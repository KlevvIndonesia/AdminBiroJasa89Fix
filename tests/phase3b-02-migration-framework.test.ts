/**
 * Phase 3B Regression Category 2 — Migration Framework Tests
 * Covers Step C requirements: ordered identifiers, deterministic sequence,
 * legacy `schema_migrations` upgrade compatibility, duplicate & checksum prevention,
 * dry-run inspection, failure rollback & partial-state blocking, TX vs non-TX
 * PRAGMA foreign_keys boundary protocol, rollback reversibility, and operational DB guard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearFailedMigrationRecord,
  ensureSchemaMigrationsTable,
  inspectSchemaVersion,
  rollbackMigration,
  runMigrations,
  sortAndValidateMigrations,
  type MigrationDefinition,
} from "../server/src/database/migrations/migrationFramework";
import {
  PHASE_3B_PLANNED_CONTRACTS,
  PHASE_3B_PREFLIGHT_GATES,
  UNRESOLVED_BUSINESS_DECISIONS,
} from "../server/src/database/migrations/phase3bContracts";
import {
  createIsolatedTempDb,
  openIsolatedDbAtPath,
  readSqlitePragmas,
} from "../server/src/database/testing/isolatedDbHarness";

function makeSampleMigration(
  overrides: Partial<MigrationDefinition> & Pick<MigrationDefinition, "id" | "order" | "up">
): MigrationDefinition {
  return {
    name: `Sample ${overrides.id}`,
    purpose: `Establish test table for ${overrides.id}`,
    preconditions: ["Isolated test database initialized"],
    schemaChanges: [`Applies DDL for ${overrides.id}`],
    postconditions: ["Target objects exist"],
    rollbackStrategy: { reversible: false, reason: "Test sample non-reversible by default" },
    verificationTests: ["tests/phase3b-02-migration-framework.test.ts"],
    requiresFkDisabled: false,
    ...overrides,
  };
}

describe("Phase 3B Category 2 — Migration Framework Foundation", () => {
  it("2.1 Rejects invalid contracts, invalid IDs, duplicate IDs, duplicate orders, and inconsistent rollback contracts", () => {
    assert.throws(() => {
      sortAndValidateMigrations([
        makeSampleMigration({ id: "bad name with spaces", order: 1, up: () => {} }),
      ]);
    }, /MIGRATION_CONTRACT_ERROR/);

    assert.throws(() => {
      sortAndValidateMigrations([
        makeSampleMigration({ id: "0001-no-purpose", order: 1, purpose: "   ", up: () => {} }),
      ]);
    }, /MIGRATION_CONTRACT_ERROR/);

    assert.throws(() => {
      sortAndValidateMigrations([
        makeSampleMigration({
          id: "0001-missing-down",
          order: 1,
          rollbackStrategy: { reversible: true, summary: "Missing down function" },
          up: () => {},
        }),
      ]);
    }, /MIGRATION_CONTRACT_ERROR/);

    assert.throws(() => {
      sortAndValidateMigrations([
        makeSampleMigration({ id: "0001-a", order: 1, up: () => {} }),
        makeSampleMigration({ id: "0001-a", order: 2, up: () => {} }),
      ]);
    }, /MIGRATION_REGISTRY_ERROR.*Duplicate migration id/i);

    assert.throws(() => {
      sortAndValidateMigrations([
        makeSampleMigration({ id: "0001-a", order: 10, up: () => {} }),
        makeSampleMigration({ id: "0002-b", order: 10, up: () => {} }),
      ]);
    }, /MIGRATION_REGISTRY_ERROR.*Duplicate migration order/i);
  });

  it("2.2 Executes out-of-order input deterministically, prevents duplicates, and verifies checksums", () => {
    const handle = createIsolatedTempDb({ suitePrefix: "cat2-order-idempotent" });
    try {
      const m1 = makeSampleMigration({
        id: "2026-11-16-001-create-exec-log",
        order: 10,
        up: (db) => {
          db.exec("CREATE TABLE exec_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, step_id TEXT NOT NULL);");
          db.prepare("INSERT INTO exec_log (step_id) VALUES (?)").run("m1");
        },
      });
      const m2 = makeSampleMigration({
        id: "2026-11-16-002-second-step",
        order: 20,
        up: (db) => {
          db.prepare("INSERT INTO exec_log (step_id) VALUES (?)").run("m2");
        },
      });
      const m3 = makeSampleMigration({
        id: "2026-11-16-003-third-step",
        order: 30,
        up: (db) => {
          db.prepare("INSERT INTO exec_log (step_id) VALUES (?)").run("m3");
        },
      });

      // Dry-run does not create tracking table or execute up()
      const dryRun = runMigrations(handle.db, [m3, m1, m2], { dryRun: true });
      assert.equal(dryRun.dryRun, true);
      assert.deepEqual(dryRun.plannedIds, [m1.id, m2.id, m3.id]);
      assert.equal(inspectSchemaVersion(handle.db, [m1, m2, m3]).trackingTableExists, false);

      // Actual execution in scrambled input order
      const firstRun = runMigrations(handle.db, [m3, m1, m2]);
      assert.deepEqual(firstRun.appliedIds, [m1.id, m2.id, m3.id]);
      assert.deepEqual(firstRun.skippedIds, []);

      const rows = handle.db.prepare("SELECT step_id FROM exec_log ORDER BY seq ASC").all() as Array<{ step_id: string }>;
      assert.deepEqual(rows.map((r) => r.step_id), ["m1", "m2", "m3"]);

      // Re-running is idempotent and skips all applied migrations
      const secondRun = runMigrations(handle.db, [m2, m3, m1]);
      assert.deepEqual(secondRun.appliedIds, []);
      assert.deepEqual(secondRun.skippedIds, [m1.id, m2.id, m3.id]);

      const inspection = inspectSchemaVersion(handle.db, [m1, m2, m3]);
      assert.equal(inspection.trackingTableExists, true);
      assert.equal(inspection.currentVersionOrder, 30);
      assert.equal(inspection.latestAppliedId, m3.id);
      assert.deepEqual(inspection.pendingIds, []);
      assert.equal(inspection.failedRecords.length, 0);

      // Modifying checksum of an already-applied migration fails closed
      const mutatedM2: MigrationDefinition = {
        ...m2,
        purpose: "Tampered post-apply purpose changing canonical checksum",
      };
      assert.throws(() => {
        runMigrations(handle.db, [m1, mutatedM2, m3]);
      }, /MIGRATION_CHECKSUM_MISMATCH/);
    } finally {
      handle.cleanup();
    }
  });

  it("2.3 Seamlessly extends legacy schema_migrations table without losing prior rows", () => {
    const handle = createIsolatedTempDb({ suitePrefix: "cat2-legacy-upgrade" });
    try {
      // Simulate legacy minimal schema_migrations from 2026-11-15-001
      handle.db.exec(`
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations (id, applied_at)
        VALUES ('2026-11-15-001-normalize-svp-role-to-administrator', '2026-11-15 10:00:00');
      `);

      ensureSchemaMigrationsTable(handle.db);

      const newMig = makeSampleMigration({
        id: "2026-11-16-010-additive-feature",
        order: 100,
        up: (db) => {
          db.exec("CREATE TABLE new_feature (id TEXT PRIMARY KEY);");
        },
      });
      const res = runMigrations(handle.db, [newMig]);
      assert.deepEqual(res.appliedIds, [newMig.id]);

      const inspection = inspectSchemaVersion(handle.db, [newMig]);
      assert.ok(inspection.appliedIds.includes("2026-11-15-001-normalize-svp-role-to-administrator"));
      assert.ok(inspection.appliedIds.includes(newMig.id));
    } finally {
      handle.cleanup();
    }
  });

  it("2.4 Rolls back failed migrations atomically, records FAILED state, blocks pipeline, and supports recovery", () => {
    const handle = createIsolatedTempDb({ suitePrefix: "cat2-failure-recovery" });
    try {
      let shouldFail = true;

      const m1 = makeSampleMigration({
        id: "0001-base-table",
        order: 1,
        up: (db) => {
          db.exec("CREATE TABLE surviving_table (id INTEGER PRIMARY KEY);");
        },
      });

      const m2 = makeSampleMigration({
        id: "0002-fragile-migration",
        order: 2,
        up: (db) => {
          db.exec("CREATE TABLE partial_should_rollback (id INTEGER PRIMARY KEY);");
          if (shouldFail) {
            throw new Error("Simulated mid-migration constraint failure");
          }
        },
      });

      const m3 = makeSampleMigration({
        id: "0003-dependent-migration",
        order: 3,
        up: (db) => {
          db.exec("CREATE TABLE dependent_table (id INTEGER PRIMARY KEY);");
        },
      });

      assert.throws(() => {
        runMigrations(handle.db, [m1, m2, m3]);
      }, /MIGRATION_FAILED.*0002-fragile-migration/);

      // m1 survived, partial_should_rollback rolled back atomically, dependent_table never ran
      const tableNames = new Set(
        (
          handle.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((t) => t.name)
      );
      assert.ok(tableNames.has("surviving_table"));
      assert.equal(tableNames.has("partial_should_rollback"), false, "Failed DDL must roll back atomically");
      assert.equal(tableNames.has("dependent_table"), false);

      const inspectFailed = inspectSchemaVersion(handle.db, [m1, m2, m3]);
      assert.equal(inspectFailed.failedRecords.length, 1);
      assert.equal(inspectFailed.failedRecords[0].id, "0002-fragile-migration");
      assert.match(inspectFailed.failedRecords[0].errorMessage ?? "", /Simulated mid-migration constraint failure/);

      // Unresolved FAILED state blocks subsequent runs unless cleared/retried
      assert.throws(() => {
        runMigrations(handle.db, [m1, m2, m3]);
      }, /MIGRATION_BLOCKED_BY_FAILED_STATE/);

      // Fix defect and recover cleanly via clearFailedMigrationRecord (or retryFailedIds)
      shouldFail = false;
      const cleared = clearFailedMigrationRecord(handle.db, "0002-fragile-migration");
      assert.equal(cleared, true);

      const recovered = runMigrations(handle.db, [m1, m2, m3]);
      assert.deepEqual(recovered.skippedIds, ["0001-base-table"]);
      assert.deepEqual(recovered.appliedIds, ["0002-fragile-migration", "0003-dependent-migration"]);
      assert.equal(inspectSchemaVersion(handle.db, [m1, m2, m3]).failedRecords.length, 0);
    } finally {
      handle.cleanup();
    }
  });

  it("2.5 Enforces explicit non-TX PRAGMA foreign_keys boundary for table rebuilds (M2 protocol) and catches FK corruption", () => {
    const handle = createIsolatedTempDb({ suitePrefix: "cat2-fk-rebuild" });
    try {
      handle.db.exec(`
        CREATE TABLE parent_docs (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE child_refs (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent_docs(id) ON DELETE RESTRICT
        );
        INSERT INTO parent_docs (id, title) VALUES ('doc-1', 'Valid Doc');
        INSERT INTO child_refs (id, parent_id) VALUES ('ref-1', 'doc-1');
      `);

      // Rebuild dropping & recreating parent_docs safely under requiresFkDisabled = true
      const validRebuild = makeSampleMigration({
        id: "2026-11-16-050-valid-parent-rebuild",
        order: 50,
        requiresFkDisabled: true,
        up: (db) => {
          db.exec(`
            CREATE TABLE parent_docs_new (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1
            );
            INSERT INTO parent_docs_new (id, title, revision) SELECT id, title, 1 FROM parent_docs;
            DROP TABLE parent_docs;
            ALTER TABLE parent_docs_new RENAME TO parent_docs;
          `);
        },
      });

      const okRes = runMigrations(handle.db, [validRebuild]);
      assert.deepEqual(okRes.appliedIds, [validRebuild.id]);
      assert.equal(readSqlitePragmas(handle.db).foreignKeys, 1, "PRAGMA foreign_keys MUST be restored to 1 after rebuild");

      // Corrupt rebuild introducing dangling child row MUST abort BEFORE commit and restore FK=ON
      const corruptRebuild = makeSampleMigration({
        id: "2026-11-16-060-corrupt-rebuild",
        order: 60,
        requiresFkDisabled: true,
        up: (db) => {
          db.prepare("DELETE FROM parent_docs WHERE id = 'doc-1'").run();
        },
      });

      assert.throws(() => {
        runMigrations(handle.db, [validRebuild, corruptRebuild]);
      }, /MIGRATION_FK_INTEGRITY_FAILED/);

      assert.equal(readSqlitePragmas(handle.db).foreignKeys, 1, "PRAGMA foreign_keys MUST be restored to 1 even after rebuild abort");
      const survivingParent = handle.db.prepare("SELECT id FROM parent_docs WHERE id = 'doc-1'").get();
      assert.ok(survivingParent, "Aborted FK-corrupt rebuild must restore original row on rollback");
    } finally {
      handle.cleanup();
    }
  });

  it("2.6 Supports rollback for reversible migrations, blocks non-reversible ones, and blocks operational DB targets", () => {
    const handle = createIsolatedTempDb({ suitePrefix: "cat2-rollback-ops" });
    try {
      const reversible = makeSampleMigration({
        id: "0010-reversible-view",
        order: 10,
        rollbackStrategy: { reversible: true, summary: "Drop test_mig_table" },
        up: (db) => {
          db.exec("CREATE TABLE test_mig_table (id INTEGER PRIMARY KEY);");
        },
        down: (db) => {
          db.exec("DROP TABLE IF EXISTS test_mig_table;");
        },
      });
      const nonReversible = makeSampleMigration({
        id: "0020-non-reversible",
        order: 20,
        rollbackStrategy: { reversible: false, reason: "Data consolidation cannot be cleanly inverted" },
        up: (db) => {
          db.exec("CREATE TABLE locked_mig_table (id INTEGER PRIMARY KEY);");
        },
      });

      runMigrations(handle.db, [reversible, nonReversible]);

      assert.throws(() => {
        rollbackMigration(handle.db, nonReversible);
      }, /MIGRATION_NON_REVERSIBLE/);

      const rb = rollbackMigration(handle.db, reversible);
      assert.equal(rb.rolledBack, true);

      const tblAfterRb = handle.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_mig_table'")
        .get();
      assert.equal(tblAfterRb, undefined);

      const inspectAfterRb = inspectSchemaVersion(handle.db, [reversible, nonReversible]);
      assert.ok(inspectAfterRb.rolledBackIds.includes(reversible.id));

      // Verify runMigrations blocks a fake operational DB path under temp fakeRoot
      const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sun89-mig-op-guard-"));
      try {
        const fakeOpPath = path.join(fakeRoot, "server", "data", "database.sqlite");
        fs.mkdirSync(path.dirname(fakeOpPath), { recursive: true });
        const opTarget = openIsolatedDbAtPath(fakeOpPath);
        try {
          assert.throws(() => {
            runMigrations(opTarget.db, [reversible], { projectRoot: fakeRoot });
          }, /ISOLATED_DB_SAFETY_GUARD/);
        } finally {
          opTarget.cleanup();
        }
      } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    } finally {
      handle.cleanup();
    }
  });

  it("2.7 Planned Phase 3B M1–M5 contract metadata and 11 Pre-Flight Gates remain explicitly DEFERRED and valid", () => {
    assert.equal(PHASE_3B_PLANNED_CONTRACTS.length, 5);
    assert.equal(PHASE_3B_PREFLIGHT_GATES.length, 11);
    assert.equal(UNRESOLVED_BUSINESS_DECISIONS.length, 9);
    for (const c of PHASE_3B_PLANNED_CONTRACTS) {
      assert.equal(c.implementationStatus, "DEFERRED");
    }
    const m2 = PHASE_3B_PLANNED_CONTRACTS.find((c) => c.stageCode === "M2");
    assert.equal(m2?.requiresFkDisabled, true);
  });
});
