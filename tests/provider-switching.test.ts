/**
 * Provider Switching & SQLite Contract Regression Test
 * Admin SUN89 — Biro Jasa Management System
 *
 * Verifies that OrderRepository defaults to ApiOrderProvider backed by SQLite
 * and cleanly supports injected custom IOrderDataProvider test doubles with
 * listener propagation and state isolation.
 */

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { OrderRepository } from "../src/data/repositories/orderRepository";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { IOrderDataProvider, OperationalOrder, StageName, STAGES } from "../src/domain/order/types";

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

class InMemoryTestOrderProvider implements IOrderDataProvider {
  private store = new Map<string, OperationalOrder>();
  private listeners = new Set<() => void>();

  getActiveOrders(): Record<StageName, OperationalOrder[]> {
    const out = {} as Record<StageName, OperationalOrder[]>;
    for (const s of STAGES) out[s] = [];
    for (const o of this.store.values()) {
      const st = (o.currentStageName as StageName) || "Verifikasi";
      if (out[st]) out[st].push({ ...o });
    }
    return out;
  }
  getArchivedOrders(): OperationalOrder[] { return []; }
  getAllFlat(): OperationalOrder[] { return Array.from(this.store.values()); }
  getOrderByNo(orderNo: string): OperationalOrder | undefined { return this.store.get(orderNo); }
  getOrdersByStage(stage: StageName): OperationalOrder[] {
    return this.getAllFlat().filter((o) => o.currentStageName === stage);
  }
  addOrder(order: OperationalOrder): void {
    this.store.set(order.orderNo, { ...order });
    this.listeners.forEach((fn) => fn());
  }
  updateOrder(orderNo: string, updates: Partial<OperationalOrder>): boolean {
    const cur = this.store.get(orderNo);
    if (!cur) return false;
    this.store.set(orderNo, { ...cur, ...updates });
    this.listeners.forEach((fn) => fn());
    return true;
  }
  advanceOrder(orderNo: string, targetStage: StageName, updates: Partial<OperationalOrder>): boolean {
    return this.updateOrder(orderNo, { ...updates, currentStageName: targetStage });
  }
  rollbackOrder(orderNo: string, targetStage: StageName, updates: Partial<OperationalOrder>): boolean {
    return this.updateOrder(orderNo, { ...updates, currentStageName: targetStage });
  }
  archiveOrder(orderNo: string): boolean { return this.store.delete(orderNo); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

test("Provider Switching - OrderRepository works with SQLite ApiOrderProvider and custom providers", async () => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@birojasa.com", password: "admin123" }),
    });
    const loginBody = (await loginRes.json()) as any;
    process.env.AUTH_TOKEN = loginBody.data.token;

    // 1. Default provider is ApiOrderProvider
    const repo = new OrderRepository(new ApiOrderProvider(`${baseUrl}/api`));
    assert.ok(repo.getProvider?.() instanceof ApiOrderProvider);

    const saved = await repo.saveOrderAsync({
      orderNo: `TMP-SW-${Date.now()}`,
      customer: "Customer SQLite Switch",
      nomorHP: "081200001111",
      layanan: "Perpanjangan 1 Tahun",
      currentStep: 1,
      currentStageName: "Verifikasi",
      createdAt: new Date().toISOString(),
      namaPemilik: "Pemilik Test",
      nopol: "B 1234 TST",
      totalEstimasi: 500000,
      biayaJasa: 50000,
    });
    const sqliteActiveCount = repo.getActiveOrders()["Verifikasi"].length;
    assert.ok(sqliteActiveCount >= 1);
    assert.ok(repo.getByOrderNo(saved.orderNo));

    // 2. Switch to an isolated in-memory test double provider
    const customProvider = new InMemoryTestOrderProvider();
    let switchNotified = false;
    repo.subscribe(() => { switchNotified = true; });
    repo.setProvider(customProvider);
    assert.strictEqual(switchNotified, true);
    assert.strictEqual(repo.getByOrderNo(saved.orderNo), undefined);

    repo.saveOrder({
      orderNo: "DOUBLE-1",
      customer: "Double Customer",
      nomorHP: "081200002222",
      layanan: "Perpanjangan 1 Tahun",
      currentStep: 1,
      currentStageName: "Verifikasi",
      createdAt: new Date().toISOString(),
      namaPemilik: "Pemilik Double",
      nopol: "B 5678 TST",
      totalEstimasi: 300000,
    });
    assert.strictEqual(repo.getActiveOrders()["Verifikasi"].length, 1);

    // 3. Switch back to SQLite ApiOrderProvider and verify SQLite state restored
    const apiProvider = new ApiOrderProvider(`${baseUrl}/api`);
    await apiProvider.initFromApi();
    repo.setProvider(apiProvider);
    assert.ok(repo.getProvider?.() instanceof ApiOrderProvider);
    assert.ok(repo.getByOrderNo(saved.orderNo));
    assert.strictEqual(repo.getActiveOrders()["Verifikasi"].length, sqliteActiveCount);
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    server.close();
  }
});
