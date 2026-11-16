import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";

import {
  sanitizeCSVFormula,
  escapeCSVCell,
  escapeHtml,
  extractPlainTextFromNode,
  buildFinanceCSVContent,
  buildFinancePDFHtml,
  resolvePdfOrientation,
  filterDataByExportPeriod,
  getFinanceExportFilename,
  ExportColumn,
} from "../src/app/utils/financeExport";

describe("FINANCE TABLE UI STANDARDIZATION & EXPORT IMPROVEMENT", () => {
  const financeContentPath = path.resolve("src/app/components/FinanceContent.tsx");
  const paymentSummaryPath = path.resolve("src/app/components/FinancePaymentMethodSummary.tsx");
  const profitViewPath = path.resolve("src/app/components/finance/ProfitReconciliationView.tsx");
  const labaRugiViewPath = path.resolve("src/app/components/finance/LabaRugiStatementView.tsx");
  const enhancedTablePath = path.resolve("src/app/components/EnhancedTableWithDialogs.tsx");
  const globalsCssPath = path.resolve("src/styles/globals.css");

  const financeContentCode = fs.readFileSync(financeContentPath, "utf8");
  const paymentSummaryCode = fs.readFileSync(paymentSummaryPath, "utf8");
  const profitViewCode = fs.readFileSync(profitViewPath, "utf8");
  const labaRugiViewCode = fs.readFileSync(labaRugiViewPath, "utf8");
  const enhancedTableCode = fs.readFileSync(enhancedTablePath, "utf8");
  const globalsCss = fs.readFileSync(globalsCssPath, "utf8");

  describe("1. Payment Method Plain Text Rendering (No Decorative Icons)", () => {
    it("renderPaymentMethodCell renders Tunai and Bank transfers without decorative emojis", () => {
      const fnStart = financeContentCode.indexOf("export function renderPaymentMethodCell");
      const fnEnd = financeContentCode.indexOf("export function FinanceContent", fnStart);
      assert.ok(fnStart > -1 && fnEnd > fnStart, "renderPaymentMethodCell function must exist");
      const fnBody = financeContentCode.slice(fnStart, fnEnd);

      assert.ok(fnBody.includes('snap.nama_metode || "Tunai (Kas Fisik)"'), "Tunai label preserved");
      assert.ok(fnBody.includes('snap.bank || "BANK"'), "Bank label preserved");
      assert.ok(fnBody.includes("{rawMethod}"), "Raw string fallback preserved");
      assert.ok(!fnBody.includes("💵"), "renderPaymentMethodCell must NOT render money emoji");
      assert.ok(!fnBody.includes("🏦"), "renderPaymentMethodCell must NOT render bank emoji");
    });

    it("FinanceContent Reimbursement table and FinancePaymentMethodSummary omit payment method icons", () => {
      assert.ok(
        !financeContentCode.includes('{isCash ? "💵 TUNAI" : "🏦 "'),
        "Reimbursement table must not render decorative cash/bank emojis"
      );
      assert.ok(
        financeContentCode.includes('{isCash ? "TUNAI" : (pmStr.split("-")[0]?.trim() || "BANK")}'),
        "Reimbursement table must render plain text method badge"
      );
      assert.ok(
        !paymentSummaryCode.includes("Banknote"),
        "FinancePaymentMethodSummary table must not render Banknote icon"
      );
      assert.ok(
        !paymentSummaryCode.includes('<CreditCard className="w-4 h-4 text-blue-500"') &&
          !paymentSummaryCode.includes('<CreditCard className="w-3.5 h-3.5 text-blue-500'),
        "FinancePaymentMethodSummary table rows must not render CreditCard icon next to payment method name"
      );
    });
  });

  describe("2. Standardized Density Across All Finance Tables", () => {
    it("globals.css defines unified .finance-table header/body/footer density tokens", () => {
      assert.ok(globalsCss.includes(".finance-table thead th"));
      assert.ok(globalsCss.includes(".finance-table tbody td"));
      assert.ok(globalsCss.includes(".finance-table tfoot td"));
    });

    it("EnhancedTableWithDialogs and inline Finance tables adopt standardized .finance-table classes and compact padding", () => {
      assert.ok(enhancedTableCode.includes("h-8.5 px-2.5"));
      assert.ok(enhancedTableCode.includes("px-2.5 py-1.5 text-[10px]"));
      assert.ok(enhancedTableCode.includes("border-b border-border/60 last:border-0 h-9"));

      assert.ok(profitViewCode.includes('className="finance-table w-full text-xs text-left border-collapse"'));
      assert.ok(profitViewCode.includes("finance-table__header"));
      assert.ok(profitViewCode.includes("finance-table__body"));
      assert.ok(profitViewCode.includes("finance-table__footer"));

      assert.ok(labaRugiViewCode.includes('className="finance-table w-full text-xs text-left border-collapse"'));
      assert.ok(labaRugiViewCode.includes("finance-table__header"));
      assert.ok(labaRugiViewCode.includes("finance-table__body"));
      assert.ok(labaRugiViewCode.includes("finance-table__footer"));

      assert.ok(paymentSummaryCode.includes('className="finance-table w-full text-left text-xs border-collapse"'));
    });
  });

  describe("3. Removal of Tutup Kas Harian from Kas Kantor", () => {
    it("FinanceContent removes RekonsiliasiKasModal, isRekonsiliasiOpen, and Tutup Kas Harian trigger while retaining Kas Kantor flows", () => {
      assert.ok(!fs.existsSync(path.resolve("src/app/components/RekonsiliasiKasModal.tsx")), "RekonsiliasiKasModal.tsx must be deleted");
      assert.ok(!financeContentCode.includes("RekonsiliasiKasModal"), "FinanceContent must not reference RekonsiliasiKasModal");
      assert.ok(!financeContentCode.includes("isRekonsiliasiOpen"), "FinanceContent must not declare isRekonsiliasiOpen");
      assert.ok(!financeContentCode.includes("Rekonsiliasi & Tutup Kas Harian"), "Tutup Kas Harian button must be removed");

      // Operational Kas Kantor ledger remains intact
      assert.ok(financeContentCode.includes("subTabTitle=\"Kas Kantor\""));
      assert.ok(financeContentCode.includes("<AddKasKantorModal"));
      assert.ok(financeContentCode.includes("Total Penerimaan (Debit)"));
      assert.ok(financeContentCode.includes("Total Pengeluaran (Kredit)"));
      assert.ok(financeContentCode.includes("Saldo Kas Kantor"));
    });
  });

  describe("4. CSV Export Standardization & Data Fidelity", () => {
    it("handles UTF-8 BOM, RFC 4180 escaping, formula neutralization, visible columns & order, and full dataset", () => {
      const cols: ExportColumn[] = [
        { key: "nopol", label: "Nomor Polisi" },
        { key: "customer", label: "Nama Customer" },
        { key: "tanggal", label: "Tanggal" },
        {
          key: "paymentMethod",
          label: "Metode Pembayaran",
          exportValue: (_v, row) =>
            React.createElement("span", null, row.bank ? `${row.bank} ${row.rek}` : "Tunai"),
        },
        { key: "nominal", label: "Nominal (Rp)", align: "right" },
      ];

      const rows = [
        {
          id: 1,
          tanggal: "2026-11-14",
          nopol: "B 1234 XYZ",
          customer: 'PT "Maju, Jaya"\nCabang',
          bank: "BCA",
          rek: "7175095764",
          nominal: 1500000,
          hiddenSecretField: "MUST_NOT_APPEAR",
        },
        {
          id: 2,
          tanggal: "15/11/2026",
          nopol: "B 5678 ABC",
          customer: "=CMD|'/C calc'!A0",
          bank: "",
          rek: "",
          nominal: -250000,
          hiddenSecretField: "SECRET_2",
        },
      ];

      const csv = buildFinanceCSVContent({
        title: "Laporan Keuangan - Kas Kantor",
        columns: cols,
        data: rows,
        periodLabel: "Bulan Ini",
        metadata: [
          { label: "Pencarian", value: "Maju" },
          { label: "Filter Status", value: "Debit" },
        ],
      });

      assert.ok(csv.startsWith("\uFEFF"), "CSV must start with UTF-8 BOM");
      assert.ok(csv.includes("PENCARIAN,Maju"));
      assert.ok(csv.includes("FILTER STATUS,Debit"));
      assert.ok(!csv.includes("MUST_NOT_APPEAR"), "Hidden fields not in exportColumns must not be exported");

      // Header follows column order
      assert.ok(csv.includes("Nomor Polisi,Nama Customer,Tanggal,Metode Pembayaran,Nominal (Rp)\r\n"));

      // Date formatted DD/MM/YYYY, JSX extracted to plain text, CSV escaping & formula protection applied, numeric values unquoted
      assert.ok(csv.includes('B 1234 XYZ,"PT ""Maju, Jaya""\nCabang",14/11/2026,BCA 7175095764,1500000'));
      assert.ok(csv.includes("B 5678 ABC,'=CMD|'/C calc'!A0,15/11/2026,Tunai,-250000"));
    });

    it("throws clear error if zero columns are selected for export", () => {
      assert.throws(() => {
        buildFinanceCSVContent({
          title: "Kosong",
          columns: [],
          data: [{ a: 1 }],
        });
      }, /Minimal satu kolom/);
    });

    it("sanitizeCSVFormula and escapeCSVCell follow RFC 4180 and formula defense", () => {
      assert.equal(sanitizeCSVFormula("=1+1"), "'=1+1");
      assert.equal(sanitizeCSVFormula("+SUM(A1)"), "'+SUM(A1)");
      assert.equal(sanitizeCSVFormula("@import"), "'@import");
      assert.equal(escapeCSVCell('a,"b"\nc'), '"a,""b""\nc"');
    });

    it("filterDataByExportPeriod parses DD/MM/YYYY and YYYY-MM-DD dates even if date column is hidden", () => {
      const sample = [
        { id: 1, tanggalMasukBerkas: "05/11/2026", customer: "Andi" },
        { id: 2, tanggalMasukBerkas: "2026-11-14", customer: "Budi" },
        { id: 3, tanggalMasukBerkas: "01/01/2025", customer: "Citra" },
      ];
      // Visible columns intentionally omit tanggalMasukBerkas
      const visibleCols: ExportColumn[] = [{ key: "customer", label: "Customer" }];

      const customFiltered = filterDataByExportPeriod(sample, visibleCols, "custom", {
        start: "2026-11-01",
        end: "2026-11-30",
      });
      assert.equal(customFiltered.length, 2);
      assert.deepEqual(
        customFiltered.map((r) => r.customer),
        ["Andi", "Budi"]
      );
    });

    it("extractPlainTextFromNode ignores SVGs and extracts clean nested text", () => {
      const node = React.createElement(
        "div",
        null,
        React.createElement("svg", null, React.createElement("path", { d: "M0 0" })),
        React.createElement("span", null, "BCA"),
        React.createElement("span", null, "7175095764")
      );
      assert.equal(extractPlainTextFromNode(node), "BCA 7175095764");
    });

    it("generates descriptive clean export filenames", () => {
      const fn = getFinanceExportFilename("Laporan Keuangan - Kas Kantor", "csv", "Bulan Ini");
      assert.match(fn, /^AdminSUN89_Laporan_Keuangan_Kas_Kantor_Bulan_Ini_\d{4}-\d{2}-\d{2}\.csv$/);
    });
  });

  describe("5. Standardized PDF Template (Laporan Riwayat Aktivitas) & Auto Orientation", () => {
    it("automatically picks A4 portrait for narrow <= 6 column reports and landscape for wide / >= 7 column reports", () => {
      const narrowCols: ExportColumn[] = [
        { key: "tanggal", label: "Tanggal" },
        { key: "nopol", label: "Nomor Polisi" },
        { key: "nominal", label: "Nominal", align: "right" },
      ];
      assert.equal(resolvePdfOrientation(narrowCols, [{ tanggal: "14/11/2026", nopol: "B 1234 XY", nominal: 500000 }]), "portrait");

      const sevenCols: ExportColumn[] = [
        { key: "tanggal", label: "Tanggal" },
        { key: "orderNo", label: "Order" },
        { key: "nopol", label: "Nopol" },
        { key: "customer", label: "Customer" },
        { key: "pengurusan", label: "Layanan" },
        { key: "paymentMethod", label: "Metode" },
        { key: "nominal", label: "Total", align: "right" },
      ];
      assert.equal(resolvePdfOrientation(sevenCols, []), "landscape");

      const wideDescriptionCols: ExportColumn[] = [
        { key: "tanggal", label: "Tanggal" },
        { key: "keterangan", label: "Keterangan Transaksi Lengkap" },
        { key: "paymentMethod", label: "Metode Pembayaran Lengkap" },
        { key: "penanggungJawab", label: "Penanggung Jawab Operasional" },
        { key: "debit", label: "Debit (masuk)", align: "right" },
        { key: "kredit", label: "Kredit (keluar)", align: "right" },
      ];
      assert.equal(resolvePdfOrientation(wideDescriptionCols, []), "landscape");
    });

    it("buildFinancePDFHtml renders standardized header, metadata box, repeating thead, right-aligned Rupiah, XSS escaping, footer, and only visible ordered columns", () => {
      const cols: ExportColumn[] = [
        { key: "tanggal", label: "Tanggal" },
        { key: "customer", label: "Nama Customer" },
        { key: "totalTagihan", label: "Total Tagihan", align: "right" },
      ];
      const rows = [
        {
          tanggal: "2026-11-14",
          customer: "<script>alert('xss')</script> PT Surya",
          totalTagihan: 1750000,
          secretHiddenCol: "HIDDEN_VALUE_SHOULD_NOT_BE_IN_PDF",
        },
      ];

      const html = buildFinancePDFHtml({
        title: "Laporan Keuangan - Belum & Kurang Bayar",
        subTitle: "Daftar piutang customer aktif",
        periodLabel: "Semua Data Aktif",
        columns: cols,
        data: rows,
        metadata: [
          { label: "Kolom Ditampilkan", value: "3 dari 11 kolom" },
          { label: "Pencarian", value: "Surya" },
        ],
      });

      assert.ok(html.includes("size: A4 portrait;"));
      assert.ok(html.includes("SUN BIRO JASA / ADMIN SUN89"));
      assert.ok(html.includes("Laporan Keuangan - Belum &amp; Kurang Bayar"));
      assert.ok(html.includes("Daftar piutang customer aktif"));
      assert.ok(html.includes('class="meta-box"'));
      assert.ok(html.includes("Kolom Ditampilkan:"));
      assert.ok(html.includes("3 dari 11 kolom"));
      assert.ok(html.includes("Pencarian:"));
      assert.ok(html.includes("Surya"));
      assert.ok(html.includes("display: table-header-group;"));
      assert.ok(html.includes('class="report-footer"'));
      assert.ok(html.includes("counter(page)"));
      assert.ok(html.includes("Rp 1.750.000"));
      assert.ok(html.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt; PT Surya"));
      assert.ok(!html.includes("<script>alert"), "HTML output must escape user strings");
      assert.ok(!html.includes("HIDDEN_VALUE_SHOULD_NOT_BE_IN_PDF"), "Hidden columns must never render in PDF");
      assert.equal(escapeHtml('a & "b"'), "a &amp; &quot;b&quot;");
    });
  });

  describe("6. Integration Between Pengaturan Tabel, Simpan Pengaturan, and Export", () => {
    it("EnhancedTableWithDialogs wires orderedColumns, savedVisibleColumnKeys, sortedData, and metadata to CSV & PDF exports", () => {
      assert.ok(enhancedTableCode.includes("savedColumnOrder"));
      assert.ok(enhancedTableCode.includes("draftColumnOrder"));
      assert.ok(enhancedTableCode.includes("handleDraftMoveColumn"));
      assert.ok(enhancedTableCode.includes("orderedColumns"));
      assert.ok(enhancedTableCode.includes("filterDataByExportPeriod(sortedData, allDateColumnsHint"));
      assert.ok(enhancedTableCode.includes("metadata: buildExportMetadata") || enhancedTableCode.includes("const metadata = buildExportMetadata()"));
    });
  });
});
