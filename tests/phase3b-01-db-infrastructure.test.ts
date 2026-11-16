/**
 * Phase 3B Regression Category 1 — Database Infrastructure & Isolation Tests
 * Covers Step B requirements: disposable DB lifecycle, operational path rejection,
 * FK enforcement, WAL & busy_timeout checks, TX commit/rollback, constraints,
 * lock contention, suite isolation, diagnostic preservation, and safe cleanup.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSafeTestDbPath,
  assertOpenDatabaseIsNotOperational,
  createIsolatedMemoryDb,
  createIsolatedTempDb,
  openIsolatedDbAtPath,
  type IsolatedDbHandle,
} from "../server/src/database/testing/isolatedDbHarness";
import { closeDb, getOperationalDbPath, isDbConnected } from "../server/src/database/db";

describe("Phase 3B Category 1 — Isolated Database Infrastructure", () => {
  it("1.1 Creates disposable file-backed DB in os.tmpdir() without connecting global singleton", () => {
    closeDb();
    assert.equal(isDbConnected(), false, "Global DB singleton must remain unconnected");

    const handle = createIsolatedTempDb({ suitePrefix: "cat1-disposable" });
    try {
      assert.equal(handle.mode, "temp-file");
      assert.ok(handle.tempDir && handle.tempDir.startsWith(os.tmpdir()));
      assert.ok(fs.existsSync(handle.dbPath));
      assert.notEqual(
        path.resolve(handle.dbPath).toLowerCase(),
        path.resolve(getOperationalDbPath()).toLowerCase()
      );
      assert.equal(handle.initialPragmas.foreignKeys, 1);
      assert.equal(handle.initialPragmas.journalMode, "wal");
      assert.equal(handle.initialPragmas.busyTimeout, 5000);
      assert.equal(isDbConnected(), false, "Harness must not mutate global db.ts singleton");
    } finally {
      handle.cleanup();
    }
  });

  it("1.2 Creates disposable :memory: DB and documents non-WAL memory journal mode", () => {
    const handle = createIsolatedMemoryDb({ busyTimeoutMs: 2500 });
    try {
      assert.equal(handle.mode, "memory");
      assert.equal(handle.dbPath, ":memory:");
      assert.equal(handle.initialPragmas.foreignKeys, 1);
      assert.equal(handle.initialPragmas.journalMode, "memory");
      assert.equal(handle.initialPragmas.busyTimeout, 2500);
    } finally {
      handle.cleanup();
    }
  });

  it("1.3 Rejects operational database paths, siblings, backup dirs, empty paths, and URIs", () => {
    const projectRoot = process.cwd();
    const opDb = getOperationalDbPath();

    const unsafeCandidates = [
      "",
      "   ",
      "file::memory:?cache=shared",
      opDb,
      opDb.toUpperCase(),
      "server/data/database.sqlite",
      "./server/data/database.sqlite",
      "server/data/database.sqlite-wal",
      "server/data/database.sqlite-shm",
      "server/data/database.sqlite-journal",
      "server/data/database.sqlite.bak-20261116",
      "server/data/custom-prod.sqlite",
      "server/backups/snapshot.sqlite",
    ];

    for (const candidate of unsafeCandidates) {
      assert.throws(
        () => assertSafeTestDbPath(candidate, { projectRoot }),
        /ISOLATED_DB_SAFETY_GUARD/,
        `Expected unsafe path '${candidate}' to be rejected`
      );
      assert.throws(
        () => openIsolatedDbAtPath(candidate, { projectRoot }),
        /ISOLATED_DB_SAFETY_GUARD/,
        `Expected openIsolatedDbAtPath('${candidate}') to reject fail-closed`
      );
    }

    // Verify open-handle guard using a simulated fake projectRoot strictly inside os.tmpdir()
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sun89-fake-root-"));
    try {
      const fakeOpPath = path.join(fakeRoot, "server", "data", "database.sqlite");
      fs.mkdirSync(path.dirname(fakeOpPath), { recursive: true });
      const fakeHandle = openIsolatedDbAtPath(fakeOpPath, { projectRoot }); // safe relative to REAL repo root
      try {
        assert.throws(
          () => assertOpenDatabaseIsNotOperational(fakeHandle.db, { projectRoot: fakeRoot }),
          /ISOLATED_DB_SAFETY_GUARD/
        );
      } finally {
        fakeHandle.cleanup();
      }
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("1.4 Enforces foreign key constraints, unique constraints, commit, and atomic rollback", () => {
    const handle = createIsolatedTempDb({ suitePrefix: "cat1-tx-constraints" });
    try {
      handle.db.exec(`
        CREATE TABLE parents (
          id TEXT PRIMARY KEY,
          code TEXT UNIQUE NOT NULL
        );
        CREATE TABLE children (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE RESTRICT
        );
      `);

      // Commit succeeds atomically
      const committed = handle.withTransaction(() => {
        handle.db.prepare("INSERT INTO parents (id, code) VALUES (?, ?)").run("p1", "CODE-1");
        handle.db.prepare("INSERT INTO children (id, parent_id) VALUES (?, ?)").run("c1", "p1");
        return "OK";
      });
      assert.equal(committed, "OK");

      // Unique violation
      assert.throws(() => {
        handle.db.prepare("INSERT INTO parents (id, code) VALUES (?, ?)").run("p2", "CODE-1");
      }, /UNIQUE constraint failed/i);

      // Foreign key violation (child referencing nonexistent parent)
      assert.throws(() => {
        handle.db.prepare("INSERT INTO children (id, parent_id) VALUES (?, ?)").run("c-orphan", "missing");
      }, /FOREIGN KEY constraint failed/i);

      // Foreign key restrict violation (deleting referenced parent)
      assert.throws(() => {
        handle.db.prepare("DELETE FROM parents WHERE id = ?").run("p1");
      }, /FOREIGN KEY constraint failed/i);

      // Atomic rollback on mid-transaction failure
      assert.throws(() => {
        handle.withTransaction(() => {
          handle.db.prepare("INSERT INTO parents (id, code) VALUES (?, ?)").run("p2", "CODE-2");
          handle.db.prepare("INSERT INTO children (id, parent_id) VALUES (?, ?)").run("c-bad", "no-such-parent");
        });
      }, /FOREIGN KEY constraint failed/i);

      const p2 = handle.db.prepare("SELECT id FROM parents WHERE id = ?").get("p2");
      assert.equal(p2, undefined, "Rolled-back insert must not persist");
    } finally {
      handle.cleanup();
    }
  });

  it("1.5 Reproduces SQLITE_BUSY / locked database contention safely across peer connections", () => {
    const handle = createIsolatedTempDb({
      suitePrefix: "cat1-busy-lock",
      busyTimeoutMs: 50,
    });
    try {
      handle.db.exec("CREATE TABLE lock_test (id INTEGER PRIMARY KEY, val TEXT NOT NULL);");
      const peer = handle.openPeerConnection({ busyTimeoutMs: 25 });

      handle.db.exec("BEGIN IMMEDIATE;");
      handle.db.prepare("INSERT INTO lock_test (id, val) VALUES (1, 'holder')").run();

      try {
        assert.throws(() => {
          peer.exec("BEGIN IMMEDIATE;");
          peer.prepare("INSERT INTO lock_test (id, val) VALUES (2, 'contender')").run();
        }, /locked|busy/i);
      } finally {
        handle.db.exec("COMMIT;");
      }

      // Verify peer writes succeed cleanly once write lock releases
      peer.exec("BEGIN IMMEDIATE;");
      peer.prepare("INSERT INTO lock_test (id, val) VALUES (2, 'after-release')").run();
      peer.exec("COMMIT;");

      const countRow = handle.db.prepare("SELECT COUNT(*) AS cnt FROM lock_test").get() as { cnt: number };
      assert.equal(countRow.cnt, 2);
    } finally {
      handle.cleanup();
    }
  });

  it("1.6 Guarantees suite isolation, failure diagnostics capture, and non-destructive cleanup", () => {
    const suiteA = createIsolatedTempDb({ suitePrefix: "cat1-suite-a" });
    const suiteB = createIsolatedTempDb({ suitePrefix: "cat1-suite-b" });
    const handlesToClean: IsolatedDbHandle[] = [suiteA, suiteB];

    try {
      assert.notEqual(suiteA.dbPath, suiteB.dbPath);
      assert.notEqual(suiteA.tempDir, suiteB.tempDir);

      suiteA.db.exec("CREATE TABLE only_in_a (id INTEGER PRIMARY KEY);");
      const inB = suiteB.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'only_in_a'")
        .get();
      assert.equal(inB, undefined, "Tables created in suite A must never leak to suite B");

      // Preserve-on-failure diagnostics workflow
      const preservedCleanup = suiteA.cleanup({
        preserveOnFailure: true,
        reason: "Simulated assertion failure diagnostic capture",
      });
      assert.equal(preservedCleanup.preserved, true);
      assert.ok(preservedCleanup.diagnosticSnapshot);
      assert.deepEqual(preservedCleanup.diagnosticSnapshot.integrityCheck, ["ok"]);
      assert.equal(preservedCleanup.diagnosticSnapshot.foreignKeyViolations.length, 0);
      assert.ok(preservedCleanup.diagnosticSnapshot.tables.includes("only_in_a"));
      assert.ok(
        preservedCleanup.diagnosticSnapshot.persistedPath &&
          fs.existsSync(preservedCleanup.diagnosticSnapshot.persistedPath),
        "Diagnostic JSON snapshot must be written on failure preservation"
      );

      // Remove simulated preserved temp dir manually after assertion so test leaves zero clutter
      if (suiteA.tempDir && fs.existsSync(suiteA.tempDir)) {
        fs.rmSync(suiteA.tempDir, { recursive: true, force: true });
      }

      // Normal cleanup on suiteB removes temp dir and files completely without affecting unrelated dirs
      const normalCleanup = suiteB.cleanup();
      assert.equal(normalCleanup.preserved, false);
      assert.ok(normalCleanup.removedTempDir);
      assert.equal(fs.existsSync(suiteB.dbPath), false);
      assert.equal(fs.existsSync(normalCleanup.removedTempDir), false);
    } finally {
      for (const h of handlesToClean) {
        try {
          h.cleanup();
        } catch {
          // Already cleaned above
        }
      }
    }
  });
});
