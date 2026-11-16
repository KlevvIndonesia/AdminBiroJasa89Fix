/**
 * Real API Finance Data Provider
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Implements IFinanceDataProvider connecting to the Express REST API.
 * Keeps an in-memory cache synchronized with the backend (/api/finance)
 * and handles optimistic updates with deterministic rollback on failure.
 */

import {
  InvoiceBillingRecord,
  ProfitItem,
  KasKantorItem,
  KasMessengerItem,
  PengeluaranItem,
} from "../../domain/finance/types";
import { IFinanceDataProvider } from "../../domain/finance/types";
import {
  isCashPaymentString,
  formatUnlinkedPaymentMethodLabel,
} from "../../domain/finance/paymentMethodCanonical";
import { isFullyPaid, toFinancePaymentStatus, toCanonicalPaymentStatus } from "../../domain/finance/paymentMapping";
import { APP_CONFIG } from "../../app/config/appConfig";
import { permissionStore, SessionAuthStatus } from "../../app/data/permissionStore";
import {
  ActionApiError,
  fetchWithTimeout,
  parseApiErrorResponse,
  sanitizeActionMessage,
} from "../../app/utils/actionErrorClassifier";

interface ConfirmedLedgerEntry<T> {
  entry: T;
  committedAtEpoch: number;
}

export class ApiFinanceProvider implements IFinanceDataProvider {
  private baseUrl: string;
  private invoices: InvoiceBillingRecord[] = [];
  private kasKantor: KasKantorItem[] = [];
  private kasMessenger: KasMessengerItem[] = [];
  private pengeluaran: PengeluaranItem[] = [];
  private profitData: ProfitItem[] = [];
  private hasAuthoritativeProfit = false;
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private isLoadingState = false;
  private lastError: Error | null = null;
  private profitError: Error | null = null;
  private nextOptimisticId = -1;

  // Concurrency guards so background GET refreshes and concurrent POSTs cannot drop, duplicate, or clobber committed records
  private kasKantorEpoch = 0;
  private latestAppliedKasKantorEpoch = 0;
  private pendingKasKantor = new Map<number, KasKantorItem>();
  private confirmedKasKantor = new Map<number, ConfirmedLedgerEntry<KasKantorItem>>();

  private kasMessengerEpoch = 0;
  private latestAppliedKasMessengerEpoch = 0;
  private pendingKasMessenger = new Map<number, KasMessengerItem>();
  private confirmedKasMessenger = new Map<number, ConfirmedLedgerEntry<KasMessengerItem>>();

  private authStatus: SessionAuthStatus = "unauthenticated";
  private pendingHydrationFetch = false;
  private activeFetchPromise: Promise<void> | null = null;
  private activeAbortController: AbortController | null = null;
  private inFlightAuthKey: string | null = null;
  private lastFetchedAuthKey: string | null = null;
  private authGeneration = 0;
  private permissionUnsubscribe: (() => void) | null = null;
  private isDestroyed = false;

  constructor(baseUrl = APP_CONFIG.apiBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.permissionUnsubscribe = permissionStore.subscribe(() => {
      this.handlePermissionStateChange();
    });

    const initialStatus = this.resolveProviderAuthStatus();
    this.authStatus = initialStatus;

    if (typeof window === "undefined") {
      this.initFromApi();
    } else if (
      initialStatus === "hydrating" ||
      (!permissionStore.hasInitializedFromApi() && !permissionStore.hasExplicitSessionHydration())
    ) {
      this.authStatus = "hydrating";
      this.pendingHydrationFetch = true;
      this.isInitialized = false;
    } else if (initialStatus === "forbidden") {
      this.isInitialized = true;
    } else if (initialStatus === "authenticated") {
      this.initFromApi();
    }
  }

  private getFinanceEndpointFlags() {
    return {
      canFetchInvoices: permissionStore.canAccessApiEndpoint("finance-invoices"),
      canFetchProfit: permissionStore.canAccessApiEndpoint("finance-profit"),
      canFetchKasKantor: permissionStore.canAccessApiEndpoint("finance-kas-kantor"),
      canFetchPengeluaran: permissionStore.canAccessApiEndpoint("finance-pengeluaran"),
      canFetchKasMessenger: permissionStore.canAccessApiEndpoint("finance-kas-messenger"),
    };
  }

  private resolveProviderAuthStatus(): SessionAuthStatus {
    const baseStatus = permissionStore.getSessionAuthStatus();
    if (baseStatus === "unauthenticated" || baseStatus === "hydrating" || baseStatus === "forbidden") {
      return baseStatus;
    }
    const flags = this.getFinanceEndpointFlags();
    if (
      !flags.canFetchInvoices &&
      !flags.canFetchProfit &&
      !flags.canFetchKasKantor &&
      !flags.canFetchPengeluaran &&
      !flags.canFetchKasMessenger
    ) {
      return "forbidden";
    }
    return "authenticated";
  }

  private buildAuthStateKey(): string {
    const token = this.getAuthHeader().Authorization || "";
    const role = permissionStore.getSessionRole() || "";
    const flags = this.getFinanceEndpointFlags();
    const mask = `${Number(flags.canFetchInvoices)}${Number(flags.canFetchKasKantor)}${Number(flags.canFetchPengeluaran)}${Number(flags.canFetchKasMessenger)}`;
    return `${token}::${role}::${mask}`;
  }

  public getAuthStatus(): SessionAuthStatus {
    this.authStatus = this.resolveProviderAuthStatus();
    return this.authStatus;
  }

  public hasPendingHydrationFetch(): boolean {
    return this.pendingHydrationFetch;
  }

  public clearSessionData(): void {
    this.invoices = [];
    this.kasKantor = [];
    this.kasMessenger = [];
    this.pengeluaran = [];
    this.profitData = [];
    this.hasAuthoritativeProfit = false;
    this.pendingKasKantor.clear();
    this.confirmedKasKantor.clear();
    this.pendingKasMessenger.clear();
    this.confirmedKasMessenger.clear();
    this.kasKantorEpoch++;
    this.kasMessengerEpoch++;
    this.authGeneration++;
    this.abortInFlightFetch();
    this.activeFetchPromise = null;
    this.inFlightAuthKey = null;
    this.lastFetchedAuthKey = null;
    this.isInitialized = false;
    this.isLoadingState = false;
    this.lastError = null;
    this.profitError = null;
  }

  private abortInFlightFetch(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.permissionUnsubscribe) {
      this.permissionUnsubscribe();
      this.permissionUnsubscribe = null;
    }
    this.clearSessionData();
    this.listeners.clear();
  }

  private handlePermissionStateChange(): void {
    if (this.isDestroyed) return;

    const prevStatus = this.authStatus;
    const nextStatus = this.resolveProviderAuthStatus();
    const nextAuthKey = this.buildAuthStateKey();

    if (nextStatus === "unauthenticated") {
      this.clearSessionData();
      this.authStatus = "unauthenticated";
      this.pendingHydrationFetch = false;
      this.notify();
      return;
    }

    if (nextStatus === "hydrating") {
      if (prevStatus === "authenticated") {
        this.clearSessionData();
      }
      this.authStatus = "hydrating";
      this.pendingHydrationFetch = true;
      this.isInitialized = false;
      this.isLoadingState = false;
      this.notify();
      return;
    }

    if (nextStatus === "forbidden") {
      this.clearSessionData();
      this.authStatus = "forbidden";
      this.pendingHydrationFetch = false;
      this.isInitialized = true;
      this.isLoadingState = false;
      this.lastFetchedAuthKey = nextAuthKey;
      this.notify();
      return;
    }

    // Authenticated with at least one finance endpoint permitted:
    // prune any sub-resources whose permissions were dynamically revoked.
    const flags = this.getFinanceEndpointFlags();
    if (!flags.canFetchInvoices) {
      this.invoices = [];
      this.profitData = [];
    }
    if (!flags.canFetchKasKantor) {
      this.kasKantor = [];
      this.pendingKasKantor.clear();
      this.confirmedKasKantor.clear();
    }
    if (!flags.canFetchPengeluaran) {
      this.pengeluaran = [];
    }
    if (!flags.canFetchKasMessenger) {
      this.kasMessenger = [];
      this.pendingKasMessenger.clear();
      this.confirmedKasMessenger.clear();
    }

    this.authStatus = "authenticated";
    if (
      this.pendingHydrationFetch ||
      (this.lastFetchedAuthKey !== null && this.lastFetchedAuthKey !== nextAuthKey)
    ) {
      this.authGeneration++;
      this.abortInFlightFetch();
      void this.initFromApi();
    } else {
      this.notify();
    }
  }

  private getAuthHeader(): Record<string, string> {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const token = window.localStorage.getItem("auth_token");
        if (token) {
          return { Authorization: `Bearer ${token}` };
        }
      }
      if (typeof process !== "undefined" && process.env?.AUTH_TOKEN) {
        return { Authorization: `Bearer ${process.env.AUTH_TOKEN}` };
      }
    } catch {
      // ignore in non-browser env
    }
    return {};
  }

  private normalizeInvoice(inv: any): InvoiceBillingRecord {
    const totalTagihan = Number(inv.totalTagihan ?? inv.total_tagihan ?? 0);
    const dibayar = Number(inv.dibayar ?? inv.terbayar ?? 0);
    const sisa = inv.sisa !== undefined ? Number(inv.sisa) : Math.max(0, totalTagihan - dibayar);
    const canonicalStatus = toCanonicalPaymentStatus(inv.status, totalTagihan, dibayar);
    const financeStatus = toFinancePaymentStatus(canonicalStatus);

    return {
      id: Number(inv.id),
      invoiceNo: inv.invoiceNo || inv.invoice_no || inv.invoice || `INV-${inv.id}`,
      orderNo: inv.orderNo || inv.order_no,
      customer: inv.customer || "Pelanggan",
      layanan: inv.layanan || inv.jenisLayanan || "Layanan Samsat",
      jenisLayanan: inv.jenisLayanan || inv.layanan || "Layanan Samsat",
      nopol: inv.nopol || "-",
      totalTagihan,
      terbayar: dibayar,
      dibayar,
      sisa,
      status: financeStatus,
      tanggal: inv.tanggal || inv.tanggalInvoice || inv.createdAt || new Date().toLocaleDateString("id-ID"),
      jatuhTempo: inv.jatuhTempo || "2026-10-15",
      invoice: inv.invoice || inv.invoiceNo || `INV-${inv.id}`,
      phone: inv.phone || inv.nomorHp,
      email: inv.email,
      alamat: inv.alamat,
      biayaSamsat: inv.biayaSamsat !== undefined ? Number(inv.biayaSamsat) : (inv.biaya_samsat !== undefined ? Number(inv.biaya_samsat) : 0),
      profit: inv.profit !== undefined ? Number(inv.profit) : (inv.profit_final !== undefined ? Number(inv.profit_final) : 0),
      profitStatus: inv.profitStatus || inv.profit_status || (isFullyPaid(financeStatus) && (inv.isCompleted || inv.billingStatus === "COMPLETED") ? "REALIZED" : "PENDING"),
      cashback: inv.cashback !== undefined ? Number(inv.cashback) : (inv.cashback_nominal !== undefined ? Number(inv.cashback_nominal) : 0),
      cashbackStatus: inv.cashbackStatus || inv.cashback_status || (isFullyPaid(financeStatus) && (inv.isCompleted || inv.refundStatus === "PROCESSED") ? "REALIZED" : "PENDING"),
      isCashRealized: dibayar > 0,
      cashRecordedAmount: dibayar,
      metodePembayaran: inv.metodePembayaran || (dibayar > 0 ? "Transfer Bank" : "Tempo"),
      bank: inv.bank || (inv as any).namaBank || "",
      billingStatus: inv.billingStatus || (isFullyPaid(financeStatus) && inv.isCompleted ? "COMPLETED" : "ACTIVE"),
      settlementCondition: inv.settlementCondition || inv.settlement_condition || (isFullyPaid(financeStatus) ? "BALANCED" : "UNDERPAID"),
      refundStatus: inv.refundStatus || inv.refund_status || "NONE",
      overpayment: inv.overpayment !== undefined ? Number(inv.overpayment) : 0,
      ...(Array.isArray(inv.payoutHistory) ? { payoutHistory: inv.payoutHistory } : {}),
      ...(inv.payoutVersion !== undefined ? { payoutVersion: Number(inv.payoutVersion) } : {}),
      ...(inv.refundLiability !== undefined ? { refundLiability: Number(inv.refundLiability) } : {}),
      ...(inv.refundedAmount !== undefined ? { refundedAmount: Number(inv.refundedAmount) } : {}),
      ...(inv.remainingRefund !== undefined ? { remainingRefund: Number(inv.remainingRefund) } : {}),
      ...(inv.cashbackPaidAmount !== undefined ? { cashbackPaidAmount: Number(inv.cashbackPaidAmount) } : {}),
      ...(inv.cashbackPaidAt ? { cashbackPaidAt: inv.cashbackPaidAt } : {}),
      ...(inv.cashbackPaidBy ? { cashbackPaidBy: inv.cashbackPaidBy } : {}),
      ...(inv.cashbackCompletionStatus || inv.cashback_completion_status
        ? { cashbackCompletionStatus: inv.cashbackCompletionStatus || inv.cashback_completion_status }
        : {}),
      ...(inv.cashbackCompletedAt || inv.cashback_completed_at
        ? { cashbackCompletedAt: inv.cashbackCompletedAt || inv.cashback_completed_at }
        : {}),
      ...(inv.cashbackCompletedBy || inv.cashback_completed_by
        ? { cashbackCompletedBy: inv.cashbackCompletedBy || inv.cashback_completed_by }
        : {}),
      ...(inv.cashbackCompletionNotes ? { cashbackCompletionNotes: inv.cashbackCompletionNotes } : {}),
      ...(inv.refundProcessedAt ? { refundProcessedAt: inv.refundProcessedAt } : {}),
      ...(inv.refundProcessedBy ? { refundProcessedBy: inv.refundProcessedBy } : {}),
      ...(inv.completedAt ? { completedAt: inv.completedAt } : {}),
      ...(inv.completedBy ? { completedBy: inv.completedBy } : {}),
      ...(inv.tanggalBayar ? { tanggalBayar: inv.tanggalBayar } : {}),
      ...(inv.alasanPending || inv.alasan_pending ? { alasanPending: inv.alasanPending || inv.alasan_pending } : {}),
    };
  }

  public async initFromApi(): Promise<void> {
    if (this.isDestroyed) return;

    const status = this.resolveProviderAuthStatus();
    this.authStatus = status;
    const authHeaders = this.getAuthHeader();

    if (typeof window !== "undefined" && (status === "unauthenticated" || !authHeaders.Authorization)) {
      this.clearSessionData();
      this.pendingHydrationFetch = false;
      this.notify();
      return;
    }

    if (!authHeaders.Authorization) {
      this.isLoadingState = false;
      return;
    }

    if (status === "hydrating") {
      // Fail-closed: token exists before role hydration completes.
      // Defer initial fetch until permissionStore hydrates a valid role.
      this.pendingHydrationFetch = true;
      this.isInitialized = false;
      this.isLoadingState = false;
      this.lastError = null;
      this.profitError = null;
      this.notify();
      return;
    }

    const flags = this.getFinanceEndpointFlags();
    const canFetchInvoices = flags.canFetchInvoices;
    const canFetchProfit = flags.canFetchProfit;
    const canFetchKasKantor = flags.canFetchKasKantor;
    const canFetchPengeluaran = flags.canFetchPengeluaran;
    const canFetchKasMessenger = flags.canFetchKasMessenger;

    if (!canFetchInvoices && !canFetchProfit && !canFetchKasKantor && !canFetchPengeluaran && !canFetchKasMessenger) {
      this.clearSessionData();
      this.authStatus = "forbidden";
      this.pendingHydrationFetch = false;
      this.isLoadingState = false;
      this.lastError = null;
      this.profitError = null;
      this.isInitialized = true;
      this.lastFetchedAuthKey = this.buildAuthStateKey();
      this.notify();
      return;
    }

    const capturedAuthKey = this.buildAuthStateKey();
    if (this.activeFetchPromise && this.inFlightAuthKey === capturedAuthKey) {
      return this.activeFetchPromise;
    }

    const capturedGeneration = this.authGeneration;
    this.abortInFlightFetch();
    const abortController = typeof AbortController !== "undefined" ? new AbortController() : null;
    this.activeAbortController = abortController;
    this.pendingHydrationFetch = false;
    this.isLoadingState = true;
    this.lastError = null;
    this.profitError = null;
    this.inFlightAuthKey = capturedAuthKey;
    const kasFetchEpoch = ++this.kasKantorEpoch;
    const messengerFetchEpoch = ++this.kasMessengerEpoch;

    const isStillValidForEndpoint = (
      endpoint:
        | "finance-invoices"
        | "finance-profit"
        | "finance-kas-kantor"
        | "finance-pengeluaran"
        | "finance-kas-messenger"
    ) =>
      !this.isDestroyed &&
      capturedGeneration === this.authGeneration &&
      Boolean(this.getAuthHeader().Authorization) &&
      permissionStore.canAccessApiEndpoint(endpoint);

    const fetchSignalOpt = abortController ? { signal: abortController.signal } : {};
    let fetchPromise: Promise<void> | null = null;

    const runFetch = async () => {
      try {
        if (canFetchInvoices && isStillValidForEndpoint("finance-invoices")) {
          const invRes = await fetch(`${this.baseUrl}/finance/invoices`, {
            headers: { "Content-Type": "application/json", ...authHeaders },
            ...fetchSignalOpt,
          });
          if (!isStillValidForEndpoint("finance-invoices")) return;
          if (!invRes.ok) {
            if (invRes.status === 401 && typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("sun89_auth_unauthorized"));
            }
            throw new Error(`Gagal memuat invoice dari server (HTTP ${invRes.status})`);
          }
          const payload = await invRes.json();
          if (isStillValidForEndpoint("finance-invoices") && payload.success && Array.isArray(payload.data)) {
            this.invoices = payload.data.map((inv: any) => this.normalizeInvoice(inv));
            this.deriveProfitFromInvoices();
          }
        }

        if (canFetchProfit && isStillValidForEndpoint("finance-profit")) {
          try {
            const profitRes = await fetch(`${this.baseUrl}/finance/profit`, {
              headers: { "Content-Type": "application/json", ...authHeaders },
              ...fetchSignalOpt,
            });
            if (!isStillValidForEndpoint("finance-profit")) return;
            if (!profitRes.ok) {
              if (profitRes.status === 401 && typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("sun89_auth_unauthorized"));
              }
              const errBody = await profitRes.json().catch(() => null);
              const errMsg =
                errBody?.error?.message ||
                errBody?.message ||
                `Gagal memuat data profit dari server (HTTP ${profitRes.status})`;
              throw new Error(errMsg);
            }
            const profitPayload = await profitRes.json();
            if (isStillValidForEndpoint("finance-profit")) {
              if (profitPayload?.success && Array.isArray(profitPayload.data)) {
                this.profitData = profitPayload.data;
                this.hasAuthoritativeProfit = true;
                this.profitError = null;
              } else {
                throw new Error(
                  profitPayload?.error?.message ||
                    profitPayload?.message ||
                    "Respons data profit dari server tidak valid."
                );
              }
            }
          } catch (profitErr: any) {
            if (profitErr?.name !== "AbortError" && isStillValidForEndpoint("finance-profit")) {
              const err =
                profitErr instanceof Error
                  ? profitErr
                  : new Error(String(profitErr || "Gagal memuat data profit."));
              this.profitError = err;
              this.lastError = err;
              this.hasAuthoritativeProfit = false;
              this.profitData = [];
            }
          }
        }

        if (canFetchKasKantor && isStillValidForEndpoint("finance-kas-kantor")) {
          const kasRes = await fetch(`${this.baseUrl}/finance/kas-kantor`, {
            headers: { "Content-Type": "application/json", ...authHeaders },
            ...fetchSignalOpt,
          });
          if (isStillValidForEndpoint("finance-kas-kantor") && kasRes.ok && kasFetchEpoch >= this.latestAppliedKasKantorEpoch) {
            const kasPayload = await kasRes.json();
            if (isStillValidForEndpoint("finance-kas-kantor") && kasPayload.success && Array.isArray(kasPayload.data)) {
              this.latestAppliedKasKantorEpoch = kasFetchEpoch;
              const serverKasRows: KasKantorItem[] = kasPayload.data.map((k: any) => ({
                id: Number(k.id),
                tanggal: k.tanggal,
                keterangan: k.keterangan,
                status: k.status,
                debit: Number(k.debit || 0),
                kredit: Number(k.kredit || 0),
                total: Number(k.total ?? k.saldo ?? 0),
                saldo: Number(k.saldo ?? k.total ?? 0),
                penanggungJawab: k.penanggungJawab || k.penanggung_jawab || undefined,
                orderNo: k.orderNo || k.order_no || undefined,
                invoiceNo: k.invoiceNo || k.invoice_no || undefined,
                kategori: k.kategori || undefined,
                paymentMethodId: k.paymentMethodId || k.payment_method_id || undefined,
                paymentMethodSnapshot: k.paymentMethodSnapshot || k.payment_method_snapshot || undefined,
                createdAt: k.createdAt || k.created_at || undefined,
              }));
              this.kasKantor = this.mergeLedgerSnapshot(
                serverKasRows,
                kasFetchEpoch,
                this.pendingKasKantor,
                this.confirmedKasKantor
              );
            }
          }
        }

        if (canFetchPengeluaran && isStillValidForEndpoint("finance-pengeluaran")) {
          const pengeluaranRes = await fetch(`${this.baseUrl}/finance/pengeluaran`, {
            headers: { "Content-Type": "application/json", ...authHeaders },
            ...fetchSignalOpt,
          });
          if (isStillValidForEndpoint("finance-pengeluaran") && pengeluaranRes.ok) {
            const pengeluaranPayload = await pengeluaranRes.json();
            if (isStillValidForEndpoint("finance-pengeluaran") && pengeluaranPayload.success && Array.isArray(pengeluaranPayload.data)) {
              this.pengeluaran = pengeluaranPayload.data.map((p: any) => ({
                id: Number(p.id),
                tanggal: p.tanggal,
                keterangan: p.keterangan,
                nominal: Number(p.nominal || 0),
                penanggungJawab: p.penanggungJawab || p.penanggung_jawab || undefined,
              }));
            }
          }
        }

        if (canFetchKasMessenger && isStillValidForEndpoint("finance-kas-messenger")) {
          const messengerRes = await fetch(`${this.baseUrl}/finance/kas-messenger`, {
            headers: { "Content-Type": "application/json", ...authHeaders },
            ...fetchSignalOpt,
          });
          if (isStillValidForEndpoint("finance-kas-messenger") && messengerRes.ok && messengerFetchEpoch >= this.latestAppliedKasMessengerEpoch) {
            const messengerPayload = await messengerRes.json();
            if (isStillValidForEndpoint("finance-kas-messenger") && messengerPayload.success && Array.isArray(messengerPayload.data)) {
              this.latestAppliedKasMessengerEpoch = messengerFetchEpoch;
              const serverMessengerRows: KasMessengerItem[] = messengerPayload.data.map((m: any) => ({
                id: Number(m.id),
                tanggal: m.tanggal,
                jenis: m.jenis,
                messenger: m.messenger,
                keterangan: m.keterangan,
                in: Number(m.in || m.debit || 0),
                out: Number(m.out || m.kredit || 0),
                total: Number(m.total || 0),
                penanggungJawab: m.penanggungJawab || m.penanggung_jawab || undefined,
                orderNo: m.orderNo || m.order_no || undefined,
                reimbursementId: m.reimbursementId || m.reimbursement_id || undefined,
                receiptUrl: m.receiptUrl || m.receipt_url || undefined,
                kategori: m.kategori || undefined,
                messengerId: m.messengerId || m.messenger_id || undefined,
                paymentMethodId: m.paymentMethodId || m.payment_method_id || undefined,
                paymentMethodSnapshot: m.paymentMethodSnapshot || m.payment_method_snapshot || undefined,
                createdAt: m.createdAt || m.created_at || undefined,
              }));
              this.kasMessenger = this.mergeLedgerSnapshot(
                serverMessengerRows,
                messengerFetchEpoch,
                this.pendingKasMessenger,
                this.confirmedKasMessenger
              );
            }
          }
        }

        if (!this.isDestroyed && capturedGeneration === this.authGeneration) {
          this.isInitialized = true;
          this.isLoadingState = false;
          this.lastFetchedAuthKey = capturedAuthKey;
          this.notify();
        }
      } catch (err: any) {
        if (err?.name === "AbortError" || abortController?.signal.aborted) {
          return;
        }
        if (!this.isDestroyed && capturedGeneration === this.authGeneration) {
          this.isLoadingState = false;
          this.lastError = err instanceof Error ? err : new Error(String(err));
          this.notify();
        }
        // In API mode, do NOT silently inject mock fixtures on error!
      } finally {
        if (this.activeAbortController === abortController) {
          this.activeAbortController = null;
        }
        if (this.activeFetchPromise === fetchPromise) {
          this.activeFetchPromise = null;
          this.inFlightAuthKey = null;
        }
      }
    };

    fetchPromise = runFetch();
    this.activeFetchPromise = fetchPromise;
    return fetchPromise;
  }

  private mergeLedgerSnapshot<T extends { id: number }>(
    serverRows: T[],
    fetchEpoch: number,
    pendingMap: Map<number, T>,
    confirmedMap: Map<number, ConfirmedLedgerEntry<T>>
  ): T[] {
    const serverIds = new Set(serverRows.map((row) => Number(row.id)));

    for (const [id, record] of Array.from(confirmedMap.entries())) {
      if (serverIds.has(id) || record.committedAtEpoch < fetchEpoch) {
        confirmedMap.delete(id);
      }
    }

    const merged: T[] = [...pendingMap.values()];
    const seenIds = new Set<number>(merged.map((row) => Number(row.id)));

    for (const { entry } of confirmedMap.values()) {
      const numId = Number(entry.id);
      if (!seenIds.has(numId)) {
        merged.push(entry);
        seenIds.add(numId);
      }
    }

    for (const row of serverRows) {
      const numId = Number(row.id);
      if (!seenIds.has(numId)) {
        merged.push(row);
        seenIds.add(numId);
      }
    }

    return merged;
  }

  private commitOptimisticAddition<T extends { id: number }>(
    list: T[],
    tempId: number,
    confirmedEntry: T,
    currentEpoch: number,
    pendingMap: Map<number, T>,
    confirmedMap: Map<number, ConfirmedLedgerEntry<T>>
  ): T[] {
    pendingMap.delete(tempId);
    const confirmedId = Number(confirmedEntry.id);
    confirmedMap.set(confirmedId, { entry: confirmedEntry, committedAtEpoch: currentEpoch });

    const nextList = list.filter((item) => item.id !== tempId && Number(item.id) !== confirmedId);
    const tempIdx = list.findIndex((item) => item.id === tempId);
    if (tempIdx !== -1 && !list.some((item) => Number(item.id) === confirmedId)) {
      const updated = [...list];
      updated[tempIdx] = confirmedEntry;
      return updated;
    }
    return [confirmedEntry, ...nextList];
  }

  private rollbackOptimisticAddition<T extends { id: number }>(
    list: T[],
    tempId: number,
    pendingMap: Map<number, T>
  ): T[] {
    pendingMap.delete(tempId);
    return list.filter((item) => item.id !== tempId);
  }

  private deriveProfitFromInvoices(forceFromInvoices = false): void {
    if (this.hasAuthoritativeProfit && !forceFromInvoices) {
      return;
    }
    this.profitData = this.invoices
      .filter((inv) => {
        const st = String(inv.status || "").trim().toUpperCase();
        const billingSt = String((inv as any).billingStatus || "").trim().toUpperCase();
        if (st === "CANCELLED" || billingSt === "CANCELLED" || Boolean((inv as any).isCancelled)) {
          return false;
        }
        return isFullyPaid(inv.status) || Number(inv.dibayar || 0) > 0;
      })
      .map((inv, idx) => {
        const totalTagihan = Number(inv.totalTagihan || 0);
        const dibayar = Number(inv.dibayar || 0);
        const eligiblePayment = Math.min(dibayar, totalTagihan);
        const rawBiayaSamsat = Number(inv.biayaSamsat ?? 0);
        const isExplicitZero = Boolean(
          inv.isExplicitZero ||
            (inv as any).isZeroCostPromotion ||
            inv.costClassification === "EXPLICIT_ZERO"
        );
        const isCostPending =
          Boolean((inv as any).isDraftEstimate) ||
          inv.costVerificationStatus === "UNCONFIGURED" ||
          inv.costVerificationStatus === "PENDING_VERIFICATION" ||
          (rawBiayaSamsat === 0 && !isExplicitZero);
        const alpha = totalTagihan > 0 ? rawBiayaSamsat / totalTagihan : 0;
        const matchedCOGS = isCostPending ? 0 : Math.min(rawBiayaSamsat, Math.round(alpha * eligiblePayment));
        const canonicalProfit = isCostPending ? 0 : Math.max(0, eligiblePayment - matchedCOGS);
        const resolvedProfit =
          inv.profit !== undefined && Number.isFinite(Number(inv.profit))
            ? Number(inv.profit)
            : canonicalProfit;
        const rawMethod = String(inv.metodePembayaran || "").trim();
        const isCash = dibayar > 0 && isCashPaymentString(rawMethod);
        const resolvedBank = isCash ? "" : String(inv.bank || (inv as any).namaBank || "").trim();
        const fallbackLabel =
          dibayar > 0
            ? formatUnlinkedPaymentMethodLabel({ metode: rawMethod, namaBank: resolvedBank })
            : "Belum Dibayar";

        return {
          id: idx + 1,
          orderNo: inv.orderNo,
          tanggal: inv.tanggal,
          customer: inv.customer,
          nopol: inv.nopol,
          pengurusan: inv.jenisLayanan,
          uangMasuk: dibayar,
          totalTagihan,
          eligiblePayment,
          biayaSamsat: rawBiayaSamsat,
          matchedCOGS,
          profit: isCostPending ? 0 : resolvedProfit,
          grossProfit: isCostPending ? 0 : resolvedProfit,
          namaBerkas: (inv as any).namaBerkas || inv.customer,
          paymentMethodId: (inv as any).paymentMethodId || null,
          paymentMethodLabel: dibayar > 0 ? fallbackLabel : null,
          verifiedPaymentCount: dibayar > 0 ? 1 : 0,
          rekening: fallbackLabel,
          metodePencairan: dibayar > 0 ? (isCash ? "Cash" : (resolvedBank || rawMethod ? "Transfer Bank" : "-")) : "-",
          metodePembayaran: dibayar > 0 ? fallbackLabel : "-",
          namaBank: resolvedBank,
          nomorRekening: isCash ? "" : String((inv as any).nomorRekening || ""),
          namaPemilikRekening: isCash ? "" : String((inv as any).namaPemilikRekening || ""),
          tanggalTTB: inv.tanggal,
          ttb: "-",
          status: inv.status,
          holdStatus: isCostPending ? "HOLD_COST_PENDING" : "NONE",
          isExplicitZero,
          invoice: inv.invoice || inv.invoiceNo || "-",
        };
      });
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error("ApiFinanceProvider listener error:", err);
      }
    });
  }

  public isLoading(): boolean {
    return this.isLoadingState;
  }

  public getError(): Error | null {
    return this.lastError;
  }

  public getProfitError(): Error | null {
    return this.profitError;
  }

  public getInvoices(): InvoiceBillingRecord[] {
    return this.invoices;
  }

  public getTagihanList(): InvoiceBillingRecord[] {
    return this.invoices.filter((inv) => !isFullyPaid(inv.status) && inv.billingStatus !== "COMPLETED");
  }

  public getCompletedTagihanList(): InvoiceBillingRecord[] {
    return this.invoices.filter((inv) => isFullyPaid(inv.status) || inv.billingStatus === "COMPLETED");
  }

  public getInvoiceById(id: number): InvoiceBillingRecord | undefined {
    return this.invoices.find((inv) => inv.id === id);
  }

  public getInvoiceByOrderNo(orderNo: string): InvoiceBillingRecord | undefined {
    return this.invoices.find((inv) => inv.orderNo === orderNo);
  }

  public getProfitList(): ProfitItem[] {
    return this.profitData;
  }

  public async fetchFilteredProfitList(
    filters?: {
      paymentMethodId?: string;
      startDate?: string;
      endDate?: string;
      category?: string;
    },
    options?: { signal?: AbortSignal }
  ): Promise<ProfitItem[] | null> {
    const authHeaders = this.getAuthHeader();
    const { canFetchProfit } = this.getFinanceEndpointFlags();
    if (!authHeaders.Authorization) {
      throw new Error("Sesi otorisasi tidak tersedia untuk memuat data profit.");
    }
    if (!canFetchProfit) {
      throw new Error("Anda tidak memiliki izin akses untuk memuat data profit.");
    }
    const qs = new URLSearchParams();
    if (filters?.paymentMethodId && filters.paymentMethodId !== "ALL") {
      qs.set("paymentMethodId", filters.paymentMethodId);
    }
    if (filters?.startDate) qs.set("startDate", filters.startDate);
    if (filters?.endDate) qs.set("endDate", filters.endDate);
    if (filters?.category && filters.category !== "ALL") {
      qs.set("category", filters.category);
    }
    const queryStr = qs.toString();
    const url = `${this.baseUrl}/finance/profit${queryStr ? `?${queryStr}` : ""}`;
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...authHeaders },
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) {
      if (res.status === 401 && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("sun89_auth_unauthorized"));
      }
      const errBody = await res.json().catch(() => null);
      const errMsg =
        errBody?.error?.message ||
        errBody?.message ||
        `Gagal memfilter data profit dari server (HTTP ${res.status})`;
      throw new Error(errMsg);
    }
    const payload = await res.json();
    if (payload?.success && Array.isArray(payload.data)) {
      return payload.data as ProfitItem[];
    }
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        "Respons filter profit dari server tidak valid."
    );
  }

  public getKasKantorList(): KasKantorItem[] {
    return this.kasKantor;
  }

  public getKasMessengerList(): KasMessengerItem[] {
    return this.kasMessenger;
  }

  public getPengeluaranList(): PengeluaranItem[] {
    return this.pengeluaran;
  }

  public async recordPayment(idOrInvoice: number | string, paymentAmount: number, details?: any): Promise<boolean> {
    if (paymentAmount <= 0) return false;

    const idx = this.invoices.findIndex(
      (inv) => inv.id === idOrInvoice || inv.invoiceNo === String(idOrInvoice) || (inv as any).invoice === String(idOrInvoice)
    );
    if (idx === -1) return false;

    const record = this.invoices[idx];

    // Stable idempotency key: reuse existing key if provided (e.g. on client retry) or generate once
    const idempotencyKey = details?.idempotencyKey || `idem-${record.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const effectiveDetails = {
      ...details,
      idempotencyKey,
    };

    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/invoices/${encodeURIComponent(record.id)}/pay`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          ...this.getAuthHeader(),
        },
        body: JSON.stringify({ amount: paymentAmount, details: effectiveDetails }),
      },
      15000
    );

    if (!res.ok) {
      throw await parseApiErrorResponse(res, "Gagal mencatat pembayaran tagihan.");
    }

    const payload = await res.json().catch(() => null);
    if (!payload || payload.success === false) {
      throw new ActionApiError(
        res.status || 400,
        String(payload?.error?.code || payload?.code || "VALIDATION_ERROR"),
        sanitizeActionMessage(payload?.error?.message || payload?.message) || "Gagal mencatat pembayaran tagihan."
      );
    }

    if (payload.data) {
      const currentIdx = this.invoices.findIndex((inv) => inv.id === record.id);
      if (currentIdx !== -1) {
        this.invoices[currentIdx] = this.normalizeInvoice(payload.data);
        this.deriveProfitFromInvoices(true);
        this.notify();
      }
    }
    return true;
  }

  public resolveInvoice(id: number, details?: any): boolean {
    const record = this.getInvoiceById(id);
    if (!record) return false;
    void this.recordPayment(id, record.sisa, details);
    return true;
  }

  public async completeInvoice(id: number, completedBy?: string): Promise<boolean> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/invoices/${encodeURIComponent(id)}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify({ completedBy }),
      },
      15000
    );

    if (!res.ok) {
      throw await parseApiErrorResponse(res, "Gagal menyelesaikan tagihan.");
    }

    const payload = await res.json().catch(() => null);
    if (!payload || payload.success === false) {
      throw new ActionApiError(
        res.status || 400,
        String(payload?.error?.code || payload?.code || "VALIDATION_ERROR"),
        sanitizeActionMessage(payload?.error?.message || payload?.message) || "Gagal menyelesaikan tagihan."
      );
    }

    if (payload.data) {
      const normalized = this.normalizeInvoice(payload.data);
      const currentIdx = this.invoices.findIndex((inv) => inv.id === id);
      if (currentIdx !== -1) {
        this.invoices[currentIdx] = normalized;
      } else {
        this.invoices.push(normalized);
      }
      this.deriveProfitFromInvoices(true);
      this.notify();
    }

    return true;
  }

  public async completeCashback(
    id: number,
    options?: { catatan?: string; idempotencyKey?: string; expectedVersion?: number }
  ): Promise<InvoiceBillingRecord> {
    const idempotencyKey =
      options?.idempotencyKey ||
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `CB-COMPLETE-${id}-${Date.now()}`);

    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/invoices/${encodeURIComponent(id)}/cashback-complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
          ...(options?.expectedVersion !== undefined
            ? { "X-Expected-Version": String(options.expectedVersion) }
            : {}),
          ...this.getAuthHeader(),
        },
        body: JSON.stringify({
          catatan: options?.catatan,
          idempotencyKey,
          expectedVersion: options?.expectedVersion,
        }),
      },
      15000
    );

    if (!res.ok) {
      throw await parseApiErrorResponse(res, "Gagal menyelesaikan transaksi cashback.");
    }

    const payload = await res.json().catch(() => null);
    if (!payload || payload.success === false || !payload.data) {
      throw new ActionApiError(
        res.status || 400,
        String(payload?.error?.code || payload?.code || "VALIDATION_ERROR"),
        sanitizeActionMessage(payload?.error?.message || payload?.message) || "Gagal menyelesaikan transaksi cashback."
      );
    }

    const normalized = this.normalizeInvoice(payload.data);
    const currentIdx = this.invoices.findIndex((inv) => inv.id === id);
    if (currentIdx !== -1) {
      this.invoices[currentIdx] = normalized;
    } else {
      this.invoices.push(normalized);
    }
    this.deriveProfitFromInvoices(true);
    this.notify();
    return normalized;
  }

  public async payoutCashback(id: number, payoutData: any): Promise<boolean> {
    const idempotencyKey = payoutData?.idempotencyKey || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `IDEMP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/finance/invoices/${encodeURIComponent(id)}/cashback-payout`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Idempotency-Key": idempotencyKey,
            ...(payoutData?.expectedVersion !== undefined ? { "X-Expected-Version": String(payoutData.expectedVersion) } : {}),
            ...this.getAuthHeader(),
          },
          body: JSON.stringify({ ...payoutData, idempotencyKey }),
        },
        15000
      );
    } catch (networkErr: any) {
      if (networkErr instanceof ActionApiError) {
        (networkErr as any).errorCode = networkErr.code;
        (networkErr as any).isDefinitive = false;
        (networkErr as any).isNetworkError = networkErr.statusCode === 0;
        throw networkErr;
      }
      const err = new ActionApiError(
        0,
        "NETWORK_ERROR",
        sanitizeActionMessage(networkErr?.message) || "Koneksi jaringan terputus saat menghubungi server."
      );
      (err as any).errorCode = "NETWORK_ERROR";
      (err as any).isDefinitive = false;
      (err as any).isNetworkError = true;
      throw err;
    }

    if (!res.ok) {
      const apiErr = await parseApiErrorResponse(res, "Gagal mencairkan cashback.");
      (apiErr as any).errorCode = apiErr.code;
      (apiErr as any).isDefinitive = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw apiErr;
    }

    const payload = await res.json().catch(() => null);
    if (!payload || payload.success === false) {
      const apiErr = new ActionApiError(
        res.status || 400,
        String(payload?.error?.code || payload?.code || "VALIDATION_ERROR"),
        sanitizeActionMessage(payload?.error?.message || payload?.message) || "Gagal mencairkan cashback."
      );
      (apiErr as any).errorCode = apiErr.code;
      (apiErr as any).isDefinitive = true;
      throw apiErr;
    }

    if (payload.data) {
      const currentIdx = this.invoices.findIndex((inv) => inv.id === id);
      if (currentIdx !== -1) {
        this.invoices[currentIdx] = this.normalizeInvoice(payload.data);
      }

      try {
        const kasRes = await fetchWithTimeout(
          `${this.baseUrl}/finance/kas-kantor`,
          { headers: { "Content-Type": "application/json", ...this.getAuthHeader() } },
          10000
        );
        if (kasRes.ok) {
          const kasPayload = await kasRes.json().catch(() => null);
          if (kasPayload?.success && Array.isArray(kasPayload.data)) {
            this.kasKantor = kasPayload.data.map((k: any) => ({
              id: Number(k.id),
              tanggal: k.tanggal,
              keterangan: k.keterangan,
              status: k.status,
              debit: Number(k.debit || 0),
              kredit: Number(k.kredit || 0),
              total: Number(k.total ?? k.saldo ?? 0),
              saldo: Number(k.saldo ?? k.total ?? 0),
              penanggungJawab: k.penanggungJawab || k.penanggung_jawab || undefined,
            }));
          }
        }
      } catch {
        // Secondary kas-kantor refresh must not falsely fail an already committed payout
      }
      this.deriveProfitFromInvoices(true);
      this.notify();
    }
    return true;
  }

  public async voidInvoicePayment(id: number, paymentId: number, reason: string): Promise<boolean> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/invoices/${encodeURIComponent(id)}/payments/${encodeURIComponent(paymentId)}/void`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify({ reason }),
      },
      15000
    );

    if (!res.ok) {
      throw await parseApiErrorResponse(res, "Gagal membatalkan pembayaran.");
    }

    const payload = await res.json().catch(() => null);
    if (payload?.success && payload.data) {
      const currentIdx = this.invoices.findIndex((inv) => inv.id === id);
      if (currentIdx !== -1) {
        this.invoices[currentIdx] = this.normalizeInvoice(payload.data);
      }

      try {
        const kasRes = await fetchWithTimeout(
          `${this.baseUrl}/finance/kas-kantor`,
          { headers: { "Content-Type": "application/json", ...this.getAuthHeader() } },
          10000
        );
        if (kasRes.ok) {
          const kasPayload = await kasRes.json().catch(() => null);
          if (kasPayload?.success && Array.isArray(kasPayload.data)) {
            this.kasKantor = kasPayload.data.map((k: any) => ({
              id: Number(k.id),
              tanggal: k.tanggal,
              keterangan: k.keterangan,
              status: k.status,
              debit: Number(k.debit || 0),
              kredit: Number(k.kredit || 0),
              total: Number(k.total ?? k.saldo ?? 0),
              saldo: Number(k.saldo ?? k.total ?? 0),
              penanggungJawab: k.penanggungJawab || k.penanggung_jawab || undefined,
            }));
          }
        }
      } catch {
        // Secondary kas-kantor refresh failure should not fail void
      }
      this.deriveProfitFromInvoices(true);
      this.notify();
    }
    return true;
  }

  public async voidCashbackPayout(id: number, reason: string): Promise<boolean> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/invoices/${encodeURIComponent(id)}/cashback-payout/void`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify({ reason }),
      },
      15000
    );

    if (!res.ok) {
      throw await parseApiErrorResponse(res, "Gagal membatalkan pencairan cashback.");
    }

    const payload = await res.json().catch(() => null);
    if (payload?.success && payload.data) {
      const currentIdx = this.invoices.findIndex((inv) => inv.id === id);
      if (currentIdx !== -1) {
        this.invoices[currentIdx] = this.normalizeInvoice(payload.data);
      }

      try {
        const kasRes = await fetchWithTimeout(
          `${this.baseUrl}/finance/kas-kantor`,
          { headers: { "Content-Type": "application/json", ...this.getAuthHeader() } },
          10000
        );
        if (kasRes.ok) {
          const kasPayload = await kasRes.json().catch(() => null);
          if (kasPayload?.success && Array.isArray(kasPayload.data)) {
            this.kasKantor = kasPayload.data.map((k: any) => ({
              id: Number(k.id),
              tanggal: k.tanggal,
              keterangan: k.keterangan,
              status: k.status,
              debit: Number(k.debit || 0),
              kredit: Number(k.kredit || 0),
              total: Number(k.total ?? k.saldo ?? 0),
              saldo: Number(k.saldo ?? k.total ?? 0),
              penanggungJawab: k.penanggungJawab || k.penanggung_jawab || undefined,
            }));
          }
        }
      } catch {
        // Secondary kas-kantor refresh failure should not fail void
      }
      this.deriveProfitFromInvoices(true);
      this.notify();
    }
    return true;
  }

  private mapKasKantorRow(k: any): KasKantorItem {
    return {
      id: Number(k.id),
      tanggal: k.tanggal,
      keterangan: k.keterangan,
      status: k.status,
      debit: Number(k.debit || 0),
      kredit: Number(k.kredit || 0),
      total: Number(k.total ?? k.saldo ?? 0),
      saldo: Number(k.saldo ?? k.total ?? 0),
      penanggungJawab: k.penanggungJawab || k.penanggung_jawab || undefined,
      orderNo: k.orderNo || k.order_no || undefined,
      invoiceNo: k.invoiceNo || k.invoice_no || undefined,
      kategori: k.kategori || undefined,
      paymentMethodId: k.paymentMethodId || k.payment_method_id || undefined,
      paymentMethodSnapshot: k.paymentMethodSnapshot || k.payment_method_snapshot || undefined,
      createdAt: k.createdAt || k.created_at || undefined,
    } as KasKantorItem;
  }

  private mapKasMessengerRow(m: any): KasMessengerItem {
    return {
      id: Number(m.id),
      tanggal: m.tanggal,
      jenis: m.jenis,
      messenger: m.messenger,
      keterangan: m.keterangan,
      in: Number(m.in ?? m.debit ?? 0),
      out: Number(m.out ?? m.kredit ?? 0),
      total: Number(m.total || 0),
      penanggungJawab: m.penanggungJawab || m.penanggung_jawab || undefined,
      orderNo: m.orderNo || m.order_no || undefined,
      reimbursementId: m.reimbursementId || m.reimbursement_id || undefined,
      receiptUrl: m.receiptUrl || m.receipt_url || undefined,
      kategori: m.kategori || undefined,
      messengerId: m.messengerId || m.messenger_id || undefined,
      paymentMethodId: m.paymentMethodId || m.payment_method_id || undefined,
      paymentMethodSnapshot: m.paymentMethodSnapshot || m.payment_method_snapshot || undefined,
      createdAt: m.createdAt || m.created_at || undefined,
    };
  }

  public async refreshKasKantor(): Promise<void> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/kas-kantor`,
      { headers: { "Content-Type": "application/json", ...this.getAuthHeader() } },
      10000
    );
    if (!res.ok) return;
    const payload = await res.json().catch(() => null);
    if (payload?.success && Array.isArray(payload.data)) {
      this.kasKantor = payload.data.map((k: any) => this.mapKasKantorRow(k));
      this.notify();
    }
  }

  public async refreshKasMessenger(): Promise<void> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/kas-messenger`,
      { headers: { "Content-Type": "application/json", ...this.getAuthHeader() } },
      10000
    );
    if (!res.ok) return;
    const payload = await res.json().catch(() => null);
    if (payload?.success && Array.isArray(payload.data)) {
      this.kasMessenger = payload.data.map((m: any) => this.mapKasMessengerRow(m));
      this.notify();
    }
  }

  public async addKasKantorAsync(item: Omit<KasKantorItem, "id">): Promise<KasKantorItem> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/kas-kantor`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify(item),
      },
      15000
    );
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.success || !payload?.data) {
      throw new Error(payload?.error?.message || payload?.message || `Gagal menambahkan kas kantor (HTTP ${res.status})`);
    }
    const confirmed = this.mapKasKantorRow(payload.data);
    this.kasKantor = [confirmed, ...this.kasKantor.filter((k) => k.id !== confirmed.id)];
    this.notify();
    await this.refreshKasKantor().catch(() => {});
    return confirmed;
  }

  public async updateKasKantor(id: number, updates: Partial<KasKantorItem> & { reason?: string }): Promise<KasKantorItem> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/kas-kantor/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify(updates),
      },
      15000
    );
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.success || !payload?.data) {
      throw new Error(payload?.error?.message || payload?.message || `Gagal memperbarui kas kantor (HTTP ${res.status})`);
    }
    const updated = this.mapKasKantorRow(payload.data);
    await this.refreshKasKantor().catch(() => {});
    return updated;
  }

  public addKasKantor(item: Omit<KasKantorItem, "id">): KasKantorItem | null {
    const lastTotal = this.kasKantor.length > 0
      ? (this.kasKantor[0].total ?? (this.kasKantor[0] as any).saldo ?? 0)
      : 0;

    const tempId = this.nextOptimisticId--;
    const newEntry: KasKantorItem = {
      id: tempId,
      tanggal: item.tanggal,
      status: item.status,
      keterangan: item.keterangan,
      debit: item.debit || 0,
      kredit: item.kredit || 0,
      penanggungJawab: item.penanggungJawab,
      orderNo: (item as any).orderNo,
      invoiceNo: (item as any).invoiceNo,
      kategori: (item as any).kategori,
      paymentMethodId: (item as any).paymentMethodId || (item as any).payment_method_id || null,
      paymentMethodSnapshot: (item as any).paymentMethodSnapshot || (item as any).payment_method_snapshot || null,
      total: (item.status === "Debit" || item.status === "Pemasukan") ? lastTotal + (item.debit || 0) : lastTotal - (item.kredit || 0),
    };

    this.pendingKasKantor.set(tempId, newEntry);
    this.kasKantor = [newEntry, ...this.kasKantor];
    this.notify();

    fetch(`${this.baseUrl}/finance/kas-kantor`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
      body: JSON.stringify(item),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        if (payload?.success && payload.data) {
          const confirmedEntry: KasKantorItem = {
            ...payload.data,
            id: Number(payload.data.id),
            total: Number(payload.data.total ?? payload.data.saldo ?? 0),
            saldo: Number(payload.data.saldo ?? payload.data.total ?? 0),
            orderNo: payload.data.orderNo || payload.data.order_no || (item as any).orderNo,
            invoiceNo: payload.data.invoiceNo || payload.data.invoice_no || (item as any).invoiceNo,
            kategori: payload.data.kategori || (item as any).kategori,
            paymentMethodId: payload.data.paymentMethodId || payload.data.payment_method_id || (item as any).paymentMethodId || (item as any).payment_method_id || null,
            paymentMethodSnapshot: payload.data.paymentMethodSnapshot || payload.data.payment_method_snapshot || (item as any).paymentMethodSnapshot || (item as any).payment_method_snapshot || null,
            createdAt: payload.data.createdAt || payload.data.created_at,
          };
          this.kasKantor = this.commitOptimisticAddition(
            this.kasKantor,
            tempId,
            confirmedEntry,
            this.kasKantorEpoch,
            this.pendingKasKantor,
            this.confirmedKasKantor
          );
          this.notify();
        } else {
          this.kasKantor = this.rollbackOptimisticAddition(this.kasKantor, tempId, this.pendingKasKantor);
          this.notify();
        }
      })
      .catch((err) => {
        console.error("Failed to persist kas entry, rolling back:", err);
        this.kasKantor = this.rollbackOptimisticAddition(this.kasKantor, tempId, this.pendingKasKantor);
        this.notify();
      });

    return newEntry;
  }

  public addPengeluaran(item: Omit<PengeluaranItem, "id">): PengeluaranItem | null {
    const nextId = Date.now();
    const newEntry: PengeluaranItem = {
      id: nextId,
      tanggal: item.tanggal,
      keterangan: item.keterangan,
      nominal: item.nominal,
      penanggungJawab: item.penanggungJawab,
    };

    this.pengeluaran.unshift(newEntry);
    this.notify();

    fetch(`${this.baseUrl}/finance/pengeluaran`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
      body: JSON.stringify(item),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        if (payload?.success && payload.data) {
          const idx = this.pengeluaran.findIndex((p) => p.id === newEntry.id);
          if (idx !== -1) {
            this.pengeluaran[idx] = {
              id: Number(payload.data.id),
              tanggal: payload.data.tanggal,
              keterangan: payload.data.keterangan,
              nominal: Number(payload.data.nominal || 0),
              penanggungJawab: payload.data.penanggungJawab || payload.data.penanggung_jawab || undefined,
            };
            this.notify();
          }
        }
      })
      .catch((err) => {
        console.error("Failed to persist pengeluaran entry, rolling back:", err);
        const idx = this.pengeluaran.findIndex((p) => p.id === newEntry.id);
        if (idx !== -1) {
          this.pengeluaran.splice(idx, 1);
          this.notify();
        }
      });

    return newEntry;
  }

  public async deleteKasKantor(id: number, reason: string, idempotencyKey?: string): Promise<boolean> {
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 10) {
      throw new Error("Alasan penghapusan permanen kas kantor wajib diisi minimal 10 karakter.");
    }
    const key = idempotencyKey || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

    const res = await fetch(`${this.baseUrl}/finance/kas-kantor/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": key,
        ...this.getAuthHeader(),
      },
      body: JSON.stringify({ reason: cleanReason }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData?.error?.message || errorData.message || `Gagal menghapus kas kantor (HTTP ${res.status})`);
    }

    // Only mutate state after confirmed server success (no optimistic removal)
    this.confirmedKasKantor.delete(Number(id));
    const idx = this.kasKantor.findIndex((k) => k.id === id);
    if (idx !== -1) {
      this.kasKantor.splice(idx, 1);
      this.notify();
    }
    await this.refreshKasKantor().catch(() => {});
    return true;
  }

  public async addKasMessengerAsync(item: Omit<KasMessengerItem, "id" | "total"> & { total?: number }): Promise<KasMessengerItem> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/kas-messenger`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify(item),
      },
      15000
    );
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.success || !payload?.data) {
      throw new Error(payload?.error?.message || payload?.message || `Gagal menambahkan kas messenger (HTTP ${res.status})`);
    }
    const confirmed = this.mapKasMessengerRow(payload.data);
    this.kasMessenger = [confirmed, ...this.kasMessenger.filter((k) => k.id !== confirmed.id)];
    this.notify();
    await this.refreshKasMessenger().catch(() => {});
    return confirmed;
  }

  public async updateKasMessenger(id: number, updates: Partial<KasMessengerItem> & { reason?: string }): Promise<KasMessengerItem> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/kas-messenger/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify(updates),
      },
      15000
    );
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.success || !payload?.data) {
      throw new Error(payload?.error?.message || payload?.message || `Gagal memperbarui kas messenger (HTTP ${res.status})`);
    }
    const updated = this.mapKasMessengerRow(payload.data);
    await this.refreshKasMessenger().catch(() => {});
    return updated;
  }

  public addKasMessenger(item: Omit<KasMessengerItem, "id" | "total"> & { total?: number }): KasMessengerItem | null {
    const lastTotal = this.kasMessenger.length > 0
      ? this.kasMessenger[0].total
      : 0;
    const runningTotal = item.total !== undefined ? item.total : lastTotal + item.in - item.out;

    const tempId = this.nextOptimisticId--;
    const newEntry: KasMessengerItem = {
      id: tempId,
      tanggal: item.tanggal,
      jenis: item.jenis,
      messenger: item.messenger,
      keterangan: item.keterangan,
      in: item.in,
      out: item.out,
      total: runningTotal,
      orderNo: (item as any).orderNo,
      penanggungJawab: (item as any).penanggungJawab,
      reimbursementId: (item as any).reimbursementId,
      receiptUrl: (item as any).receiptUrl,
      kategori: (item as any).kategori,
      messengerId: (item as any).messengerId || (item as any).messenger_id,
      paymentMethodId: (item as any).paymentMethodId || (item as any).payment_method_id || null,
      paymentMethodSnapshot: (item as any).paymentMethodSnapshot || (item as any).payment_method_snapshot || null,
    };

    this.pendingKasMessenger.set(tempId, newEntry);
    this.kasMessenger = [newEntry, ...this.kasMessenger];
    this.notify();

    fetch(`${this.baseUrl}/finance/kas-messenger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
      body: JSON.stringify(item),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        if (payload?.success && payload.data) {
          const confirmedEntry: KasMessengerItem = {
            id: Number(payload.data.id),
            tanggal: payload.data.tanggal,
            jenis: payload.data.jenis,
            messenger: payload.data.messenger,
            keterangan: payload.data.keterangan,
            in: Number(payload.data.in ?? payload.data.debit ?? 0),
            out: Number(payload.data.out ?? payload.data.kredit ?? 0),
            total: Number(payload.data.total ?? 0),
            orderNo: payload.data.orderNo || payload.data.order_no || (item as any).orderNo,
            penanggungJawab: payload.data.penanggungJawab || payload.data.penanggung_jawab || (item as any).penanggungJawab,
            reimbursementId: payload.data.reimbursementId || payload.data.reimbursement_id || (item as any).reimbursementId,
            receiptUrl: payload.data.receiptUrl || payload.data.receipt_url || (item as any).receiptUrl,
            kategori: payload.data.kategori || (item as any).kategori,
            messengerId: payload.data.messengerId || payload.data.messenger_id || (item as any).messengerId || (item as any).messenger_id,
            paymentMethodId: payload.data.paymentMethodId || payload.data.payment_method_id || (item as any).paymentMethodId || (item as any).payment_method_id || null,
            paymentMethodSnapshot: payload.data.paymentMethodSnapshot || payload.data.payment_method_snapshot || (item as any).paymentMethodSnapshot || (item as any).payment_method_snapshot || null,
            createdAt: payload.data.createdAt || payload.data.created_at,
          };
          this.kasMessenger = this.commitOptimisticAddition(
            this.kasMessenger,
            tempId,
            confirmedEntry,
            this.kasMessengerEpoch,
            this.pendingKasMessenger,
            this.confirmedKasMessenger
          );
          this.notify();
        } else {
          this.kasMessenger = this.rollbackOptimisticAddition(this.kasMessenger, tempId, this.pendingKasMessenger);
          this.notify();
        }
      })
      .catch((err) => {
        console.error("Failed to persist kas messenger, rolling back:", err);
        this.kasMessenger = this.rollbackOptimisticAddition(this.kasMessenger, tempId, this.pendingKasMessenger);
        this.notify();
      });

    return newEntry;
  }

  public async deleteKasMessenger(id: number, reason: string, idempotencyKey?: string): Promise<boolean> {
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 10) {
      throw new Error("Alasan penghapusan permanen kas messenger wajib diisi minimal 10 karakter.");
    }
    const key = idempotencyKey || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

    const res = await fetch(`${this.baseUrl}/finance/kas-messenger/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": key,
        ...this.getAuthHeader(),
      },
      body: JSON.stringify({ reason: cleanReason }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData?.error?.message || errorData.message || `Gagal menghapus kas messenger (HTTP ${res.status})`);
    }

    // Only mutate state after confirmed server success (no optimistic removal)
    this.confirmedKasMessenger.delete(Number(id));
    const idx = this.kasMessenger.findIndex((k) => k.id === id);
    if (idx !== -1) {
      this.kasMessenger.splice(idx, 1);
      this.notify();
    }
    await this.refreshKasMessenger().catch(() => {});
    return true;
  }

  public async deletePengeluaran(id: number, reason: string, idempotencyKey?: string): Promise<boolean> {
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 10) {
      throw new Error("Alasan penghapusan permanen pengeluaran wajib diisi minimal 10 karakter.");
    }
    const key = idempotencyKey || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

    const res = await fetch(`${this.baseUrl}/finance/pengeluaran/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": key,
        ...this.getAuthHeader(),
      },
      body: JSON.stringify({ reason: cleanReason }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || `Gagal menghapus pengeluaran (HTTP ${res.status})`);
    }

    // Only mutate state after confirmed server success (no optimistic removal)
    const idx = this.pengeluaran.findIndex((p) => p.id === id);
    if (idx !== -1) {
      this.pengeluaran.splice(idx, 1);
      this.notify();
    }
    return true;
  }

  public saveInvoice(invoice: InvoiceBillingRecord): void {
    const normalized = this.normalizeInvoice(invoice);
    const idx = this.invoices.findIndex((inv) => inv.id === normalized.id || inv.invoiceNo === normalized.invoiceNo);
    if (idx !== -1) {
      this.invoices[idx] = normalized;
    } else {
      this.invoices.unshift(normalized);
    }
    this.deriveProfitFromInvoices(true);
    this.notify();
  }

  public async getVoidAuditHistory(): Promise<{ payments: any[]; cashbacks: any[] }> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/finance/audit/void-history`,
      { headers: { "Content-Type": "application/json", ...this.getAuthHeader() } },
      15000
    );
    if (!res.ok) {
      throw await parseApiErrorResponse(res, "Gagal mengambil riwayat audit void.");
    }
    const payload = await res.json();
    return payload.data || { payments: [], cashbacks: [] };
  }
}
