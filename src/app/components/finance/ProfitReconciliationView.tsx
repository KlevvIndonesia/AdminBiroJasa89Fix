import { useState, useMemo, useEffect, useRef } from "react";
import { Card } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { formatRupiah, formatDateDDMMYYYY } from "../../utils/financeFormatters";
import {
  exportProfitToCSV,
  exportProfitToPDF,
  ProfitExportGroup,
  ProfitExportParams,
} from "../../utils/financeExport";
import { useFinanceStore, PenjualanContractCategory, ProfitItem } from "../../data/financeStore";
import { usePaymentMethods } from "../../data/paymentMethodStore";
import {
  CanonicalPaymentMethodRecord,
  ProfitPaymentBreakdownEntry,
  buildPaymentMethodLabelMap,
  resolveCanonicalPaymentMethod,
  isPaymentSchemeString,
  isCashPaymentString,
  matchesWibDateRange,
  normalizeProfitCategoryKey,
} from "../../../domain/finance/paymentMethodCanonical";
import { toast } from "sonner";
import {
  CANONICAL_SALES_CATEGORIES,
  CANONICAL_SERVICES_METADATA,
} from "../DataPenjualan";
import {
  Filter,
  Calendar,
  CreditCard,
  Layers,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Download,
  Printer,
  Loader2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

/**
 * Normalizes payment method name to a clean, canonical string without decorative icons.
 * Strictly filters out payment schemes/timing such as "Bayar di Awal", "Bayar di Akhir", "Tempo".
 * Never defaults NULL/empty strings to "Tunai".
 */
export function normalizeBankMethodName(raw?: string | null): string {
  if (!raw || isPaymentSchemeString(raw)) return "";
  const s = raw.toLowerCase().trim();
  if (!s || s === "belum terhubung" || s === "belum dibayar") return "";

  if (isCashPaymentString(raw)) {
    return "Tunai";
  }
  if (s.includes("cimb")) return "Transfer CIMB Niaga";
  if (s.includes("bca")) return "Transfer BCA";
  if (s.includes("muamalat")) return "Transfer Muamalat";
  if (s.includes("mandiri")) return "Transfer Mandiri";
  if (s.includes("bri")) return "Transfer BRI";
  if (s.includes("bni")) return "Transfer BNI";
  if (s === "transfer" || s === "transfer bank") return "Transfer Bank";

  const clean = raw.replace(/^(transfer\s+bank\s+|transfer\s+|bank\s+)/i, "").trim();
  return clean ? (raw.trim().toLowerCase().startsWith("transfer") ? raw.trim() : `Transfer ${clean}`) : "";
}

/**
 * Normalizes outflow bank/cash channel without decorative icons.
 */
export function normalizeOutflowBankName(raw?: string | null): string {
  if (!raw) return "Kas Kantor";
  const s = raw.toLowerCase().trim();
  if (
    s.includes("cash") ||
    s.includes("tunai") ||
    s.includes("kas fisik") ||
    s.includes("kas messenger") ||
    s.includes("kas kantor")
  ) {
    return "Kas Kantor";
  }
  if (s.includes("cimb")) return "Bank CIMB Niaga";
  if (s.includes("bca")) return "Bank BCA";
  if (s.includes("muamalat")) return "Bank Muamalat";
  if (s.includes("mandiri")) return "Bank Mandiri";
  if (s.includes("bri")) return "Bank BRI";
  if (s.includes("bni")) return "Bank BNI";
  return raw;
}

/**
 * Extracts true payment method from order/invoice/contract row.
 * Strictly ignores "Skema Pembayaran" and NEVER falls back NULL/empty values to "Tunai".
 */
export function extractRealPaymentMethod(
  item: any,
  paymentMethods: CanonicalPaymentMethodRecord[] = []
): string {
  if (!item) return "";

  if (paymentMethods.length > 0) {
    const resolved = resolveCanonicalPaymentMethod(
      {
        id: item.paymentMethodId || item.metodePembayaranId || item.payment?.paymentMethodId,
        snapshot: item.paymentMethodSnapshot || item.payment_method_snapshot || item.payment?.paymentMethodSnapshot,
        metode: item.metodePembayaran || item["Metode Pembayaran"] || item.payment?.metodePembayaran,
        namaBank: item.namaBank || item.bank || item["Nama Bank"] || item.payment?.namaBank || item.payment?.bank,
        nomorRekening: item.nomorRekening || item.noRekening || item["Nomor Rekening"],
      },
      paymentMethods
    );
    if (resolved) {
      return buildPaymentMethodLabelMap(paymentMethods).get(resolved.id)?.displayLabel || resolved.nama_metode;
    }
  }

  if (
    typeof item.paymentMethodLabel === "string" &&
    item.paymentMethodLabel.trim() &&
    item.paymentMethodLabel !== "-" &&
    item.paymentMethodLabel !== "Belum Dibayar"
  ) {
    return item.paymentMethodLabel.trim();
  }

  const candidates = [
    item["Metode Pembayaran"],
    item.metodePembayaran,
    item.payment?.metodePembayaran,
    item.payment?.bank,
    item.payment?.namaBank,
    item.invoice?.metodePembayaran,
    item.invoice?.bank,
    item["Nama Bank"],
    item.namaBank,
    item.bank,
    item.rekening,
    item.paymentMethod,
    item.payment_method,
    item.metodePencairan,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      const norm = normalizeBankMethodName(c);
      if (norm) return norm;
    }
  }

  const snap =
    item.paymentMethodSnapshot ||
    item.payment_method_snapshot ||
    item.payment?.paymentMethodSnapshot;
  if (snap) {
    try {
      const parsed = typeof snap === "string" ? JSON.parse(snap) : snap;
      const b = parsed.bank || parsed.nama_metode;
      if (b) {
        const norm = normalizeBankMethodName(b);
        if (norm) return norm;
      }
    } catch {}
  }

  return "";
}

function matchesDateRange(dateStr?: string | null, start?: string, end?: string): boolean {
  return matchesWibDateRange(dateStr, start, end);
}

export interface ServiceProfitGroup {
  id: string;
  categoryKey: string;
  serviceTitle: string;
  jumlahBerkas: number;
  totalUangMasuk: number;
  breakdownUangMasuk: Record<string, { nominal: number; count: number }>;
  totalUangKeluar: number;
  breakdownUangKeluar: Record<string, { nominal: number; count: number }>;
  totalProfit: number;
  marginPercent: number;
  items: any[];
}

export interface ProfitFilterQueryParams {
  paymentMethodId?: string;
  startDate?: string;
  endDate?: string;
  category?: string;
}

/**
 * Coordinates one authoritative filtered-profit fetch cycle with AbortController
 * cancellation, stale-response sequence protection, and deterministic loading cleanup.
 */
export async function executeProfitFilterFetch(params: {
  filters: ProfitFilterQueryParams;
  seq: number;
  getCurrentSeq: () => number;
  isCancelled: () => boolean;
  signal?: AbortSignal;
  fetcher: (
    filters?: ProfitFilterQueryParams,
    options?: { signal?: AbortSignal }
  ) => Promise<ProfitItem[] | null>;
  onLoading: (loading: boolean) => void;
  onSuccess: (rows: ProfitItem[]) => void;
  onError: (message: string) => void;
}): Promise<void> {
  const {
    filters,
    seq,
    getCurrentSeq,
    isCancelled,
    signal,
    fetcher,
    onLoading,
    onSuccess,
    onError,
  } = params;

  onLoading(true);
  try {
    const data = await fetcher(filters, signal ? { signal } : undefined);
    if (!isCancelled() && seq === getCurrentSeq()) {
      if (Array.isArray(data)) {
        onSuccess(data);
      } else {
        onError("Respons filter profit dari server tidak valid.");
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError" || isCancelled() || seq !== getCurrentSeq()) {
      return;
    }
    onError(err?.message || "Gagal memuat data profit terfilter dari server.");
  } finally {
    if (!isCancelled() && seq === getCurrentSeq()) {
      onLoading(false);
    }
  }
}

export function ProfitReconciliationView() {
  const {
    profitList: storeProfitData,
    fetchFilteredProfitList,
    getContractData,
    profitPendingList,
    cashbackPendingList,
    belumBayarList,
    isLoading: isFinanceLoading,
    profitError,
    error: financeError,
    refresh: refreshFinanceStore,
  } = useFinanceStore();
  const {
    methods: allPaymentMethods,
    refresh: refreshPaymentMethods,
    isLoading: isPaymentMethodsLoading,
    error: pmError,
  } = usePaymentMethods();

  // SECTION 1: FILTER STATES
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [selectedMethod, setSelectedMethod] = useState<string>("ALL");
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const [serverFilteredProfit, setServerFilteredProfit] = useState<ProfitItem[] | null>(null);
  const [isFilterLoading, setIsFilterLoading] = useState<boolean>(false);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [retryCounter, setRetryCounter] = useState<number>(0);
  const fetchSeqRef = useRef(0);

  // Ensure DB payment methods (including historical nonaktif entries) are loaded cleanly
  useEffect(() => {
    void refreshPaymentMethods();
  }, []);

  const hasActiveFilter =
    selectedMethod !== "ALL" ||
    Boolean(startDate) ||
    Boolean(endDate) ||
    selectedCategory !== "ALL";

  const effectiveProfitError =
    (hasActiveFilter ? filterError : null) ||
    profitError?.message ||
    financeError?.message ||
    pmError ||
    null;

  const isProfitLoading =
    isFinanceLoading || isPaymentMethodsLoading || (hasActiveFilter && isFilterLoading);

  // Fetch authoritative server-filtered profit list whenever filters change (in API mode)
  useEffect(() => {
    if (!hasActiveFilter) {
      setServerFilteredProfit(null);
      setIsFilterLoading(false);
      setFilterError(null);
      return;
    }

    const seq = ++fetchSeqRef.current;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let cancelled = false;
    setFilterError(null);

    void executeProfitFilterFetch({
      filters: {
        paymentMethodId: selectedMethod !== "ALL" ? selectedMethod : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        category: selectedCategory !== "ALL" ? selectedCategory : undefined,
      },
      seq,
      getCurrentSeq: () => fetchSeqRef.current,
      isCancelled: () => cancelled,
      signal: controller?.signal,
      fetcher: fetchFilteredProfitList,
      onLoading: setIsFilterLoading,
      onSuccess: (rows) => {
        setServerFilteredProfit(rows);
        setFilterError(null);
      },
      onError: (message) => {
        setServerFilteredProfit([]);
        setFilterError(message);
      },
    });

    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [hasActiveFilter, selectedMethod, startDate, endDate, selectedCategory, storeProfitData, retryCounter]);

  const handleRetryProfit = async () => {
    setFilterError(null);
    await Promise.all([
      refreshFinanceStore().catch(() => undefined),
      refreshPaymentMethods().catch(() => undefined),
    ]);
    if (hasActiveFilter) {
      setRetryCounter((c) => c + 1);
    }
  };

  // SECTION 2: INDEPENDENT EXPAND / COLLAPSE STATE PER SERVICE CATEGORY (DEFAULT: COLLAPSED)
  const [expandedBreakdown, setExpandedBreakdown] = useState<Record<string, boolean>>({});

  const toggleBreakdown = (catKey: string) => {
    setExpandedBreakdown((prev) => ({
      ...prev,
      [catKey]: !prev[catKey],
    }));
  };

  const resetFilters = () => {
    setStartDate("");
    setEndDate("");
    setSelectedMethod("ALL");
    setSelectedCategory("ALL");
    setServerFilteredProfit(null);
  };

  const paymentLabelMap = useMemo(
    () => buildPaymentMethodLabelMap(allPaymentMethods),
    [allPaymentMethods]
  );

  // Helper to resolve canonical payment method ID & verified breakdown for a row
  const resolveRowPaymentInfo = (
    src: any,
    uangMasukVal: number
  ): {
    paymentMethodId: string | null;
    paymentMethodIds: string[];
    paymentMethodLabel: string;
    paymentBreakdown: ProfitPaymentBreakdownEntry[];
    hasVerifiedPayment: boolean;
  } => {
    if (uangMasukVal <= 0 || src?.verifiedPaymentCount === 0) {
      return {
        paymentMethodId: null,
        paymentMethodIds: [],
        paymentMethodLabel: "",
        paymentBreakdown: [],
        hasVerifiedPayment: false,
      };
    }

    const rawBreakdown: ProfitPaymentBreakdownEntry[] = Array.isArray(src?.paymentBreakdown)
      ? src.paymentBreakdown
      : [];

    if (rawBreakdown.length > 0) {
      const normalizedBreakdown = rawBreakdown.map((b) => {
        const matchedPm =
          (b.paymentMethodId && allPaymentMethods.find((m) => m.id === b.paymentMethodId)) ||
          resolveCanonicalPaymentMethod(
            {
              id: b.paymentMethodId,
              metode: b.paymentMethodLabel,
              namaBank: b.namaBank,
              nomorRekening: b.nomorRekening,
            },
            allPaymentMethods
          );
        const id = matchedPm ? matchedPm.id : b.paymentMethodId || null;
        const label = matchedPm
          ? paymentLabelMap.get(matchedPm.id)?.displayLabel || matchedPm.nama_metode
          : b.paymentMethodLabel || "Belum Terhubung";
        return {
          ...b,
          paymentMethodId: id,
          paymentMethodLabel: label,
        };
      });

      const primary = normalizedBreakdown[normalizedBreakdown.length - 1];
      const ids = Array.from(
        new Set(normalizedBreakdown.map((b) => b.paymentMethodId).filter((id): id is string => Boolean(id)))
      );
      return {
        paymentMethodId: primary.paymentMethodId,
        paymentMethodIds: ids,
        paymentMethodLabel: primary.paymentMethodLabel,
        paymentBreakdown: normalizedBreakdown,
        hasVerifiedPayment: true,
      };
    }

    const matchedPm = resolveCanonicalPaymentMethod(
      {
        id: src?.paymentMethodId || src?.metodePembayaranId,
        snapshot: src?.paymentMethodSnapshot || src?.payment_method_snapshot,
        metode: src?.metodePembayaran || src?.["Metode Pembayaran"],
        namaBank: src?.namaBank || src?.bank || src?.["Nama Bank"],
        nomorRekening: src?.nomorRekening || src?.noRekening || src?.["Nomor Rekening"],
      },
      allPaymentMethods
    );
    const label = matchedPm
      ? paymentLabelMap.get(matchedPm.id)?.displayLabel || matchedPm.nama_metode
      : extractRealPaymentMethod(src, allPaymentMethods) || "Belum Terhubung";

    const id = matchedPm ? matchedPm.id : src?.paymentMethodId || null;
    const singleEntry: ProfitPaymentBreakdownEntry = {
      paymentMethodId: id,
      paymentMethodLabel: label,
      paymentMethodStatus: matchedPm ? matchedPm.status : null,
      metodePencairan: src?.metodePencairan || "-",
      namaBank: matchedPm ? matchedPm.bank || "" : src?.namaBank || "",
      nomorRekening: matchedPm ? matchedPm.nomor_rekening || "" : src?.nomorRekening || "",
      namaPemilikRekening: matchedPm ? matchedPm.nama_rekening || "" : src?.namaPemilikRekening || "",
      nominal: uangMasukVal,
      count: 1,
    };

    return {
      paymentMethodId: id,
      paymentMethodIds: id ? [id] : [],
      paymentMethodLabel: label,
      paymentBreakdown: [singleEntry],
      hasVerifiedPayment: true,
    };
  };

  // Track used method IDs across unfiltered data so historical inactive DB methods remain selectable when relevant
  const unfilteredUsedMethodIds = useMemo(() => {
    const ids = new Set<string>();
    (storeProfitData || []).forEach((p: any) => {
      if (p?.verifiedPaymentCount === 0 || Number(p?.uangMasuk ?? 0) <= 0) return;
      if (p?.paymentMethodId) ids.add(String(p.paymentMethodId));
      if (Array.isArray(p?.paymentMethodIds)) {
        p.paymentMethodIds.forEach((id: string) => {
          if (id) ids.add(String(id));
        });
      }
      if (Array.isArray(p?.paymentBreakdown)) {
        p.paymentBreakdown.forEach((b: any) => {
          if (b?.paymentMethodId) ids.add(String(b.paymentMethodId));
        });
      }
    });
    return ids;
  }, [storeProfitData]);

  // Authoritative dropdown options built 100% from DB payment_methods
  const dropdownPaymentOptions = useMemo(() => {
    const active = allPaymentMethods.filter(
      (m) => String(m.status || "").trim().toLowerCase() === "aktif"
    );
    const inactiveUsed = allPaymentMethods.filter(
      (m) =>
        String(m.status || "").trim().toLowerCase() !== "aktif" &&
        unfilteredUsedMethodIds.has(m.id)
    );
    return [...active, ...inactiveUsed].map((m) => ({
      id: m.id,
      label: paymentLabelMap.get(m.id)?.dropdownLabel || m.nama_metode,
      status: m.status,
    }));
  }, [allPaymentMethods, unfilteredUsedMethodIds, paymentLabelMap]);

  // 1. GATHER ALL VERIFIED SALES DATA FROM AUTHORITATIVE BACKEND / DATA PENJUALAN
  const allRawSalesRows = useMemo(() => {
    if (effectiveProfitError) {
      return [];
    }
    const rows: any[] = [];
    const seenKeys = new Set<string>();
    const normalizeKey = (val: unknown) => String(val || "").trim().toUpperCase();

    const isCancelledRow = (row: any): boolean => {
      if (!row) return false;
      if (Boolean(row.isOrderCancelled) || Boolean(row.isCancelled)) return true;
      const st = String(row.status || row.billingStatus || "").trim().toUpperCase();
      if (st === "CANCELLED") return true;
      const stPengerjaan = String(row["Status Pengerjaan"] || "").trim().toLowerCase();
      const stPembayaran = String(row["Status Pembayaran"] || "").trim().toLowerCase();
      return stPengerjaan === "dibatalkan" || stPembayaran === "dibatalkan";
    };

    const activeProfitSource = serverFilteredProfit !== null ? serverFilteredProfit : storeProfitData;

    const profitByOrderNo = new Map<string, any>();
    const profitByInvoiceNo = new Map<string, any>();
    (activeProfitSource || []).forEach((p: any) => {
      if (isCancelledRow(p)) return;
      const ordKey = normalizeKey(p.orderNo);
      const invKey = normalizeKey(p.invoice || p.invoiceNo);
      if (ordKey) profitByOrderNo.set(ordKey, p);
      if (invKey) profitByInvoiceNo.set(invKey, p);
    });

    // When authoritative server-filtered profit list is active, do NOT re-inject unfiltered contract rows
    if (serverFilteredProfit === null) {
      // A. Read from each canonical category of Data Penjualan (exclude CANCELLED, unpaid/unverified & enrich from authoritative profitData)
      CANONICAL_SALES_CATEGORIES.forEach((catKey) => {
        try {
          const catRows = getContractData(catKey as PenjualanContractCategory) || [];
          catRows.forEach((r: any) => {
            if (isCancelledRow(r)) return;
            const ordNo = r["Nomor Order"] || r.orderNo || r.id;
            const invNo = r["No Invoice"] || r.noInvoice || r.invoice || "-";
            const ordKey = normalizeKey(ordNo);
            const invKey = invNo !== "-" ? normalizeKey(invNo) : "";
            if ((ordKey && seenKeys.has(ordKey)) || (invKey && seenKeys.has(invKey))) return;

            const matchedProfit =
              (ordKey ? profitByOrderNo.get(ordKey) : undefined) ||
              (invKey ? profitByInvoiceNo.get(invKey) : undefined);

            const uangMasukVal = matchedProfit
              ? Number(matchedProfit.uangMasuk ?? 0)
              : Number(r["Uang Masuk dari Konsumen"] ?? r.uangMasuk ?? r.dibayar ?? 0);

            // Only include rows with verified incoming money
            if (uangMasukVal <= 0 || matchedProfit?.verifiedPaymentCount === 0) {
              return;
            }

            if (ordKey) seenKeys.add(ordKey);
            if (invKey) seenKeys.add(invKey);

            const payInfo = resolveRowPaymentInfo(matchedProfit || r, uangMasukVal);
            if (!payInfo.hasVerifiedPayment) return;

            const svcTitle =
              CANONICAL_SERVICES_METADATA[catKey]?.title ||
              r["Jenis Pengurusan"] ||
              "Layanan Samsat";

            const biayaSamsatVal = matchedProfit
              ? Number(matchedProfit.matchedCOGS ?? matchedProfit.biayaSamsat ?? 0)
              : Number(r["Biaya Pokok Samsat"] ?? r["Uang Keluar dari Biro Jasa"] ?? r.biayaSamsat ?? 0);
            const isHoldPending =
              matchedProfit?.holdStatus === "HOLD_COST_PENDING" ||
              matchedProfit?.isFinancialAnomaly === true ||
              (biayaSamsatVal === 0 && !matchedProfit?.isExplicitZero && !r.isExplicitZero && uangMasukVal > 0);
            const profitVal = matchedProfit
              ? Number(matchedProfit.profit ?? matchedProfit.grossProfit ?? 0)
              : (isHoldPending ? 0 : Number(r.Profit ?? r.profit ?? Math.max(0, Math.min(uangMasukVal, Number(r["Total Tagihan"] ?? r.totalTagihan ?? uangMasukVal)) - biayaSamsatVal)));

            rows.push({
              id: r.id || ordNo,
              orderNo: ordNo,
              categoryKey: catKey,
              serviceTitle: svcTitle,
              tanggal: (matchedProfit?.tanggalUangMasuk || matchedProfit?.tanggal) ?? (r["Tanggal Uang Masuk"] || r["Tanggal Masuk Berkas"] || r.tanggal || ""),
              nopol: r["Plat No"] || r.nopol || "-",
              customer: r["Nama Customer"] || r.customer || "-",
              namaBerkas: r["Nama Pemilik (STNK/BPKB)"] || r.namaBerkas || "-",
              uangMasuk: uangMasukVal,
              uangKeluar: biayaSamsatVal,
              profit: profitVal,
              paymentMethodId: payInfo.paymentMethodId,
              paymentMethodIds: payInfo.paymentMethodIds,
              paymentMethodLabel: payInfo.paymentMethodLabel,
              paymentBreakdown: payInfo.paymentBreakdown,
              metodePembayaran: payInfo.paymentMethodLabel,
              bankUangKeluar: r["Bank Uang Keluar"] || r.bankUangKeluar || "Kas Kantor",
              invoice: (matchedProfit?.invoice && matchedProfit.invoice !== "-") ? matchedProfit.invoice : invNo,
            });
          });
        } catch {}
      });
    }

    // B. Merge remaining verified items from profitData (or all items when serverFilteredProfit is active)
    (activeProfitSource || []).forEach((p: any) => {
      if (isCancelledRow(p)) return;
      const ordKey = normalizeKey(p.orderNo);
      const invNo = p.invoice || p.invoiceNo || p.id;
      const invKey = normalizeKey(invNo);
      if ((ordKey && seenKeys.has(ordKey)) || (invKey && seenKeys.has(invKey))) return;

      const uangMasukVal = Number(p.uangMasuk ?? 0);
      if (uangMasukVal <= 0 || p.verifiedPaymentCount === 0) return;

      if (ordKey) seenKeys.add(ordKey);
      if (invKey) seenKeys.add(invKey);

      const matchedCat = normalizeProfitCategoryKey(p.pengurusan);
      const svcTitle =
        CANONICAL_SERVICES_METADATA[matchedCat as keyof typeof CANONICAL_SERVICES_METADATA]?.title ||
        p.pengurusan ||
        "Layanan Samsat";

      const payInfo = resolveRowPaymentInfo(p, uangMasukVal);
      if (!payInfo.hasVerifiedPayment) return;

      rows.push({
        id: p.id || invNo,
        orderNo: p.orderNo || invNo,
        categoryKey: matchedCat,
        serviceTitle: svcTitle,
        tanggal: p.tanggalUangMasuk || p.tanggal || "",
        nopol: p.nopol || "-",
        customer: p.customer || "-",
        namaBerkas: p.namaBerkas || "-",
        uangMasuk: uangMasukVal,
        uangKeluar: Number(p.matchedCOGS ?? p.biayaSamsat ?? 0),
        profit: Number(p.profit ?? p.grossProfit ?? 0),
        paymentMethodId: payInfo.paymentMethodId,
        paymentMethodIds: payInfo.paymentMethodIds,
        paymentMethodLabel: payInfo.paymentMethodLabel,
        paymentBreakdown: payInfo.paymentBreakdown,
        metodePembayaran: payInfo.paymentMethodLabel,
        bankUangKeluar: p.bankUangKeluar || "Kas Kantor",
        invoice: p.invoice || "-",
      });
    });

    return rows;
  }, [storeProfitData, serverFilteredProfit, getContractData, allPaymentMethods, paymentLabelMap, effectiveProfitError]);

  // 2. APPLY FILTERS (SECTION 1) — Strict canonical ID & proportional multi-payment attribution
  const filteredSalesRows = useMemo(() => {
    return allRawSalesRows
      .map((row) => {
        if (!matchesDateRange(row.tanggal, startDate, endDate)) {
          return null;
        }

        if (selectedCategory !== "ALL") {
          if (row.categoryKey !== selectedCategory && row.serviceTitle !== selectedCategory) {
            return null;
          }
        }

        if (selectedMethod !== "ALL") {
          const breakdown: ProfitPaymentBreakdownEntry[] = Array.isArray(row.paymentBreakdown)
            ? row.paymentBreakdown
            : [];
          const matchedEntries = breakdown.filter((b) => b.paymentMethodId === selectedMethod);

          if (matchedEntries.length === 0) {
            // Only fall back to top-level paymentMethodId when breakdown wasn't populated
            if (breakdown.length === 0 && row.paymentMethodId === selectedMethod) {
              return row;
            }
            return null;
          }

          const totalBreakdownNominal = breakdown.reduce((s, b) => s + Number(b.nominal || 0), 0);
          const matchedNominal = matchedEntries.reduce((s, b) => s + Number(b.nominal || 0), 0);

          if (breakdown.length > 1 && totalBreakdownNominal > 0 && matchedNominal < totalBreakdownNominal) {
            const ratio = matchedNominal / totalBreakdownNominal;
            return {
              ...row,
              uangMasuk: Math.round(row.uangMasuk * ratio),
              uangKeluar: Math.round(row.uangKeluar * ratio),
              profit: Math.round(row.profit * ratio),
              paymentBreakdown: matchedEntries,
              paymentMethodId: selectedMethod,
              paymentMethodIds: [selectedMethod],
              paymentMethodLabel: matchedEntries[matchedEntries.length - 1].paymentMethodLabel,
              metodePembayaran: matchedEntries[matchedEntries.length - 1].paymentMethodLabel,
            };
          }

          return {
            ...row,
            paymentBreakdown: matchedEntries,
            paymentMethodId: selectedMethod,
            paymentMethodIds: [selectedMethod],
            paymentMethodLabel: matchedEntries[matchedEntries.length - 1].paymentMethodLabel,
            metodePembayaran: matchedEntries[matchedEntries.length - 1].paymentMethodLabel,
          };
        }

        return row;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [allRawSalesRows, startDate, endDate, selectedMethod, selectedCategory]);

  // 3. GROUP AND AGGREGATE BY JENIS PENGURUSAN (SECTION 2)
  const serviceGroups = useMemo(() => {
    const map: Record<string, ServiceProfitGroup> = {};

    CANONICAL_SALES_CATEGORIES.forEach((catKey) => {
      const meta = CANONICAL_SERVICES_METADATA[catKey];
      map[catKey] = {
        id: catKey,
        categoryKey: catKey,
        serviceTitle: meta?.title || catKey,
        jumlahBerkas: 0,
        totalUangMasuk: 0,
        breakdownUangMasuk: {},
        totalUangKeluar: 0,
        breakdownUangKeluar: {},
        totalProfit: 0,
        marginPercent: 0,
        items: [],
      };
    });

    filteredSalesRows.forEach((row) => {
      const catKey = row.categoryKey || "lainnya";
      if (!map[catKey]) {
        map[catKey] = {
          id: catKey,
          categoryKey: catKey,
          serviceTitle: row.serviceTitle || catKey,
          jumlahBerkas: 0,
          totalUangMasuk: 0,
          breakdownUangMasuk: {},
          totalUangKeluar: 0,
          breakdownUangKeluar: {},
          totalProfit: 0,
          marginPercent: 0,
          items: [],
        };
      }

      const g = map[catKey];
      g.jumlahBerkas += 1;
      g.totalUangMasuk += row.uangMasuk;
      g.totalUangKeluar += row.uangKeluar;
      g.totalProfit += row.profit;
      g.items.push(row);

      // Inflow breakdown by real payment method (proportional when multi-method, never phantom Tunai)
      const breakdown: ProfitPaymentBreakdownEntry[] = Array.isArray(row.paymentBreakdown)
        ? row.paymentBreakdown
        : [];
      if (breakdown.length > 0) {
        const totalB = breakdown.reduce((s, b) => s + Number(b.nominal || 0), 0);
        let allocatedSoFar = 0;
        breakdown.forEach((b, bIdx) => {
          const isLast = bIdx === breakdown.length - 1;
          const allocNominal =
            breakdown.length === 1
              ? row.uangMasuk
              : isLast
                ? Math.max(0, row.uangMasuk - allocatedSoFar)
                : totalB > 0
                  ? Math.round(row.uangMasuk * (Number(b.nominal || 0) / totalB))
                  : 0;
          allocatedSoFar += allocNominal;
          const lbl = b.paymentMethodLabel || row.paymentMethodLabel || "Belum Terhubung";
          if (!g.breakdownUangMasuk[lbl]) {
            g.breakdownUangMasuk[lbl] = { nominal: 0, count: 0 };
          }
          g.breakdownUangMasuk[lbl].nominal += allocNominal;
          g.breakdownUangMasuk[lbl].count += b.count || 1;
        });
      } else {
        const methodIn = row.paymentMethodLabel || row.metodePembayaran || "Belum Terhubung";
        if (!g.breakdownUangMasuk[methodIn]) {
          g.breakdownUangMasuk[methodIn] = { nominal: 0, count: 0 };
        }
        g.breakdownUangMasuk[methodIn].nominal += row.uangMasuk;
        g.breakdownUangMasuk[methodIn].count += 1;
      }

      // Outflow breakdown by actual bank/cash source
      const bankOut = normalizeOutflowBankName(row.bankUangKeluar);
      if (!g.breakdownUangKeluar[bankOut]) {
        g.breakdownUangKeluar[bankOut] = { nominal: 0, count: 0 };
      }
      g.breakdownUangKeluar[bankOut].nominal += row.uangKeluar;
      g.breakdownUangKeluar[bankOut].count += 1;
    });

    return Object.values(map)
      .map((g) => {
        g.marginPercent = g.totalUangMasuk > 0 ? (g.totalProfit / g.totalUangMasuk) * 100 : 0;
        return g;
      })
      .filter((g) => {
        if (selectedCategory !== "ALL") {
          return g.categoryKey === selectedCategory && g.jumlahBerkas > 0;
        }
        return g.jumlahBerkas > 0;
      });
  }, [filteredSalesRows, selectedCategory]);

  // 4. TOTAL GRAND SUMMARY (SECTION 3)
  const grandTotals = useMemo(() => {
    let berkas = 0;
    let uangMasuk = 0;
    let uangKeluar = 0;
    let profit = 0;

    serviceGroups.forEach((g) => {
      berkas += g.jumlahBerkas;
      uangMasuk += g.totalUangMasuk;
      uangKeluar += g.totalUangKeluar;
      profit += g.totalProfit;
    });

    const margin = uangMasuk > 0 ? (profit / uangMasuk) * 100 : 0;

    return {
      totalBerkas: berkas,
      totalUangMasuk: uangMasuk,
      totalUangKeluar: uangKeluar,
      totalProfit: profit,
      marginPercent: margin,
    };
  }, [serviceGroups]);

  // 5. RESOLVE PENDING BALANCES PER SERVICE CATEGORY
  const resolveCategoryKey = (pengRaw?: string | null): string => {
    const raw = (pengRaw || "").toLowerCase();
    if (raw.includes("5 tahun")) return "perpanjangan-5-tahun";
    if (raw.includes("balik nama") || raw.includes("bbn")) return "balik-nama";
    if (raw.includes("mutasi ld") || raw.includes("mutasi antar")) return "mutasi-antar-daerah";
    if (raw.includes("mutasi as") || raw.includes("mutasi asal")) return "mutasi-asal";
    if (raw.includes("tarik")) return "tarik-berkas";
    if (raw.includes("duplikat")) return "duplikat-stnk";
    if (raw.includes("1 tahun") || raw.includes("tahunan")) return "perpanjangan-1-tahun";
    return "lainnya";
  };

  const pendingByCategory = useMemo(() => {
    const map: Record<string, { profit: number; cashback: number; tagihan: number }> = {};
    CANONICAL_SALES_CATEGORIES.forEach((cat) => {
      map[cat] = { profit: 0, cashback: 0, tagihan: 0 };
    });
    map["lainnya"] = { profit: 0, cashback: 0, tagihan: 0 };

    (profitPendingList || []).forEach((item: any) => {
      const d = item.tanggal || item["Tanggal Masuk Berkas"] || item["Tanggal Uang Masuk"] || "";
      if (!matchesDateRange(d, startDate, endDate)) return;
      const cat = resolveCategoryKey(item.pengurusan || item["Jenis Pengurusan"]);
      if (!map[cat]) map[cat] = { profit: 0, cashback: 0, tagihan: 0 };
      map[cat].profit += Number(item.profit || item.estimasiProfit || 0);
    });

    (cashbackPendingList || []).forEach((item: any) => {
      const d = item.tanggal || item["Tanggal Masuk Berkas"] || item["Tanggal Uang Masuk"] || "";
      if (!matchesDateRange(d, startDate, endDate)) return;
      const cat = resolveCategoryKey(item.pengurusan || item["Jenis Pengurusan"]);
      if (!map[cat]) map[cat] = { profit: 0, cashback: 0, tagihan: 0 };
      map[cat].cashback += Number(item.jumlahCashback || item["Jumlah Cashback"] || 0);
    });

    (belumBayarList || []).forEach((item: any) => {
      const d = item.tanggal || item["Tanggal Masuk Berkas"] || item["Tanggal Uang Masuk"] || "";
      if (!matchesDateRange(d, startDate, endDate)) return;
      const cat = resolveCategoryKey(item.pengurusan || item["Jenis Pengurusan"]);
      if (!map[cat]) map[cat] = { profit: 0, cashback: 0, tagihan: 0 };
      map[cat].tagihan += Number(item.sisaTagihan ?? item.sisa ?? item.kekurangan ?? 0);
    });

    return map;
  }, [profitPendingList, cashbackPendingList, belumBayarList, startDate, endDate]);

  const pendingGrandTotals = useMemo(() => {
    let profit = 0;
    let cashback = 0;
    let tagihan = 0;

    serviceGroups.forEach((g) => {
      const p = pendingByCategory[g.categoryKey] || { profit: 0, cashback: 0, tagihan: 0 };
      profit += p.profit;
      cashback += p.cashback;
      tagihan += p.tagihan;
    });

    return {
      profitPending: profit,
      cashbackPending: cashback,
      tagihanCustomer: tagihan,
    };
  }, [serviceGroups, pendingByCategory]);

  const exportGroups: ProfitExportGroup[] = useMemo(() => {
    return serviceGroups.map((g) => {
      const p = pendingByCategory[g.categoryKey] || { profit: 0, cashback: 0, tagihan: 0 };
      return {
        id: g.id,
        categoryKey: g.categoryKey,
        serviceTitle: g.serviceTitle,
        jumlahBerkas: g.jumlahBerkas,
        totalUangMasuk: g.totalUangMasuk,
        breakdownUangMasuk: g.breakdownUangMasuk,
        totalUangKeluar: g.totalUangKeluar,
        breakdownUangKeluar: g.breakdownUangKeluar,
        totalProfit: g.totalProfit,
        marginPercent: g.marginPercent,
        profitPending: p.profit,
        cashbackPending: p.cashback,
        tagihanCustomer: p.tagihan,
      };
    });
  }, [serviceGroups, pendingByCategory]);

  // 6. EXPORT ACTION HANDLERS
  const [isExporting, setIsExporting] = useState<"csv" | "download" | "print" | null>(null);

  const getExportParams = (): ProfitExportParams => {
    const periodLabel =
      startDate && endDate
        ? `${formatDateDDMMYYYY(startDate)} s.d ${formatDateDDMMYYYY(endDate)}`
        : startDate
        ? `Mulai ${formatDateDDMMYYYY(startDate)}`
        : endDate
        ? `Sampai ${formatDateDDMMYYYY(endDate)}`
        : "Semua Data";

    const filterMethodLabel =
      selectedMethod === "ALL"
        ? "Semua Metode Pembayaran"
        : dropdownPaymentOptions.find((o) => o.id === selectedMethod)?.label ||
          paymentLabelMap.get(selectedMethod)?.displayLabel ||
          selectedMethod;

    const filterCategoryLabel =
      selectedCategory === "ALL"
        ? "Semua Pengurusan"
        : CANONICAL_SERVICES_METADATA[selectedCategory as keyof typeof CANONICAL_SERVICES_METADATA]?.title || selectedCategory;

    return {
      periodLabel,
      filterMethodLabel,
      filterCategoryLabel,
      grandTotals,
      pendingTotals: pendingGrandTotals,
      groups: exportGroups,
    };
  };

  const handleExportCSV = () => {
    if (isExporting) return;
    if (isProfitLoading) {
      toast.warning("Data profit masih dimuat, tunggu hingga selesai sebelum ekspor.");
      return;
    }
    if (effectiveProfitError) {
      toast.error("Gagal memuat data profit. Muat ulang data terlebih dahulu sebelum ekspor.");
      return;
    }
    if (serviceGroups.length === 0) {
      toast.warning("Tidak ada data transaksi profit untuk diekspor pada filter yang dipilih.");
      return;
    }
    setIsExporting("csv");
    try {
      const params = getExportParams();
      exportProfitToCSV(params);
      toast.success("Laporan Profit (CSV) berhasil diunduh.");
    } catch (err: any) {
      toast.error(err.message || "Gagal mengunduh CSV Profit.");
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportPDF = (action: "download" | "print") => {
    if (isExporting) return;
    if (isProfitLoading) {
      toast.warning("Data profit masih dimuat, tunggu hingga selesai sebelum ekspor.");
      return;
    }
    if (effectiveProfitError) {
      toast.error("Gagal memuat data profit. Muat ulang data terlebih dahulu sebelum ekspor.");
      return;
    }
    if (serviceGroups.length === 0) {
      toast.warning("Tidak ada data transaksi profit untuk diekspor pada filter yang dipilih.");
      return;
    }
    setIsExporting(action);
    try {
      const params = getExportParams();
      exportProfitToPDF(params, action);
      if (action === "download") {
        toast.success("Dokumen PDF Profit siap disimpan.");
      } else {
        toast.success("Membuka jendela cetak Laporan Profit.");
      }
    } catch (err: any) {
      toast.error(err.message || "Gagal memproses dokumen PDF Profit.");
    } finally {
      setTimeout(() => setIsExporting(null), 600);
    }
  };

  const isFiltered =
    startDate !== "" ||
    endDate !== "" ||
    selectedMethod !== "ALL" ||
    selectedCategory !== "ALL";

  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-4">
      {/* ========================================================= */}
      {/* SECTION 1: FILTER PANEL                                   */}
      {/* ========================================================= */}
      <Card className="p-4 border border-border bg-card shadow-xs">
        <div className="flex items-center justify-between mb-3 border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-primary/10 text-primary">
              <Filter className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold text-foreground">Filter Data Profit & Penjualan</h3>
              <p className="text-xs text-muted-foreground font-normal">
                Saring rincian uang masuk, pengeluaran, dan profit berdasarkan parameter transaksi
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-normal text-muted-foreground font-mono hidden sm:inline-block">
              Menampilkan <span className="font-semibold text-foreground">{filteredSalesRows.length}</span> transaksi terverifikasi
            </span>
            {isFiltered && (
              <Button
                variant="outline"
                size="sm"
                onClick={resetFilters}
                className="h-7 text-xs font-medium gap-1 text-muted-foreground hover:text-foreground border-border/80"
              >
                <RotateCcw className="w-3 h-3" />
                Reset Filter
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {/* Filter Tanggal Mulai */}
          <div className="space-y-1">
            <Label className="text-[11px] font-medium text-foreground flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-primary" />
              Tanggal Mulai
            </Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-8 text-xs font-normal bg-background"
            />
          </div>

          {/* Filter Tanggal Selesai */}
          <div className="space-y-1">
            <Label className="text-[11px] font-medium text-foreground flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-primary" />
              Tanggal Selesai
            </Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-8 text-xs font-normal bg-background"
            />
          </div>

          {/* Filter Metode Pembayaran */}
          <div className="space-y-1">
            <Label className="text-[11px] font-medium text-foreground flex items-center gap-1.5">
              <CreditCard className="w-3.5 h-3.5 text-primary" />
              Metode Pembayaran
            </Label>
            <Select value={selectedMethod} onValueChange={setSelectedMethod}>
              <SelectTrigger className="h-8 text-xs font-normal bg-background">
                <SelectValue placeholder="Semua Metode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Semua Metode Pembayaran</SelectItem>
                {dropdownPaymentOptions.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Filter Jenis Pengurusan */}
          <div className="space-y-1">
            <Label className="text-[11px] font-medium text-foreground flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-primary" />
              Jenis Pengurusan
            </Label>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="h-8 text-xs font-normal bg-background">
                <SelectValue placeholder="Semua Pengurusan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Semua Pengurusan (8 Layanan)</SelectItem>
                {CANONICAL_SALES_CATEGORIES.map((catKey) => (
                  <SelectItem key={catKey} value={catKey}>
                    {CANONICAL_SERVICES_METADATA[catKey]?.title || catKey}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      {/* ========================================================= */}
      {/* ERROR TRANSPARENCY BANNER                                 */}
      {/* ========================================================= */}
      {effectiveProfitError && !isProfitLoading && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-rose-700 dark:text-rose-300"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
            <div className="space-y-0.5">
              <p className="text-xs font-semibold">Gagal Memuat Data Profit</p>
              <p className="text-xs opacity-90">{effectiveProfitError}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRetryProfit()}
            className="h-7 text-xs font-medium gap-1.5 border-rose-500/40 bg-background hover:bg-rose-500/10 text-rose-700 dark:text-rose-300 shrink-0 self-start sm:self-auto"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Muat Ulang Data</span>
          </Button>
        </div>
      )}

      {/* ========================================================= */}
      {/* SECTION 2: TABEL REKAPITULASI PER JENIS PENGURUSAN       */}
      {/* ========================================================= */}
      <Card className="p-3.5 sm:p-4 border border-border bg-card shadow-xs flex flex-col shrink-0 overflow-hidden">
        <div className="mb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 border-b border-border/40 pb-2.5">
          <div>
            <h2 className="text-[15px] sm:text-base font-semibold text-foreground flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              Tabel Rekapitulasi Profit per Jenis Pengurusan
            </h2>
            <p className="text-xs font-normal text-muted-foreground mt-0.5">
              Rekapitulasi uang masuk, pengeluaran resmi Samsat/operasional, serta margin profit bersih per layanan
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto">
            <Badge variant="outline" className="text-[11px] font-medium font-mono bg-primary/5 text-primary border-primary/20">
              {serviceGroups.length} Kategori Layanan Aktif
            </Badge>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              disabled={isExporting !== null || isProfitLoading || Boolean(effectiveProfitError)}
              className="h-8 text-xs font-medium gap-1.5 border-border hover:bg-muted shadow-2xs"
            >
              {isExporting === "csv" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>Export CSV</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExportPDF("download")}
              disabled={isExporting !== null || isProfitLoading || Boolean(effectiveProfitError)}
              className="h-8 text-xs font-medium gap-1.5 border-border hover:bg-muted shadow-2xs"
            >
              {isExporting === "download" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FileText className="w-3.5 h-3.5" />
              )}
              <span>Export PDF</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExportPDF("print")}
              disabled={isExporting !== null || isProfitLoading || Boolean(effectiveProfitError)}
              className="h-8 text-xs font-medium gap-1.5 border-border hover:bg-muted shadow-2xs"
            >
              {isExporting === "print" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Printer className="w-3.5 h-3.5" />
              )}
              <span>Cetak Laporan</span>
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto overflow-y-auto max-h-[500px] rounded-lg border border-border">
          <table className="finance-table w-full text-xs text-left border-collapse">
            <thead className="finance-table__header bg-muted text-muted-foreground uppercase text-[11px] tracking-wider sticky top-0 z-10 border-b border-border">
              <tr>
                <th className="py-2 px-2.5 text-center w-12 font-semibold">No.</th>
                <th className="py-2 px-2.5 min-w-[200px] font-semibold">Jenis Pengurusan</th>
                <th className="py-2 px-2.5 text-center w-28 font-semibold">Jumlah Berkas</th>
                <th className="py-2 px-2.5 min-w-[240px] text-right font-semibold">
                  Jumlah Uang Masuk
                </th>
                <th className="py-2 px-2.5 min-w-[200px] text-right font-semibold">
                  Jumlah Uang Keluar (Samsat/Ops)
                </th>
                <th className="py-2 px-2.5 min-w-[140px] text-right font-semibold">Total Profit</th>
                <th className="py-2 px-2.5 text-center w-24 font-semibold">Margin %</th>
              </tr>
            </thead>
            <tbody className="finance-table__body divide-y divide-border/60">
              {isProfitLoading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted-foreground text-xs font-normal">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      <span>Memuat data profit dari server...</span>
                    </div>
                  </td>
                </tr>
              ) : effectiveProfitError ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-rose-600 dark:text-rose-400 text-xs font-normal">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <div className="inline-flex items-center gap-1.5 font-medium">
                        <AlertCircle className="w-4 h-4" />
                        <span>{effectiveProfitError}</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleRetryProfit()}
                        className="h-7 text-xs font-medium gap-1.5"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Muat Ulang Data</span>
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : serviceGroups.length > 0 ? (
                serviceGroups.map((group, idx) => {
                  const isExpanded = !!expandedBreakdown[group.categoryKey];
                  const isDeficit = group.totalProfit < 0;

                  // Sort inflow breakdown so that non-zero amounts are prominent
                  const sortedInflow = Object.entries(group.breakdownUangMasuk).sort(
                    ([, a], [, b]) => b.nominal - a.nominal
                  );

                  // Sort outflow breakdown
                  const sortedOutflow = Object.entries(group.breakdownUangKeluar).sort(
                    ([, a], [, b]) => b.nominal - a.nominal
                  );

                  return (
                    <tr
                      key={group.categoryKey}
                      className={`hover:bg-muted/30 transition-colors ${
                        isExpanded ? "bg-muted/15" : ""
                      }`}
                    >
                      {/* 1. No */}
                      <td className="py-2 px-2.5 align-top text-center font-mono text-[11px] font-normal text-muted-foreground">
                        {idx + 1}
                      </td>

                      {/* 2. Jenis Pengurusan */}
                      <td className="py-2 px-2.5 align-top">
                        <div className="flex flex-col">
                          <span className="text-xs font-semibold text-foreground">
                            {group.serviceTitle}
                          </span>
                          <span className="text-[11px] font-normal font-mono text-muted-foreground mt-0.5">
                            Kode: {group.categoryKey}
                          </span>
                        </div>
                      </td>

                      {/* 3. Jumlah Berkas */}
                      <td className="py-2 px-2.5 align-top text-center">
                        <Badge
                          variant="secondary"
                          className="text-[11px] font-medium px-2 py-0.5"
                        >
                          {group.jumlahBerkas} Berkas
                        </Badge>
                      </td>

                      {/* 4. Jumlah Uang Masuk & Rincian Expand/Collapse (NO ICONS) */}
                      <td className="py-2 px-2.5 align-top text-right">
                        <div className="flex flex-col items-end">
                          {/* Row Header: Total Uang Masuk + Chevron Toggle */}
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                              {formatRupiah(group.totalUangMasuk)}
                            </span>
                            <button
                              type="button"
                              onClick={() => toggleBreakdown(group.categoryKey)}
                              aria-expanded={isExpanded}
                              aria-label={`${isExpanded ? "Sembunyikan" : "Tampilkan"} rincian metode pembayaran ${group.serviceTitle}`}
                              className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-primary/40"
                              title={isExpanded ? "Tutup rincian metode" : "Buka rincian metode pembayaran"}
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>

                          {/* Expandable Breakdown List (Pure Text, Clean Alignment, No Icons) */}
                          {isExpanded && (
                            <div className="mt-2 pt-1.5 border-t border-border/50 flex flex-col items-end space-y-1 w-full max-w-[240px] animate-in fade-in duration-150">
                              {sortedInflow.map(([mName, data]) => (
                                <div
                                  key={mName}
                                  className="flex items-center justify-between text-[11px] w-full"
                                >
                                  <span className="font-normal text-muted-foreground text-left">
                                    {mName}
                                  </span>
                                  <span className="font-mono font-medium text-foreground/90 tabular-nums text-right ml-2">
                                    {formatRupiah(data.nominal)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* 5. Jumlah Uang Keluar (Samsat / Ops) & Rincian Rekening (NO ICONS) */}
                      <td className="py-2 px-2.5 align-top text-right">
                        <div className="flex flex-col items-end">
                          <span className="font-mono text-xs font-semibold text-rose-600 dark:text-rose-400 tabular-nums">
                            {formatRupiah(group.totalUangKeluar)}
                          </span>

                          {/* Outflow Breakdown synchronized with row expansion */}
                          {isExpanded && sortedOutflow.length > 0 && (
                            <div className="mt-2 pt-1.5 border-t border-border/50 flex flex-col items-end space-y-1 w-full max-w-[240px] animate-in fade-in duration-150">
                              {sortedOutflow.map(([bName, data]) => (
                                <div
                                  key={bName}
                                  className="flex items-center justify-between text-[11px] w-full"
                                >
                                  <span className="font-normal text-muted-foreground text-left">
                                    {bName}
                                  </span>
                                  <span className="font-mono font-medium text-foreground/90 tabular-nums text-right ml-2">
                                    {formatRupiah(data.nominal)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* 6. Total Profit */}
                      <td className="py-2 px-2.5 align-top text-right">
                        <span
                          className={`font-mono text-xs font-semibold tabular-nums ${
                            isDeficit
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {isDeficit
                            ? `-${formatRupiah(Math.abs(group.totalProfit))}`
                            : formatRupiah(group.totalProfit)}
                        </span>
                      </td>

                      {/* 7. Margin % */}
                      <td className="py-2 px-2.5 align-top text-center">
                        <Badge
                          variant="outline"
                          className={`text-[11px] font-semibold px-2 py-0.5 ${
                            isDeficit
                              ? "bg-rose-500/10 text-rose-600 border-rose-300"
                              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-300/40"
                          }`}
                        >
                          {group.marginPercent.toFixed(1)}%
                        </Badge>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted-foreground text-xs font-normal">
                    Tidak ada data penjualan atau transaksi profit yang sesuai dengan filter pencarian.
                  </td>
                </tr>
              )}
            </tbody>

            {/* BARIS TOTAL FOOTER (700 WEIGHT, RINGKAS, TANPA EXPAND) */}
            {serviceGroups.length > 0 && (
              <tfoot className="finance-table__footer bg-muted text-foreground border-t-2 border-border text-xs font-bold">
                <tr>
                  <td colSpan={2} className="py-2 px-2.5 text-left uppercase tracking-wider font-bold">
                    TOTAL KESELURUHAN (SESUAI FILTER)
                  </td>
                  <td className="py-2 px-2.5 text-center font-mono">
                    <Badge variant="default" className="text-[11px] font-semibold px-2 py-0.5">
                      {grandTotals.totalBerkas} Berkas
                    </Badge>
                  </td>
                  <td className="py-2 px-2.5 text-right font-mono text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">
                    {formatRupiah(grandTotals.totalUangMasuk)}
                  </td>
                  <td className="py-2 px-2.5 text-right font-mono text-rose-600 dark:text-rose-400 font-bold tabular-nums">
                    {formatRupiah(grandTotals.totalUangKeluar)}
                  </td>
                  <td className="py-2 px-2.5 text-right font-mono text-primary font-bold tabular-nums">
                    {formatRupiah(grandTotals.totalProfit)}
                  </td>
                  <td className="py-2 px-2.5 text-center font-mono">
                    <Badge variant="outline" className="text-[11px] font-semibold bg-primary/10 text-primary border-primary/30">
                      {grandTotals.marginPercent.toFixed(1)}%
                    </Badge>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* ========================================================= */}
      {/* SECTION 3: INFORMASI TOTAL PEMASUKAN, PENGELUARAN, PROFIT */}
      {/* ========================================================= */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* KARTU 1: TOTAL PEMASUKAN */}
        <Card className="p-4 border border-border bg-card shadow-xs flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Total Pemasukan
            </span>
            <div className="text-xl sm:text-2xl font-mono font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
              {formatRupiah(grandTotals.totalUangMasuk)}
            </div>
            <p className="text-[11px] font-normal text-muted-foreground">
              Total uang masuk dari <span className="font-semibold text-foreground">{grandTotals.totalBerkas}</span> berkas terverifikasi
            </p>
          </div>
          <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-600 border border-emerald-300/40">
            <ArrowDownLeft className="w-6 h-6" />
          </div>
        </Card>

        {/* KARTU 2: TOTAL PENGELUARAN */}
        <Card className="p-4 border border-border bg-card shadow-xs flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Total Pengeluaran
            </span>
            <div className="text-xl sm:text-2xl font-mono font-bold text-rose-600 dark:text-rose-400 tabular-nums">
              {formatRupiah(grandTotals.totalUangKeluar)}
            </div>
            <p className="text-[11px] font-normal text-muted-foreground">
              Biaya resmi Samsat & pengeluaran operasional proses
            </p>
          </div>
          <div className="p-3 rounded-xl bg-rose-500/10 text-rose-600 border border-rose-300/40">
            <ArrowUpRight className="w-6 h-6" />
          </div>
        </Card>

        {/* KARTU 3: TOTAL PROFIT BERSIH */}
        <Card className="p-4 border border-border bg-card shadow-xs flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Total Profit Bersih
            </span>
            <div className={`text-xl sm:text-2xl font-mono font-bold tabular-nums ${
              grandTotals.totalProfit < 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-primary"
            }`}>
              {formatRupiah(grandTotals.totalProfit)}
            </div>
            <p className="text-[11px] font-normal text-muted-foreground">
              Margin Keuntungan Bersih: <span className="font-semibold text-foreground">{grandTotals.marginPercent.toFixed(1)}%</span>
            </p>
          </div>
          <div className="p-3 rounded-xl bg-primary/10 text-primary border border-primary/30">
            <TrendingUp className="w-6 h-6" />
          </div>
        </Card>
      </div>
    </div>
  );
}
