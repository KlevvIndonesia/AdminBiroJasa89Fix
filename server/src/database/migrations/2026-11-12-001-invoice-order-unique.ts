import { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "../db";

export interface MigrationResult {
  success: boolean;
  message: string;
}

/**
 * Phase 4B Batch 2C — UNIQUE Index Migration for Order-Invoice 1-to-1 Invariant (GAP-FIN-02)
 * 
 * Safety & Preconditions:
 * 1. Checks 6 explicit preconditions inside runInTransaction (BEGIN IMMEDIATE):
 *    - Precondition 1: Zero duplicate order_no entries.
 *    - Precondition 2: Zero NULL or empty order_no entries.
 *    - Precondition 3: Zero untrimmed whitespace entries.
 *    - Precondition 4: Zero malformed format entries (must match ORD-MMYY-XXX structure).
 *    - Precondition 5: Zero dangling order_no references (all order_no must exist in orders table).
 *    - Precondition 6: Zero canonical numerical variant collisions (e.g. ORD-1126-1 vs ORD-1126-001).
 * 2. Safe Two-Stage Transition:
 *    - Stage 1: Creates idx_invoices_order_unique with UNIQUE(order_no).
 *    - Stage 2: Verifies idx_invoices_order_unique via PRAGMA index_list.
 *    - Stage 3: Only drops idx_invoices_order after verification succeeds.
 * 3. Idempotent: If idx_invoices_order_unique already exists and is unique, returns success.
 */
export function runInvoiceOrderUniqueMigration(targetDb: DatabaseSync): MigrationResult {
  return runInTransaction(() => {
    // 0. Idempotency Check: if unique index already exists and is unique
    const existingIndexList = targetDb.prepare(
      `SELECT name, "unique" FROM pragma_index_list('finance_invoices') WHERE name = 'idx_invoices_order_unique'`
    ).get() as { name: string; unique: number } | undefined;

    if (existingIndexList && existingIndexList.unique === 1) {
      // Ensure old index is dropped if it still lingered
      targetDb.exec(`DROP INDEX IF EXISTS idx_invoices_order;`);
      return { success: true, message: "UNIQUE index idx_invoices_order_unique already exists and is valid." };
    }

    // PRECONDITION 1: Exact duplicate order_no
    const duplicates = targetDb.prepare(`
      SELECT order_no, COUNT(*) as cnt
      FROM finance_invoices
      WHERE order_no IS NOT NULL AND trim(order_no) != ''
      GROUP BY order_no
      HAVING cnt > 1
    `).all() as { order_no: string; cnt: number }[];

    if (duplicates.length > 0) {
      throw new Error(`[MIGRATION_BLOCKED] Precondition 1 failed: Found ${duplicates.length} duplicate order_no entries in finance_invoices.`);
    }

    // PRECONDITION 2: NULL or empty order_no
    const emptyRows = targetDb.prepare(`
      SELECT id, invoice_no FROM finance_invoices
      WHERE order_no IS NULL OR trim(order_no) = ''
    `).all() as { id: number; invoice_no: string }[];

    if (emptyRows.length > 0) {
      throw new Error(`[MIGRATION_BLOCKED] Precondition 2 failed: Found ${emptyRows.length} rows with NULL or empty order_no in finance_invoices.`);
    }

    // PRECONDITION 3: Whitespace anomalies
    const whitespaceRows = targetDb.prepare(`
      SELECT id, order_no FROM finance_invoices
      WHERE order_no != trim(order_no)
    `).all() as { id: number; order_no: string }[];

    if (whitespaceRows.length > 0) {
      throw new Error(`[MIGRATION_BLOCKED] Precondition 3 failed: Found ${whitespaceRows.length} rows with untrimmed whitespace in order_no.`);
    }

    // PRECONDITION 4: Invalid format structure
    const invalidFormatRows = targetDb.prepare(`
      SELECT id, order_no FROM finance_invoices
      WHERE order_no NOT GLOB 'ORD-[0-9][0-9][0-9][0-9]-*'
    `).all() as { id: number; order_no: string }[];

    if (invalidFormatRows.length > 0) {
      throw new Error(`[MIGRATION_BLOCKED] Precondition 4 failed: Found ${invalidFormatRows.length} rows with invalid order_no format.`);
    }

    // PRECONDITION 5: Dangling order_no not found in orders table
    const danglingRows = targetDb.prepare(`
      SELECT fi.id, fi.order_no FROM finance_invoices fi
      LEFT JOIN orders o ON fi.order_no = o.order_no
      WHERE o.order_no IS NULL
    `).all() as { id: number; order_no: string }[];

    if (danglingRows.length > 0) {
      throw new Error(`[MIGRATION_BLOCKED] Precondition 5 failed: Found ${danglingRows.length} dangling invoice-order relations without matching order row.`);
    }

    // PRECONDITION 6: Domain equivalent format variations (e.g. leading zeros ORD-1126-1 vs ORD-1126-001)
    const allInvoices = targetDb.prepare(`SELECT id, order_no FROM finance_invoices`).all() as { id: number; order_no: string }[];
    const canonicalOrderSet = new Set<string>();
    for (const row of allInvoices) {
      const match = row.order_no.match(/^ORD-(\d{4})-(\d+)$/);
      if (match) {
        const canonicalKey = `ORD-${match[1]}-${parseInt(match[2], 10)}`;
        if (canonicalOrderSet.has(canonicalKey)) {
          throw new Error(`[MIGRATION_BLOCKED] Precondition 6 failed: Equivalent numerical order variant detected for ${row.order_no}.`);
        }
        canonicalOrderSet.add(canonicalKey);
      }
    }

    // SAFE TWO-STAGE INDEX CREATION:
    // Stage 1: Create the new unique index first
    targetDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_order_unique ON finance_invoices(order_no);`);

    // Stage 2: Verify that the unique index exists and is unique
    const indexCheck = targetDb.prepare(`
      SELECT name, "unique" FROM pragma_index_list('finance_invoices') WHERE name = 'idx_invoices_order_unique'
    `).get() as { name: string; unique: number } | undefined;

    if (!indexCheck || indexCheck.unique !== 1) {
      throw new Error(`[MIGRATION_FAILED] Verification of idx_invoices_order_unique failed.`);
    }

    // Stage 3: Only after verification, safely drop the old non-unique index
    targetDb.exec(`DROP INDEX IF EXISTS idx_invoices_order;`);

    return {
      success: true,
      message: "UNIQUE index idx_invoices_order_unique successfully created and verified; old index retired."
    };
  }, targetDb);
}

/**
 * Rollback Migration for testing and emergency restoration
 */
export function rollbackInvoiceOrderUniqueMigration(targetDb: DatabaseSync): MigrationResult {
  return runInTransaction(() => {
    targetDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_invoices_order ON finance_invoices(order_no);
      DROP INDEX IF EXISTS idx_invoices_order_unique;
    `);
    return {
      success: true,
      message: "Rollback successful: idx_invoices_order restored and idx_invoices_order_unique dropped."
    };
  }, targetDb);
}
