/**
 * Finance Domain Service
 * Admin SUN89 — Biro Jasa Management System
 */

import { dbFinanceRepository } from "../repositories/dbFinanceRepository";
import { dbOrderRepository } from "../repositories/dbOrderRepository";
import { dbAuditRepository } from "../repositories/dbAuditRepository";
import { dbDocumentRepository } from "../repositories/dbDocumentRepository";
import { dbMessengerRepository } from "../repositories/dbMessengerRepository";
import { db, runInTransaction } from "../database/db";
import { validateAndNormalizeBusinessDate } from "../utils/dateNormalizer";
import { recalculateKasKantorRunningBalances, recalculateKasMessengerRunningBalances } from "./cashLedgerCalculationService";
import type { DatabaseSync } from "node:sqlite";
import { InvoiceBillingRecord, KasKantorItem, PengeluaranItem, KasMessengerItem, PayoutTransactionRecord, RefundStatus } from "../../../src/domain/finance/types";
import { OperationalOrder } from "../../../src/domain/order/types";
import { CanonicalLabaRugiSummary } from "../../../src/domain/finance/labaRugiCanonical";
import { ApiError } from "../middleware/errorHandler";
import { TokenPayload } from "../utils/crypto";
import { calculateCanonicalInvoiceTotals } from "./canonicalInvoiceCalculator";
import { generateCanonicalPaymentId, hashPaymentSubmissionPayload, hashPaymentVerificationPayload, formatScopedIdempotencyKey } from "../utils/canonicalHasher";

export interface VerifyPaymentInput {
  paymentId?: string;
  orderNo?: string;
  invoiceId?: number | string;
  invoiceNo?: string;
  confirmedAmount?: number;
  notes?: string;
  proofPayload?: any;
  verifierName?: string;
  user?: TokenPayload | null;
  idempotencyKey?: string;
}

export interface FinanceServiceDependencies {
  financeRepo?: typeof dbFinanceRepository;
  orderRepo?: typeof dbOrderRepository;
  auditRepo?: typeof dbAuditRepository;
  documentRepo?: typeof dbDocumentRepository;
  messengerRepo?: typeof dbMessengerRepository;
}

export class FinanceService {
  private readonly financeRepo: typeof dbFinanceRepository;
  private readonly orderRepo: typeof dbOrderRepository;
  private readonly auditRepo: typeof dbAuditRepository;
  private readonly documentRepo: typeof dbDocumentRepository;
  private readonly messengerRepo: typeof dbMessengerRepository;

  constructor(deps?: FinanceServiceDependencies) {
    if (deps && process.env.NODE_ENV === "production") {
      throw new Error("SECURITY_VIOLATION: Custom repository dependencies cannot be initialized in production.");
    }
    this.financeRepo = deps?.financeRepo ?? dbFinanceRepository;
    this.orderRepo = deps?.orderRepo ?? dbOrderRepository;
    this.auditRepo = deps?.auditRepo ?? dbAuditRepository;
    this.documentRepo = deps?.documentRepo ?? dbDocumentRepository;
    this.messengerRepo = deps?.messengerRepo ?? dbMessengerRepository;
  }
  public getAllInvoices(): InvoiceBillingRecord[] {
    return dbFinanceRepository.getAllInvoices();
  }

  public getProfitList(): any[] {
    return dbFinanceRepository.getProfitList();
  }

  public getCanonicalLabaRugiSummary(
    periodFilter: string = "monthly",
    customStartDate?: string,
    customEndDate?: string
  ): CanonicalLabaRugiSummary {
    return dbFinanceRepository.getCanonicalLabaRugiSummary(periodFilter, customStartDate, customEndDate);
  }

  public getInvoiceById(id: number | string): InvoiceBillingRecord {
    const isNum = typeof id === "number" || (!isNaN(Number(id)) && !String(id).startsWith("INV") && !String(id).startsWith("ORD"));
    const inv = isNum
      ? dbFinanceRepository.getInvoiceById(Number(id))
      : (dbFinanceRepository.getInvoiceByNo(String(id)) || dbFinanceRepository.getInvoiceByOrderNo(String(id)));
    if (!inv) {
      throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice ID '${id}' tidak ditemukan.`);
    }
    return inv;
  }

  public getInvoicePayments(invoiceNo: string): any[] {
    return dbFinanceRepository.getPaymentsByInvoiceNo(invoiceNo);
  }

  public getOrderPayments(orderNo: string): any[] {
    return dbFinanceRepository.getPaymentsByOrderNo(orderNo);
  }

  public recordPayment(id: number, amount: number, paymentDetails: any, user?: TokenPayload | null): InvoiceBillingRecord {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nominal pembayaran harus berupa angka positif yang valid.");
    }

    const inv = this.getInvoiceById(id);

    // P0 Anti-Double Payment: Strict rejection if invoice is already fully paid
    const currentPaid = Number(inv.dibayar ?? inv.terbayar ?? 0);
    const currentRemaining = inv.sisa !== undefined ? Number(inv.sisa) : Math.max(0, inv.totalTagihan - currentPaid);

    if ((inv.status === "PAID" || inv.status === "OVERPAID" || inv.status === "Lunas") && currentRemaining <= 0) {
      throw new ApiError(400, "INVOICE_ALREADY_PAID", "Invoice ini sudah lunas. Pembayaran baru tidak dapat diproses.");
    }

    // Phase B Payment Security Gating: Payment cannot be processed before final cost is set and Supervisi is approved
    if (inv.orderNo) {
      const linkedOrder = dbOrderRepository.getByOrderNo(inv.orderNo);
      if (!linkedOrder) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${inv.orderNo}' yang terhubung dengan invoice #${id} tidak ditemukan.`);
      }
      if (linkedOrder.currentStageName === "Dibatalkan" || Boolean((linkedOrder as any).isCancelled)) {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${linkedOrder.orderNo}' telah dibatalkan. Pembayaran tidak dapat diproses.`);
      }

      
      // Cost verification guard: PARTIAL_ESTIMATE orders cannot process final payment until verified
      const snapshot = (linkedOrder as any).costSnapshot || (linkedOrder as any).data_json?.costSnapshot;
      const isPartialEstimate = snapshot?.completenessStatus === "PARTIAL_ESTIMATE" || (linkedOrder as any).cost_completeness_status === "PARTIAL_ESTIMATE";
      const isCostVerified = Boolean((linkedOrder as any).is_cost_verified || (linkedOrder as any).isCostVerified);
      if (isPartialEstimate && !isCostVerified) {
        throw new ApiError(
          400,
          "COST_VERIFICATION_REQUIRED",
          `Pembayaran dan invoice final untuk order '${linkedOrder.orderNo}' tidak dapat diproses karena rincian biaya masih berstatus estimasi parsial dan belum diverifikasi.`
        );
      }

      const hasFinalCost = Boolean(
        linkedOrder.isVerified ||
        (typeof (linkedOrder as any).finalCost === "number" && (linkedOrder as any).finalCost > 0) ||
        linkedOrder.documentApproval?.stage5Verified ||
        linkedOrder.currentStep >= 6
      );
      if (!hasFinalCost) {
        throw new ApiError(
          400,
          "FINAL_COST_NOT_SET",
          `Pembayaran untuk order '${linkedOrder.orderNo}' tidak dapat diproses karena rincian biaya final belum ditetapkan.`
        );
      }

      const isSupervisiApproved = Boolean(
        linkedOrder.approvedBySpv ||
        linkedOrder.documentApproval?.stage6Approved ||
        linkedOrder.currentStep >= 7
      );
      if (!isSupervisiApproved) {
        throw new ApiError(
          400,
          "SUPERVISI_NOT_APPROVED",
          `Pembayaran untuk order '${linkedOrder.orderNo}' tidak dapat diproses karena belum disetujui oleh Supervisor (Stage 6 Supervisi).`
        );
      }
    }

    const proof = paymentDetails?.buktiPembayaran || paymentDetails?.buktiBayar || (paymentDetails?.fileUrl ? {
      fileName: paymentDetails.fileName || "Bukti_Pembayaran",
      fileType: paymentDetails.fileType || "image",
      fileUrl: paymentDetails.fileUrl,
      documentId: paymentDetails.documentId,
      uploadedAt: new Date().toISOString(),
    } : null);

    return runInTransaction(() => {
      // Re-fetch inside transaction lock
      const lockedInv = this.getInvoiceById(id);
      const lockedPaid = Number(lockedInv.dibayar ?? lockedInv.terbayar ?? 0);
      const lockedRemaining = lockedInv.sisa !== undefined ? Number(lockedInv.sisa) : Math.max(0, lockedInv.totalTagihan - lockedPaid);

      if ((lockedInv.status === "PAID" || lockedInv.status === "OVERPAID" || lockedInv.status === "Lunas") && lockedRemaining <= 0) {
        throw new ApiError(400, "INVOICE_ALREADY_PAID", "Invoice ini sudah lunas. Pembayaran baru tidak dapat diproses.");
      }

      // Re-verify payment security gating inside transaction lock
      if (lockedInv.orderNo) {
        const lockedOrder = dbOrderRepository.getByOrderNo(lockedInv.orderNo);
        if (!lockedOrder) {
          throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${lockedInv.orderNo}' yang terhubung dengan invoice #${id} tidak ditemukan.`);
        }
        if (lockedOrder.currentStageName === "Dibatalkan" || Boolean((lockedOrder as any).isCancelled)) {
          throw new ApiError(400, "ORDER_CANCELLED", `Order '${lockedOrder.orderNo}' telah dibatalkan. Pembayaran tidak dapat diproses.`);
        }

        
        // Cost verification guard inside transaction lock
        const lockedSnapshot = (lockedOrder as any).costSnapshot || (lockedOrder as any).data_json?.costSnapshot;
        const isLockedPartial = lockedSnapshot?.completenessStatus === "PARTIAL_ESTIMATE" || (lockedOrder as any).cost_completeness_status === "PARTIAL_ESTIMATE";
        const isLockedCostVerified = Boolean((lockedOrder as any).is_cost_verified || (lockedOrder as any).isCostVerified);
        if (isLockedPartial && !isLockedCostVerified) {
          throw new ApiError(
            400,
            "COST_VERIFICATION_REQUIRED",
            `Pembayaran dan invoice final untuk order '${lockedOrder.orderNo}' tidak dapat diproses karena rincian biaya masih berstatus estimasi parsial dan belum diverifikasi.`
          );
        }

        const hasFinalCost = Boolean(
          lockedOrder.isVerified ||
          (typeof (lockedOrder as any).finalCost === "number" && (lockedOrder as any).finalCost > 0) ||
          lockedOrder.documentApproval?.stage5Verified ||
          lockedOrder.currentStep >= 6
        );
        if (!hasFinalCost) {
          throw new ApiError(
            400,
            "FINAL_COST_NOT_SET",
            `Pembayaran untuk order '${lockedOrder.orderNo}' tidak dapat diproses karena rincian biaya final belum ditetapkan.`
          );
        }

        const isSupervisiApproved = Boolean(
          lockedOrder.approvedBySpv ||
          lockedOrder.documentApproval?.stage6Approved ||
          lockedOrder.currentStep >= 7
        );
        if (!isSupervisiApproved) {
          throw new ApiError(
            400,
            "SUPERVISI_NOT_APPROVED",
            `Pembayaran untuk order '${lockedOrder.orderNo}' tidak dapat diproses karena belum disetujui oleh Supervisor (Stage 6 Supervisi).`
          );
        }
      }

      // P0 Persistent Idempotency: Protect against concurrent retry and prevent parameter reuse
      const rawKey = paymentDetails?.idempotencyKey || paymentDetails?.clientRequestId || paymentDetails?.transactionRef;
      const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : undefined;
      const requestHash = hashPaymentSubmissionPayload(id, amount, paymentDetails || {});

      if (idempotencyKey) {
        const existingRecord = dbFinanceRepository.getIdempotencyRecord(idempotencyKey, "PAYMENT_SUBMISSION");
        if (existingRecord) {
          // Ownership verification
          if (existingRecord.user_id !== null && existingRecord.user_id !== undefined) {
            if (user?.userId && existingRecord.user_id !== user.userId) {
              throw new ApiError(403, "IDEMPOTENCY_USER_MISMATCH", "Idempotency key milik pengguna lain.");
            }
          } else {
            // Historical record with NULL user_id: non-admin callers rejected fail-closed
            const userRole = (user?.role || "").toLowerCase();
            const isAdmin = userRole === "admin" || userRole === "administrator";
            if (!isAdmin) {
              throw new ApiError(403, "IDEMPOTENCY_OWNERSHIP_UNVERIFIABLE", "Kepemilikan record historis tidak dapat diverifikasi; hubungi administrator.");
            }
          }

          if (existingRecord.request_hash === requestHash) {
            // Identical retry: return current invoice directly without double-charging (ZERO DML)
            return this.getInvoiceById(id);
          } else {
            // Reused key with different transaction parameters: reject with 409 Conflict
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              `Idempotency key '${idempotencyKey}' sudah digunakan untuk transaksi pembayaran dengan parameter berbeda.`
            );
          }
        }
      }

      // Generate backend canonical payment UUID (Path 2)
      const canonicalPaymentId = generateCanonicalPaymentId();

      // Phase C Rule 1.B: Initial status must be pending verification.
      // Do NOT post Kas Kantor and do NOT reduce outstanding invoice directly until explicitly verified.
      const nowStr = new Date().toISOString();
      const paymentDate = nowStr.split("T")[0];
      const bankName = paymentDetails?.bank || paymentDetails?.metodePembayaran || "Kas Kantor";
      const invoiceNum = lockedInv.invoiceNo || (lockedInv as any).invoice || `INV-${id}`;

      // Section 1: Resolve Master Payment Method & Construct Frozen Snapshot At Payment Recording Time
      const inputPmId = paymentDetails?.paymentMethodId || paymentDetails?.metode_pembayaran_id || paymentDetails?.payment_method_id || null;
      let pmRow: any = null;

      if (inputPmId) {
        pmRow = db.prepare("SELECT * FROM payment_methods WHERE id = ?").get(String(inputPmId).trim());
        if (!pmRow) {
          throw new ApiError(400, "INVALID_PAYMENT_METHOD", `Metode pembayaran dengan ID '${inputPmId}' tidak ditemukan.`);
        }
      } else if (paymentDetails?.metodePembayaran || paymentDetails?.metode) {
        const methodName = String(paymentDetails.metodePembayaran || paymentDetails.metode).trim();
        pmRow = db.prepare("SELECT * FROM payment_methods WHERE LOWER(nama_metode) = LOWER(?)").get(methodName);
      }

      if (pmRow) {
        const normStatus = String(pmRow.status || "").trim().toLowerCase();
        if (normStatus !== "aktif") {
          throw new ApiError(400, "INVALID_PAYMENT_METHOD", `Metode pembayaran '${pmRow.nama_metode}' tidak aktif.`);
        }
      } else {
        throw new ApiError(400, "INVALID_PAYMENT_METHOD", "Metode pembayaran wajib dipilih dari metode pembayaran aktif.");
      }

      const isBank = (pmRow.bank && String(pmRow.bank).trim() !== "") || /transfer|bank|bca|mandiri|bni|bri/i.test(pmRow.nama_metode);
      const snapshotObj = {
        id: pmRow.id,
        nama_metode: pmRow.nama_metode,
        tipe: isBank ? "BANK" : "CASH",
        bank: pmRow.bank || null,
        nomor_rekening: pmRow.nomor_rekening || null,
        nama_rekening: pmRow.nama_rekening || null,
        frozen_at: nowStr,
      };
      const frozenSnapshotJson = JSON.stringify(snapshotObj);

      // Validate document relation if proof exists
      let verifiedDocId: string | undefined = undefined;
      if (proof?.documentId) {
        const existingDoc = dbDocumentRepository.findById(proof.documentId);
        if (existingDoc) {
          verifiedDocId = proof.documentId;
        }
      }

      const initialStatus = (proof?.fileUrl || verifiedDocId) ? "MENUNGGU_VERIFIKASI" : "MENUNGGU_BUKTI";

      // Record into canonical invoice_payments relational table with kasKantorId: undefined (pending verification)
      dbFinanceRepository.recordInvoicePayment({
        paymentId: canonicalPaymentId,
        invoiceNo: invoiceNum,
        orderNo: lockedInv.orderNo || "",
        nominal: amount,
        metodePembayaran: pmRow.nama_metode,
        namaBank: pmRow.bank || bankName,
        nomorRekening: pmRow.nomor_rekening || paymentDetails?.noRekening || paymentDetails?.nomorRekening || undefined,
        tanggalBayar: paymentDate,
        documentId: verifiedDocId,
        kasKantorId: undefined,
        statusVerifikasi: initialStatus,
        idempotencyKey: idempotencyKey || undefined,
        verifiedBy: undefined,
        verifiedAt: undefined,
        catatan: paymentDetails?.catatan || "Pencatatan Pembayaran (Menunggu Verifikasi)",
        metode_pembayaran_id: pmRow.id,
        payment_method_snapshot: frozenSnapshotJson,
      });

      // Synchronize to linked Order in SQLite orders table as pending payment record
      if (lockedInv.orderNo) {
        const linkedOrder = dbOrderRepository.getByOrderNo(lockedInv.orderNo);
        if (linkedOrder) {
          const newPaymentRecord = {
            id: canonicalPaymentId,
            payment_id: canonicalPaymentId,
            paymentId: canonicalPaymentId,
            idempotencyKey: idempotencyKey || undefined,
            nominal: amount,
            tanggal: nowStr,
            metodePembayaran: pmRow.nama_metode,
            namaBank: pmRow.bank || bankName,
            namaRekening: pmRow.nama_rekening || paymentDetails?.namaRekening || "",
            noRekening: pmRow.nomor_rekening || paymentDetails?.noRekening || "",
            buktiPembayaran: proof,
            statusVerifikasi: initialStatus as any,
            uploadedBy: user?.nama || "Finance User",
            catatan: paymentDetails?.catatan || "Pencatatan Pembayaran (Menunggu Verifikasi)",
            metode_pembayaran_id: pmRow.id,
            payment_method_snapshot: frozenSnapshotJson,
          };
          const existingRecords = linkedOrder.payment?.paymentRecords || [];
          const updatedOrderPayment = {
            ...linkedOrder.payment,
            buktiPembayaran: linkedOrder.payment?.buktiPembayaran || proof,
            paymentRecords: [...existingRecords, newPaymentRecord],
            ...(paymentDetails?.metodePembayaran ? { metodePembayaran: paymentDetails.metodePembayaran } : {}),
          };

          dbOrderRepository.saveOrder({
            ...linkedOrder,
            payment: updatedOrderPayment,
          });
        }
      }

      // Persist idempotency key on success (Plain INSERT, scoped key)
      if (idempotencyKey) {
        dbFinanceRepository.saveIdempotencyRecord({
          key: formatScopedIdempotencyKey("PAYMENT_SUBMISSION", idempotencyKey),
          scope: "PAYMENT_SUBMISSION",
          user_id: user?.userId || null,
          request_hash: requestHash,
          resource_id: String(id),
          response_json: JSON.stringify({ invoiceId: id, paymentId: canonicalPaymentId, amount, status: lockedInv.status, statusVerifikasi: initialStatus }),
        });
      }

      dbAuditRepository.save({
        id: `log-fin-pay-${Date.now()}`,
        userId: user?.userId || "usr-finance",
        userName: user?.nama || "Finance User",
        userRole: user?.role || "finance",
        action: "RECORD_PAYMENT",
        module: "Keuangan",
        details: `Pencatatan pembayaran invoice ${lockedInv.invoiceNo} sejumlah Rp ${amount.toLocaleString("id-ID")} [Status: ${initialStatus}]`,
        metadata: { invoiceId: id, orderNo: lockedInv.orderNo, amount, paymentDetails, statusVerifikasi: initialStatus },
        createdAt: new Date().toISOString(),
      });

      return this.getInvoiceById(id);
    });
  }

  /**
   * Phase 4B Batch 2B Step C: Unified Payment Verification Lifecycle Engine
   * Single Source of Truth for verifying payments across Order Tracking & Finance.
   * Atomically mutates invoice_payments in-place, posts exactly one Debit to kas_kantor,
   * updates finance_invoices via canonical calculator, and updates orders.data_json.
   */
  public verifyPayment(input: VerifyPaymentInput): {
    order: OperationalOrder;
    invoice: InvoiceBillingRecord;
    payment: any;
    kasItem: KasKantorItem;
    isReplay?: boolean;
  } {
    return runInTransaction(() => {
      // 1. Resolve Target Order & Invoice
      let orderNo = (input.orderNo || "").trim();
      let targetInvoice: InvoiceBillingRecord | undefined;

      if (orderNo) {
        targetInvoice = this.financeRepo.getInvoiceByOrderNo(orderNo);
      } else if (input.invoiceId !== undefined && input.invoiceId !== null) {
        targetInvoice = typeof input.invoiceId === "number" || /^\d+$/.test(String(input.invoiceId))
          ? this.financeRepo.getInvoiceById(Number(input.invoiceId))
          : this.financeRepo.getInvoiceByNo(String(input.invoiceId).trim());
        if (targetInvoice && targetInvoice.orderNo) {
          orderNo = targetInvoice.orderNo.trim();
        }
      } else if (input.invoiceNo) {
        targetInvoice = this.financeRepo.getInvoiceByNo(String(input.invoiceNo).trim());
        if (targetInvoice && targetInvoice.orderNo) {
          orderNo = targetInvoice.orderNo.trim();
        }
      }

      if (!orderNo) {
        throw new ApiError(400, "VALIDATION_ERROR", "Order No atau Invoice ID wajib disediakan untuk verifikasi pembayaran.");
      }

      const targetOrder = this.orderRepo.getByOrderNo(orderNo);
      if (!targetOrder) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((targetOrder as any).isCancelled || targetOrder.currentStageName === "Dibatalkan" || (targetOrder as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan dan pembayarannya tidak dapat diverifikasi.`);
      }

      if (!targetInvoice) {
        // Fallback: auto-create/ensure invoice exists for this order
        const totalEstimasi = targetOrder.payment?.totalBiaya || targetOrder.totalEstimasi || 0;
        const invId = this.financeRepo.saveInvoice({
          invoiceNo: targetOrder.payment?.invoiceNo || `INV-${orderNo.replace(/^ORD-/, "")}`,
          orderNo: orderNo,
          customer: targetOrder.customer,
          layanan: targetOrder.layanan,
          nopol: targetOrder.nopol,
          totalTagihan: totalEstimasi,
          dibayar: 0,
          sisa: totalEstimasi,
          status: "UNPAID",
        });
        targetInvoice = this.financeRepo.getInvoiceById(invId)!;
      }

      const resolvedInvoiceNo = (targetInvoice.invoiceNo || (targetInvoice as any).invoice || targetOrder.payment?.invoiceNo || `INV-${orderNo.replace(/^ORD-/, "")}`).trim();
      const nowStr = new Date().toISOString();
      const effectiveVerifier = input.user?.nama || input.verifierName || "Admin";
      const verifierUserId = input.user?.userId || (input.user as any)?.id || input.verifierName || "usr-admin";

      // 1b. Idempotency Check & Replay Protection (Section 7, AC-C-05)
      const rawKey = input.idempotencyKey || (input.user ? undefined : (targetOrder as any).clientRequestId);
      if (rawKey) {
        const existingRecord = this.financeRepo.getIdempotencyRecord(rawKey, "PAYMENT_VERIFICATION");
        if (existingRecord) {
          if (existingRecord.user_id !== null && existingRecord.user_id !== undefined) {
            if (input.user?.userId && existingRecord.user_id !== input.user.userId) {
              throw new ApiError(403, "IDEMPOTENCY_USER_MISMATCH", "Idempotency key milik pengguna lain.");
            }
          }

          const existingPayment = existingRecord.resource_id ? this.financeRepo.getInvoicePaymentById(existingRecord.resource_id) : undefined;
          const targetPaymentId = (input.paymentId ? String(input.paymentId).trim() : undefined) || existingRecord.resource_id || "";
          const targetAmount = input.confirmedAmount !== undefined
            ? Math.max(0, input.confirmedAmount)
            : Number(
                existingPayment?.nominal ??
                targetOrder.payment?.nominalPembayaranAwalTerkonfirmasi ??
                targetOrder.payment?.nominalDibayarAwal ??
                targetOrder.payment?.dibayar ??
                targetInvoice.totalTagihan
              );
          const effectiveProofDocId = input.proofPayload?.documentId || existingPayment?.document_id || targetOrder.payment?.buktiPembayaran?.documentId;
          const checkHash = hashPaymentVerificationPayload(orderNo, targetPaymentId, targetAmount, verifierUserId, input.notes, effectiveProofDocId);

          if (existingRecord.request_hash === checkHash) {
            const currentOrder = this.orderRepo.getByOrderNo(orderNo)!;
            const currentInvoice = this.financeRepo.getInvoiceById(targetInvoice.id)!;
            const currentKas = existingPayment?.kas_kantor_id ? this.financeRepo.getKasKantorById(existingPayment.kas_kantor_id) : undefined;
            return {
              order: currentOrder,
              invoice: currentInvoice,
              payment: existingPayment,
              kasItem: currentKas as any,
              isReplay: true,
            };
          } else {
            throw new ApiError(409, "IDEMPOTENCY_CONFLICT", `Idempotency key '${rawKey}' sudah digunakan untuk transaksi verifikasi dengan parameter berbeda.`);
          }
        }
      }

      // 2. Fetch all payments for this order/invoice
      const allDbPayments = this.financeRepo.getPaymentsByOrderNo(orderNo);
      const existingOrderRecords = targetOrder.payment?.paymentRecords || [];

      // 3. Target Payment Resolution
      let targetPaymentRow: any = undefined;
      let targetOrderRecord: any = undefined;
      let canonicalPaymentId: string | undefined = undefined;

      const rawPaymentId = input.paymentId ? String(input.paymentId).trim() : undefined;

      if (rawPaymentId) {
        // Branch 1: Specific paymentId provided (UUID or numeric id)
        targetPaymentRow = this.financeRepo.getInvoicePaymentById(rawPaymentId);
        if (targetPaymentRow) {
          if (targetPaymentRow.order_no && targetPaymentRow.order_no.toUpperCase() !== orderNo.toUpperCase()) {
            throw new ApiError(404, "PAYMENT_NOT_FOUND", `Pembayaran '${rawPaymentId}' tidak terdaftar pada order '${orderNo}'.`);
          }
          if (targetPaymentRow.is_void === 1 || targetPaymentRow.status_verifikasi === "VOID") {
            throw new ApiError(400, "PAYMENT_VOIDED", `Pembayaran '${rawPaymentId}' telah dibatalkan (VOID) dan tidak dapat diverifikasi.`);
          }
          canonicalPaymentId = targetPaymentRow.payment_id || `pay-${targetPaymentRow.id}`;
        }

        // Also find matching record in order JSON if available
        targetOrderRecord = existingOrderRecords.find(
          (pr: any) => pr.payment_id === rawPaymentId || pr.paymentId === rawPaymentId || pr.id === rawPaymentId || (targetPaymentRow && (pr.payment_id === targetPaymentRow.payment_id || pr.id === targetPaymentRow.payment_id))
        );

        if (!targetPaymentRow && targetOrderRecord) {
          canonicalPaymentId = targetOrderRecord.payment_id || targetOrderRecord.paymentId || targetOrderRecord.id || generateCanonicalPaymentId();
        }

        if (!targetPaymentRow && !targetOrderRecord) {
          throw new ApiError(404, "PAYMENT_NOT_FOUND", `Pembayaran '${rawPaymentId}' tidak ditemukan untuk order '${orderNo}'.`);
        }
      } else {
        // Branch 2: Legacy Fallback (No paymentId provided - AC-C-06)
        const pendingDbPayments = allDbPayments.filter(
          (p: any) => !p.is_void && (p.status_verifikasi === "MENUNGGU_VERIFIKASI" || p.status_verifikasi === "MENUNGGU_BUKTI" || p.status_verifikasi === "PENDING")
        );

        const verifiedPaymentIds = new Set(
          allDbPayments.filter((p: any) => p.status_verifikasi === "TERVERIFIKASI").map((p: any) => p.payment_id || String(p.id))
        );
        const pendingOrderRecords = existingOrderRecords.filter(
          (pr: any) =>
            !verifiedPaymentIds.has(pr.payment_id) &&
            !verifiedPaymentIds.has(pr.paymentId) &&
            !verifiedPaymentIds.has(pr.id) &&
            (pr.statusVerifikasi === "MENUNGGU_VERIFIKASI" || pr.statusVerifikasi === "MENUNGGU_BUKTI" || pr.statusVerifikasi === "PENDING" || pr.statusVerifikasi === undefined)
        );

        // Combine unique candidates by payment UUID / id
        const candidateMap = new Map<string, { dbRow?: any; orderRecord?: any }>();
        for (const p of pendingDbPayments) {
          const key = p.payment_id || String(p.id);
          candidateMap.set(key, { dbRow: p });
        }
        for (const pr of pendingOrderRecords) {
          const key = pr.payment_id || pr.paymentId || pr.id || "pending-initial";
          if (candidateMap.has(key)) {
            candidateMap.get(key)!.orderRecord = pr;
          } else {
            candidateMap.set(key, { orderRecord: pr });
          }
        }

        const candidateCount = candidateMap.size;
        if (candidateCount === 0) {
          throw new ApiError(400, "NO_PENDING_PAYMENT", "Tidak ada pembayaran berstatus pending yang dapat diverifikasi.");
        }
        if (candidateCount > 1) {
          throw new ApiError(422, "AMBIGUOUS_PAYMENT_TARGET", "Ditemukan lebih dari satu pembayaran pending. Harap tentukan paymentId yang ingin diverifikasi.");
        }

        const [candKey, candidate] = Array.from(candidateMap.entries())[0];
        targetPaymentRow = candidate.dbRow;
        targetOrderRecord = candidate.orderRecord;
        canonicalPaymentId = targetPaymentRow?.payment_id || targetOrderRecord?.payment_id || targetOrderRecord?.paymentId || (candKey.startsWith("pay-") ? candKey : generateCanonicalPaymentId());
      }

      if (!canonicalPaymentId) {
        canonicalPaymentId = generateCanonicalPaymentId();
      }

      // 4. Resolve Amount and Proof
      const resolvedNominal = input.confirmedAmount !== undefined
        ? Math.max(0, input.confirmedAmount)
        : Number(
            targetPaymentRow?.nominal ??
            targetOrderRecord?.nominal ??
            targetOrder.payment?.nominalPembayaranAwalTerkonfirmasi ??
            targetOrder.payment?.nominalDibayarAwal ??
            targetOrder.payment?.dibayar ??
            targetInvoice.totalTagihan
          );

      const effectiveProof =
        input.proofPayload ||
        targetOrderRecord?.buktiPembayaran ||
        targetOrderRecord?.buktiBayar ||
        targetPaymentRow?.bukti_pembayaran ||
        targetOrder.payment?.buktiPembayaran;

      if (resolvedNominal > 0 && !effectiveProof?.fileUrl && !effectiveProof?.fileName && !targetPaymentRow?.document_id && !targetOrderRecord?.documentId) {
        throw new ApiError(400, "PAYMENT_PROOF_REQUIRED", "Bukti pembayaran (file bukti transfer/kas loket) wajib dilampirkan sebelum pembayaran dapat diverifikasi.");
      }

      // 5. Idempotency Request Hash for Persistence (Section 7, AC-C-05)
      const requestHash = rawKey ? hashPaymentVerificationPayload(orderNo, canonicalPaymentId, resolvedNominal, verifierUserId, input.notes, effectiveProof?.documentId) : "";

      // If target payment is ALREADY verified, reject without valid idempotency replay (AC-C-06)
      if (targetPaymentRow && targetPaymentRow.status_verifikasi === "TERVERIFIKASI") {
        throw new ApiError(400, "PAYMENT_ALREADY_VERIFIED", `Pembayaran '${canonicalPaymentId || rawPaymentId}' sudah diverifikasi sebelumnya.`);
      }

      // 6. Mutate / Insert into invoice_payments in-place (AC-C-01, AC-C-03)
      let paymentRowId: number;
      let effectivePmId: string | null = null;
      let effectivePmSnapshot: string | null = null;

      if (targetPaymentRow) {
        paymentRowId = targetPaymentRow.id;
        effectivePmId = targetPaymentRow.metode_pembayaran_id || null;
        effectivePmSnapshot = targetPaymentRow.payment_method_snapshot || null;

        this.financeRepo.updateInvoicePayment(paymentRowId, {
          payment_id: canonicalPaymentId,
          nominal: resolvedNominal,
          status_verifikasi: "TERVERIFIKASI",
          verified_by: effectiveVerifier,
          verified_at: nowStr,
          catatan: input.notes || targetPaymentRow.catatan || "Verifikasi Pembayaran",
        });
      } else {
        // Read historical frozen snapshot from targetOrderRecord recorded at initial recording time (order creation)
        // INVARIANT: Verification ONLY reads existing snapshot; ZERO queries to payment_methods master table!
        effectivePmSnapshot =
          targetOrderRecord?.payment_method_snapshot ||
          targetOrderRecord?.paymentMethodSnapshot ||
          (targetOrder.payment as any)?.paymentMethodSnapshot ||
          null;

        effectivePmId =
          targetOrderRecord?.payment_method_id ||
          targetOrderRecord?.paymentMethodId ||
          targetOrderRecord?.metode_pembayaran_id ||
          (targetOrder.payment as any)?.paymentMethodId ||
          null;

        if (!effectivePmId && effectivePmSnapshot) {
          try {
            const parsed = JSON.parse(effectivePmSnapshot);
            if (parsed?.id) effectivePmId = parsed.id;
          } catch {
            // malformed snapshot handled downstream
          }
        }

        const insertedRow = this.financeRepo.recordInvoicePayment({
          paymentId: canonicalPaymentId,
          invoiceNo: resolvedInvoiceNo,
          orderNo: orderNo,
          nominal: resolvedNominal,
          metodePembayaran: targetOrderRecord?.metodePembayaran || targetOrder.payment?.metodePembayaran || "Transfer Bank",
          namaBank: targetOrderRecord?.namaBank || targetOrder.payment?.namaBank || "",
          nomorRekening: targetOrderRecord?.noRekening || targetOrderRecord?.nomorRekening || targetOrder.payment?.noRekening || "",
          tanggalBayar: targetOrderRecord?.tanggal || nowStr.split("T")[0],
          documentId: targetOrderRecord?.documentId || effectiveProof?.documentId,
          statusVerifikasi: "TERVERIFIKASI",
          verifiedBy: effectiveVerifier,
          verifiedAt: nowStr,
          catatan: input.notes || "Verifikasi Pembayaran",
          metode_pembayaran_id: effectivePmId || undefined,
          payment_method_snapshot: effectivePmSnapshot || undefined,
        });
        paymentRowId = insertedRow.id;
      }

      // 7. Atomic Cash Posting to kas_kantor (AC-C-02, AC-C-04)
      const kasItem = this.financeRepo.addKasKantor({
        tanggal: nowStr.split("T")[0],
        keterangan: `Penerimaan Pembayaran Invoice ${resolvedInvoiceNo} (Order ${orderNo}) - ${targetOrderRecord?.metodePembayaran || targetPaymentRow?.metode_pembayaran || targetOrder.payment?.metodePembayaran || "Transfer Bank"}`,
        status: "Debit",
        debit: resolvedNominal,
        kredit: 0,
        penanggungJawab: effectiveVerifier,
        orderNo: orderNo,
        invoiceNo: resolvedInvoiceNo,
        kategori: "PEMBAYARAN_INVOICE",
        payment_method_id: effectivePmId,
        payment_method_snapshot: effectivePmSnapshot,
      });

      // Link kas_kantor_id back to invoice_payments
      this.financeRepo.updateInvoicePayment(paymentRowId, {
        kas_kantor_id: kasItem.id,
      });

      // 8. Canonical Invoice Recalculation (AC-C-03)
      const allPaymentsAfter = this.financeRepo.getPaymentsByOrderNo(orderNo);
      const calc = calculateCanonicalInvoiceTotals({
        invoiceNo: resolvedInvoiceNo,
        orderNo: orderNo,
        totalTagihan: targetInvoice.totalTagihan,
        biayaSamsat: targetInvoice.biayaSamsat,
        isExplicitZero: Boolean(targetInvoice.isExplicitZero),
        basePaid: 0,
        payments: allPaymentsAfter,
      });

      this.financeRepo.updateInvoice(targetInvoice.id, {
        status: calc.status as any,
        dibayar: calc.verifiedPaid,
        sisa: calc.sisaTagihan,
        overpayment: calc.overpayment,
        settlementCondition: calc.settlementCondition,
        profit: calc.grossProfit,
        profitStatus: calc.profitStatus as any,
      });

      // 9. Synchronize orders.data_json in-place (AC-C-01, AC-C-03)
      let recordUpdated = false;
      const updatedOrderRecords = existingOrderRecords.map((pr: any) => {
        const isTarget =
          pr.payment_id === canonicalPaymentId ||
          pr.paymentId === canonicalPaymentId ||
          pr.id === canonicalPaymentId ||
          (targetPaymentRow && (pr.payment_id === targetPaymentRow.payment_id || pr.id === targetPaymentRow.payment_id));

        if (isTarget) {
          recordUpdated = true;
          return {
            ...pr,
            id: canonicalPaymentId,
            payment_id: canonicalPaymentId,
            paymentId: canonicalPaymentId,
            nominal: resolvedNominal,
            statusVerifikasi: "TERVERIFIKASI" as const,
            verifiedAt: nowStr,
            verifiedBy: effectiveVerifier,
            kasKantorId: kasItem.id,
            kas_kantor_id: kasItem.id,
            catatan: input.notes || pr.catatan || "Verifikasi Pembayaran",
            buktiPembayaran: effectiveProof || pr.buktiPembayaran,
          };
        }
        return pr;
      });

      if (!recordUpdated) {
        updatedOrderRecords.push({
          id: canonicalPaymentId,
          payment_id: canonicalPaymentId,
          paymentId: canonicalPaymentId,
          nominal: resolvedNominal,
          tanggal: nowStr,
          metodePembayaran: targetPaymentRow?.metode_pembayaran || targetOrder.payment?.metodePembayaran || "Transfer Bank",
          namaBank: targetPaymentRow?.nama_bank || targetOrder.payment?.namaBank || "",
          nomorRekening: targetPaymentRow?.nomor_rekening || targetOrder.payment?.noRekening || "",
          statusVerifikasi: "TERVERIFIKASI" as const,
          verifiedAt: nowStr,
          verifiedBy: effectiveVerifier,
          kasKantorId: kasItem.id,
          kas_kantor_id: kasItem.id,
          catatan: input.notes || "Verifikasi Pembayaran",
          buktiPembayaran: effectiveProof,
        });
      }

      // History of payment correction
      const prevConfirmed = targetOrder.payment?.nominalPembayaranAwalTerkonfirmasi ?? targetOrder.payment?.nominalDibayarAwal ?? targetOrder.payment?.dibayar ?? 0;
      const riwayat = [...(targetOrder.payment?.riwayatKoreksiPembayaran || [])];
      if (prevConfirmed !== resolvedNominal || input.notes) {
        riwayat.push({
          nominalLama: prevConfirmed,
          nominalBaru: resolvedNominal,
          tanggal: nowStr,
          admin: effectiveVerifier,
          catatan: input.notes,
        });
      }

      const orderPaymentStatus = calc.sisaTagihan <= 0 && calc.verifiedPaid > 0 ? "Lunas" : calc.verifiedPaid > 0 ? "Kurang Bayar" : "Belum Bayar";

      const updatedPaymentObj = {
        ...targetOrder.payment,
        isPaymentVerified: true,
        paymentVerifiedAt: nowStr,
        paymentVerifiedBy: effectiveVerifier,
        nominalPembayaranAwalTerkonfirmasi: calc.verifiedPaid,
        statusPembayaran: orderPaymentStatus as any,
        dibayar: calc.verifiedPaid,
        kurang: calc.sisaTagihan,
        overpayment: calc.overpayment,
        tanggalBayar: targetOrder.payment?.tanggalBayar || nowStr.split("T")[0],
        buktiPembayaran: effectiveProof,
        riwayatKoreksiPembayaran: riwayat,
        paymentRecords: updatedOrderRecords,
      };

      this.orderRepo.updateOrder(orderNo, { payment: updatedPaymentObj });

      const finalOrder = this.orderRepo.getByOrderNo(orderNo)!;
      const finalInvoice = this.financeRepo.getInvoiceById(targetInvoice.id)!;
      const finalPaymentRow = this.financeRepo.getInvoicePaymentById(paymentRowId);

      // 10. Persist Idempotency Record (if key provided) & Audit Log
      if (rawKey) {
        this.financeRepo.saveIdempotencyRecord({
          key: formatScopedIdempotencyKey("PAYMENT_VERIFICATION", rawKey),
          scope: "PAYMENT_VERIFICATION",
          user_id: input.user?.userId || null,
          request_hash: requestHash,
          resource_id: canonicalPaymentId,
          response_json: JSON.stringify({
            orderNo,
            invoiceNo: resolvedInvoiceNo,
            paymentId: canonicalPaymentId,
            amount: resolvedNominal,
            kasKantorId: kasItem.id,
            statusVerifikasi: "TERVERIFIKASI",
          }),
        });
      }

      this.auditRepo.save({
        id: `log-pay-verif-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        userId: input.user?.userId || "usr-finance",
        userName: effectiveVerifier,
        userRole: input.user?.role || "finance",
        action: "VERIFY_PAYMENT",
        module: "Keuangan",
        details: `Verifikasi pembayaran ${canonicalPaymentId} invoice ${resolvedInvoiceNo} sejumlah Rp ${resolvedNominal.toLocaleString("id-ID")}`,
        metadata: {
          orderNo,
          invoiceNo: resolvedInvoiceNo,
          paymentId: canonicalPaymentId,
          amount: resolvedNominal,
          kasKantorId: kasItem.id,
        },
        createdAt: nowStr,
      });

      return {
        order: finalOrder,
        invoice: finalInvoice,
        payment: finalPaymentRow,
        kasItem,
      };
    });
  }

  public getAllKasKantor(): KasKantorItem[] {
    return dbFinanceRepository.getAllKasKantor();
  }

  public addKasKantor(
    item: Omit<KasKantorItem, "id"> & {
      payment_method_id?: string | null;
      payment_method_snapshot?: string | null;
      paymentMethodId?: string | null;
      paymentMethodSnapshot?: string | null;
    },
    user?: TokenPayload | null,
    targetDb?: DatabaseSync
  ): KasKantorItem {
    const rawOrderNo = (item as any).orderNo?.trim();
    const rawInvoiceNo = (item as any).invoiceNo?.trim();

    if (rawOrderNo) {
      const orderExists = dbOrderRepository.getByOrderNo(rawOrderNo);
      if (!orderExists) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${rawOrderNo}' tidak ditemukan.`);
      }
    }

    if (rawInvoiceNo) {
      const invExists = dbFinanceRepository.getInvoiceByNo(rawInvoiceNo);
      if (!invExists) {
        throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice '${rawInvoiceNo}' tidak ditemukan.`);
      }
    }

    // Business date validation
    const normalizedDate = validateAndNormalizeBusinessDate(item.tanggal);

    // Strict Debit/Kredit Mutual Exclusivity Invariant
    const isDebit = item.status === "Debit" || item.status === "Pemasukan";
    const isKredit = item.status === "Kredit" || item.status === "Pengeluaran";
    let debitVal = Number(item.debit ?? (isDebit ? ((item as any).nominal ?? 0) : 0));
    let kreditVal = Number(item.kredit ?? (isKredit ? ((item as any).nominal ?? 0) : 0));

    if (debitVal < 0 || kreditVal < 0) {
      throw new ApiError(400, "INVALID_TRANSACTION_AMOUNTS", "Nominal debit dan kredit tidak boleh bernilai negatif.");
    }
    if (debitVal > 0 && kreditVal > 0) {
      throw new ApiError(400, "INVALID_TRANSACTION_AMOUNTS", "Nominal debit dan kredit bersifat mutually exclusive. Hanya satu yang boleh bernilai positif.");
    }
    if (debitVal === 0 && kreditVal === 0) {
      throw new ApiError(400, "ZERO_TRANSACTION_AMOUNT", "Nominal transaksi tidak boleh nol.");
    }

    // Pre-Reset Hardening Guard 1: Authorization for Opening Balance / Modal Awal
    const isModalAwal = item.kategori === "MODAL_AWAL";
    if (isModalAwal) {
      if (user && user.role !== "admin" && user.role !== "supervisor" && user.role !== "svp") {
        throw new ApiError(403, "FORBIDDEN", "Hanya Administrator atau Supervisor yang berwenang menyetor modal awal / opening balance.");
      }
    }

    const activeDb = targetDb ?? db;

    // Payment method validation
    const rawPmId = (item as any).payment_method_id || (item as any).paymentMethodId;
    let paymentMethodId: string | null = null;
    let paymentMethodSnapshot: string | null = null;

    if (rawPmId) {
      const pm = activeDb.prepare("SELECT * FROM payment_methods WHERE id = ?").get(rawPmId) as any;
      if (!pm || pm.status?.trim().toLowerCase() !== "aktif") {
        throw new ApiError(400, "INVALID_PAYMENT_METHOD", "Metode pembayaran tidak valid atau tidak aktif.");
      }
      paymentMethodId = pm.id;
      paymentMethodSnapshot = JSON.stringify({
        id: pm.id,
        nama_metode: pm.nama_metode,
        bank: pm.bank,
        nama_rekening: pm.nama_rekening || "",
        nomor_rekening: pm.nomor_rekening || "",
      });
    } else if (!isModalAwal) {
      throw new ApiError(400, "INVALID_PAYMENT_METHOD", "Metode pembayaran wajib dipilih untuk transaksi kas kantor operasional.");
    }

    return runInTransaction(() => {
      // Pre-Reset Hardening Guard 2: Office Cash Balance Guard (Prevent Negative Cash) - Atomic Validation
      if (kreditVal > 0) {
        const officeBalRow = activeDb.prepare("SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(kredit), 0) as balance FROM kas_kantor").get() as any;
        const officeBalance = officeBalRow?.balance ?? 0;
        if (officeBalance < kreditVal) {
          throw new ApiError(400, "INSUFFICIENT_OFFICE_BALANCE", `Saldo Kas Kantor (Rp ${officeBalance.toLocaleString("id-ID")}) tidak mencukupi untuk pengeluaran sebesar Rp ${kreditVal.toLocaleString("id-ID")}.`);
        }
      }

      const created = dbFinanceRepository.addKasKantor({
        ...item,
        tanggal: normalizedDate,
        status: debitVal > 0 ? "Debit" : "Kredit",
        debit: debitVal,
        kredit: kreditVal,
        payment_method_id: paymentMethodId,
        payment_method_snapshot: paymentMethodSnapshot,
      }, activeDb);

      dbAuditRepository.save({
        id: `log-kas-${Date.now()}`,
        userId: user?.userId || "usr-finance",
        userName: user?.nama || "Finance User",
        userRole: user?.role || "finance",
        action: "ADD_KAS",
        module: "Kas Kantor",
        details: `Transaksi Kas: ${item.keterangan} (${created.status}) Rp ${(created.debit || created.kredit).toLocaleString("id-ID")}`,
        metadata: { item: created },
        createdAt: new Date().toISOString(),
      });

      return created;
    }, activeDb);
  }

  public payoutCashback(
    id: number,
    payoutData: {
      nominal: number;
      paymentType?: "KELEBIHAN" | "KOMISI" | "ALL";
      penerima: string;
      nomorHP?: string;
      bank: string;
      noRekening: string;
      namaRekening: string;
      buktiPembayaran: any;
      catatan?: string;
      expectedVersion?: number;
      idempotencyKey?: string;
    },
    user?: TokenPayload | null
  ): InvoiceBillingRecord {
    const nominal = Number(payoutData.nominal || (payoutData as any).amount);
    if (!Number.isFinite(nominal) || nominal <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nominal pencairan cashback/refund harus berupa angka positif.");
    }
    if (!payoutData.penerima || !payoutData.penerima.trim()) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nama penerima cashback/refund wajib diisi.");
    }
    const isCash = (payoutData as any).paymentMethod?.toLowerCase().includes("tunai") ||
                   (payoutData as any).paymentMethod?.toLowerCase().includes("cash") ||
                   payoutData.bank?.toLowerCase().includes("tunai") ||
                   payoutData.bank?.toLowerCase().includes("cash") ||
                   payoutData.bank === "Kas Kantor" ||
                   payoutData.bank === "—" ||
                   payoutData.bank === "-";

    if (!isCash) {
      if (!payoutData.bank || !payoutData.bank.trim() || !payoutData.noRekening || !payoutData.noRekening.trim()) {
        throw new ApiError(400, "VALIDATION_ERROR", "Informasi rekening bank tujuan (Nama Bank dan Nomor Rekening) wajib diisi untuk transfer bank.");
      }
      payoutData.namaRekening = (payoutData.namaRekening || "").trim();
    }

    const proof = payoutData.buktiPembayaran || (payoutData as any).fileUrl ? {
      fileName: payoutData.buktiPembayaran?.fileName || (payoutData as any).fileName || "Bukti_Transfer_Cashback",
      fileType: payoutData.buktiPembayaran?.fileType || (payoutData as any).fileType || "image",
      fileUrl: payoutData.buktiPembayaran?.fileUrl || (payoutData as any).fileUrl,
      documentId: payoutData.buktiPembayaran?.documentId || (payoutData as any).documentId,
      uploadedAt: new Date().toISOString(),
    } : null;

    // Phase B Payment Security Gating: Cashback cannot be disbursed before final cost is set and Supervisi is approved
    const invPre = this.getInvoiceById(id);
    if (!invPre) {
      throw new ApiError(404, "NOT_FOUND", `Invoice #${id} tidak ditemukan.`);
    }

    if (invPre.orderNo) {
      const linkedOrder = dbOrderRepository.getByOrderNo(invPre.orderNo);
      if (!linkedOrder) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${invPre.orderNo}' yang terhubung dengan invoice #${id} tidak ditemukan.`);
      }
      const isCancelledOrder = linkedOrder.currentStageName === "Dibatalkan" || Boolean((linkedOrder as any).isCancelled);
      if (isCancelledOrder) {
        if (!invPre.overpayment || invPre.overpayment <= 0) {
          throw new ApiError(400, "ORDER_CANCELLED", `Order '${linkedOrder.orderNo}' telah dibatalkan dan tidak memiliki saldo dana titipan untuk dikembalikan.`);
        }
      } else {
        const hasFinalCost = Boolean(
          linkedOrder.isVerified ||
          (typeof (linkedOrder as any).finalCost === "number" && (linkedOrder as any).finalCost > 0) ||
          linkedOrder.documentApproval?.stage5Verified ||
          linkedOrder.currentStep >= 6
        );
        if (!hasFinalCost) {
          throw new ApiError(
            400,
            "FINAL_COST_NOT_SET",
            `Pencairan cashback/kelebihan bayar untuk order '${linkedOrder.orderNo}' tidak dapat diproses karena rincian biaya final belum ditetapkan.`
          );
        }

        const isSupervisiApproved = Boolean(
          linkedOrder.approvedBySpv ||
          linkedOrder.documentApproval?.stage6Approved ||
          linkedOrder.currentStep >= 7
        );
        if (!isSupervisiApproved) {
          throw new ApiError(
            400,
            "SUPERVISI_NOT_APPROVED",
            `Pencairan cashback/kelebihan bayar untuk order '${linkedOrder.orderNo}' tidak dapat diproses karena belum disetujui oleh Supervisor (Stage 6 Supervisi).`
          );
        }
      }
    }

    return runInTransaction(() => {
      const inv = this.getInvoiceById(id);
      if (!inv) {
        throw new ApiError(404, "NOT_FOUND", `Invoice #${id} tidak ditemukan.`);
      }

      // Re-verify payment security gating inside transaction lock
      if (inv.orderNo) {
        const lockedOrder = dbOrderRepository.getByOrderNo(inv.orderNo);
        if (!lockedOrder) {
          throw new ApiError(404, "ORDER_NOT_FOUND", "Order tidak valid.");
        }
        const isCancelledOrder = lockedOrder.currentStageName === "Dibatalkan" || Boolean((lockedOrder as any).isCancelled);
        if (isCancelledOrder) {
          if (!inv.overpayment || inv.overpayment <= 0) {
            throw new ApiError(400, "ORDER_CANCELLED", "Order telah dibatalkan dan tidak memiliki saldo refund.");
          }
        } else {
          const isSupervisiApproved = Boolean(
            lockedOrder.approvedBySpv ||
            lockedOrder.documentApproval?.stage6Approved ||
            lockedOrder.currentStep >= 7
          );
          if (!isSupervisiApproved) {
            throw new ApiError(
              400,
              "SUPERVISI_NOT_APPROVED",
              "Pencairan ditolak karena belum disetujui oleh Supervisor (Stage 6 Supervisi)."
            );
          }
        }
      }

      const pType: "KELEBIHAN" | "KOMISI" | "ALL" = payoutData.paymentType || (inv.overpayment && inv.overpayment > 0 ? "KELEBIHAN" : "KOMISI");

      // DEF-FIN-005: Cashback Payout Mandatory Idempotency Guard
      const idempotencyKey = (payoutData as any).idempotencyKey || (payoutData as any).clientRequestId || (payoutData as any).transactionRef;
      if (!idempotencyKey || typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency key wajib disertakan untuk transaksi pencairan cashback.");
      }

      const cleanKey = idempotencyKey.trim();
      const requestHash = `${id}:${nominal}:${pType}:${(payoutData.penerima || "").trim()}:${(payoutData.bank || "").trim()}:${(payoutData.noRekening || "").trim()}`;

      const existingRecord = dbFinanceRepository.getIdempotencyRecord(cleanKey, "cashback_payout");
      if (existingRecord) {
        if (existingRecord.request_hash === requestHash) {
          // Identical retry: return current invoice directly without duplicate cash deduction
          return this.getInvoiceById(id);
        } else {
          // Reused key with different transaction parameters: reject with 409 Conflict
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            `Idempotency key '${cleanKey}' sudah digunakan untuk transaksi pencairan cashback dengan parameter berbeda.`
          );
        }
      }

      // DEF-FIN-005 Phase 5 & GAP A: Mandatory Version-based Optimistic Concurrency Control (OCC)
      const currentVersion = Number((inv as any).payoutVersion ?? (inv.payoutHistory || []).length);
      
      const rawExpVersion = payoutData.expectedVersion;
      if (rawExpVersion === undefined || rawExpVersion === null || String(rawExpVersion).trim() === "") {
        throw new ApiError(400, "EXPECTED_VERSION_REQUIRED", "expectedVersion wajib disertakan untuk transaksi pencairan cashback.");
      }

      const expVersionNum = Number(rawExpVersion);
      if (isNaN(expVersionNum) || !Number.isInteger(expVersionNum) || expVersionNum < 0) {
        throw new ApiError(400, "INVALID_EXPECTED_VERSION", "expectedVersion harus berupa bilangan bulat non-negatif (0, 1, 2, ...).");
      }

      if (expVersionNum !== currentVersion) {
        throw new ApiError(
          409,
          "CONCURRENT_MODIFICATION",
          `Pencairan ditolak karena data invoice telah diperbarui oleh transaksi lain (versi server: ${currentVersion}, versi request: ${expVersionNum}). Silakan muat ulang invoice.`,
          {
            currentVersion,
            expectedVersion: expVersionNum,
            invoiceId: id,
            remainingRefund: inv.remainingRefund !== undefined ? inv.remainingRefund : Number(inv.overpayment || 0),
          }
        );
      }

      const payoutHistory: PayoutTransactionRecord[] = [...(inv.payoutHistory || [])];
      let nominalToPay = nominal;
      let newRefundStatus: RefundStatus | undefined = undefined;
      let newRefundedAmount = inv.refundedAmount || 0;
      let newRemainingRefund = inv.remainingRefund !== undefined ? inv.remainingRefund : Number(inv.overpayment || 0);

      if (pType === "KELEBIHAN") {
        const totalLiability = Number(inv.overpayment || 0);
        const priorRefunded = payoutHistory
          .filter((p) => p.payoutType === "KELEBIHAN" && p.status === "PROCESSED")
          .reduce((sum, p) => sum + Number(p.nominal || 0), 0);
        
        const effectivePriorRefunded = priorRefunded > 0 ? priorRefunded : (inv.refundStatus === "PROCESSED" ? totalLiability : 0);
        const remainingRefund = Math.max(0, totalLiability - effectivePriorRefunded);

        if (remainingRefund <= 0 || (inv.refundStatus === "PROCESSED" && effectivePriorRefunded >= totalLiability && totalLiability > 0)) {
          throw new ApiError(400, "ALREADY_PROCESSED", "Pengembalian kelebihan bayar untuk invoice ini sudah diproses sepenuhnya.");
        }

        if (nominalToPay <= 0) {
          nominalToPay = remainingRefund;
        }

        if (nominalToPay > remainingRefund) {
          throw new ApiError(
            400,
            "EXCEEDS_LIMIT",
            `Nominal pencairan (Rp ${nominalToPay.toLocaleString("id-ID")}) melebihi sisa kelebihan bayar yang belum dikembalikan (Rp ${remainingRefund.toLocaleString("id-ID")}).`
          );
        }

        newRefundedAmount = effectivePriorRefunded + nominalToPay;
        newRemainingRefund = Math.max(0, totalLiability - newRefundedAmount);
        newRefundStatus = newRemainingRefund === 0 ? "PROCESSED" : "PARTIALLY_REFUNDED";
      } else if (pType === "KOMISI") {
        const totalCashback = Number(inv.cashback || 0);
        const priorCashback = payoutHistory
          .filter((p) => p.payoutType === "KOMISI" && p.status === "PROCESSED")
          .reduce((sum, p) => sum + Number(p.nominal || 0), 0);
        
        const effectivePriorCashback = priorCashback > 0 ? priorCashback : (inv.cashbackStatus === "REALIZED" ? totalCashback : 0);
        const remainingCashback = Math.max(0, totalCashback - effectivePriorCashback);

        if (remainingCashback <= 0 || inv.cashbackStatus === "REALIZED") {
          throw new ApiError(400, "ALREADY_PROCESSED", "Pencairan komisi rekanan untuk invoice ini sudah diproses sebelumnya.");
        }

        if (nominalToPay <= 0) {
          nominalToPay = remainingCashback;
        }

        if (nominalToPay > remainingCashback) {
          throw new ApiError(
            400,
            "EXCEEDS_LIMIT",
            `Nominal pencairan (Rp ${nominalToPay.toLocaleString("id-ID")}) melebihi saldo komisi yang tersedia (Rp ${remainingCashback.toLocaleString("id-ID")}).`
          );
        }
      }

      const nowStr = new Date().toISOString();
      const paymentDate = (payoutData as any).tanggal && typeof (payoutData as any).tanggal === "string" && (payoutData as any).tanggal.trim()
        ? (payoutData as any).tanggal.trim()
        : nowStr.split("T")[0];

      // 1. Record atomic Kas Keluar (Kredit) in kas_kantor
      const channelDesc = isCash ? "Kas Tunai" : `Transfer ${payoutData.bank || ""}`.trim();
      const desc = pType === "KELEBIHAN"
        ? `Pengembalian kelebihan bayar: ${inv.invoiceNo || `INV-${id}`} - ${payoutData.penerima} (${inv.nopol || "-"} / ${channelDesc})`
        : `Pencairan komisi rekanan: ${inv.invoiceNo || `INV-${id}`} - ${payoutData.penerima} (${inv.nopol || "-"} / ${channelDesc})`;

      const kasRecord = dbFinanceRepository.addKasKantor({
        tanggal: paymentDate,
        keterangan: desc,
        status: "Kredit",
        debit: 0,
        kredit: nominalToPay,
        penanggungJawab: user?.nama || "Finance User",
        orderNo: inv.orderNo || undefined,
        invoiceNo: inv.invoiceNo || `INV-${id}`,
      });

      // 2. Create distinct PayoutTransactionRecord
      const payoutId = (payoutData as any).payoutId || `payout-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const payoutRecord: PayoutTransactionRecord = {
        id: payoutId,
        invoiceId: id,
        invoiceNo: inv.invoiceNo || `INV-${id}`,
        orderNo: inv.orderNo,
        payoutType: pType === "KOMISI" ? "KOMISI" : "KELEBIHAN",
        nominal: nominalToPay,
        tanggal: paymentDate,
        metode: isCash ? "Tunai" : "Transfer Bank",
        penerima: payoutData.penerima,
        status: "PROCESSED",
        kasKantorId: kasRecord.id,
        processedAt: nowStr,
        processedBy: user?.nama || "Finance User",
        proofUrl: proof,
        bank: payoutData.bank,
        noRekening: payoutData.noRekening,
        namaRekening: payoutData.namaRekening,
        idempotencyKey: idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim() ? idempotencyKey.trim() : undefined,
      };

      payoutHistory.push(payoutRecord);

      const updates: Partial<InvoiceBillingRecord> = {
        payoutHistory,
        payoutVersion: currentVersion + 1,
      };

      if (pType === "KELEBIHAN" || pType === "ALL") {
        updates.refundStatus = newRefundStatus || "PROCESSED";
        updates.refundLiability = Number(inv.overpayment || 0);
        updates.refundedAmount = newRefundedAmount;
        updates.remainingRefund = newRemainingRefund;
        (updates as any).refundProcessedAt = nowStr;
        (updates as any).refundProcessedBy = user?.nama || "Finance User";
        (updates as any).refundProof = proof;
        (updates as any).refundAccount = isCash ? {
          penerima: payoutData.penerima,
          nomorHP: payoutData.nomorHP || "-",
          metode: "Tunai",
        } : {
          penerima: payoutData.penerima,
          nomorHP: payoutData.nomorHP || "-",
          bank: payoutData.bank,
          noRekening: payoutData.noRekening,
          namaRekening: payoutData.namaRekening,
        };
      }
      if (pType === "KOMISI" || pType === "ALL") {
        updates.cashbackStatus = "REALIZED";
        updates.cashbackPaidAmount = Number(inv.cashback || 0);
        (updates as any).cashbackPaidAt = nowStr;
        (updates as any).cashbackPaidBy = user?.nama || "Finance User";
        (updates as any).cashbackProof = proof;
        (updates as any).cashbackAccount = isCash ? {
          penerima: payoutData.penerima,
          nomorHP: payoutData.nomorHP || "-",
          metode: "Tunai",
        } : {
          penerima: payoutData.penerima,
          nomorHP: payoutData.nomorHP || "-",
          bank: payoutData.bank,
          noRekening: payoutData.noRekening,
          namaRekening: payoutData.namaRekening,
        };
      }

      const success = dbFinanceRepository.updateInvoice(id, updates);
      if (!success) {
        throw new ApiError(500, "PAYMENT_FAILED", "Gagal memperbarui status pencairan pada invoice.");
      }

      // Synchronize to linked order if present
      if (inv.orderNo) {
        const linkedOrder = dbOrderRepository.getByOrderNo(inv.orderNo);
        if (linkedOrder) {
          dbOrderRepository.saveOrder({
            ...linkedOrder,
            payment: {
              ...linkedOrder.payment,
              refundStatus: updates.refundStatus || linkedOrder.payment?.refundStatus,
              refundAmount: nominalToPay,
              refundProcessedAt: nowStr,
              refundProcessedBy: user?.nama || "Finance User",
            },
          });
        }
      }

      // Persist idempotency record on success
      if (idempotencyKey && typeof idempotencyKey === "string" && idempotencyKey.trim()) {
        dbFinanceRepository.saveIdempotencyRecord({
          key: idempotencyKey.trim(),
          scope: "cashback_payout",
          user_id: user?.userId || null,
          request_hash: requestHash,
          resource_id: String(id),
          response_json: JSON.stringify({
            invoiceId: id,
            nominal: nominalToPay,
            status: "PROCESSED",
            payoutId,
            payoutType: pType,
            payoutVersion: currentVersion + 1,
            remainingRefund: newRemainingRefund,
            refundStatus: newRefundStatus,
          }),
        });
      }

      // Audit Log
      dbAuditRepository.save({
        id: `log-cashback-pay-${Date.now()}`,
        userId: user?.userId || "usr-finance",
        userName: user?.nama || "Finance User",
        userRole: user?.role || "finance",
        action: "CASHBACK_PAYOUT",
        module: "Cashback Terpending",
        details: `${desc} sejumlah Rp ${nominalToPay.toLocaleString("id-ID")}`,
        metadata: { invoiceId: id, orderNo: inv.orderNo, nominal: nominalToPay, payoutId, payoutData },
        createdAt: nowStr,
      });

      return this.getInvoiceById(id);
    });
  }

  public completeInvoice(id: number, user?: TokenPayload | null): InvoiceBillingRecord {
    return runInTransaction(() => {
      const inv = this.getInvoiceById(id);
      const paid = Number(inv.terbayar ?? inv.dibayar) || 0;
      const total = Number(inv.totalTagihan) || 0;
      const sisa = inv.sisa !== undefined ? Number(inv.sisa) : Math.max(0, total - paid);

      if (paid < total || sisa > 0) {
        throw new ApiError(400, "INVOICE_NOT_PAID", "Hanya tagihan yang sudah lunas yang dapat diselesaikan dan diarsipkan.");
      }

      const isStandardPaid = (inv.status === "Lunas" || inv.status === "PAID") && (inv.overpayment || 0) <= 0;
      const isOverpaid = inv.status === "OVERPAID" || Number(inv.overpayment || 0) > 0;

      if (!isStandardPaid && !isOverpaid) {
        throw new ApiError(400, "INVOICE_NOT_PAID", "Hanya tagihan yang sudah lunas yang dapat diselesaikan dan diarsipkan.");
      }

      // DEF-FIN-003: For OVERPAID invoices, closing is strictly gated on complete verified refund with actual cash journal evidence
      if (isOverpaid) {
        const totalLiability = Number(inv.overpayment || 0);
        const payoutHistory = inv.payoutHistory || [];
        const seenPayoutIds = new Set<string>();
        const seenKasIds = new Set<number>();
        let verifiedRefundsPaid = 0;

        for (const p of payoutHistory) {
          if (p.payoutType === "KELEBIHAN" && p.status === "PROCESSED") {
            // 1. Transaction identity uniqueness
            if (!p.id || seenPayoutIds.has(p.id)) {
              continue; // Duplicate payout transaction ID ignored
            }
            seenPayoutIds.add(p.id);

            // 2. Verified cash journal linkage in kas_kantor
            if (!p.kasKantorId || seenKasIds.has(p.kasKantorId)) {
              continue; // Missing or duplicate kas journal reference
            }
            seenKasIds.add(p.kasKantorId);

            // Query actual cash journal from kas_kantor
            const kasRow = db.prepare("SELECT * FROM kas_kantor WHERE id = ?").get(p.kasKantorId) as any;
            if (!kasRow) {
              continue; // Cash journal row does not exist on disk!
            }

            // 3. Status and amount verification: must be Kredit and match payout nominal, never Batal or Void
            if (kasRow.status !== "Kredit" || (kasRow.keterangan && (kasRow.keterangan.includes("[BATAL]") || kasRow.keterangan.includes("[VOID]")))) {
              continue; // Cash journal is not a valid Kredit journal or was marked Batal/Void!
            }

            const kasNominal = Number(kasRow.kredit || 0);
            if (kasNominal !== Number(p.nominal) || kasNominal <= 0) {
              continue; // Nominal mismatch between payout record and cash journal!
            }

            // 4. Invoice linkage: kas journal must be linked to this invoice or linked order
            const invMatch = (!kasRow.invoice_no || kasRow.invoice_no === inv.invoiceNo || kasRow.invoice_no === (inv as any).invoice) &&
                             (!kasRow.order_no || kasRow.order_no === inv.orderNo);
            if (!invMatch) {
              continue; // Cash journal belongs to a different invoice or order!
            }

            // 5. Check if this cash journal was subsequently voided
            const voidCheck = db.prepare("SELECT COUNT(*) as count FROM kas_kantor WHERE keterangan LIKE ?").get(`%[VOID]%#${p.kasKantorId}%`) as any;
            if (voidCheck && voidCheck.count > 0) {
              continue; // Cash journal was voided / reversed!
            }

            verifiedRefundsPaid += Number(p.nominal);
          }
        }

        if (verifiedRefundsPaid < totalLiability || inv.refundStatus !== "PROCESSED") {
          const sisaRefund = Math.max(0, totalLiability - verifiedRefundsPaid);
          throw new ApiError(
            400,
            "REFUND_NOT_COMPLETED",
            `Invoice dengan kelebihan bayar tidak dapat diselesaikan karena pengembalian dana pelanggan belum tuntas atau bukti jurnal kas tidak valid. Sisa kelebihan bayar: Rp ${sisaRefund.toLocaleString("id-ID")} (Status Refund: ${inv.refundStatus || "BELUM_DIPROSES"}).`
          );
        }
      }

            if (inv.orderNo) {
        const linkedOrder = dbOrderRepository.getByOrderNo(inv.orderNo);
        if (linkedOrder) {
          const snapshot = (linkedOrder as any).costSnapshot || (linkedOrder as any).data_json?.costSnapshot;
          const isPartialEstimate = snapshot?.completenessStatus === "PARTIAL_ESTIMATE" || (linkedOrder as any).cost_completeness_status === "PARTIAL_ESTIMATE";
          const isCostVerified = Boolean((linkedOrder as any).is_cost_verified || (linkedOrder as any).isCostVerified);
          if (isPartialEstimate && !isCostVerified) {
            throw new ApiError(
              400,
              "COST_VERIFICATION_REQUIRED",
              `Invoice untuk order '${linkedOrder.orderNo}' tidak dapat diselesaikan karena rincian biaya masih berstatus estimasi parsial dan belum diverifikasi.`
            );
          }
        }
      }

      const nowStr = new Date().toISOString();
      const success = dbFinanceRepository.updateInvoice(id, {
        billingStatus: "COMPLETED",
        completedAt: nowStr,
        completedBy: user?.nama || "Finance User",
      });

      if (!success) {
        throw new ApiError(500, "UPDATE_FAILED", "Gagal memperbarui status invoice.");
      }

      dbAuditRepository.save({
        id: `log-inv-complete-${Date.now()}`,
        userId: user?.userId || "usr-finance",
        userName: user?.nama || "Finance User",
        userRole: user?.role || "finance",
        action: "COMPLETE_INVOICE",
        module: "Tagihan",
        details: `Menyelesaikan dan mengarsipkan tagihan ${inv.invoiceNo}`,
        metadata: { invoiceId: id, orderNo: inv.orderNo },
        createdAt: nowStr,
      });

      return this.getInvoiceById(id);
    });
  }

  /**
   * Void / Cancel a recorded invoice payment (Storno / Reversal).
   * Restricted strictly to roles: Administrator, Supervisor (SPV), or SVP.
   * Atomically posts a Kredit reversal into kas_kantor, marks invoice_payment as VOID,
   * decrements paid amount, restores remaining balance, resets invoice and order status,
   * and records an immutable audit log.
   */
  public voidInvoicePayment(
    id: number | string,
    paymentId: number | string,
    voidReason: string,
    user?: TokenPayload | null
  ): InvoiceBillingRecord {
    const userRole = (user?.role || "").toLowerCase();
    const isSpvOrAdmin =
      userRole === "administrator" ||
      userRole === "supervisor" ||
      userRole === "spv" ||
      userRole === "svp" ||
      (user as any)?.jabatan === "SVP";

    if (!isSpvOrAdmin) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Hanya Supervisor (SPV) atau Administrator yang berwenang membatalkan transaksi pembayaran."
      );
    }

    const reason = (voidReason || "").trim();
    if (!reason || reason.length < 10) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Alasan pembatalan transaksi wajib diisi minimal 10 karakter demi akuntabilitas audit."
      );
    }

    return runInTransaction(() => {
      const inv = this.getInvoiceById(id);
      if (!inv) {
        throw new ApiError(404, "NOT_FOUND", `Invoice #${id} tidak ditemukan.`);
      }

      const payment = dbFinanceRepository.getInvoicePaymentById(paymentId);
      if (!payment) {
        throw new ApiError(404, "PAYMENT_NOT_FOUND", `Data pembayaran #${paymentId} tidak ditemukan.`);
      }

      if (payment.is_void === 1 || payment.status_verifikasi === "VOID") {
        throw new ApiError(400, "PAYMENT_ALREADY_VOIDED", `Pembayaran #${paymentId} sudah dibatalkan sebelumnya.`);
      }

      const invoiceNum = inv.invoiceNo || (inv as any).invoice || `INV-${id}`;
      if (payment.invoice_no !== invoiceNum && payment.invoice_no !== inv.invoiceNo) {
        throw new ApiError(
          400,
          "PAYMENT_MISMATCH",
          `Pembayaran #${paymentId} tidak terdaftar pada invoice ${invoiceNum}.`
        );
      }

      const amount = Number(payment.nominal);
      const nowStr = new Date().toISOString();
      const paymentDate = nowStr.split("T")[0];

      let reversalKasId: number | null = null;

      // 1. Authoritative cash journal check: Post atomic Kredit reversal in Kas Kantor
      // ONLY IF this payment was verified and produced a genuine debit entry in kas_kantor.
      // If payment is unverified or has no actual cash journal link, no reversal journal is created.
      if (payment.kas_kantor_id) {
        const originalKas = dbFinanceRepository.getKasKantorById(payment.kas_kantor_id);
        if (originalKas) {
          const reversalKas = dbFinanceRepository.addKasKantor({
            tanggal: paymentDate,
            keterangan: `[BATAL/VOID] Koreksi Pelunasan: ${invoiceNum} [Ref: Kas #${payment.kas_kantor_id}] - ${reason}`,
            status: "Kredit",
            debit: 0,
            kredit: amount,
            penanggungJawab: user?.nama || "Supervisor",
            orderNo: inv.orderNo || undefined,
            invoiceNo: invoiceNum,
          });
          reversalKasId = reversalKas.id;
        }
      }

      // 2. Mark payment as VOID
      dbFinanceRepository.updateInvoicePayment(paymentId, {
        is_void: 1,
        status_verifikasi: "VOID",
        void_reason: reason,
        voided_by: user?.nama || "Supervisor",
        voided_at: nowStr,
        reversal_kas_id: reversalKasId,
      });

      // 3. Recalculate invoice balance and status strictly using Canonical Invoice Calculator (GAP-FIN-01 & GAP-FIN-05)
      const payments = dbFinanceRepository.getPaymentsByOrderNo(inv.orderNo || "");
      const totalTagihan = Number(inv.totalTagihan || 0);
      const calc = calculateCanonicalInvoiceTotals({
        invoiceNo: invoiceNum,
        orderNo: inv.orderNo || "",
        totalTagihan,
        biayaSamsat: Number(inv.biayaSamsat || 0),
        isExplicitZero: Boolean(inv.isExplicitZero),
        payments,
      });

      const newPaid = calc.verifiedPaid;
      const newSisa = calc.sisaTagihan;
      const newOverpayment = calc.overpayment;
      const newSettlement = calc.settlementCondition;
      const newRefundStatus = calc.overpayment > 0 ? "PENDING" : "NONE";
      const profitStatus = calc.profitStatus as any;

      dbFinanceRepository.updateInvoice(Number(inv.id), {
        dibayar: newPaid,
        sisa: newSisa,
        overpayment: newOverpayment,
        settlementCondition: newSettlement,
        refundStatus: newRefundStatus,
        profit: calc.grossProfit,
        profitStatus,
        status: calc.status as any,
        billingStatus: "ACTIVE",
      });

      // 4. Synchronize with linked Order in orders table
      if (inv.orderNo) {
        const linkedOrder = dbOrderRepository.getByOrderNo(inv.orderNo);
        if (linkedOrder) {
          const existingRecords = (linkedOrder.payment?.paymentRecords || []).map((r: any) => {
            if (
              r.id === payment.idempotency_key ||
              r.id === `pay-${payment.idempotency_key}` ||
              (Number(r.nominal) === amount && !r.isVoid)
            ) {
              return { ...r, statusVerifikasi: "VOID", isVoid: true, voidReason: reason, voidedAt: nowStr, voidedBy: user?.nama || "Supervisor" };
            }
            return r;
          });
          const orderPayStatus = newOverpayment > 0 ? "Kelebihan Bayar" : ((newSisa === 0 && totalTagihan > 0) ? "Lunas" : (newPaid > 0 ? "Kurang" : "Belum Lunas"));
          dbOrderRepository.saveOrder({
            ...linkedOrder,
            payment: {
              ...linkedOrder.payment,
              dibayar: newPaid,
              kurang: newSisa,
              overpayment: newOverpayment,
              settlementCondition: newSettlement,
              refundStatus: newRefundStatus,
              statusPembayaran: orderPayStatus as any,
              isPaymentVerified: (newSisa === 0 || newOverpayment > 0) && totalTagihan > 0,
              paymentRecords: existingRecords,
            },
          });
        }
      }

      // 5. Immutable Audit Log
      dbAuditRepository.save({
        id: `log-void-pay-${Date.now()}`,
        userId: user?.userId || "usr-spv",
        userName: user?.nama || "Supervisor",
        userRole: user?.role || "supervisor",
        action: "VOID_INVOICE_PAYMENT",
        module: "Finance Tagihan",
        details: `[VOID] Pembatalan pembayaran #${paymentId} (${invoiceNum}) sebesar Rp ${amount.toLocaleString("id-ID")} oleh ${user?.nama}. Alasan: ${reason}`,
        metadata: {
          invoiceId: id,
          paymentId,
          nominal: amount,
          reason,
          reversalKasId: reversalKasId || null,
          hadKasEntry: Boolean(payment.kas_kantor_id),
        },
        createdAt: nowStr,
      });

      return this.getInvoiceById(id);
    });
  }

  /**
   * Void / Cancel a disbursed cashback or overpayment refund.
   * Restricted strictly to roles: Administrator, Supervisor (SPV), or SVP.
   * Atomically posts a Debit reversal into kas_kantor (restores cash),
   * resets invoice refundStatus back to PENDING, and logs to audit trail.
   */
  public voidCashbackPayout(
    id: number,
    voidReason: string,
    user?: TokenPayload | null,
    options?: { payoutId?: string; payoutType?: "KELEBIHAN" | "KOMISI" }
  ): InvoiceBillingRecord {
    const userRole = (user?.role || "").toLowerCase();
    const isSpvOrAdmin =
      userRole === "administrator" ||
      userRole === "supervisor" ||
      userRole === "spv" ||
      userRole === "svp" ||
      (user as any)?.jabatan === "SVP";

    if (!isSpvOrAdmin) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Hanya Supervisor (SPV) atau Administrator yang berwenang membatalkan transaksi pencairan cashback."
      );
    }

    const reason = (voidReason || "").trim();
    if (!reason || reason.length < 10) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Alasan pembatalan transaksi wajib diisi minimal 10 karakter demi akuntabilitas audit."
      );
    }

    return runInTransaction(() => {
      const inv = this.getInvoiceById(id);
      if (!inv) {
        throw new ApiError(404, "NOT_FOUND", `Invoice #${id} tidak ditemukan.`);
      }

      const payoutHistory: PayoutTransactionRecord[] = [...(inv.payoutHistory || [])];
      let targetPayout: PayoutTransactionRecord | undefined = undefined;
      let targetType: "KELEBIHAN" | "KOMISI" = options?.payoutType || "KELEBIHAN";

      if (options?.payoutId) {
        targetPayout = payoutHistory.find((p) => p.id === options.payoutId);
        if (!targetPayout) {
          throw new ApiError(404, "NOT_FOUND", `Transaksi pencairan dengan ID '${options.payoutId}' tidak ditemukan.`);
        }
        if (targetPayout.status === "VOIDED") {
          throw new ApiError(400, "ALREADY_VOIDED", "Transaksi pencairan ini sudah pernah dibatalkan (void) sebelumnya.");
        }
        targetType = targetPayout.payoutType;
      } else if (options?.payoutType) {
        targetType = options.payoutType;
        const matches = payoutHistory.filter((p) => p.payoutType === targetType && p.status === "PROCESSED");
        if (matches.length > 0) {
          targetPayout = matches[matches.length - 1];
        } else {
          if (targetType === "KELEBIHAN") {
            if (inv.refundStatus !== "PROCESSED" && inv.refundStatus !== "PARTIALLY_REFUNDED") {
              throw new ApiError(
                400,
                "ALREADY_VOIDED",
                "Pencairan kelebihan bayar untuk invoice ini belum diproses atau sudah dibatalkan sebelumnya."
              );
            }
          } else if (targetType === "KOMISI") {
            if (inv.cashbackStatus !== "REALIZED") {
              throw new ApiError(
                400,
                "ALREADY_VOIDED",
                "Pencairan komisi rekanan untuk invoice ini belum diproses atau sudah dibatalkan sebelumnya."
              );
            }
          }
        }
      } else {
        const activeRefundPayouts = payoutHistory.filter((p) => p.payoutType === "KELEBIHAN" && p.status === "PROCESSED");
        const activeCashbackPayouts = payoutHistory.filter((p) => p.payoutType === "KOMISI" && p.status === "PROCESSED");
        const isRefundActive = activeRefundPayouts.length > 0 || inv.refundStatus === "PROCESSED" || inv.refundStatus === "PARTIALLY_REFUNDED";
        const isCashbackActive = activeCashbackPayouts.length > 0 || inv.cashbackStatus === "REALIZED";

        if (!isRefundActive && !isCashbackActive) {
          throw new ApiError(
            400,
            "CASHBACK_NOT_PROCESSED",
            "Pencairan untuk invoice ini belum pernah diproses atau sudah dibatalkan sebelumnya."
          );
        }

        if (isRefundActive && isCashbackActive) {
          throw new ApiError(
            400,
            "AMBIGUOUS_PAYOUT_TYPE",
            "Invoice ini memiliki pencairan kelebihan bayar dan komisi rekanan. Harap tentukan payoutType ('KELEBIHAN' atau 'KOMISI') atau payoutId yang ingin dibatalkan."
          );
        }

        if (isRefundActive) {
          targetType = "KELEBIHAN";
          if (activeRefundPayouts.length > 0) {
            targetPayout = activeRefundPayouts[activeRefundPayouts.length - 1];
          }
        } else {
          targetType = "KOMISI";
          if (activeCashbackPayouts.length > 0) {
            targetPayout = activeCashbackPayouts[activeCashbackPayouts.length - 1];
          }
        }
      }

      // Exact reversal nominal strictly derived from target payout or liability
      const nominal = targetPayout
        ? Number(targetPayout.nominal)
        : (targetType === "KELEBIHAN" ? Number(inv.overpayment || 0) : Number(inv.cashback || 0));

      if (nominal <= 0) {
        throw new ApiError(400, "INVALID_NOMINAL", "Nominal transaksi pencairan tidak valid untuk dilakukan void.");
      }

      const invoiceNum = inv.invoiceNo || (inv as any).invoice || `INV-${id}`;
      const nowStr = new Date().toISOString();
      const paymentDate = nowStr.split("T")[0];

      // 1. Post atomic Debit reversal in Kas Kantor (restore cash)
      const reversalKas = dbFinanceRepository.addKasKantor({
        tanggal: paymentDate,
        keterangan: `[BATAL/VOID] Koreksi Pencairan ${targetType === "KELEBIHAN" ? "Kelebihan Bayar" : "Komisi Rekanan"}: ${invoiceNum} - ${reason}`,
        status: "Debit",
        debit: nominal,
        kredit: 0,
        penanggungJawab: user?.nama || "Supervisor",
        orderNo: inv.orderNo || undefined,
        invoiceNo: invoiceNum,
      });

      // 2. Mark targeted payout as VOIDED in history
      if (targetPayout) {
        targetPayout.status = "VOIDED";
        targetPayout.voidReason = reason;
        targetPayout.voidedAt = nowStr;
        targetPayout.voidedBy = user?.nama || "Supervisor";
        targetPayout.voidKasKantorId = reversalKas.id;
      }

      // 3. Revert invoice status strictly according to targetType
      const updates: Partial<InvoiceBillingRecord> = {
        payoutHistory,
      };

      if (targetType === "KELEBIHAN") {
        const remainingActiveRefunds = payoutHistory
          .filter((p) => p.payoutType === "KELEBIHAN" && p.status === "PROCESSED")
          .reduce((sum, p) => sum + Number(p.nominal || 0), 0);
        
        const totalOverpayment = Number(inv.overpayment || 0);
        const restoredRemaining = Math.max(0, totalOverpayment - remainingActiveRefunds);

        updates.refundedAmount = remainingActiveRefunds;
        updates.remainingRefund = restoredRemaining;
        updates.refundStatus = remainingActiveRefunds === 0 ? "PENDING" : "PARTIALLY_REFUNDED";
        updates.settlementCondition = "OVERPAID";
        // cashbackStatus is 100% UNTOUCHED
      } else {
        updates.cashbackStatus = "PENDING";
        updates.cashbackPaidAmount = 0;
        // refundStatus is 100% UNTOUCHED
      }

      dbFinanceRepository.updateInvoice(id, updates);

      // 4. Immutable Audit Log
      dbAuditRepository.save({
        id: `log-void-payout-${Date.now()}`,
        userId: user?.userId || "usr-spv",
        userName: user?.nama || "Supervisor",
        userRole: user?.role || "supervisor",
        action: "VOID_CASHBACK_PAYOUT",
        module: "Cashback Terpending",
        details: `[VOID] Pembatalan pencairan ${targetType === "KELEBIHAN" ? "kelebihan bayar" : "komisi"} invoice #${id} (${invoiceNum}) sebesar Rp ${nominal.toLocaleString("id-ID")} oleh ${user?.nama}. Alasan: ${reason}`,
        metadata: {
          invoiceId: id,
          payoutId: targetPayout?.id,
          payoutType: targetType,
          nominal,
          reason,
          reversalKasId: reversalKas.id,
        },
        createdAt: nowStr,
      });

      return this.getInvoiceById(id);
    });
  }

  public getAllPengeluaran(): PengeluaranItem[] {
    return dbFinanceRepository.getAllPengeluaran();
  }

  public addPengeluaran(item: Omit<PengeluaranItem, "id">, user?: TokenPayload | null): PengeluaranItem {
    const rawOrderNo = (item as any).orderNo?.trim();
    const rawInvoiceNo = (item as any).invoiceNo?.trim();

    if (rawOrderNo) {
      const orderExists = dbOrderRepository.getByOrderNo(rawOrderNo);
      if (!orderExists) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${rawOrderNo}' tidak ditemukan.`);
      }
    }

    if (rawInvoiceNo) {
      const invExists = dbFinanceRepository.getInvoiceByNo(rawInvoiceNo);
      if (!invExists) {
        throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice '${rawInvoiceNo}' tidak ditemukan.`);
      }
    }

    return runInTransaction(() => {
      const created = dbFinanceRepository.addPengeluaran(item);

      dbAuditRepository.save({
        id: `log-pengeluaran-${Date.now()}`,
        userId: user?.userId || "usr-finance",
        userName: user?.nama || "Finance User",
        userRole: user?.role || "finance",
        action: "ADD_PENGELUARAN",
        module: "Pengeluaran",
        details: `Pengeluaran: ${item.keterangan} Rp ${item.nominal.toLocaleString("id-ID")}${item.penanggungJawab ? ` (PJ: ${item.penanggungJawab})` : ""}`,
        metadata: { item },
        createdAt: new Date().toISOString(),
      });

      return created;
    });
  }

  public deleteKasKantor(id: number, user: TokenPayload): boolean {
    const existing = dbFinanceRepository.getKasKantorById(id);
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", `Entri Kas Kantor #${id} tidak ditemukan.`);
    }

    // Referential integrity check: Cannot delete if linked to invoice_payments
    const payCheck = db.prepare("SELECT COUNT(*) as count FROM invoice_payments WHERE kas_kantor_id = ?").get(id) as any;
    if (payCheck && payCheck.count > 0) {
      throw new ApiError(
        409,
        "CANNOT_DELETE_LINKED_KAS",
        `Entri Kas Kantor #${id} terhubung dengan data verifikasi pembayaran tagihan (invoice_payments) dan tidak dapat dihapus untuk menjaga integritas pelaporan.`
      );
    }

    const ket = existing.keterangan || "";
    if (
      ket.startsWith("Pembayaran: INV-") ||
      ket.startsWith("Pencairan Reimbursement:") ||
      ket.startsWith("Pengembalian kelebihan bayar:") ||
      ket.startsWith("Pencairan komisi rekanan:")
    ) {
      throw new ApiError(
        400,
        "SYSTEM_ENTRY_PROTECTED",
        "Transaksi kas otomatis dari pelunasan tagihan atau pencairan reimbursement/cashback tidak dapat dihapus langsung untuk menjaga konsistensi keuangan. Lakukan pembatalan melalui transaksi sumbernya."
      );
    }

    return runInTransaction(() => {
      const success = dbFinanceRepository.deleteKasKantor(id);
      if (success) {
        dbAuditRepository.save({
          id: `audit-del-kaskantor-${Date.now()}`,
          userId: user.userId,
          userName: user.nama,
          userRole: user.role as any,
          action: "DELETE",
          module: "Kas Kantor",
          details: `Menghapus entri Kas Kantor #${id} (${existing.keterangan} - ${existing.status})`,
          metadata: { id, existing },
          createdAt: new Date().toISOString(),
        });
      }
      return success;
    });
  }

  public deletePengeluaran(id: number, user: TokenPayload): boolean {
    const existing = dbFinanceRepository.getPengeluaranById(id);
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", `Entri Pengeluaran #${id} tidak ditemukan.`);
    }

    // Referential integrity check: Cannot delete if linked to messenger_reimbursements
    const reimbCheck = db.prepare("SELECT COUNT(*) as count FROM messenger_reimbursements WHERE pengeluaran_id = ?").get(id) as any;
    if (reimbCheck && reimbCheck.count > 0) {
      throw new ApiError(
        409,
        "CANNOT_DELETE_LINKED_PENGELUARAN",
        `Entri Pengeluaran #${id} terhubung dengan pengajuan reimbursement kurir dan tidak dapat dihapus untuk menjaga keutuhan audit trail.`
      );
    }

    const ket = existing.keterangan || "";
    if (ket.startsWith("Reimbursement ")) {
      throw new ApiError(
        400,
        "SYSTEM_ENTRY_PROTECTED",
        "Pengeluaran otomatis dari pencairan reimbursement kurir tidak dapat dihapus langsung demi integritas audit trail."
      );
    }

    return runInTransaction(() => {
      const success = dbFinanceRepository.deletePengeluaran(id);
      if (success) {
        dbAuditRepository.save({
          id: `audit-del-pengeluaran-${Date.now()}`,
          userId: user.userId,
          userName: user.nama,
          userRole: user.role as any,
          action: "DELETE",
          module: "Pengeluaran",
          details: `Menghapus entri Pengeluaran #${id} (${existing.keterangan} - Rp ${existing.nominal.toLocaleString("id-ID")})`,
          metadata: { id, existing },
          createdAt: new Date().toISOString(),
        });
      }
      return success;
    });
  }

  // ─── KAS MESSENGER DATABASE SERVICES ───────────────────────────────────────

  public getAllKasMessenger(
    filterMessengerId?: string,
    user?: TokenPayload | null,
    targetDb?: DatabaseSync
  ): {
    data: KasMessengerItem[];
    summary: {
      totalFloatingCash: number;
      byMessenger: Array<{ messengerId: string; nama: string; total: number }>;
    };
  } {
    const activeDb = targetDb ?? db;
    let scopedMessengerId = filterMessengerId?.trim() || undefined;

    // Courier role isolation: if role is messenger, force filter to own messenger_id
    if (user?.role === "messenger") {
      let mRow = activeDb.prepare(`
        SELECT m.id 
        FROM messengers m 
        JOIN users u ON u.employee_id = m.employee_id 
        WHERE u.id = ?
      `).get(user.userId) as { id: string } | undefined;

      if (!mRow && user.employeeId) {
        mRow = activeDb.prepare(`SELECT id FROM messengers WHERE employee_id = ?`).get(user.employeeId) as { id: string } | undefined;
      }

      if (!mRow) {
        throw new ApiError(403, "NOT_A_MESSENGER", "Akun kurir ini belum terpetakan ke data kurir aktif.");
      }

      const ownMessengerId = mRow.id;

      // If courier tries to filter by another courier's ID, reject fail-closed with HTTP 403
      if (filterMessengerId && filterMessengerId.trim() !== ownMessengerId) {
        throw new ApiError(403, "FORBIDDEN_COURIER_ACCESS", "Kurir dilarang mengakses data kas kurir lain.");
      }

      scopedMessengerId = ownMessengerId;
    } else if (scopedMessengerId) {
      // Resolve filterMessengerId to canonical messengers.id if employeeId was provided
      const directM = activeDb.prepare("SELECT id FROM messengers WHERE id = ?").get(scopedMessengerId) as { id: string } | undefined;
      if (!directM) {
        const empM = activeDb.prepare("SELECT id FROM messengers WHERE employee_id = ?").get(scopedMessengerId) as { id: string } | undefined;
        if (empM) {
          scopedMessengerId = empM.id;
        }
      }
    }

    const items = dbFinanceRepository.getAllKasMessenger(scopedMessengerId, activeDb);

    // Compute canonical summary
    const query = `
      SELECT 
        m.id as messengerId, 
        COALESCE(e.nama_lengkap, m.id) as nama,
        COALESCE((
          SELECT km.total 
          FROM kas_messenger km 
          WHERE km.messenger_id = m.id 
          ORDER BY substr(km.tanggal, 1, 10) DESC, km.created_at DESC, km.id DESC 
          LIMIT 1
        ), 0) as total
      FROM messengers m
      LEFT JOIN employees e ON m.employee_id = e.id
      ${scopedMessengerId ? "WHERE m.id = ?" : ""}
      ORDER BY m.id ASC
    `;
    const messengersList = (scopedMessengerId ? activeDb.prepare(query).all(scopedMessengerId) : activeDb.prepare(query).all()) as Array<{ messengerId: string; nama: string; total: number }>;

    const byMessenger = messengersList.map(r => ({
      messengerId: r.messengerId,
      nama: r.nama,
      total: Number(r.total || 0),
    }));

    const totalFloatingCash = byMessenger.reduce((sum, m) => sum + m.total, 0);

    return {
      data: items,
      summary: {
        totalFloatingCash,
        byMessenger,
      },
    };
  }

  public addKasMessenger(
    item: Omit<KasMessengerItem, "id" | "total"> & {
      total?: number;
      orderNo?: string;
      messengerId?: string;
      messenger_id?: string;
      payment_method_id?: string | null;
      payment_method_snapshot?: string | null;
      paymentMethodId?: string | null;
      paymentMethodSnapshot?: string | null;
    },
    user?: TokenPayload | null,
    targetDb?: DatabaseSync
  ): KasMessengerItem {
    const activeDb = targetDb ?? db;

    // 1. Messenger Canonical Identity Resolution
    let messengerId = (item as any).messenger_id || (item as any).messengerId || null;
    let messengerName = item.messenger?.trim() || "";

    if (messengerId) {
      const mRow = activeDb.prepare(`
        SELECT m.id, COALESCE(e.nama_lengkap, m.id) as nama 
        FROM messengers m 
        LEFT JOIN employees e ON m.employee_id = e.id 
        WHERE m.id = ? OR m.employee_id = ?
      `).get(messengerId, messengerId) as { id: string; nama: string } | undefined;
      if (!mRow) {
        throw new ApiError(404, "MESSENGER_NOT_FOUND", `Kurir dengan ID '${messengerId}' tidak ditemukan.`);
      }
      messengerId = mRow.id;
      messengerName = mRow.nama;
    } else if (messengerName) {
      const mRow = activeDb.prepare(`
        SELECT m.id, COALESCE(e.nama_lengkap, m.id) as nama 
        FROM messengers m 
        LEFT JOIN employees e ON m.employee_id = e.id 
        WHERE e.nama_lengkap = ? OR m.id = ? OR m.employee_id = ?
        LIMIT 1
      `).get(messengerName, messengerName, messengerName) as { id: string; nama: string } | undefined;
      if (mRow) {
        messengerId = mRow.id;
        messengerName = mRow.nama;
      } else {
        throw new ApiError(404, "MESSENGER_NOT_FOUND", `Kurir '${messengerName}' tidak ditemukan.`);
      }
    } else {
      throw new ApiError(400, "VALIDATION_ERROR", "Nama atau ID kurir wajib diisi.");
    }

    // Role check: if courier role, ensure they can only add to their own ledger
    if (user?.role === "messenger") {
      let ownMRow = activeDb.prepare(`
        SELECT m.id 
        FROM messengers m 
        JOIN users u ON u.employee_id = m.employee_id 
        WHERE u.id = ?
      `).get(user.userId) as { id: string } | undefined;
      if (!ownMRow && user.employeeId) {
        ownMRow = activeDb.prepare(`SELECT id FROM messengers WHERE employee_id = ?`).get(user.employeeId) as { id: string } | undefined;
      }
      if (!ownMRow || ownMRow.id !== messengerId) {
        throw new ApiError(403, "FORBIDDEN_COURIER_ACCESS", "Kurir dilarang memanipulasi kas kurir lain.");
      }
    }

    if (!item.jenis || !item.jenis.trim()) {
      throw new ApiError(400, "VALIDATION_ERROR", "Jenis kas messenger wajib diisi.");
    }

    // Business date validation
    const normalizedDate = validateAndNormalizeBusinessDate(item.tanggal);

    // Strict Debit/Kredit Mutual Exclusivity Invariant
    const debit = Number(item.in || (item as any).debit || 0);
    const kredit = Number(item.out || (item as any).kredit || 0);

    if (debit < 0 || kredit < 0) {
      throw new ApiError(400, "INVALID_TRANSACTION_AMOUNTS", "Nominal kas masuk (in/debit) dan kas keluar (out/kredit) tidak boleh bernilai negatif.");
    }
    if (debit > 0 && kredit > 0) {
      throw new ApiError(400, "INVALID_TRANSACTION_AMOUNTS", "Nominal debit dan kredit bersifat mutually exclusive. Hanya satu yang boleh bernilai positif.");
    }
    if (debit === 0 && kredit === 0) {
      throw new ApiError(400, "ZERO_TRANSACTION_AMOUNT", "Nominal transaksi tidak boleh nol.");
    }

    const rawOrderNo = item.orderNo?.trim();
    const rawReimbId = (item as any).reimbursementId?.trim();

    if (rawOrderNo) {
      const orderExists = dbOrderRepository.getByOrderNo(rawOrderNo);
      if (!orderExists) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${rawOrderNo}' tidak ditemukan.`);
      }
    }

    if (rawReimbId) {
      const reimbExists = dbMessengerRepository.getReimbursementById(rawReimbId);
      if (!reimbExists) {
        throw new ApiError(404, "REIMBURSEMENT_NOT_FOUND", `Pengajuan reimbursement '${rawReimbId}' tidak ditemukan.`);
      }
    }

    // Payment method handling
    let paymentMethodId: string | null = null;
    let paymentMethodSnapshot: string | null = null;

    if (debit > 0) {
      // Top-up: Payment method is MANDATORY
      const rawPmId = (item as any).payment_method_id || (item as any).paymentMethodId;
      if (!rawPmId) {
        throw new ApiError(400, "INVALID_PAYMENT_METHOD", "Metode pembayaran wajib dipilih untuk top up kas messenger.");
      }
      const pm = activeDb.prepare("SELECT * FROM payment_methods WHERE id = ?").get(rawPmId) as any;
      if (!pm || pm.status?.trim().toLowerCase() !== "aktif") {
        throw new ApiError(400, "INVALID_PAYMENT_METHOD", "Metode pembayaran tidak valid atau tidak aktif.");
      }
      paymentMethodId = pm.id;
      paymentMethodSnapshot = JSON.stringify({
        id: pm.id,
        nama_metode: pm.nama_metode,
        bank: pm.bank,
        nama_rekening: pm.nama_rekening || "",
        nomor_rekening: pm.nomor_rekening || "",
      });
    } else {
      // Payout/Disbursement: payment method MUST be NULL
      paymentMethodId = null;
      paymentMethodSnapshot = null;
    }

    return runInTransaction(() => {
      // Courier Balance Guard: Prevent Negative Courier Balance
      if (kredit > 0) {
        const balRow = activeDb.prepare("SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(kredit), 0) as balance FROM kas_messenger WHERE messenger_id = ?").get(messengerId) as any;
        const currentBalance = balRow?.balance ?? 0;
        if (currentBalance < kredit) {
          throw new ApiError(400, "INSUFFICIENT_MESSENGER_BALANCE", `Saldo Kas Messenger '${messengerName}' (Rp ${currentBalance.toLocaleString("id-ID")}) tidak mencukupi untuk pengeluaran sebesar Rp ${kredit.toLocaleString("id-ID")}.`);
        }
      }

      const created = dbFinanceRepository.addKasMessenger({
        ...item,
        tanggal: normalizedDate,
        messenger: messengerName,
        messenger_id: messengerId,
        messengerId: messengerId,
        in: debit,
        out: kredit,
        payment_method_id: paymentMethodId,
        payment_method_snapshot: paymentMethodSnapshot,
        penanggungJawab: user?.nama || "Admin Finance",
      }, activeDb);

      dbAuditRepository.save({
        id: `audit-kas-msg-${Date.now()}`,
        userId: user?.userId || "usr-finance",
        userName: user?.nama || "Finance User",
        userRole: user?.role || "finance",
        action: "ADD_KAS_MESSENGER",
        module: "Kas Messenger",
        details: `Kas Messenger (${messengerName}): ${item.keterangan} [Masuk: Rp ${debit.toLocaleString("id-ID")}, Keluar: Rp ${kredit.toLocaleString("id-ID")}]`,
        metadata: { created },
        createdAt: new Date().toISOString(),
      });

      return created;
    }, activeDb);
  }

  public deleteKasMessenger(id: number, user: TokenPayload): boolean {
    const existing = dbFinanceRepository.getKasMessengerById(id);
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", `Entri Kas Messenger #${id} tidak ditemukan.`);
    }

    // Referential integrity check: Cannot delete if linked to messenger_reimbursements
    const reimbCheck = db.prepare("SELECT COUNT(*) as count FROM messenger_reimbursements WHERE kas_messenger_id = ?").get(id) as any;
    if (reimbCheck && reimbCheck.count > 0) {
      throw new ApiError(
        409,
        "CANNOT_DELETE_LINKED_KAS_MESSENGER",
        `Entri Kas Messenger #${id} terhubung dengan pencairan reimbursement kurir dan tidak dapat dihapus.`
      );
    }
    if ((existing as any).reimbursementId) {
      throw new ApiError(
        409,
        "CANNOT_DELETE_LINKED_KAS_MESSENGER",
        `Entri Kas Messenger #${id} dicatat dari reimbursement '${(existing as any).reimbursementId}' dan dilindungi dari penghapusan langsung.`
      );
    }

    const success = dbFinanceRepository.deleteKasMessenger(id);
    if (success) {
      dbAuditRepository.save({
        id: `audit-del-kas-msg-${Date.now()}`,
        userId: user.userId,
        userName: user.nama,
        userRole: user.role as any,
        action: "DELETE",
        module: "Kas Messenger",
        details: `Menghapus entri Kas Messenger #${id}`,
        metadata: { id },
        createdAt: new Date().toISOString(),
      });
    }
    return success;
  }

  public transferMessengerToOffice(
    _input?: any,
    _user?: TokenPayload | null
  ): never {
    throw new ApiError(410, "TRANSFERS_DISABLED", "Transfer langsung antar kas tidak lagi didukung. Gunakan alur reimbursement atau setoran kas.");
  }

  public transferOfficeToMessenger(
    _input?: any,
    _user?: TokenPayload | null
  ): never {
    throw new ApiError(410, "TRANSFERS_DISABLED", "Transfer langsung antar kas tidak lagi didukung. Gunakan alur reimbursement atau setoran kas.");
  }

  public getVoidAuditHistory(): { payments: any[]; cashbacks: any[] } {
    const payments = db.prepare(`
      SELECT 
        p.id as payment_id,
        COALESCE(p.invoice_no, '') as invoice_no,
        COALESCE(p.order_no, '') as order_no,
        COALESCE(i.customer, '') as customer,
        p.nominal,
        COALESCE(p.metode_pembayaran, '') as metode_pembayaran,
        p.is_void,
        COALESCE(p.void_reason, '') as void_reason,
        COALESCE(p.voided_by, '') as voided_by,
        COALESCE(p.voided_at, '') as voided_at,
        p.reversal_kas_id,
        'VOID_PAYMENT' as void_type
      FROM invoice_payments p
      LEFT JOIN finance_invoices i ON p.invoice_no = i.invoice_no
      WHERE p.is_void = 1
      ORDER BY p.voided_at DESC
    `).all() as any[];

    const cashbacksRaw = db.prepare(`
      SELECT 
        id,
        user_id,
        COALESCE(user_name, '') as voided_by,
        user_role,
        action as void_type,
        COALESCE(metadata_json, '') as metadata_json,
        COALESCE(details, '') as void_reason,
        created_at as voided_at
      FROM audit_logs
      WHERE action = 'VOID_CASHBACK_PAYOUT'
      ORDER BY created_at DESC
    `).all() as any[];

    const cashbacks = cashbacksRaw.map((c) => {
      let invoiceNo = "-";
      let nominal = 0;
      try {
        if (c.metadata_json) {
          const m = JSON.parse(c.metadata_json);
          invoiceNo = m.invoiceNum || m.invoiceNo || m.orderNo || `INV-${m.invoiceId || ""}`;
          nominal = Number(m.nominal || 0);
        }
      } catch {
        // fallback
      }
      return {
        ...c,
        invoice_no: invoiceNo,
        nominal,
      };
    });

    return { payments, cashbacks };
  }
}

export const financeService = new FinanceService();
