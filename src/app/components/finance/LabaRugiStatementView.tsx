import { useState, useMemo } from "react";
import { Card } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { formatRupiah, formatDateDDMMYYYY } from "../../utils/financeFormatters";
import {
  exportLabaRugiToCSV,
  exportLabaRugiToPDF,
  LabaRugiExportParams,
} from "../../utils/financeExport";
import { useFinanceStore } from "../../data/financeStore";
import { toast } from "sonner";
import {
  LabaRugiTransactionRow,
  CanonicalLabaRugiSummary,
  parseDateFlexible,
  isQuarantinedInvoice,
  isInternalTransferTransaction,
} from "../../../domain/finance/labaRugiCanonical";
import { classifyFinancialTransaction } from "../../../domain/finance/types";
import {
  DAY_MS,
  getWibPartsFromEpochMs,
  matchesPeriodWib,
} from "../../../domain/finance/datePeriod";
import {
  Calendar,
  Download,
  FileText,
  TrendingUp,
  TrendingDown,
  Search,
  ExternalLink,
  Layers,
  SlidersHorizontal,
  Info,
  Loader2,
  AlertTriangle,
} from "lucide-react";

type PeriodPreset = "today" | "this_week" | "this_month" | "last_month" | "this_year" | "all" | "custom";

interface GenericDrillDownRow {
  id: string | number;
  tanggal: string;
  invoiceOrOrder: string;
  keterangan: string;
  kategori: string;
  nominal: number;
  type: "in" | "out" | "neutral";
}

interface DrillDownModalState {
  isOpen: boolean;
  title: string;
  subtitle: string;
  totalNominal: number;
  rows: GenericDrillDownRow[];
}

export function LabaRugiStatementView() {
  const {
    getCanonicalLabaRugi,
    kasKantorList,
    kasMessengerList,
    invoices,
    belumBayarList,
  } = useFinanceStore();

  // 1. PERIOD FILTER STATES (Anchored in Asia/Jakarta WIB)
  const [activePreset, setActivePreset] = useState<PeriodPreset>("this_month");
  const today = useMemo(() => new Date(), []);

  const defaultDates = useMemo(() => {
    const wib = getWibPartsFromEpochMs(today.getTime()) || getWibPartsFromEpochMs(Date.now())!;
    const { year, month, day, dayOfWeek, ymd } = wib;
    const pad2 = (n: number) => String(n).padStart(2, "0");

    // This Week (Monday .. Sunday in WIB)
    const todayWibMidMs = Date.UTC(year, month - 1, day) - 7 * 3600 * 1000;
    const diffFromMon = (dayOfWeek + 6) % 7;
    const monStart = getWibPartsFromEpochMs(todayWibMidMs - diffFromMon * DAY_MS)!;
    const sunEnd = getWibPartsFromEpochMs(todayWibMidMs - diffFromMon * DAY_MS + 6 * DAY_MS)!;

    // This Month
    const lastDayThisMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const startThisMonth = `${year}-${pad2(month)}-01`;
    const endThisMonth = `${year}-${pad2(month)}-${pad2(lastDayThisMonth)}`;

    // Last Month
    const prevMonthYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const lastDayPrevMonth = new Date(Date.UTC(prevMonthYear, prevMonth, 0)).getUTCDate();
    const startLastMonth = `${prevMonthYear}-${pad2(prevMonth)}-01`;
    const endLastMonth = `${prevMonthYear}-${pad2(prevMonth)}-${pad2(lastDayPrevMonth)}`;

    return {
      today: { start: ymd, end: ymd },
      thisWeek: { start: monStart.ymd, end: sunEnd.ymd },
      thisMonth: { start: startThisMonth, end: endThisMonth },
      lastMonth: { start: startLastMonth, end: endLastMonth },
      thisYear: { start: `${year}-01-01`, end: `${year}-12-31` },
    };
  }, [today]);

  const [startDate, setStartDate] = useState<string>(defaultDates.thisMonth.start);
  const [endDate, setEndDate] = useState<string>(defaultDates.thisMonth.end);

  const handleSelectPreset = (preset: PeriodPreset) => {
    setActivePreset(preset);
    if (preset === "today") {
      setStartDate(defaultDates.today.start);
      setEndDate(defaultDates.today.end);
    } else if (preset === "this_week") {
      setStartDate(defaultDates.thisWeek.start);
      setEndDate(defaultDates.thisWeek.end);
    } else if (preset === "this_month") {
      setStartDate(defaultDates.thisMonth.start);
      setEndDate(defaultDates.thisMonth.end);
    } else if (preset === "last_month") {
      setStartDate(defaultDates.lastMonth.start);
      setEndDate(defaultDates.lastMonth.end);
    } else if (preset === "this_year") {
      setStartDate(defaultDates.thisYear.start);
      setEndDate(defaultDates.thisYear.end);
    } else if (preset === "all") {
      setStartDate("");
      setEndDate("");
    }
  };

  // Canonical period matcher (rejects null/empty/dash/invalid dates for any bounded period)
  const isDateInPeriod = (dateStr?: string | null): boolean => {
    if (activePreset === "all") return true;
    const d = parseDateFlexible(dateStr);
    if (!d) return false;
    return matchesPeriodWib(d, "custom", today, startDate, endDate);
  };

  // 2. RETRIEVE CANONICAL LABA RUGI SUMMARY
  const canonicalSummary: CanonicalLabaRugiSummary = useMemo(() => {
    if (activePreset === "all") {
      return getCanonicalLabaRugi("all");
    }
    return getCanonicalLabaRugi("custom", startDate, endDate);
  }, [getCanonicalLabaRugi, activePreset, startDate, endDate]);

  // 3. RETRIEVE KAS KANTOR & KAS MESSENGER MUTASI IN PERIOD (Aligned with Canonical P&L Exclusion Rules)
  const voidedKantorRefs = useMemo(() => {
    const refs = new Set<string>();
    (kasKantorList || []).forEach((item) => {
      const ket = String(item.keterangan || "");
      if (ket.includes("[VOID") || ket.includes("[BATAL")) {
        const m = ket.match(/\[Ref:\s*([^\]]+)\]/);
        if (m && m[1]) refs.add(m[1].trim());
      }
    });
    return refs;
  }, [kasKantorList]);

  const filteredKasKantor = useMemo(() => {
    return (kasKantorList || []).filter((item) => {
      const ket = String(item.keterangan || "");
      if (
        (item as any).is_void ||
        item.status === "VOIDED" ||
        ket.startsWith("[VOID") ||
        ket.startsWith("[BATAL")
      ) {
        return false;
      }
      const refMatch = ket.match(/\[Ref:\s*([^\]]+)\]/);
      if (refMatch && refMatch[1] && voidedKantorRefs.has(refMatch[1].trim())) {
        return false;
      }
      if (!isDateInPeriod(item.tanggal)) return false;

      if (isInternalTransferTransaction(item)) return false;
      const classification = classifyFinancialTransaction(item);
      if (
        classification === "INTERNAL_TRANSFER" ||
        classification === "CAPITAL_INJECTION" ||
        classification === "SAMSAT_PASS_THROUGH" ||
        classification === "CUSTOMER_REFUND"
      ) {
        return false;
      }
      return true;
    });
  }, [kasKantorList, voidedKantorRefs, startDate, endDate, activePreset]);

  const kasKantorUangMasuk = useMemo(() => {
    if (canonicalSummary.kasKantorDebitNonInternal !== undefined) {
      return canonicalSummary.kasKantorDebitNonInternal;
    }
    return filteredKasKantor.reduce((sum, item) => {
      const ket = String(item.keterangan || "").toLowerCase();
      const kat = String((item as any).kategori || "").toUpperCase();
      if (kat === "PEMBAYARAN_INVOICE" || ket.startsWith("penerimaan pembayaran invoice") || Boolean((item as any).invoiceNo)) {
        return sum;
      }
      return sum + Number(item.debit || 0);
    }, 0);
  }, [canonicalSummary, filteredKasKantor]);

  const kasKantorUangKeluar = useMemo(() => {
    return canonicalSummary.pengeluaranKantor + canonicalSummary.realizedCashback;
  }, [canonicalSummary]);

  const filteredKasMessenger = useMemo(() => {
    const voidedCounts = new Map<string, number>();
    (kasMessengerList || []).forEach((item) => {
      const ket = String(item.keterangan || "");
      if (ket.includes("[VOID") || ket.includes("[BATAL")) {
        const m = ket.match(/\[Ref:\s*([^\]]+)\]/);
        if (m && m[1]) {
          const ref = m[1].trim();
          voidedCounts.set(ref, (voidedCounts.get(ref) || 0) + 1);
        }
      }
    });
    const remainingCancel = new Map(voidedCounts);

    return (kasMessengerList || []).filter((item) => {
      const ket = String(item.keterangan || "");
      if ((item as any).is_void || ket.startsWith("[VOID") || ket.startsWith("[BATAL")) return false;
      const refMatch = ket.match(/\[Ref:\s*([^\]]+)\]/);
      const refId = ((item as any).reimbursementId || (refMatch && refMatch[1] ? refMatch[1].trim() : "")) || "";
      if (refId && (remainingCancel.get(refId) || 0) > 0) {
        remainingCancel.set(refId, (remainingCancel.get(refId) || 1) - 1);
        return false;
      }
      if (isInternalTransferTransaction(item)) return false;
      const classification = classifyFinancialTransaction(item);
      if (
        classification === "INTERNAL_TRANSFER" ||
        classification === "CAPITAL_INJECTION" ||
        classification === "SAMSAT_PASS_THROUGH"
      ) {
        return false;
      }
      return isDateInPeriod(item.tanggal);
    });
  }, [kasMessengerList, startDate, endDate, activePreset]);

  const kasMessengerUangMasuk = useMemo(() => {
    if (canonicalSummary.kasMessengerInNonInternal !== undefined) {
      return canonicalSummary.kasMessengerInNonInternal;
    }
    return filteredKasMessenger.reduce(
      (sum, item) => sum + Number(item.in ?? (item as any).masuk ?? (item as any).debit ?? 0),
      0
    );
  }, [canonicalSummary, filteredKasMessenger]);

  const kasMessengerUangKeluar = useMemo(() => {
    return canonicalSummary.pengeluaranMessenger;
  }, [canonicalSummary]);

  // Invoices filtered by period for Tagihan Customer & Pending Items (excludes quarantined & cancelled)
  const periodInvoices = useMemo(() => {
    return (invoices || []).filter((inv: any) => {
      if (isQuarantinedInvoice(inv)) return false;
      if (
        inv.status === "CANCELLED" ||
        inv.billingStatus === "CANCELLED" ||
        Boolean((inv as any).isCancelled) ||
        (inv as any).is_void === 1
      ) {
        return false;
      }
      const dStr = inv.tanggalBayar || inv.tanggal || inv.tanggalInvoice || (inv as any).createdAt || "";
      return isDateInPeriod(dStr);
    });
  }, [invoices, startDate, endDate, activePreset]);

  // Filtered unpaid invoices (Tagihan Customer)
  const filteredTagihanCustomer = useMemo(() => {
    return periodInvoices.filter((inv: any) => {
      const sisa = Number(inv.sisa ?? (inv as any).sisaTagihan ?? 0);
      return sisa > 0;
    });
  }, [periodInvoices]);

  const totalTagihanCustomer = useMemo(() => {
    return canonicalSummary.pendingUnpaidBalance;
  }, [canonicalSummary]);

  // Uncollected service profit margin portion of Tagihan Customer (Accrual service fee)
  const uncollectedServiceProfit = useMemo(() => {
    let sum = 0;
    filteredTagihanCustomer.forEach((inv: any) => {
      const total = Number(inv.totalTagihan ?? (inv as any).total_tagihan ?? 0);
      const sisa = Number(inv.sisa ?? (inv as any).sisaTagihan ?? 0);
      const samsat = Number(inv.biayaSamsat ?? (inv as any).biaya_samsat ?? 0);
      if (total > 0 && sisa > 0) {
        const profitPart = Math.max(0, total - samsat);
        sum += Math.round(profitPart * (sisa / total));
      }
    });
    return sum;
  }, [filteredTagihanCustomer]);

  // Pending profit items from period
  const pendingProfitNominal = canonicalSummary.pendingProfit;
  const pendingCashbackNominal = canonicalSummary.pendingCashback;

  // 4. DATA PENJUALAN COLUMN VALUES
  const penjualanUangMasuk = canonicalSummary.totalPemasukan;
  const penjualanUangKeluar = canonicalSummary.totalBiayaSamsat;

  // 5. TOTAL ROW VALUES
  const totalColUangMasuk = penjualanUangMasuk + kasKantorUangMasuk + kasMessengerUangMasuk;
  const totalColUangKeluar = penjualanUangKeluar + kasKantorUangKeluar + kasMessengerUangKeluar;
  const totalColProfitPending = pendingProfitNominal;
  const totalColCashbackPending = pendingCashbackNominal;
  const totalColTagihanCustomer = totalTagihanCustomer;

  // 6. TOGGLE FILTERS FOR LABA RUGI BERSIH (DEFAULT: ALL OFF)
  const [includeProfitPending, setIncludeProfitPending] = useState<boolean>(false);
  const [includeCashbackPending, setIncludeCashbackPending] = useState<boolean>(false);
  const [includeTagihanCustomer, setIncludeTagihanCustomer] = useState<boolean>(false);

  // BASE LABA RUGI BERSIH (REALIZED TRANSACTIONS ONLY, WITHOUT DOUBLE COUNTING)
  const baseLabaBersih = canonicalSummary.labaRugiBersih;

  // FINAL LABA RUGI BERSIH BASED ON ACTIVE TOGGLES
  const finalLabaBersih = useMemo(() => {
    let result = baseLabaBersih;
    if (includeProfitPending) {
      result += pendingProfitNominal;
    }
    if (includeCashbackPending) {
      result -= pendingCashbackNominal;
    }
    if (includeTagihanCustomer) {
      result += uncollectedServiceProfit;
    }
    return result;
  }, [
    baseLabaBersih,
    includeProfitPending,
    includeCashbackPending,
    includeTagihanCustomer,
    pendingProfitNominal,
    pendingCashbackNominal,
    uncollectedServiceProfit,
  ]);

  // 7. DRILL DOWN STATE & MODAL
  const [drillDown, setDrillDown] = useState<DrillDownModalState>({
    isOpen: false,
    title: "",
    subtitle: "",
    totalNominal: 0,
    rows: [],
  });

  const [drillDownSearch, setDrillDownSearch] = useState<string>("");

  const filteredDrillDownRows = useMemo(() => {
    if (!drillDownSearch.trim()) return drillDown.rows;
    const q = drillDownSearch.toLowerCase();
    return drillDown.rows.filter(
      (r) =>
        r.keterangan.toLowerCase().includes(q) ||
        r.invoiceOrOrder.toLowerCase().includes(q) ||
        r.tanggal.toLowerCase().includes(q) ||
        r.kategori.toLowerCase().includes(q)
    );
  }, [drillDown.rows, drillDownSearch]);

  const openDrillDown = (
    title: string,
    subtitle: string,
    rows: GenericDrillDownRow[],
    totalNominal: number
  ) => {
    setDrillDownSearch("");
    setDrillDown({
      isOpen: true,
      title,
      subtitle,
      totalNominal,
      rows,
    });
  };

  // Helper generators for drill-down rows
  const getPenjualanMasukRows = (): GenericDrillDownRow[] => {
    return canonicalSummary.combinedTableData
      .filter((r) => r.type === "in")
      .map((r) => ({
        id: `pj-in-${r.id}`,
        tanggal: r.tanggal,
        invoiceOrOrder: r.invoice,
        keterangan: r.keterangan,
        kategori: "Penerimaan Customer",
        nominal: r.nominal,
        type: "in",
      }));
  };

  const getPenjualanKeluarRows = (): GenericDrillDownRow[] => {
    return canonicalSummary.combinedTableData
      .filter((r) => r.type === "out" && r.kategori === "Biaya samsat")
      .map((r) => ({
        id: `pj-out-${r.id}`,
        tanggal: r.tanggal,
        invoiceOrOrder: r.invoice,
        keterangan: r.keterangan,
        kategori: "Biaya Pokok Samsat",
        nominal: r.nominal,
        type: "out",
      }));
  };

  const getKasKantorMasukRows = (): GenericDrillDownRow[] => {
    return filteredKasKantor
      .filter((k) => {
        const debit = Number(k.debit || 0);
        if (debit <= 0) return false;
        const ket = String(k.keterangan || "").toLowerCase();
        const kat = String((k as any).kategori || "").toUpperCase();
        if (kat === "PEMBAYARAN_INVOICE" || ket.startsWith("penerimaan pembayaran invoice") || Boolean((k as any).invoiceNo)) {
          return false;
        }
        return true;
      })
      .map((k) => ({
        id: `kk-in-${k.id}`,
        tanggal: k.tanggal,
        invoiceOrOrder: (k as any).invoiceNo || (k as any).orderNo || "-",
        keterangan: k.keterangan || "Uang Masuk Non-Invoice Kas Kantor",
        kategori: (k as any).kategori || "Debit Kas Kantor",
        nominal: Number(k.debit || 0),
        type: "in",
      }));
  };

  const getKasKantorKeluarRows = (): GenericDrillDownRow[] => {
    const officeOpex = canonicalSummary.combinedTableData
      .filter((r) => r.type === "out" && r.kategori === "Pengeluaran kantor")
      .map((r) => ({
        id: `kk-opex-${r.id}`,
        tanggal: r.tanggal,
        invoiceOrOrder: r.invoice || "-",
        keterangan: r.keterangan,
        kategori: "Pengeluaran Kantor",
        nominal: r.nominal,
        type: "out" as const,
      }));
    const cashbackRows = periodInvoices
      .filter((inv: any) => {
        const cb = Number(inv.cashback ?? inv.cashback_nominal ?? 0);
        const st = String(inv.cashbackStatus ?? inv.cashback_status ?? "").toUpperCase();
        return cb > 0 && (st === "REALIZED" || st === "PAID" || st === "PROCESSED");
      })
      .map((inv: any) => ({
        id: `kk-cb-${inv.id}`,
        tanggal: inv.cashbackPaidAt || inv.tanggalBayar || inv.tanggal || "-",
        invoiceOrOrder: inv.invoice || inv.invoiceNo || inv.orderNo || "-",
        keterangan: `Realisasi Cashback Rekanan - ${inv.customer || "-"}`,
        kategori: "Cashback Rekanan",
        nominal: Number(inv.cashbackPaidAmount || inv.cashback || inv.cashback_nominal || 0),
        type: "out" as const,
      }));
    return [...officeOpex, ...cashbackRows];
  };

  const getKasMessengerMasukRows = (): GenericDrillDownRow[] => {
    return filteredKasMessenger
      .filter((m) => Number(m.in ?? (m as any).masuk ?? (m as any).debit ?? 0) > 0)
      .map((m) => ({
        id: `km-in-${m.id}`,
        tanggal: m.tanggal,
        invoiceOrOrder: "-",
        keterangan: `${m.keterangan || "Penerimaan Eksternal Kas Messenger"} (${m.messenger || "Kurir"})`,
        kategori: m.jenis || "Debit Kas Messenger",
        nominal: Number(m.in ?? (m as any).masuk ?? (m as any).debit ?? 0),
        type: "in",
      }));
  };

  const getKasMessengerKeluarRows = (): GenericDrillDownRow[] => {
    return canonicalSummary.combinedTableData
      .filter((r) => r.type === "out" && r.kategori.startsWith("Pengeluaran messenger"))
      .map((r) => ({
        id: `km-out-${r.id}`,
        tanggal: r.tanggal,
        invoiceOrOrder: r.invoice || "-",
        keterangan: r.keterangan,
        kategori: r.kategori,
        nominal: r.nominal,
        type: "out",
      }));
  };

  const getProfitPendingRows = (): GenericDrillDownRow[] => {
    return periodInvoices
      .filter((inv: any) => {
        const costVer = String(inv.costVerificationStatus || (inv as any).cost_verification_status || "");
        const rawSamsat = Number(inv.biayaSamsat || (inv as any).biaya_samsat || 0);
        const total = Number(inv.totalTagihan || (inv as any).total_tagihan || 0);
        return costVer === "PENDING_VERIFICATION" || rawSamsat > total;
      })
      .map((inv: any) => ({
        id: `pp-${inv.id}`,
        tanggal: inv.tanggal || (inv as any).createdAt || "-",
        invoiceOrOrder: inv.invoice || (inv as any).invoice_no || inv.orderNo || "-",
        keterangan: `${inv.customer || "Customer"} - ${(inv as any).jenisLayanan || inv.layanan || "Layanan Samsat"} (Pending Verifikasi SKKP)`,
        kategori: "Profit Terpending",
        nominal: Math.max(0, Number(inv.totalTagihan || 0) - Number(inv.biayaSamsat || 0)),
        type: "neutral",
      }));
  };

  const getCashbackPendingRows = (): GenericDrillDownRow[] => {
    return periodInvoices
      .filter((inv: any) => {
        const cbNominal = Number(inv.cashback ?? (inv as any).cashback_nominal ?? 0);
        const cbStatus = String(inv.cashbackStatus ?? (inv as any).cashback_status ?? "").toUpperCase();
        return cbNominal > 0 && cbStatus === "PENDING";
      })
      .map((inv: any) => ({
        id: `cb-${inv.id}`,
        tanggal: inv.tanggal || (inv as any).createdAt || "-",
        invoiceOrOrder: inv.invoice || (inv as any).invoice_no || inv.orderNo || "-",
        keterangan: `${inv.customer || "Customer"} - Komitmen rabat/cashback kemitraan belum dicairkan`,
        kategori: "Cashback Terpending",
        nominal: Number(inv.cashback ?? (inv as any).cashback_nominal ?? 0),
        type: "out",
      }));
  };

  const getTagihanCustomerRows = (): GenericDrillDownRow[] => {
    return filteredTagihanCustomer.map((inv: any) => ({
      id: `tc-${inv.id}`,
      tanggal: inv.tanggal || (inv as any).createdAt || "-",
      invoiceOrOrder: inv.invoice || (inv as any).invoice_no || inv.orderNo || "-",
      keterangan: `${inv.customer || "Customer"} - Sisa piutang tagihan berkas ${(inv as any).jenisLayanan || inv.layanan || "Samsat"}`,
      kategori: "Piutang Tagihan",
      nominal: Number(inv.sisa ?? (inv as any).sisaTagihan ?? 0),
      type: "neutral",
    }));
  };

  // 8. EXPORT STATE & HANDLERS
  const [isExporting, setIsExporting] = useState<"csv" | "download" | "print" | null>(null);

  const getExportParams = (): LabaRugiExportParams => {
    const periodLabel =
      activePreset === "all"
        ? "Semua Data"
        : activePreset === "today"
        ? `Hari Ini (${formatDateDDMMYYYY(startDate)})`
        : activePreset === "this_week"
        ? `Minggu Ini (${formatDateDDMMYYYY(startDate)} s.d ${formatDateDDMMYYYY(endDate)})`
        : activePreset === "this_month"
        ? `Bulan Ini (${formatDateDDMMYYYY(startDate)} s.d ${formatDateDDMMYYYY(endDate)})`
        : activePreset === "last_month"
        ? `Bulan Lalu (${formatDateDDMMYYYY(startDate)} s.d ${formatDateDDMMYYYY(endDate)})`
        : activePreset === "this_year"
        ? `Tahun Ini (${formatDateDDMMYYYY(startDate)} s.d ${formatDateDDMMYYYY(endDate)})`
        : `${formatDateDDMMYYYY(startDate)} s.d ${formatDateDDMMYYYY(endDate)}`;

    const basisText =
      !includeProfitPending && !includeCashbackPending && !includeTagihanCustomer
        ? "Transaksi Aktual Terealisasi"
        : "Penyesuaian Komponen Pilihan";

    return {
      periodLabel,
      startDate,
      endDate,
      componentFilters: {
        includeProfitPending,
        includeCashbackPending,
        includeTagihanCustomer,
      },
      labaBersih: {
        amount: finalLabaBersih,
        baseAmount: baseLabaBersih,
        isSurplus: finalLabaBersih >= 0,
        basisText,
      },
      tableRows: [
        {
          sumber: "Data Penjualan",
          uangMasuk: penjualanUangMasuk,
          uangKeluar: penjualanUangKeluar,
          profitPending: pendingProfitNominal,
          cashbackPending: pendingCashbackNominal,
          tagihanCustomer: totalTagihanCustomer,
        },
        {
          sumber: "Kas Kantor",
          uangMasuk: kasKantorUangMasuk,
          uangKeluar: kasKantorUangKeluar,
          profitPending: null,
          cashbackPending: null,
          tagihanCustomer: null,
        },
        {
          sumber: "Kas Messenger",
          uangMasuk: kasMessengerUangMasuk,
          uangKeluar: kasMessengerUangKeluar,
          profitPending: null,
          cashbackPending: null,
          tagihanCustomer: null,
        },
        {
          sumber: "TOTAL",
          uangMasuk: totalColUangMasuk,
          uangKeluar: totalColUangKeluar,
          profitPending: totalColProfitPending,
          cashbackPending: totalColCashbackPending,
          tagihanCustomer: totalColTagihanCustomer,
        },
      ],
    };
  };

  const handleExportCSV = () => {
    if (isExporting) return;
    setIsExporting("csv");
    try {
      const params = getExportParams();
      exportLabaRugiToCSV(params);
      toast.success("Laporan Laba Rugi (CSV) berhasil diunduh.");
    } catch (err: any) {
      toast.error(err.message || "Gagal mengunduh CSV Laba Rugi.");
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportPDF = (action: "download" | "print") => {
    if (isExporting) return;
    setIsExporting(action);
    try {
      const params = getExportParams();
      exportLabaRugiToPDF(params, action);
      if (action === "download") {
        toast.success("Dokumen PDF Laba Rugi siap disimpan.");
      } else {
        toast.success("Membuka jendela cetak Laporan Laba Rugi.");
      }
    } catch (err: any) {
      toast.error(err.message || "Gagal memproses dokumen PDF.");
    } finally {
      setTimeout(() => setIsExporting(null), 600);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-4 pb-8">
      {/* ========================================================= */}
      {/* 1. HEADER: LAPORAN LABA RUGI                              */}
      {/* ========================================================= */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-border/70">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[11px] font-bold tracking-wider uppercase bg-primary/10 text-primary border border-primary/20">
              Ringkasan Finansial
            </span>
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-foreground">
              Laporan Laba Rugi
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Ringkasan keuangan dari Data Penjualan, Kas Kantor, dan Kas Messenger
          </p>
        </div>

        {/* Action Buttons: Export CSV, Export PDF */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCSV}
            disabled={isExporting !== null}
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
            disabled={isExporting !== null}
            className="h-8 text-xs font-medium gap-1.5 border-border hover:bg-muted shadow-2xs"
          >
            {isExporting === "download" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FileText className="w-3.5 h-3.5" />
            )}
            <span>Export PDF</span>
          </Button>
        </div>
      </div>

      {/* ========================================================= */}
      {/* 2. FILTER PERIODE                                         */}
      {/* ========================================================= */}
      <Card className="p-3 border border-border bg-card shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
          {/* Preset Buttons */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-medium text-muted-foreground mr-1 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              Periode:
            </span>
            <Button
              variant={activePreset === "today" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSelectPreset("today")}
              className="h-7 text-xs font-medium px-2.5"
            >
              Hari Ini
            </Button>
            <Button
              variant={activePreset === "this_week" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSelectPreset("this_week")}
              className="h-7 text-xs font-medium px-2.5"
            >
              Minggu Ini
            </Button>
            <Button
              variant={activePreset === "this_month" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSelectPreset("this_month")}
              className="h-7 text-xs font-medium px-2.5"
            >
              Bulan Ini
            </Button>
            <Button
              variant={activePreset === "last_month" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSelectPreset("last_month")}
              className="h-7 text-xs font-medium px-2.5"
            >
              Bulan Lalu
            </Button>
            <Button
              variant={activePreset === "this_year" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSelectPreset("this_year")}
              className="h-7 text-xs font-medium px-2.5"
            >
              Tahun Ini
            </Button>
            <Button
              variant={activePreset === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSelectPreset("all")}
              className="h-7 text-xs font-medium px-2.5"
            >
              Semua Data
            </Button>
          </div>

          {/* Date Pickers */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Label className="text-[11px] font-normal text-muted-foreground">Mulai:</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setActivePreset("custom");
                }}
                className="h-8 text-xs w-36 bg-background font-normal"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-[11px] font-normal text-muted-foreground">Selesai:</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setActivePreset("custom");
                }}
                className="h-8 text-xs w-36 bg-background font-normal"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* ========================================================= */}
      {/* 3. HASIL AKHIR: LABA RUGI BERSIH (PROMINENT HERO CARD)    */}
      {/* ========================================================= */}
      <Card className="p-4 sm:p-5 border-2 border-primary/30 bg-primary/5 shadow-xs flex flex-col justify-between">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                Hasil Akhir
              </span>
              <Badge
                variant="outline"
                className={`text-[10px] font-semibold px-2 py-0.5 ${
                  finalLabaBersih >= 0
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-400/40"
                    : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-400/40"
                }`}
              >
                {finalLabaBersih >= 0 ? "Surplus Usaha" : "Defisit Operasional"}
              </Badge>
            </div>
            <h2 className="text-sm font-semibold text-foreground">
              LABA RUGI BERSIH
            </h2>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap pt-0.5">
              <span>
                Periode:{" "}
                <span className="font-semibold text-foreground">
                  {activePreset === "all" ? "Semua Periode" : `${startDate || "-"} s/d ${endDate || "-"}`}
                </span>
              </span>
              <span>•</span>
              <span>
                Basis:{" "}
                <span className="font-medium text-foreground">
                  {includeProfitPending || includeCashbackPending || includeTagihanCustomer
                    ? "Penyesuaian Komponen Pilihan"
                    : "Transaksi Aktual Terealisasi"}
                </span>
              </span>
            </div>
          </div>

          <div className="flex flex-col md:items-end">
            <div
              className={`text-2xl sm:text-3xl font-mono font-bold tracking-tight tabular-nums ${
                finalLabaBersih >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
            >
              {finalLabaBersih < 0 ? "-" : ""}
              {formatRupiah(Math.abs(finalLabaBersih))}
            </div>
            <div className="text-[11px] font-medium text-muted-foreground mt-0.5 flex items-center gap-1.5">
              {finalLabaBersih >= 0 ? (
                <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5 text-rose-600" />
              )}
              <span>
                {baseLabaBersih !== finalLabaBersih
                  ? `(Realisasi Dasar: ${formatRupiah(baseLabaBersih)})`
                  : "Murni realisasi kas & beban sah tanpa pending"}
              </span>
            </div>
          </div>
        </div>

        {/* Breakdown chips of active components */}
        <div className="mt-3 pt-2.5 border-t border-primary/20 flex items-center gap-2 flex-wrap text-[11px]">
          <span className="text-muted-foreground">Komponen Aktif:</span>
          <span className="px-2 py-0.5 rounded bg-background border border-border text-foreground font-mono">
            Realisasi Bersih: {formatRupiah(baseLabaBersih)}
          </span>
          {includeProfitPending && (
            <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 border border-emerald-300 font-mono">
              + Profit Pending ({formatRupiah(pendingProfitNominal)})
            </span>
          )}
          {includeCashbackPending && (
            <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-600 border border-rose-300 font-mono">
              - Cashback Pending ({formatRupiah(pendingCashbackNominal)})
            </span>
          )}
          {includeTagihanCustomer && (
            <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-600 border border-blue-300 font-mono">
              + Margin Jasa Tagihan ({formatRupiah(uncollectedServiceProfit)})
            </span>
          )}
          {!includeProfitPending && !includeCashbackPending && !includeTagihanCustomer && (
            <span className="text-muted-foreground italic">
              (Semua komponen pending dinonaktifkan — hasil murni transaksi aktual)
            </span>
          )}
          {canonicalSummary.invalidDateCount && canonicalSummary.invalidDateCount > 0 ? (
            <span
              className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-300/60 font-medium"
              title="Transaksi dengan tanggal kosong/tidak valid otomatis dikecualikan dari filter periode"
            >
              <AlertTriangle className="w-3 h-3" />
              {canonicalSummary.invalidDateCount} data bertanggal tidak valid dikecualikan dari periode
            </span>
          ) : null}
        </div>
      </Card>

      {/* ========================================================= */}
      {/* 4. TABEL UTAMA: 3 SUMBER TRANSAKSI & 5 KOLOM WAJIB        */}
      {/* ========================================================= */}
      <Card className="border border-border bg-card shadow-xs overflow-hidden">
        <div className="p-3.5 border-b border-border/70 flex items-center justify-between">
          <div>
            <h2 className="text-sm sm:text-[15px] font-semibold text-foreground flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              Tabel Rekapitulasi Finansial
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Tiga sumber transaksi operasional perusahaan (* Klik angka nominal untuk melihat transaksi pembentuknya)
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="finance-table w-full text-xs text-left border-collapse">
            <thead className="finance-table__header bg-muted text-muted-foreground uppercase text-[11px] tracking-wider border-b border-border">
              <tr>
                <th className="py-2 px-2.5 font-semibold min-w-[180px]">Sumber Transaksi</th>
                <th className="py-2 px-2.5 font-semibold text-right min-w-[140px] text-emerald-700 dark:text-emerald-400">
                  Uang Masuk
                </th>
                <th className="py-2 px-2.5 font-semibold text-right min-w-[140px] text-rose-700 dark:text-rose-400">
                  Uang Keluar
                </th>
                <th className="py-2 px-2.5 font-semibold text-right min-w-[140px]">
                  Profit Terpending
                </th>
                <th className="py-2 px-2.5 font-semibold text-right min-w-[140px]">
                  Cashback Terpending
                </th>
                <th className="py-2 px-2.5 font-semibold text-right min-w-[140px]">
                  Tagihan Customer
                </th>
              </tr>
            </thead>
            <tbody className="finance-table__body divide-y divide-border/60">
              {/* BARIS 1: DATA PENJUALAN */}
              <tr className="hover:bg-muted/30 transition-colors">
                <td className="py-2 px-2.5 font-semibold text-xs text-foreground">
                  Data Penjualan
                </td>
                {/* Uang Masuk */}
                <td className="py-2 px-2.5 text-right font-mono font-semibold text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Data Penjualan — Uang Masuk",
                        "Seluruh penerimaan pembayaran konsumen yang sah terverifikasi",
                        getPenjualanMasukRows(),
                        penjualanUangMasuk
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                    title="Klik untuk rincian transaksi"
                  >
                    {formatRupiah(penjualanUangMasuk)}
                  </button>
                </td>
                {/* Uang Keluar */}
                <td className="py-2 px-2.5 text-right font-mono font-semibold text-xs text-rose-600 dark:text-rose-400 tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Data Penjualan — Uang Keluar",
                        "Biaya pokok resmi Samsat yang diakui proporsional",
                        getPenjualanKeluarRows(),
                        penjualanUangKeluar
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                    title="Klik untuk rincian transaksi"
                  >
                    {formatRupiah(penjualanUangKeluar)}
                  </button>
                </td>
                {/* Profit Terpending */}
                <td className="py-2 px-2.5 text-right font-mono font-medium text-xs text-foreground tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Data Penjualan — Profit Terpending",
                        "Estimasi margin berkas menunggu verifikasi biaya Samsat (SKKP)",
                        getProfitPendingRows(),
                        pendingProfitNominal
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer text-muted-foreground hover:text-foreground"
                    title="Klik untuk rincian transaksi"
                  >
                    {formatRupiah(pendingProfitNominal)}
                  </button>
                </td>
                {/* Cashback Terpending */}
                <td className="py-2 px-2.5 text-right font-mono font-medium text-xs text-foreground tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Data Penjualan — Cashback Terpending",
                        "Komitmen rabat kemitraan yang belum dicairkan",
                        getCashbackPendingRows(),
                        pendingCashbackNominal
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer text-muted-foreground hover:text-foreground"
                    title="Klik untuk rincian transaksi"
                  >
                    {formatRupiah(pendingCashbackNominal)}
                  </button>
                </td>
                {/* Tagihan Customer */}
                <td className="py-2 px-2.5 text-right font-mono font-medium text-xs text-foreground tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Data Penjualan — Tagihan Customer",
                        "Sisa piutang tagihan pelanggan atas invoice yang belum lunas",
                        getTagihanCustomerRows(),
                        totalTagihanCustomer
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer text-muted-foreground hover:text-foreground"
                    title="Klik untuk rincian transaksi"
                  >
                    {formatRupiah(totalTagihanCustomer)}
                  </button>
                </td>
              </tr>

              {/* BARIS 2: KAS KANTOR */}
              <tr className="hover:bg-muted/30 transition-colors">
                <td className="py-2 px-2.5 font-semibold text-xs text-foreground">
                  Kas Kantor
                </td>
                {/* Uang Masuk */}
                <td className="py-2 px-2.5 text-right font-mono font-semibold text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Kas Kantor — Uang Masuk",
                        "Mutasi debit kas kantor & penerimaan rekening bank",
                        getKasKantorMasukRows(),
                        kasKantorUangMasuk
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                    title="Klik untuk rincian mutasi kas kantor"
                  >
                    {formatRupiah(kasKantorUangMasuk)}
                  </button>
                </td>
                {/* Uang Keluar */}
                <td className="py-2 px-2.5 text-right font-mono font-semibold text-xs text-rose-600 dark:text-rose-400 tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Kas Kantor — Uang Keluar",
                        "Pengeluaran operasional kantor & kredit rekening bank",
                        getKasKantorKeluarRows(),
                        kasKantorUangKeluar
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                    title="Klik untuk rincian mutasi kas kantor"
                  >
                    {formatRupiah(kasKantorUangKeluar)}
                  </button>
                </td>
                {/* Profit Terpending */}
                <td className="py-2 px-2.5 text-right font-mono text-muted-foreground text-center">
                  —
                </td>
                {/* Cashback Terpending */}
                <td className="py-2 px-2.5 text-right font-mono text-muted-foreground text-center">
                  —
                </td>
                {/* Tagihan Customer */}
                <td className="py-2 px-2.5 text-right font-mono text-muted-foreground text-center">
                  —
                </td>
              </tr>

              {/* BARIS 3: KAS MESSENGER */}
              <tr className="hover:bg-muted/30 transition-colors">
                <td className="py-2 px-2.5 font-semibold text-xs text-foreground">
                  Kas Messenger
                </td>
                {/* Uang Masuk */}
                <td className="py-2 px-2.5 text-right font-mono font-semibold text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Kas Messenger — Uang Masuk",
                        "Penerimaan top up & panjar operasional kurir",
                        getKasMessengerMasukRows(),
                        kasMessengerUangMasuk
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                    title="Klik untuk rincian mutasi kas messenger"
                  >
                    {formatRupiah(kasMessengerUangMasuk)}
                  </button>
                </td>
                {/* Uang Keluar */}
                <td className="py-2 px-2.5 text-right font-mono font-semibold text-xs text-rose-600 dark:text-rose-400 tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Kas Messenger — Uang Keluar",
                        "Pengeluaran lapangan kurir (BBM, tol, parkir & samsat)",
                        getKasMessengerKeluarRows(),
                        kasMessengerUangKeluar
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                    title="Klik untuk rincian mutasi kas messenger"
                  >
                    {formatRupiah(kasMessengerUangKeluar)}
                  </button>
                </td>
                {/* Profit Terpending */}
                <td className="py-2 px-2.5 text-right font-mono text-muted-foreground text-center">
                  —
                </td>
                {/* Cashback Terpending */}
                <td className="py-2 px-2.5 text-right font-mono text-muted-foreground text-center">
                  —
                </td>
                {/* Tagihan Customer */}
                <td className="py-2 px-2.5 text-right font-mono text-muted-foreground text-center">
                  —
                </td>
              </tr>
            </tbody>

            {/* BARIS 4: TOTAL KESELURUHAN */}
            <tfoot className="finance-table__footer bg-muted text-foreground border-t-2 border-border font-bold text-xs">
              <tr>
                <td className="py-2 px-2.5 text-left uppercase tracking-wider font-bold">
                  TOTAL
                </td>
                <td className="py-2 px-2.5 text-right font-mono text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Total Uang Masuk Keseluruhan",
                        "Gabungan seluruh penerimaan dari Penjualan, Kas Kantor, dan Kas Messenger",
                        [
                          ...getPenjualanMasukRows(),
                          ...getKasKantorMasukRows(),
                          ...getKasMessengerMasukRows(),
                        ],
                        totalColUangMasuk
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                  >
                    {formatRupiah(totalColUangMasuk)}
                  </button>
                </td>
                <td className="py-2 px-2.5 text-right font-mono text-rose-600 dark:text-rose-400 font-bold tabular-nums">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Total Uang Keluar Keseluruhan",
                        "Gabungan seluruh pengeluaran dari Biaya Samsat, Kas Kantor, dan Kas Messenger",
                        [
                          ...getPenjualanKeluarRows(),
                          ...getKasKantorKeluarRows(),
                          ...getKasMessengerKeluarRows(),
                        ],
                        totalColUangKeluar
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                  >
                    {formatRupiah(totalColUangKeluar)}
                  </button>
                </td>
                <td className="py-2 px-2.5 text-right font-mono font-bold tabular-nums text-foreground">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Total Profit Terpending",
                        "Total estimasi margin profit yang masih menunggu verifikasi SKKP",
                        getProfitPendingRows(),
                        totalColProfitPending
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                  >
                    {formatRupiah(totalColProfitPending)}
                  </button>
                </td>
                <td className="py-2 px-2.5 text-right font-mono font-bold tabular-nums text-foreground">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Total Cashback Terpending",
                        "Total komitmen rabat yang belum dicairkan ke pelanggan/mitra",
                        getCashbackPendingRows(),
                        totalColCashbackPending
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                  >
                    {formatRupiah(totalColCashbackPending)}
                  </button>
                </td>
                <td className="py-2 px-2.5 text-right font-mono font-bold tabular-nums text-foreground">
                  <button
                    type="button"
                    onClick={() =>
                      openDrillDown(
                        "Total Tagihan Customer",
                        "Total sisa piutang tagihan pelanggan dari invoice belum lunas",
                        getTagihanCustomerRows(),
                        totalColTagihanCustomer
                      )
                    }
                    className="hover:underline focus:outline-none cursor-pointer"
                  >
                    {formatRupiah(totalColTagihanCustomer)}
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {/* ========================================================= */}
      {/* 5. FILTER KOMPONEN YANG DIPERHITUNGKAN (3 TOGGLES)        */}
      {/* ========================================================= */}
      <Card className="p-4 border border-border bg-card shadow-xs">
        <div className="flex items-center gap-2 pb-2.5 border-b border-border/70 mb-3">
          <div className="p-1.5 rounded-md bg-primary/10 text-primary">
            <SlidersHorizontal className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Komponen yang Diperhitungkan
            </h3>
            <p className="text-xs text-muted-foreground font-normal">
              Aktifkan komponen di bawah untuk melihat pengaruhnya terhadap kalkulasi Laba Rugi Bersih (Default: OFF / tidak diperhitungkan)
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* TOGGLE 1: PROFIT TERPENDING */}
          <div className="p-3 rounded-lg border border-border bg-muted/20 flex flex-col justify-between space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5 cursor-pointer">
                <span>Profit Terpending</span>
              </Label>
              <Switch
                checked={includeProfitPending}
                onCheckedChange={setIncludeProfitPending}
              />
            </div>
            <div className="flex items-baseline justify-between pt-1">
              <span className="font-mono text-xs font-bold text-foreground">
                {formatRupiah(pendingProfitNominal)}
              </span>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                includeProfitPending
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              }`}>
                {includeProfitPending ? "+ Menambah Laba" : "OFF / Diabaikan"}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Potensi margin estimasi dari order yang belum selesai verifikasi tarif Samsat
            </p>
          </div>

          {/* TOGGLE 2: CASHBACK TERPENDING */}
          <div className="p-3 rounded-lg border border-border bg-muted/20 flex flex-col justify-between space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5 cursor-pointer">
                <span>Cashback Terpending</span>
              </Label>
              <Switch
                checked={includeCashbackPending}
                onCheckedChange={setIncludeCashbackPending}
              />
            </div>
            <div className="flex items-baseline justify-between pt-1">
              <span className="font-mono text-xs font-bold text-foreground">
                {formatRupiah(pendingCashbackNominal)}
              </span>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                includeCashbackPending
                  ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  : "bg-muted text-muted-foreground"
              }`}>
                {includeCashbackPending ? "- Mengurangi Laba" : "OFF / Diabaikan"}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Beban akrual komitmen rabat/cashback yang telah disetujui namun belum dicairkan
            </p>
          </div>

          {/* TOGGLE 3: TAGIHAN CUSTOMER */}
          <div className="p-3 rounded-lg border border-border bg-muted/20 flex flex-col justify-between space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5 cursor-pointer">
                <span>Tagihan Customer</span>
              </Label>
              <Switch
                checked={includeTagihanCustomer}
                onCheckedChange={setIncludeTagihanCustomer}
              />
            </div>
            <div className="flex items-baseline justify-between pt-1">
              <span className="font-mono text-xs font-bold text-foreground">
                {formatRupiah(totalTagihanCustomer)}
              </span>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                includeTagihanCustomer
                  ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                  : "bg-muted text-muted-foreground"
              }`}>
                {includeTagihanCustomer
                  ? `+ Margin Jasa (${formatRupiah(uncollectedServiceProfit)})`
                  : "OFF / Diabaikan"}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Diakui murni sebagai piutang margin jasa biro; biaya titipan Samsat tidak dihitung laba
            </p>
          </div>
        </div>

        <div className="mt-2.5 p-2 rounded bg-muted/30 border border-border/50 text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5 text-primary shrink-0" />
          <span>
            <strong>Aturan Pengakuan Akuntansi:</strong> Sesuai standar, perubahan filter tidak menggandakan pembayaran ataupun mengakui uang kas fisik sebelum diterima. Transfer internal antarkas kas kantor & kurir dieliminasi penuh.
          </span>
        </div>
      </Card>

      {/* ========================================================= */}
      {/* 6. MODAL RINCIAN TRANSAKSI (DRILL-DOWN)                   */}
      {/* ========================================================= */}
      <Dialog
        open={drillDown.isOpen}
        onOpenChange={(open) => setDrillDown((prev) => ({ ...prev, isOpen: open }))}
      >
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-5 bg-card border-border shadow-xl">
          <DialogHeader className="border-b border-border/70 pb-3">
            <div className="flex items-center justify-between gap-3 pr-6">
              <div>
                <DialogTitle className="text-base font-bold text-foreground flex items-center gap-2">
                  <Layers className="w-4 h-4 text-primary" />
                  {drillDown.title}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  {drillDown.subtitle}
                </DialogDescription>
              </div>
              <Badge variant="secondary" className="font-mono text-xs px-2.5 py-1">
                {drillDown.rows.length} Transaksi
              </Badge>
            </div>
          </DialogHeader>

          {/* Drill Down Controls */}
          <div className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Cari transaksi, invoice, tanggal..."
                value={drillDownSearch}
                onChange={(e) => setDrillDownSearch(e.target.value)}
                className="h-8 text-xs pl-8 bg-background font-normal"
              />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-muted-foreground">Total Nominal:</span>
              <span className="text-sm font-bold font-mono text-foreground tabular-nums">
                {formatRupiah(drillDown.totalNominal)}
              </span>
            </div>
          </div>

          {/* Drill Down Table */}
          <div className="overflow-y-auto max-h-[50vh] rounded-lg border border-border">
            <table className="finance-table w-full text-xs text-left border-collapse">
              <thead className="finance-table__header bg-muted text-muted-foreground uppercase text-[10px] tracking-wider sticky top-0 z-10 border-b border-border">
                <tr>
                  <th className="py-2 px-2.5 text-center w-12 font-semibold">No.</th>
                  <th className="py-2 px-2.5 w-28 font-semibold">Tanggal</th>
                  <th className="py-2 px-2.5 w-36 font-semibold">No. Invoice / Order</th>
                  <th className="py-2 px-2.5 min-w-[200px] font-semibold">Keterangan Transaksi</th>
                  <th className="py-2 px-2.5 w-36 font-semibold">Kategori</th>
                  <th className="py-2 px-2.5 text-right w-32 font-semibold">Nominal (Rp)</th>
                </tr>
              </thead>
              <tbody className="finance-table__body divide-y divide-border/60">
                {filteredDrillDownRows.length > 0 ? (
                  filteredDrillDownRows.map((row, idx) => (
                    <tr key={row.id || idx} className="hover:bg-muted/30 transition-colors">
                      <td className="py-2 px-3 text-center font-mono text-muted-foreground text-[11px]">
                        {idx + 1}
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] text-muted-foreground">
                        {formatDateDDMMYYYY(row.tanggal || "-")}
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] font-medium text-foreground">
                        {row.invoiceOrOrder || "-"}
                      </td>
                      <td className="py-2 px-3 text-[11px] text-foreground">
                        {row.keterangan || "-"}
                      </td>
                      <td className="py-2 px-3">
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {row.kategori}
                        </Badge>
                      </td>
                      <td className={`py-2 px-3 text-right font-mono text-[11px] font-semibold tabular-nums ${
                        row.type === "in"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : row.type === "out"
                          ? "text-rose-600 dark:text-rose-400"
                          : "text-foreground"
                      }`}>
                        {row.type === "in" ? "+" : row.type === "out" ? "-" : ""}
                        {formatRupiah(row.nominal)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted-foreground text-xs">
                      Tidak ada transaksi yang sesuai dengan filter pencarian rincian.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
