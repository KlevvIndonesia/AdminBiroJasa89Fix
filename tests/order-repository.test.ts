import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { OrderRepository } from "../src/data/repositories/orderRepository";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { OperationalOrder } from "../src/domain/order/types";

function startTestServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = createApp();
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

async function loginAsAdmin(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@birojasa.com", password: "admin123" }),
  });
  const body = (await res.json()) as any;
  assert.strictEqual(res.status, 200);
  return body.data.token;
}

function makeOrder(suffix: string, customer: string): OperationalOrder {
  return {
    orderNo: `TMP-REPO-${suffix}`,
    customer,
    nomorHP: "081234567890",
    layanan: "Perpanjangan 1 Tahun",
    currentStep: 1,
    currentStageName: "Verifikasi",
    createdAt: new Date().toISOString(),
    namaPemilik: customer,
    kepemilikanKendaraan: "Milik Sendiri",
    nopol: `B ${suffix.slice(-4)} RPO`,
    wilayahSamsatAsal: "Jakarta Timur",
    wilayahSamsatTujuan: "-",
    nominalPkbTerakhir: 350000,
    nominalSwdkllj: 143000,
    biayaJasa: 100000,
    pkb: 350000,
    swdkllj: 143000,
    dendaSwdkllj: 0,
    totalEstimasi: 593000,
    payment: {
      tipePembayaran: "Bayar di Awal",
      metodePembayaran: "Cash",
      statusPembayaran: "Lunas",
      totalBiaya: 593000,
      dibayar: 593000,
      kurang: 0,
    },
    clientDocuments: {},
    samsatProcesses: [],
  };
}

test("OrderRepository - Read operations return valid SQLite collections", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const repo = new OrderRepository(new ApiOrderProvider(`${baseUrl}/api`));

    const saved = await repo.saveOrderAsync(makeOrder("001", "Test Read Customer"));
    await repo.initFromApi();

    const activeOrders = repo.getActiveOrders();
    assert.ok(activeOrders, "Active orders should exist");
    assert.ok(Array.isArray(activeOrders["Verifikasi"]), "Stage Verifikasi should be an array");

    const allOrders = repo.getAllFlat();
    assert.ok(Array.isArray(allOrders), "getAllFlat should return an array");
    assert.ok(allOrders.length > 0, "Repository should have orders after saving");

    const foundByNo = repo.getByOrderNo(saved.orderNo);
    assert.strictEqual(foundByNo?.orderNo, saved.orderNo, "getByOrderNo should find the order");

    const byStage = repo.getByStage("Verifikasi");
    assert.ok(Array.isArray(byStage), "getByStage should return an array");
    assert.ok(byStage.some((o) => o.orderNo === saved.orderNo), "getByStage should include saved order");
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("OrderRepository - Mutation operations: saveOrderAsync and updateOrderAsync", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const repo = new OrderRepository(new ApiOrderProvider(`${baseUrl}/api`));

    const saved = await repo.saveOrderAsync(makeOrder("002", "Budi Test"));
    const fetched = repo.getByOrderNo(saved.orderNo);
    assert.ok(fetched, "Order should be saved in repository");
    assert.strictEqual(fetched?.customer, "Budi Test");

    const updateSuccess = await repo.updateOrderAsync(saved.orderNo, { customer: "Budi Updated" });
    assert.strictEqual(updateSuccess, true, "updateOrderAsync should succeed");

    await repo.initFromApi();
    const updated = repo.getByOrderNo(saved.orderNo);
    assert.strictEqual(updated?.customer, "Budi Updated", "Customer name should persist in SQLite");

    assert.strictEqual(repo.updateOrder("NON-EXISTENT-9999", { customer: "Nobody" }), false);
    await assert.rejects(() => repo.updateOrderAsync("NON-EXISTENT-9999", { customer: "Nobody" }));
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("OrderRepository - advanceOrderAsync moves order between stages in SQLite", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const repo = new OrderRepository(new ApiOrderProvider(`${baseUrl}/api`));

    const saved = await repo.saveOrderAsync(makeOrder("003", "Andi Workflow"));
    const advanced = await repo.advanceOrderAsync(saved.orderNo, "Penjadwalan", {
      tanggalPenjadwalan: "2026-10-10",
    });
    assert.ok(advanced && typeof advanced === "object", "advanceOrderAsync should return updated order");

    const orderAfterAdvance = repo.getByOrderNo(saved.orderNo);
    assert.strictEqual(orderAfterAdvance?.currentStageName, "Penjadwalan");
    assert.strictEqual(orderAfterAdvance?.currentStep, 2);
    assert.strictEqual(orderAfterAdvance?.tanggalPenjadwalan, "2026-10-10");

    assert.strictEqual(repo.getByStage("Verifikasi").some((o) => o.orderNo === saved.orderNo), false);
    assert.strictEqual(repo.getByStage("Penjadwalan").some((o) => o.orderNo === saved.orderNo), true);
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("OrderRepository - archiveOrderAsync moves Stage 8 order to archived collection", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const repo = new OrderRepository(new ApiOrderProvider(`${baseUrl}/api`));

    const saved = await repo.saveOrderAsync(makeOrder("004", "Citra Selesai"));
    dbOrderRepository.updateOrder(saved.orderNo, {
      currentStep: 8,
      currentStageName: "Dokumen Telah Diterima",
      isReceived: true,
    });
    await repo.initFromApi();
    assert.strictEqual(repo.getArchivedOrders().length, 0);

    const archiveSuccess = await repo.archiveOrderAsync(saved.orderNo);
    assert.strictEqual(archiveSuccess, true, "archiveOrderAsync should succeed at Stage 8");

    await repo.initFromApi();
    const archivedList = repo.getArchivedOrders();
    assert.ok(archivedList.some((o) => o.orderNo === saved.orderNo));

    const activeOrder = repo.getByStage("Dokumen Telah Diterima").find((o) => o.orderNo === saved.orderNo);
    assert.strictEqual(activeOrder, undefined, "Archived order should not be in active stages");
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("OrderRepository - Subscription notifies listeners on state changes", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const repo = new OrderRepository(new ApiOrderProvider(`${baseUrl}/api`));
    await repo.initFromApi();

    let notifyCount = 0;
    const unsubscribe = repo.subscribe(() => {
      notifyCount++;
    });

    const saved = await repo.saveOrderAsync(makeOrder("005", "Test Listener"));
    const countAfterSave = notifyCount;
    assert.ok(countAfterSave >= 1, "Listener should be called on saveOrderAsync");

    await repo.updateOrderAsync(saved.orderNo, { customer: "Updated Listener" });
    assert.ok(notifyCount > countAfterSave, "Listener should be called again on updateOrderAsync");
    const countBeforeUnsub = notifyCount;

    unsubscribe();
    await repo.updateOrderAsync(saved.orderNo, { customer: "After Unsubscribe" });
    assert.strictEqual(notifyCount, countBeforeUnsub, "Listener should not be called after unsubscribe");
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});
