import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { karyawanPenggunaAdapter } from "../src/app/data/karyawanPenggunaAdapter";
import { orderStore } from "../src/app/data/orderStore";
import { orderRepository } from "../src/data/repositories/orderRepository";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { APP_CONFIG } from "../src/app/config/appConfig";

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

async function loginAsSvp(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "svp@birojasa.com", password: "admin123" }),
  });
  assert.strictEqual(res.status, 200);
  const body = (await res.json()) as any;
  return body.data.token;
}

test("Messenger - SQLite-backed active messengers & assignment workflow", async (t) => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  const origFetch = globalThis.fetch;

  try {
    const token = await loginAsSvp(baseUrl);
    process.env.AUTH_TOKEN = token;

    // Route singleton apiEmployeeProvider default baseUrl to isolated test server
    const defaultApiBase = APP_CONFIG.apiBaseUrl.replace(/\/$/, "");
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(defaultApiBase)) {
        return origFetch(`${baseUrl}/api${url.slice(defaultApiBase.length)}`, init);
      }
      return origFetch(input, init);
    };

    const apiOrder = new ApiOrderProvider(`${baseUrl}/api`);
    await apiOrder.initFromApi();
    orderRepository.setProvider(apiOrder);

    await t.test("karyawanPenggunaAdapter returns active messengers exclusively from SQLite", async () => {
      await karyawanPenggunaAdapter.refresh({ target: "employees" });
      const allKaryawan = karyawanPenggunaAdapter.getKaryawan();
      assert.ok(allKaryawan.length > 0, "Karyawan list should populate from SQLite");

      const activeMessengers = allKaryawan
        .filter((k) => k.jabatan === "MESSENGER" && k.status === "Aktif")
        .map((k) => k.nama);

      assert.ok(activeMessengers.length > 0, "Should have active messengers from SQLite");
      assert.ok(activeMessengers.includes("Budi Santoso"), "Budi Santoso should be an active messenger");
      assert.ok(activeMessengers.includes("Andi Pratama"), "Andi Pratama should be an active messenger");
      assert.ok(!activeMessengers.includes("Citra Dewi"), "Fictional mock messenger Citra Dewi must not exist");
    });

    await t.test("Assigning active SQLite messenger updates order without corrupting order state", async () => {
      const newOrder = await orderStore.addOrderAsync({
        customer: "Messenger Assignment Test",
        namaPemilik: "Messenger Assignment Test",
        nomorHP: "0812333333",
        nopol: "B 3333 MSG",
        layanan: "Perpanjangan 1 Tahun",
        wilayahSamsatAsal: "Jakarta Timur",
        biayaJasa: 150000,
        totalEstimasi: 400000,
        payment: {
          tipePembayaran: "Bayar di Akhir",
          metodePembayaran: "Cash",
          statusPembayaran: "Belum Bayar",
          totalBiaya: 400000,
          dibayar: 0,
          kurang: 400000,
        },
      });

      const orderNo = newOrder.orderNo;

      // Assign Stage 2 Messenger (Jemput & Proses)
      const assignStage2 = await orderStore.updateOrderAsync(orderNo, {
        messenger: "Budi Santoso",
      });
      assert.strictEqual(assignStage2, true);

      let current = orderStore.getOrderByNo(orderNo);
      assert.strictEqual(current?.messenger, "Budi Santoso");
      assert.strictEqual(current?.customer, "Messenger Assignment Test");
      assert.strictEqual(current?.nopol, "B 3333 MSG");

      // Assign Stage 7 Messenger (Pengantar)
      const assignStage7 = await orderStore.updateOrderAsync(orderNo, {
        messengerPengantar: "Andi Pratama",
      });
      assert.strictEqual(assignStage7, true);

      current = orderStore.getOrderByNo(orderNo);
      assert.strictEqual(current?.messenger, "Budi Santoso");
      assert.strictEqual(current?.messengerPengantar, "Andi Pratama");
      assert.strictEqual(current?.nopol, "B 3333 MSG");
    });
  } finally {
    globalThis.fetch = origFetch;
    process.env.AUTH_TOKEN = prevToken;
    orderRepository.setProvider(new ApiOrderProvider());
    server.close();
  }
});
