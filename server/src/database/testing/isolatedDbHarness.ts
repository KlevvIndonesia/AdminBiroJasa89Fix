/**
 * Phase 3B Step 1 — Isolated Database Test Harness
 * Admin SUN89 — Biro Jasa Management System
 *
 * Provides strictly isolated, disposable SQLite database handles (`node:sqlite` DatabaseSync)
 * for automated tests and migration verification without touching or falling back to
 * `server/data/database.sqlite` or `CONFIG.DB_PATH`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "../../config/env";
import { getOperationalDbPath, runInTransaction } from "../db";
import { initializeSchema } from "../schema";

export type IsolatedDbMode = "temp-file" | "explicit-file" | "memory";

export interface IsolatedDbOptions {
  /** Required only for `openIsolatedDbAtPath`. Never falls back to operational DB. */
  explicitDbPath?: string;
  /** Descriptive prefix for temporary directories in `os.tmpdir()`. */
  suitePrefix?: string;
  /** File name inside temp directory. Defaults to `phase3b_isolated.sqlite`. */
  fileName?: string;
  /** Project root override for safety path assertions (useful in security guard tests). */
  projectRoot?: string;
  /** Enable SQLite WAL mode on file-backed DBs (ignored/unavailable as 'memory' for `:memory:`). */
  enableWal?: boolean;
  /** Enforce PRAGMA foreign_keys = ON immediately after open (default: true). */
  enforceForeignKeys?: boolean;
  /** Busy timeout in milliseconds (default: 5000). */
  busyTimeoutMs?: number;
  /** Explicitly initialize full application baseline schema after opening (default: false). */
  initializeAppSchema?: boolean;
  /** Optional directory where diagnostic JSON snapshots are preserved on failure. */
  diagnosticsOutputDir?: string;
}

export interface SqlitePragmaSnapshot {
  foreignKeys: number;
  journalMode: string;
  busyTimeout: number | null;
  databaseList: Array<{ seq: number; name: string; file: string }>;
}

export interface DiagnosticSnapshot {
  capturedAt: string;
  reason?: string;
  mode: IsolatedDbMode;
  dbPath: string;
  pragmas: SqlitePragmaSnapshot;
  integrityCheck: string[];
  foreignKeyViolations: Array<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>;
  tables: string[];
  schemaMigrations: Array<Record<string, unknown>>;
  error?: string;
  persistedPath?: string;
}

export interface CleanupOptions {
  /** Preserve the temporary database files and write a diagnostic snapshot before closing. */
  preserveOnFailure?: boolean;
  /** Reason recorded if preserved or capturing diagnostics. */
  reason?: string;
}

export interface CleanupResult {
  closedConnections: number;
  removedFiles: string[];
  removedTempDir: string | null;
  preserved: boolean;
  diagnosticSnapshot?: DiagnosticSnapshot;
}

export interface IsolatedDbHandle {
  readonly mode: IsolatedDbMode;
  readonly dbPath: string;
  readonly tempDir: string | null;
  readonly db: DatabaseSync;
  readonly initialPragmas: SqlitePragmaSnapshot;
  withTransaction<T>(fn: () => T): T;
  openPeerConnection(options?: {
    busyTimeoutMs?: number;
    enforceForeignKeys?: boolean;
  }): DatabaseSync;
  readPragmas(targetDb?: DatabaseSync): SqlitePragmaSnapshot;
  captureDiagnostics(reason?: string, persistToDir?: string): DiagnosticSnapshot;
  cleanup(options?: CleanupOptions): CleanupResult;
}

function normalizeForComparison(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideDir(candidatePath: string, directoryPath: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidatePath);
  const normalizedDir = normalizeForComparison(directoryPath);
  const relative = path.relative(normalizedDir, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWithExistingAncestorRealpath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch {
    // Fall back to ancestor inspection below
  }

  const partsToAppend: string[] = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    partsToAppend.unshift(path.basename(cursor));
    cursor = parent;
  }

  try {
    const realBase = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
    return path.resolve(realBase, ...partsToAppend);
  } catch {
    return resolved;
  }
}

/**
 * Validates that a candidate database path is safe for isolated test execution.
 * Fails closed against:
 * - Empty, whitespace-only, or SQLite URI strings (`file:...`)
 * - The operational database (`server/data/database.sqlite`) and its WAL/SHM/journal/backup siblings
 * - Any path inside `server/data/` or `server/backups/` (including case variants and symlinks)
 * - `CONFIG.DB_PATH` whenever it resolves inside protected operational locations
 */
export function assertSafeTestDbPath(
  candidatePath: string,
  options?: { allowMemory?: boolean; projectRoot?: string }
): string {
  if (typeof candidatePath !== "string" || candidatePath.trim() === "") {
    throw new Error(
      "[ISOLATED_DB_SAFETY_GUARD] Database path must be explicitly provided and non-empty. Implicit fallback to operational database is prohibited."
    );
  }

  const trimmed = candidatePath.trim();
  const allowMemory = options?.allowMemory !== false;

  if (trimmed === ":memory:") {
    if (!allowMemory) {
      throw new Error(
        "[ISOLATED_DB_SAFETY_GUARD] In-memory ':memory:' database is disallowed for this file-backed operation."
      );
    }
    return ":memory:";
  }

  if (trimmed.toLowerCase().startsWith("file:")) {
    throw new Error(
      `[ISOLATED_DB_SAFETY_GUARD] SQLite URI paths are prohibited ('${trimmed}') to prevent ambiguous file/memory targeting.`
    );
  }

  const projectRoot = path.resolve(options?.projectRoot ?? CONFIG.PROJECT_ROOT);
  const operationalDbPath =
    options?.projectRoot !== undefined
      ? path.resolve(projectRoot, "server/data/database.sqlite")
      : getOperationalDbPath();
  const operationalDataDir = path.dirname(operationalDbPath);
  const operationalBackupDir = path.resolve(projectRoot, "server/backups");

  const resolvedCandidate = resolveWithExistingAncestorRealpath(trimmed);
  const resolvedOperational = resolveWithExistingAncestorRealpath(operationalDbPath);
  const resolvedDataDir = resolveWithExistingAncestorRealpath(operationalDataDir);
  const resolvedBackupDir = resolveWithExistingAncestorRealpath(operationalBackupDir);

  const normalizedCandidate = normalizeForComparison(resolvedCandidate);
  const normalizedOperational = normalizeForComparison(resolvedOperational);

  const forbiddenExactAndPrefixTargets = [
    normalizedOperational,
    `${normalizedOperational}-wal`,
    `${normalizedOperational}-shm`,
    `${normalizedOperational}-journal`,
  ];

  if (
    forbiddenExactAndPrefixTargets.includes(normalizedCandidate) ||
    path.basename(normalizedCandidate).startsWith("database.sqlite")
  ) {
    if (
      isPathInsideDir(resolvedCandidate, resolvedDataDir) ||
      forbiddenExactAndPrefixTargets.includes(normalizedCandidate)
    ) {
      throw new Error(
        `[ISOLATED_DB_SAFETY_GUARD] Refused protected operational database path '${trimmed}' (resolved: '${resolvedCandidate}'). Tests must strictly target disposable isolated databases.`
      );
    }
  }

  if (isPathInsideDir(resolvedCandidate, resolvedDataDir)) {
    throw new Error(
      `[ISOLATED_DB_SAFETY_GUARD] Refused path inside operational data directory '${resolvedDataDir}': '${resolvedCandidate}'.`
    );
  }

  if (isPathInsideDir(resolvedCandidate, resolvedBackupDir)) {
    throw new Error(
      `[ISOLATED_DB_SAFETY_GUARD] Refused path inside operational backup directory '${resolvedBackupDir}': '${resolvedCandidate}'.`
    );
  }

  // Secondary check: verify database path never matches default CONFIG.DB_PATH when it aliases operational DB
  const resolvedConfigDb = resolveWithExistingAncestorRealpath(CONFIG.DB_PATH);
  if (
    normalizeForComparison(resolvedConfigDb) === normalizedOperational &&
    normalizeForComparison(resolvedCandidate) === normalizeForComparison(resolvedConfigDb)
  ) {
    throw new Error(
      `[ISOLATED_DB_SAFETY_GUARD] Refused CONFIG.DB_PATH aliasing operational database '${resolvedOperational}'.`
    );
  }

  return resolvedCandidate;
}

/**
 * Verifies every attached file in an already-open DatabaseSync via `PRAGMA database_list`.
 * Used by both the test harness and the migration runner for fail-closed protection.
 */
export function assertOpenDatabaseIsNotOperational(
  targetDb: DatabaseSync,
  options?: { allowOperationalWrite?: boolean; projectRoot?: string }
): void {
  if (options?.allowOperationalWrite === true) {
    return;
  }
  const dbList = targetDb.prepare("PRAGMA database_list").all() as Array<{
    seq: number;
    name: string;
    file: string;
  }>;
  for (const entry of dbList) {
    if (entry.file && entry.file.trim() !== "") {
      assertSafeTestDbPath(entry.file, { allowMemory: false, projectRoot: options?.projectRoot });
    }
  }
}

export function readSqlitePragmas(targetDb: DatabaseSync): SqlitePragmaSnapshot {
  const fkRow = targetDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
  const journalRow = targetDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  const busyRow = targetDb.prepare("PRAGMA busy_timeout").get() as Record<string, number> | undefined;
  const dbList = targetDb.prepare("PRAGMA database_list").all() as Array<{
    seq: number;
    name: string;
    file: string;
  }>;

  const busyValue =
    busyRow && typeof busyRow.timeout === "number"
      ? busyRow.timeout
      : busyRow && typeof busyRow.busy_timeout === "number"
        ? busyRow.busy_timeout
        : null;

  return {
    foreignKeys: Number(fkRow?.foreign_keys ?? 0),
    journalMode: String(journalRow?.journal_mode ?? "").toLowerCase(),
    busyTimeout: busyValue,
    databaseList: dbList.map((row) => ({
      seq: Number(row.seq),
      name: String(row.name),
      file: String(row.file ?? ""),
    })),
  };
}

function unlinkWithRetry(filePath: string, maxRetries = 5): boolean {
  if (!fs.existsSync(filePath)) return false;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < maxRetries) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * Math.pow(2, attempt - 1));
        continue;
      }
      if (!fs.existsSync(filePath)) return false;
      throw err;
    }
  }
  return false;
}

function removeDirWithRetry(dirPath: string, maxRetries = 5): boolean {
  if (!fs.existsSync(dirPath)) return false;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < maxRetries) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * Math.pow(2, attempt - 1));
        continue;
      }
      if (!fs.existsSync(dirPath)) return false;
      throw err;
    }
  }
  return false;
}

function sanitizePrefix(raw: string | undefined): string {
  const cleaned = (raw ?? "sun89-phase3b-")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-");
  return cleaned.endsWith("-") ? cleaned : `${cleaned}-`;
}

function buildIsolatedHandle(
  mode: IsolatedDbMode,
  dbPath: string,
  tempDir: string | null,
  ownsTempDir: boolean,
  options: IsolatedDbOptions
): IsolatedDbHandle {
  const enforceForeignKeys = options.enforceForeignKeys ?? true;
  const enableWal = options.enableWal ?? true;
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  if (mode !== "memory") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const primaryDb = new DatabaseSync(dbPath);
  const peerConnections = new Set<DatabaseSync>();
  let cleanedUp = false;

  const configureConnection = (
    conn: DatabaseSync,
    connBusyMs: number,
    connEnforceFk: boolean,
    connApplyWal: boolean
  ): SqlitePragmaSnapshot => {
    conn.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(connBusyMs))};`);
    if (connApplyWal && mode !== "memory") {
      conn.exec("PRAGMA journal_mode = WAL;");
    }
    conn.exec(`PRAGMA foreign_keys = ${connEnforceFk ? "ON" : "OFF"};`);

    const snapshot = readSqlitePragmas(conn);
    if (connEnforceFk && snapshot.foreignKeys !== 1) {
      conn.close();
      throw new Error(
        `[ISOLATED_DB_HARNESS] Failed to enforce PRAGMA foreign_keys = ON (actual=${snapshot.foreignKeys}).`
      );
    }
    if (connApplyWal && mode !== "memory" && snapshot.journalMode !== "wal") {
      conn.close();
      throw new Error(
        `[ISOLATED_DB_HARNESS] Failed to enable WAL journal mode on file database '${dbPath}' (actual=${snapshot.journalMode}).`
      );
    }
    return snapshot;
  };

  let initialPragmas: SqlitePragmaSnapshot;
  try {
    assertOpenDatabaseIsNotOperational(primaryDb, { projectRoot: options.projectRoot });
    initialPragmas = configureConnection(primaryDb, busyTimeoutMs, enforceForeignKeys, enableWal);
    if (options.initializeAppSchema) {
      initializeSchema(primaryDb);
    }
  } catch (err) {
    try {
      primaryDb.close();
    } catch {
      // Ignore close error during startup failure cleanup
    }
    if (ownsTempDir && tempDir) {
      try {
        removeDirWithRetry(tempDir);
      } catch {
        // Ignore temp cleanup error when rethrowing root error
      }
    }
    throw err;
  }

  const handle: IsolatedDbHandle = {
    mode,
    dbPath,
    tempDir,
    db: primaryDb,
    initialPragmas,

    withTransaction<T>(fn: () => T): T {
      return runInTransaction(fn, primaryDb);
    },

    openPeerConnection(peerOpts) {
      if (mode === "memory") {
        throw new Error(
          "[ISOLATED_DB_HARNESS] Peer connections cannot attach to a private ':memory:' database. Use createIsolatedTempDb() for multi-connection lock/concurrency testing."
        );
      }
      if (cleanedUp) {
        throw new Error("[ISOLATED_DB_HARNESS] Cannot open peer connection after handle cleanup.");
      }
      const peer = new DatabaseSync(dbPath);
      const peerSnapshot = configureConnection(
        peer,
        peerOpts?.busyTimeoutMs ?? busyTimeoutMs,
        peerOpts?.enforceForeignKeys ?? enforceForeignKeys,
        false
      );
      if (peerSnapshot.foreignKeys !== (peerOpts?.enforceForeignKeys ?? enforceForeignKeys ? 1 : 0)) {
        peer.close();
        throw new Error("[ISOLATED_DB_HARNESS] Peer connection foreign_keys assertion failed.");
      }
      peerConnections.add(peer);
      return peer;
    },

    readPragmas(targetDb = primaryDb) {
      return readSqlitePragmas(targetDb);
    },

    captureDiagnostics(reason, persistToDir) {
      const capturedAt = new Date().toISOString();
      try {
        const pragmas = readSqlitePragmas(primaryDb);
        const integrityRows = primaryDb.prepare("PRAGMA integrity_check").all() as Array<{
          integrity_check: string;
        }>;
        const fkRows = primaryDb.prepare("PRAGMA foreign_key_check").all() as Array<{
          table: string;
          rowid: number;
          parent: string;
          fkid: number;
        }>;
        const tableRows = primaryDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
          .all() as Array<{ name: string }>;

        let schemaMigrations: Array<Record<string, unknown>> = [];
        if (tableRows.some((t) => t.name === "schema_migrations")) {
          schemaMigrations = primaryDb
            .prepare("SELECT * FROM schema_migrations ORDER BY rowid ASC")
            .all() as Array<Record<string, unknown>>;
        }

        const snapshot: DiagnosticSnapshot = {
          capturedAt,
          reason,
          mode,
          dbPath,
          pragmas,
          integrityCheck: integrityRows.map((r) => String(r.integrity_check)),
          foreignKeyViolations: fkRows,
          tables: tableRows.map((t) => t.name),
          schemaMigrations,
        };

        const outDir = persistToDir ?? options.diagnosticsOutputDir;
        if (outDir) {
          fs.mkdirSync(outDir, { recursive: true });
          const safeStamp = capturedAt.replace(/[:.]/g, "-");
          const diagPath = path.join(outDir, `db-diagnostics-${safeStamp}.json`);
          fs.writeFileSync(diagPath, JSON.stringify(snapshot, null, 2), "utf8");
          snapshot.persistedPath = diagPath;
        }
        return snapshot;
      } catch (err) {
        return {
          capturedAt,
          reason,
          mode,
          dbPath,
          pragmas: initialPragmas,
          integrityCheck: [],
          foreignKeyViolations: [],
          tables: [],
          schemaMigrations: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    cleanup(cleanupOpts) {
      if (cleanedUp) {
        return {
          closedConnections: 0,
          removedFiles: [],
          removedTempDir: null,
          preserved: false,
        };
      }

      let diagnosticSnapshot: DiagnosticSnapshot | undefined;
      if (cleanupOpts?.preserveOnFailure) {
        diagnosticSnapshot = handle.captureDiagnostics(
          cleanupOpts.reason ?? "Preserved on test failure",
          tempDir ?? options.diagnosticsOutputDir
        );
      }

      let closedConnections = 0;
      for (const peer of peerConnections) {
        try {
          peer.close();
          closedConnections++;
        } catch {
          // Best-effort close; report clean teardown attempt
        }
      }
      peerConnections.clear();

      try {
        primaryDb.close();
        closedConnections++;
      } catch {
        // Ignore if caller already explicitly closed primaryDb
      }

      cleanedUp = true;

      if (cleanupOpts?.preserveOnFailure) {
        return {
          closedConnections,
          removedFiles: [],
          removedTempDir: null,
          preserved: true,
          diagnosticSnapshot,
        };
      }

      const removedFiles: string[] = [];
      let removedTempDir: string | null = null;

      if (mode !== "memory") {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          const candidate = `${dbPath}${suffix}`;
          if (unlinkWithRetry(candidate)) {
            removedFiles.push(candidate);
          }
        }
        if (ownsTempDir && tempDir) {
          if (removeDirWithRetry(tempDir)) {
            removedTempDir = tempDir;
          }
        }
      }

      return {
        closedConnections,
        removedFiles,
        removedTempDir,
        preserved: false,
        diagnosticSnapshot,
      };
    },
  };

  return handle;
}

/**
 * Creates a brand-new disposable file-backed SQLite database in an isolated `os.tmpdir()` directory.
 * Strictly validates the resulting path against operational DB protections.
 */
export function createIsolatedTempDb(options: IsolatedDbOptions = {}): IsolatedDbHandle {
  const prefix = sanitizePrefix(options.suitePrefix);
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const rawFileName = options.fileName?.trim() || "phase3b_isolated.sqlite";
  if (rawFileName.includes("..") || path.isAbsolute(rawFileName)) {
    removeDirWithRetry(dirPath);
    throw new Error(`[ISOLATED_DB_HARNESS] Invalid fileName '${rawFileName}'.`);
  }
  const candidateDbPath = path.join(dirPath, rawFileName);
  const safePath = assertSafeTestDbPath(candidateDbPath, {
    allowMemory: false,
    projectRoot: options.projectRoot,
  });
  return buildIsolatedHandle("temp-file", safePath, dirPath, true, options);
}

/**
 * Opens an isolated SQLite database at an explicitly provided safe file path.
 * Never falls back to operational DB paths or environment defaults.
 */
export function openIsolatedDbAtPath(
  explicitDbPath: string,
  options: Omit<IsolatedDbOptions, "explicitDbPath"> = {}
): IsolatedDbHandle {
  const safePath = assertSafeTestDbPath(explicitDbPath, {
    allowMemory: false,
    projectRoot: options.projectRoot,
  });
  return buildIsolatedHandle("explicit-file", safePath, null, false, options);
}

/**
 * Creates a disposable in-memory SQLite database (`:memory:`).
 * Note: SQLite keeps `:memory:` databases in `'memory'` journal mode (WAL does not apply to `:memory:`).
 */
export function createIsolatedMemoryDb(
  options: Omit<IsolatedDbOptions, "explicitDbPath" | "enableWal"> = {}
): IsolatedDbHandle {
  const safePath = assertSafeTestDbPath(":memory:", {
    allowMemory: true,
    projectRoot: options.projectRoot,
  });
  return buildIsolatedHandle("memory", safePath, null, false, {
    ...options,
    enableWal: false,
  });
}
