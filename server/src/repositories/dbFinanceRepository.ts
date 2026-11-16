/**
 * SQLite Finance Repository
 * Admin SUN89 — Biro Jasa Management System
 */

import { db, getDb, runInTransaction } from "../database/db";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "../middleware/errorHandler";
import { isValidCanonicalPaymentId, formatScopedIdempotencyKey } from "../utils/canonicalHasher";
import { InvoiceBillingRecord, KasKantorItem, PengeluaranItem, KasMessengerItem, CostClassificationType } from "../../../src/domain/finance/types";
import { computeCanonicalLabaRugi, CanonicalLabaRugiSummary } from "../../../src/domain/finance/labaRugiCanonical";
import { calculateCanonicalInvoiceTotals } from "../services/canonicalInvoiceCalculator";
import { recalculateKasKantorRunningBalances, recalculateKasMessengerRunningBalances } from "../services/cashLedgerCalculationService";
import { resolveCanonicalSamsatCogs } from "../../../src/domain/finance/samsatCogs";
import {
  CanonicalPaymentMethodRecord,
  ProfitPaymentBreakdownEntry,
  buildPaymentMethodLabelMap,
  resolveCanonicalPaymentMethod,
  isCashPaymentMethodRow,
  isCashPaymentString,
  isPaymentSchemeString,
  formatUnlinkedPaymentMethodLabel,
  matchesWibDateRange,
  normalizeProfitCategoryKey,
} from "../../../src/domain/finance/paymentMethodCanonical";

export interface ProfitListFilters {
  paymentMethodId?: string;
  startDate?: string;
  endDate?: string;
  category?: string;
}

const _cashbackColsEnsured = new WeakSet<DatabaseSync>();

function ensureCashbackCompletionColumns(): void {
  const activeDb = getDb();
  if (_cashbackColsEnsured.has(activeDb)) {
    return;
  }
  const cols = activeDb.prepare("PRAGMA table_info(finance_invoices)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("cashback_completion_status")) {
    activeDb.exec("ALTER TABLE finance_invoices ADD COLUMN cashback_completion_status TEXT DEFAULT 'PENDING';");
  }
  if (!names.has("cashback_completed_at")) {
    activeDb.exec("ALTER TABLE finance_invoices ADD COLUMN cashback_completed_at TEXT;");
  }
  if (!names.has("cashback_completed_by")) {
    activeDb.exec("ALTER TABLE finance_invoices ADD COLUMN cashback_completed_by TEXT;");
  }
  _cashbackColsEnsured.add(activeDb);
}

export class DbFinanceRepository {
  private mapRowToInvoice(r: any): InvoiceBillingRecord {
    let parsed: any = {};
    try {
      parsed = JSON.parse(r.data_json || "{}");
    } catch {}

    const totalTagihan = Number(r.total_tagihan ?? parsed.totalTagihan ?? 0);
    const dibayar = Number(r.dibayar ?? parsed.dibayar ?? parsed.terbayar ?? 0);
    const sisa = Number(r.sisa ?? Math.max(0, totalTagihan - dibayar));
    const biayaSamsat = Number((r.biaya_samsat !== null && r.biaya_samsat !== undefined && Number(r.biaya_samsat) !== 0) ? r.biaya_samsat : (parsed.biayaSamsat || parsed.biaya_samsat || r.biaya_samsat || 0));
    const pendapatanJasa = Number(r.pendapatan_jasa ?? Math.max(0, totalTagihan - biayaSamsat));
    const overpayment = Number(r.overpayment ?? parsed.overpayment ?? 0);
    const cashback = Number(r.cashback_nominal ?? parsed.cashback ?? 0);
    const profit = Number(r.profit_final ?? parsed.profit ?? 0);
    const serviceId = r.service_id !== null && r.service_id !== undefined ? String(r.service_id) : (parsed.serviceId || parsed.service_id || undefined);
    const costVerificationStatus = r.cost_verification_status !== null && r.cost_verification_status !== undefined
      ? String(r.cost_verification_status)
      : String(parsed.costVerificationStatus || (parsed.cost_verification_status) || "VERIFIED");
    const isDraftEstimate = r.is_draft_estimate !== null && r.is_draft_estimate !== undefined
      ? Boolean(r.is_draft_estimate)
      : Boolean(parsed.isDraftEstimate ?? (parsed.is_draft_estimate) ?? false);
    const isExplicitZero = r.is_explicit_zero !== null && r.is_explicit_zero !== undefined ? Boolean(r.is_explicit_zero) : Boolean(parsed.isExplicitZero || parsed.is_explicit_zero || parsed.isZeroCostPromotion);
    const tanggal = parsed.tanggal || (r.created_at ? String(r.created_at).split("T")[0].split(" ")[0] : new Date().toISOString().split("T")[0]);
    const costClassification: CostClassificationType = parsed.costClassification || (
      costVerificationStatus === "VERIFIED"
        ? (biayaSamsat === 0 && isExplicitZero ? "EXPLICIT_ZERO" : "ACTUAL_COST")
        : (biayaSamsat === 0 && !isExplicitZero
            ? "UNCONFIGURED"
            : (biayaSamsat === 0 && isExplicitZero ? "EXPLICIT_ZERO" : "ESTIMATED_COST"))
    );

    return {
      ...parsed,
      id: r.id,
      tanggal,
      invoice: r.invoice_no,
      invoiceNo: r.invoice_no,
      orderNo: r.order_no,
      customer: r.customer,
      layanan: r.layanan,
      serviceId,
      service_id: serviceId,
      status: r.status as any,
      totalTagihan,
      total_tagihan: totalTagihan,
      dibayar,
      terbayar: dibayar,
      sisa,
      biayaSamsat,
      biaya_samsat: biayaSamsat,
      pendapatanJasa,
      pendapatan_jasa: pendapatanJasa,
      overpayment,
      settlementCondition: r.settlement_condition ?? parsed.settlementCondition ?? (dibayar >= totalTagihan ? "BALANCED" : "UNDERPAID"),
      refundStatus: r.refund_status ?? parsed.refundStatus ?? "NONE",
      cashback,
      cashbackStatus: r.cashback_status ?? parsed.cashbackStatus ?? "PENDING",
      profit,
      profitStatus: r.profit_status ?? parsed.profitStatus ?? "PENDING",
      alasan_pending: r.alasan_pending ?? parsed.alasan_pending ?? parsed.alasan ?? null,
      alasan: r.alasan_pending ?? parsed.alasan_pending ?? parsed.alasan ?? null,
      costVerificationStatus,
      cost_verification_status: costVerificationStatus,
      isDraftEstimate,
      is_draft_estimate: isDraftEstimate ? 1 : 0,
      costClassification,
      isExplicitZero,
      payoutHistory: parsed.payoutHistory || [],
      refundLiability: parsed.refundLiability !== undefined ? Number(parsed.refundLiability) : overpayment,
      refundedAmount: parsed.refundedAmount !== undefined ? Number(parsed.refundedAmount) : (r.refund_status === "PROCESSED" ? overpayment : 0),
      remainingRefund: parsed.remainingRefund !== undefined ? Number(parsed.remainingRefund) : (r.refund_status === "PROCESSED" ? 0 : overpayment),
      cashbackPaidAmount: parsed.cashbackPaidAmount !== undefined ? Number(parsed.cashbackPaidAmount) : 0,
      cashbackPaidAt: parsed.cashbackPaidAt ?? undefined,
      cashbackPaidBy: parsed.cashbackPaidBy ?? undefined,
      cashbackCompletionStatus: r.cashback_completion_status ?? parsed.cashbackCompletionStatus ?? "PENDING",
      cashbackCompletedAt: r.cashback_completed_at ?? parsed.cashbackCompletedAt ?? undefined,
      cashbackCompletedBy: r.cashback_completed_by ?? parsed.cashbackCompletedBy ?? undefined,
      cashbackCompletionNotes: parsed.cashbackCompletionNotes ?? undefined,
      completedAt: parsed.completedAt ?? undefined,
      completedBy: parsed.completedBy ?? undefined,
    };
  }

  /**
   * Enriches an invoice record with canonical financial calculations (GAP-FIN-05).
   * Ensures getInvoiceById, getInvoiceByOrderNo, and getInvoiceByNo produce
   * 100% consistent totals, balances, and statuses with getAllInvoices.
   */
  private applyCanonicalCalculation(
    inv: InvoiceBillingRecord,
    payments: any[],
    isExplicitZeroOverride?: boolean
  ): InvoiceBillingRecord {
    const normalizedStatus = String(inv.status || "").trim().toUpperCase();
    const normalizedBillingStatus = String((inv as any).billingStatus || "").trim().toUpperCase();

    if (normalizedStatus === "CANCELLED" || normalizedBillingStatus === "CANCELLED") {
      inv.status = "CANCELLED" as any;
      (inv as any).billingStatus = "CANCELLED";
      if (!Array.isArray(inv.riwayatPembayaran)) {
        inv.riwayatPembayaran = payments.filter((p) => !p.is_void);
      }
      return inv;
    }

    const orderNo = (inv.orderNo || "").trim();
    const invoiceNo = (inv.invoiceNo || inv.invoice || "").trim();
    const calc = calculateCanonicalInvoiceTotals({
      invoiceNo,
      orderNo,
      totalTagihan: inv.totalTagihan,
      biayaSamsat: inv.biayaSamsat,
      isExplicitZero: isExplicitZeroOverride !== undefined ? isExplicitZeroOverride : Boolean(inv.isExplicitZero),
      basePaid: Number(inv.dibayar ?? inv.terbayar ?? 0),
      payments,
    });

    inv.dibayar = calc.verifiedPaid;
    inv.terbayar = calc.verifiedPaid;
    inv.sisa = calc.sisaTagihan;
    (inv as any).overpayment = calc.overpayment;
    inv.status = calc.status as any;
    (inv as any).settlementCondition = calc.settlementCondition;
    inv.profit = calc.grossProfit;
    inv.profitStatus = calc.profitStatus as any;
    inv.riwayatPembayaran = calc.allActivePayments;

    const lastVerified =
      calc.eligibleVerifiedPayments[calc.eligibleVerifiedPayments.length - 1] ||
      calc.allActivePayments[calc.allActivePayments.length - 1];
    if (lastVerified) {
      inv.bank = lastVerified.nama_bank || inv.bank;
      inv.metodePembayaran = lastVerified.metode_pembayaran || inv.metodePembayaran;
      (inv as any).tanggalBayar = lastVerified.tanggal_bayar;
      (inv as any).nomorRekening = lastVerified.nomor_rekening;
    }

    return inv;
  }

  private enrichInvoiceWithCanonicalCalculation(inv: InvoiceBillingRecord): InvoiceBillingRecord {
    try {
      const orderNo = (inv.orderNo || "").trim();
      const payments = this.getPaymentsByOrderNo(orderNo);
      return this.applyCanonicalCalculation(inv, payments);
    } catch {
      // Non-fatal if table not initialized
    }
    return inv;
  }

  public getAllInvoices(): InvoiceBillingRecord[] {
    const stmt = db.prepare("SELECT * FROM finance_invoices ORDER BY id DESC");
    const rows = stmt.all() as any[];

    // Index all active non-void payments by order_no to guarantee strict order isolation (GAP-FIN-01)
    const paymentsByOrder = new Map<string, any[]>();
    try {
      const paymentsStmt = db.prepare("SELECT * FROM invoice_payments WHERE is_void = 0 ORDER BY id ASC");
      const allPayments = paymentsStmt.all() as any[];
      for (const p of allPayments) {
        const ordKey = (p.order_no || "").trim().toUpperCase();
        if (ordKey) {
          if (!paymentsByOrder.has(ordKey)) paymentsByOrder.set(ordKey, []);
          paymentsByOrder.get(ordKey)!.push(p);
        }
      }
    } catch {
      // Non-fatal if table not yet initialized in tests
    }

    return rows.map((r) => {
      const inv = this.mapRowToInvoice(r);
      const ordKey = (r.order_no || "").trim().toUpperCase();
      const rawPayments = paymentsByOrder.get(ordKey) || [];
      return this.applyCanonicalCalculation(
        inv,
        rawPayments,
        Boolean(r.is_explicit_zero || (inv as any).isExplicitZero)
      );
    });
  }

  public isQuarantinedInvoice(inv: any): boolean {
    const invoiceNo = String(inv.invoiceNo || inv.invoice || "").trim().toUpperCase();
    const orderNo = String(inv.orderNo || "").trim().toUpperCase();
    const totalTagihan = Number(inv.totalTagihan ?? inv.total_tagihan ?? 0);
    return invoiceNo === "INV-1026-080" || orderNo === "ORD-1026-080" || totalTagihan >= 5000000000;
  }

  public getProfitList(filters?: ProfitListFilters): any[] {
    const invoices = this.getAllInvoices();

    const cancelledOrderNos = new Set<string>();
    try {
      const orderRows = db
        .prepare("SELECT order_no, current_stage_name, payment_status, data_json FROM orders")
        .all() as any[];
      for (const r of orderRows) {
        const key = String(r.order_no || "").trim().toUpperCase();
        if (!key) continue;
        let parsedOrder: any = {};
        try {
          parsedOrder = r.data_json ? JSON.parse(r.data_json) : {};
        } catch {}
        const isOrdCancelled =
          r.current_stage_name === "Dibatalkan" ||
          r.payment_status === "Dibatalkan" ||
          Boolean(parsedOrder.isCancelled) ||
          String(parsedOrder.status || "").trim().toUpperCase() === "CANCELLED";
        if (isOrdCancelled) cancelledOrderNos.add(key);
      }
    } catch (err: any) {
      throw new ApiError(
        500,
        "PROFIT_QUERY_FAILED",
        `Gagal membaca status order untuk kalkulasi profit: ${err?.message || String(err)}`
      );
    }

    let paymentMethods: CanonicalPaymentMethodRecord[] = [];
    try {
      paymentMethods = db
        .prepare(
          "SELECT id, nama_metode, bank, nama_rekening, nomor_rekening, status FROM payment_methods ORDER BY created_at ASC, id ASC"
        )
        .all() as CanonicalPaymentMethodRecord[];
    } catch (err: any) {
      throw new ApiError(
        500,
        "PROFIT_QUERY_FAILED",
        `Gagal membaca master metode pembayaran untuk profit: ${err?.message || String(err)}`
      );
    }
    const labelMap = buildPaymentMethodLabelMap(paymentMethods);

    const verifiedPaysByOrder = new Map<string, any[]>();
    const verifiedPaysByInvoice = new Map<string, any[]>();
    const activePaymentOrders = new Set<string>();
    const activePaymentInvoices = new Set<string>();
    try {
      const pays = db
        .prepare(
          `SELECT id, payment_id, invoice_no, order_no, nominal, metode_pembayaran, nama_bank, nomor_rekening,
                  tanggal_bayar, metode_pembayaran_id, payment_method_snapshot, status_verifikasi, is_void, created_at
           FROM invoice_payments
           WHERE is_void = 0
           ORDER BY id ASC`
        )
        .all() as any[];
      for (const p of pays) {
        const oKey = String(p.order_no || "").trim().toUpperCase();
        const iKey = String(p.invoice_no || "").trim().toUpperCase();
        if (oKey) activePaymentOrders.add(oKey);
        if (iKey) activePaymentInvoices.add(iKey);

        if (String(p.status_verifikasi || "").trim().toUpperCase() === "TERVERIFIKASI") {
          if (oKey) {
            const arr = verifiedPaysByOrder.get(oKey) || [];
            arr.push(p);
            verifiedPaysByOrder.set(oKey, arr);
          }
          if (iKey) {
            const arr = verifiedPaysByInvoice.get(iKey) || [];
            arr.push(p);
            verifiedPaysByInvoice.set(iKey, arr);
          }
        }
      }
    } catch (err: any) {
      throw new ApiError(
        500,
        "PROFIT_QUERY_FAILED",
        `Gagal membaca data pembayaran untuk kalkulasi profit: ${err?.message || String(err)}`
      );
    }

    const filterMethodId =
      filters?.paymentMethodId && filters.paymentMethodId !== "ALL"
        ? filters.paymentMethodId.trim()
        : undefined;
    const filterStartDate = filters?.startDate?.trim() || undefined;
    const filterEndDate = filters?.endDate?.trim() || undefined;
    const filterCategory =
      filters?.category && filters.category !== "ALL" ? filters.category.trim() : undefined;

    return invoices
      .filter((inv) => {
        if (this.isQuarantinedInvoice(inv)) return false;
        const invStatus = String(inv.status || "").trim().toUpperCase();
        const invBilling = String((inv as any).billingStatus || "").trim().toUpperCase();
        if (invStatus === "CANCELLED" || invBilling === "CANCELLED" || Boolean((inv as any).isCancelled)) {
          return false;
        }
        const ordKey = String(inv.orderNo || "").trim().toUpperCase();
        if (ordKey && cancelledOrderNos.has(ordKey)) {
          return false;
        }
        return true;
      })
      .map((inv, idx) => {
        const total = Number(inv.totalTagihan ?? (inv as any).total_tagihan ?? 0);
        const paid = Number(inv.dibayar ?? (inv as any).terbayar ?? 0);
        const eligiblePayment = Math.min(paid, total);
        const overpayment = Math.max(0, paid - total);
        const rawBiayaSamsat = Number(inv.biayaSamsat ?? (inv as any).biaya_samsat ?? 0);

        const isExplicitZero = Boolean(
          inv.isExplicitZero ||
          (inv as any).is_explicit_zero ||
          (inv as any).isZeroCostPromotion ||
          (rawBiayaSamsat === 0 && (inv.costClassification === "EXPLICIT_ZERO" || inv.costClassification === "DEFINITIVE"))
        );

        const costVerificationStatus = String(
          inv.costVerificationStatus ||
          (inv as any).cost_verification_status ||
          (inv.isDraftEstimate || (inv as any).isCostVerified === false ? "PENDING_VERIFICATION" : "VERIFIED")
        );

        let costClassification = inv.costClassification;
        if (!costClassification) {
          if (isExplicitZero) {
            costClassification = "DEFINITIVE";
          } else if (rawBiayaSamsat === 0) {
            costClassification = "UNCONFIGURED";
          } else if (costVerificationStatus === "VERIFIED" || costVerificationStatus === "DEFINITIVE") {
            costClassification = "DEFINITIVE";
          } else {
            costClassification = "ESTIMATED";
          }
        } else if (costClassification === "ACTUAL_COST" || costClassification === "EXPLICIT_ZERO") {
          costClassification = "DEFINITIVE";
        } else if (costClassification === "ESTIMATED_COST") {
          costClassification = "ESTIMATED";
        }

        const isAnomaly = total > 0 && rawBiayaSamsat > total;
        const isCostPending = !isAnomaly && (costClassification === "UNCONFIGURED" || costClassification === "ESTIMATED");

        let matchedCOGS = 0;
        let profit = 0;
        let holdStatus = "NONE";
        let anomalyReason = "";

        if (isAnomaly) {
          holdStatus = "HOLD_ANOMALY";
          anomalyReason = "BIAYA_SAMSAT_MELEBIHI_TAGIHAN";
          profit = 0;
          matchedCOGS = 0;
        } else if (isCostPending) {
          holdStatus = "HOLD_COST_PENDING";
          profit = 0;
          matchedCOGS = 0;
        } else if (isExplicitZero) {
          profit = eligiblePayment;
          matchedCOGS = 0;
        } else if (total > 0 && rawBiayaSamsat <= total) {
          // Phase C Canonical Proportional Matching Formula
          const alpha = rawBiayaSamsat / total;
          matchedCOGS = Math.min(rawBiayaSamsat, Math.round(alpha * eligiblePayment));
          profit = Math.max(0, eligiblePayment - matchedCOGS);
        }

        const ordKey = String(inv.orderNo || "").trim().toUpperCase();
        const invKey = String(inv.invoice || (inv as any).invoiceNo || "").trim().toUpperCase();

        // Combine verified payments matched by orderNo or invoiceNo cleanly (dedup by DB payment row id)
        const combinedVerifiedPays: any[] = [];
        const seenPayRowIds = new Set<string>();
        for (const candidate of [
          ...(ordKey ? verifiedPaysByOrder.get(ordKey) || [] : []),
          ...(invKey ? verifiedPaysByInvoice.get(invKey) || [] : []),
        ]) {
          const rowKey = String(candidate.id ?? candidate.payment_id ?? `${candidate.nominal}:${candidate.tanggal_bayar}`);
          if (!seenPayRowIds.has(rowKey)) {
            seenPayRowIds.add(rowKey);
            combinedVerifiedPays.push(candidate);
          }
        }

        const hasAnyPaymentRow =
          (ordKey && activePaymentOrders.has(ordKey)) || (invKey && activePaymentInvoices.has(invKey));

        const breakdownMap = new Map<string, ProfitPaymentBreakdownEntry>();
        const addBreakdownSample = (opts: {
          id?: string | null;
          snapshot?: unknown;
          metode?: string | null;
          namaBank?: string | null;
          nomorRekening?: string | null;
          namaPemilikRekening?: string | null;
          nominal: number;
          tanggalBayar?: string;
        }) => {
          const pm = resolveCanonicalPaymentMethod(opts, paymentMethods);
          const bankCandidate = String(
            pm?.bank || (!isPaymentSchemeString(opts.namaBank) ? opts.namaBank : "") || ""
          ).trim();
          const metodeCandidate = !isPaymentSchemeString(opts.metode) ? String(opts.metode || "").trim() : "";
          const isCash = pm ? isCashPaymentMethodRow(pm) : isCashPaymentString(bankCandidate || metodeCandidate);

          const label = pm
            ? labelMap.get(pm.id)?.displayLabel || pm.nama_metode
            : formatUnlinkedPaymentMethodLabel({ metode: metodeCandidate, namaBank: bankCandidate });
          const bucketKey = pm ? pm.id : `UNLINKED:${label.toLowerCase()}`;
          const existing = breakdownMap.get(bucketKey);

          const namaBankResolved = isCash ? "" : bankCandidate;
          const acctResolved = isCash ? "" : String(pm?.nomor_rekening || opts.nomorRekening || "").trim();
          const ownerResolved = isCash ? "" : String(pm?.nama_rekening || opts.namaPemilikRekening || "").trim();
          const pencairanResolved = isCash
            ? "Cash"
            : namaBankResolved || metodeCandidate
              ? "Transfer Bank"
              : "-";

          if (existing) {
            existing.nominal += Number(opts.nominal || 0);
            existing.count += 1;
            if (opts.tanggalBayar) existing.tanggalBayar = opts.tanggalBayar;
          } else {
            breakdownMap.set(bucketKey, {
              paymentMethodId: pm ? pm.id : null,
              paymentMethodLabel: label,
              paymentMethodStatus: pm ? pm.status : null,
              metodePencairan: pencairanResolved,
              namaBank: namaBankResolved,
              nomorRekening: acctResolved,
              namaPemilikRekening: ownerResolved,
              nominal: Number(opts.nominal || 0),
              count: 1,
              tanggalBayar: opts.tanggalBayar,
            });
          }
        };

        if (combinedVerifiedPays.length > 0) {
          for (const p of combinedVerifiedPays) {
            addBreakdownSample({
              id: p.metode_pembayaran_id,
              snapshot: p.payment_method_snapshot,
              metode: p.metode_pembayaran,
              namaBank: p.nama_bank,
              nomorRekening: p.nomor_rekening,
              nominal: Number(p.nominal || 0),
              tanggalBayar: p.tanggal_bayar || undefined,
            });
          }
        } else if (paid > 0 && !hasAnyPaymentRow) {
          // Legacy fallback ONLY when paid > 0 in fixtures without invoice_payments rows
          addBreakdownSample({
            id: (inv as any).paymentMethodId || (inv as any).metodePembayaranId || null,
            snapshot: (inv as any).paymentMethodSnapshot || (inv as any).payment_method_snapshot || null,
            metode: inv.metodePembayaran,
            namaBank: inv.bank || (inv as any).namaBank,
            nomorRekening: (inv as any).nomorRekening || (inv as any).noRekening,
            namaPemilikRekening: (inv as any).namaPemilikRekening || (inv as any).namaRekening,
            nominal: paid,
            tanggalBayar: (inv as any).tanggalBayar || inv.tanggal,
          });
        }

        const paymentBreakdown = Array.from(breakdownMap.values());
        const verifiedPaymentCount =
          combinedVerifiedPays.length > 0 ? combinedVerifiedPays.length : paid > 0 && !hasAnyPaymentRow ? 1 : 0;

        const primaryEntry =
          paymentBreakdown.length > 0 ? paymentBreakdown[paymentBreakdown.length - 1] : null;
        const paymentMethodIds = Array.from(
          new Set(paymentBreakdown.map((b) => b.paymentMethodId).filter((id): id is string => Boolean(id)))
        );

        const baseTanggal =
          inv.tanggal ||
          ((inv as any).created_at
            ? String((inv as any).created_at).split("T")[0].split(" ")[0]
            : new Date().toISOString().split("T")[0]);
        const latestVerifiedTanggal =
          (combinedVerifiedPays.length > 0
            ? combinedVerifiedPays[combinedVerifiedPays.length - 1]?.tanggal_bayar
            : undefined) ||
          (inv as any).tanggalBayar ||
          (inv as any).tanggalUangMasuk ||
          baseTanggal;
        const tanggalUangMasuk = paid > 0 ? latestVerifiedTanggal : "";
        const categoryKey = normalizeProfitCategoryKey(inv.jenisLayanan || (inv as any).layanan);

        let scopedPaid = paid;
        let scopedEligible = eligiblePayment;
        let scopedOverpayment = overpayment;
        let scopedCogs = matchedCOGS;
        let scopedProfit = profit;
        let scopedBreakdown = paymentBreakdown;
        let scopedPrimary = primaryEntry;
        let scopedMethodIds = paymentMethodIds;

        if (filterStartDate || filterEndDate) {
          if (!matchesWibDateRange(tanggalUangMasuk || baseTanggal, filterStartDate, filterEndDate)) {
            return null;
          }
        }

        if (filterCategory) {
          const serviceName = String(inv.jenisLayanan || (inv as any).layanan || "");
          if (categoryKey !== filterCategory && serviceName !== filterCategory) {
            return null;
          }
        }

        if (filterMethodId) {
          if (verifiedPaymentCount === 0 || paid <= 0) {
            return null;
          }
          const matchedEntries = paymentBreakdown.filter((b) => b.paymentMethodId === filterMethodId);
          if (matchedEntries.length === 0) {
            return null;
          }
          const totalBreakdownNominal = paymentBreakdown.reduce((s, b) => s + Number(b.nominal || 0), 0);
          const matchedNominal = matchedEntries.reduce((s, b) => s + Number(b.nominal || 0), 0);
          if (paymentBreakdown.length > 1 && totalBreakdownNominal > 0 && matchedNominal < totalBreakdownNominal) {
            const ratio = matchedNominal / totalBreakdownNominal;
            scopedPaid = Math.round(paid * ratio);
            scopedEligible = Math.round(eligiblePayment * ratio);
            scopedCogs = Math.round(matchedCOGS * ratio);
            scopedProfit = Math.round(profit * ratio);
            scopedOverpayment = Math.max(0, scopedPaid - scopedEligible);
          }
          scopedBreakdown = matchedEntries;
          scopedPrimary = matchedEntries[matchedEntries.length - 1];
          scopedMethodIds = [filterMethodId];
        }

        return {
          id: idx + 1,
          orderNo: inv.orderNo,
          tanggal: baseTanggal,
          tanggalUangMasuk,
          customer: inv.customer,
          nopol: inv.nopol,
          pengurusan: inv.jenisLayanan || (inv as any).layanan,
          categoryKey,
          uangMasuk: scopedPaid,
          totalTagihan: total,
          eligiblePayment: scopedEligible,
          overpayment: scopedOverpayment,
          biayaSamsat: rawBiayaSamsat,
          matchedCOGS: scopedCogs,
          profit: scopedProfit,
          grossProfit: scopedProfit,
          pendapatanJasa: scopedProfit,
          labaKotor: scopedProfit,
          namaBerkas: (inv as any).namaBerkas || inv.customer,
          paymentMethodId: scopedPrimary ? scopedPrimary.paymentMethodId : null,
          paymentMethodIds: scopedMethodIds,
          paymentMethodLabel: scopedPrimary ? scopedPrimary.paymentMethodLabel : null,
          paymentMethodStatus: scopedPrimary ? scopedPrimary.paymentMethodStatus : null,
          verifiedPaymentCount,
          paymentBreakdown: scopedBreakdown,
          rekening: scopedPrimary ? scopedPrimary.paymentMethodLabel : "Belum Dibayar",
          metodePencairan: scopedPrimary ? scopedPrimary.metodePencairan : "-",
          metodePembayaran: scopedPrimary ? scopedPrimary.paymentMethodLabel : "-",
          namaBank: scopedPrimary ? scopedPrimary.namaBank : "",
          nomorRekening: scopedPrimary ? scopedPrimary.nomorRekening : "",
          namaPemilikRekening: scopedPrimary ? scopedPrimary.namaPemilikRekening : "",
          tanggalTTB: inv.tanggal,
          ttb: (inv as any).ttb || "-",
          status: inv.status,
          invoice: inv.invoice || (inv as any).invoiceNo || "-",
          isExplicitZero,
          costClassification,
          isFinancialAnomaly: isAnomaly,
          anomalyReason,
          holdStatus,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }

  public getCanonicalLabaRugiSummary(
    periodFilter: string = "monthly",
    customStartDate?: string,
    customEndDate?: string
  ): CanonicalLabaRugiSummary {
    const invoices = this.getAllInvoices();
    const kasKantor = this.getAllKasKantor();
    const kasMessenger = this.getAllKasMessenger();
    const pengeluaran = this.getAllPengeluaran();

    return computeCanonicalLabaRugi(
      invoices,
      pengeluaran,
      kasMessenger,
      periodFilter,
      undefined,
      customStartDate,
      customEndDate,
      kasKantor
    );
  }

  public getInvoiceById(id: number): InvoiceBillingRecord | undefined {
    const stmt = db.prepare("SELECT * FROM finance_invoices WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.enrichInvoiceWithCanonicalCalculation(this.mapRowToInvoice(row));
  }

  public getInvoiceByOrderNo(orderNo: string): InvoiceBillingRecord | undefined {
    const cleanNo = (orderNo || "").trim().toUpperCase();
    const stmt = db.prepare("SELECT * FROM finance_invoices WHERE UPPER(order_no) = ? OR order_no = ?");
    const row = stmt.get(cleanNo, orderNo) as any;
    if (!row) return undefined;
    return this.enrichInvoiceWithCanonicalCalculation(this.mapRowToInvoice(row));
  }

  public getInvoiceByNo(invoiceNo: string): InvoiceBillingRecord | undefined {
    const stmt = db.prepare("SELECT * FROM finance_invoices WHERE invoice_no = ?");
    const row = stmt.get(invoiceNo) as any;
    if (!row) return undefined;
    return this.enrichInvoiceWithCanonicalCalculation(this.mapRowToInvoice(row));
  }

  public saveInvoice(invoice: Partial<InvoiceBillingRecord> & { invoiceNo: string; orderNo: string }): number {
    if (!invoice.orderNo || !invoice.orderNo.trim()) {
      throw new ApiError(400, "INVALID_ORDER_RELATION", "Order number is mandatory for invoice persistence.");
    }

    const existingByNo = this.getInvoiceByNo(invoice.invoiceNo);
    const existingByOrder = this.getInvoiceByOrderNo(invoice.orderNo);

    // [GAP-FIN-02 & DEF-FIN-001 REMEDIATION]: Anti-hijacking & Bi-directional Relational Validation
    // 1. If an invoice with this invoiceNo already exists, it MUST belong to the same order.
    if (existingByNo && existingByNo.orderNo && existingByNo.orderNo.trim().toUpperCase() !== invoice.orderNo.trim().toUpperCase()) {
      throw new ApiError(
        409,
        "FINANCE_INVOICE_COLLISION",
        `[FINANCE_INVOICE_COLLISION] Nomor invoice '${invoice.invoiceNo}' sudah terdaftar untuk pesanan '${existingByNo.orderNo}'. Tidak dapat digunakan untuk pesanan '${invoice.orderNo}'.`
      );
    }

    // 2. If an order already has an active invoice, prevent silent renumbering to a different invoiceNo.
    const activeInvNo = existingByOrder ? (existingByOrder.invoiceNo || existingByOrder.invoice) : undefined;
    if (existingByOrder && activeInvNo && activeInvNo.trim().toUpperCase() !== invoice.invoiceNo.trim().toUpperCase()) {
      throw new ApiError(
        409,
        "RELATIONAL_INTEGRITY_VIOLATION",
        `[RELATIONAL_INTEGRITY_VIOLATION] Pesanan '${invoice.orderNo}' sudah memiliki invoice terdaftar '${activeInvNo}'. Perubahan nomor invoice ke '${invoice.invoiceNo}' tidak diizinkan tanpa prosedur migrasi formal.`
      );
    }

    const existing = existingByOrder || existingByNo;
    const isExistingCancelled =
      String((existing as any)?.status || "").trim().toUpperCase() === "CANCELLED" ||
      String((existing as any)?.billingStatus || "").trim().toUpperCase() === "CANCELLED";

    const biayaSamsat = isExistingCancelled
      ? Number((existing as any)?.biayaSamsat ?? invoice.biayaSamsat ?? 0)
      : Number(invoice.biayaSamsat ?? (existing as any)?.biayaSamsat ?? 0);
    const totalTagihan = isExistingCancelled
      ? Number((existing as any)?.totalTagihan ?? invoice.totalTagihan ?? 0)
      : Number(invoice.totalTagihan ?? (existing as any)?.totalTagihan ?? 0);
    const dibayar = isExistingCancelled
      ? Number((existing as any)?.dibayar ?? (existing as any)?.terbayar ?? 0)
      : Number(invoice.dibayar ?? invoice.terbayar ?? (existing as any)?.dibayar ?? 0);
    const sisa = isExistingCancelled
      ? Number((existing as any)?.sisa ?? 0)
      : Number(invoice.sisa ?? Math.max(0, totalTagihan - dibayar));
    const pendapatanJasa = Math.max(0, totalTagihan - biayaSamsat);
    const overpayment = isExistingCancelled
      ? Number((existing as any)?.overpayment ?? 0)
      : Number(
          invoice.overpayment !== undefined
            ? invoice.overpayment
            : ((existing as any)?.overpayment !== undefined && dibayar === Number((existing as any)?.dibayar)
                ? (existing as any).overpayment
                : Math.max(0, dibayar - totalTagihan))
        );
    const settlementCondition = isExistingCancelled
      ? ((existing as any)?.settlementCondition ?? invoice.settlementCondition ?? (overpayment > 0 ? "OVERPAID" : "UNDERPAID"))
      : (
          invoice.settlementCondition ||
          (overpayment > 0 ? "OVERPAID" : (dibayar >= totalTagihan && totalTagihan > 0 ? "BALANCED" : "UNDERPAID"))
        ) as string;
    const refundStatus = isExistingCancelled
      ? ((existing as any)?.refundStatus || invoice.refundStatus || (overpayment > 0 ? "PENDING" : "NONE"))
      : (
          invoice.refundStatus ||
          (existing as any)?.refundStatus ||
          (overpayment > 0 ? "PENDING" : "NONE")
        ) as string;
    const cashbackNominal = Number(invoice.cashback ?? (existing as any)?.cashback ?? 0);
    const cashbackStatus = (invoice.cashbackStatus || (existing as any)?.cashbackStatus || (cashbackNominal > 0 ? "PENDING" : "APPROVED")) as string;
    
    // Phase C Canonical Proportional Matching Formula
    const recognizedRevenue = Math.min(dibayar, totalTagihan);
    const isAnomaly = totalTagihan > 0 && biayaSamsat > totalTagihan;
    const alpha = totalTagihan > 0 ? (biayaSamsat / totalTagihan) : 0;
    const matchedCOGS = Math.min(biayaSamsat, Math.round(alpha * recognizedRevenue));
    const maxProfit = isAnomaly ? 0 : Math.max(0, recognizedRevenue - matchedCOGS);
    const profitFinal = isAnomaly
      ? 0
      : (invoice.profit !== undefined
          ? Math.min(Number(invoice.profit), maxProfit)
          : ((existing as any)?.profit !== undefined ? Math.min(Number((existing as any)?.profit), maxProfit) : maxProfit));
    const profitStatus = (invoice.profitStatus || (existing as any)?.profitStatus || (isAnomaly ? "HOLD_ANOMALY" : (((sisa === 0 || overpayment > 0) && totalTagihan > 0) ? "REALIZED" : "PENDING"))) as string;
    const biayaJasa = Number((invoice as any).biayaJasa ?? (existing as any)?.biayaJasa ?? 0);
    const biayaAntarJemput = Number((invoice as any).biayaAntarJemput ?? (existing as any)?.biayaAntarJemput ?? 0);
    const namaPenerimaKeluar = (invoice as any).namaPenerimaKeluar || (existing as any)?.namaPenerimaKeluar || null;
    const alasanPending = (invoice as any).alasan_pending || (invoice as any).alasan || (existing as any)?.alasan_pending || (existing as any)?.alasan || null;
    const serviceId = (invoice as any).serviceId || (invoice as any).service_id || (existing as any)?.serviceId || (existing as any)?.service_id || null;
    const explicitCostVerificationStatus =
      (invoice as any).costVerificationStatus || (invoice as any).cost_verification_status;
    const explicitIsDraft =
      (invoice as any).isDraftEstimate !== undefined
        ? Boolean((invoice as any).isDraftEstimate)
        : ((invoice as any).is_draft_estimate !== undefined
            ? Boolean((invoice as any).is_draft_estimate)
            : undefined);
    const explicitCompleteness =
      (invoice as any).costCompletenessStatus || (invoice as any).cost_completeness_status;
    const explicitCostVerified =
      (invoice as any).isCostVerified !== undefined
        ? Boolean((invoice as any).isCostVerified)
        : ((invoice as any).is_cost_verified !== undefined
            ? Boolean((invoice as any).is_cost_verified)
            : undefined);

    let linkedOrderIsPartial = false;
    if (!existing && explicitCostVerificationStatus === undefined && explicitIsDraft === undefined) {
      try {
        const orderRow = db
          .prepare("SELECT is_cost_verified, cost_completeness_status, data_json FROM orders WHERE UPPER(order_no) = UPPER(?)")
          .get(invoice.orderNo) as any;
        if (orderRow) {
          let parsedOrder: any = {};
          try {
            parsedOrder = JSON.parse(orderRow.data_json || "{}");
          } catch {}
          const orderCompleteness = String(
            orderRow.cost_completeness_status || parsedOrder.costCompletenessStatus || ""
          ).toUpperCase();
          const orderVerified =
            orderRow.is_cost_verified !== null && orderRow.is_cost_verified !== undefined
              ? Boolean(orderRow.is_cost_verified)
              : parsedOrder.isCostVerified;
          if (orderCompleteness === "PARTIAL_ESTIMATE" || orderVerified === false) {
            linkedOrderIsPartial = true;
          }
        }
      } catch {
        // Non-fatal if orders table is not present in standalone unit tests
      }
    }

    const inferredPartial =
      explicitIsDraft === true ||
      explicitCompleteness === "PARTIAL_ESTIMATE" ||
      explicitCostVerified === false ||
      linkedOrderIsPartial;

    const costVerificationStatus =
      explicitCostVerificationStatus ||
      (inferredPartial
        ? "PENDING_VERIFICATION"
        : ((existing as any)?.costVerificationStatus || (existing as any)?.cost_verification_status || "VERIFIED"));
    const isExplicitZero = (invoice as any).isExplicitZero !== undefined
      ? ((invoice as any).isExplicitZero ? 1 : 0)
      : ((invoice as any).is_explicit_zero !== undefined
          ? ((invoice as any).is_explicit_zero ? 1 : 0)
          : ((invoice as any).isZeroCostPromotion ? 1 : ((existing as any)?.isExplicitZero ? 1 : 0)));
    const isDraftEstimate =
      explicitIsDraft !== undefined
        ? (explicitIsDraft ? 1 : 0)
        : (inferredPartial
            ? 1
            : (existing
                ? ((existing as any)?.isDraftEstimate ? 1 : 0)
                : (costVerificationStatus === "PENDING_VERIFICATION" ? 1 : 0)));

    if (existing) {
      const merged: InvoiceBillingRecord = (isExistingCancelled
        ? {
            ...existing,
            ...invoice,
            status: "CANCELLED",
            billingStatus: "CANCELLED",
            totalTagihan,
            biayaSamsat,
            pendapatanJasa,
            dibayar,
            sisa,
            overpayment,
            refundLiability: (existing as any)?.refundLiability,
            refundStatus,
            settlementCondition,
            payoutHistory: (existing as any)?.payoutHistory,
            payoutVersion: (existing as any)?.payoutVersion ?? 0,
            refundedAmount: (existing as any)?.refundedAmount,
            remainingRefund: (existing as any)?.remainingRefund,
            refundProcessedAt: (existing as any)?.refundProcessedAt,
            refundProcessedBy: (existing as any)?.refundProcessedBy,
            refundProof: (existing as any)?.refundProof,
            refundAccount: (existing as any)?.refundAccount,
            profit: (existing as any)?.profit ?? profitFinal,
            profitStatus: (existing as any)?.profitStatus ?? profitStatus,
            costVerificationStatus,
            cost_verification_status: costVerificationStatus,
            isDraftEstimate: Boolean(isDraftEstimate),
            is_draft_estimate: isDraftEstimate,
            serviceId: serviceId || undefined,
            service_id: serviceId || undefined
          }
        : {
            ...existing,
            ...invoice,
            costVerificationStatus,
            cost_verification_status: costVerificationStatus,
            isDraftEstimate: Boolean(isDraftEstimate),
            is_draft_estimate: isDraftEstimate,
            serviceId: serviceId || undefined,
            service_id: serviceId || undefined
          }) as any;
      const effectiveProfitFinal = isExistingCancelled ? Number((existing as any)?.profit ?? profitFinal) : profitFinal;
      const effectiveProfitStatus = isExistingCancelled ? ((existing as any)?.profitStatus ?? profitStatus) : profitStatus;
      const stmt = db.prepare(`
        UPDATE finance_invoices SET
          invoice_no = ?,
          order_no = ?,
          customer = ?,
          layanan = ?,
          status = ?,
          total_tagihan = ?,
          dibayar = ?,
          sisa = ?,
          biaya_samsat = ?,
          pendapatan_jasa = ?,
          overpayment = ?,
          settlement_condition = ?,
          refund_status = ?,
          cashback_nominal = ?,
          cashback_status = ?,
          profit_final = ?,
          profit_status = ?,
          biaya_jasa = ?,
          biaya_antar_jemput = ?,
          nama_penerima_keluar = ?,
          alasan_pending = ?,
          cost_verification_status = ?,
          is_draft_estimate = ?,
          is_explicit_zero = ?,
          data_json = ?,
          service_id = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `);
      stmt.run(
        merged.invoiceNo || invoice.invoiceNo,
        merged.orderNo || invoice.orderNo,
        merged.customer || "",
        merged.layanan || "",
        isExistingCancelled ? "CANCELLED" : (merged.status || "UNPAID"),
        totalTagihan,
        dibayar,
        sisa,
        biayaSamsat,
        pendapatanJasa,
        overpayment,
        settlementCondition,
        refundStatus,
        cashbackNominal,
        cashbackStatus,
        effectiveProfitFinal,
        effectiveProfitStatus,
        biayaJasa,
        biayaAntarJemput,
        namaPenerimaKeluar ?? null,
        alasanPending ?? null,
        costVerificationStatus,
        isDraftEstimate,
        isExplicitZero,
        JSON.stringify(merged),
        serviceId ?? null,
        existing.id
      );
      return existing.id;
    }

    const invoiceWithFlags = {
      ...invoice,
      costVerificationStatus,
      cost_verification_status: costVerificationStatus,
      isDraftEstimate: Boolean(isDraftEstimate),
      is_draft_estimate: isDraftEstimate,
    };
    const stmt = db.prepare(`
      INSERT INTO finance_invoices (
        invoice_no, order_no, customer, layanan, status,
        total_tagihan, dibayar, sisa, biaya_samsat, pendapatan_jasa,
        overpayment, settlement_condition, refund_status,
        cashback_nominal, cashback_status, profit_final, profit_status,
        biaya_jasa, biaya_antar_jemput, nama_penerima_keluar,
        alasan_pending, cost_verification_status, is_draft_estimate, is_explicit_zero, data_json, service_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    let res: any;
    try {
      res = stmt.run(
        invoice.invoiceNo,
        invoice.orderNo,
        invoice.customer || "",
        invoice.layanan || "",
        invoice.status || "UNPAID",
        totalTagihan,
        dibayar,
        sisa,
        biayaSamsat,
        pendapatanJasa,
        overpayment,
        settlementCondition,
        refundStatus,
        cashbackNominal,
        cashbackStatus,
        profitFinal,
        profitStatus,
        biayaJasa,
        biayaAntarJemput,
        namaPenerimaKeluar,
        alasanPending,
        costVerificationStatus,
        isDraftEstimate,
        isExplicitZero,
        JSON.stringify(invoiceWithFlags),
        serviceId
      );
    } catch (err: any) {
      if (err && (err.code === "SQLITE_CONSTRAINT_UNIQUE" || String(err.message).includes("UNIQUE constraint failed"))) {
        throw new ApiError(
          409,
          "DUPLICATE_ORDER_INVOICE",
          `Invoice untuk pesanan '${invoice.orderNo}' atau nomor invoice '${invoice.invoiceNo}' sudah terdaftar.`
        );
      }
      throw err;
    }

    const insertedId = Number(res.lastInsertRowid);
    const completeRecord = { ...invoiceWithFlags, id: insertedId };
    db.prepare("UPDATE finance_invoices SET data_json = ? WHERE id = ?").run(
      JSON.stringify(completeRecord),
      insertedId
    );
    return insertedId;
  }

  public updateInvoice(id: number, updates: Partial<InvoiceBillingRecord>): boolean {
    const existing = this.getInvoiceById(id);
    if (!existing) return false;

    const isExistingCancelled =
      String(existing.status || "").trim().toUpperCase() === "CANCELLED" ||
      String((existing as any).billingStatus || "").trim().toUpperCase() === "CANCELLED";
    const isCorrectionVoidReset =
      isExistingCancelled &&
      updates.status === "CANCELLED" &&
      (updates as any).billingStatus === "CANCELLED" &&
      updates.dibayar === 0 &&
      updates.overpayment === 0;

    const resolvedStatus = isExistingCancelled
      ? "CANCELLED"
      : (updates.status || (updates as any).billingStatus || existing.status);
    const merged: InvoiceBillingRecord = {
      ...existing,
      ...updates,
      status: resolvedStatus,
      billingStatus: isExistingCancelled
        ? ("CANCELLED" as any)
        : (resolvedStatus === "CANCELLED" ? ("CANCELLED" as any) : ((updates as any).billingStatus || existing.billingStatus || resolvedStatus)),
      ...(isExistingCancelled && !isCorrectionVoidReset
        ? {
            totalTagihan: Number(existing.totalTagihan || 0),
            biayaSamsat: Number(existing.biayaSamsat || 0),
            dibayar: Number(existing.dibayar ?? existing.terbayar ?? 0),
            sisa: Number(existing.sisa ?? 0),
            overpayment: Number(existing.overpayment ?? 0),
            refundLiability: (existing as any).refundLiability ?? (updates as any).refundLiability,
            payoutVersion: updates.payoutVersion !== undefined ? updates.payoutVersion : (existing as any).payoutVersion,
            profit: existing.profit,
            profitStatus: existing.profitStatus,
          }
        : {}),
    };
    const totalTagihan = isExistingCancelled ? Number(merged.totalTagihan || 0) : Number(merged.totalTagihan || 0);
    const dibayar = Number(merged.dibayar ?? merged.terbayar ?? 0);
    const sisa = Number(merged.sisa ?? Math.max(0, totalTagihan - dibayar));
    const biayaSamsat = Number(merged.biayaSamsat || 0);
    const pendapatanJasa = Math.max(0, totalTagihan - biayaSamsat);
    const overpayment = isExistingCancelled && !isCorrectionVoidReset
      ? Number(existing.overpayment ?? 0)
      : Number(
          updates.overpayment !== undefined
            ? updates.overpayment
            : (merged.overpayment !== undefined ? merged.overpayment : Math.max(0, dibayar - totalTagihan))
        );
    const settlementCondition = isExistingCancelled && !isCorrectionVoidReset
      ? (updates.settlementCondition || existing.settlementCondition || (overpayment > 0 ? "OVERPAID" : "UNDERPAID")) as string
      : (
          updates.settlementCondition ||
          (overpayment > 0 ? "OVERPAID" : (dibayar >= totalTagihan && totalTagihan > 0 ? "BALANCED" : "UNDERPAID"))
        ) as string;
    const refundStatus = (
      updates.refundStatus ||
      existing.refundStatus ||
      (overpayment > 0 ? "PENDING" : (merged.refundStatus || "NONE"))
    ) as string;
    const cashbackNominal = Number(merged.cashback || 0);
    const cashbackStatus = (merged.cashbackStatus || (cashbackNominal > 0 ? "PENDING" : "APPROVED")) as string;
    const cashbackCompletionStatus = (
      updates.cashbackCompletionStatus ??
      (merged as any).cashbackCompletionStatus ??
      "PENDING"
    ) as string;
    const cashbackCompletedAt =
      updates.cashbackCompletedAt !== undefined
        ? updates.cashbackCompletedAt
        : (merged as any).cashbackCompletedAt ?? null;
    const cashbackCompletedBy =
      updates.cashbackCompletedBy !== undefined
        ? updates.cashbackCompletedBy
        : (merged as any).cashbackCompletedBy ?? null;

    // Profit must strictly exclude overpayment / trust funds (capped at recognized revenue)
    const recognizedRevenue = Math.min(dibayar, totalTagihan);
    const maxProfit = Math.max(0, recognizedRevenue - biayaSamsat);
    const profitFinal = isExistingCancelled && !isCorrectionVoidReset
      ? Number(existing.profit ?? maxProfit)
      : (updates.profit !== undefined
          ? Math.min(Number(updates.profit), maxProfit)
          : (merged.profit !== undefined ? Math.min(Number(merged.profit), maxProfit) : maxProfit));
    const profitStatus = isExistingCancelled && !isCorrectionVoidReset
      ? ((existing.profitStatus || (existing as any).profit_status || "PENDING") as string)
      : ((updates.profitStatus || (updates as any).profit_status || (updates.billingStatus === "COMPLETED" ? "REALIZED" : (existing.profitStatus || "PENDING"))) as string);
    const alasanPending = (updates as any).alasan_pending || (updates as any).alasan || (existing as any).alasan_pending || (existing as any).alasan || null;
    const serviceId = (updates as any).serviceId || (updates as any).service_id || (existing as any).serviceId || (existing as any).service_id || null;
    const resolvedLayanan = updates.layanan || existing.layanan;

    merged.totalTagihan = totalTagihan;
    merged.dibayar = dibayar;
    merged.sisa = sisa;
    merged.biayaSamsat = biayaSamsat;
    merged.overpayment = overpayment;
    merged.settlementCondition = settlementCondition as any;
    merged.refundStatus = refundStatus as any;
    merged.profit = profitFinal;
    merged.profitStatus = profitStatus as any;

    ensureCashbackCompletionColumns();

    const stmt = db.prepare(`
      UPDATE finance_invoices SET
        layanan = ?,
        service_id = ?,
        status = ?,
        dibayar = ?,
        sisa = ?,
        biaya_samsat = ?,
        pendapatan_jasa = ?,
        overpayment = ?,
        settlement_condition = ?,
        refund_status = ?,
        cashback_nominal = ?,
        cashback_status = ?,
        cashback_completion_status = ?,
        cashback_completed_at = ?,
        cashback_completed_by = ?,
        profit_final = ?,
        profit_status = ?,
        alasan_pending = ?,
        data_json = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    const res = stmt.run(
      resolvedLayanan ?? "",
      serviceId ?? null,
      merged.status,
      dibayar,
      sisa,
      biayaSamsat,
      pendapatanJasa,
      overpayment,
      settlementCondition,
      refundStatus,
      cashbackNominal,
      cashbackStatus,
      cashbackCompletionStatus,
      cashbackCompletedAt ?? null,
      cashbackCompletedBy ?? null,
      profitFinal,
      profitStatus,
      alasanPending ?? null,
      JSON.stringify({
        ...merged,
        cashbackCompletionStatus,
        cashbackCompletedAt: cashbackCompletedAt || undefined,
        cashbackCompletedBy: cashbackCompletedBy || undefined,
        serviceId: serviceId || undefined,
        service_id: serviceId || undefined,
      }),
      id
    );

    return res.changes > 0;
  }

  /**
   * Checks if an invoice has recorded payment entries.
   * Scoped to invoiceNo and optional orderNo to prevent false positives across collided invoices.
   */
  public hasPayments(invoiceNo: string, orderNo?: string): boolean {
    let cleanOrderNo = orderNo;
    if (!cleanOrderNo) {
      try {
        const invRow = db.prepare("SELECT order_no FROM finance_invoices WHERE invoice_no = ?").get(invoiceNo) as { order_no: string } | undefined;
        cleanOrderNo = invRow?.order_no;
      } catch {}
    }

    if (cleanOrderNo) {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM invoice_payments WHERE invoice_no = ? AND order_no = ? AND is_void = 0")
        .get(invoiceNo, cleanOrderNo) as { count: number } | undefined;
      return Boolean(row && row.count > 0);
    }

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM invoice_payments WHERE invoice_no = ? AND is_void = 0")
      .get(invoiceNo) as { count: number } | undefined;
    return Boolean(row && row.count > 0);
  }

  /**
   * Deletes an invoice with cascade deletion safeguard.
   * Strictly refuses deletion if verified payments exist to prevent cascading data loss.
   */
  public deleteInvoice(id: number): boolean {
    const inv = this.getInvoiceById(id);
    if (!inv) return false;

    if (inv.invoiceNo && this.hasPayments(inv.invoiceNo, inv.orderNo)) {
      throw new Error(`INVOICE_HAS_PAYMENTS: Cannot delete invoice '${inv.invoiceNo}' because it has recorded payments.`);
    }

    const stmt = db.prepare("DELETE FROM finance_invoices WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ─── INVOICE PAYMENTS REPOSITORY METHODS ────────────────────────────────────

  public getValidPaymentsTotal(invoiceNo: string, orderNo?: string): number {
    let cleanOrderNo = orderNo;
    if (!cleanOrderNo) {
      // Resolve associated orderNo from finance_invoices to avoid cross-order aggregation (GAP-FIN-01)
      try {
        const invRow = db.prepare("SELECT order_no FROM finance_invoices WHERE invoice_no = ?").get(invoiceNo) as { order_no: string } | undefined;
        cleanOrderNo = invRow?.order_no;
      } catch {}
    }

    if (cleanOrderNo) {
      const stmt = db.prepare(`
        SELECT COALESCE(SUM(nominal), 0) AS total
        FROM invoice_payments
        WHERE invoice_no = ?
          AND order_no = ?
          AND is_void = 0
          AND status_verifikasi = 'TERVERIFIKASI'
      `);
      const row = stmt.get(invoiceNo, cleanOrderNo) as { total: number } | undefined;
      return row ? Math.round(Number(row.total)) : 0;
    }

    const stmt = db.prepare(`
      SELECT COALESCE(SUM(nominal), 0) AS total
      FROM invoice_payments
      WHERE invoice_no = ?
        AND is_void = 0
        AND status_verifikasi = 'TERVERIFIKASI'
    `);
    const row = stmt.get(invoiceNo) as { total: number } | undefined;
    return row ? Math.round(Number(row.total)) : 0;
  }

  public getValidPaymentsTotalByOrder(orderNo: string): number {
    const stmt = db.prepare(`
      SELECT COALESCE(SUM(nominal), 0) AS total
      FROM invoice_payments
      WHERE order_no = ?
        AND is_void = 0
        AND status_verifikasi = 'TERVERIFIKASI'
    `);
    const row = stmt.get(orderNo) as { total: number } | undefined;
    return row ? Math.round(Number(row.total)) : 0;
  }

  public getPaymentsByInvoiceAndOrder(invoiceNo: string, orderNo: string): any[] {
    const stmt = db.prepare(`
      SELECT * FROM invoice_payments
      WHERE invoice_no = ? AND order_no = ? AND is_void = 0
      ORDER BY id ASC
    `);
    return stmt.all(invoiceNo, orderNo);
  }

  public getPaymentsByInvoiceNo(invoiceNo: string, orderNo?: string): any[] {
    let cleanOrderNo = orderNo;
    if (!cleanOrderNo) {
      try {
        const invRow = db.prepare("SELECT order_no FROM finance_invoices WHERE invoice_no = ?").get(invoiceNo) as { order_no: string } | undefined;
        cleanOrderNo = invRow?.order_no;
      } catch {}
    }
    if (cleanOrderNo) {
      return this.getPaymentsByInvoiceAndOrder(invoiceNo, cleanOrderNo);
    }
    const stmt = db.prepare("SELECT * FROM invoice_payments WHERE invoice_no = ? AND is_void = 0 ORDER BY id ASC");
    return stmt.all(invoiceNo);
  }

  public getPaymentsByOrderNo(orderNo: string): any[] {
    const stmt = db.prepare("SELECT * FROM invoice_payments WHERE order_no = ? ORDER BY id ASC");
    return stmt.all(orderNo);
  }

  public getAllPayments(): any[] {
    const stmt = db.prepare("SELECT * FROM invoice_payments ORDER BY id DESC");
    return stmt.all();
  }

  public getInvoicePaymentById(paymentId: number | string): any {
    if (typeof paymentId === "number" || /^\d+$/.test(String(paymentId).trim())) {
      const numericId = typeof paymentId === "number" ? paymentId : parseInt(String(paymentId).trim(), 10);
      const stmt = db.prepare("SELECT * FROM invoice_payments WHERE id = ?");
      return stmt.get(numericId);
    }
    const cleanStr = String(paymentId).trim();
    if (isValidCanonicalPaymentId(cleanStr)) {
      const stmt = db.prepare("SELECT * FROM invoice_payments WHERE payment_id = ?");
      return stmt.get(cleanStr);
    }
    return undefined;
  }

  public getInvoicePaymentByPaymentId(paymentId: string): any {
    const cleanStr = String(paymentId || "").trim();
    if (!cleanStr) return undefined;
    const stmt = db.prepare("SELECT * FROM invoice_payments WHERE payment_id = ?");
    return stmt.get(cleanStr);
  }

  public updateInvoicePayment(paymentId: number | string, updates: Partial<any>): boolean {
    const existing = this.getInvoicePaymentById(paymentId);
    if (!existing) return false;
    const numericId = existing.id;

    const COLUMN_MAP: Record<string, string> = {
      paymentId: "payment_id",
      invoiceNo: "invoice_no",
      orderNo: "order_no",
      metodePembayaran: "metode_pembayaran",
      namaBank: "nama_bank",
      nomorRekening: "nomor_rekening",
      tanggalBayar: "tanggal_bayar",
      documentId: "document_id",
      kasKantorId: "kas_kantor_id",
      statusVerifikasi: "status_verifikasi",
      idempotencyKey: "idempotency_key",
      verifiedBy: "verified_by",
      verifiedAt: "verified_at",
      isVoid: "is_void",
      voidReason: "void_reason",
      voidAt: "void_at",
      voidBy: "void_by",
      voidKasKantorId: "void_kas_kantor_id",
      metodePembayaranId: "metode_pembayaran_id",
      paymentMethodId: "metode_pembayaran_id",
      paymentMethodSnapshot: "payment_method_snapshot",
    };

    const normalizedUpdates: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      const col = COLUMN_MAP[k] || k;
      normalizedUpdates[col] = v;
    }

    // GAP-FIN-02: Prevent silent or unauthorized changes to invoice_no or order_no
    const newInvoiceNo = normalizedUpdates.invoice_no !== undefined ? String(normalizedUpdates.invoice_no).trim() : existing.invoice_no;
    const newOrderNo = normalizedUpdates.order_no !== undefined ? String(normalizedUpdates.order_no).trim() : existing.order_no;

    if (normalizedUpdates.invoice_no !== undefined || normalizedUpdates.order_no !== undefined) {
      try {
        const targetInvoice = this.getInvoiceByNo(newInvoiceNo);
        if (targetInvoice && targetInvoice.orderNo) {
          if (targetInvoice.orderNo.trim().toUpperCase() !== newOrderNo.toUpperCase()) {
            throw new Error(
              `[RELATIONAL_INTEGRITY_VIOLATION] Cannot update payment #${paymentId}: Invoice '${newInvoiceNo}' belongs to order '${targetInvoice.orderNo}', not '${newOrderNo}'.`
            );
          }
        }
      } catch (err: any) {
        if (err?.message?.includes("RELATIONAL_INTEGRITY_VIOLATION")) throw err;
      }
    }

    const fields = Object.keys(normalizedUpdates);
    if (fields.length === 0) return true;
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => normalizedUpdates[f]);
    const stmt = db.prepare(`UPDATE invoice_payments SET ${setClause} WHERE id = ?`);
    const res = stmt.run(...values, numericId);
    return res.changes > 0;
  }

  public recordInvoicePayment(data: {
    paymentId?: string;
    invoiceNo: string;
    orderNo: string;
    nominal: number;
    metodePembayaran: string;
    namaBank?: string;
    nomorRekening?: string;
    tanggalBayar?: string;
    documentId?: string;
    kasKantorId?: number;
    statusVerifikasi?: string;
    idempotencyKey?: string;
    verifiedBy?: string;
    verifiedAt?: string;
    catatan?: string;
    metode_pembayaran_id?: string | null;
    metodePembayaranId?: string | null;
    payment_method_snapshot?: string | null;
    paymentMethodSnapshot?: string | null;
  }, targetDb?: DatabaseSync): any {
    const activeDb = targetDb ?? db;
    // Validate paymentId if provided
    let cleanPaymentId: string | null = null;
    if (data.paymentId !== undefined && data.paymentId !== null) {
      const trimmed = String(data.paymentId).trim();
      if (!isValidCanonicalPaymentId(trimmed)) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Payment ID harus berupa UUID v4 kanonis dengan prefix 'pay-'."
        );
      }
      cleanPaymentId = trimmed;
    }

    // GAP-FIN-02: Fail-closed relational integrity validation
    const cleanInvoiceNo = (data.invoiceNo || "").trim();
    const cleanOrderNo = (data.orderNo || "").trim();

    if (!cleanInvoiceNo) {
      throw new Error("[RELATIONAL_INTEGRITY_VIOLATION] invoiceNo is required for invoice_payments.");
    }
    if (!cleanOrderNo) {
      throw new Error("[RELATIONAL_INTEGRITY_VIOLATION] orderNo is required for invoice_payments.");
    }

    try {
      const targetInvoice = this.getInvoiceByNo(cleanInvoiceNo);
      if (targetInvoice && targetInvoice.orderNo) {
        const invoiceOrderNo = targetInvoice.orderNo.trim().toUpperCase();
        if (invoiceOrderNo !== cleanOrderNo.toUpperCase()) {
          throw new Error(
            `[RELATIONAL_INTEGRITY_VIOLATION] Mismatch between invoice and order. Invoice '${cleanInvoiceNo}' belongs to order '${targetInvoice.orderNo}', but payment payload specifies order '${cleanOrderNo}'. Payment rejected.`
          );
        }
      }
    } catch (e: any) {
      if (e?.message?.includes("RELATIONAL_INTEGRITY_VIOLATION")) {
        throw e;
      }
      // Non-fatal if invoice table not yet initialized in early migration
    }

    const cleanPmId = (data as any).metode_pembayaran_id || (data as any).metodePembayaranId || null;
    const cleanPmSnapshot = (data as any).payment_method_snapshot || (data as any).paymentMethodSnapshot || null;

    const stmt = activeDb.prepare(`
      INSERT INTO invoice_payments (
        payment_id, invoice_no, order_no, nominal, metode_pembayaran, nama_bank,
        nomor_rekening, tanggal_bayar, document_id, kas_kantor_id,
        status_verifikasi, idempotency_key, verified_by, verified_at,
        catatan, created_at, metode_pembayaran_id, payment_method_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `);

    const res = stmt.run(
      cleanPaymentId,
      cleanInvoiceNo,
      cleanOrderNo,
      Math.round(Number(data.nominal)),
      data.metodePembayaran,
      data.namaBank || null,
      data.nomorRekening || null,
      data.tanggalBayar || new Date().toISOString(),
      data.documentId || null,
      data.kasKantorId || null,
      data.statusVerifikasi || "TERVERIFIKASI",
      data.idempotencyKey || null,
      data.verifiedBy || "Finance User",
      data.verifiedAt || new Date().toISOString(),
      data.catatan || null,
      cleanPmId,
      cleanPmSnapshot
    );

    return {
      id: Number(res.lastInsertRowid),
      payment_id: cleanPaymentId,
      paymentId: cleanPaymentId,
      ...data,
      nominal: Math.round(Number(data.nominal)),
      metode_pembayaran_id: cleanPmId,
      payment_method_snapshot: cleanPmSnapshot,
      createdAt: new Date().toISOString(),
    };
  }

  // ─── KAS KANTOR & PENGELUARAN OPERATIONS ───────────────────────────────────

  public getAllKasKantor(targetDb?: DatabaseSync): KasKantorItem[] {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare("SELECT * FROM kas_kantor ORDER BY substr(tanggal, 1, 10) DESC, created_at DESC, id DESC");
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      id: r.id,
      tanggal: r.tanggal,
      keterangan: r.keterangan,
      status: r.status,
      debit: Number(r.debit || 0),
      kredit: Number(r.kredit || 0),
      saldo: Number(r.saldo || 0),
      total: Number(r.saldo || 0),
      penanggungJawab: r.penanggung_jawab || undefined,
      kategori: r.kategori || undefined,
      orderNo: r.order_no || undefined,
      invoiceNo: r.invoice_no || undefined,
      paymentMethodId: r.payment_method_id || undefined,
      paymentMethodSnapshot: r.payment_method_snapshot || undefined,
      createdAt: r.created_at || undefined,
    })) as unknown as KasKantorItem[];
  }

  public addKasKantor(
    item: Omit<KasKantorItem, "id" | "total"> & {
      orderNo?: string;
      invoiceNo?: string;
      kategori?: string;
      total?: number;
      payment_method_id?: string | null;
      payment_method_snapshot?: string | null;
      paymentMethodId?: string | null;
      paymentMethodSnapshot?: string | null;
    },
    targetDb?: DatabaseSync
  ): KasKantorItem {
    const activeDb = targetDb ?? getDb();
    const isDebit = item.status === "Pemasukan" || item.status === "Debit";
    const debitVal = Number(item.debit ?? (isDebit ? ((item as any).nominal ?? 0) : 0));
    const kreditVal = Number(item.kredit ?? (!isDebit ? ((item as any).nominal ?? 0) : 0));
    const pmId = item.payment_method_id || item.paymentMethodId || null;
    const pmSnapshot = item.payment_method_snapshot || item.paymentMethodSnapshot || null;

    const insertStmt = activeDb.prepare(`
      INSERT INTO kas_kantor (
        tanggal, keterangan, status, debit, kredit, saldo, 
        penanggung_jawab, order_no, invoice_no, kategori,
        payment_method_id, payment_method_snapshot, created_at
      )
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const res = insertStmt.run(
      item.tanggal,
      item.keterangan,
      item.status,
      debitVal,
      kreditVal,
      item.penanggungJawab || null,
      (item as any).orderNo || null,
      (item as any).invoiceNo || null,
      (item as any).kategori || null,
      pmId,
      pmSnapshot
    );

    const newId = Number(res.lastInsertRowid);
    recalculateKasKantorRunningBalances(activeDb);

    const inserted = activeDb.prepare("SELECT * FROM kas_kantor WHERE id = ?").get(newId) as any;
    return {
      id: newId,
      tanggal: inserted?.tanggal || item.tanggal,
      keterangan: inserted?.keterangan || item.keterangan,
      status: inserted?.status || item.status,
      debit: Number(inserted?.debit || debitVal),
      kredit: Number(inserted?.kredit || kreditVal),
      saldo: Number(inserted?.saldo || 0),
      total: Number(inserted?.saldo || 0),
      penanggungJawab: inserted?.penanggung_jawab || item.penanggungJawab,
      kategori: inserted?.kategori || (item as any).kategori || undefined,
      orderNo: inserted?.order_no || (item as any).orderNo || undefined,
      invoiceNo: inserted?.invoice_no || (item as any).invoiceNo || undefined,
      paymentMethodId: inserted?.payment_method_id || pmId || undefined,
      paymentMethodSnapshot: inserted?.payment_method_snapshot || pmSnapshot || undefined,
      createdAt: inserted?.created_at || undefined,
    } as unknown as KasKantorItem;
  }

  public updateKasKantor(
    id: number,
    updates: {
      tanggal: string;
      keterangan: string;
      status: string;
      debit: number;
      kredit: number;
      penanggungJawab?: string | null;
      kategori?: string | null;
      orderNo?: string | null;
      invoiceNo?: string | null;
      payment_method_id?: string | null;
      payment_method_snapshot?: string | null;
    },
    targetDb?: DatabaseSync
  ): KasKantorItem | undefined {
    const activeDb = targetDb ?? getDb();
    const res = activeDb.prepare(`
      UPDATE kas_kantor SET
        tanggal = ?,
        keterangan = ?,
        status = ?,
        debit = ?,
        kredit = ?,
        penanggung_jawab = ?,
        kategori = ?,
        order_no = ?,
        invoice_no = ?,
        payment_method_id = ?,
        payment_method_snapshot = ?
      WHERE id = ?
    `).run(
      updates.tanggal,
      updates.keterangan,
      updates.status,
      updates.debit,
      updates.kredit,
      updates.penanggungJawab ?? null,
      updates.kategori ?? null,
      updates.orderNo ?? null,
      updates.invoiceNo ?? null,
      updates.payment_method_id ?? null,
      updates.payment_method_snapshot ?? null,
      id
    );

    if (res.changes === 0) return undefined;
    recalculateKasKantorRunningBalances(activeDb);
    return this.getKasKantorById(id, activeDb);
  }

  public getAllPengeluaran(): PengeluaranItem[] {
    const stmt = db.prepare("SELECT * FROM pengeluaran ORDER BY substr(tanggal, 1, 10) DESC, created_at DESC, id DESC");
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      id: r.id,
      tanggal: r.tanggal,
      keterangan: r.keterangan,
      nominal: r.nominal,
      penanggungJawab: r.penanggung_jawab || undefined,
      kategori: r.kategori || undefined,
      orderNo: r.order_no || undefined,
      invoiceNo: r.invoice_no || undefined,
    })) as PengeluaranItem[];
  }

  public addPengeluaran(item: Omit<PengeluaranItem, "id"> & { orderNo?: string; invoiceNo?: string; kategori?: string }): PengeluaranItem {
    const insertStmt = db.prepare(`
      INSERT INTO pengeluaran (tanggal, keterangan, nominal, penanggung_jawab, order_no, invoice_no, kategori)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const res = insertStmt.run(
      item.tanggal,
      item.keterangan,
      item.nominal,
      item.penanggungJawab || null,
      (item as any).orderNo || null,
      (item as any).invoiceNo || null,
      (item as any).kategori || null
    );

    return {
      id: Number(res.lastInsertRowid),
      tanggal: item.tanggal,
      keterangan: item.keterangan,
      nominal: item.nominal,
      penanggungJawab: item.penanggungJawab,
      kategori: (item as any).kategori || undefined,
      orderNo: (item as any).orderNo || undefined,
    };
  }

  public getKasKantorById(id: number, targetDb?: DatabaseSync): KasKantorItem | undefined {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare("SELECT * FROM kas_kantor WHERE id = ?");
    const r = stmt.get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      tanggal: r.tanggal,
      keterangan: r.keterangan,
      status: r.status,
      debit: Number(r.debit || 0),
      kredit: Number(r.kredit || 0),
      saldo: Number(r.saldo || 0),
      total: Number(r.saldo || 0),
      penanggungJawab: r.penanggung_jawab || undefined,
      kategori: r.kategori || undefined,
      orderNo: r.order_no || undefined,
      invoiceNo: r.invoice_no || undefined,
      paymentMethodId: r.payment_method_id || undefined,
      paymentMethodSnapshot: r.payment_method_snapshot || undefined,
      createdAt: r.created_at || undefined,
    } as unknown as KasKantorItem;
  }

  public deleteKasKantor(id: number): boolean {
    // Non-destructive compensating reversal (Workstream 3 & C1.0.1 Invariant)
    const existing = db.prepare("SELECT * FROM kas_kantor WHERE id = ?").get(id) as any;
    if (!existing) return false;

    const balRow = db.prepare("SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(kredit), 0) AS balance FROM kas_kantor").get() as { balance: number } | undefined;
    const currentBalance = balRow ? Number(balRow.balance || 0) : 0;

    const isOriginalDebit = existing.status === "Pemasukan" || existing.status === "Debit" || Number(existing.debit || 0) > 0;
    const debitVal = isOriginalDebit ? 0 : Number(existing.kredit || 0);
    const kreditVal = isOriginalDebit ? Number(existing.debit || 0) : 0;
    const newStatus = isOriginalDebit ? "Kredit" : "Debit";
    const newSaldo = newStatus === "Debit" ? currentBalance + debitVal : currentBalance - kreditVal;

    const insertStmt = db.prepare(`
      INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, penanggung_jawab, order_no, invoice_no, kategori)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const nowStr = new Date().toISOString().split("T")[0];
    const res = insertStmt.run(
      nowStr,
      `[VOID] Reversal Kas Kantor #${id}: ${existing.keterangan || "-"}`,
      newStatus,
      debitVal,
      kreditVal,
      newSaldo,
      "System Reversal",
      existing.order_no || null,
      existing.invoice_no || null,
      "Reversal"
    );
    return res.changes > 0;
  }

  public getPengeluaranById(id: number): PengeluaranItem | undefined {
    const stmt = db.prepare("SELECT * FROM pengeluaran WHERE id = ?");
    const r = stmt.get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      tanggal: r.tanggal,
      keterangan: r.keterangan,
      nominal: r.nominal,
      penanggungJawab: r.penanggung_jawab || undefined,
    };
  }

  public deletePengeluaran(id: number): boolean {
    const stmt = db.prepare("DELETE FROM pengeluaran WHERE id = ?");
    const res = stmt.run(id);
    return res.changes > 0;
  }

  // ─── KAS MESSENGER DATABASE REPOSITORY ──────────────────────────────────────

  public getAllKasMessenger(messengerId?: string, targetDb?: DatabaseSync): KasMessengerItem[] {
    const activeDb = targetDb ?? getDb();
    let query = "SELECT * FROM kas_messenger";
    const params: any[] = [];
    if (messengerId) {
      query += " WHERE messenger_id = ?";
      params.push(messengerId);
    }
    query += " ORDER BY substr(tanggal, 1, 10) DESC, created_at DESC, id DESC";

    const stmt = activeDb.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      tanggal: r.tanggal,
      jenis: r.jenis,
      messenger: r.messenger,
      keterangan: r.keterangan,
      in: Number(r.debit || 0),
      out: Number(r.kredit || 0),
      total: Number(r.total || 0),
      penanggungJawab: r.penanggung_jawab || undefined,
      orderNo: r.order_no || undefined,
      reimbursementId: r.reimbursement_id || undefined,
      receiptUrl: r.receipt_url || undefined,
      kategori: r.kategori || undefined,
      messengerId: r.messenger_id || undefined,
      paymentMethodId: r.payment_method_id || undefined,
      paymentMethodSnapshot: r.payment_method_snapshot || undefined,
      createdAt: r.created_at || undefined,
    })) as KasMessengerItem[];
  }

  public getKasMessengerById(id: number, targetDb?: DatabaseSync): KasMessengerItem | undefined {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare("SELECT * FROM kas_messenger WHERE id = ?");
    const r = stmt.get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      tanggal: r.tanggal,
      jenis: r.jenis,
      messenger: r.messenger,
      keterangan: r.keterangan,
      in: Number(r.debit || 0),
      out: Number(r.kredit || 0),
      total: Number(r.total || 0),
      penanggungJawab: r.penanggung_jawab || undefined,
      orderNo: r.order_no || undefined,
      reimbursementId: r.reimbursement_id || undefined,
      receiptUrl: r.receipt_url || undefined,
      kategori: r.kategori || undefined,
      messengerId: r.messenger_id || undefined,
      paymentMethodId: r.payment_method_id || undefined,
      paymentMethodSnapshot: r.payment_method_snapshot || undefined,
      createdAt: r.created_at || undefined,
    };
  }

  public addKasMessenger(
    item: Omit<KasMessengerItem, "id" | "total"> & {
      total?: number;
      penanggungJawab?: string;
      orderNo?: string;
      reimbursementId?: string;
      receiptUrl?: string;
      kategori?: string;
      payment_method_id?: string | null;
      payment_method_snapshot?: string | null;
      paymentMethodId?: string | null;
      paymentMethodSnapshot?: string | null;
      messenger_id?: string | null;
      messengerId?: string | null;
    },
    targetDb?: DatabaseSync
  ): KasMessengerItem {
    const activeDb = targetDb ?? getDb();
    let messengerId = (item as any).messenger_id || (item as any).messengerId || null;

    if (!messengerId && item.messenger) {
      const mRow = activeDb.prepare(`
        SELECT m.id 
        FROM messengers m 
        LEFT JOIN employees e ON m.employee_id = e.id 
        WHERE e.nama_lengkap = ? OR m.id = ? 
        LIMIT 1
      `).get(item.messenger, item.messenger) as { id: string } | undefined;
      if (mRow) {
        messengerId = mRow.id;
      }
    }

    const debit = Number(item.in || (item as any).debit || 0);
    const kredit = Number(item.out || (item as any).kredit || 0);
    const pmId = item.payment_method_id || item.paymentMethodId || null;
    const pmSnapshot = item.payment_method_snapshot || item.paymentMethodSnapshot || null;

    const insertStmt = activeDb.prepare(`
      INSERT INTO kas_messenger (
        tanggal, jenis, messenger, keterangan, debit, kredit, total, 
        penanggung_jawab, order_no, reimbursement_id, receipt_url, 
        kategori, messenger_id, payment_method_id, payment_method_snapshot, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const res = insertStmt.run(
      item.tanggal,
      item.jenis,
      item.messenger,
      item.keterangan,
      debit,
      kredit,
      item.penanggungJawab || null,
      item.orderNo || null,
      item.reimbursementId || null,
      item.receiptUrl || null,
      item.kategori || null,
      messengerId,
      pmId,
      pmSnapshot
    );

    const newId = Number(res.lastInsertRowid);
    if (messengerId) {
      recalculateKasMessengerRunningBalances(messengerId, activeDb);
    }

    const inserted = activeDb.prepare("SELECT * FROM kas_messenger WHERE id = ?").get(newId) as any;
    return {
      id: newId,
      tanggal: inserted?.tanggal || item.tanggal,
      jenis: inserted?.jenis || item.jenis,
      messenger: inserted?.messenger || item.messenger,
      keterangan: inserted?.keterangan || item.keterangan,
      in: debit,
      out: kredit,
      total: Number(inserted?.total || 0),
      penanggungJawab: inserted?.penanggung_jawab || item.penanggungJawab,
      orderNo: inserted?.order_no || item.orderNo,
      reimbursementId: inserted?.reimbursement_id || item.reimbursementId,
      receiptUrl: inserted?.receipt_url || item.receiptUrl,
      kategori: inserted?.kategori || item.kategori,
      messengerId: inserted?.messenger_id || messengerId,
      paymentMethodId: inserted?.payment_method_id || pmId || undefined,
      paymentMethodSnapshot: inserted?.payment_method_snapshot || pmSnapshot || undefined,
      createdAt: inserted?.created_at || undefined,
    } as KasMessengerItem;
  }

  public updateKasMessenger(
    id: number,
    updates: {
      tanggal: string;
      jenis: string;
      messenger: string;
      messengerId: string | null;
      keterangan: string;
      debit: number;
      kredit: number;
      penanggungJawab?: string | null;
      orderNo?: string | null;
      kategori?: string | null;
      payment_method_id?: string | null;
      payment_method_snapshot?: string | null;
    },
    previousMessengerId?: string | null,
    targetDb?: DatabaseSync
  ): KasMessengerItem | undefined {
    const activeDb = targetDb ?? getDb();
    const res = activeDb.prepare(`
      UPDATE kas_messenger SET
        tanggal = ?,
        jenis = ?,
        messenger = ?,
        messenger_id = ?,
        keterangan = ?,
        debit = ?,
        kredit = ?,
        penanggung_jawab = ?,
        order_no = ?,
        kategori = ?,
        payment_method_id = ?,
        payment_method_snapshot = ?
      WHERE id = ?
    `).run(
      updates.tanggal,
      updates.jenis,
      updates.messenger,
      updates.messengerId ?? null,
      updates.keterangan,
      updates.debit,
      updates.kredit,
      updates.penanggungJawab ?? null,
      updates.orderNo ?? null,
      updates.kategori ?? null,
      updates.payment_method_id ?? null,
      updates.payment_method_snapshot ?? null,
      id
    );

    if (res.changes === 0) return undefined;

    if (previousMessengerId && previousMessengerId !== updates.messengerId) {
      recalculateKasMessengerRunningBalances(previousMessengerId, activeDb);
    }
    if (updates.messengerId) {
      recalculateKasMessengerRunningBalances(updates.messengerId, activeDb);
    }
    return this.getKasMessengerById(id, activeDb);
  }

  public deleteKasMessenger(id: number): boolean {
    // Non-destructive compensating reversal (Workstream 3 & C1.0.1 Invariant)
    const existing = db.prepare("SELECT * FROM kas_messenger WHERE id = ?").get(id) as any;
    if (!existing) return false;

    const messengerId = existing.messenger_id;
    let lastTotal = 0;
    if (messengerId) {
      const lastRow = db.prepare("SELECT total FROM kas_messenger WHERE messenger_id = ? ORDER BY substr(tanggal, 1, 10) DESC, created_at DESC, id DESC LIMIT 1").get(messengerId) as { total?: number } | undefined;
      lastTotal = lastRow?.total ?? 0;
    } else if (existing.messenger) {
      const lastRow = db.prepare("SELECT total FROM kas_messenger WHERE messenger = ? ORDER BY substr(tanggal, 1, 10) DESC, created_at DESC, id DESC LIMIT 1").get(existing.messenger) as { total?: number } | undefined;
      lastTotal = lastRow?.total ?? 0;
    }

    const origDebit = Number(existing.debit || 0);
    const origKredit = Number(existing.kredit || 0);
    const revDebit = origKredit;
    const revKredit = origDebit;
    const newJenis = revDebit > 0 ? "Pemasukan" : "Pengeluaran";
    const newTotal = lastTotal + revDebit - revKredit;

    const insertStmt = db.prepare(`
      INSERT INTO kas_messenger (tanggal, jenis, messenger, keterangan, debit, kredit, total, penanggung_jawab, order_no, reimbursement_id, receipt_url, kategori, messenger_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const nowStr = new Date().toISOString().split("T")[0];
    const res = insertStmt.run(
      nowStr,
      newJenis,
      existing.messenger,
      `[VOID] Reversal Kas Messenger #${id}: ${existing.keterangan || "-"}`,
      revDebit,
      revKredit,
      newTotal,
      "System Reversal",
      existing.order_no || null,
      existing.reimbursement_id || null,
      existing.receipt_url || null,
      "Reversal",
      messengerId || null
    );
    return res.changes > 0;
  }

  // ─── IDEMPOTENCY RECORD OPERATIONS ──────────────────────────────────────────

  public getIdempotencyRecord(key: string, scope = "PAYMENT_SUBMISSION"): {
    key: string;
    scope: string;
    user_id?: string | null;
    request_hash: string;
    resource_id: string | null;
    response_json: string;
    created_at: string;
  } | undefined {
    const cleanKey = (key || "").trim();
    if (!cleanKey) return undefined;

    const scopedKey = formatScopedIdempotencyKey(scope, cleanKey);

    // 1. Primary Lookup: Look for new scoped key (${scope}::${clientKey})
    const stmtScoped = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?");
    const recordScoped = stmtScoped.get(scopedKey) as any;
    if (recordScoped) return recordScoped;

    // 2. Dual-Read Fallback: Look for legacy unprefixed key matching this exact scope
    const stmtLegacy = db.prepare("SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?");
    const recordLegacy = stmtLegacy.get(cleanKey, scope) as any;
    if (recordLegacy) return recordLegacy;

    // 3. Fallback for legacy scope alias: 'payment' -> 'PAYMENT_SUBMISSION'
    if (scope === "PAYMENT_SUBMISSION") {
      const recordLegacyAlias = stmtLegacy.get(cleanKey, "payment") as any;
      if (recordLegacyAlias) return recordLegacyAlias;
    }

    return undefined;
  }

  public saveIdempotencyRecord(data: {
    key: string;
    scope: string;
    user_id?: string | null;
    request_hash: string;
    resource_id?: string | null;
    response_json: string;
  }): void {
    const stmt = db.prepare(`
      INSERT INTO idempotency_keys (key, scope, user_id, request_hash, resource_id, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(data.key, data.scope, data.user_id || null, data.request_hash, data.resource_id || null, data.response_json);
  }

  /**
   * Read-only integrity & reconciliation audit across orders, finance_invoices, and invoice_payments.
   * Zero database writes. Used for diagnostics, audit reports, and regression assertions.
   */
  public getOrderInvoiceReconciliationReport(): {
    missingInvoicesForOrders: Array<{ orderNo: string; orderInvoiceNo: string | null }>;
    orderInvoiceMismatches: Array<{ orderNo: string; orderInvoiceNo: string; invoiceOrderNo: string }>;
    totalAmountMismatches: Array<{ orderNo: string; invoiceNo: string; orderTotal: number; invoiceTotal: number }>;
    cancelledStatusMismatches: Array<{ orderNo: string; invoiceNo: string; invoiceStatus: string }>;
    understatedCogsInvoices: Array<{ orderNo: string; invoiceNo: string; biayaSamsat: number; pkbSwdklljSum: number }>;
    verifiedPaymentsMissingKasKantor: Array<{ paymentId: number; orderNo: string; invoiceNo: string; nominal: number }>;
    duplicatePendingPayments: Array<{ orderNo: string; invoiceNo: string; nominal: number; count: number }>;
  } {
    const orders = db.prepare("SELECT order_no, total_biaya, current_stage_name, payment_status, data_json FROM orders").all() as any[];
    const invoices = db.prepare("SELECT id, invoice_no, order_no, status, total_tagihan, biaya_samsat, data_json FROM finance_invoices").all() as any[];
    const payments = db.prepare("SELECT id, order_no, invoice_no, nominal, status_verifikasi, kas_kantor_id, is_void FROM invoice_payments").all() as any[];

    const invByOrder = new Map<string, any>();
    const invByNo = new Map<string, any>();
    for (const inv of invoices) {
      if (inv.order_no) invByOrder.set(String(inv.order_no).trim().toUpperCase(), inv);
      if (inv.invoice_no) invByNo.set(String(inv.invoice_no).trim().toUpperCase(), inv);
    }

    const missingInvoicesForOrders: Array<{ orderNo: string; orderInvoiceNo: string | null }> = [];
    const orderInvoiceMismatches: Array<{ orderNo: string; orderInvoiceNo: string; invoiceOrderNo: string }> = [];
    const totalAmountMismatches: Array<{ orderNo: string; invoiceNo: string; orderTotal: number; invoiceTotal: number }> = [];
    const cancelledStatusMismatches: Array<{ orderNo: string; invoiceNo: string; invoiceStatus: string }> = [];
    const understatedCogsInvoices: Array<{ orderNo: string; invoiceNo: string; biayaSamsat: number; pkbSwdklljSum: number }> = [];

    for (const o of orders) {
      const oKey = String(o.order_no || "").trim().toUpperCase();
      let parsedOrder: any = {};
      try { parsedOrder = o.data_json ? JSON.parse(o.data_json) : {}; } catch {}
      const orderInvNo = parsedOrder.noInvoice || parsedOrder.payment?.invoiceNo || null;
      const linkedInv = invByOrder.get(oKey);

      if (!linkedInv) {
        missingInvoicesForOrders.push({ orderNo: o.order_no, orderInvoiceNo: orderInvNo });
      }
      if (orderInvNo) {
        const invWithNo = invByNo.get(String(orderInvNo).trim().toUpperCase());
        if (invWithNo && String(invWithNo.order_no || "").trim().toUpperCase() !== oKey) {
          orderInvoiceMismatches.push({
            orderNo: o.order_no,
            orderInvoiceNo: String(orderInvNo),
            invoiceOrderNo: String(invWithNo.order_no),
          });
        }
      }
      if (linkedInv) {
        const orderTotal = Number(o.total_biaya || parsedOrder.payment?.totalBiaya || 0);
        const invoiceTotal = Number(linkedInv.total_tagihan || 0);
        if (Math.abs(orderTotal - invoiceTotal) > 0) {
          totalAmountMismatches.push({
            orderNo: o.order_no,
            invoiceNo: linkedInv.invoice_no,
            orderTotal,
            invoiceTotal,
          });
        }

        const isOrdCancelled =
          o.current_stage_name === "Dibatalkan" ||
          o.payment_status === "Dibatalkan" ||
          Boolean(parsedOrder.isCancelled);
        if (isOrdCancelled && String(linkedInv.status || "").toUpperCase() !== "CANCELLED") {
          cancelledStatusMismatches.push({
            orderNo: o.order_no,
            invoiceNo: linkedInv.invoice_no,
            invoiceStatus: String(linkedInv.status || ""),
          });
        }

        const canonicalCogs = resolveCanonicalSamsatCogs(parsedOrder);
        const taxSum = Math.max(
          canonicalCogs.biayaSamsat,
          Number(parsedOrder.pkb || 0) +
            Number(parsedOrder.swdkllj || 0) +
            Number(parsedOrder.dendaSwdkllj || 0)
        );
        const biayaSamsat = Number(linkedInv.biaya_samsat || 0);
        if (taxSum > biayaSamsat) {
          understatedCogsInvoices.push({
            orderNo: o.order_no,
            invoiceNo: linkedInv.invoice_no,
            biayaSamsat,
            pkbSwdklljSum: taxSum,
          });
        }
      }
    }

    const verifiedPaymentsMissingKasKantor: Array<{ paymentId: number; orderNo: string; invoiceNo: string; nominal: number }> = [];
    const pendingBuckets = new Map<string, number>();

    for (const p of payments) {
      if (Number(p.is_void) === 1) continue;
      const st = String(p.status_verifikasi || "").toUpperCase();
      if (st === "TERVERIFIKASI" && !p.kas_kantor_id) {
        verifiedPaymentsMissingKasKantor.push({
          paymentId: Number(p.id),
          orderNo: String(p.order_no || ""),
          invoiceNo: String(p.invoice_no || ""),
          nominal: Number(p.nominal || 0),
        });
      }
      if (st === "MENUNGGU_BUKTI" || st === "MENUNGGU_VERIFIKASI") {
        const bKey = `${String(p.order_no || "").toUpperCase()}|${String(p.invoice_no || "").toUpperCase()}|${Number(p.nominal || 0)}`;
        pendingBuckets.set(bKey, (pendingBuckets.get(bKey) || 0) + 1);
      }
    }

    const duplicatePendingPayments: Array<{ orderNo: string; invoiceNo: string; nominal: number; count: number }> = [];
    for (const [bKey, count] of pendingBuckets.entries()) {
      if (count > 1) {
        const [orderNo, invoiceNo, nominalStr] = bKey.split("|");
        duplicatePendingPayments.push({ orderNo, invoiceNo, nominal: Number(nominalStr), count });
      }
    }

    return {
      missingInvoicesForOrders,
      orderInvoiceMismatches,
      totalAmountMismatches,
      cancelledStatusMismatches,
      understatedCogsInvoices,
      verifiedPaymentsMissingKasKantor,
      duplicatePendingPayments,
    };
  }

  public getCashLedgerReconciliation(targetDb?: DatabaseSync) {
    const activeDb = targetDb ?? getDb();

    // 1. Kas Kantor chronological ledger & running balance verification
    const kkRows = activeDb.prepare(`
      SELECT id, tanggal, status, debit, kredit, saldo, kategori, keterangan
      FROM kas_kantor
      ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC
    `).all() as any[];

    let kkOpeningCapital = 0;
    let kkExternalInflows = 0;
    let kkInternalTransfersIn = 0;
    let kkReversalsIn = 0;
    let kkOutflows = 0;
    let kkInternalTransfersOut = 0;
    let kkRunningExpected = 0;
    let kkDriftCount = 0;

    for (const r of kkRows) {
      const d = Number(r.debit || 0);
      const k = Number(r.kredit || 0);
      const kat = String(r.kategori || "").toUpperCase();
      const ket = String(r.keterangan || "").toUpperCase();

      if (kat === "MODAL_AWAL") {
        kkOpeningCapital += d - k;
      } else if (kat.includes("INTERNAL_TRANSFER") || ket.includes("TRANSFER ANTAR KAS")) {
        kkInternalTransfersIn += d;
        kkInternalTransfersOut += k;
      } else if (ket.includes("[VOID") || ket.includes("[BATAL") || kat.includes("REVERSAL")) {
        kkReversalsIn += d;
        kkOutflows += k;
      } else {
        kkExternalInflows += d;
        kkOutflows += k;
      }

      kkRunningExpected += d - k;
      if (Math.abs(kkRunningExpected - Number(r.saldo || 0)) > 0.01) {
        kkDriftCount++;
      }
    }

    const kkStoredClosing = kkRows.length > 0 ? Number(kkRows[kkRows.length - 1].saldo || 0) : 0;

    // 2. Kas Messenger chronological ledger & per-courier reconciliation
    const kmRows = activeDb.prepare(`
      SELECT id, tanggal, jenis, messenger, messenger_id, debit, kredit, total, kategori, keterangan, reimbursement_id
      FROM kas_messenger
      ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC
    `).all() as any[];

    const perCourierMap = new Map<string, {
      messengerKey: string;
      messengerId: string | null;
      messengerName: string;
      openingCapital: number;
      inflows: number;
      reversalsIn: number;
      internalTransfersIn: number;
      outflows: number;
      internalTransfersOut: number;
      expectedClosing: number;
      storedClosing: number;
      driftCount: number;
    }>();

    for (const r of kmRows) {
      const key = r.messenger_id || r.messenger || "UNASSIGNED";
      if (!perCourierMap.has(key)) {
        perCourierMap.set(key, {
          messengerKey: key,
          messengerId: r.messenger_id || null,
          messengerName: r.messenger || key,
          openingCapital: 0,
          inflows: 0,
          reversalsIn: 0,
          internalTransfersIn: 0,
          outflows: 0,
          internalTransfersOut: 0,
          expectedClosing: 0,
          storedClosing: 0,
          driftCount: 0,
        });
      }
      const bucket = perCourierMap.get(key)!;
      const d = Number(r.debit || 0);
      const k = Number(r.kredit || 0);
      const kat = String(r.kategori || "").toUpperCase();
      const ket = String(r.keterangan || "").toUpperCase();

      if (kat === "MODAL_AWAL") {
        bucket.openingCapital += d - k;
      } else if (kat.includes("INTERNAL_TRANSFER") || ket.includes("TRANSFER ANTAR KAS")) {
        bucket.internalTransfersIn += d;
        bucket.internalTransfersOut += k;
      } else if (ket.includes("[VOID") || ket.includes("[BATAL") || kat.includes("REVERSAL")) {
        bucket.reversalsIn += d;
        bucket.outflows += k;
      } else {
        bucket.inflows += d;
        bucket.outflows += k;
      }

      bucket.expectedClosing += d - k;
      bucket.storedClosing = Number(r.total || 0);
      if (Math.abs(bucket.expectedClosing - bucket.storedClosing) > 0.01) {
        bucket.driftCount++;
      }
    }

    const byMessenger = Array.from(perCourierMap.values());
    const kmExpectedTotal = byMessenger.reduce((s, m) => s + m.expectedClosing, 0);
    const kmStoredTotal = byMessenger.reduce((s, m) => s + m.storedClosing, 0);
    const kmDriftCount = byMessenger.reduce((s, m) => s + m.driftCount, 0);

    // 3. Reimbursement cross-ledger parity check
    const paidReimbs = activeDb.prepare(`
      SELECT id, amount, approved_amount, kas_messenger_id
      FROM messenger_reimbursements
      WHERE status = 'Dibayar'
    `).all() as any[];

    let totalPaidReimbursements = 0;
    const orphanReimbLinks: Array<{ reimbursementId: string; kasMessengerId: number | null }> = [];
    for (const pr of paidReimbs) {
      const amt = Number(pr.approved_amount || pr.amount || 0);
      totalPaidReimbursements += amt;
      if (pr.kas_messenger_id) {
        const kmHit = activeDb.prepare("SELECT id FROM kas_messenger WHERE id = ?").get(pr.kas_messenger_id);
        if (!kmHit) {
          orphanReimbLinks.push({ reimbursementId: pr.id, kasMessengerId: pr.kas_messenger_id });
        }
      }
    }

    const netKmReimbRow = activeDb.prepare(`
      SELECT COALESCE(SUM(kredit), 0) - COALESCE(SUM(debit), 0) as netDisbursed
      FROM kas_messenger
      WHERE reimbursement_id IS NOT NULL
    `).get() as { netDisbursed: number } | undefined;

    const kkReimbReversalsRow = activeDb.prepare(`
      SELECT COUNT(*) as count
      FROM kas_kantor
      WHERE kategori = 'Reimbursement Reversal' OR keterangan LIKE '%Reversal Pencairan Reimbursement%'
    `).get() as { count: number } | undefined;

    const netKmDisbursed = Number(netKmReimbRow?.netDisbursed || 0);

    return {
      kasKantor: {
        rowCount: kkRows.length,
        openingCapital: kkOpeningCapital,
        externalInflows: kkExternalInflows,
        reversalsIn: kkReversalsIn,
        internalTransfersIn: kkInternalTransfersIn,
        outflows: kkOutflows,
        internalTransfersOut: kkInternalTransfersOut,
        expectedClosingBalance: kkRunningExpected,
        storedClosingBalance: kkStoredClosing,
        runningBalanceDriftCount: kkDriftCount,
        reconciled: Math.abs(kkRunningExpected - kkStoredClosing) <= 0.01 && kkDriftCount === 0,
      },
      kasMessenger: {
        rowCount: kmRows.length,
        expectedClosingBalance: kmExpectedTotal,
        storedClosingBalance: kmStoredTotal,
        runningBalanceDriftCount: kmDriftCount,
        byMessenger,
        reconciled: Math.abs(kmExpectedTotal - kmStoredTotal) <= 0.01 && kmDriftCount === 0,
      },
      reimbursements: {
        paidCount: paidReimbs.length,
        totalPaidReimbursements,
        netKasMessengerDisbursed: netKmDisbursed,
        discrepancy: totalPaidReimbursements - netKmDisbursed,
        orphanLinks: orphanReimbLinks,
        crossLedgerKasKantorReversalsCount: Number(kkReimbReversalsRow?.count || 0),
        reconciled:
          Math.abs(totalPaidReimbursements - netKmDisbursed) <= 0.01 &&
          orphanReimbLinks.length === 0,
      },
    };
  }
}

export const dbFinanceRepository = new DbFinanceRepository();
