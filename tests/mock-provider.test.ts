import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { OperationalOrder, STAGES } from "../src/domain/order/types";

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

function buildOrderPayload(suffix: string, customer: string): OperationalOrder {
  return {
    orderNo: `TMP-PROV-${suffix}`,
    customer,
    nomorHP: "081234567890",
    layanan: "Perpanjangan 1 Tahun",
    currentStep: 1,
    currentStageName: "Verifikasi",
    createdAt: new Date().toISOString(),
    namaPemilik: customer,
    kepemilikanKendaraan: "Milik Sendiri",
    nopol: `B ${suffix.slice(-4)} ABC`,
    wilayahSamsatAsal: "Jakarta Timur",
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

test("ApiOrderProvider - Loads SQLite collections across all 8 stages", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const provider = new ApiOrderProvider(`${baseUrl}/api`);

    const created = await provider.addOrderAsync(buildOrderPayload("1001", "PT. Maju Jaya Abadi"));
    await provider.initFromApi();

    const activeOrders = provider.getActiveOrders();
    for (const stage of STAGES) {
      assert.ok(Array.isArray(activeOrders[stage]), `Stage '${stage}' should be an array`);
    }

    const found = provider.getOrderByNo(created.orderNo);
    assert.ok(found, "Created order should be returned from SQLite");
    assert.strictEqual(found?.customer, "PT. Maju Jaya Abadi");
    assert.strictEqual(found?.currentStageName, "Verifikasi");
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("ApiOrderProvider - Preserves isolation: mutating one order does not alter others", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const provider = new ApiOrderProvider(`${baseUrl}/api`);

    const order1 = await provider.addOrderAsync(buildOrderPayload("2001", "Order Satu"));
    const order2 = await provider.addOrderAsync(buildOrderPayload("2002", "Order Dua"));

    await provider.updateOrderAsync(order1.orderNo, {
      customer: "Budi Changed Name",
      catatanOrder: `Special memo for ${order1.orderNo}`,
    });

    await provider.initFromApi();
    const refreshedOrder1 = provider.getOrderByNo(order1.orderNo);
    const refreshedOrder2 = provider.getOrderByNo(order2.orderNo);

    assert.strictEqual(refreshedOrder1?.customer, "Budi Changed Name");
    assert.strictEqual(refreshedOrder1?.catatanOrder, `Special memo for ${order1.orderNo}`);
    assert.strictEqual(refreshedOrder2?.customer, "Order Dua", "Second order should remain untouched");
    assert.notStrictEqual(refreshedOrder2?.catatanOrder, `Special memo for ${order1.orderNo}`);
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("ApiOrderProvider - addOrderAsync persists order into Verifikasi stage", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const provider = new ApiOrderProvider(`${baseUrl}/api`);

    const created = await provider.addOrderAsync(buildOrderPayload("3001", "Dewi Lestari"));
    const found = provider.getOrderByNo(created.orderNo);
    assert.ok(found, "Newly added order should be found");
    assert.strictEqual(found?.customer, "Dewi Lestari");

    const verifikasiList = provider.getOrdersByStage("Verifikasi");
    assert.ok(verifikasiList.some((o) => o.orderNo === created.orderNo), "Should be in Verifikasi list");
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("ApiOrderProvider - rollbackOrderAsync moves order from Stage 3 back to Stage 2", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const provider = new ApiOrderProvider(`${baseUrl}/api`);

    const created = await provider.addOrderAsync(buildOrderPayload("4001", "Rolled Back Customer"));
    dbOrderRepository.updateOrder(created.orderNo, {
      currentStep: 3,
      currentStageName: "Verifikasi Dokumen",
    });
    await provider.initFromApi();
    assert.strictEqual(provider.getOrderByNo(created.orderNo)?.currentStageName, "Verifikasi Dokumen");

    const rolledBackOrder = await provider.rollbackOrderAsync(created.orderNo, "Penjadwalan", {
      catatanOrder: "Dokumen kurang lengkap, dijadwalkan ulang",
    });
    assert.strictEqual(rolledBackOrder.currentStageName, "Penjadwalan");
    assert.strictEqual(rolledBackOrder.currentStep, 2);
    assert.strictEqual(rolledBackOrder.catatanOrder, "Dokumen kurang lengkap, dijadwalkan ulang");

    const stage3List = provider.getOrdersByStage("Verifikasi Dokumen");
    assert.strictEqual(stage3List.some((o) => o.orderNo === created.orderNo), false);

    const stage2List = provider.getOrdersByStage("Penjadwalan");
    assert.strictEqual(stage2List.some((o) => o.orderNo === created.orderNo), true);
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});

test("ApiOrderProvider - Non-existent order mutations fail cleanly without corrupting state", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = await loginAsAdmin(baseUrl);
    const provider = new ApiOrderProvider(`${baseUrl}/api`);
    await provider.initFromApi();

    assert.strictEqual(provider.updateOrder("GHOST-ORDER", { customer: "Ghost" }), false);
    assert.strictEqual(provider.getOrderByNo("GHOST-ORDER"), undefined);
    await assert.rejects(() => provider.updateOrderAsync("GHOST-ORDER", { customer: "Ghost" }));
    await assert.rejects(() => provider.advanceOrderAsync("GHOST-ORDER", "Proses Samsat", {}));
    await assert.rejects(() => provider.rollbackOrderAsync("GHOST-ORDER", "Verifikasi", {}));
    await assert.rejects(() => provider.archiveOrderAsync("GHOST-ORDER"));
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});
