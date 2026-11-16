/**
 * Phase 3 Regression Tests: Finance -> Profit Payment Method Data Source & Canonical Filtering Integrity
 *
 * Covers all 12 canonical scenarios:
 *  1. Dropdown & API payment methods sourced strictly from DB `payment_methods` (zero hardcoded static options).
 *  2. Filtering by every real DB payment method returns exact matching verified transactions.
 *  3. Multiple accounts sharing identical `nama_metode = "Transfer Bank"` AND duplicate bank names
 *     with different `nomor_rekening` do not collide; filtered strictly by canonical `payment_methods.id`.
 *  4. Unknown / nonexistent `paymentMethodId` returns empty result cleanly.
 *  5. Unpaid orders (no verified payment) do not enter verified payment profit filter / breakdown.
 *  6. Orders with `Bayar di Awal` pending verification (`MENUNGGU_VERIFIKASI` / `MENUNGGU_BUKTI`) are excluded.
 *  7. `ALL` filter equals exact aggregate of all verified valid transactions without double-counting (including split payments).
 *  8. KPI, table totals, per-method breakdown, CSV export (escaped RFC 4180), and PDF metadata use consistent filtered results & canonical label.
 *  9. Combined WIB date range + service category + payment method filter intersects accurately.
 * 10. `CANCELLED` orders and voided (`is_void = 1`) payments never appear under any payment method filter.
 * 11. Verified payment with NULL/empty payment method never matches `"Tunai"` (`pm-cash`) or any real DB ID.
 * 12. Inactive (`Nonaktif`) historical method remains preserved with `(Nonaktif)` badge on canonical label and filterable without errors.
 */

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../server/src/app";
import { generateToken } from "../server/src/utils/crypto";
import { db, initDatabase, closeDb, getOperationalDbPath } from "../server/src/database/db";
import { CONFIG } from "../server/src/config/env";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import {
  buildPaymentMethodLabelMap,
  resolveCanonicalPaymentMethod,
  matchesWibDateRange,
  CanonicalPaymentMethodRecord,
} from "../src/domain/finance/paymentMethodCanonical";
import {
  normalizeBankMethodName,
  extractRealPaymentMethod,
} from "../src/app/components/finance/ProfitReconciliationView";
import { exportProfitToCSV, exportProfitToPDF } from "../src/app/utils/financeExport";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";
import { permissionStore } from "../src/app/data/permissionStore";

test("Finance -> Profit Payment Method Canonical Data Source & Filtering (12 Scenarios)", async (t) => {
  // Hard isolation proof: verify runtime DB_PATH points strictly to isolated sandbox, never operational DB
  assert.notStrictEqual(
    path.resolve(CONFIG.DB_PATH),
    path.resolve(getOperationalDbPath()),
    "Test MUST execute against isolated temporary SQLite DB, never operational DB"
  );

  initDatabase({ runSchema: true });

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const financeToken = generateToken({
    userId: "3",
    email: "finance@birojasa.com",
    nama: "Finance Staff",
    role: "finance",
  });

  try {
    // Ensure deterministic custom payment methods in isolated DB (including duplicate Transfer Bank + two BCA accounts + inactive method)
    const pmCashId = "pm-cash";
    const pmBca1Id = "pm-test-bca-1";
    const pmBca2Id = "pm-test-bca-2";
    const pmCimbId = "pm-test-cimb";
    const pmInactiveBsiId = "pm-test-bsi-old";

    const ensurePm = db.prepare(`
      INSERT OR REPLACE INTO payment_methods (id, nama_metode, bank, nama_rekening, nomor_rekening, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    ensurePm.run(pmCashId, "Tunai", "Tunai", "", "", "Aktif");
    ensurePm.run(pmBca1Id, "Transfer Bank", "BCA", "PT SUN BCA 1", "111000111", "Aktif");
    ensurePm.run(pmBca2Id, "Transfer Bank", "BCA", "PT SUN BCA 2", "222000222", "Aktif");
    ensurePm.run(pmCimbId, "Transfer Bank", "CIMB NIAGA", "PT SUN CIMB", "707751492800", "Aktif");
    ensurePm.run(pmInactiveBsiId, "Transfer Bank", "BSI", "PT SUN BSI OLD", "999888777", "Nonaktif");

    // Seed deterministic orders + invoices + payments using actual schema columns in isolated DB
    const insertOrder = db.prepare(`
      INSERT INTO orders (
        order_no, customer, nomor_hp, layanan, nopol, current_step, current_stage_name, payment_status,
        total_biaya, is_archived, data_json, created_at, updated_at, is_cost_verified, cost_completeness_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'), 1, 'VERIFIED')
    `);
    const insertInvoice = db.prepare(`
      INSERT INTO finance_invoices (
        invoice_no, order_no, customer, layanan, status, total_tagihan, dibayar, sisa,
        data_json, created_at, updated_at, biaya_samsat, pendapatan_jasa, profit_final,
        is_explicit_zero, cost_verification_status, is_draft_estimate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, 0, 'VERIFIED', 0)
    `);
    const insertPayment = db.prepare(`
      INSERT INTO invoice_payments (
        payment_id, invoice_no, order_no, nominal, metode_pembayaran, nama_bank, nomor_rekening,
        tanggal_bayar, status_verifikasi, metode_pembayaran_id, payment_method_snapshot, is_void, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const seedCase = (opts: {
      orderNo: string;
      invoiceNo: string;
      customer: string;
      layanan: string;
      nopol: string;
      tanggal: string;
      stageName: string;
      orderPayStatus: string;
      invStatus: string;
      billingStatus: string;
      totalTagihan: number;
      biayaSamsat: number;
      dibayar: number;
      sisa: number;
      profit: number;
      isCancelled?: boolean;
    }) => {
      insertOrder.run(
        opts.orderNo,
        opts.customer,
        "081200000000",
        opts.layanan,
        opts.nopol,
        opts.stageName === "Selesai" ? 6 : 1,
        opts.stageName,
        opts.orderPayStatus,
        opts.totalTagihan,
        JSON.stringify({
          orderNo: opts.orderNo,
          customer: opts.customer,
          layanan: opts.layanan,
          nopol: opts.nopol,
          isCancelled: Boolean(opts.isCancelled),
          status: opts.isCancelled ? "CANCELLED" : undefined,
        })
      );
      insertInvoice.run(
        opts.invoiceNo,
        opts.orderNo,
        opts.customer,
        opts.layanan,
        opts.invStatus,
        opts.totalTagihan,
        opts.dibayar,
        opts.sisa,
        JSON.stringify({
          invoice: opts.invoiceNo,
          invoiceNo: opts.invoiceNo,
          orderNo: opts.orderNo,
          customer: opts.customer,
          jenisLayanan: opts.layanan,
          layanan: opts.layanan,
          nopol: opts.nopol,
          tanggal: opts.tanggal,
          billingStatus: opts.billingStatus,
          isCancelled: Boolean(opts.isCancelled),
          totalTagihan: opts.totalTagihan,
          biayaSamsat: opts.biayaSamsat,
          dibayar: opts.dibayar,
          sisa: opts.sisa,
          profit: opts.profit,
          costClassification: "DEFINITIVE",
          costVerificationStatus: "VERIFIED",
        }),
        opts.biayaSamsat,
        Math.max(0, opts.totalTagihan - opts.biayaSamsat),
        opts.profit
      );
    };

    // Case A: Verified Cash payment (`pm-cash`) — Perpanjangan 1 Tahun, 2026-06-10
    seedCase({
      orderNo: "ORD-PM-01",
      invoiceNo: "INV-PM-01",
      customer: "Cust Cash",
      layanan: "Perpanjangan 1 Tahun",
      nopol: "B 1001 PM",
      tanggal: "2026-06-10",
      stageName: "Selesai",
      orderPayStatus: "Lunas",
      invStatus: "Lunas",
      billingStatus: "PAID",
      totalTagihan: 1000000,
      biayaSamsat: 600000,
      dibayar: 1000000,
      sisa: 0,
      profit: 400000,
    });
    insertPayment.run("PAY-PM-01", "INV-PM-01", "ORD-PM-01", 1000000, "Tunai", "Tunai", "", "2026-06-10", "TERVERIFIKASI", pmCashId, JSON.stringify({ id: pmCashId, nama_metode: "Tunai", bank: "Tunai" }), 0);

    // Case B: Verified BCA Account 1 (`pm-test-bca-1`) — Balik Nama, 2026-06-12
    seedCase({
      orderNo: "ORD-PM-02",
      invoiceNo: "INV-PM-02",
      customer: "Cust BCA 1",
      layanan: "Balik Nama",
      nopol: "B 1002 PM",
      tanggal: "2026-06-12",
      stageName: "Proses",
      orderPayStatus: "Lunas",
      invStatus: "Lunas",
      billingStatus: "PAID",
      totalTagihan: 2000000,
      biayaSamsat: 1200000,
      dibayar: 2000000,
      sisa: 0,
      profit: 800000,
    });
    insertPayment.run("PAY-PM-02", "INV-PM-02", "ORD-PM-02", 2000000, "Transfer Bank", "BCA", "111000111", "2026-06-12", "TERVERIFIKASI", pmBca1Id, JSON.stringify({ id: pmBca1Id, nama_metode: "Transfer Bank", bank: "BCA", nomor_rekening: "111000111" }), 0);

    // Case C: Verified BCA Account 2 (`pm-test-bca-2`, shares bank='BCA' & nama_metode='Transfer Bank') — Balik Nama, 2026-06-15
    seedCase({
      orderNo: "ORD-PM-03",
      invoiceNo: "INV-PM-03",
      customer: "Cust BCA 2",
      layanan: "Balik Nama",
      nopol: "B 1003 PM",
      tanggal: "2026-06-15",
      stageName: "Proses",
      orderPayStatus: "Lunas",
      invStatus: "Lunas",
      billingStatus: "PAID",
      totalTagihan: 1500000,
      biayaSamsat: 900000,
      dibayar: 1500000,
      sisa: 0,
      profit: 600000,
    });
    insertPayment.run("PAY-PM-03", "INV-PM-03", "ORD-PM-03", 1500000, "Transfer Bank", "BCA", "222000222", "2026-06-15", "TERVERIFIKASI", pmBca2Id, JSON.stringify({ id: pmBca2Id, nama_metode: "Transfer Bank", bank: "BCA", nomor_rekening: "222000222" }), 0);

    // Case D: Verified Split Payment (300k Cash + 700k CIMB NIAGA) — Perpanjangan 5 Tahun, 2026-06-16
    seedCase({
      orderNo: "ORD-PM-04",
      invoiceNo: "INV-PM-04",
      customer: "Cust Split",
      layanan: "Perpanjangan 5 Tahun",
      nopol: "B 1004 PM",
      tanggal: "2026-06-16",
      stageName: "Proses",
      orderPayStatus: "Lunas",
      invStatus: "Lunas",
      billingStatus: "PAID",
      totalTagihan: 1000000,
      biayaSamsat: 500000,
      dibayar: 1000000,
      sisa: 0,
      profit: 500000,
    });
    insertPayment.run("PAY-PM-04A", "INV-PM-04", "ORD-PM-04", 300000, "Tunai", "Tunai", "", "2026-06-16", "TERVERIFIKASI", pmCashId, null, 0);
    insertPayment.run("PAY-PM-04B", "INV-PM-04", "ORD-PM-04", 700000, "Transfer Bank", "CIMB NIAGA", "707751492800", "2026-06-16", "TERVERIFIKASI", pmCimbId, null, 0);

    // Case E: Unpaid Order (0 payments) — must NOT enter any payment method filter
    seedCase({
      orderNo: "ORD-PM-05",
      invoiceNo: "INV-PM-05",
      customer: "Cust Unpaid",
      layanan: "Perpanjangan 1 Tahun",
      nopol: "B 1005 PM",
      tanggal: "2026-06-17",
      stageName: "Pendaftaran",
      orderPayStatus: "Belum Bayar",
      invStatus: "Belum Bayar",
      billingStatus: "ISSUED",
      totalTagihan: 800000,
      biayaSamsat: 500000,
      dibayar: 0,
      sisa: 800000,
      profit: 0,
    });

    // Case F: Bayar di Awal pending verification (`MENUNGGU_VERIFIKASI`) — must NOT appear under BCA or any verified profit
    seedCase({
      orderNo: "ORD-PM-06",
      invoiceNo: "INV-PM-06",
      customer: "Cust Pending Verify",
      layanan: "Perpanjangan 1 Tahun",
      nopol: "B 1006 PM",
      tanggal: "2026-06-17",
      stageName: "Pendaftaran",
      orderPayStatus: "Menunggu Verifikasi",
      invStatus: "Menunggu Verifikasi",
      billingStatus: "ISSUED",
      totalTagihan: 900000,
      biayaSamsat: 600000,
      dibayar: 0,
      sisa: 900000,
      profit: 0,
    });
    insertPayment.run("PAY-PM-06", "INV-PM-06", "ORD-PM-06", 900000, "Bayar di Awal - Transfer Bank", "BCA", "111000111", "2026-06-17", "MENUNGGU_VERIFIKASI", pmBca1Id, null, 0);

    // Case G: CANCELLED order with previously verified payment — must be excluded from all filters & totals
    seedCase({
      orderNo: "ORD-PM-07",
      invoiceNo: "INV-PM-07",
      customer: "Cust Cancelled",
      layanan: "Perpanjangan 1 Tahun",
      nopol: "B 1007 PM",
      tanggal: "2026-06-17",
      stageName: "Dibatalkan",
      orderPayStatus: "Dibatalkan",
      invStatus: "CANCELLED",
      billingStatus: "CANCELLED",
      totalTagihan: 1200000,
      biayaSamsat: 700000,
      dibayar: 1200000,
      sisa: 0,
      profit: 500000,
      isCancelled: true,
    });
    insertPayment.run("PAY-PM-07", "INV-PM-07", "ORD-PM-07", 1200000, "Tunai", "Tunai", "", "2026-06-17", "TERVERIFIKASI", pmCashId, null, 0);

    // Case H: NULL/empty payment method on a verified legacy payment — must NOT match Tunai (`pm-cash`)!
    seedCase({
      orderNo: "ORD-PM-08",
      invoiceNo: "INV-PM-08",
      customer: "Cust Null Method",
      layanan: "Duplikat STNK",
      nopol: "B 1008 PM",
      tanggal: "2026-06-18",
      stageName: "Selesai",
      orderPayStatus: "Lunas",
      invStatus: "Lunas",
      billingStatus: "PAID",
      totalTagihan: 600000,
      biayaSamsat: 400000,
      dibayar: 600000,
      sisa: 0,
      profit: 200000,
    });
    insertPayment.run("PAY-PM-08", "INV-PM-08", "ORD-PM-08", 600000, "", "", "", "2026-06-18", "TERVERIFIKASI", null, null, 0);

    // Case I: Voided payment (`is_void = 1`) must NOT count, while historical `Nonaktif` method DOES resolve cleanly with badge
    seedCase({
      orderNo: "ORD-PM-09",
      invoiceNo: "INV-PM-09",
      customer: "Cust Inactive Method",
      layanan: "Mutasi Antar Daerah",
      nopol: "B 1009 PM",
      tanggal: "2026-06-19",
      stageName: "Selesai",
      orderPayStatus: "Lunas",
      invStatus: "Lunas",
      billingStatus: "PAID",
      totalTagihan: 2500000,
      biayaSamsat: 1800000,
      dibayar: 2500000,
      sisa: 0,
      profit: 700000,
    });
    insertPayment.run("PAY-PM-09-VOID", "INV-PM-09", "ORD-PM-09", 2500000, "Tunai", "Tunai", "", "2026-06-19", "TERVERIFIKASI", pmCashId, null, 1);
    insertPayment.run("PAY-PM-09-BSI", "INV-PM-09", "ORD-PM-09", 2500000, "Transfer Bank", "BSI", "999888777", "2026-06-19", "TERVERIFIKASI", pmInactiveBsiId, null, 0);

    await t.test("Scenario 1: UI source has NO hardcoded payment method options & store fetches DB /payment-methods", async () => {
      const viewCode = fs.readFileSync(
        path.resolve("src/app/components/finance/ProfitReconciliationView.tsx"),
        "utf8"
      );
      assert.ok(!viewCode.includes('<SelectItem value="Tunai">'), "Must remove hardcoded Tunai SelectItem");
      assert.ok(!viewCode.includes('<SelectItem value="BCA">'), "Must remove hardcoded BCA SelectItem");
      assert.ok(!viewCode.includes('<SelectItem value="CIMB">'), "Must remove hardcoded CIMB SelectItem");
      assert.ok(!viewCode.includes('<SelectItem value="Muamalat">'), "Must remove hardcoded Muamalat SelectItem");
      assert.ok(!viewCode.includes('<SelectItem value="Mandiri">'), "Must remove hardcoded Mandiri SelectItem");
      assert.ok(viewCode.includes("dropdownPaymentOptions.map"), "Dropdown must render dynamically from DB options");

      const storeCode = fs.readFileSync(path.resolve("src/app/data/paymentMethodStore.ts"), "utf8");
      assert.ok(storeCode.includes("/payment-methods"), "PaymentMethodStore must fetch from /api/payment-methods");
      assert.ok(!storeCode.includes("/payment-methods?status=Aktif"), "Store must load full DB catalog so historical Nonaktif methods can be canonicalized cleanly");

      const res = await fetch(`${baseUrl}/api/payment-methods`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as any;
      assert.ok(body.success && Array.isArray(body.data));
      assert.ok(body.data.some((m: any) => m.id === pmBca1Id));
      assert.ok(body.data.some((m: any) => m.id === pmBca2Id));
      assert.ok(body.data.some((m: any) => m.id === pmInactiveBsiId));
    });

    await t.test("Scenario 2: Filter by each canonical DB payment method returns accurate transactions via API", async () => {
      // Cash: INV-PM-01 (1.000.000) + Split 30% of INV-PM-04 (300.000)
      const resCash = await fetch(`${baseUrl}/api/finance/profit?paymentMethodId=${encodeURIComponent(pmCashId)}&startDate=2026-06-01&endDate=2026-06-30`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      assert.strictEqual(resCash.status, 200);
      const cashData = ((await resCash.json()) as any).data as any[];
      const cashInvoices = cashData.map((d) => d.invoice);
      assert.ok(cashInvoices.includes("INV-PM-01"), "INV-PM-01 must match pm-cash");
      assert.ok(cashInvoices.includes("INV-PM-04"), "Split INV-PM-04 cash share must match pm-cash");
      const cashTotal = cashData.reduce((s, d) => s + Number(d.uangMasuk || 0), 0);
      assert.strictEqual(cashTotal, 1300000, "Cash filtered uangMasuk must equal 1.000.000 + 300.000 = 1.300.000");

      // CIMB NIAGA: Split 70% of INV-PM-04 (700.000)
      const resCimb = await fetch(`${baseUrl}/api/finance/profit?paymentMethodId=${encodeURIComponent(pmCimbId)}&startDate=2026-06-01&endDate=2026-06-30`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      const cimbData = ((await resCimb.json()) as any).data as any[];
      assert.strictEqual(cimbData.length, 1);
      assert.strictEqual(cimbData[0].invoice, "INV-PM-04");
      assert.strictEqual(cimbData[0].uangMasuk, 700000);
      assert.strictEqual(cimbData[0].profit, 350000);
    });

    await t.test("Scenario 3: Duplicate `Transfer Bank` nama_metode & duplicate BCA bank accounts remain isolated by canonical ID and unique labels", async () => {
      const pms = db
        .prepare("SELECT id, nama_metode, bank, nama_rekening, nomor_rekening, status FROM payment_methods")
        .all() as CanonicalPaymentMethodRecord[];
      const labelMap = buildPaymentMethodLabelMap(pms);

      const labelBca1 = labelMap.get(pmBca1Id)?.displayLabel;
      const labelBca2 = labelMap.get(pmBca2Id)?.displayLabel;
      const labelCimb = labelMap.get(pmCimbId)?.displayLabel;
      assert.notStrictEqual(labelBca1, labelBca2, "Duplicate BCA accounts must have distinct canonical labels (e.g., with nomor_rekening)");
      assert.ok(labelBca1?.includes("111000111"));
      assert.ok(labelBca2?.includes("222000222"));
      assert.ok(labelCimb && labelCimb !== "Transfer Bank", "Transfer Bank label must include specific bank name");

      // Filter BCA Account 1 -> ONLY INV-PM-02 (NOT INV-PM-03!)
      const res1 = await fetch(`${baseUrl}/api/finance/profit?paymentMethodId=${encodeURIComponent(pmBca1Id)}&startDate=2026-06-01&endDate=2026-06-30`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      const data1 = ((await res1.json()) as any).data as any[];
      assert.strictEqual(data1.length, 1);
      assert.strictEqual(data1[0].invoice, "INV-PM-02");
      assert.strictEqual(data1[0].paymentMethodId, pmBca1Id);

      // Filter BCA Account 2 -> ONLY INV-PM-03 (NOT INV-PM-02!)
      const res2 = await fetch(`${baseUrl}/api/finance/profit?paymentMethodId=${encodeURIComponent(pmBca2Id)}&startDate=2026-06-01&endDate=2026-06-30`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      const data2 = ((await res2.json()) as any).data as any[];
      assert.strictEqual(data2.length, 1);
      assert.strictEqual(data2[0].invoice, "INV-PM-03");
      assert.strictEqual(data2[0].paymentMethodId, pmBca2Id);
    });

    await t.test("Scenario 4: Unknown paymentMethodId returns empty dataset cleanly", async () => {
      const res = await fetch(`${baseUrl}/api/finance/profit?paymentMethodId=pm-unknown-does-not-exist`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as any;
      assert.deepStrictEqual(body.data, []);
    });

    await t.test("Scenario 5: Unpaid orders never enter payment method filters or verified profit", async () => {
      const allFilteredIds = [pmCashId, pmBca1Id, pmBca2Id, pmCimbId, pmInactiveBsiId];
      for (const methodId of allFilteredIds) {
        const res = await fetch(`${baseUrl}/api/finance/profit?paymentMethodId=${encodeURIComponent(methodId)}`, {
          headers: { Authorization: `Bearer ${financeToken}` },
        });
        const rows = ((await res.json()) as any).data as any[];
        assert.ok(!rows.some((r) => r.invoice === "INV-PM-05"), `Unpaid INV-PM-05 leaked into filter ${methodId}`);
      }

      const unfiltered = dbFinanceRepository.getProfitList();
      const unpaid = unfiltered.find((r) => r.invoice === "INV-PM-05");
      assert.ok(unpaid && unpaid.verifiedPaymentCount === 0 && unpaid.paymentMethodId === null);
    });

    await t.test("Scenario 6: Pending-verification Bayar di Awal orders never enter payment method filters or verified profit", async () => {
      const allFilteredIds = [pmCashId, pmBca1Id, pmBca2Id, pmCimbId, pmInactiveBsiId];
      for (const methodId of allFilteredIds) {
        const res = await fetch(`${baseUrl}/api/finance/profit?paymentMethodId=${encodeURIComponent(methodId)}`, {
          headers: { Authorization: `Bearer ${financeToken}` },
        });
        const rows = ((await res.json()) as any).data as any[];
        assert.ok(!rows.some((r) => r.invoice === "INV-PM-06"), `Pending verification INV-PM-06 leaked into filter ${methodId}`);
      }

      const unfiltered = dbFinanceRepository.getProfitList();
      const pending = unfiltered.find((r) => r.invoice === "INV-PM-06");
      assert.ok(pending && pending.verifiedPaymentCount === 0 && pending.paymentMethodId === null && pending.profit === 0);
    });

    await t.test("Scenario 7: Unfiltered JUNE window equals exact sum of partitioned canonical verified buckets (no double counting)", async () => {
      const resAll = await fetch(`${baseUrl}/api/finance/profit?startDate=2026-06-01&endDate=2026-06-30`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      const allJune = ((await resAll.json()) as any).data as any[];
      const testJuneRows = allJune.filter((r) => String(r.invoice || "").startsWith("INV-PM-"));
      // Paid verified invoices in June: PM-01 (1M), PM-02 (2M), PM-03 (1.5M), PM-04 (1M), PM-08 (600k), PM-09 (2.5M)
      const verifiedPaidSum = testJuneRows
        .filter((r) => r.verifiedPaymentCount > 0)
        .reduce((s, r) => s + Number(r.uangMasuk || 0), 0);
      assert.strictEqual(verifiedPaidSum, 1000000 + 2000000 + 1500000 + 1000000 + 600000 + 2500000);

      // Sum across each distinct payment method + unlinked PM-08 equals exact 8,600,000
      let bucketSum = 0;
      for (const methodId of [pmCashId, pmBca1Id, pmBca2Id, pmCimbId, pmInactiveBsiId]) {
        const rows = dbFinanceRepository.getProfitList({ paymentMethodId: methodId, startDate: "2026-06-01", endDate: "2026-06-30" });
        const testOnly = rows.filter((r) => String(r.invoice || "").startsWith("INV-PM-"));
        bucketSum += testOnly.reduce((s, r) => s + Number(r.uangMasuk || 0), 0);
      }
      const unlinkedPm08 = testJuneRows.find((r) => r.invoice === "INV-PM-08");
      assert.ok(unlinkedPm08 && unlinkedPm08.paymentMethodId === null);
      assert.strictEqual(bucketSum + unlinkedPm08.uangMasuk, verifiedPaidSum);
    });

    await t.test("Scenario 8: CSV & PDF export escaping and consistent KPI/table/export filter label", async () => {
      let capturedCsv = "";
      let capturedPdfHtml = "";
      const origBlob = (globalThis as any).Blob;
      const origDoc = (globalThis as any).document;
      const origUrl = (globalThis as any).URL;
      const origWin = (globalThis as any).window;

      (globalThis as any).Blob = class MockBlob {
        constructor(parts: any[]) {
          capturedCsv = parts.join("");
        }
      };
      (globalThis as any).URL = {
        createObjectURL: () => "blob:mock",
        revokeObjectURL: () => {},
      };
      (globalThis as any).document = {
        createElement: () => ({
          href: "",
          download: "",
          setAttribute: () => {},
          click: () => {},
        }),
        body: {
          appendChild: () => {},
          removeChild: () => {},
          contains: () => true,
        },
      };
      (globalThis as any).window = {
        open: () => ({
          document: {
            open: () => {},
            write: (html: string) => {
              capturedPdfHtml = html;
            },
            close: () => {},
          },
          focus: () => {},
          print: () => {},
        }),
      };

      const exportParams = {
        periodLabel: "01/06/2026 s.d 30/06/2026",
        filterMethodLabel: 'Transfer BCA (111000111), "Test"',
        filterCategoryLabel: "Balik Nama",
        grandTotals: {
          totalBerkas: 1,
          totalUangMasuk: 2000000,
          totalUangKeluar: 1200000,
          totalProfit: 800000,
          marginPercent: 40.0,
        },
        pendingTotals: {
          profitPending: 0,
          cashbackPending: 0,
          tagihanCustomer: 0,
        },
        groups: [
          {
            id: "balik-nama",
            categoryKey: "balik-nama",
            serviceTitle: "Balik Nama",
            jumlahBerkas: 1,
            totalUangMasuk: 2000000,
            breakdownUangMasuk: { "Transfer BCA (111000111)": { nominal: 2000000, count: 1 } },
            totalUangKeluar: 1200000,
            breakdownUangKeluar: { "Kas Kantor": { nominal: 1200000, count: 1 } },
            totalProfit: 800000,
            marginPercent: 40.0,
            profitPending: 0,
            cashbackPending: 0,
            tagihanCustomer: 0,
          },
        ],
      };

      try {
        exportProfitToCSV(exportParams);
        exportProfitToPDF(exportParams, "download");

        // Allow async export timers (1500ms blob revoke / 500ms print trigger) to fire cleanly under mocks
        await new Promise((r) => setTimeout(r, 1600));

        assert.ok(
          capturedCsv.includes('FILTER METODE PEMBAYARAN,"Transfer BCA (111000111), ""Test"""'),
          `CSV filter method label must be RFC-4180 escaped! Got: ${capturedCsv.slice(0, 400)}`
        );
        assert.ok(
          capturedCsv.includes("Transfer BCA (111000111): 2.000.000 (1)"),
          `CSV breakdown missing expected method text! Got: ${capturedCsv}`
        );
        assert.ok(capturedCsv.includes("TOTAL,TOTAL KESELURUHAN,1,2000000,,1200000,,800000,40.0%"));

        assert.ok(
          capturedPdfHtml.includes("Transfer BCA (111000111), &quot;Test&quot;"),
          "PDF export must HTML-escape filterMethodLabel cleanly"
        );
        assert.ok(capturedPdfHtml.includes("Transfer BCA (111000111):"));
      } finally {
        (globalThis as any).Blob = origBlob;
        (globalThis as any).document = origDoc;
        (globalThis as any).URL = origUrl;
        (globalThis as any).window = origWin;
      }
    });

    await t.test("Scenario 9: Combined WIB date + service category + payment method filter intersects cleanly", () => {
      // Narrow date to 2026-06-12..2026-06-15 + balik-nama + pm-test-bca-1 => ONLY INV-PM-02
      const filtered = dbFinanceRepository.getProfitList({
        startDate: "2026-06-12",
        endDate: "2026-06-15",
        category: "balik-nama",
        paymentMethodId: pmBca1Id,
      });
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].invoice, "INV-PM-02");

      // WIB boundary check: 2026-06-12T18:00:00Z is 2026-06-13 01:00 WIB
      assert.strictEqual(matchesWibDateRange("2026-06-12T18:00:00.000Z", "2026-06-13", "2026-06-13"), true);
      assert.strictEqual(matchesWibDateRange("2026-06-12T18:00:00.000Z", "2026-06-12", "2026-06-12"), false);
    });

    await t.test("Scenario 10: CANCELLED order & voided payment excluded from filtered and unfiltered profit results", () => {
      const cashRows = dbFinanceRepository.getProfitList({ paymentMethodId: pmCashId });
      assert.ok(!cashRows.some((r) => r.invoice === "INV-PM-07"), "CANCELLED INV-PM-07 must never appear");
      assert.ok(!cashRows.some((r) => r.invoice === "INV-PM-09"), "Voided cash payment on INV-PM-09 must never match pm-cash");
    });

    await t.test("Scenario 11: NULL / empty payment method NEVER defaults to Tunai or matches pm-cash", () => {
      assert.strictEqual(normalizeBankMethodName(null), "");
      assert.strictEqual(normalizeBankMethodName(""), "");
      assert.strictEqual(extractRealPaymentMethod({}), "");
      assert.strictEqual(
        resolveCanonicalPaymentMethod({ id: null, metode: "", namaBank: "", nomorRekening: "" }, [
          { id: pmCashId, nama_metode: "Tunai", bank: "Tunai", status: "Aktif" },
        ]),
        null
      );

      const unfiltered = dbFinanceRepository.getProfitList();
      const nullMethodRow = unfiltered.find((r) => r.invoice === "INV-PM-08");
      assert.ok(nullMethodRow, "INV-PM-08 should exist in unfiltered list");
      assert.strictEqual(nullMethodRow.paymentMethodId, null);
      assert.notStrictEqual(nullMethodRow.metodePembayaran, "Tunai");

      const cashOnly = dbFinanceRepository.getProfitList({ paymentMethodId: pmCashId });
      assert.ok(!cashOnly.some((r) => r.invoice === "INV-PM-08"), "NULL payment method row must NEVER match pm-cash filter");
    });

    await t.test("Scenario 12: Historical Nonaktif DB payment method preserved & filterable by canonical ID", () => {
      const bsiRows = dbFinanceRepository.getProfitList({ paymentMethodId: pmInactiveBsiId });
      const inv09 = bsiRows.find((r) => r.invoice === "INV-PM-09");
      assert.ok(inv09, "Historical verified transaction for Nonaktif method must be returned when filtered by its ID");
      assert.strictEqual(inv09.paymentMethodId, pmInactiveBsiId);
      assert.strictEqual(inv09.paymentMethodStatus, "Nonaktif");
      assert.ok(String(inv09.paymentMethodLabel).includes("(Nonaktif)"), `Expected (Nonaktif) marker in ${inv09.paymentMethodLabel}`);
    });

    await t.test("Scenario 13: Backend SQL failure on Profit query returns HTTP 500 PROFIT_QUERY_FAILED (never empty 200)", async () => {
      db.exec("ALTER TABLE invoice_payments RENAME TO invoice_payments_bak");
      try {
        const res = await fetch(`${baseUrl}/api/finance/profit`, {
          headers: { Authorization: `Bearer ${financeToken}` },
        });
        assert.strictEqual(res.status, 500, "SQL failure in getProfitList must return HTTP 500");
        const body = (await res.json()) as any;
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.error?.code, "PROFIT_QUERY_FAILED");
      } finally {
        db.exec("ALTER TABLE invoice_payments_bak RENAME TO invoice_payments");
      }

      const recovered = await fetch(`${baseUrl}/api/finance/profit`, {
        headers: { Authorization: `Bearer ${financeToken}` },
      });
      assert.strictEqual(recovered.status, 200);
    });

    await t.test("Scenario 14: ApiFinanceProvider propagates HTTP 500 error transparently (never returns null)", async () => {
      const origFetch = globalThis.fetch;
      const origAuthToken = process.env.AUTH_TOKEN;
      permissionStore.hydrateSession("finance", { notify: false, requireAuthoritativeSync: false });
      process.env.AUTH_TOKEN = financeToken;
      let provider: ApiFinanceProvider | null = null;
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input);
          if (u.includes("/finance/profit")) {
            return new Response(
              JSON.stringify({
                success: false,
                error: { code: "PROFIT_QUERY_FAILED", message: "DB query failed on profit" },
              }),
              { status: 500, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch;

        provider = new ApiFinanceProvider(`${baseUrl}/api`);
        await provider.initFromApi();
        const initErr = provider.getProfitError();
        assert.ok(initErr instanceof Error, "initFromApi must expose getProfitError() when /finance/profit fails");
        assert.match(initErr.message, /DB query failed on profit/);
        assert.deepStrictEqual(provider.getProfitList(), []);

        await assert.rejects(
          () => provider!.fetchFilteredProfitList({ paymentMethodId: pmCashId }),
          (err: any) => err instanceof Error && /DB query failed on profit/.test(err.message)
        );
      } finally {
        provider?.destroy();
        globalThis.fetch = origFetch;
        if (origAuthToken === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = origAuthToken;
        permissionStore.clearSession();
      }
    });

    await t.test("Scenario 15: ApiFinanceProvider propagates network failure transparently (never returns null)", async () => {
      const origFetch = globalThis.fetch;
      const origAuthToken = process.env.AUTH_TOKEN;
      permissionStore.hydrateSession("finance", { notify: false, requireAuthoritativeSync: false });
      process.env.AUTH_TOKEN = financeToken;
      let provider: ApiFinanceProvider | null = null;
      try {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const u = String(input);
          if (u.includes("/finance/profit")) {
            throw new TypeError("fetch failed: ECONNREFUSED");
          }
          return new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch;

        provider = new ApiFinanceProvider(`${baseUrl}/api`);
        await provider.initFromApi();
        const initErr = provider.getProfitError();
        assert.ok(initErr instanceof Error, "initFromApi must record profit network error");
        assert.match(initErr.message, /ECONNREFUSED/);

        await assert.rejects(
          () => provider!.fetchFilteredProfitList({ paymentMethodId: pmCashId }),
          (err: any) => err instanceof Error && /ECONNREFUSED/.test(err.message)
        );
      } finally {
        provider?.destroy();
        globalThis.fetch = origFetch;
        if (origAuthToken === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = origAuthToken;
        permissionStore.clearSession();
      }
    });

    await t.test("Scenario 16: ProfitReconciliationView enforces distinct Loading, Error, Valid Empty, and Data UI states", () => {
      const viewPath = path.resolve(process.cwd(), "src/app/components/finance/ProfitReconciliationView.tsx");
      const src = fs.readFileSync(viewPath, "utf8");
      assert.ok(src.includes("effectiveProfitError"), "Component must compute effectiveProfitError");
      assert.ok(src.includes("isProfitLoading"), "Component must compute isProfitLoading");
      assert.ok(src.includes("handleRetryProfit"), "Component must provide retry handler");
      assert.ok(src.includes("setServerFilteredProfit([])"), "Filter catch path must set [] instead of silent store fallback");
      assert.ok(src.includes('role="alert"'), "Component must render error alert banner");
      assert.ok(src.includes("Muat Ulang Data"), "Error UI must expose Muat Ulang Data retry action");
      assert.ok(
        src.includes("isExporting !== null || isProfitLoading || Boolean(effectiveProfitError)"),
        "Export buttons must be disabled during loading or error state"
      );
      assert.ok(src.includes("Memuat data profit dari server..."), "Loading table state must be distinct");
      assert.ok(
        src.includes("Tidak ada data penjualan atau transaksi profit yang sesuai dengan filter pencarian."),
        "Valid empty state text must remain intact"
      );
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
  }
});
