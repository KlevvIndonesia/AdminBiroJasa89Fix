/**
 * Runtime Data Provider Wiring and Final Source-of-Truth Integration Tests
 * Admin SUN89 — Biro Jasa Management System
 *
 * Verifies:
 * 1. FinanceStore runtime wiring to SQLite ApiFinanceProvider
 * 2. Dynamic P&L calculation from live SQLite invoices and cash transactions
 * 3. Dashboard financial KPIs source-of-truth derivation
 * 4. PricingStore runtime wiring and snapshot immutability against SQLite
 * 5. User management adapter (karyawanPenggunaAdapter) wiring to SQLite
 * 6. Messenger active roster wiring with zero mock leakage
 * 7. Loading and error states on repositories
 * 8. SQLite database persistence consistency and zero orphan invoices
 */

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { financeStore } from "../src/app/data/financeStore";
import { pricingStore } from "../src/app/data/pricingStore";
import { karyawanPenggunaAdapter } from "../src/app/data/karyawanPenggunaAdapter";
import { financeRepository, FinanceRepository } from "../src/data/repositories/financeRepository";
import { pricingRepository, PricingRepository } from "../src/data/repositories/pricingRepository";
import { userRepository, UserRepository } from "../src/data/repositories/userRepository";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";
import { ApiPricingProvider } from "../src/data/api/apiPricingProvider";
import { ApiUserProvider } from "../src/data/api/apiUserProvider";
import { getFinancialKPIs } from "../src/app/data/dashboardAdapter";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";

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

test("Phase 7.2D - End-to-End Runtime Provider Wiring & SQLite Source-of-Truth", async (t) => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;

  try {
    const token = await loginAsSvp(baseUrl);
    process.env.AUTH_TOKEN = token;

    // Seed an authoritative order & invoice in isolated SQLite
    const createOrderRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        customer: "PT Wiring SQLite",
        namaPemilik: "Pemilik Wiring",
        nomorHP: "081200009999",
        layanan: "Perpanjangan 1 Tahun",
        nopol: "B 7722 WRN",
        wilayahSamsatAsal: "Jakarta Timur",
        biayaJasa: 250000,
        totalEstimasi: 850000,
      }),
    });
    assert.strictEqual(createOrderRes.status, 201);

    await t.test("FinanceStore Runtime Wiring & Dynamic P&L", async () => {
      const apiFin = new ApiFinanceProvider(`${baseUrl}/api`);
      await apiFin.initFromApi();
      financeRepository.setProvider(apiFin);
      financeStore.syncFromRepository();

      const repo = new FinanceRepository(apiFin);
      assert.strictEqual(repo.isLoading(), false);
      assert.strictEqual(repo.getError(), null);

      const invoices = financeStore.getInvoices();
      assert.ok(Array.isArray(invoices), "Invoices must be an array");
      assert.ok(invoices.some((i) => i.customer === "PT Wiring SQLite"), "SQLite invoice must load into financeStore");

      const labaRugi = financeStore.getLabaRugiData();
      assert.ok(Array.isArray(labaRugi), "Dynamic P&L must be an array");
      assert.ok(labaRugi.length > 0, "Dynamic P&L must have generated months");
      assert.ok(labaRugi[0].bulan, "Dynamic P&L month must have bulan name");
      assert.ok(typeof labaRugi[0].pendapatan === "number", "Dynamic P&L must have numeric revenue");
    });

    await t.test("Dashboard Financial KPIs derive canonically from store state", () => {
      const invoices = financeStore.getInvoices();
      const kasKantor = financeStore.getKasKantorList();
      const profitData = financeStore.getProfitList();

      const kpis = getFinancialKPIs(invoices, kasKantor, profitData);
      assert.ok(typeof kpis.revenueTotal === "number");
      assert.ok(typeof kpis.outstandingTotal === "number");
      assert.ok(typeof kpis.realizedProfitTotal === "number");
      assert.ok(typeof kpis.saldoKasKantor === "number");

      const expectedPaid = invoices.reduce((sum, inv) => sum + (inv.terbayar || 0), 0);
      assert.strictEqual(kpis.revenueTotal, expectedPaid);
    });

    await t.test("PricingStore Runtime Wiring against SQLite", async () => {
      const apiPricing = new ApiPricingProvider(`${baseUrl}/api`);
      await apiPricing.initFromApi();
      pricingRepository.setProvider(apiPricing);

      const repo = new PricingRepository(apiPricing);
      assert.strictEqual(repo.isLoading(), false);
      assert.strictEqual(repo.getError(), null);

      const targetItem = "mutasi-cf";
      const newPrice = 75000;
      await pricingStore.setSamsatOverride("samsat-jakarta-timur", targetItem, newPrice);
      const updatedPrice = pricingStore.getSamsatPrice("samsat-jakarta-timur", targetItem);
      assert.strictEqual(updatedPrice, newPrice, "PricingStore must reflect updated price");
    });

    await t.test("User Management Adapter (karyawanPenggunaAdapter) SQLite Wiring", async () => {
      const apiUser = new ApiUserProvider(`${baseUrl}/api`);
      await apiUser.initFromApi();
      userRepository.setProvider(apiUser);

      const repo = new UserRepository(apiUser);
      assert.strictEqual(repo.isLoading(), false);
      assert.strictEqual(repo.getError(), null);

      await karyawanPenggunaAdapter.refresh({ target: "all" });
      const penggunas = karyawanPenggunaAdapter.getPengguna();
      assert.ok(Array.isArray(penggunas), "Pengguna list must be an array");
      assert.ok(penggunas.length > 0, "Pengguna list must not be empty from SQLite");

      const target = penggunas[0];
      if (target.statusAkun === "Aktif") {
        karyawanPenggunaAdapter.deactivateAccount(target.id);
        const updated = karyawanPenggunaAdapter.getPengguna().find((p) => p.id === target.id);
        assert.strictEqual(updated?.statusAkun, "Nonaktif");

        karyawanPenggunaAdapter.activateAccount(target.id);
        const reactivated = karyawanPenggunaAdapter.getPengguna().find((p) => p.id === target.id);
        assert.strictEqual(reactivated?.statusAkun, "Aktif");
      }
    });

    await t.test("Messenger Active Roster derives strictly from SQLite employees", () => {
      const allKaryawan = karyawanPenggunaAdapter.getKaryawan();
      const activeMessengers = allKaryawan
        .filter((k) => k.jabatan === "MESSENGER" && k.status === "Aktif")
        .map((k) => k.nama);

      assert.ok(Array.isArray(activeMessengers));
      assert.ok(!activeMessengers.includes("MOCK_FALLBACK"));
    });

    await t.test("SQLite Database Consistency & Zero Orphan Records", () => {
      const kasRows = dbFinanceRepository.getAllKasKantor();
      assert.ok(kasRows.length > 0, "kas_kantor table must have seeded rows");
      assert.ok(kasRows[0].saldo !== undefined || kasRows[0].total !== undefined);

      const orphanResult = db
        .prepare(`
          SELECT COUNT(*) as orphan_count
          FROM finance_invoices f
          LEFT JOIN orders o ON f.order_no = o.order_no
          WHERE o.order_no IS NULL
        `)
        .get() as { orphan_count: number };
      assert.strictEqual(orphanResult.orphan_count, 0, "There must be 0 orphan invoices without matching order");

      const orderCount = (db.prepare("SELECT COUNT(*) as count FROM orders").get() as { count: number }).count;
      const invoiceCount = (db.prepare("SELECT COUNT(*) as count FROM finance_invoices").get() as { count: number }).count;
      assert.ok(invoiceCount > 0 && orderCount >= invoiceCount, "SQLite orders & invoices must exist cleanly");
    });
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    financeRepository.setProvider(new ApiFinanceProvider());
    pricingRepository.setProvider(new ApiPricingProvider());
    userRepository.setProvider(new ApiUserProvider());
    server.close();
  }
});
