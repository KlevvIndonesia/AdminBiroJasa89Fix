import { DatabaseSync } from "node:sqlite";
import { getDb } from "../database/db";
import { ApiError } from "../middleware/errorHandler";

/**
 * Recalculates Kas Kantor running balances using deterministic forward chronological order:
 * ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC
 * Explicitly operates on targetDb.
 */
export function recalculateKasKantorRunningBalances(targetDb?: DatabaseSync): void {
  const activeDb = targetDb ?? getDb();
  const rows = activeDb.prepare(`
    SELECT id, debit, kredit 
    FROM kas_kantor 
    ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC
  `).all() as Array<{ id: number; debit: number; kredit: number }>;

  let runningSaldo = 0;
  const updateStmt = activeDb.prepare(`UPDATE kas_kantor SET saldo = ? WHERE id = ?`);

  for (const row of rows) {
    runningSaldo += (Number(row.debit) || 0) - (Number(row.kredit) || 0);
    updateStmt.run(runningSaldo, row.id);
  }
}

/**
 * Recalculates Kas Messenger running balances for a specific courier using deterministic forward chronological order:
 * ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC within partition WHERE messenger_id = ?
 * Explicitly operates on targetDb.
 */
export function recalculateKasMessengerRunningBalances(messengerId: string, targetDb?: DatabaseSync): void {
  const activeDb = targetDb ?? getDb();
  const rows = activeDb.prepare(`
    SELECT id, debit, kredit 
    FROM kas_messenger 
    WHERE messenger_id = ? 
    ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC
  `).all(messengerId) as Array<{ id: number; debit: number; kredit: number }>;

  let runningTotal = 0;
  const updateStmt = activeDb.prepare(`UPDATE kas_messenger SET total = ? WHERE id = ?`);

  for (const row of rows) {
    runningTotal += (Number(row.debit) || 0) - (Number(row.kredit) || 0);
    updateStmt.run(runningTotal, row.id);
  }
}

/**
 * Precise negative balance simulation before permanent deletion:
 * Checks whether removing the target transaction's net inflow CAUSES any subsequent balance
 * in the deterministic chronological order to drop from non-negative (>= 0) to negative (< 0).
 * Explicitly operates on targetDb.
 */
export function assertNoSubsequentNegativeBalance(
  table: "kas_kantor" | "kas_messenger",
  targetId: number | string,
  messengerId?: string,
  targetDb?: DatabaseSync
): void {
  const activeDb = targetDb ?? getDb();

  // 1. Fetch all rows for the relevant ledger in strict deterministic order
  let query = `SELECT id, debit, kredit, tanggal, created_at FROM "${table}"`;
  const params: any[] = [];

  if (table === "kas_messenger") {
    if (!messengerId) {
      throw new ApiError(500, "MISSING_MESSENGER_ID", "messenger_id diperlukan untuk simulasi saldo kas messenger.");
    }
    query += ` WHERE messenger_id = ?`;
    params.push(messengerId);
  }
  query += ` ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC`;

  const rows = activeDb.prepare(query).all(...params) as Array<{
    id: number | string;
    debit: number;
    kredit: number;
    tanggal: string;
    created_at: string;
  }>;

  // 2. Locate target transaction and determine its net inflow contribution
  const targetIndex = rows.findIndex((r) => String(r.id) === String(targetId));
  if (targetIndex === -1) {
    throw new ApiError(404, "NOT_FOUND", `Data ${table} #${targetId} tidak ditemukan.`);
  }

  const targetRow = rows[targetIndex];
  const netInflowRemoved = (Number(targetRow.debit) || 0) - (Number(targetRow.kredit) || 0);

  // If removing the target does not decrease balance (e.g. net outflow or zero), it cannot cause negative balances
  if (netInflowRemoved <= 0) {
    return;
  }

  // 3. Compute baseline cumulative running balance across the ledger
  let runningBaseline = 0;
  const baselineBalances: number[] = [];
  for (const row of rows) {
    runningBaseline += (Number(row.debit) || 0) - (Number(row.kredit) || 0);
    baselineBalances.push(runningBaseline);
  }

  // 4. Simulate running balance across all transactions strictly AFTER the target
  // and check if this deletion CAUSES any subsequent balance to drop from non-negative to negative
  for (let i = targetIndex + 1; i < rows.length; i++) {
    const baselineAtI = baselineBalances[i];
    const simulatedAtI = baselineAtI - netInflowRemoved;

    // Condition: Deletion causes a subsequent balance to become negative where it was previously non-negative
    if (baselineAtI >= 0 && simulatedAtI < 0) {
      throw new ApiError(
        409,
        "NEGATIVE_BALANCE_VIOLATION",
        `Penghapusan transaksi #${targetId} (Net Inflow: Rp ${netInflowRemoved}) ditolak karena menyebabkan saldo berjalan pada transaksi berikutnya #${rows[i].id} (${rows[i].tanggal}) menjadi negatif (Saldo Awal: Rp ${baselineAtI} -> Simulasi: Rp ${simulatedAtI}).`
      );
    }
  }
}
