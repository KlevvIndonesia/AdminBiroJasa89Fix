import { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "../db";

export interface ForeignKeyViolation {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

/**
 * Kas Domain Separation & Payment Channel Migration (Revision 2.8-FINAL.7)
 * 
 * Safety Protocol & Transaction Boundary:
 * 1. Outside Transaction (Pre-flight checks):
 *    - PRAGMA foreign_keys MUST equal 1 (cannot be configured inside an active SQLite transaction).
 *    - Prerequisite tables MUST exist (kas_kantor, pengeluaran, payment_methods, idempotency_keys, kas_messenger, invoice_payments).
 *    - If any pre-flight check fails, migration halts immediately before initiating a transaction.
 * 2. Inside Transaction (runInTransaction callback under SQLite reserved write lock):
 *    - Step 1: SQLite reserved write lock (serialized writer lock) acquired via BEGIN IMMEDIATE on targetDb.
 *              Concurrent writers are serialized; concurrent readers proceed non-blocking in WAL mode.
 *    - Step 2: Capture baselineViolations via PRAGMA foreign_key_check under reserved write lock.
 *    - Step 3: Store baseline key set for differential comparison (eliminating concurrency race window).
 *    - Step 4: Execute DDL (ALTER TABLE if column missing) and CREATE INDEX IF NOT EXISTS unconditionally across kas_kantor, pengeluaran, kas_messenger, idempotency_keys, and invoice_payments.
 *    - Step 5: Execute post-migration PRAGMA foreign_key_check on the same connection.
 *    - Step 6: Filter for newly introduced violations not present in baselineKeySet.
 *    - Step 7: If new violations detected, throw Error -> triggers immediate atomic ROLLBACK.
 *    - Step 8: Clean return allows runInTransaction to execute COMMIT.
 */
export function runKasDomainSeparationMigration(targetDb: DatabaseSync): void {
  // 1. Pre-Transaction Check: Verify foreign key enforcement is active
  // In SQLite, PRAGMA foreign_keys must be configured before opening a transaction.
  const fkPragma = targetDb.prepare("PRAGMA foreign_keys;").get() as { foreign_keys: number } | undefined;
  if (!fkPragma || Number(fkPragma.foreign_keys) !== 1) {
    throw new Error(
      "[SUN89 Migration Safety] Migration aborted fail-closed: SQLite foreign key enforcement is NOT active (PRAGMA foreign_keys = 0). " +
      "Active foreign key enforcement is mandatory prior to initiating schema migrations."
    );
  }

  // 2. Pre-Transaction Check: Verify existence of prerequisite tables (including invoice_payments)
  const tables = targetDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const tableSet = new Set(tables.map((t) => t.name.toLowerCase()));

  const requiredTables = ["kas_kantor", "pengeluaran", "payment_methods", "idempotency_keys", "kas_messenger", "invoice_payments"];
  for (const tbl of requiredTables) {
    if (!tableSet.has(tbl)) {
      throw new Error(`[SUN89 Migration Safety] Prerequisite table '${tbl}' is missing from database. Migration aborted.`);
    }
  }

  // 3. Helper to check existing columns
  function hasColumn(tableName: string, columnName: string): boolean {
    const cols = targetDb.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name.toLowerCase() === columnName.toLowerCase());
  }

  // 4. Execute transaction: runInTransaction executes BEGIN IMMEDIATE acquiring SQLite reserved write lock on targetDb
  // (Serializes concurrent writers at SQLite engine level; readers proceed non-blocking in WAL mode)
  runInTransaction(() => {
    // Step 1 & 2: Under active reserved write lock, capture pre-migration baseline FK snapshot
    // (Guarantees zero concurrency race window from competing writers)
    const baselineViolations = targetDb.prepare("PRAGMA foreign_key_check;").all() as ForeignKeyViolation[];

    // Step 3: Store baseline for differential comparison
    const baselineKeySet = new Set(
      baselineViolations.map((v) => `${v.table}|${v.rowid}|${v.parent}|${v.fkid}`)
    );

    // Step 4: Execute all DDL and index creation under reserved write lock
    // A. kas_kantor: Add columns only if missing, then ensure index exists unconditionally
    if (!hasColumn("kas_kantor", "payment_method_id")) {
      targetDb.exec(`ALTER TABLE kas_kantor ADD COLUMN payment_method_id TEXT REFERENCES payment_methods(id);`);
    }
    if (!hasColumn("kas_kantor", "payment_method_snapshot")) {
      targetDb.exec(`ALTER TABLE kas_kantor ADD COLUMN payment_method_snapshot TEXT;`);
    }
    // Independent Index Creation: Repairs state where column exists but index was never created
    targetDb.exec(`CREATE INDEX IF NOT EXISTS idx_kas_kantor_payment_method ON kas_kantor(payment_method_id);`);

    // B. pengeluaran: Add column only if missing, then ensure index exists unconditionally
    if (!hasColumn("pengeluaran", "payment_method_id")) {
      targetDb.exec(`ALTER TABLE pengeluaran ADD COLUMN payment_method_id TEXT REFERENCES payment_methods(id);`);
    }
    // Independent Index Creation: Repairs state where column exists but index was never created
    targetDb.exec(`CREATE INDEX IF NOT EXISTS idx_pengeluaran_payment_method ON pengeluaran(payment_method_id);`);

    // C. kas_messenger: Add columns only if missing, then ensure index exists unconditionally (Option B Confirmed)
    if (!hasColumn("kas_messenger", "payment_method_id")) {
      targetDb.exec(`ALTER TABLE kas_messenger ADD COLUMN payment_method_id TEXT REFERENCES payment_methods(id);`);
    }
    if (!hasColumn("kas_messenger", "payment_method_snapshot")) {
      targetDb.exec(`ALTER TABLE kas_messenger ADD COLUMN payment_method_snapshot TEXT;`);
    }
    targetDb.exec(`CREATE INDEX IF NOT EXISTS idx_kas_messenger_payment_method ON kas_messenger(payment_method_id);`);

    // D. idempotency_keys: Ensure lookup index exists unconditionally
    targetDb.exec(`CREATE INDEX IF NOT EXISTS idx_idempotency_scope_resource ON idempotency_keys(scope, resource_id);`);

    // E. invoice_payments: Add payment_method_snapshot column only if missing (FIX-01)
    if (!hasColumn("invoice_payments", "payment_method_snapshot")) {
      targetDb.exec(`ALTER TABLE invoice_payments ADD COLUMN payment_method_snapshot TEXT;`);
    }

    // Step 5: Post-migration FK verification inside the same transaction and connection
    const postViolations = targetDb.prepare("PRAGMA foreign_key_check;").all() as ForeignKeyViolation[];

    // Step 6: Differential comparison against in-transaction baseline
    const newViolations = postViolations.filter(
      (v) => !baselineKeySet.has(`${v.table}|${v.rowid}|${v.parent}|${v.fkid}`)
    );

    // Step 7: Abort fail-closed on newly introduced violations (triggers atomic ROLLBACK)
    if (newViolations.length > 0) {
      throw new Error(
        `[SUN89 Migration Safety] Migration introduced ${newViolations.length} new foreign key violation(s): ${JSON.stringify(newViolations)}. Transaction rolled back.`
      );
    }

    // Step 8: Clean return allows runInTransaction to execute COMMIT
  }, targetDb);
}
