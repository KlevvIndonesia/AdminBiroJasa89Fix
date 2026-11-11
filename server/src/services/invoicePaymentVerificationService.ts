/**
 * Invoice Payment Verification Service
 * Phase 4B Batch 2B — Kas Messenger & Kas Kantor
 * 
 * Strict Acceptance Invariants:
 * 1. paymentId SSoT & Deterministic Resolution.
 * 2. In-Transaction Actor Re-Validation Under Write Lock (TOCTOU Defense).
 * 3. Exact Relational Binding (payment.invoice_no === invoice.invoice_no, ZERO DML on mismatch).
 * 4. Idempotency Replay with fail-closed resource_id binding.
 * 5. Frozen Payment Method Snapshot Validation (Tunai vs Bank).
 * 6. Historical Baseline #1–#7 NULL retention exception.
 * 7. Chronological Kas Kantor running balance recalculation.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db, runInTransaction } from "../database/db";
import { ApiError } from "../middleware/errorHandler";
import { validateAndNormalizeBusinessDate } from "../utils/dateNormalizer";
import { recalculateKasKantorRunningBalances } from "./cashLedgerCalculationService";

export interface PaymentMethodSnapshot {
  id: string;
  nama_metode: string;
  bank: string;
  nama_rekening: string;
  nomor_rekening: string;
}

export interface InvoicePaymentRow {
  id: number;
  payment_id: string | null;
  invoice_no: string;
  order_no: string | null;
  nominal: number;
  tanggal_bayar: string;
  metode_pembayaran: string | null;
  metode_pembayaran_id: string | null;
  payment_method_snapshot: string | null;
  status_verifikasi: string;
  kas_kantor_id: number | null;
  is_void: number;
  created_at: string;
}

export interface IdempotencyRow {
  key: string;
  scope: string;
  user_id: string | null;
  resource_id: string | null;
  request_hash: string;
  response_json: string;
}

/**
 * Validates frozen payment method snapshot JSON string.
 */
export function validatePaymentMethodSnapshot(
  rawSnapshot: string | null | undefined,
  paymentMethodId: string | null | undefined,
  isHistoricalBaseline: boolean
): string | null {
  if (isHistoricalBaseline && !rawSnapshot && !paymentMethodId) {
    return null;
  }

  if (!rawSnapshot || typeof rawSnapshot !== "string" || !rawSnapshot.trim()) {
    throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Payment method snapshot wajib ada untuk pembayaran non-historis.");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawSnapshot);
  } catch {
    throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Payment method snapshot bukan JSON valid.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Payment method snapshot harus berupa object JSON.");
  }

  if (!parsed.id || typeof parsed.id !== "string" || !parsed.id.trim()) {
    throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Snapshot wajib memuat field 'id' tidak kosong.");
  }

  if (paymentMethodId && parsed.id !== paymentMethodId) {
    throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", `Snapshot id '${parsed.id}' tidak sesuai dengan metode pembayaran id '${paymentMethodId}'.`);
  }

  if (!parsed.nama_metode || typeof parsed.nama_metode !== "string" || !parsed.nama_metode.trim()) {
    throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Snapshot wajib memuat field 'nama_metode' tidak kosong.");
  }

  const namaMetode = parsed.nama_metode.trim();
  if (namaMetode === "Tunai") {
    // Tunai: bank, nama_rekening, nomor_rekening can be empty or 'Tunai'
  } else {
    // Bank Transfer
    if (!parsed.bank || typeof parsed.bank !== "string" || !parsed.bank.trim()) {
      throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Snapshot transfer bank wajib memuat field 'bank' tidak kosong.");
    }
    if (!parsed.nama_rekening || typeof parsed.nama_rekening !== "string" || !parsed.nama_rekening.trim()) {
      throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Snapshot transfer bank wajib memuat field 'nama_rekening' tidak kosong.");
    }
    if (!parsed.nomor_rekening || typeof parsed.nomor_rekening !== "string" || !parsed.nomor_rekening.trim()) {
      throw new ApiError(400, "PAYMENT_METHOD_SNAPSHOT_INVALID", "Snapshot transfer bank wajib memuat field 'nomor_rekening' tidak kosong.");
    }
  }

  return rawSnapshot;
}

/**
 * Atomically verifies a customer invoice payment and posts Debit to Kas Kantor.
 */
export function verifyInvoicePaymentAtomic(
  paymentId: number | string,
  invoiceIdentifier: number | string,
  actorId: string,
  actorRole: string,
  idempotencyKey: string,
  targetDb: DatabaseSync = db
): { success: boolean; data: any; timestamp: string } {
  // 1. Mandatory input & header format validations (Outside Transaction)
  const cleanKey = String(idempotencyKey || "").trim();
  if (!cleanKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanKey)) {
    throw new ApiError(400, "MISSING_IDEMPOTENCY_KEY", "Header X-Idempotency-Key (UUID) wajib disertakan dan valid.");
  }

  const cleanActorId = String(actorId || "").trim();
  const cleanActorRole = String(actorRole || "").trim().toLowerCase();
  if (!cleanActorId || !cleanActorRole) {
    throw new ApiError(401, "UNAUTHORIZED", "Identitas aktor terautentikasi wajib disediakan dari sesi backend.");
  }

  const rawInvoiceId = String(invoiceIdentifier || "").trim();
  if (!rawInvoiceId) {
    throw new ApiError(400, "INVALID_INVOICE_IDENTIFIER", "Identifier invoice tidak boleh kosong.");
  }

  const rawPaymentId = String(paymentId || "").trim();
  if (!rawPaymentId) {
    throw new ApiError(400, "INVALID_PAYMENT_IDENTIFIER", "Identifier payment tidak boleh kosong.");
  }

  // 2. Execute inside runInTransaction with targetDb under reserved write lock (BEGIN IMMEDIATE)
  return runInTransaction(() => {
    // 3. In-Transaction Actor Re-Validation Under Write Lock (TOCTOU Defense — FIX-03)
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
    const allowedRoles = ["admin", "administrator", "finance", "svp"];
    if (!allowedRoles.includes(verifiedRole)) {
      throw new ApiError(403, "FORBIDDEN", `Role '${actorRow.role}' tidak memiliki hak akses verifikasi pembayaran.`);
    }

    // 4. Resolve Canonical Invoice Identifier (Deterministic Resolver, No Ambiguous OR Queries)
    let targetInvoice: { id: number; invoice_no: string; order_no: string | null; status: string; total_tagihan: number; is_draft_estimate: number };

    if (/^[1-9]\d*$/.test(rawInvoiceId)) {
      const numId = Number(rawInvoiceId);
      if (!Number.isSafeInteger(numId)) {
        throw new ApiError(400, "INVALID_INVOICE_IDENTIFIER", "Identifier invoice numerik melebihi batas safe integer.");
      }
      const invRow = targetDb.prepare(`
        SELECT id, invoice_no, order_no, status, total_tagihan, is_draft_estimate
        FROM finance_invoices
        WHERE id = ?
      `).get(numId) as typeof targetInvoice | undefined;

      if (!invRow) {
        throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice dengan ID '${rawInvoiceId}' tidak ditemukan.`);
      }
      targetInvoice = invRow;
    } else if (/^0\d+$/.test(rawInvoiceId)) {
      throw new ApiError(400, "INVALID_INVOICE_IDENTIFIER", `Identifier numerik tidak boleh memiliki leading zero: '${rawInvoiceId}'.`);
    } else if (rawInvoiceId.startsWith("INV-")) {
      const invRow = targetDb.prepare(`
        SELECT id, invoice_no, order_no, status, total_tagihan, is_draft_estimate
        FROM finance_invoices
        WHERE invoice_no = ?
      `).get(rawInvoiceId) as typeof targetInvoice | undefined;

      if (!invRow) {
        throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice dengan nomor '${rawInvoiceId}' tidak ditemukan.`);
      }
      targetInvoice = invRow;
    } else if (rawInvoiceId.startsWith("ORD-")) {
      const candidates = targetDb.prepare(`
        SELECT id, invoice_no, order_no, status, total_tagihan, is_draft_estimate
        FROM finance_invoices
        WHERE order_no = ?
      `).all(rawInvoiceId) as typeof targetInvoice[];

      if (candidates.length === 0) {
        throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice untuk order '${rawInvoiceId}' tidak ditemukan.`);
      }
      if (candidates.length > 1) {
        throw new ApiError(409, "INVOICE_IDENTIFIER_AMBIGUOUS", `Order '${rawInvoiceId}' terhubung ke ${candidates.length} invoice. Gunakan invoice_no secara spesifik.`);
      }
      targetInvoice = candidates[0];
    } else {
      throw new ApiError(400, "INVALID_INVOICE_IDENTIFIER", `Format identifier invoice '${rawInvoiceId}' tidak didukung. Gunakan ID numerik, 'INV-...', atau 'ORD-...'.`);
    }

    // 5. Resolve Exact Payment Identity (Deterministic Payment Lookup)
    let payment: InvoicePaymentRow;

    if (/^[1-9]\d*$/.test(rawPaymentId)) {
      const numPaymentId = Number(rawPaymentId);
      if (!Number.isSafeInteger(numPaymentId)) {
        throw new ApiError(400, "INVALID_PAYMENT_IDENTIFIER", "Identifier payment numerik melebihi batas safe integer.");
      }
      const payRow = targetDb.prepare(`
        SELECT id, payment_id, invoice_no, order_no, nominal, tanggal_bayar, metode_pembayaran, metode_pembayaran_id, payment_method_snapshot, status_verifikasi, kas_kantor_id, is_void, created_at
        FROM invoice_payments
        WHERE id = ?
      `).get(numPaymentId) as InvoicePaymentRow | undefined;

      if (!payRow) {
        throw new ApiError(404, "PAYMENT_NOT_FOUND", `Data pembayaran invoice #${rawPaymentId} tidak ditemukan.`);
      }
      payment = payRow;
    } else if (/^0\d+$/.test(rawPaymentId)) {
      throw new ApiError(400, "INVALID_PAYMENT_IDENTIFIER", `Identifier payment tidak boleh memiliki leading zero: '${rawPaymentId}'.`);
    } else {
      const payCandidates = targetDb.prepare(`
        SELECT id, payment_id, invoice_no, order_no, nominal, tanggal_bayar, metode_pembayaran, metode_pembayaran_id, payment_method_snapshot, status_verifikasi, kas_kantor_id, is_void, created_at
        FROM invoice_payments
        WHERE payment_id = ?
      `).all(rawPaymentId) as InvoicePaymentRow[];

      if (payCandidates.length === 0) {
        throw new ApiError(404, "PAYMENT_NOT_FOUND", `Data pembayaran invoice '${rawPaymentId}' tidak ditemukan.`);
      }
      if (payCandidates.length > 1) {
        throw new ApiError(409, "PAYMENT_IDENTIFIER_AMBIGUOUS", `Integritas data terlanggar: ditemukan ${payCandidates.length} pembayaran dengan payment_id '${rawPaymentId}'.`);
      }
      payment = payCandidates[0];
    }

    // 6. Validate Invoice-to-Payment Relational Binding (FIX-04 — ZERO DML on Mismatch)
    if (payment.invoice_no !== targetInvoice.invoice_no) {
      throw new ApiError(404, "PAYMENT_NOT_FOUND", `Pembayaran #${payment.id} tidak terdaftar pada invoice '${targetInvoice.invoice_no}'.`);
    }

    const paymentOrder = payment.order_no ? String(payment.order_no).trim() : null;
    const invoiceOrder = targetInvoice.order_no ? String(targetInvoice.order_no).trim() : null;

    if (paymentOrder && invoiceOrder) {
      if (paymentOrder !== invoiceOrder) {
        throw new ApiError(404, "PAYMENT_NOT_FOUND", `Pembayaran #${payment.id} (order: '${paymentOrder}') tidak cocok dengan order invoice '${invoiceOrder}'.`);
      }
    } else if (paymentOrder && !invoiceOrder) {
      throw new ApiError(404, "PAYMENT_NOT_FOUND", `Pembayaran #${payment.id} memiliki relasi order '${paymentOrder}' tetapi invoice '${targetInvoice.invoice_no}' tidak memiliki relasi order.`);
    } else if (!paymentOrder && invoiceOrder) {
      throw new ApiError(404, "PAYMENT_NOT_FOUND", `Invoice '${targetInvoice.invoice_no}' memiliki relasi order '${invoiceOrder}' tetapi pembayaran #${payment.id} tidak memiliki relasi order.`);
    }

    // 7. Construct Canonical Request Hash from Resolved Canonical Entities & Verified Actor
    const nominal = Number(payment.nominal);
    const canonicalPayload = JSON.stringify({
      scope: "PAYMENT_VERIFICATION",
      invoiceId: targetInvoice.id,
      invoiceNo: targetInvoice.invoice_no,
      paymentId: payment.id,
      paymentUuid: payment.payment_id || null,
      nominal: nominal,
      actorId: cleanActorId,
    });
    const canonicalRequestHash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");

    // 8. Check Existing Idempotency Record Under Reserved Write Lock
    const scopedKey = `PAYMENT_VERIFICATION::${cleanKey}`;
    const existingKey = targetDb.prepare(`
      SELECT key, scope, user_id, resource_id, request_hash, response_json 
      FROM idempotency_keys 
      WHERE key = ? AND scope = 'PAYMENT_VERIFICATION'
    `).get(scopedKey) as IdempotencyRow | undefined;

    // 9. Idempotency Replay Branch with Exact Fail-Closed resource_id (FIX-02)
    if (existingKey) {
      // Fail-closed exact resource_id validation
      if (
        existingKey.resource_id === null ||
        existingKey.resource_id === undefined ||
        typeof existingKey.resource_id !== "string" ||
        existingKey.resource_id.trim() === "" ||
        existingKey.resource_id !== String(payment.id)
      ) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          `Idempotency key telah digunakan dengan resource berbeda: expected payment '${payment.id}', got '${existingKey.resource_id}'.`
        );
      }

      // Validate Actor Ownership
      if (existingKey.user_id !== null && existingKey.user_id !== undefined) {
        if (String(existingKey.user_id) !== String(cleanActorId)) {
          throw new ApiError(403, "IDEMPOTENCY_USER_MISMATCH", "Idempotency key milik pengguna lain.");
        }
      } else {
        const isActorAdmin = verifiedRole === "admin" || verifiedRole === "administrator";
        if (!isActorAdmin) {
          throw new ApiError(403, "IDEMPOTENCY_OWNERSHIP_UNVERIFIABLE", "Kepemilikan record historis tidak dapat diverifikasi; hubungi administrator.");
        }
      }

      // Validate Canonical Hash
      if (existingKey.request_hash !== canonicalRequestHash) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key sudah digunakan untuk transaksi dengan parameter berbeda.");
      }

      // Valid replay: return cached response with ZERO DML
      return JSON.parse(existingKey.response_json);
    }

    // 10. Non-Replay Validation: Invoice Status, Lifecycle, Nominal & Snapshot Invariants
    // 10a. Validate Invoice Status (FIX-07 B)
    if (targetInvoice.is_draft_estimate === 1) {
      throw new ApiError(400, "INVOICE_IS_DRAFT", `Invoice '${targetInvoice.invoice_no}' masih berupa draft estimasi dan belum dapat menerima pembayaran.`);
    }
    const normalizedInvoiceStatus = String(targetInvoice.status || "").trim().toUpperCase();
    if (["CANCELLED", "BATAL", "DIBATALKAN"].includes(normalizedInvoiceStatus)) {
      throw new ApiError(400, "INVOICE_CANCELLED", `Invoice '${targetInvoice.invoice_no}' telah dibatalkan (${targetInvoice.status}) dan tidak dapat menerima verifikasi pembayaran.`);
    }
    const allowedInvoiceStatuses = ["UNPAID", "PARTIAL", "KURANG BAYAR", "BELUM BAYAR", "PAID", "LUNAS"];
    if (!allowedInvoiceStatuses.includes(normalizedInvoiceStatus)) {
      throw new ApiError(400, "INVALID_INVOICE_STATUS", `Status invoice '${targetInvoice.status}' tidak valid untuk verifikasi pembayaran.`);
    }

    // 10b. Validate Payment Nominal
    if (!Number.isFinite(nominal) || nominal <= 0 || !Number.isSafeInteger(nominal) || nominal > 10_000_000_000) {
      throw new ApiError(400, "INVALID_PAYMENT_AMOUNT", `Nominal pembayaran tidak valid: Rp ${payment.nominal}.`);
    }

    // 10c. Validate Payment Lifecycle Status
    if (payment.status_verifikasi === "TERVERIFIKASI") {
      throw new ApiError(409, "PAYMENT_ALREADY_VERIFIED", `Pembayaran #${payment.id} sudah diverifikasi sebelumnya.`);
    }
    if (payment.is_void === 1 || payment.status_verifikasi === "VOID") {
      throw new ApiError(400, "PAYMENT_VOIDED", `Pembayaran #${payment.id} telah dibatalkan (VOID) dan tidak dapat diverifikasi.`);
    }
    const validPendingStatuses = ["MENUNGGU_VERIFIKASI", "PENDING", "MENUNGGU_BUKTI"];
    if (!validPendingStatuses.includes(payment.status_verifikasi)) {
      throw new ApiError(400, "INVALID_PAYMENT_STATUS", `Status pembayaran '${payment.status_verifikasi}' tidak diizinkan untuk verifikasi.`);
    }
    if (payment.kas_kantor_id !== null && payment.kas_kantor_id !== undefined) {
      throw new ApiError(409, "PAYMENT_ALREADY_LINKED", `Pembayaran #${payment.id} sudah terhubung ke entri kas kantor #${payment.kas_kantor_id}.`);
    }

    // 11. Validate Real Calendar Business Date (FIX-07 A)
    const rawTanggal = payment.tanggal_bayar || new Date().toISOString();
    const normalizedTanggal = validateAndNormalizeBusinessDate(rawTanggal);

    // 12. Strict Payment Method Snapshot Validation (FIX-05)
    const isHistoricalBaseline = payment.id <= 7;
    const pmId = payment.metode_pembayaran_id || null;
    const pmSnapshot = validatePaymentMethodSnapshot(payment.payment_method_snapshot, pmId, isHistoricalBaseline);

    // 13. Create Kas Kantor Debit
    const insertKkStmt = targetDb.prepare(`
      INSERT INTO kas_kantor (
        tanggal, keterangan, status, debit, kredit, saldo, 
        penanggung_jawab, order_no, invoice_no, kategori,
        payment_method_id, payment_method_snapshot, created_at
      ) VALUES (?, ?, 'Debit', ?, 0, 0, ?, ?, ?, 'Invoice Payment', ?, ?, CURRENT_TIMESTAMP)
    `);

    const kkResult = insertKkStmt.run(
      normalizedTanggal,
      `Penerimaan pembayaran invoice ${targetInvoice.invoice_no} (Payment #${payment.id})`,
      nominal,
      actorRow.nama || cleanActorId,
      targetInvoice.order_no,
      targetInvoice.invoice_no,
      pmId,
      pmSnapshot
    );
    const newKasKantorId = Number(kkResult.lastInsertRowid);

    // 14. Update strictly the target payment row (sibling payments remain untouched)
    targetDb.prepare(`
      UPDATE invoice_payments
      SET status_verifikasi = 'TERVERIFIKASI',
          kas_kantor_id = ?,
          verified_at = CURRENT_TIMESTAMP,
          verified_by = ?
      WHERE id = ?
    `).run(newKasKantorId, cleanActorId, payment.id);

    // 15. Recalculate kas_kantor running balances chronologically
    recalculateKasKantorRunningBalances(targetDb);

    // 16. Persist idempotency success record
    const responsePayload = {
      success: true,
      data: {
        paymentId: payment.id,
        invoiceNo: targetInvoice.invoice_no,
        orderNo: targetInvoice.order_no,
        kasKantorId: newKasKantorId,
        nominal: nominal,
        status: "TERVERIFIKASI",
        paymentMethodId: pmId,
        hasSnapshot: !!pmSnapshot,
      },
      timestamp: new Date().toISOString(),
    };

    targetDb.prepare(`
      INSERT INTO idempotency_keys (key, scope, resource_id, user_id, request_hash, response_json, created_at)
      VALUES (?, 'PAYMENT_VERIFICATION', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      scopedKey,
      String(payment.id),
      cleanActorId,
      canonicalRequestHash,
      JSON.stringify(responsePayload)
    );

    // 17. Return payload & Commit
    return responsePayload;
  }, targetDb);
}
