/**
 * Finance Export Utility — Admin SUN89
 * Generates actual-data CSV with UTF-8 BOM, sanitized formula protection,
 * and high-fidelity printable/PDF documents for Laba Rugi & Profit modules.
 */

import { formatRupiah, formatDateDDMMYYYY } from "./financeFormatters";

/**
 * Neutralizes potential CSV/Formula Injection attacks.
 * Prepends a single quote if string begins with =, +, -, or @
 */
export function sanitizeCSVFormula(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/^\s*[=+\-@]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Escapes cell value according to RFC 4180 specification.
 */
export function escapeCSVCell(rawVal: any): string {
  if (rawVal === null || rawVal === undefined) return "";
  let str = String(rawVal);
  str = sanitizeCSVFormula(str);
  if (/[",\r\n;]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Triggers client-side browser file download from Blob.
 */
function triggerBlobDownload(content: string, filename: string, mimeType = "text/csv;charset=utf-8;"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    if (document.body.contains(link)) {
      document.body.removeChild(link);
    }
    URL.revokeObjectURL(url);
  }, 1500);
}

/**
 * Dispatches HTML printable document via iframe or preview window.
 */
function dispatchPrintableDocument(htmlContent: string, title: string, action: "download" | "print"): void {
  if (action === "download") {
    // Open in new preview tab with document title set so "Save as PDF" uses correct filename
    const previewWindow = window.open("", "_blank");
    if (!previewWindow) {
      throw new Error("Pop-up diblokir oleh browser. Izinkan pop-up untuk mengunduh dokumen PDF.");
    }
    previewWindow.document.open();
    previewWindow.document.write(htmlContent);
    previewWindow.document.close();
    previewWindow.focus();
    setTimeout(() => {
      try {
        previewWindow.print();
      } catch (e) {
        console.error("Auto print error:", e);
      }
    }, 500);
    return;
  }

  // Action === 'print': Use hidden iframe for seamless direct print dialog
  const printFrame = document.createElement("iframe");
  printFrame.style.position = "fixed";
  printFrame.style.right = "0";
  printFrame.style.bottom = "0";
  printFrame.style.width = "0";
  printFrame.style.height = "0";
  printFrame.style.border = "0";
  printFrame.setAttribute("aria-hidden", "true");
  document.body.appendChild(printFrame);

  const frameDoc = printFrame.contentWindow?.document;
  if (!frameDoc) {
    const fallbackWin = window.open("", "_blank");
    if (fallbackWin) {
      fallbackWin.document.open();
      fallbackWin.document.write(htmlContent);
      fallbackWin.document.close();
      fallbackWin.focus();
      setTimeout(() => fallbackWin.print(), 300);
    }
    return;
  }

  frameDoc.open();
  frameDoc.write(htmlContent);
  frameDoc.close();

  printFrame.contentWindow?.focus();
  setTimeout(() => {
    try {
      printFrame.contentWindow?.print();
    } catch (err) {
      console.error("Print error:", err);
    } finally {
      setTimeout(() => {
        if (document.body.contains(printFrame)) {
          document.body.removeChild(printFrame);
        }
      }, 2500);
    }
  }, 450);
}

// =========================================================================
// 1. LABA RUGI EXPORT INTERFACES & IMPLEMENTATIONS
// =========================================================================

export interface LabaRugiExportParams {
  periodLabel: string;
  startDate?: string;
  endDate?: string;
  componentFilters: {
    includeProfitPending: boolean;
    includeCashbackPending: boolean;
    includeTagihanCustomer: boolean;
  };
  labaBersih: {
    amount: number;
    baseAmount: number;
    isSurplus: boolean;
    basisText: string;
  };
  tableRows: {
    sumber: string;
    uangMasuk: number;
    uangKeluar: number;
    profitPending: number | null;
    cashbackPending: number | null;
    tagihanCustomer: number | null;
  }[];
  printedBy?: string;
}

/**
 * Format clean safe filename for Laba Rugi
 */
export function getLabaRugiFilename(periodLabel: string, ext: "csv" | "pdf"): string {
  const safePeriod = periodLabel
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase();
  return `Laporan-Laba-Rugi-${safePeriod || "periode"}.${ext}`;
}

/**
 * EXPORT CSV: LABA RUGI
 * - UTF-8 BOM (\uFEFF)
 * - Raw numeric amounts (no 'Rp' string) for Excel arithmetic
 * - Formula injection protected
 * - 5 Columns + 1 Source Column + Metadata Header
 */
export function exportLabaRugiToCSV(params: LabaRugiExportParams): void {
  const filename = getLabaRugiFilename(params.periodLabel, "csv");
  const now = new Date();
  const printDateTime = `${now.toLocaleDateString("id-ID")} ${now.toLocaleTimeString("id-ID")}`;

  const lines: string[] = [];

  // Metadata Section
  lines.push(`"LAPORAN","LAPORAN LABA RUGI"`);
  lines.push(`"PERUSAHAAN","SUN DELAPAN SEMBILAN"`);
  lines.push(`"PERIODE","${params.periodLabel}"`);
  lines.push(`"TANGGAL EKSPOR","${printDateTime}"`);
  lines.push(
    `"KOMPONEN DIPERHITUNGKAN","Profit Terpending: ${params.componentFilters.includeProfitPending ? "ON" : "OFF"} | Cashback Terpending: ${params.componentFilters.includeCashbackPending ? "ON" : "OFF"} | Tagihan Customer: ${params.componentFilters.includeTagihanCustomer ? "ON" : "OFF"}"`
  );
  lines.push(`"LABA RUGI BERSIH",${params.labaBersih.amount}`);
  lines.push(`"STATUS USAHA","${params.labaBersih.isSurplus ? "SURPLUS USAHA" : "DEFISIT USAHA"}"`);
  lines.push(`"BASIS PERHITUNGAN","${params.labaBersih.basisText}"`);
  lines.push(""); // empty row before table

  // Table Column Headers (Excel friendly)
  lines.push(
    [
      escapeCSVCell("Sumber Transaksi"),
      escapeCSVCell("Uang Masuk (Rp)"),
      escapeCSVCell("Uang Keluar (Rp)"),
      escapeCSVCell("Profit Terpending (Rp)"),
      escapeCSVCell("Cashback Terpending (Rp)"),
      escapeCSVCell("Tagihan Customer (Rp)"),
    ].join(",")
  );

  // Table Data Rows
  params.tableRows.forEach((row) => {
    const cols = [
      escapeCSVCell(row.sumber),
      row.uangMasuk, // numeric
      row.uangKeluar, // numeric
      row.profitPending !== null ? row.profitPending : "",
      row.cashbackPending !== null ? row.cashbackPending : "",
      row.tagihanCustomer !== null ? row.tagihanCustomer : "",
    ];
    lines.push(cols.join(","));
  });

  // Prepend UTF-8 BOM
  const csvContent = "\uFEFF" + lines.join("\r\n");
  triggerBlobDownload(csvContent, filename);
}

/**
 * EXPORT PDF / PRINT: LABA RUGI
 * - A4 Landscape layout
 * - Brand SUN DELAPAN SEMBILAN header
 * - Prominent Laba Rugi Bersih hero card
 * - Clean 5 columns + 1 source table
 * - Exact Rupiah currency & color scheme
 */
export function exportLabaRugiToPDF(params: LabaRugiExportParams, action: "download" | "print"): void {
  const filename = getLabaRugiFilename(params.periodLabel, "pdf");
  const now = new Date();
  const printDate = now.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const printTime = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const totalRow = params.tableRows.find((r) => r.sumber.toUpperCase() === "TOTAL") || params.tableRows[params.tableRows.length - 1];

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <title>${filename}</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 12mm 14mm 14mm 14mm;
    }
    @media print {
      body {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .no-print {
        display: none !important;
      }
      thead {
        display: table-header-group;
      }
      tr {
        page-break-inside: avoid;
      }
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      font-size: 9pt;
      line-height: 1.4;
      padding: 12px;
    }
    .print-toolbar {
      background: #0f172a;
      color: #ffffff;
      padding: 10px 16px;
      margin: -12px -12px 16px -12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-radius: 0 0 6px 6px;
      font-size: 11px;
    }
    .btn-action {
      background: #2563eb;
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 4px;
      font-weight: 600;
      cursor: pointer;
      font-size: 11px;
    }
    .btn-action:hover {
      background: #1d4ed8;
    }
    .header-box {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2.5px solid #0f172a;
      padding-bottom: 8px;
      margin-bottom: 12px;
    }
    .brand-title {
      font-size: 15pt;
      font-weight: 800;
      letter-spacing: -0.2px;
      color: #0f172a;
    }
    .brand-sub {
      font-size: 8.5pt;
      color: #475569;
      margin-top: 1px;
    }
    .doc-meta {
      text-align: right;
      font-size: 8pt;
      color: #475569;
    }
    .report-hero {
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-left: 5px solid ${params.labaBersih.isSurplus ? "#059669" : "#dc2626"};
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .hero-title {
      font-size: 9pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #475569;
    }
    .hero-amount {
      font-size: 17pt;
      font-weight: 800;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: ${params.labaBersih.isSurplus ? "#059669" : "#dc2626"};
      margin-top: 2px;
    }
    .hero-sub {
      font-size: 8pt;
      color: #64748b;
      margin-top: 2px;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 8pt;
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-surplus {
      background: #ecfdf5;
      color: #047857;
      border: 1px solid #a7f3d0;
    }
    .badge-deficit {
      background: #fef2f2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }
    .chips-box {
      font-size: 8pt;
      color: #475569;
      margin-top: 4px;
    }
    .chip {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      background: #e2e8f0;
      margin-right: 4px;
      font-size: 7.5pt;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 8.5pt;
    }
    thead {
      display: table-header-group;
    }
    th {
      background-color: #f1f5f9;
      color: #0f172a;
      font-weight: 700;
      border: 1px solid #cbd5e1;
      padding: 7px 8px;
      text-transform: uppercase;
      font-size: 8pt;
      letter-spacing: 0.2px;
    }
    td {
      border: 1px solid #cbd5e1;
      padding: 6.5px 8px;
    }
    tr.odd {
      background-color: #ffffff;
    }
    tr.even {
      background-color: #f8fafc;
    }
    tr.total-row {
      background-color: #f1f5f9;
      font-weight: 700;
      border-top: 2px solid #0f172a;
      border-bottom: 2px solid #0f172a;
    }
    .text-left { text-align: left; }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .text-green {
      color: #059669;
      font-weight: 600;
    }
    .text-red {
      color: #dc2626;
      font-weight: 600;
    }
    .text-neutral {
      color: #334155;
    }
    .note-box {
      margin-top: 12px;
      padding: 7px 10px;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      border-radius: 4px;
      font-size: 7.5pt;
      color: #64748b;
      line-height: 1.35;
    }
    .signatures {
      margin-top: 24px;
      display: flex;
      justify-content: space-between;
      page-break-inside: avoid;
    }
    .sig-col {
      width: 220px;
      text-align: center;
    }
    .sig-label {
      font-size: 8pt;
      color: #475569;
      margin-bottom: 45px;
    }
    .sig-line {
      border-top: 1px solid #0f172a;
      padding-top: 3px;
      font-size: 8pt;
      font-weight: 600;
    }
    .doc-footer {
      margin-top: 16px;
      border-top: 1px dashed #cbd5e1;
      padding-top: 6px;
      display: flex;
      justify-content: space-between;
      font-size: 7.5pt;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  ${
    action === "download"
      ? `<div class="print-toolbar no-print">
          <div>
            <strong>Ekspor Dokumen PDF — LAPORAN LABA RUGI</strong>
            <div style="font-size: 10px; opacity: 0.85;">Pilih "Save as PDF" / "Simpan sebagai PDF" pada dialog cetak untuk mengunduh berkas.</div>
          </div>
          <button class="btn-action" onclick="window.print()">Simpan PDF / Cetak</button>
        </div>`
      : ""
  }

  <div class="header-box">
    <div>
      <div class="brand-title">SUN DELAPAN SEMBILAN</div>
      <div class="brand-sub">Biro Jasa & Manajemen Layanan Samsat Terpadu</div>
    </div>
    <div class="doc-meta">
      <div><strong>Laporan:</strong> LAPORAN LABA RUGI</div>
      <div><strong>Periode:</strong> ${params.periodLabel}</div>
      <div><strong>Waktu Ekspor:</strong> ${printDate}, ${printTime} WIB</div>
      <div><strong>Petugas:</strong> ${params.printedBy || "Admin Keuangan"}</div>
    </div>
  </div>

  <div class="report-hero">
    <div>
      <div class="hero-title">LABA RUGI BERSIH (${params.periodLabel})</div>
      <div class="hero-amount">${formatRupiah(params.labaBersih.amount)}</div>
      <div class="hero-sub">Basis: ${params.labaBersih.basisText} &nbsp;|&nbsp; Realisasi Dasar: ${formatRupiah(params.labaBersih.baseAmount)}</div>
      <div class="chips-box">
        Filter Komponen: 
        <span class="chip">Profit Pending: ${params.componentFilters.includeProfitPending ? "ON" : "OFF"}</span>
        <span class="chip">Cashback Pending: ${params.componentFilters.includeCashbackPending ? "ON" : "OFF"}</span>
        <span class="chip">Tagihan Customer: ${params.componentFilters.includeTagihanCustomer ? "ON" : "OFF"}</span>
      </div>
    </div>
    <div style="text-align: right;">
      <span class="badge ${params.labaBersih.isSurplus ? "badge-surplus" : "badge-deficit"}">
        ${params.labaBersih.isSurplus ? "SURPLUS USAHA" : "DEFISIT USAHA"}
      </span>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="text-left" style="width: 22%;">Sumber Transaksi</th>
        <th class="text-right" style="width: 15%;">Uang Masuk</th>
        <th class="text-right" style="width: 15%;">Uang Keluar</th>
        <th class="text-right" style="width: 16%;">Profit Terpending</th>
        <th class="text-right" style="width: 16%;">Cashback Terpending</th>
        <th class="text-right" style="width: 16%;">Tagihan Customer</th>
      </tr>
    </thead>
    <tbody>
      ${params.tableRows
        .map((row, idx) => {
          const isTotal = row.sumber.toUpperCase() === "TOTAL";
          const rowClass = isTotal ? "total-row" : idx % 2 === 0 ? "even" : "odd";

          return `
            <tr class="${rowClass}">
              <td class="text-left font-semibold">${row.sumber}</td>
              <td class="text-right font-mono text-green">${formatRupiah(row.uangMasuk)}</td>
              <td class="text-right font-mono text-red">${formatRupiah(row.uangKeluar)}</td>
              <td class="text-right font-mono text-neutral">${row.profitPending !== null ? formatRupiah(row.profitPending) : "—"}</td>
              <td class="text-right font-mono text-neutral">${row.cashbackPending !== null ? formatRupiah(row.cashbackPending) : "—"}</td>
              <td class="text-right font-mono text-neutral">${row.tagihanCustomer !== null ? formatRupiah(row.tagihanCustomer) : "—"}</td>
            </tr>
          `;
        })
        .join("")}
    </tbody>
  </table>

  <div class="note-box">
    <strong>Catatan Kepatuhan Finansial:</strong> Kolom Profit Terpending, Cashback Terpending, dan Tagihan Customer murni berasal dari Data Penjualan. Mutasi transaksi internal antarkas kantor & kas messenger dieliminasi penuh (Rp 0 impact). Tagihan customer dan profit pending hanya diperhitungkan jika switch komponen terkait diaktifkan pada sistem.
  </div>

  <div class="signatures">
    <div class="sig-col">
      <div class="sig-label">Dibuat Oleh (Admin Keuangan):</div>
      <div class="sig-line">( ........................................ )</div>
    </div>
    <div class="sig-col">
      <div class="sig-label">Mengetahui (SPV Operasional):</div>
      <div class="sig-line">( ........................................ )</div>
    </div>
  </div>

  <div class="doc-footer">
    <span>Dicetak otomatis dari Sistem Administrasi Keuangan SUN89 — Dokumen resmi valid tanpa tanda tangan basah.</span>
    <span>Format Dokumen: A4 Landscape</span>
  </div>
</body>
</html>`;

  dispatchPrintableDocument(html, filename, action);
}

// =========================================================================
// 2. PROFIT EXPORT INTERFACES & IMPLEMENTATIONS
// =========================================================================

export interface ProfitExportGroup {
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
  profitPending: number;
  cashbackPending: number;
  tagihanCustomer: number;
}

export interface ProfitExportParams {
  periodLabel: string;
  filterMethodLabel: string;
  filterCategoryLabel: string;
  grandTotals: {
    totalBerkas: number;
    totalUangMasuk: number;
    totalUangKeluar: number;
    totalProfit: number;
    marginPercent: number;
  };
  pendingTotals: {
    profitPending: number;
    cashbackPending: number;
    tagihanCustomer: number;
  };
  groups: ProfitExportGroup[];
  printedBy?: string;
}

/**
 * Format clean safe filename for Profit
 */
export function getProfitFilename(periodLabel: string, ext: "csv" | "pdf"): string {
  const safePeriod = periodLabel
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase();
  return `Laporan-Profit-${safePeriod || "semua-data"}.${ext}`;
}

/**
 * Formats breakdown map into readable inline text for CSV/PDF
 * (e.g. "Transfer BCA: 886.000 (1); Transfer Bank: 500.000 (1)")
 */
function formatBreakdownInline(breakdown: Record<string, { nominal: number; count: number }>): string {
  const entries = Object.entries(breakdown).filter(([, v]) => v.nominal > 0 || v.count > 0);
  if (entries.length === 0) return "-";
  return entries
    .map(([method, val]) => `${method}: ${val.nominal.toLocaleString("id-ID")}${val.count > 0 ? ` (${val.count})` : ""}`)
    .join("; ");
}

/**
 * EXPORT CSV: PROFIT
 * - UTF-8 BOM (\uFEFF)
 * - Raw numeric amounts for Excel calculations
 * - Breakdown of payment methods per service category
 * - Formula injection protected
 * - Preserves total row
 */
export function exportProfitToCSV(params: ProfitExportParams): void {
  const filename = getProfitFilename(params.periodLabel, "csv");
  const now = new Date();
  const printDateTime = `${now.toLocaleDateString("id-ID")} ${now.toLocaleTimeString("id-ID")}`;

  const lines: string[] = [];

  // Metadata headers
  lines.push(`"LAPORAN","LAPORAN PROFIT PER JENIS PENGURUSAN"`);
  lines.push(`"PERUSAHAAN","SUN DELAPAN SEMBILAN"`);
  lines.push(`"PERIODE","${params.periodLabel}"`);
  lines.push(`"FILTER METODE PEMBAYARAN","${params.filterMethodLabel}"`);
  lines.push(`"FILTER JENIS PENGURUSAN","${params.filterCategoryLabel}"`);
  lines.push(`"TANGGAL EKSPOR","${printDateTime}"`);
  lines.push(`"TOTAL BERKAS",${params.grandTotals.totalBerkas}`);
  lines.push(`"TOTAL PEMASUKAN",${params.grandTotals.totalUangMasuk}`);
  lines.push(`"TOTAL PENGELUARAN",${params.grandTotals.totalUangKeluar}`);
  lines.push(`"TOTAL PROFIT",${params.grandTotals.totalProfit}`);
  lines.push(`"MARGIN PROFIT","${params.grandTotals.marginPercent.toFixed(1)}%"`);
  lines.push(`"TOTAL PROFIT TERPENDING",${params.pendingTotals.profitPending}`);
  lines.push(`"TOTAL CASHBACK TERPENDING",${params.pendingTotals.cashbackPending}`);
  lines.push(`"TOTAL TAGIHAN CUSTOMER",${params.pendingTotals.tagihanCustomer}`);
  lines.push(""); // empty separator row

  // Table Column Headers
  lines.push(
    [
      escapeCSVCell("No."),
      escapeCSVCell("Jenis Pengurusan"),
      escapeCSVCell("Jumlah Berkas"),
      escapeCSVCell("Total Pemasukan (Rp)"),
      escapeCSVCell("Rincian Metode Pembayaran"),
      escapeCSVCell("Total Pengeluaran (Rp)"),
      escapeCSVCell("Rincian Sumber Pengeluaran"),
      escapeCSVCell("Total Profit (Rp)"),
      escapeCSVCell("Margin %"),
      escapeCSVCell("Profit Terpending (Rp)"),
      escapeCSVCell("Cashback Terpending (Rp)"),
      escapeCSVCell("Tagihan Customer (Rp)"),
    ].join(",")
  );

  // Group Rows
  params.groups.forEach((g, idx) => {
    const row = [
      idx + 1,
      escapeCSVCell(g.serviceTitle),
      g.jumlahBerkas,
      g.totalUangMasuk, // numeric
      escapeCSVCell(formatBreakdownInline(g.breakdownUangMasuk)),
      g.totalUangKeluar, // numeric
      escapeCSVCell(formatBreakdownInline(g.breakdownUangKeluar)),
      g.totalProfit, // numeric
      escapeCSVCell(`${g.marginPercent.toFixed(1)}%`),
      g.profitPending, // numeric
      g.cashbackPending, // numeric
      g.tagihanCustomer, // numeric
    ];
    lines.push(row.join(","));
  });

  // Grand Total Row
  const totalRow = [
    escapeCSVCell("TOTAL"),
    escapeCSVCell("TOTAL KESELURUHAN"),
    params.grandTotals.totalBerkas,
    params.grandTotals.totalUangMasuk,
    escapeCSVCell(""),
    params.grandTotals.totalUangKeluar,
    escapeCSVCell(""),
    params.grandTotals.totalProfit,
    escapeCSVCell(`${params.grandTotals.marginPercent.toFixed(1)}%`),
    params.pendingTotals.profitPending,
    params.pendingTotals.cashbackPending,
    params.pendingTotals.tagihanCustomer,
  ];
  lines.push(totalRow.join(","));

  const csvContent = "\uFEFF" + lines.join("\r\n");
  triggerBlobDownload(csvContent, filename);
}

/**
 * EXPORT PDF / PRINT: PROFIT
 * - A4 Landscape layout
 * - Brand SUN DELAPAN SEMBILAN
 * - Summary KPI cards
 * - Detailed table with payment method breakdown per category even if collapsed in UI
 * - Pending columns preserved
 */
export function exportProfitToPDF(params: ProfitExportParams, action: "download" | "print"): void {
  const filename = getProfitFilename(params.periodLabel, "pdf");
  const now = new Date();
  const printDate = now.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const printTime = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <title>${filename}</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 10mm 12mm 12mm 12mm;
    }
    @media print {
      body {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .no-print {
        display: none !important;
      }
      thead {
        display: table-header-group;
      }
      tr {
        page-break-inside: avoid;
      }
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      font-size: 8pt;
      line-height: 1.35;
      padding: 10px;
    }
    .print-toolbar {
      background: #0f172a;
      color: #ffffff;
      padding: 10px 16px;
      margin: -10px -10px 14px -10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-radius: 0 0 6px 6px;
      font-size: 11px;
    }
    .btn-action {
      background: #2563eb;
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 4px;
      font-weight: 600;
      cursor: pointer;
      font-size: 11px;
    }
    .btn-action:hover {
      background: #1d4ed8;
    }
    .header-box {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2.5px solid #0f172a;
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .brand-title {
      font-size: 14pt;
      font-weight: 800;
      color: #0f172a;
    }
    .brand-sub {
      font-size: 8pt;
      color: #475569;
    }
    .doc-meta {
      text-align: right;
      font-size: 7.5pt;
      color: #475569;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }
    .kpi-card {
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 6px 8px;
      background: #f8fafc;
    }
    .kpi-label {
      font-size: 6.5pt;
      color: #64748b;
      text-transform: uppercase;
      font-weight: 700;
    }
    .kpi-value {
      font-size: 9.5pt;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      margin-top: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 7.5pt;
    }
    thead {
      display: table-header-group;
    }
    th {
      background-color: #f1f5f9;
      color: #0f172a;
      font-weight: 700;
      border: 1px solid #cbd5e1;
      padding: 6px 5px;
      text-transform: uppercase;
      font-size: 7pt;
      letter-spacing: 0.1px;
    }
    td {
      border: 1px solid #cbd5e1;
      padding: 5px 6px;
      vertical-align: top;
    }
    tr.odd {
      background-color: #ffffff;
    }
    tr.even {
      background-color: #f8fafc;
    }
    tr.total-row {
      background-color: #f1f5f9;
      font-weight: 700;
      border-top: 2px solid #0f172a;
      border-bottom: 2px solid #0f172a;
    }
    .text-left { text-align: left; }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .text-green {
      color: #059669;
      font-weight: 600;
    }
    .text-red {
      color: #dc2626;
      font-weight: 600;
    }
    .text-blue {
      color: #2563eb;
      font-weight: 600;
    }
    .method-list {
      margin-top: 3px;
      padding-top: 3px;
      border-top: 1px dashed #cbd5e1;
      font-size: 6.8pt;
      color: #475569;
      line-height: 1.3;
    }
    .method-item {
      display: flex;
      justify-content: space-between;
      gap: 6px;
    }
    .signatures {
      margin-top: 20px;
      display: flex;
      justify-content: space-between;
      page-break-inside: avoid;
    }
    .sig-col {
      width: 200px;
      text-align: center;
    }
    .sig-label {
      font-size: 7.5pt;
      color: #475569;
      margin-bottom: 40px;
    }
    .sig-line {
      border-top: 1px solid #0f172a;
      padding-top: 3px;
      font-size: 7.5pt;
      font-weight: 600;
    }
    .doc-footer {
      margin-top: 14px;
      border-top: 1px dashed #cbd5e1;
      padding-top: 5px;
      display: flex;
      justify-content: space-between;
      font-size: 7pt;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  ${
    action === "download"
      ? `<div class="print-toolbar no-print">
          <div>
            <strong>Ekspor Dokumen PDF — LAPORAN PROFIT</strong>
            <div style="font-size: 10px; opacity: 0.85;">Pilih "Save as PDF" / "Simpan sebagai PDF" pada dialog cetak untuk mengunduh dokumen.</div>
          </div>
          <button class="btn-action" onclick="window.print()">Simpan PDF / Cetak</button>
        </div>`
      : ""
  }

  <div class="header-box">
    <div>
      <div class="brand-title">SUN DELAPAN SEMBILAN</div>
      <div class="brand-sub">Biro Jasa & Manajemen Layanan Samsat Terpadu</div>
    </div>
    <div class="doc-meta">
      <div><strong>Laporan:</strong> LAPORAN PROFIT PER JENIS PENGURUSAN</div>
      <div><strong>Periode:</strong> ${params.periodLabel}</div>
      <div><strong>Filter:</strong> ${params.filterMethodLabel} &nbsp;|&nbsp; ${params.filterCategoryLabel}</div>
      <div><strong>Waktu Ekspor:</strong> ${printDate}, ${printTime} WIB</div>
      <div><strong>Petugas:</strong> ${params.printedBy || "Admin Keuangan"}</div>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Total Pemasukan</div>
      <div class="kpi-value text-green">${formatRupiah(params.grandTotals.totalUangMasuk)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Pengeluaran</div>
      <div class="kpi-value text-red">${formatRupiah(params.grandTotals.totalUangKeluar)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Profit Bersih</div>
      <div class="kpi-value text-blue">${formatRupiah(params.grandTotals.totalProfit)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Margin Keuntungan</div>
      <div class="kpi-value">${params.grandTotals.marginPercent.toFixed(1)}%</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Profit Terpending</div>
      <div class="kpi-value">${formatRupiah(params.pendingTotals.profitPending)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Tagihan Customer</div>
      <div class="kpi-value">${formatRupiah(params.pendingTotals.tagihanCustomer)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="text-center" style="width: 3%;">No.</th>
        <th class="text-left" style="width: 17%;">Jenis Pengurusan</th>
        <th class="text-center" style="width: 6%;">Berkas</th>
        <th class="text-right" style="width: 20%;">Total Uang Masuk & Rincian Metode</th>
        <th class="text-right" style="width: 17%;">Pengeluaran (Samsat/Ops)</th>
        <th class="text-right" style="width: 11%;">Total Profit</th>
        <th class="text-center" style="width: 6%;">Margin</th>
        <th class="text-right" style="width: 10%;">Profit Pending</th>
        <th class="text-right" style="width: 10%;">Tagihan Customer</th>
      </tr>
    </thead>
    <tbody>
      ${params.groups
        .map((g, idx) => {
          const rowClass = idx % 2 === 0 ? "even" : "odd";
          const inBreakdown = Object.entries(g.breakdownUangMasuk).filter(([, v]) => v.nominal > 0 || v.count > 0);
          const outBreakdown = Object.entries(g.breakdownUangKeluar).filter(([, v]) => v.nominal > 0 || v.count > 0);

          return `
            <tr class="${rowClass}">
              <td class="text-center">${idx + 1}</td>
              <td class="text-left font-semibold">${g.serviceTitle}</td>
              <td class="text-center font-mono">${g.jumlahBerkas}</td>
              <td class="text-right">
                <div class="font-mono text-green font-semibold">${formatRupiah(g.totalUangMasuk)}</div>
                ${
                  inBreakdown.length > 0
                    ? `<div class="method-list">
                        ${inBreakdown
                          .map(
                            ([m, v]) => `
                          <div class="method-item">
                            <span>${m}:</span>
                            <span class="font-mono">${formatRupiah(v.nominal)}</span>
                          </div>`
                          )
                          .join("")}
                      </div>`
                    : ""
                }
              </td>
              <td class="text-right">
                <div class="font-mono text-red font-semibold">${formatRupiah(g.totalUangKeluar)}</div>
                ${
                  outBreakdown.length > 0
                    ? `<div class="method-list">
                        ${outBreakdown
                          .map(
                            ([b, v]) => `
                          <div class="method-item">
                            <span>${b}:</span>
                            <span class="font-mono">${formatRupiah(v.nominal)}</span>
                          </div>`
                          )
                          .join("")}
                      </div>`
                    : ""
                }
              </td>
              <td class="text-right font-mono text-blue font-semibold">${formatRupiah(g.totalProfit)}</td>
              <td class="text-center font-mono font-semibold">${g.marginPercent.toFixed(1)}%</td>
              <td class="text-right font-mono text-neutral">${formatRupiah(g.profitPending)}</td>
              <td class="text-right font-mono text-neutral">${formatRupiah(g.tagihanCustomer)}</td>
            </tr>
          `;
        })
        .join("")}
      <tr class="total-row">
        <td class="text-center" colspan="2">TOTAL KESELURUHAN</td>
        <td class="text-center font-mono">${params.grandTotals.totalBerkas}</td>
        <td class="text-right font-mono text-green">${formatRupiah(params.grandTotals.totalUangMasuk)}</td>
        <td class="text-right font-mono text-red">${formatRupiah(params.grandTotals.totalUangKeluar)}</td>
        <td class="text-right font-mono text-blue">${formatRupiah(params.grandTotals.totalProfit)}</td>
        <td class="text-center font-mono">${params.grandTotals.marginPercent.toFixed(1)}%</td>
        <td class="text-right font-mono text-neutral">${formatRupiah(params.pendingTotals.profitPending)}</td>
        <td class="text-right font-mono text-neutral">${formatRupiah(params.pendingTotals.tagihanCustomer)}</td>
      </tr>
    </tbody>
  </table>

  <div class="signatures">
    <div class="sig-col">
      <div class="sig-label">Dibuat Oleh (Admin Keuangan):</div>
      <div class="sig-line">( ........................................ )</div>
    </div>
    <div class="sig-col">
      <div class="sig-label">Mengetahui (SPV Operasional):</div>
      <div class="sig-line">( ........................................ )</div>
    </div>
  </div>

  <div class="doc-footer">
    <span>Dicetak otomatis dari Sistem Administrasi Keuangan SUN89 — Valid untuk arsip internal.</span>
    <span>Format Dokumen: A4 Landscape</span>
  </div>
</body>
</html>`;

  dispatchPrintableDocument(html, filename, action);
}

// =========================================================================
// 3. GENERIC BACKWARD COMPATIBLE EXPORTS (Kept for other components)
// =========================================================================

export interface ExportColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
}

export interface SummaryMetric {
  label: string;
  value: string | number;
}

export interface CSVExportOptions {
  title: string;
  columns: ExportColumn[];
  data: any[];
  filename?: string;
  periodLabel?: string;
}

export interface PDFExportOptions {
  title: string;
  subTitle?: string;
  periodLabel: string;
  columns: ExportColumn[];
  data: any[];
  summaryMetrics?: SummaryMetric[];
  printedBy?: string;
}

export type ExportPeriodOption = "all" | "today" | "this_week" | "this_month" | "this_year" | "custom";

export function filterDataByExportPeriod(
  data: any[],
  columns: ExportColumn[],
  period: ExportPeriodOption,
  customRange?: { start?: string; end?: string }
): any[] {
  if (period === "all" || !data || data.length === 0) {
    return data;
  }

  const dateCol = columns.find((c) => {
    const k = c.key.toLowerCase();
    return k.includes("tanggal") || k.includes("tgl") || k.includes("tempo") || k.includes("date");
  });

  const dateKey = dateCol ? dateCol.key : "tanggal";

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 86400000 - 1;

  if (period === "today") {
    return data.filter((row) => {
      const ts = new Date(row[dateKey]).getTime();
      return ts >= startOfDay && ts <= endOfDay;
    });
  }

  if (period === "this_week") {
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday).getTime();
    const endOfWeek = startOfWeek + 7 * 86400000 - 1;

    return data.filter((row) => {
      const ts = new Date(row[dateKey]).getTime();
      return ts >= startOfWeek && ts <= endOfWeek;
    });
  }

  if (period === "this_month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();

    return data.filter((row) => {
      const ts = new Date(row[dateKey]).getTime();
      return ts >= startOfMonth && ts <= endOfMonth;
    });
  }

  if (period === "this_year") {
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
    const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).getTime();

    return data.filter((row) => {
      const ts = new Date(row[dateKey]).getTime();
      return ts >= startOfYear && ts <= endOfYear;
    });
  }

  if (period === "custom" && customRange?.start && customRange?.end) {
    const startCustom = new Date(customRange.start).getTime();
    const endCustom = new Date(customRange.end).getTime() + 86400000 - 1;

    return data.filter((row) => {
      const ts = new Date(row[dateKey]).getTime();
      return ts >= startCustom && ts <= endCustom;
    });
  }

  return data;
}

export function exportToCSV({ title, columns, data, filename, periodLabel }: CSVExportOptions): void {
  const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = new Date().toISOString().slice(0, 10);
  const actualFilename = filename || `AdminSUN89_${safeTitle}_${dateStr}.csv`;

  const lines: string[] = [];
  lines.push(`"LAPORAN: ${title.toUpperCase()}"`);
  if (periodLabel) lines.push(`"PERIODE: ${periodLabel}"`);
  lines.push(`"TANGGAL CETAK: ${new Date().toLocaleDateString("id-ID")}"`);
  lines.push(`"TOTAL BARIS: ${data.length}"`);
  lines.push("");

  const headers = columns.map((c) => escapeCSVCell(c.label));
  lines.push(headers.join(","));

  data.forEach((row) => {
    const rowValues = columns.map((col) => {
      const rawVal = row[col.key];
      return escapeCSVCell(rawVal);
    });
    lines.push(rowValues.join(","));
  });

  const csvContent = "\uFEFF" + lines.join("\r\n");
  triggerBlobDownload(csvContent, actualFilename);
}

export function exportToPDF(options: PDFExportOptions): void {
  // Backwards compatibility fallback using printable dispatcher
  const theadHtml = options.columns
    .map((c) => `<th style="border:1px solid #cbd5e1; padding:6px; background:#f1f5f9; text-align:${c.align || 'left'}">${c.label}</th>`)
    .join("");

  const tbodyHtml = options.data
    .map(
      (r) =>
        `<tr>${options.columns.map((c) => `<td style="border:1px solid #cbd5e1; padding:6px; text-align:${c.align || 'left'}">${r[c.key] ?? "-"}</td>`).join("")}</tr>`
    )
    .join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${options.title}</title><style>@page{size:A4 landscape;margin:10mm;}body{font-family:sans-serif;font-size:8pt;}table{width:100%;border-collapse:collapse;}</style></head><body><h2>SUN DELAPAN SEMBILAN — ${options.title}</h2><p>Periode: ${options.periodLabel}</p><br/><table><thead><tr>${theadHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table><script>window.print();</script></body></html>`;

  dispatchPrintableDocument(html, `${options.title}.pdf`, "print");
}
