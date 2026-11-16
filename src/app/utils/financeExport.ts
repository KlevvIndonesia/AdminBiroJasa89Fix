/**
 * Finance Export Utility — Admin SUN89
 * Generates actual-data CSV with UTF-8 BOM, sanitized formula protection,
 * and high-fidelity printable/PDF documents for Laba Rugi & Profit modules.
 */

import { formatRupiah, formatDateDDMMYYYY, parseDateTimestamp } from "./financeFormatters";

/**
 * Neutralizes potential CSV/Formula Injection attacks.
 * Prepends a single quote if string begins with =, +, -, @, tab, or carriage return.
 */
export function sanitizeCSVFormula(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/^\s*[=+\-@\t\r]/.test(str)) {
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
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Escapes HTML special characters for safe printable report rendering.
 */
export function escapeHtml(val: unknown): string {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  lines.push(`"PERIODE",${escapeCSVCell(params.periodLabel)}`);
  lines.push(`"TANGGAL EKSPOR",${escapeCSVCell(printDateTime)}`);
  lines.push(
    `"KOMPONEN DIPERHITUNGKAN",${escapeCSVCell(
      `Profit Terpending: ${params.componentFilters.includeProfitPending ? "ON" : "OFF"} | Cashback Terpending: ${params.componentFilters.includeCashbackPending ? "ON" : "OFF"} | Tagihan Customer: ${params.componentFilters.includeTagihanCustomer ? "ON" : "OFF"}`
    )}`
  );
  lines.push(`"LABA RUGI BERSIH",${escapeCSVCell(params.labaBersih.amount)}`);
  lines.push(`"STATUS USAHA",${escapeCSVCell(params.labaBersih.isSurplus ? "SURPLUS USAHA" : "DEFISIT USAHA")}`);
  lines.push(`"BASIS PERHITUNGAN",${escapeCSVCell(params.labaBersih.basisText)}`);
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

  const totalRow =
    params.tableRows.find((r) => r.sumber.toUpperCase() === "TOTAL") ||
    params.tableRows[params.tableRows.length - 1] || {
      sumber: "TOTAL",
      uangMasuk: 0,
      uangKeluar: 0,
      keterangan: "-",
    };

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(filename)}</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 12mm 14mm 14mm 14mm;
      @bottom-left {
        content: "SUN BIRO JASA / ADMIN SUN89 — Dokumen Keuangan Resmi";
        font-size: 7.5pt;
        color: #64748b;
      }
      @bottom-right {
        content: "Halaman " counter(page) " dari " counter(pages);
        font-size: 7.5pt;
        color: #64748b;
      }
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
      <div class="brand-title">SUN BIRO JASA / ADMIN SUN89</div>
      <div class="brand-sub">Biro Jasa & Manajemen Layanan Samsat Terpadu</div>
    </div>
    <div class="doc-meta">
      <div><strong>Laporan:</strong> LAPORAN LABA RUGI</div>
      <div><strong>Periode:</strong> ${escapeHtml(params.periodLabel)}</div>
      <div><strong>Waktu Ekspor:</strong> ${escapeHtml(printDate)}, ${escapeHtml(printTime)} WIB</div>
      <div><strong>Petugas:</strong> ${escapeHtml(params.printedBy || "Admin Keuangan")}</div>
    </div>
  </div>

  <div class="report-hero">
    <div>
      <div class="hero-title">LABA RUGI BERSIH (${escapeHtml(params.periodLabel)})</div>
      <div class="hero-amount">${formatRupiah(params.labaBersih.amount)}</div>
      <div class="hero-sub">Basis: ${escapeHtml(params.labaBersih.basisText)} &nbsp;|&nbsp; Realisasi Dasar: ${formatRupiah(params.labaBersih.baseAmount)}</div>
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
      ${
        params.tableRows.length === 0
          ? `
            <tr class="even">
              <td colspan="6" class="text-left">Tidak ada transaksi keuangan pada periode ini.</td>
            </tr>
          `
          : params.tableRows
              .map((row, idx) => {
                const isTotal = row.sumber.toUpperCase() === "TOTAL";
                const rowClass = isTotal ? "total-row" : idx % 2 === 0 ? "even" : "odd";

                return `
            <tr class="${rowClass}">
              <td class="text-left font-semibold">${escapeHtml(row.sumber)}</td>
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
  lines.push(`${escapeCSVCell("LAPORAN")},${escapeCSVCell("LAPORAN PROFIT PER JENIS PENGURUSAN")}`);
  lines.push(`${escapeCSVCell("PERUSAHAAN")},${escapeCSVCell("SUN DELAPAN SEMBILAN")}`);
  lines.push(`${escapeCSVCell("PERIODE")},${escapeCSVCell(params.periodLabel)}`);
  lines.push(`${escapeCSVCell("FILTER METODE PEMBAYARAN")},${escapeCSVCell(params.filterMethodLabel)}`);
  lines.push(`${escapeCSVCell("FILTER JENIS PENGURUSAN")},${escapeCSVCell(params.filterCategoryLabel)}`);
  lines.push(`${escapeCSVCell("TANGGAL EKSPOR")},${escapeCSVCell(printDateTime)}`);
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
  <title>${escapeHtml(filename)}</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 10mm 12mm 13mm 12mm;
      @bottom-left {
        content: "SUN BIRO JASA / ADMIN SUN89 — Dokumen Keuangan Resmi";
        font-size: 7.5pt;
        color: #64748b;
      }
      @bottom-right {
        content: "Halaman " counter(page) " dari " counter(pages);
        font-size: 7.5pt;
        color: #64748b;
      }
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
      <div class="brand-title">SUN BIRO JASA / ADMIN SUN89</div>
      <div class="brand-sub">Biro Jasa & Manajemen Layanan Samsat Terpadu</div>
    </div>
    <div class="doc-meta">
      <div><strong>Laporan:</strong> LAPORAN PROFIT PER JENIS PENGURUSAN</div>
      <div><strong>Periode:</strong> ${escapeHtml(params.periodLabel)}</div>
      <div><strong>Filter:</strong> ${escapeHtml(params.filterMethodLabel)} &nbsp;|&nbsp; ${escapeHtml(params.filterCategoryLabel)}</div>
      <div><strong>Waktu Ekspor:</strong> ${escapeHtml(printDate)}, ${escapeHtml(printTime)} WIB</div>
      <div><strong>Petugas:</strong> ${escapeHtml(params.printedBy || "Admin Keuangan")}</div>
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
              <td class="text-left font-semibold">${escapeHtml(g.serviceTitle)}</td>
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
                            <span>${escapeHtml(m)}:</span>
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
                            <span>${escapeHtml(b)}:</span>
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
  exportValue?: (value: any, row: any, rowIndex: number) => any;
}

export interface SummaryMetric {
  label: string;
  value: string | number;
}

export interface ExportMetadataItem {
  label: string;
  value: string;
}

export interface CSVExportOptions {
  title: string;
  subTitle?: string;
  columns: ExportColumn[];
  data: any[];
  filename?: string;
  periodLabel?: string;
  metadata?: ExportMetadataItem[];
}

export interface PDFExportOptions {
  title: string;
  subTitle?: string;
  companyName?: string;
  periodLabel: string;
  columns: ExportColumn[];
  data: any[];
  summaryMetrics?: SummaryMetric[];
  metadata?: ExportMetadataItem[];
  printedBy?: string;
  orientation?: "auto" | "portrait" | "landscape";
  action?: "download" | "print";
}

export type ExportPeriodOption = "all" | "today" | "this_week" | "this_month" | "this_year" | "custom";

/**
 * Parses a row date field safely into a local epoch timestamp (ms), supporting
 * ISO YYYY-MM-DD (without UTC-shift bugs), DD/MM/YYYY, DD-MM-YYYY, and Indonesian dates.
 */
function parseExportDateTimestamp(rawVal: unknown): number {
  if (rawVal === null || rawVal === undefined) return 0;
  const str = String(rawVal).trim();
  if (!str || str === "-" || str === "—") return 0;

  // Date-only ISO string YYYY-MM-DD -> parse in local calendar day so midnight comparisons match WIB/local TZ
  const isoDateOnly = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const [, y, m, d] = isoDateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  }

  return parseDateTimestamp(str);
}

const FALLBACK_DATE_KEYS = [
  "tanggal",
  "Tanggal",
  "tanggalMasukBerkas",
  "Tanggal Masuk Berkas",
  "tanggalPengajuan",
  "tanggalOrder",
  "date",
  "created_at",
];

function resolveRowDateTimestamp(row: any, columns: ExportColumn[]): number {
  if (!row || typeof row !== "object") return 0;

  const dateCols = columns.filter((c) => {
    const k = c.key.toLowerCase();
    return k.includes("tanggal") || k.includes("tgl") || k.includes("tempo") || k.includes("date");
  });

  for (const col of dateCols) {
    if (row[col.key]) {
      const ts = parseExportDateTimestamp(row[col.key]);
      if (ts > 0) return ts;
    }
  }

  for (const key of FALLBACK_DATE_KEYS) {
    if (row[key]) {
      const ts = parseExportDateTimestamp(row[key]);
      if (ts > 0) return ts;
    }
  }

  for (const [k, v] of Object.entries(row)) {
    const lower = k.toLowerCase();
    if ((lower.includes("tanggal") || lower.includes("tgl") || lower.includes("date")) && v) {
      const ts = parseExportDateTimestamp(v);
      if (ts > 0) return ts;
    }
  }

  return 0;
}

export function filterDataByExportPeriod(
  data: any[],
  columns: ExportColumn[],
  period: ExportPeriodOption,
  customRange?: { start?: string; end?: string }
): any[] {
  if (period === "all" || !data || data.length === 0) {
    return data;
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 86400000 - 1;

  if (period === "today") {
    return data.filter((row) => {
      const ts = resolveRowDateTimestamp(row, columns);
      return ts >= startOfDay && ts <= endOfDay;
    });
  }

  if (period === "this_week") {
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday).getTime();
    const endOfWeek = startOfWeek + 7 * 86400000 - 1;

    return data.filter((row) => {
      const ts = resolveRowDateTimestamp(row, columns);
      return ts >= startOfWeek && ts <= endOfWeek;
    });
  }

  if (period === "this_month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();

    return data.filter((row) => {
      const ts = resolveRowDateTimestamp(row, columns);
      return ts >= startOfMonth && ts <= endOfMonth;
    });
  }

  if (period === "this_year") {
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
    const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).getTime();

    return data.filter((row) => {
      const ts = resolveRowDateTimestamp(row, columns);
      return ts >= startOfYear && ts <= endOfYear;
    });
  }

  if (period === "custom" && (customRange?.start || customRange?.end)) {
    const rawStart = customRange?.start ? parseExportDateTimestamp(customRange.start) : 0;
    const rawEnd = customRange?.end ? parseExportDateTimestamp(customRange.end) + 86400000 - 1 : Number.MAX_SAFE_INTEGER;
    const startCustom = rawStart && rawEnd !== Number.MAX_SAFE_INTEGER && rawStart > rawEnd ? parseExportDateTimestamp(customRange!.end!) : rawStart;
    const endCustom = rawStart && rawEnd !== Number.MAX_SAFE_INTEGER && rawStart > rawEnd ? rawStart + 86400000 - 1 : rawEnd;

    return data.filter((row) => {
      const ts = resolveRowDateTimestamp(row, columns);
      return ts > 0 && ts >= startCustom && ts <= endCustom;
    });
  }

  return data;
}

/**
 * Recursively extracts clean plain text from React elements / primitives for exports.
 */
export function extractPlainTextFromNode(node: any): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node
      .map((child) => extractPlainTextFromNode(child))
      .filter((s) => s.trim().length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (typeof node === "object" && node.props) {
    // Skip hidden decorative icons / SVG elements
    if (node.type === "svg") return "";
    return extractPlainTextFromNode(node.props.children);
  }
  return "";
}

export function isMonetaryColumnKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.includes("tanggal") || lower.includes("tgl")) return false;
  return (
    lower.includes("uang") ||
    lower.includes("biaya") ||
    lower.includes("profit") ||
    lower.includes("cashback") ||
    lower.includes("nominal") ||
    lower.includes("total") ||
    lower.includes("debit") ||
    lower.includes("kredit") ||
    lower.includes("tagihan") ||
    lower.includes("terbayar") ||
    lower.includes("sisa") ||
    lower.includes("kekurangan") ||
    lower.includes("kelebihan") ||
    lower.includes("selisih") ||
    lower.includes("saldo") ||
    lower.includes("dana") ||
    lower === "in" ||
    lower === "out"
  );
}

export function isDateColumnKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes("tanggal") || lower.includes("tgl") || lower.includes("tempo") || lower === "date";
}

export function resolveExportCellDisplay(
  col: ExportColumn,
  row: any,
  rowIndex: number,
  mode: "csv" | "pdf"
): string | number {
  const raw = row ? row[col.key] : undefined;
  let val = col.exportValue ? col.exportValue(raw, row, rowIndex) : raw;

  if (val !== null && val !== undefined && typeof val === "object") {
    val = extractPlainTextFromNode(val);
  }

  if (isMonetaryColumnKey(col.key)) {
    if (typeof val === "number" && Number.isFinite(val)) {
      return mode === "csv" ? val : formatRupiah(val);
    }
    if (val === null || val === undefined || val === "" || val === "-" || val === "—") {
      return mode === "csv" ? 0 : "-";
    }
    const parsedNum = Number(String(val).replace(/[^0-9-]/g, ""));
    if (String(val).trim().match(/^-?\s*(?:rp\.?\s*)?[\d.,]+$/i) && !Number.isNaN(parsedNum)) {
      return mode === "csv" ? parsedNum : formatRupiah(parsedNum);
    }
  }

  if (isDateColumnKey(col.key) && val !== null && val !== undefined && val !== "" && val !== "-" && val !== "—") {
    return formatDateDDMMYYYY(String(val));
  }

  if (val === null || val === undefined || val === "") {
    return mode === "csv" ? "" : "-";
  }

  return typeof val === "number"
    ? val
    : String(val)
        .replace(/[ \t]+/g, " ")
        .replace(/\r?\n+/g, mode === "csv" ? "\n" : " ")
        .trim();
}

export function getFinanceExportFilename(title: string, ext: "csv" | "pdf", periodLabel?: string): string {
  const cleanPart = (val: string) =>
    val
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const safeTitle = cleanPart(title) || "Laporan_Keuangan";
  const safePeriod = periodLabel ? `_${cleanPart(periodLabel).slice(0, 32)}` : "";
  const dateStr = new Date().toISOString().slice(0, 10);
  return `AdminSUN89_${safeTitle}${safePeriod}_${dateStr}.${ext}`;
}

export function buildFinanceCSVContent({
  title,
  columns,
  data,
  periodLabel,
  metadata = [],
}: CSVExportOptions): string {
  if (!columns || columns.length === 0) {
    throw new Error("Minimal satu kolom harus dipilih untuk diekspor ke CSV.");
  }

  const now = new Date();
  const printDateTime = `${now.toLocaleDateString("id-ID")} ${now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

  const lines: string[] = [];
  lines.push([escapeCSVCell("LAPORAN"), escapeCSVCell(title.toUpperCase())].join(","));
  lines.push([escapeCSVCell("PERUSAHAAN"), escapeCSVCell("SUN BIRO JASA / ADMIN SUN89")].join(","));
  if (periodLabel) {
    lines.push([escapeCSVCell("PERIODE"), escapeCSVCell(periodLabel)].join(","));
  }
  metadata.forEach((m) => {
    lines.push([escapeCSVCell(m.label.toUpperCase()), escapeCSVCell(m.value)].join(","));
  });
  lines.push([escapeCSVCell("TANGGAL EKSPOR"), escapeCSVCell(printDateTime)].join(","));
  lines.push([escapeCSVCell("TOTAL DATA"), String(data.length)].join(","));
  lines.push("");

  const headers = columns.map((c) => escapeCSVCell(c.label));
  lines.push(headers.join(","));

  data.forEach((row, rowIdx) => {
    const rowValues = columns.map((col) => {
      const resolved = resolveExportCellDisplay(col, row, rowIdx, "csv");
      if (typeof resolved === "number" && Number.isFinite(resolved)) {
        return String(resolved);
      }
      return escapeCSVCell(resolved);
    });
    lines.push(rowValues.join(","));
  });

  return "\uFEFF" + lines.join("\r\n");
}

export function exportToCSV(options: CSVExportOptions): void {
  const actualFilename =
    options.filename || getFinanceExportFilename(options.title, "csv", options.periodLabel);
  const csvContent = buildFinanceCSVContent(options);
  triggerBlobDownload(csvContent, actualFilename);
}

/**
 * Automatically selects A4 Portrait vs Landscape based on column count & estimated horizontal width.
 */
export function resolvePdfOrientation(
  columns: ExportColumn[],
  data: any[] = [],
  requestedOrientation: "auto" | "portrait" | "landscape" = "auto"
): "portrait" | "landscape" {
  if (requestedOrientation === "portrait" || requestedOrientation === "landscape") {
    return requestedOrientation;
  }

  const colCount = columns.length;
  if (colCount >= 7) {
    return "landscape";
  }

  const sample = data.slice(0, 25);
  let estimatedWidthPx = 42; // Base No. column

  for (const col of columns) {
    const k = col.key.toLowerCase();
    let baseWidth = Math.max(80, Math.min(180, col.label.length * 7.5 + 24));

    if (k.includes("keterangan") || k.includes("catatan") || k.includes("alamat") || k.includes("detail")) {
      baseWidth = Math.max(baseWidth, 175);
    } else if (k.includes("payment") || k.includes("metode") || k.includes("bank")) {
      baseWidth = Math.max(baseWidth, 150);
    } else if (k.includes("customer") || k.includes("nama") || k.includes("pengurusan") || k.includes("layanan")) {
      baseWidth = Math.max(baseWidth, 135);
    } else if (isMonetaryColumnKey(col.key)) {
      baseWidth = Math.max(baseWidth, 112);
    } else if (isDateColumnKey(col.key) || k.includes("nopol") || k.includes("plat") || k.includes("status")) {
      baseWidth = Math.max(baseWidth, 88);
    }

    if (sample.length > 0) {
      let maxSampleLen = 0;
      for (let i = 0; i < sample.length; i++) {
        const text = String(resolveExportCellDisplay(col, sample[i], i, "pdf"));
        if (text.length > maxSampleLen) maxSampleLen = text.length;
      }
      baseWidth = Math.max(baseWidth, Math.min(200, maxSampleLen * 6.2 + 18));
    }

    estimatedWidthPx += baseWidth;
  }

  return estimatedWidthPx > 680 ? "landscape" : "portrait";
}

export function buildFinancePDFHtml(options: PDFExportOptions): string {
  const {
    title,
    subTitle = "Laporan Operasional & Keuangan Terintegrasi",
    companyName = "SUN BIRO JASA / ADMIN SUN89",
    periodLabel,
    columns,
    data,
    summaryMetrics = [],
    metadata = [],
    printedBy,
    orientation: requestedOrientation = "auto",
  } = options;

  if (!columns || columns.length === 0) {
    throw new Error("Minimal satu kolom harus dipilih untuk dicetak ke PDF.");
  }

  const orientation = resolvePdfOrientation(columns, data, requestedOrientation);
  const now = new Date();
  const currentDate = `${now.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })}, ${now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  })} WIB`;

  const isUltraWide = columns.length >= 18;
  const isDenseWide = columns.length >= 12;

  const bodyFontSize =
    columns.length >= 26
      ? "5.25pt"
      : isUltraWide
        ? "6pt"
        : isDenseWide
          ? "7.5pt"
          : columns.length >= 8
            ? "8.25pt"
            : orientation === "portrait"
              ? "9pt"
              : "8.75pt";
  const headerFontSize =
    columns.length >= 26
      ? "4.85pt"
      : isUltraWide
        ? "5.5pt"
        : isDenseWide
          ? "7pt"
          : columns.length >= 8
            ? "7.5pt"
            : "8pt";
  const cellPadding =
    columns.length >= 26
      ? "2px 2.5px"
      : isUltraWide
        ? "2.5px 3.5px"
        : columns.length >= 11
          ? "4.5px 5px"
          : "6px 7px";
  const noColWidth = columns.length >= 26 ? "18px" : isUltraWide ? "24px" : "34px";
  const pageMarginCss = isUltraWide ? "8mm 6mm 12mm 6mm" : "10mm 11mm 13mm 11mm";
  const tableZoomCss = columns.length >= 26 ? "0.86" : "1";

  const metaItems: ExportMetadataItem[] = [
    ...(periodLabel ? [{ label: "Periode", value: periodLabel }] : []),
    ...metadata,
    ...(printedBy ? [{ label: "Dicetak Oleh", value: printedBy }] : []),
    { label: "Total Data", value: `${data.length} Baris` },
  ];

  const metadataHtml = metaItems
    .map(
      (m) => `
      <div class="meta-item">
        <span class="meta-label">${escapeHtml(m.label)}:</span>
        <span class="meta-value">${escapeHtml(m.value)}</span>
      </div>`
    )
    .join("");

  const summaryHtml =
    summaryMetrics.length > 0
      ? `<div class="summary-grid">${summaryMetrics
          .map(
            (s) => `
          <div class="summary-card">
            <div class="summary-label">${escapeHtml(s.label)}</div>
            <div class="summary-value">${escapeHtml(s.value)}</div>
          </div>`
          )
          .join("")}</div>`
      : "";

  const headerCellsHtml = [
    `<th class="text-center" style="width: ${noColWidth};">No</th>`,
    ...columns.map((col) => {
      const align = col.align || (isMonetaryColumnKey(col.key) ? "right" : "left");
      return `<th class="text-${align}">${escapeHtml(col.label)}</th>`;
    }),
  ].join("");

  const rowsHtml =
    data.length > 0
      ? data
          .map((row, rowIdx) => {
            const cells = [
              `<td class="text-center font-mono text-muted">${rowIdx + 1}</td>`,
              ...columns.map((col) => {
                const resolved = resolveExportCellDisplay(col, row, rowIdx, "pdf");
                const isMoney = isMonetaryColumnKey(col.key);
                const isDate = isDateColumnKey(col.key);
                const align = col.align || (isMoney ? "right" : "left");
                const extraClasses = [
                  `text-${align}`,
                  isMoney ? "font-mono text-currency" : "",
                  isDate && !isUltraWide ? "font-mono text-nowrap" : isDate ? "font-mono" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return `<td class="${extraClasses}">${escapeHtml(resolved)}</td>`;
              }),
            ].join("");
            return `<tr>${cells}</tr>`;
          })
          .join("")
      : `<tr><td colspan="${columns.length + 1}" class="empty-cell">Tidak ada data yang tersedia untuk filter / periode yang dipilih.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)} - ${escapeHtml(companyName)}</title>
  <style>
    @page {
      size: A4 ${orientation};
      margin: ${pageMarginCss};
      @bottom-left {
        content: "SUN BIRO JASA / ADMIN SUN89 — Dokumen Keuangan Resmi";
        font-size: 7.5pt;
        color: #64748b;
      }
      @bottom-right {
        content: "Halaman " counter(page) " dari " counter(pages);
        font-size: 7.5pt;
        color: #64748b;
      }
    }
    @media print {
      body {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        padding: 0 !important;
      }
      thead {
        display: table-header-group;
      }
      tfoot {
        display: table-footer-group;
      }
      tr {
        page-break-inside: avoid;
      }
      .print-bar {
        display: none !important;
      }
    }
    * {
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 16px;
      font-size: ${bodyFontSize};
      line-height: 1.4;
    }
    .print-bar {
      background: #0f172a;
      color: #ffffff;
      padding: 10px 16px;
      margin: -16px -16px 16px -16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .print-bar-meta {
      font-size: 11px;
      color: #cbd5e1;
      margin-top: 2px;
    }
    .print-btn {
      background: #2563eb;
      color: #ffffff;
      border: none;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .print-btn:hover {
      background: #1d4ed8;
    }
    .report-header {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 8px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
    }
    .company-title {
      font-size: 9pt;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #475569;
      text-transform: uppercase;
    }
    .doc-title {
      font-size: 14pt;
      font-weight: 700;
      color: #0f172a;
      margin: 2px 0;
      letter-spacing: -0.01em;
    }
    .doc-subtitle {
      font-size: 8.5pt;
      color: #64748b;
    }
    .header-right {
      text-align: right;
      font-size: 8pt;
      color: #475569;
      line-height: 1.5;
      white-space: nowrap;
    }
    .meta-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
    }
    .meta-item {
      display: inline-flex;
      gap: 4px;
      font-size: 8pt;
    }
    .meta-label {
      color: #64748b;
      font-weight: 500;
    }
    .meta-value {
      color: #0f172a;
      font-weight: 600;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .summary-card {
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 6px 10px;
      background: #f8fafc;
    }
    .summary-label {
      font-size: 7pt;
      color: #64748b;
      text-transform: uppercase;
      font-weight: 700;
    }
    .summary-value {
      font-size: 9.5pt;
      font-weight: 700;
      color: #0f172a;
      margin-top: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 4px;
      table-layout: auto;
      zoom: ${tableZoomCss};
    }
    th {
      background-color: #f1f5f9;
      color: #1e293b;
      font-weight: 700;
      font-size: ${headerFontSize};
      text-transform: uppercase;
      letter-spacing: ${isUltraWide ? "0.01em" : "0.03em"};
      padding: ${cellPadding};
      border: 1px solid #cbd5e1;
      vertical-align: middle;
      line-height: 1.2;
      overflow-wrap: ${isUltraWide ? "anywhere" : "break-word"};
      word-break: normal;
    }
    td {
      padding: ${cellPadding};
      border: 1px solid #e2e8f0;
      font-size: ${bodyFontSize};
      vertical-align: middle;
      line-height: ${isUltraWide ? "1.25" : "1.35"};
      overflow-wrap: ${isUltraWide ? "anywhere" : "break-word"};
      word-break: normal;
    }
    tr:nth-child(even) td {
      background-color: #f8fafc;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-left { text-align: left; }
    .text-nowrap { white-space: nowrap; }
    .text-muted { color: #64748b; }
    .text-currency {
      white-space: ${isUltraWide ? "normal" : "nowrap"};
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      word-break: normal;
      overflow-wrap: normal;
    }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .empty-cell {
      text-align: center;
      padding: 24px;
      color: #64748b;
    }
    .report-footer {
      margin-top: 14px;
      padding-top: 8px;
      border-top: 1px solid #cbd5e1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      font-size: 7.5pt;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="print-bar">
    <div>
      <div><strong>Pratinjau Dokumen Cetak / PDF — ${escapeHtml(title)}</strong></div>
      <div class="print-bar-meta">Orientasi otomatis: A4 ${orientation === "portrait" ? "Portrait" : "Landscape"} • ${columns.length} kolom aktif • ${data.length} baris data</div>
    </div>
    <button class="print-btn" onclick="window.print()">Cetak / Simpan PDF</button>
  </div>

  <div class="report-header">
    <div>
      <div class="company-title">${escapeHtml(companyName)}</div>
      <div class="doc-title">${escapeHtml(title)}</div>
      ${subTitle ? `<div class="doc-subtitle">${escapeHtml(subTitle)}</div>` : ""}
    </div>
    <div class="header-right">
      <div>Tanggal Cetak: <strong>${escapeHtml(currentDate)}</strong></div>
      <div>Total Data: <strong>${data.length} baris</strong></div>
      <div>Format Kertas: <strong>A4 ${orientation === "portrait" ? "Portrait" : "Landscape"}</strong></div>
    </div>
  </div>

  ${metaItems.length > 0 ? `<div class="meta-box">${metadataHtml}</div>` : ""}

  ${summaryHtml}

  <table>
    <thead>
      <tr>${headerCellsHtml}</tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <div class="report-footer">
    <div>${escapeHtml(companyName)} — Dokumen dicetak otomatis dari sistem operasional Admin SUN89.</div>
    <div>Dicetak pada: ${escapeHtml(currentDate)}</div>
  </div>
</body>
</html>`;
}

export function exportToPDF(options: PDFExportOptions): void {
  const filename = getFinanceExportFilename(options.title, "pdf", options.periodLabel);
  const html = buildFinancePDFHtml(options);
  dispatchPrintableDocument(html, filename, options.action || "download");
}
