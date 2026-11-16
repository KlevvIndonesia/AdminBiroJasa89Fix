import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

describe("ApiFinanceProvider Concurrency & Race Condition Suite", () => {
  const originalFetch = globalThis.fetch;
  const originalAuthToken = process.env.AUTH_TOKEN;

  beforeEach(() => {
    process.env.AUTH_TOKEN = "test-jwt-token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN;
    } else {
      process.env.AUTH_TOKEN = originalAuthToken;
    }
  });

  it("Scenario 1 (POST settles before in-flight GET): preserves committed Kas Kantor & Kas Messenger rows without overwrite", async () => {
    const kasGetDeferred = createDeferred<Response>();
    const msgGetDeferred = createDeferred<Response>();
    let kasFetchCount = 0;
    let msgFetchCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();

      if (url.endsWith("/finance/invoices") && method === "GET") {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith("/finance/pengeluaran") && method === "GET") {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith("/finance/kas-kantor") && method === "GET") {
        kasFetchCount++;
        if (kasFetchCount === 1) return jsonResponse({ success: true, data: [] });
        return kasGetDeferred.promise;
      }
      if (url.endsWith("/finance/kas-messenger") && method === "GET") {
        msgFetchCount++;
        if (msgFetchCount === 1) return jsonResponse({ success: true, data: [] });
        return msgGetDeferred.promise;
      }
      if (url.endsWith("/finance/kas-kantor") && method === "POST") {
        return jsonResponse({
          success: true,
          data: { id: 101, tanggal: "2026-11-12", status: "Debit", keterangan: "Kas Kantor Commit", debit: 50000, kredit: 0, total: 50000 },
        }, 201);
      }
      if (url.endsWith("/finance/kas-messenger") && method === "POST") {
        return jsonResponse({
          success: true,
          data: { id: 201, tanggal: "2026-11-12", jenis: "Petty cash", messenger: "Budi Santoso", keterangan: "Topup Commit", in: 75000, out: 0, total: 75000 },
        }, 201);
      }
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    const provider = new ApiFinanceProvider("http://localhost:3001/api");
    await flushMicrotasks();

    // Start background GET refresh (captures stale server snapshot before POSTs commit)
    const refreshPromise = provider.initFromApi();
    await flushMicrotasks();

    // Both POSTs complete BEFORE the in-flight GET resolves
    provider.addKasKantor({ tanggal: "2026-11-12", status: "Debit", keterangan: "Kas Kantor Commit", debit: 50000, kredit: 0 });
    provider.addKasMessenger({ tanggal: "2026-11-12", jenis: "Petty cash", messenger: "Budi Santoso", keterangan: "Topup Commit", in: 75000, out: 0 });
    await flushMicrotasks();

    assert.equal(provider.getKasKantorList().some((r) => r.id === 101), true, "POST commit present before stale GET resolves");
    assert.equal(provider.getKasMessengerList().some((r) => r.id === 201), true, "Messenger POST commit present before stale GET resolves");

    // Now stale GETs resolve with empty server arrays (captured before POSTs!)
    kasGetDeferred.resolve(jsonResponse({ success: true, data: [] }));
    msgGetDeferred.resolve(jsonResponse({ success: true, data: [] }));
    await refreshPromise;

    assert.equal(provider.getKasKantorList().length, 1);
    assert.equal(provider.getKasKantorList()[0].id, 101);
    assert.equal(provider.getKasMessengerList().length, 1);
    assert.equal(provider.getKasMessengerList()[0].id, 201);
  });

  it("Scenario 2 (GET settles before in-flight POST): retains optimistic row during GET and swaps without duplicates after POST", async () => {
    const kasPostDeferred = createDeferred<Response>();
    const msgPostDeferred = createDeferred<Response>();
    let kasFetchCount = 0;
    let msgFetchCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();

      if (url.endsWith("/finance/invoices") || url.endsWith("/finance/pengeluaran")) {
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith("/finance/kas-kantor") && method === "GET") {
        kasFetchCount++;
        return jsonResponse({
          success: true,
          data: [{ id: 1, tanggal: "2026-11-11", status: "Debit", keterangan: "Seed Kantor", debit: 10000, kredit: 0, total: 10000 }],
        });
      }
      if (url.endsWith("/finance/kas-messenger") && method === "GET") {
        msgFetchCount++;
        return jsonResponse({
          success: true,
          data: [{ id: 2, tanggal: "2026-11-11", jenis: "Operasional", messenger: "Andi Pratama", keterangan: "Seed Messenger", in: 20000, out: 0, total: 20000 }],
        });
      }
      if (url.endsWith("/finance/kas-kantor") && method === "POST") return kasPostDeferred.promise;
      if (url.endsWith("/finance/kas-messenger") && method === "POST") return msgPostDeferred.promise;
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    const provider = new ApiFinanceProvider("http://localhost:3001/api");
    await flushMicrotasks();

    // Trigger optimistic POSTs that stay in flight
    provider.addKasKantor({ tanggal: "2026-11-12", status: "Debit", keterangan: "In-Flight Kantor", debit: 30000, kredit: 0 });
    provider.addKasMessenger({ tanggal: "2026-11-12", jenis: "Petty cash", messenger: "Budi Santoso", keterangan: "In-Flight Messenger", in: 40000, out: 0 });

    // Background GET settles WHILE POSTs are still pending
    await provider.initFromApi();
    assert.ok(kasFetchCount >= 2 && msgFetchCount >= 2);
    assert.equal(provider.getKasKantorList().length, 2, "Optimistic Kas Kantor must survive background GET");
    assert.equal(provider.getKasMessengerList().length, 2, "Optimistic Kas Messenger must survive background GET");

    // Resolve in-flight POSTs
    kasPostDeferred.resolve(jsonResponse({
      success: true,
      data: { id: 102, tanggal: "2026-11-12", status: "Debit", keterangan: "In-Flight Kantor", debit: 30000, kredit: 0, total: 40000 },
    }, 201));
    msgPostDeferred.resolve(jsonResponse({
      success: true,
      data: { id: 202, tanggal: "2026-11-12", jenis: "Petty cash", messenger: "Budi Santoso", keterangan: "In-Flight Messenger", in: 40000, out: 0, total: 60000 },
    }, 201));
    await flushMicrotasks();

    const kasIds = provider.getKasKantorList().map((r) => r.id);
    const msgIds = provider.getKasMessengerList().map((r) => r.id);
    assert.deepEqual(kasIds, [102, 1]);
    assert.deepEqual(msgIds, [202, 2]);
  });

  it("Scenario 3 (Two concurrent POSTs in same ms): unique negative optimistic IDs prevent collision and preserve both commits", async () => {
    const postKantorA = createDeferred<Response>();
    const postKantorB = createDeferred<Response>();
    let postCall = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.endsWith("/finance/kas-kantor") && method === "POST") {
        postCall++;
        return postCall === 1 ? postKantorA.promise : postKantorB.promise;
      }
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    const provider = new ApiFinanceProvider("http://localhost:3001/api");
    await flushMicrotasks();

    const optA = provider.addKasKantor({ tanggal: "2026-11-12", status: "Debit", keterangan: "Concurrent A", debit: 10000, kredit: 0 });
    const optB = provider.addKasKantor({ tanggal: "2026-11-12", status: "Debit", keterangan: "Concurrent B", debit: 20000, kredit: 0 });
    assert.notEqual(optA?.id, optB?.id, "Concurrent optimistic temp IDs must be strictly distinct");
    assert.equal(provider.getKasKantorList().length, 2);

    // Resolve second POST first, then fail first POST — only optA should roll back while optB commit survives
    postKantorB.resolve(jsonResponse({
      success: true,
      data: { id: 302, tanggal: "2026-11-12", status: "Debit", keterangan: "Concurrent B", debit: 20000, kredit: 0, total: 20000 },
    }, 201));
    await flushMicrotasks();
    postKantorA.resolve(jsonResponse({ success: false, message: "Validation failed" }, 400));
    await flushMicrotasks();

    const rows = provider.getKasKantorList();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 302);
    assert.equal(rows[0].keterangan, "Concurrent B");
  });

  it("Scenario 4 (GET fails while POST succeeds): retains committed POST entries intact", async () => {
    let initialDone = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET") {
        if (!initialDone) return jsonResponse({ success: true, data: [] });
        if (url.endsWith("/finance/kas-kantor") || url.endsWith("/finance/kas-messenger")) {
          return jsonResponse({ success: false, message: "Internal Server Error" }, 500);
        }
        return jsonResponse({ success: true, data: [] });
      }
      if (url.endsWith("/finance/kas-kantor") && method === "POST") {
        return jsonResponse({ success: true, data: { id: 401, tanggal: "2026-11-12", status: "Debit", keterangan: "Survives GET 500", debit: 50000, kredit: 0, total: 50000 } }, 201);
      }
      if (url.endsWith("/finance/kas-messenger") && method === "POST") {
        return jsonResponse({ success: true, data: { id: 402, tanggal: "2026-11-12", jenis: "Petty cash", messenger: "Budi Santoso", keterangan: "Survives GET 500", in: 50000, out: 0, total: 50000 } }, 201);
      }
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    const provider = new ApiFinanceProvider("http://localhost:3001/api");
    await flushMicrotasks();
    initialDone = true;

    provider.addKasKantor({ tanggal: "2026-11-12", status: "Debit", keterangan: "Survives GET 500", debit: 50000, kredit: 0 });
    provider.addKasMessenger({ tanggal: "2026-11-12", jenis: "Petty cash", messenger: "Budi Santoso", keterangan: "Survives GET 500", in: 50000, out: 0 });
    await flushMicrotasks();

    await provider.initFromApi();
    assert.equal(provider.getKasKantorList().length, 1);
    assert.equal(provider.getKasKantorList()[0].id, 401);
    assert.equal(provider.getKasMessengerList().length, 1);
    assert.equal(provider.getKasMessengerList()[0].id, 402);
  });

  it("Scenario 5 (POST fails while GET succeeds): rolls back failed optimistic row without losing GET rows", async () => {
    const postKantorDeferred = createDeferred<Response>();
    const postMsgDeferred = createDeferred<Response>();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.endsWith("/finance/kas-kantor") && method === "GET") {
        return jsonResponse({
          success: true,
          data: [{ id: 10, tanggal: "2026-11-12", status: "Debit", keterangan: "Server Row K", debit: 15000, kredit: 0, total: 15000 }],
        });
      }
      if (url.endsWith("/finance/kas-messenger") && method === "GET") {
        return jsonResponse({
          success: true,
          data: [{ id: 20, tanggal: "2026-11-12", jenis: "Operasional", messenger: "Andi Pratama", keterangan: "Server Row M", in: 25000, out: 0, total: 25000 }],
        });
      }
      if (url.endsWith("/finance/kas-kantor") && method === "POST") return postKantorDeferred.promise;
      if (url.endsWith("/finance/kas-messenger") && method === "POST") return postMsgDeferred.promise;
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    const provider = new ApiFinanceProvider("http://localhost:3001/api");
    await flushMicrotasks();

    provider.addKasKantor({ tanggal: "2026-11-12", status: "Kredit", keterangan: "Bad Kantor POST", debit: 0, kredit: 99999 });
    provider.addKasMessenger({ tanggal: "2026-11-12", jenis: "Petty cash", messenger: "Unknown", keterangan: "Bad Messenger POST", in: 0, out: 99999 });

    await provider.initFromApi();
    assert.equal(provider.getKasKantorList().length, 2);
    assert.equal(provider.getKasMessengerList().length, 2);

    postKantorDeferred.resolve(jsonResponse({ success: false, message: "Bad Request" }, 400));
    postMsgDeferred.reject(new Error("Network error"));
    await flushMicrotasks();

    assert.deepEqual(provider.getKasKantorList().map((r) => r.id), [10]);
    assert.deepEqual(provider.getKasMessengerList().map((r) => r.id), [20]);
  });
});
