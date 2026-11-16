/**
 * Regression Tests: Profit Filter Infinite Re-fetch Loop Fix
 *
 * Verifies:
 *  1. Initial Profit load triggers expected fetches without redundant loops.
 *  2. Payment method filter change issues exactly 1 fetch with canonical paymentMethodId.
 *  3. Date range filter change issues exactly 1 fetch with startDate/endDate.
 *  4. Re-renders with unchanged dependencies (including 25+ simulated renders and no-op store polls) return stable getProfitList() references and issue ZERO extra fetches.
 *  5. Loading state transitions do not re-trigger fetch effects.
 *  6. Error state transitions do not re-trigger fetch effects.
 *  7. Genuine Profit source changes invalidate cache reference and refresh filtered view once.
 *  8. Rapid filter change aborts prior in-flight request via AbortController and prevents stale out-of-order response from overwriting newer results.
 *  9. Empty result sets serverFilteredProfit = [], finishes loading cleanly, preserves null error.
 * 10. API HTTP 500 / network error exposes explicit error message, stops loading cleanly, never swallows errors.
 * 11. Successful result populates rows and stops loading cleanly.
 * 12. CSV & PDF exports execute cleanly after fetch settles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";
import { financeRepository } from "../src/data/repositories/financeRepository";
import { financeStore } from "../src/app/data/financeStore";
import { permissionStore } from "../src/app/data/permissionStore";
import { executeProfitFilterFetch } from "../src/app/components/finance/ProfitReconciliationView";
import { exportProfitToCSV, exportProfitToPDF } from "../src/app/utils/financeExport";
import { ProfitItem } from "../src/domain/finance/types";

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

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeProfitRow(overrides: Partial<ProfitItem> = {}): ProfitItem {
  return {
    id: "INV-LOOP-001",
    invoice: "INV-LOOP-001",
    orderNo: "ORD-LOOP-001",
    customer: "Budi Test",
    namaBerkas: "Budi Test",
    nopol: "B 1234 TST",
    pengurusan: "perpanjangan-1-tahun",
    tanggal: "2026-11-16",
    tanggalBayar: "2026-11-16",
    uangMasuk: 1258000,
    biayaSamsat: 100000,
    profit: 1158000,
    rekening: "Transfer BCA (PT SUN BCA)",
    metodePembayaran: "Transfer BCA (PT SUN BCA)",
    paymentMethodId: "pm-bca-1",
    paymentMethodLabel: "Transfer Bank - BCA",
    verifiedPaymentCount: 1,
    ...overrides,
  } as ProfitItem;
}

/**
 * Simulates React's Object.is dependency array check on ProfitReconciliationView's
 * effect tuple `[hasActiveFilter, selectedMethod, startDate, endDate, selectedCategory, storeProfitData, retryCounter]`.
 */
function depsChanged(prev: unknown[] | null, next: unknown[]): boolean {
  if (!prev || prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

test("Profit Filter Loop Regression Suite (All 12 Lifecycle & Anti-Loop Cases)", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalProvider = financeRepository.getProvider();
  const originalAuthToken = process.env.AUTH_TOKEN;

  let currentServerProfitRows: ProfitItem[] = [makeProfitRow()];
  const profitRequests: Array<{ url: string; aborted: boolean }> = [];
  let mode: "ok" | "empty" | "http500" = "ok";

  process.env.AUTH_TOKEN = "test-finance-token";
  permissionStore.hydrateSession("finance", { notify: false, requireAuthoritativeSync: false });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const entry = { url, aborted: false };
    init?.signal?.addEventListener("abort", () => {
      entry.aborted = true;
    });

    if (url.includes("/finance/profit")) {
      profitRequests.push(entry);
      if (mode === "http500") {
        return jsonRes(
          { success: false, error: { code: "PROFIT_QUERY_FAILED", message: "Simulated SQL failure" } },
          500
        );
      }
      if (mode === "empty" || url.includes("paymentMethodId=pm-cash") || url.includes("startDate=2099-01-01")) {
        return jsonRes({ success: true, data: [] });
      }
      return jsonRes({ success: true, data: currentServerProfitRows });
    }

    return jsonRes({ success: true, data: [] });
  }) as typeof fetch;

  const provider = new ApiFinanceProvider("http://127.0.0.1:9999/api");
  financeRepository.setProvider(provider);

  t.after(() => {
    provider.destroy();
    financeRepository.setProvider(originalProvider);
    globalThis.fetch = originalFetch;
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = originalAuthToken;
    permissionStore.clearSession();
  });

  // Track simulated component state & render/effect cycles mirroring ProfitReconciliationView
  let selectedMethod = "ALL";
  let startDate = "";
  let endDate = "";
  const selectedCategory = "ALL";
  let retryCounter = 0;
  let isFilterLoading = false;
  let filterError: string | null = null;
  let serverFilteredProfit: ProfitItem[] | null = null;
  let fetchSeq = 0;
  let prevDeps: unknown[] | null = null;
  let activeCleanup: (() => void) | null = null;
  const inFlightPromises: Promise<void>[] = [];

  async function renderCycle(): Promise<void> {
    const storeProfitData = financeStore.getProfitList();
    const hasActiveFilter =
      selectedMethod !== "ALL" || Boolean(startDate) || Boolean(endDate) || selectedCategory !== "ALL";
    const nextDeps = [
      hasActiveFilter,
      selectedMethod,
      startDate,
      endDate,
      selectedCategory,
      storeProfitData,
      retryCounter,
    ];

    if (depsChanged(prevDeps, nextDeps)) {
      prevDeps = nextDeps;
      activeCleanup?.();

      if (!hasActiveFilter) {
        serverFilteredProfit = null;
        isFilterLoading = false;
        filterError = null;
        activeCleanup = null;
      } else {
        const seq = ++fetchSeq;
        const controller = new AbortController();
        let cancelled = false;
        filterError = null;
        activeCleanup = () => {
          cancelled = true;
          controller.abort();
        };

        const p = executeProfitFilterFetch({
          filters: {
            paymentMethodId: selectedMethod !== "ALL" ? selectedMethod : undefined,
            startDate: startDate || undefined,
            endDate: endDate || undefined,
            category: selectedCategory !== "ALL" ? selectedCategory : undefined,
          },
          seq,
          getCurrentSeq: () => fetchSeq,
          isCancelled: () => cancelled,
          signal: controller.signal,
          fetcher: (f, opts) => financeRepository.fetchFilteredProfitList(f, opts),
          onLoading: (loading) => {
            isFilterLoading = loading;
          },
          onSuccess: (rows) => {
            serverFilteredProfit = rows;
            filterError = null;
          },
          onError: (msg) => {
            serverFilteredProfit = [];
            filterError = msg;
          },
        });
        inFlightPromises.push(p);
        await p;
      }
    }
  }

  await t.test("1. Initial Profit load runs expected initFromApi & 0 redundant filter requests", async () => {
    await provider.initFromApi();
    financeStore.syncFromRepository();
    const initCount = profitRequests.length;
    assert.ok(initCount >= 1, "Initial initFromApi must fetch /finance/profit");

    await renderCycle();
    assert.strictEqual(profitRequests.length, initCount, "Unfiltered render must issue 0 filtered profit requests");
    assert.strictEqual(isFilterLoading, false);
    assert.strictEqual(filterError, null);
    assert.strictEqual(financeStore.getProfitList().length, 1);
  });

  await t.test("2, 4, 5, 6, 9, 12. Payment method filter (pm-cash) -> 1 fetch, zero loop across 25 rerenders, empty state + loading complete, export ready", async () => {
    const before = profitRequests.length;
    selectedMethod = "pm-cash";

    // Simulate render cycle triggering effect + 25 subsequent re-renders (loading/state/rerender churn)
    await renderCycle();
    for (let i = 0; i < 25; i++) {
      await renderCycle();
    }

    const issued = profitRequests.slice(before);
    assert.strictEqual(issued.length, 1, `Expected strictly 1 request across filter + 25 re-renders, got ${issued.length}`);
    assert.ok(issued[0].url.includes("paymentMethodId=pm-cash"), `Expected paymentMethodId=pm-cash in ${issued[0].url}`);
    assert.strictEqual(isFilterLoading, false, "Loading must finish after empty result");
    assert.strictEqual(filterError, null, "Valid empty result must not set error");
    assert.deepStrictEqual(serverFilteredProfit, []);

    // Loading/Error state flips in local component do NOT trigger store reference change or extra fetches
    const refA = financeStore.getProfitList();
    const refB = financeStore.getProfitList();
    assert.strictEqual(refA, refB, "Repeated getProfitList() calls without store mutation must preserve === reference");
  });

  await t.test("3. Date range change issues exactly 1 fetch with startDate & endDate, zero loop", async () => {
    selectedMethod = "ALL";
    await renderCycle();
    const before = profitRequests.length;

    startDate = "2026-11-01";
    endDate = "2026-11-30";
    await renderCycle();
    for (let i = 0; i < 15; i++) {
      await renderCycle();
    }

    const issued = profitRequests.slice(before);
    assert.strictEqual(issued.length, 1, `Expected strictly 1 request for date filter, got ${issued.length}`);
    assert.ok(issued[0].url.includes("startDate=2026-11-01"));
    assert.ok(issued[0].url.includes("endDate=2026-11-30"));
    assert.strictEqual(isFilterLoading, false);
    assert.strictEqual(serverFilteredProfit?.length, 1);
  });

  await t.test("7. No-op store poll keeps getProfitList() === reference (0 extra fetch), genuine profit change refreshes once", async () => {
    const refBeforeNoopPoll = financeStore.getProfitList();
    const beforeNoop = profitRequests.length;

    // Simulate 8s liveSync poll returning identical rows from server
    await provider.initFromApi();
    financeStore.syncFromRepository();
    const initOnlyCount = 1; // initFromApi calls /finance/profit once (unfiltered)
    const refAfterNoopPoll = financeStore.getProfitList();
    assert.strictEqual(refAfterNoopPoll, refBeforeNoopPoll, "Unchanged profit payload poll must keep identical array reference");

    await renderCycle();
    assert.strictEqual(
      profitRequests.length,
      beforeNoop + initOnlyCount,
      "No-op store sync must trigger ZERO extra filtered fetches"
    );

    // Now simulate genuinely changed profit source data on server
    currentServerProfitRows = [
      ...currentServerProfitRows,
      makeProfitRow({ id: "INV-LOOP-002", invoice: "INV-LOOP-002", orderNo: "ORD-LOOP-002", profit: 500000 }),
    ];
    await provider.initFromApi();
    financeStore.syncFromRepository();
    const refAfterRealChange = financeStore.getProfitList();
    assert.notStrictEqual(refAfterRealChange, refBeforeNoopPoll, "Genuine profit change must invalidate reference");

    const beforeRefresh = profitRequests.length;
    await renderCycle();
    assert.strictEqual(
      profitRequests.length - beforeRefresh,
      1,
      "Active filter must refresh cleanly once when profit source genuinely changes"
    );
  });

  await t.test("8. Filter change while prior request is in-flight aborts old request & drops stale out-of-order response", async () => {
    const req1Deferred = createDeferred<Response>();
    const req2Deferred = createDeferred<Response>();
    const savedFetch = globalThis.fetch;
    let callIdx = 0;
    const signals: Array<{ aborted: boolean }> = [];

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const idx = ++callIdx;
      const track = { aborted: false };
      signals.push(track);
      init?.signal?.addEventListener("abort", () => {
        track.aborted = true;
      });
      return idx === 1 ? req1Deferred.promise : req2Deferred.promise;
    }) as typeof fetch;

    try {
      let localSeq = 0;
      let latestLoading = false;
      let latestRows: ProfitItem[] = [];
      let latestError: string | null = null;

      // Start Request 1 (pm-cash)
      const seq1 = ++localSeq;
      const c1 = new AbortController();
      let cancelled1 = false;
      const p1 = executeProfitFilterFetch({
        filters: { paymentMethodId: "pm-cash" },
        seq: seq1,
        getCurrentSeq: () => localSeq,
        isCancelled: () => cancelled1,
        signal: c1.signal,
        fetcher: (f, opts) => financeRepository.fetchFilteredProfitList(f, opts),
        onLoading: (l) => {
          latestLoading = l;
        },
        onSuccess: (rows) => {
          latestRows = rows;
        },
        onError: (e) => {
          latestError = e;
        },
      });

      // Immediately switch filter to pm-bca-1 before Request 1 resolves
      cancelled1 = true;
      c1.abort();
      assert.strictEqual(signals[0]?.aborted, true, "Prior in-flight request must be aborted on filter switch");

      const seq2 = ++localSeq;
      const c2 = new AbortController();
      const expectedNewRows = [makeProfitRow({ id: "INV-NEW", invoice: "INV-NEW", paymentMethodId: "pm-bca-1" })];
      const p2 = executeProfitFilterFetch({
        filters: { paymentMethodId: "pm-bca-1" },
        seq: seq2,
        getCurrentSeq: () => localSeq,
        isCancelled: () => false,
        signal: c2.signal,
        fetcher: (f, opts) => financeRepository.fetchFilteredProfitList(f, opts),
        onLoading: (l) => {
          latestLoading = l;
        },
        onSuccess: (rows) => {
          latestRows = rows;
        },
        onError: (e) => {
          latestError = e;
        },
      });

      // Resolve Request 2 first, then resolve stale Request 1 later with wrong data
      req2Deferred.resolve(jsonRes({ success: true, data: expectedNewRows }));
      await p2;

      req1Deferred.resolve(jsonRes({ success: true, data: [makeProfitRow({ id: "STALE-ROW" })] }));
      await p1;

      assert.strictEqual(latestLoading, false);
      assert.strictEqual(latestError, null);
      assert.strictEqual(latestRows.length, 1);
      assert.strictEqual(latestRows[0].id, "INV-NEW", "Stale Request 1 response must NEVER overwrite newer Request 2 result");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  await t.test("10, 11, 12. API HTTP 500 stops loading cleanly with explicit error, zero retry loop; recovery + CSV/PDF export succeed", async () => {
    mode = "http500";
    selectedMethod = "pm-bca-1";
    startDate = "";
    endDate = "";
    const beforeErr = profitRequests.length;

    await renderCycle();
    for (let i = 0; i < 10; i++) {
      await renderCycle();
    }

    assert.strictEqual(
      profitRequests.length - beforeErr,
      1,
      "HTTP 500 error + 10 re-renders must NOT trigger an automatic retry loop"
    );
    assert.strictEqual(isFilterLoading, false, "Loading must stop cleanly on HTTP 500 error");
    assert.match(String(filterError || ""), /Simulated SQL failure/);
    assert.deepStrictEqual(serverFilteredProfit, []);

    // Recover cleanly via retryCounter
    mode = "ok";
    retryCounter++;
    const beforeRecover = profitRequests.length;
    await renderCycle();
    for (let i = 0; i < 10; i++) {
      await renderCycle();
    }

    assert.strictEqual(profitRequests.length - beforeRecover, 1, "Manual retry must trigger 1 request without loop");
    assert.strictEqual(isFilterLoading, false, "Loading must finish on success");
    assert.strictEqual(filterError, null, "Error must clear on success");
    assert.ok((serverFilteredProfit?.length || 0) >= 1, "Recovered data must populate");

    // Verify CSV & PDF export helpers run cleanly on filtered rows without throwing
    let capturedCsv = "";
    let capturedPdfHtml = "";
    const origBlob = (globalThis as any).Blob;
    const origDoc = (globalThis as any).document;
    const origUrl = (globalThis as any).URL;
    const origWin = (globalThis as any).window;
    const origSetTimeout = globalThis.setTimeout;
    const exportTimers: ReturnType<typeof setTimeout>[] = [];
    try {
      (globalThis as any).setTimeout = ((fn: any, _ms?: number, ...args: any[]) => {
        const id = origSetTimeout(() => fn(...args), 0);
        exportTimers.push(id);
        return id;
      }) as typeof setTimeout;
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
        periodLabel: "Semua Data",
        filterMethodLabel: "Transfer Bank - BCA",
        filterCategoryLabel: "Semua Pengurusan",
        grandTotals: {
          totalBerkas: serverFilteredProfit!.length,
          totalUangMasuk: 1258000,
          totalUangKeluar: 100000,
          totalProfit: 1158000,
          marginPercent: 92.1,
        },
        pendingTotals: {
          profitPending: 0,
          cashbackPending: 0,
          tagihanCustomer: 0,
        },
        groups: [
          {
            serviceTitle: "Perpanjangan 1 Tahun",
            jumlahBerkas: serverFilteredProfit!.length,
            totalUangMasuk: 1258000,
            breakdownUangMasuk: { "Transfer Bank - BCA": { nominal: 1258000, count: 1 } },
            totalUangKeluar: 100000,
            breakdownUangKeluar: { "Kas Kantor": { nominal: 100000, count: 1 } },
            totalProfit: 1158000,
            marginPercent: 92.1,
            profitPending: 0,
            cashbackPending: 0,
            tagihanCustomer: 0,
          },
        ],
      };

      exportProfitToCSV(exportParams);
      assert.ok(capturedCsv.includes("Perpanjangan 1 Tahun"));

      exportProfitToPDF(exportParams, "download");
      assert.ok(capturedPdfHtml.includes("Transfer Bank - BCA"));
      await new Promise((r) => origSetTimeout(r, 15));
    } finally {
      exportTimers.forEach((id) => clearTimeout(id));
      globalThis.setTimeout = origSetTimeout;
      (globalThis as any).Blob = origBlob;
      (globalThis as any).document = origDoc;
      (globalThis as any).URL = origUrl;
      (globalThis as any).window = origWin;
    }
  });
});
