import test, { before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { orderRepository } from "../src/data/repositories/orderRepository";
import { financeRepository } from "../src/data/repositories/financeRepository";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";
import { orderStore } from "../src/app/data/orderStore";
import { financeStore } from "../src/app/data/financeStore";

let server: http.Server | null = null;
const prevToken = process.env.AUTH_TOKEN;

before(async () => {
  const started = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    const app = createApp();
    const s = http.createServer(app);
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: s, baseUrl: `http://localhost:${port}` });
    });
  });
  server = started.server;

  const loginRes = await fetch(`${started.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "svp@birojasa.com", password: "admin123" }),
  });
  assert.strictEqual(loginRes.status, 200);
  const loginBody = (await loginRes.json()) as any;
  process.env.AUTH_TOKEN = loginBody.data.token;

  orderRepository.setProvider(new ApiOrderProvider(`${started.baseUrl}/api`));
  financeRepository.setProvider(new ApiFinanceProvider(`${started.baseUrl}/api`));
  await Promise.all([orderStore.initFromApi(), financeStore.initFromApi()]);
});

after(async () => {
  await new Promise((r) => setTimeout(r, 150));
  if (prevToken === undefined) {
    delete process.env.AUTH_TOKEN;
  } else {
    process.env.AUTH_TOKEN = prevToken;
  }
  orderRepository.setProvider(new ApiOrderProvider());
  financeRepository.setProvider(new ApiFinanceProvider());
  server?.close();
});

test("Finance Sync - verifyPayment updates order payment status and synchronizes with finance invoice", async () => {
  const newOrder = await orderStore.addOrderAsync({
    customer: "Finance Test Client",
    namaPemilik: "Finance Test Client",
    nomorHP: "0812999999",
    nopol: "B 1234 FIN",
    layanan: "Perpanjangan 1 Tahun",
    totalEstimasi: 500000,
    payment: {
      tipePembayaran: "Bayar di Awal",
      metodePembayaran: "Transfer BCA",
      statusPembayaran: "Belum Lunas",
      totalBiaya: 500000,
      nominalDibayarAwal: 500000,
      dibayar: 500000,
      kurang: 0,
      isPaymentVerified: false,
    },
  });

  const orderNo = newOrder.orderNo;
  assert.ok(newOrder.payment.invoiceNo, "Invoice should be registered in financeStore");

  // Verify payment through orderStore against backend SQLite
  const verifiedOrder = await orderStore.verifyPaymentAsync(
    orderNo,
    "Finance Admin",
    500000,
    "Verified",
    { fileName: "bukti-1.jpg", uploadedAt: new Date().toISOString() }
  );
  assert.ok(verifiedOrder, "verifyPaymentAsync should return verified order");

  const orderAfterVerify = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(orderAfterVerify?.payment.statusPembayaran, "Lunas");
  assert.strictEqual(orderAfterVerify?.payment.isPaymentVerified, true);
  assert.strictEqual(orderAfterVerify?.payment.dibayar, 500000);
  assert.strictEqual(orderAfterVerify?.payment.kurang, 0);

  // Check financeStore invoice record synced with SQLite
  await financeStore.initFromApi();
  const invoice = financeStore.getInvoices().find((inv) => inv.orderNo === orderNo);
  assert.ok(invoice, "Invoice should exist in financeStore");
  assert.strictEqual(invoice?.status, "Lunas");
});

test("Finance Sync - syncFinalCostToFinance calculates UNDERPAID condition correctly", async () => {
  const newOrder = await orderStore.addOrderAsync({
    customer: "Underpaid Test Client",
    namaPemilik: "Underpaid Test Client",
    nomorHP: "0812888888",
    nopol: "B 5555 UND",
    layanan: "Perpanjangan 1 Tahun",
    totalEstimasi: 400000,
    payment: {
      tipePembayaran: "Bayar di Awal",
      metodePembayaran: "Cash",
      statusPembayaran: "Belum Lunas",
      totalBiaya: 400000,
      nominalDibayarAwal: 400000,
      dibayar: 400000,
      kurang: 0,
      isPaymentVerified: false,
    },
  });

  const orderNo = newOrder.orderNo;
  await orderStore.verifyPaymentAsync(
    orderNo,
    "Finance Admin",
    400000,
    "Verified",
    { fileName: "bukti-2.jpg", uploadedAt: new Date().toISOString() }
  );

  // Actual Samsat cost ends up higher: 400,000 paid vs 550,000 new total -> 150,000 underpaid
  const syncSuccess = orderStore.syncFinalCostToFinance(
    orderNo,
    550000, // newTotal
    450000, // biayaSamsat
    100000  // profit
  );

  assert.strictEqual(syncSuccess, true, "syncFinalCostToFinance should succeed");

  const orderAfterSync = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(orderAfterSync?.settlementCondition, "UNDERPAID");
  assert.strictEqual(orderAfterSync?.payment.kurang, 150000);
  assert.strictEqual(orderAfterSync?.payment.statusPembayaran, "Kurang Bayar");

  const invoice = financeStore.getInvoices().find((inv) => inv.orderNo === orderNo);
  assert.ok(invoice, "Invoice should exist");
  assert.strictEqual(invoice?.sisa, 150000);
  assert.strictEqual(invoice?.status, "Kurang Bayar");
});

test("Finance Sync - syncFinalCostToFinance calculates OVERPAID condition and processRefund settles it", async () => {
  const newOrder = await orderStore.addOrderAsync({
    customer: "Overpaid Test Client",
    namaPemilik: "Overpaid Test Client",
    nomorHP: "0812777777",
    nopol: "B 7777 OVR",
    layanan: "Perpanjangan 1 Tahun",
    totalEstimasi: 600000,
    payment: {
      tipePembayaran: "Bayar di Awal",
      metodePembayaran: "Transfer BCA",
      statusPembayaran: "Belum Lunas",
      totalBiaya: 600000,
      nominalDibayarAwal: 600000,
      dibayar: 600000,
      kurang: 0,
      isPaymentVerified: false,
    },
  });

  const orderNo = newOrder.orderNo;
  await orderStore.verifyPaymentAsync(
    orderNo,
    "Finance Admin",
    600000,
    "Verified",
    { fileName: "bukti-3.jpg", uploadedAt: new Date().toISOString() }
  );

  // Actual Samsat cost turns out lower: 600,000 paid vs 450,000 new total -> 150,000 overpaid
  const syncSuccess = orderStore.syncFinalCostToFinance(
    orderNo,
    450000, // newTotal
    350000, // biayaSamsat
    100000  // profit
  );

  assert.strictEqual(syncSuccess, true, "syncFinalCostToFinance should succeed");

  const orderAfterSync = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(orderAfterSync?.settlementCondition, "OVERPAID");
  assert.strictEqual(orderAfterSync?.refundStatus, "PENDING");
  assert.strictEqual(orderAfterSync?.payment.overpayment, 150000);

  // Process Refund
  const refundSuccess = orderStore.processRefund(orderNo, "Finance Lead");
  assert.strictEqual(refundSuccess, true, "processRefund should succeed");

  const orderAfterRefund = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(orderAfterRefund?.settlementCondition, "SETTLED");
  assert.strictEqual(orderAfterRefund?.refundStatus, "PROCESSED");
  assert.strictEqual(orderAfterRefund?.payment.refundAmount, 150000);
});

test("Finance Sync - syncPaymentFromFinance updates order from finance events", async () => {
  const newOrder = await orderStore.addOrderAsync({
    customer: "Reverse Sync Client",
    namaPemilik: "Reverse Sync Client",
    nomorHP: "0812666666",
    nopol: "B 6666 REV",
    layanan: "Perpanjangan 1 Tahun",
    totalEstimasi: 300000,
    payment: {
      tipePembayaran: "Bayar di Akhir",
      metodePembayaran: "Cash",
      statusPembayaran: "Belum Bayar",
      totalBiaya: 300000,
      dibayar: 0,
      kurang: 300000,
    },
  });

  const orderNo = newOrder.orderNo;

  // Simulate payment recorded directly in Finance
  const syncSuccess = orderStore.syncPaymentFromFinance({
    orderNo,
    statusPembayaran: "Lunas",
    dibayar: 300000,
    kurang: 0,
    totalBiaya: 300000,
    tanggalBayar: "2026-10-03",
    metodePembayaran: "Transfer BCA",
  });

  assert.strictEqual(syncSuccess, true, "syncPaymentFromFinance should succeed");

  const orderAfterSync = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(orderAfterSync?.payment.statusPembayaran, "Lunas");
  assert.strictEqual(orderAfterSync?.payment.dibayar, 300000);
  assert.strictEqual(orderAfterSync?.payment.kurang, 0);
  assert.strictEqual(orderAfterSync?.payment.metodePembayaran, "Transfer BCA");
});
