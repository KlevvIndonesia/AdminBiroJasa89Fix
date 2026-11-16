/**
 * SUN89 — BATCH 2: ORDER, INVOICE, COGS & PROFIT INTEGRITY TEST SUITE
 *
 * Covers Batch 2 remediation scopes on isolated SQLite:
 * - Phase B: Order-Invoice 1:1 Identity, Collision Rollback, Atomic Sync, Read-Only Anomaly Scanner
 * - Phase C: Canonical Samsat COGS Mapping (PKB + SWDKLLJ/OPSEN + Denda + Admin Samsat vs Jasa/Courier),
 *            Explicit Zero vs Unconfigured preservation, Pricing Sanity & BuatOrder/OrderTracking parity
 * - Phase D: Profit Calculation without 75%/25% or BCA/772-019-2831 fallbacks, CANCELLED exclusion
 *            with refund/audit preservation, Single-Count ProfitReconciliationView deduplication
 * - Phase E: Payment-Invoice Consistency & Unverified Bayar di Awal Pending Isolation
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "../server/src/database/db";
import { orderService } from "../server/src/services/orderService";
import { financeService } from "../server/src/services/financeService";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { validateOrderPricingSanity } from "../server/src/utils/pricingSanityCheck";
import { resolveCanonicalSamsatCogs } from "../src/domain/finance/samsatCogs";
import { computeCanonicalLabaRugi } from "../src/domain/finance/labaRugiCanonical";
import { pricingStore } from "../src/app/data/pricingStore";

const testAdmin = {
  userId: "usr-1",
  id: 1,
  nama: "Super Admin Batch 2",
  role: "admin" as const,
};

test("SUN89 BATCH 2: Order, Invoice, COGS & Profit Integrity Suite", async (t) => {
  await t.test("B-1: Order creation enforces 1:1 Order <-> Invoice linkage and atomic update sync", () => {
    const order = orderService.createOrder(
      {
        customer: "PT Satu Invoice",
        nomorHP: "081200011001",
        layanan: "Perpanjangan 1 Tahun",
        serviceId: "svc-perp-1th",
        nopol: "B 2001 B2A",
        biayaJasa: 250000,
        biayaAntarJemput: 50000,
        pkb: 600000,
        swdkllj: 143000,
        dendaSwdkllj: 0,
        totalEstimasi: 1043000,
        payment: {
          tipePembayaran: "Bayar di Akhir",
          metodePembayaran: "Cash",
          totalBiaya: 1043000,
          dibayar: 0,
        },
      },
      testAdmin
    );

    const inv = dbFinanceRepository.getInvoiceByOrderNo(order.orderNo);
    assert.ok(inv, "Created order must immediately persist linked finance_invoices row");
    assert.strictEqual(inv.orderNo, order.orderNo);
    assert.strictEqual(inv.invoiceNo, order.noInvoice);
    assert.strictEqual(inv.totalTagihan, 1043000);
    assert.strictEqual(inv.biayaSamsat, 743000, "biayaSamsat must combine PKB + SWDKLLJ");
    assert.strictEqual(inv.biayaJasa, 250000);
    assert.strictEqual(inv.biayaAntarJemput, 50000);

    // Update order total & PKB -> must atomically sync finance_invoices (without protected payment.isPaymentVerified)
    const updated = orderService.updateOrder(
      order.orderNo,
      {
        pkb: 700000,
        swdkllj: 143000,
        totalEstimasi: 1143000,
        payment: {
          tipePembayaran: order.payment.tipePembayaran,
          metodePembayaran: order.payment.metodePembayaran,
          totalBiaya: 1143000,
        },
      } as any,
      testAdmin
    );
    assert.ok(updated);
    const invAfter = dbFinanceRepository.getInvoiceByOrderNo(order.orderNo)!;
    assert.strictEqual(invAfter.totalTagihan, 1143000);
    assert.strictEqual(invAfter.biayaSamsat, 843000);
    assert.strictEqual(invAfter.sisa, 1143000);
  });

  await t.test("B-2: Duplicate/colliding invoice number throws 409 and rolls back orphan order", () => {
    const seedOrder = orderService.createOrder(
      {
        customer: "Pemilik Sah Invoice",
        nomorHP: "081200011002",
        layanan: "Perpanjangan 1 Tahun",
        nopol: "B 2002 B2B",
        biayaJasa: 250000,
        biayaSamsat: 500000,
        totalEstimasi: 750000,
        payment: {
          tipePembayaran: "Bayar di Akhir",
          metodePembayaran: "Cash",
          totalBiaya: 750000,
          dibayar: 0,
        },
      },
      testAdmin
    );
    const activeMmYy = seedOrder.orderNo.slice(4, 8);
    assert.strictEqual(seedOrder.noInvoice, `INV-${activeMmYy}-${seedOrder.orderNo.slice(9)}`);

    // Simulate an orphan invoice-holder mismatch / collision attempt on a matching MMYY-SEQ pair
    const conflictingSuffix = "994";
    const conflictingOrderNo = `ORD-${activeMmYy}-${conflictingSuffix}`;
    dbFinanceRepository.saveInvoice({
      invoiceNo: `INV-${activeMmYy}-${conflictingSuffix}`,
      orderNo: "ORD-OTHER-LOCK",
      customer: "Locker",
      layanan: "Perpanjangan 1 Tahun",
      nopol: "B 2099 LCK",
      status: "UNPAID",
      totalTagihan: 500000,
      dibayar: 0,
      sisa: 500000,
      biayaSamsat: 300000,
      pendapatanJasa: 200000,
      biayaJasa: 200000,
    });

    assert.throws(
      () => {
        orderService.createOrder(
          {
            orderNo: conflictingOrderNo,
            customer: "Orphan Rollback Victim",
            nomorHP: "081200011003",
            layanan: "Perpanjangan 1 Tahun",
            nopol: "B 2003 B2C",
            biayaJasa: 250000,
            biayaSamsat: 400000,
            totalEstimasi: 650000,
            payment: {
              tipePembayaran: "Bayar di Akhir",
              metodePembayaran: "Cash",
              totalBiaya: 650000,
              dibayar: 0,
            },
          },
          testAdmin
        );
      },
      (err: any) => err?.statusCode === 409 || String(err?.message || "").includes("FINANCE_INVOICE_COLLISION")
    );

    const orphanOrder = dbOrderRepository.getByOrderNo(conflictingOrderNo);
    assert.strictEqual(orphanOrder, undefined, "Transaction must roll back orphan order when invoice collides");

    // Clean synthetic locker row so later reconciliation assertions stay clean
    db.prepare("DELETE FROM finance_invoices WHERE order_no = ?").run("ORD-OTHER-LOCK");
  });

  await t.test("B-3: Read-only getOrderInvoiceReconciliationReport detects anomalies without mutating DB", () => {
    const beforeCount = (db.prepare("SELECT COUNT(*) as c FROM finance_invoices").get() as any).c;
    const report = dbFinanceRepository.getOrderInvoiceReconciliationReport();
    assert.ok(Array.isArray(report.missingInvoicesForOrders));
    assert.ok(Array.isArray(report.orderInvoiceMismatches));
    assert.ok(Array.isArray(report.totalAmountMismatches));
    assert.ok(Array.isArray(report.cancelledStatusMismatches));
    assert.ok(Array.isArray(report.understatedCogsInvoices));
    assert.ok(Array.isArray(report.verifiedPaymentsMissingKasKantor));
    assert.ok(Array.isArray(report.duplicatePendingPayments));
    const afterCount = (db.prepare("SELECT COUNT(*) as c FROM finance_invoices").get() as any).c;
    assert.strictEqual(beforeCount, afterCount, "Scanner must be strictly read-only");
  });

  await t.test("C-1: Canonical Samsat COGS maps PKB + SWDKLLJ + Denda + Samsat Admin, excluding Jasa & Courier", () => {
    const resolved = resolveCanonicalSamsatCogs({
      biayaSamsat: 100000, // legacy understated admin-only snapshot field
      biayaJasa: 250000,
      biayaAntarJemput: 65000,
      totalTagihan: 1358000,
      pkb: 750000,
      swdkllj: 143000,
      dendaSwdkllj: 50000,
      costSnapshot: {
        biayaSamsat: 100000,
        biayaJasa: 250000,
        biayaAntarJemput: 65000,
        breakdown: [
          { itemId: "cetak-skp", name: "Cetak SKP", category: "Samsat", nominal: 100000, status: "CONFIGURED" },
          { itemId: "biaya-jasa", name: "Biaya Jasa", category: "Jasa", nominal: 250000, status: "CONFIGURED" },
          { itemId: "biaya-antar-jemput", name: "Antar Jemput", category: "Antar Jemput", nominal: 65000, status: "CONFIGURED" },
        ],
      },
    });
    assert.strictEqual(resolved.taxComponentTotal, 943000);
    assert.strictEqual(resolved.samsatAdminTotal, 100000);
    assert.strictEqual(resolved.biayaSamsat, 1043000, "COGS = 750k + 143k + 50k + 100k = 1,043,000");
    assert.strictEqual(resolved.biayaJasa, 250000);
    assert.strictEqual(resolved.biayaAntarJemput, 65000);
    assert.strictEqual(resolved.costClassification, "DEFINITIVE");

    // Sanity check validator uses canonical COGS resolution even if top-level biayaSamsat omitted
    const sanity = validateOrderPricingSanity({
      layanan: "Perpanjangan 1 Tahun",
      biayaJasa: 250000,
      biayaAntarJemput: 65000,
      pkb: 750000,
      swdkllj: 143000,
      dendaSwdkllj: 50000,
      totalEstimasi: 1358000,
      costSnapshot: {
        breakdown: [
          { itemId: "cetak-skp", name: "Cetak SKP", category: "Samsat", nominal: 100000, status: "CONFIGURED" },
          { itemId: "biaya-jasa", name: "Biaya Jasa", category: "Jasa", nominal: 250000, status: "CONFIGURED" },
        ],
      },
    });
    assert.strictEqual(sanity.isValid, true);
    assert.strictEqual(sanity.resolvedBiayaSamsat, 1043000);

    // pricingStore.calculateOrderCost includes PKB + SWDKLLJ + Denda in biayaSamsat
    const calc = pricingStore.calculateOrderCost({
      serviceId: "svc-perp-1th",
      samsatAsalId: "samsat-jakarta-timur",
      pkb: 500000,
      swdkllj: 143000,
      dendaSwdkllj: 35000,
    });
    assert.ok(calc.biayaSamsat >= 678000, `Expected calc.biayaSamsat >= 678000 (PKB+SWDKLLJ+Denda), got ${calc.biayaSamsat}`);
  });

  await t.test("C-2: Explicit zero Rp 0 is preserved without inventing Profit; unconfigured is held pending", () => {
    const zeroResolved = resolveCanonicalSamsatCogs({
      biayaSamsat: 0,
      biayaJasa: 250000,
      totalTagihan: 250000,
      isExplicitZero: true,
    });
    assert.strictEqual(zeroResolved.biayaSamsat, 0);
    assert.strictEqual(zeroResolved.costClassification, "EXPLICIT_ZERO");
    assert.strictEqual(zeroResolved.isExplicitZero, true);
    assert.strictEqual(zeroResolved.isCostPending, false);

    const unconfResolved = resolveCanonicalSamsatCogs({
      biayaSamsat: 0,
      biayaJasa: 250000,
      totalTagihan: 250000,
      costVerificationStatus: "UNCONFIGURED",
      isDraftEstimate: true,
    });
    assert.strictEqual(unconfResolved.biayaSamsat, 0);
    assert.strictEqual(unconfResolved.costClassification, "UNCONFIGURED");
    assert.strictEqual(unconfResolved.isCostPending, true);
  });

  await t.test("D-1 & E-1: Unverified Bayar di Awal stays UNPAID/0 profit until verified; Verification links payment -> Kas -> Profit & dynamic bank", () => {
    const bankCimbRow = db
      .prepare("SELECT id, nama_metode, bank, nomor_rekening, nama_rekening FROM payment_methods WHERE UPPER(bank) LIKE '%CIMB%' LIMIT 1")
      .get() as any;

    const order = orderService.createOrder(
      {
        customer: "PT Pending Sampai Verif",
        nomorHP: "081200011004",
        layanan: "Perpanjangan 1 Tahun",
        serviceId: "svc-perp-1th",
        nopol: "B 2004 VER",
        biayaJasa: 230000,
        biayaAntarJemput: 65000,
        pkb: 750000,
        swdkllj: 143000,
        biayaSamsat: 963000,
        totalEstimasi: 1258000,
        payment: {
          tipePembayaran: "Bayar di Awal",
          metodePembayaran: bankCimbRow?.nama_metode || "Transfer CIMB NIAGA",
          bank: bankCimbRow?.bank || "CIMB NIAGA",
          totalBiaya: 1258000,
          dibayar: 1258000,
          isPaymentVerified: false,
          buktiPembayaran: { fileName: "proof_ver.jpg", fileType: "image" },
        },
      },
      testAdmin
    );

    const invBefore = dbFinanceRepository.getInvoiceByOrderNo(order.orderNo)!;
    assert.strictEqual(invBefore.dibayar, 0, "Unverified Bayar di Awal MUST NOT reduce invoice balance");
    assert.strictEqual(invBefore.status, "UNPAID", "Invoice status MUST be UNPAID prior to verification");
    assert.strictEqual(invBefore.sisa, 1258000);
    assert.strictEqual(invBefore.profit, 0, "Unverified payment MUST have 0 profit");

    const profitBefore = dbFinanceRepository.getProfitList().find((p) => p.orderNo === order.orderNo || p.nopol === "B 2004 VER");
    assert.ok(!profitBefore || profitBefore.profit === 0, "Profit must be 0 before verification");

    // Verify payment now
    orderService.verifyPayment(order.orderNo, testAdmin, 1258000, "Verified Bank CIMB");

    const invAfter = dbFinanceRepository.getInvoiceByOrderNo(order.orderNo)!;
    assert.strictEqual(invAfter.dibayar, 1258000);
    assert.strictEqual(invAfter.status, "PAID");
    assert.strictEqual(invAfter.biayaSamsat, 963000);
    // Profit = 1,258,000 - 963,000 = 295,000 (gross before antar jemput deduction at Laba Rugi / Net Margin)
    assert.strictEqual(invAfter.profit, 295000);

    const pays = dbFinanceRepository.getPaymentsByOrderNo(order.orderNo);
    assert.strictEqual(pays.length, 1);
    assert.strictEqual(pays[0].status_verifikasi, "TERVERIFIKASI");
    assert.ok(pays[0].kas_kantor_id, "Verified payment must post linked kas_kantor entry");

    const profitRow = dbFinanceRepository.getProfitList().find((p) => p.nopol === "B 2004 VER");
    assert.ok(profitRow, "Verified order must appear in Profit list");
    assert.strictEqual(profitRow.biayaSamsat, 963000);
    assert.strictEqual(profitRow.profit, 295000);
    assert.notStrictEqual(profitRow.nomorRekening, "772-019-2831", "Must NOT emit hardcoded 772-019-2831");
    assert.notStrictEqual(profitRow.namaPemilikRekening, "PT Biro Jasa SUN89 Abadi", "Must NOT emit hardcoded company name");
    if (bankCimbRow) {
      assert.strictEqual(profitRow.namaBank, bankCimbRow.bank);
      assert.strictEqual(profitRow.nomorRekening, bankCimbRow.nomor_rekening);
      assert.strictEqual(profitRow.namaPemilikRekening, bankCimbRow.nama_rekening);
    }
  });

  await t.test("D-2: CANCELLED orders and their costs are strictly excluded from Profit while preserving refund history", () => {
    const order = orderService.createOrder(
      {
        customer: "PT Cancel Exclusion",
        nomorHP: "081200011005",
        layanan: "Perpanjangan 1 Tahun",
        serviceId: "svc-perp-1th",
        nopol: "B 2005 CAN",
        biayaJasa: 300000,
        biayaSamsat: 700000,
        totalEstimasi: 1000000,
        payment: {
          tipePembayaran: "Bayar di Awal",
          metodePembayaran: "Cash",
          totalBiaya: 1000000,
          dibayar: 1000000,
          isPaymentVerified: true,
          buktiPembayaran: { fileName: "proof_can.jpg", fileType: "image" },
        },
      },
      testAdmin
    );

    const activeProfit = dbFinanceRepository.getProfitList().find((p) => p.nopol === "B 2005 CAN");
    assert.ok(activeProfit, "Active paid order exists in Profit before cancellation");
    assert.strictEqual(activeProfit.profit, 300000);

    // Cancel order
    orderService.cancelOrder(order.orderNo, "Konsumen batal mendadak", testAdmin);

    const invAfterCancel = dbFinanceRepository.getInvoiceByOrderNo(order.orderNo)!;
    assert.strictEqual(invAfterCancel.status, "CANCELLED");
    assert.strictEqual(invAfterCancel.refundStatus, "PENDING", "Refund tracking must be preserved on cancellation");
    assert.strictEqual(invAfterCancel.overpayment, 1000000, "Paid deposit refund liability must remain preserved");

    const cancelledInProfit = dbFinanceRepository.getProfitList().find((p) => p.nopol === "B 2005 CAN" || p.orderNo === order.orderNo);
    assert.strictEqual(cancelledInProfit, undefined, "CANCELLED order MUST be excluded from getProfitList()");

    const pnl = computeCanonicalLabaRugi(
      [invAfterCancel],
      [],
      [],
      "all",
      undefined,
      undefined,
      undefined,
      []
    );
    assert.strictEqual(pnl.grossProfit, 0, "Cancelled invoice must contribute Rp 0 to Laba Rugi grossProfit");
  });

  await t.test("D-3: Static guard verifies removal of 75%/25%/70%/15% fallbacks & double-counting in frontend profit modules", () => {
    const providerSrc = fs.readFileSync(path.resolve("src/data/api/apiFinanceProvider.ts"), "utf8");
    const storeSrc = fs.readFileSync(path.resolve("src/app/data/financeStore.ts"), "utf8");
    const reconViewSrc = fs.readFileSync(path.resolve("src/app/components/finance/ProfitReconciliationView.tsx"), "utf8");

    assert.ok(!providerSrc.includes("totalTagihan * 0.75"), "apiFinanceProvider must not contain 0.75 fallback");
    assert.ok(!providerSrc.includes("totalTagihan * 0.25"), "apiFinanceProvider must not contain 0.25 fallback");
    assert.ok(!storeSrc.includes("772-019-2831"), "financeStore must not hardcode 772-019-2831");
    assert.ok(!storeSrc.includes("PT Biro Jasa SUN89 Abadi"), "financeStore must not hardcode PT Biro Jasa SUN89 Abadi");
    assert.ok(!storeSrc.includes("biayaSamsat * 0.7)"), "financeStore must not fabricate PKB via * 0.7");
    assert.ok(!storeSrc.includes("biayaSamsat * 0.15)"), "financeStore must not fabricate SWDKLLJ via * 0.15");
    assert.ok(!storeSrc.includes("totalTagihan * 0.75"), "financeStore must not fabricate danaTitipanPajak via * 0.75");
    assert.ok(reconViewSrc.includes("seenKeys") && reconViewSrc.includes("isCancelledRow"), "ProfitReconciliationView must deduplicate across orderNo/invoiceNo and exclude CANCELLED rows");
  });
});
