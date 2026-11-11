/**
 * Permanent Delete Service with Mandatory Audit Logging & Idempotency
 * Phase 4B Batch 2B — Kas Messenger & Kas Kantor
 * 
 * Strict Acceptance Invariants:
 * 1. Restricted strictly to SVP role (users.role === 'svp' re-validated in-transaction).
 * 2. Mandatory X-Idempotency-Key header and reason (>= 10 characters).
 * 3. Exact fail-closed blocker evaluations for:
 *    - kas_kantor: linked verified payment (409), MODAL_AWAL (400), subsequent negative balance (409).
 *    - kas_messenger: linked reimbursement (409), subsequent negative balance (409).
 *    - pengeluaran: forward and reverse reimbursement FK (409).
 *    - messenger_reimbursements: status not draft/rejected (409), forward and reverse links to kas_messenger or pengeluaran (409).
 * 4. Full dynamic row snapshot captured via `SELECT *` into audit_logs before deletion.
 * 5. Deterministic chronological balance recalculation post-delete.
 * 6. Step B/C compatible idempotency persistence and replay.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db, runInTransaction } from "../database/db";
import { ApiError } from "../middleware/errorHandler";
import {
  recalculateKasKantorRunningBalances,
  recalculateKasMessengerRunningBalances,
  assertNoSubsequentNegativeBalance,
} from "./cashLedgerCalculationService";

export type AllowedPermanentDeleteTable =
  | "kas_kantor"
  | "kas_messenger"
  | "pengeluaran"
  | "messenger_reimbursements";

const ALLOWED_TABLES: readonly AllowedPermanentDeleteTable[] = [
  "kas_kantor",
  "kas_messenger",
  "pengeluaran",
  "messenger_reimbursements",
];

export function deletePermanentlyWithAuditAndIdempotency(
  table: AllowedPermanentDeleteTable,
  id: number | string,
  reason: string,
  actorId: string,
  actorRole: string,
  idempotencyKey: string,
  targetDb: DatabaseSync = db
): { statusCode: number; body: any } {
  // 1. Table Allowlist Validation
  if (!ALLOWED_TABLES.includes(table)) {
    throw new ApiError(400, "INVALID_TARGET_TABLE", `Tabel '${table}' tidak diizinkan untuk penghapusan permanen.`);
  }

  // 2. Reason Validation (>= 10 chars)
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length < 10) {
    throw new ApiError(400, "INVALID_DELETE_REASON", "Alasan penghapusan permanen wajib diisi minimal 10 karakter.");
  }

  // 3. Mandatory Idempotency Key Validation (UUID format)
  const cleanKey = String(idempotencyKey || "").trim();
  if (!cleanKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanKey)) {
    throw new ApiError(400, "MISSING_IDEMPOTENCY_KEY", "Header X-Idempotency-Key (UUID) wajib disertakan dan valid.");
  }

  // 4. Actor Session Identity Validation
  const cleanActorId = String(actorId || "").trim();
  const cleanActorRole = String(actorRole || "").trim().toLowerCase();
  if (!cleanActorId || !cleanActorRole) {
    throw new ApiError(401, "UNAUTHORIZED", "Identitas aktor terautentikasi wajib disediakan dari sesi backend.");
  }

  // 5. Execute Atomic Transaction under Reserved Write Lock (BEGIN IMMEDIATE)
  return runInTransaction(() => {
    // 5.1 In-Transaction Actor Re-Validation Under Write Lock (TOCTOU Defense)
    const actorRow = targetDb.prepare(`
      SELECT id, nama, role, status
      FROM users
      WHERE id = ?
    `).get(cleanActorId) as { id: number | string; nama: string; role: string; status: string } | undefined;

    if (!actorRow) {
      throw new ApiError(403, "FORBIDDEN_USER_NOT_FOUND", "Pengguna terautentikasi tidak ditemukan di database.");
    }

    if (actorRow.status !== "Aktif") {
      throw new ApiError(403, "FORBIDDEN_USER_INACTIVE", "Akun pengguna tidak aktif.");
    }

    const verifiedRole = String(actorRow.role || "").trim().toLowerCase();
    if (verifiedRole !== "svp") {
      throw new ApiError(403, "FORBIDDEN_NOT_SVP", "Penghapusan permanen hanya diizinkan untuk Supervisor (role: svp).");
    }

    // 5.2 Compute Canonical Request Hash & Scope
    const scope = `PERMANENT_DELETE::${table.toUpperCase()}`;
    const scopedKey = `${scope}::${cleanKey}`;
    const payloadToHash = JSON.stringify({
      table,
      id: String(id),
      reason: cleanReason,
      actorId: cleanActorId,
    });
    const requestHash = crypto.createHash("sha256").update(payloadToHash).digest("hex");

    // Idempotency Check Under Write Lock
    const existingIdem = targetDb.prepare(`
      SELECT key, scope, user_id, request_hash, resource_id, response_json
      FROM idempotency_keys
      WHERE key = ?
    `).get(scopedKey) as {
      key: string;
      scope: string;
      user_id: string;
      request_hash: string;
      resource_id: string;
      response_json: string;
    } | undefined;

    if (existingIdem) {
      const isActorMatch = existingIdem.user_id !== null &&
        existingIdem.user_id !== undefined &&
        (String(existingIdem.user_id) === String(cleanActorId) ||
         Number(existingIdem.user_id) === Number(cleanActorId));
      const isResourceMatch = existingIdem.resource_id === String(id) && existingIdem.scope === scope;
      const isPayloadMatch = existingIdem.request_hash === requestHash;

      if (isActorMatch && isResourceMatch && isPayloadMatch) {
        // Replay: Return original cached response directly. NO audit log created, NO delete re-attempted.
        const cachedBody = JSON.parse(existingIdem.response_json);
        return {
          statusCode: 200,
          body: cachedBody,
        };
      } else if (!isActorMatch) {
        throw new ApiError(409, "IDEMPOTENCY_KEY_ACTOR_MISMATCH", "Idempotency key telah digunakan oleh pengguna lain.");
      } else {
        throw new ApiError(409, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", "Idempotency key telah digunakan dengan target entitas atau alasan yang berbeda.");
      }
    }

    // 5.3 Fetch Pre-Deletion Target Entity
    const existing = targetDb.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id) as Record<string, any> | undefined;
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", `Data ${table} #${id} tidak ditemukan.`);
    }

    // 5.4 Business Blocker Evaluations (Fail-Closed)
    if (table === "kas_kantor") {
      if (existing.kategori === "MODAL_AWAL" || Number(id) === 1) {
        throw new ApiError(400, "CANNOT_DELETE_INITIAL_CAPITAL", "Entri modal awal sistem (kategori: 'MODAL_AWAL') dilindungi secara permanen dan tidak dapat dihapus.");
      }
      const linkedPayment = targetDb.prepare("SELECT id FROM invoice_payments WHERE kas_kantor_id = ?").get(id);
      if (linkedPayment) {
        throw new ApiError(409, "CANNOT_DELETE_VERIFIED_PAYMENT", `Entri Kas Kantor #${id} terhubung dengan verifikasi pembayaran dan tidak dapat dihapus.`);
      }
      assertNoSubsequentNegativeBalance("kas_kantor", id, undefined, targetDb);
    }

    if (table === "kas_messenger") {
      if (existing.reimbursement_id) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Entri Kas Messenger #${id} terhubung dengan reimbursement #${existing.reimbursement_id} dan tidak dapat dihapus.`);
      }
      const linkedReimb = targetDb.prepare("SELECT id FROM messenger_reimbursements WHERE kas_messenger_id = ?").get(id);
      if (linkedReimb) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Entri Kas Messenger #${id} terhubung dengan data reimbursement kurir.`);
      }
      assertNoSubsequentNegativeBalance("kas_messenger", id, existing.messenger_id, targetDb);
    }

    if (table === "pengeluaran") {
      // Direction 1: Forward relation (pengeluaran has reimbursement_id)
      if (existing.reimbursement_id) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Pengeluaran #${id} terhubung dengan reimbursement #${existing.reimbursement_id} (forward relation) dan tidak dapat dihapus.`);
      }
      // Direction 2: Reverse relation (messenger_reimbursements has pengeluaran_id)
      const linkedReimb = targetDb.prepare("SELECT id FROM messenger_reimbursements WHERE pengeluaran_id = ?").get(id);
      if (linkedReimb) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Pengeluaran #${id} terhubung dengan data reimbursement kurir #${(linkedReimb as any).id} (reverse relation) dan tidak dapat dihapus.`);
      }
    }

    if (table === "messenger_reimbursements") {
      const currentStatus = String(existing.status || "").toLowerCase().trim();
      if (currentStatus !== "draft" && currentStatus !== "rejected") {
        throw new ApiError(409, "CANNOT_DELETE_ACTIVE_REIMBURSEMENT", `Reimbursement #${id} dengan status '${existing.status}' tidak dapat dihapus. Hanya status 'draft' atau 'rejected' yang diizinkan.`);
      }
      // Check 1: Forward relation to kas_messenger
      if (existing.kas_messenger_id) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Reimbursement #${id} memiliki relasi langsung ke entri kas messenger #${existing.kas_messenger_id} (forward relation).`);
      }
      // Check 2: Reverse relation from kas_messenger
      const linkedCash = targetDb.prepare("SELECT id FROM kas_messenger WHERE reimbursement_id = ?").get(id);
      if (linkedCash) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Reimbursement #${id} terhubung dengan entri kas messenger #${(linkedCash as any).id} (reverse relation).`);
      }
      // Check 3: Forward relation to pengeluaran
      if (existing.pengeluaran_id) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Reimbursement #${id} memiliki relasi langsung ke pengeluaran #${existing.pengeluaran_id} (forward relation).`);
      }
      // Check 4: Reverse relation from pengeluaran
      const linkedPengeluaran = targetDb.prepare("SELECT id FROM pengeluaran WHERE reimbursement_id = ?").get(id);
      if (linkedPengeluaran) {
        throw new ApiError(409, "CANNOT_DELETE_LINKED_REIMBURSEMENT", `Reimbursement #${id} terhubung dengan entri pengeluaran #${(linkedPengeluaran as any).id} (reverse relation).`);
      }
    }

    // 5.5 Pre-Deletion Dynamic Full-Row Audit Snapshot Logging (UUID ID)
    const auditId = `audit-del-${table}-${id}-${crypto.randomUUID()}`;
    targetDb.prepare(`
      INSERT INTO audit_logs (id, user_id, user_name, user_role, action, module, details, metadata_json, created_at)
      VALUES (?, ?, ?, ?, 'PERMANENT_DELETE', ?, ?, ?, datetime('now'))
    `).run(
      auditId,
      String(cleanActorId),
      actorRow.nama,
      actorRow.role,
      table === "kas_kantor" ? "Kas Kantor" : table === "kas_messenger" ? "Kas Messenger" : table === "pengeluaran" ? "Pengeluaran" : "Reimbursement",
      `Penghapusan permanen entri #${id} oleh SVP (Alasan: ${cleanReason})`,
      JSON.stringify({ targetId: id, deletedSnapshot: existing, idempotencyKey: cleanKey })
    );

    // 5.6 Physical DELETE Execution
    const deleteRes = targetDb.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
    if (deleteRes.changes === 0) {
      throw new ApiError(500, "DELETE_FAILED", `Gagal menghapus entri ${table} #${id}.`);
    }

    // 5.7 Recalculate Subsequent Running Balances
    if (table === "kas_kantor") {
      recalculateKasKantorRunningBalances(targetDb);
    } else if (table === "kas_messenger" && existing.messenger_id) {
      recalculateKasMessengerRunningBalances(existing.messenger_id, targetDb);
    }

    // 5.8 Prepare Success Response Body
    const responsePayload = {
      success: true,
      message: `Entri ${table} #${id} berhasil dihapus permanen oleh SVP. Snapshot tersimpan di audit log.`,
      targetId: id,
      deletedAt: new Date().toISOString(),
    };

    // 5.9 Persist Idempotency Record
    targetDb.prepare(`
      INSERT INTO idempotency_keys (key, scope, user_id, request_hash, resource_id, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      scopedKey,
      scope,
      String(cleanActorId),
      requestHash,
      String(id),
      JSON.stringify(responsePayload)
    );

    return {
      statusCode: 200,
      body: responsePayload,
    };
  }, targetDb);
}
