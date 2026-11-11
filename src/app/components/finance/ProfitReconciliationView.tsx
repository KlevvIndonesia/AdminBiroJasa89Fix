import { useState, useMemo } from "react";
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
import { useFinanceStore, PenjualanContractCategory } from "../../data/financeStore";
import { usePaymentMethods } from "../../data/paymentMethodStore";
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
} from "lucide-react";

/**
 * Normalizes payment method name to a clean, canonical string without decorative icons.
 * Strictly filters out payment schemes/timing such as "Bayar di Awal", "Bayar di Akhir", "Tempo".
 */
export function normalizeBankMethodName(raw?: string | null): string {
  if (!raw) return "Tunai";
  const s = raw.toLowerCase().trim();

  // If input contains payment timing/scheme, reject it
  if (s.includes("bayar di awal") || s.includes("bayar di akhir") || s.includes("tempo")) {
    return "";
  }

  if (
    s.includes("cash") ||
    s.includes("tunai") ||
    s.includes("kas fisik") ||
    s.includes("kas messenger") ||
    s.includes("kas kantor")
  ) {
    return "Tunai";
  }
  if (s.includes("cimb")) return "Transfer CIMB Niaga";
  if (s.includes("bca")) return "Transfer BCA";
  if (s.includes("muamalat")) return "Transfer Muamalat";
  if (s.includes("mandiri")) return "Transfer Mandiri";
  if (s.includes("bri")) return "Transfer BRI";
  if (s.includes("bni")) return "Transfer BNI";
  if (s.includes("transfer")) return "Transfer Bank";

  // Clean raw string from unwanted prefixes
  const clean = raw.replace(/^(transfer\s+|bank\s+)/i, "").trim();
  return clean ? `Transfer ${clean}` : "Transfer Bank";
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
 * Strictly ignores "Skema Pembayaran" (Bayar di Awal / Bayar di Akhir).
 */
export function extractRealPaymentMethod(item: any): string {
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

  // Check snapshot JSON if available
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

  return "Tunai";
}

function matchesDateRange(dateStr?: string | null, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  if (!dateStr || dateStr === "-" || dateStr === "—") return false;

  let normalized = dateStr;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [d, m, y] = dateStr.split("/");
    normalized = `${y}-${m}-${d}`;
  }
  const target = normalized.slice(0, 10);
  if (start && target < start) return false;
  if (end && target > end) return false;
  return true;
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

export function ProfitReconciliationView() {
  const {
    profitList: profitData,
    getContractData,
    profitPendingList,
    cashbackPendingList,
    belumBayarList,
  } = useFinanceStore();
  const { activeMethods } = usePaymentMethods();

  // SECTION 1: FILTER STATES
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [selectedMethod, setSelectedMethod] = useState<string>("ALL");
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");

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
  };

  // 1. GATHER ALL SALES DATA FROM DATA PENJUALAN + PROFIT DATA
  const allRawSalesRows = useMemo(() => {
    const rows: any[] = [];
    const seenOrderNos = new Set<string>();

    // A. Read from each canonical category of Data Penjualan
    CANONICAL_SALES_CATEGORIES.forEach((catKey) => {
      try {
        const catRows = getContractData(catKey as PenjualanContractCategory) || [];
        catRows.forEach((r: any) => {
          const ordNo = r["Nomor Order"] || r.orderNo || r.id;
          if (ordNo && seenOrderNos.has(String(ordNo))) return;
          if (ordNo) seenOrderNos.add(String(ordNo));

          const svcTitle =
            CANONICAL_SERVICES_METADATA[catKey]?.title ||
            r["Jenis Pengurusan"] ||
            "Layanan Samsat";

          const realMethod = extractRealPaymentMethod(r);

          rows.push({
            id: r.id || ordNo,
            orderNo: ordNo,
            categoryKey: catKey,
            serviceTitle: svcTitle,
            tanggal: r["Tanggal Uang Masuk"] || r["Tanggal Masuk Berkas"] || r.tanggal || "",
            nopol: r["Plat No"] || r.nopol || "-",
            customer: r["Nama Customer"] || r.customer || "-",
            namaBerkas: r["Nama Pemilik (STNK/BPKB)"] || r.namaBerkas || "-",
            uangMasuk: Number(r["Uang Masuk dari Konsumen"] ?? r.uangMasuk ?? r.dibayar ?? 0),
            uangKeluar: Number(r["Biaya Pokok Samsat"] ?? r["Uang Keluar dari Biro Jasa"] ?? r.biayaSamsat ?? 0),
            profit: Number(r.Profit ?? r.profit ?? (Number(r["Uang Masuk dari Konsumen"] || 0) - Number(r["Biaya Pokok Samsat"] || 0))),
            metodePembayaran: realMethod,
            bankUangKeluar: r["Bank Uang Keluar"] || r.bankUangKeluar || "Kas Kantor",
            invoice: r["No Invoice"] || r.invoice || "-",
          });
        });
      } catch {}
    });

    // B. Merge any remaining items from profitData (Paid Invoices) not already captured
    profitData.forEach((p: any) => {
      const invNo = p.invoice || p.id;
      if (seenOrderNos.has(String(invNo))) return;
      seenOrderNos.add(String(invNo));

      // Resolve category key from pengurusan
      const pengRaw = (p.pengurusan || "").toLowerCase();
      let matchedCat: string = "perpanjangan-1-tahun";
      if (pengRaw.includes("5 tahun")) matchedCat = "perpanjangan-5-tahun";
      else if (pengRaw.includes("balik nama") || pengRaw.includes("bbn")) matchedCat = "balik-nama";
      else if (pengRaw.includes("mutasi ld") || pengRaw.includes("mutasi antar")) matchedCat = "mutasi-antar-daerah";
      else if (pengRaw.includes("mutasi as") || pengRaw.includes("mutasi asal")) matchedCat = "mutasi-asal";
      else if (pengRaw.includes("tarik")) matchedCat = "tarik-berkas";
      else if (pengRaw.includes("duplikat")) matchedCat = "duplikat-stnk";
      else if (pengRaw.includes("1 tahun") || pengRaw.includes("tahunan")) matchedCat = "perpanjangan-1-tahun";
      else matchedCat = "lainnya";

      const svcTitle =
        CANONICAL_SERVICES_METADATA[matchedCat as keyof typeof CANONICAL_SERVICES_METADATA]?.title ||
        p.pengurusan ||
        "Layanan Samsat";

      const realMethod = extractRealPaymentMethod(p);

      rows.push({
        id: p.id || invNo,
        orderNo: p.orderNo || invNo,
        categoryKey: matchedCat,
        serviceTitle: svcTitle,
        tanggal: p.tanggalUangMasuk || p.tanggal || "",
        nopol: p.nopol || "-",
        customer: p.customer || "-",
        namaBerkas: p.namaBerkas || "-",
        uangMasuk: Number(p.uangMasuk || 0),
        uangKeluar: Number(p.biayaSamsat || 0),
        profit: Number(p.profit || (Number(p.uangMasuk || 0) - Number(p.biayaSamsat || 0))),
        metodePembayaran: realMethod,
        bankUangKeluar: p.bankUangKeluar || "Kas Kantor",
        invoice: p.invoice || "-",
      });
    });

    return rows;
  }, [profitData, getContractData]);

  // 2. APPLY FILTERS (SECTION 1)
  const filteredSalesRows = useMemo(() => {
    return allRawSalesRows.filter((row) => {
      // Date filter
      if (!matchesDateRange(row.tanggal, startDate, endDate)) {
        return false;
      }

      // Payment Method filter
      if (selectedMethod !== "ALL") {
        const normRowMethod = row.metodePembayaran.toLowerCase();
        const normFilter = selectedMethod.toLowerCase();
        if (!normRowMethod.includes(normFilter) && !normFilter.includes(normRowMethod)) {
          return false;
        }
      }

      // Service Category filter
      if (selectedCategory !== "ALL") {
        if (row.categoryKey !== selectedCategory && row.serviceTitle !== selectedCategory) {
          return false;
        }
      }

      return true;
    });
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

      // Inflow breakdown by actual payment method (only attributing payments to real methods)
      const methodIn = row.metodePembayaran || "Tunai";
      if (!g.breakdownUangMasuk[methodIn]) {
        g.breakdownUangMasuk[methodIn] = { nominal: 0, count: 0 };
      }
      g.breakdownUangMasuk[methodIn].nominal += row.uangMasuk;
      g.breakdownUangMasuk[methodIn].count += 1;

      // Outflow breakdown by actual bank/cash source
      const bankOut = normalizeOutflowBankName(row.bankUangKeluar);
      if (!g.breakdownUangKeluar[bankOut]) {
        g.breakdownUangKeluar[bankOut] = { nominal: 0, count: 0 };
      }
      g.breakdownUangKeluar[bankOut].nominal += row.uangKeluar;
      g.breakdownUangKeluar[bankOut].count += 1;
    });

    // Ensure Tunai is present in breakdown if category has transactions (with 0 if not paid in cash)
    Object.values(map).forEach((g) => {
      if (g.totalUangMasuk > 0 && !g.breakdownUangMasuk["Tunai"]) {
        g.breakdownUangMasuk["Tunai"] = { nominal: 0, count: 0 };
      }
    });

    return Object.values(map)
      .map((g) => {
        g.marginPercent = g.totalUangMasuk > 0 ? (g.totalProfit / g.totalUangMasuk) * 100 : 0;
        return g;
      })
      .filter((g) => {
        if (selectedCategory !== "ALL") {
          return g.categoryKey === selectedCategory;
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
      selectedMethod === "ALL" ? "Semua Metode Pembayaran" : selectedMethod;

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
                <SelectItem value="Tunai">Tunai</SelectItem>
                <SelectItem value="BCA">Transfer BCA</SelectItem>
                <SelectItem value="CIMB">Transfer CIMB Niaga</SelectItem>
                <SelectItem value="Muamalat">Transfer Muamalat</SelectItem>
                <SelectItem value="Mandiri">Transfer Mandiri</SelectItem>
                {activeMethods
                  .filter((m) => !["bca", "cimb", "muamalat", "mandiri", "tunai"].some((b) => (m.bank || "").toLowerCase().includes(b)))
                  .map((m) => (
                    <SelectItem key={m.id} value={m.bank || m.nama_metode}>
                      {m.nama_metode}
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

            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExportPDF("print")}
              disabled={isExporting !== null}
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
          <table className="w-full text-xs text-left border-collapse">
            <thead className="bg-muted text-muted-foreground uppercase text-[11px] tracking-wider sticky top-0 z-10 border-b border-border">
              <tr>
                <th className="py-2.5 px-3 text-center w-12 font-semibold">No.</th>
                <th className="py-2.5 px-3 min-w-[200px] font-semibold">Jenis Pengurusan</th>
                <th className="py-2.5 px-3 text-center w-28 font-semibold">Jumlah Berkas</th>
                <th className="py-2.5 px-3 min-w-[260px] text-right font-semibold">
                  Jumlah Uang Masuk
                </th>
                <th className="py-2.5 px-3 min-w-[220px] text-right font-semibold">
                  Jumlah Uang Keluar (Samsat/Ops)
                </th>
                <th className="py-2.5 px-3 min-w-[150px] text-right font-semibold">Total Profit</th>
                <th className="py-2.5 px-3 text-center w-24 font-semibold">Margin %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {serviceGroups.length > 0 ? (
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
                      <td className="py-3 px-3 align-top text-center font-mono text-[11px] font-normal text-muted-foreground">
                        {idx + 1}
                      </td>

                      {/* 2. Jenis Pengurusan */}
                      <td className="py-3 px-3 align-top">
                        <div className="flex flex-col">
                          <span className="text-[13px] font-semibold text-foreground">
                            {group.serviceTitle}
                          </span>
                          <span className="text-[11px] font-normal font-mono text-muted-foreground mt-0.5">
                            Kode: {group.categoryKey}
                          </span>
                        </div>
                      </td>

                      {/* 3. Jumlah Berkas */}
                      <td className="py-3 px-3 align-top text-center">
                        <Badge
                          variant="secondary"
                          className="text-xs font-medium px-2 py-0.5"
                        >
                          {group.jumlahBerkas} Berkas
                        </Badge>
                      </td>

                      {/* 4. Jumlah Uang Masuk & Rincian Expand/Collapse (NO ICONS) */}
                      <td className="py-3 px-3 align-top text-right">
                        <div className="flex flex-col items-end">
                          {/* Row Header: Total Uang Masuk + Chevron Toggle */}
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="font-mono text-[13px] font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
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
                      <td className="py-3 px-3 align-top text-right">
                        <div className="flex flex-col items-end">
                          <span className="font-mono text-[13px] font-semibold text-rose-600 dark:text-rose-400 tabular-nums">
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
                      <td className="py-3 px-3 align-top text-right">
                        <span
                          className={`font-mono text-[13px] font-semibold tabular-nums ${
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
                      <td className="py-3 px-3 align-top text-center">
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
              <tfoot className="bg-muted text-foreground border-t-2 border-border text-[13px] font-bold">
                <tr>
                  <td colSpan={2} className="py-3 px-3 text-left uppercase tracking-wider font-bold">
                    TOTAL KESELURUHAN (SESUAI FILTER)
                  </td>
                  <td className="py-3 px-3 text-center font-mono">
                    <Badge variant="default" className="text-xs font-semibold px-2 py-0.5">
                      {grandTotals.totalBerkas} Berkas
                    </Badge>
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">
                    {formatRupiah(grandTotals.totalUangMasuk)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-rose-600 dark:text-rose-400 font-bold tabular-nums">
                    {formatRupiah(grandTotals.totalUangKeluar)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-primary font-bold tabular-nums">
                    {formatRupiah(grandTotals.totalProfit)}
                  </td>
                  <td className="py-3 px-3 text-center font-mono">
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
