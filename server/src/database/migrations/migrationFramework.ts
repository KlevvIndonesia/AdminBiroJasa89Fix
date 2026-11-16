/**
 * Phase 3B Step 1 — Deterministic Migration Framework Foundation
 * Admin SUN89 — Biro Jasa Management System
 *
 * Extends the repository's existing `schema_migrations` table convention
 * (`2026-11-14-001-admin-stage4-parity-rbac.ts`, `2026-11-15-001-normalize-svp-role-to-administrator.ts`)
 * with deterministic ordering, explicit migration contracts, checksum tracking,
 * safe TX vs non-TX PRAGMA foreign_keys boundary handling, failure state tracking,
 * rollback support, and fail-closed operational DB protection.
 */

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "../db";
import { assertOpenDatabaseIsNotOperational } from "../testing/isolatedDbHarness";

export type MigrationStatus = "APPLIED" | "FAILED" | "ROLLED_BACK";

export type RollbackStrategy =
  | { reversible: true; summary: string }
  | { reversible: false; reason: string };

export interface MigrationContract {
  /** Ordered canonical identifier, e.g. `2026-11-17-001-m1-estimation-tables`. */
  id: string;
  /** Strictly unique positive integer controlling deterministic execution sequence. */
  order: number;
  /** Human-readable migration title. */
  name: string;
  /** Why this migration exists and what architectural invariant it establishes. */
  purpose: string;
  /** Preconditions required before DDL begins. */
  preconditions: string[];
  /** Explicit summary of schema modifications performed. */
  schemaChanges: string[];
  /** Postconditions that must hold immediately after DDL prior to commit. */
  postconditions: string[];
  /** Reversibility declaration and rollback plan or non-reversibility justification. */
  rollbackStrategy: RollbackStrategy;
  /** Named regression/verification checks bound to this migration. */
  verificationTests: string[];
  /**
   * Explicit SQLite FK boundary flag:
   * - `false`: PRAGMA foreign_keys stays ON (`1`) throughout.
   * - `true`: Table-rebuild migration (e.g. Phase 3B M2). PRAGMA foreign_keys is disabled
   *   strictly OUTSIDE transaction, DDL runs atomically inside BEGIN IMMEDIATE, differential
   *   `PRAGMA foreign_key_check` enforces zero newly introduced violations before COMMIT,
   *   and `PRAGMA foreign_keys = ON` is restored outside TX in `finally`.
   */
  requiresFkDisabled: boolean;
}

export interface MigrationDefinition extends MigrationContract {
  /** Optional read-only validation executed before opening write lock (and before disabling FKs). */
  checkPreconditions?: (db: DatabaseSync) => void;
  /** Schema/data transformation executed under BEGIN IMMEDIATE transaction lock. */
  up: (db: DatabaseSync) => void;
  /** Validation executed inside the active transaction immediately after `up`. */
  checkPostconditions?: (db: DatabaseSync) => void;
  /** Deterministic down-migration (required when `rollbackStrategy.reversible === true`). */
  down?: (db: DatabaseSync) => void;
}

export interface AppliedMigrationRecord {
  id: string;
  versionOrder: number | null;
  name: string | null;
  description: string | null;
  checksum: string | null;
  status: MigrationStatus;
  requiresFkDisabled: boolean;
  isReversible: boolean;
  appliedAt: string;
  executionMs: number | null;
  errorMessage: string | null;
  rolledBackAt: string | null;
  contractJson: string | null;
}

export interface RunMigrationsOptions {
  /**
   * Safety gate: must remain false/omitted in automated tests and scripts.
   * Only explicit operator maintenance workflows may override this.
   */
  allowOperationalWrite?: boolean;
  /** Override workspace root check when testing custom operational path guards. */
  projectRoot?: string;
  /** Validate registry, preconditions, and pending plan without mutating database schema or history. */
  dryRun?: boolean;
  /** Permit re-execution of a previously `FAILED` migration ID after manual remediation. */
  retryFailedIds?: string[];
  /** When false, fails if an already-APPLIED migration's contract checksum changed (default: true). */
  verifyChecksums?: boolean;
}

export interface RunMigrationsResult {
  dryRun: boolean;
  orderedIds: string[];
  appliedIds: string[];
  skippedIds: string[];
  plannedIds: string[];
  failedId: string | null;
  records: AppliedMigrationRecord[];
}

export interface SchemaVersionInspection {
  trackingTableExists: boolean;
  currentVersionOrder: number | null;
  latestAppliedId: string | null;
  appliedIds: string[];
  failedRecords: AppliedMigrationRecord[];
  rolledBackIds: string[];
  pendingIds: string[];
  history: AppliedMigrationRecord[];
}

export interface RollbackMigrationResult {
  id: string;
  rolledBack: boolean;
  executionMs: number;
}

const VALID_MIGRATION_ID_REGEX = /^(?:\d{4}-\d{2}-\d{2}-\d{3}|\d{3,6}|M\d{1,3})-[a-z0-9][a-z0-9-]*$/;

export function computeMigrationChecksum(migration: MigrationContract): string {
  const canonicalPayload = JSON.stringify({
    id: migration.id,
    order: migration.order,
    name: migration.name,
    purpose: migration.purpose,
    preconditions: migration.preconditions,
    schemaChanges: migration.schemaChanges,
    postconditions: migration.postconditions,
    rollbackStrategy: migration.rollbackStrategy,
    requiresFkDisabled: migration.requiresFkDisabled,
  });
  return crypto.createHash("sha256").update(canonicalPayload).digest("hex");
}

function validateSingleContract(migration: MigrationDefinition): void {
  if (!VALID_MIGRATION_ID_REGEX.test(migration.id)) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Invalid migration identifier '${migration.id}'. Expected format like '2026-11-17-001-slug', '0001-slug', or 'M1-slug'.`
    );
  }
  if (!Number.isInteger(migration.order) || migration.order <= 0) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' must define a positive integer 'order'.`
    );
  }
  if (!migration.name?.trim() || !migration.purpose?.trim()) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' must declare non-empty 'name' and 'purpose'.`
    );
  }
  if (!Array.isArray(migration.preconditions) || migration.preconditions.length === 0) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' must declare explicit 'preconditions' (cannot be empty).`
    );
  }
  if (!Array.isArray(migration.schemaChanges) || migration.schemaChanges.length === 0) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' must declare explicit 'schemaChanges'.`
    );
  }
  if (!Array.isArray(migration.postconditions) || migration.postconditions.length === 0) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' must declare explicit 'postconditions'.`
    );
  }
  if (!Array.isArray(migration.verificationTests) || migration.verificationTests.length === 0) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' must declare explicit 'verificationTests'.`
    );
  }
  if (typeof migration.up !== "function") {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' is missing executable 'up' handler.`
    );
  }
  if (migration.rollbackStrategy.reversible && typeof migration.down !== "function") {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Migration '${migration.id}' declares reversible rollbackStrategy but omits 'down' handler.`
    );
  }
  if (!migration.rollbackStrategy.reversible && !migration.rollbackStrategy.reason?.trim()) {
    throw new Error(
      `[MIGRATION_CONTRACT_ERROR] Non-reversible migration '${migration.id}' must state an explicit non-reversibility reason.`
    );
  }
}

/**
 * Validates all contracts and returns a deterministically ordered copy sorted by `(order ASC, id ASC)`.
 */
export function sortAndValidateMigrations<T extends MigrationDefinition>(migrations: readonly T[]): T[] {
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();

  for (const mig of migrations) {
    validateSingleContract(mig);
    if (seenIds.has(mig.id)) {
      throw new Error(`[MIGRATION_REGISTRY_ERROR] Duplicate migration id detected: '${mig.id}'.`);
    }
    if (seenOrders.has(mig.order)) {
      throw new Error(
        `[MIGRATION_REGISTRY_ERROR] Duplicate migration order ${mig.order} detected (conflict on '${mig.id}').`
      );
    }
    seenIds.add(mig.id);
    seenOrders.add(mig.order);
  }

  return [...migrations].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function hasSchemaMigrationsTable(targetDb: DatabaseSync): boolean {
  const row = targetDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  return Boolean(row);
}

/**
 * Creates or additively upgrades `schema_migrations` in-place while remaining 100% compatible
 * with legacy rows inserted by `2026-11-14-001` and `2026-11-15-001`.
 */
export function ensureSchemaMigrationsTable(targetDb: DatabaseSync): void {
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT
    );
  `);

  const cols = targetDb.prepare("PRAGMA table_info('schema_migrations')").all() as Array<{
    name: string;
  }>;
  const colSet = new Set(cols.map((c) => c.name.toLowerCase()));

  const additiveColumns: Array<{ name: string; ddl: string }> = [
    { name: "description", ddl: "ALTER TABLE schema_migrations ADD COLUMN description TEXT;" },
    { name: "version_order", ddl: "ALTER TABLE schema_migrations ADD COLUMN version_order INTEGER;" },
    { name: "name", ddl: "ALTER TABLE schema_migrations ADD COLUMN name TEXT;" },
    { name: "checksum", ddl: "ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;" },
    { name: "status", ddl: "ALTER TABLE schema_migrations ADD COLUMN status TEXT NOT NULL DEFAULT 'APPLIED';" },
    { name: "requires_fk_disabled", ddl: "ALTER TABLE schema_migrations ADD COLUMN requires_fk_disabled INTEGER NOT NULL DEFAULT 0;" },
    { name: "is_reversible", ddl: "ALTER TABLE schema_migrations ADD COLUMN is_reversible INTEGER NOT NULL DEFAULT 0;" },
    { name: "execution_ms", ddl: "ALTER TABLE schema_migrations ADD COLUMN execution_ms INTEGER;" },
    { name: "error_message", ddl: "ALTER TABLE schema_migrations ADD COLUMN error_message TEXT;" },
    { name: "rolled_back_at", ddl: "ALTER TABLE schema_migrations ADD COLUMN rolled_back_at TEXT;" },
    { name: "contract_json", ddl: "ALTER TABLE schema_migrations ADD COLUMN contract_json TEXT;" },
  ];

  for (const col of additiveColumns) {
    if (!colSet.has(col.name)) {
      targetDb.exec(col.ddl);
    }
  }

  targetDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_schema_migrations_status_order ON schema_migrations(status, version_order, applied_at);`
  );
}

function readAllMigrationRows(targetDb: DatabaseSync): AppliedMigrationRecord[] {
  if (!hasSchemaMigrationsTable(targetDb)) {
    return [];
  }

  const cols = targetDb.prepare("PRAGMA table_info('schema_migrations')").all() as Array<{ name: string }>;
  const colSet = new Set(cols.map((c) => c.name.toLowerCase()));

  const selectCol = (colName: string, fallbackExpr: string) =>
    colSet.has(colName) ? colName : `${fallbackExpr} AS ${colName}`;

  const sql = `
    SELECT
      id,
      ${selectCol("version_order", "NULL")},
      ${selectCol("name", "NULL")},
      ${selectCol("description", "NULL")},
      ${selectCol("checksum", "NULL")},
      ${selectCol("status", "'APPLIED'")},
      ${selectCol("requires_fk_disabled", "0")},
      ${selectCol("is_reversible", "0")},
      applied_at,
      ${selectCol("execution_ms", "NULL")},
      ${selectCol("error_message", "NULL")},
      ${selectCol("rolled_back_at", "NULL")},
      ${selectCol("contract_json", "NULL")}
    FROM schema_migrations
    ORDER BY COALESCE(version_order, 0) ASC, applied_at ASC, id ASC
  `;

  const rows = targetDb.prepare(sql).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    versionOrder: r.version_order === null || r.version_order === undefined ? null : Number(r.version_order),
    name: r.name === null || r.name === undefined ? null : String(r.name),
    description: r.description === null || r.description === undefined ? null : String(r.description),
    checksum: r.checksum === null || r.checksum === undefined ? null : String(r.checksum),
    status: (String(r.status || "APPLIED").toUpperCase() as MigrationStatus),
    requiresFkDisabled: Number(r.requires_fk_disabled ?? 0) === 1,
    isReversible: Number(r.is_reversible ?? 0) === 1,
    appliedAt: String(r.applied_at ?? ""),
    executionMs: r.execution_ms === null || r.execution_ms === undefined ? null : Number(r.execution_ms),
    errorMessage: r.error_message === null || r.error_message === undefined ? null : String(r.error_message),
    rolledBackAt: r.rolled_back_at === null || r.rolled_back_at === undefined ? null : String(r.rolled_back_at),
    contractJson: r.contract_json === null || r.contract_json === undefined ? null : String(r.contract_json),
  }));
}

/**
 * Read-only inspection of current schema migration version and history.
 */
export function inspectSchemaVersion(
  targetDb: DatabaseSync,
  registeredMigrations: readonly MigrationDefinition[] = []
): SchemaVersionInspection {
  const ordered = sortAndValidateMigrations(registeredMigrations);
  const trackingTableExists = hasSchemaMigrationsTable(targetDb);
  const history = readAllMigrationRows(targetDb);

  const appliedRecords = history.filter((h) => h.status === "APPLIED");
  const failedRecords = history.filter((h) => h.status === "FAILED");
  const rolledBackIds = history.filter((h) => h.status === "ROLLED_BACK").map((h) => h.id);
  const appliedIdSet = new Set(appliedRecords.map((r) => r.id));

  let currentVersionOrder: number | null = null;
  for (const rec of appliedRecords) {
    if (rec.versionOrder !== null && (currentVersionOrder === null || rec.versionOrder > currentVersionOrder)) {
      currentVersionOrder = rec.versionOrder;
    }
  }

  const latestApplied = appliedRecords.length > 0 ? appliedRecords[appliedRecords.length - 1] : null;
  const pendingIds = ordered.filter((m) => !appliedIdSet.has(m.id)).map((m) => m.id);

  return {
    trackingTableExists,
    currentVersionOrder,
    latestAppliedId: latestApplied ? latestApplied.id : null,
    appliedIds: appliedRecords.map((r) => r.id),
    failedRecords,
    rolledBackIds,
    pendingIds,
    history,
  };
}

interface FkViolationRow {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

function captureFkViolationKeys(targetDb: DatabaseSync): Set<string> {
  const rows = targetDb.prepare("PRAGMA foreign_key_check;").all() as unknown as FkViolationRow[];
  return new Set(rows.map((v) => `${v.table}|${v.rowid}|${v.parent}|${v.fkid}`));
}

function serializeContractSummary(migration: MigrationContract): string {
  return JSON.stringify({
    id: migration.id,
    order: migration.order,
    name: migration.name,
    purpose: migration.purpose,
    preconditions: migration.preconditions,
    schemaChanges: migration.schemaChanges,
    postconditions: migration.postconditions,
    rollbackStrategy: migration.rollbackStrategy,
    verificationTests: migration.verificationTests,
    requiresFkDisabled: migration.requiresFkDisabled,
  });
}

function upsertMigrationRecord(
  targetDb: DatabaseSync,
  migration: MigrationDefinition,
  status: MigrationStatus,
  executionMs: number,
  errorMessage: string | null
): void {
  const checksum = computeMigrationChecksum(migration);
  const contractJson = serializeContractSummary(migration);
  targetDb
    .prepare(
      `INSERT INTO schema_migrations (
         id, applied_at, description, version_order, name, checksum, status,
         requires_fk_disabled, is_reversible, execution_ms, error_message, rolled_back_at, contract_json
       )
       VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         applied_at = datetime('now'),
         description = excluded.description,
         version_order = excluded.version_order,
         name = excluded.name,
         checksum = excluded.checksum,
         status = excluded.status,
         requires_fk_disabled = excluded.requires_fk_disabled,
         is_reversible = excluded.is_reversible,
         execution_ms = excluded.execution_ms,
         error_message = excluded.error_message,
         rolled_back_at = NULL,
         contract_json = excluded.contract_json`
    )
    .run(
      migration.id,
      migration.purpose,
      migration.order,
      migration.name,
      checksum,
      status,
      migration.requiresFkDisabled ? 1 : 0,
      migration.rollbackStrategy.reversible ? 1 : 0,
      executionMs,
      errorMessage,
      contractJson
    );
}

/**
 * Executes ordered migrations deterministically against an isolated (or explicitly authorized) DB.
 */
export function runMigrations(
  targetDb: DatabaseSync,
  migrations: readonly MigrationDefinition[],
  options: RunMigrationsOptions = {}
): RunMigrationsResult {
  assertOpenDatabaseIsNotOperational(targetDb, {
    allowOperationalWrite: options.allowOperationalWrite,
    projectRoot: options.projectRoot,
  });

  const ordered = sortAndValidateMigrations(migrations);
  const orderedIds = ordered.map((m) => m.id);
  const retrySet = new Set(options.retryFailedIds ?? []);
  const verifyChecksums = options.verifyChecksums ?? true;

  if (!options.dryRun) {
    ensureSchemaMigrationsTable(targetDb);
  }

  const existingRecords = readAllMigrationRows(targetDb);
  const existingMap = new Map(existingRecords.map((r) => [r.id, r]));

  // Fail closed if database currently holds unresolved FAILED migration entries not explicitly being retried
  const blockingFailed = existingRecords.filter(
    (r) => r.status === "FAILED" && !retrySet.has(r.id)
  );
  if (blockingFailed.length > 0) {
    const first = blockingFailed[0];
    throw new Error(
      `[MIGRATION_BLOCKED_BY_FAILED_STATE] Cannot run migrations while unresolved FAILED migration '${first.id}' exists (error: ${first.errorMessage ?? "unknown"}). Recover/rollback or pass retryFailedIds explicitly.`
    );
  }

  const skippedIds: string[] = [];
  const plannedIds: string[] = [];
  const appliedIds: string[] = [];

  for (const mig of ordered) {
    const existing = existingMap.get(mig.id);
    if (existing && existing.status === "APPLIED") {
      if (verifyChecksums && existing.checksum) {
        const expectedChecksum = computeMigrationChecksum(mig);
        if (existing.checksum !== expectedChecksum) {
          throw new Error(
            `[MIGRATION_CHECKSUM_MISMATCH] Migration '${mig.id}' already applied with checksum ${existing.checksum}, but current definition has ${expectedChecksum}.`
          );
        }
      }
      skippedIds.push(mig.id);
    } else {
      plannedIds.push(mig.id);
    }
  }

  if (options.dryRun) {
    for (const mig of ordered) {
      if (!plannedIds.includes(mig.id)) continue;
      if (mig.checkPreconditions) {
        mig.checkPreconditions(targetDb);
      }
    }
    return {
      dryRun: true,
      orderedIds,
      appliedIds: [],
      skippedIds,
      plannedIds,
      failedId: null,
      records: existingRecords,
    };
  }

  // Enforce foreign keys ON before starting migration pipeline
  const fkStart = targetDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
  if (!fkStart || Number(fkStart.foreign_keys) !== 1) {
    targetDb.exec("PRAGMA foreign_keys = ON;");
  }

  for (const mig of ordered) {
    if (!plannedIds.includes(mig.id)) continue;

    const startedAt = Date.now();
    try {
      // Preconditions always run with FK=ON before mutating schema or toggling FK pragma
      if (mig.checkPreconditions) {
        mig.checkPreconditions(targetDb);
      }

      if (mig.requiresFkDisabled) {
        // Explicit SQLite rule: PRAGMA foreign_keys = OFF MUST execute outside transaction.
        const baselineFkKeys = captureFkViolationKeys(targetDb);
        targetDb.exec("PRAGMA foreign_keys = OFF;");
        let txCompleted = false;
        try {
          runInTransaction(() => {
            mig.up(targetDb);
            if (mig.checkPostconditions) {
              mig.checkPostconditions(targetDb);
            }
            const postViolations = targetDb
              .prepare("PRAGMA foreign_key_check;")
              .all() as unknown as FkViolationRow[];
            const newViolations = postViolations.filter(
              (v) => !baselineFkKeys.has(`${v.table}|${v.rowid}|${v.parent}|${v.fkid}`)
            );
            if (newViolations.length > 0) {
              throw new Error(
                `[MIGRATION_FK_INTEGRITY_FAILED] Migration '${mig.id}' introduced ${newViolations.length} new foreign key violation(s) under table rebuild (first: table='${newViolations[0].table}', rowid=${newViolations[0].rowid}, parent='${newViolations[0].parent}'). Transaction rolled back.`
              );
            }
            upsertMigrationRecord(targetDb, mig, "APPLIED", Date.now() - startedAt, null);
          }, targetDb);
          txCompleted = true;
        } finally {
          targetDb.exec("PRAGMA foreign_keys = ON;");
        }
        if (txCompleted) {
          const fkRestored = targetDb.prepare("PRAGMA foreign_keys").get() as
            | { foreign_keys: number }
            | undefined;
          if (!fkRestored || Number(fkRestored.foreign_keys) !== 1) {
            throw new Error(
              `[MIGRATION_FK_RESTORE_FAILED] Failed to re-enable PRAGMA foreign_keys = ON after migration '${mig.id}'.`
            );
          }
        }
      } else {
        const baselineFkKeys = captureFkViolationKeys(targetDb);
        runInTransaction(() => {
          mig.up(targetDb);
          if (mig.checkPostconditions) {
            mig.checkPostconditions(targetDb);
          }
          const postViolations = targetDb
            .prepare("PRAGMA foreign_key_check;")
            .all() as unknown as FkViolationRow[];
          const newViolations = postViolations.filter(
            (v) => !baselineFkKeys.has(`${v.table}|${v.rowid}|${v.parent}|${v.fkid}`)
          );
          if (newViolations.length > 0) {
            throw new Error(
              `[MIGRATION_FK_INTEGRITY_FAILED] Migration '${mig.id}' introduced ${newViolations.length} new foreign key violation(s). Transaction rolled back.`
            );
          }
          upsertMigrationRecord(targetDb, mig, "APPLIED", Date.now() - startedAt, null);
        }, targetDb);
      }

      appliedIds.push(mig.id);
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        upsertMigrationRecord(targetDb, mig, "FAILED", elapsed, errMsg);
      } catch {
        // Ignore secondary failure while propagating root migration failure
      }
      throw new Error(`[MIGRATION_FAILED] Migration '${mig.id}' failed and halted pipeline: ${errMsg}`);
    }
  }

  return {
    dryRun: false,
    orderedIds,
    appliedIds,
    skippedIds,
    plannedIds,
    failedId: null,
    records: readAllMigrationRows(targetDb),
  };
}

/**
 * Rolls back a single applied migration if its contract explicitly declares reversibility.
 */
export function rollbackMigration(
  targetDb: DatabaseSync,
  migration: MigrationDefinition,
  options: { allowOperationalWrite?: boolean; projectRoot?: string } = {}
): RollbackMigrationResult {
  assertOpenDatabaseIsNotOperational(targetDb, {
    allowOperationalWrite: options.allowOperationalWrite,
    projectRoot: options.projectRoot,
  });
  validateSingleContract(migration);

  if (!migration.rollbackStrategy.reversible || !migration.down) {
    const reason = !migration.rollbackStrategy.reversible
      ? migration.rollbackStrategy.reason
      : "No down handler registered";
    throw new Error(`[MIGRATION_NON_REVERSIBLE] Migration '${migration.id}' cannot be rolled back: ${reason}`);
  }

  ensureSchemaMigrationsTable(targetDb);
  const existing = readAllMigrationRows(targetDb).find((r) => r.id === migration.id);
  if (!existing || existing.status !== "APPLIED") {
    return {
      id: migration.id,
      rolledBack: false,
      executionMs: 0,
    };
  }

  const startedAt = Date.now();
  const downHandler = migration.down;

  const executeDownTx = () => {
    runInTransaction(() => {
      downHandler(targetDb);
      targetDb
        .prepare(
          `UPDATE schema_migrations
           SET status = 'ROLLED_BACK',
               rolled_back_at = datetime('now'),
               error_message = NULL
           WHERE id = ?`
        )
        .run(migration.id);
    }, targetDb);
  };

  if (migration.requiresFkDisabled) {
    targetDb.exec("PRAGMA foreign_keys = OFF;");
    try {
      executeDownTx();
    } finally {
      targetDb.exec("PRAGMA foreign_keys = ON;");
    }
  } else {
    executeDownTx();
  }

  return {
    id: migration.id,
    rolledBack: true,
    executionMs: Date.now() - startedAt,
  };
}

/**
 * Clears or marks a failed migration record after verified manual remediation in isolated tests/ops.
 */
export function clearFailedMigrationRecord(
  targetDb: DatabaseSync,
  migrationId: string,
  options: { allowOperationalWrite?: boolean; projectRoot?: string } = {}
): boolean {
  assertOpenDatabaseIsNotOperational(targetDb, {
    allowOperationalWrite: options.allowOperationalWrite,
    projectRoot: options.projectRoot,
  });
  if (!hasSchemaMigrationsTable(targetDb)) return false;
  const res = targetDb
    .prepare("DELETE FROM schema_migrations WHERE id = ? AND status = 'FAILED'")
    .run(migrationId);
  return Number(res.changes ?? 0) > 0;
}
