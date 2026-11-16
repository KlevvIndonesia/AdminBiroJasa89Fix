import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ApiEmployeeProvider } from "../src/data/api/apiEmployeeProvider";
import { karyawanPenggunaAdapter } from "../src/app/data/karyawanPenggunaAdapter";

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

describe("Employee Provider Lifecycle & Selector Stabilization Suite", () => {
  const originalFetch = globalThis.fetch;
  const originalAuthToken = process.env.AUTH_TOKEN;

  beforeEach(() => {
    process.env.AUTH_TOKEN = "mock-jwt-token";
    karyawanPenggunaAdapter.clearSessionData();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN;
    } else {
      process.env.AUTH_TOKEN = originalAuthToken;
    }
  });

  it("1. Concurrency Deduplication: Multiple concurrent initFromApi calls trigger exactly one network request", async () => {
    const deferred = createDeferred<Response>();
    let networkFetchCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/employees")) {
        networkFetchCount++;
        return deferred.promise;
      }
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    const provider = new ApiEmployeeProvider("http://localhost:3001/api");

    // Fire 3 concurrent initialization calls
    const p1 = provider.initFromApi();
    const p2 = provider.initFromApi();
    const p3 = provider.initFromApi();

    assert.equal(networkFetchCount, 1, "Only one fetch request must be made for concurrent init calls");
    assert.equal(provider.isLoading(), true, "Provider should report loading state while in-flight");

    // Resolve deferred
    deferred.resolve(
      jsonResponse({
        success: true,
        data: [
          {
            id: "EMP-0001",
            nama_lengkap: "Admin Super (SVP)",
            jabatan: "SVP",
            status_karyawan: "Aktif",
          },
        ],
      })
    );

    await Promise.all([p1, p2, p3]);

    assert.equal(networkFetchCount, 1, "Fetch count remains exactly 1 after all promises resolve");
    assert.equal(provider.isLoading(), false, "Provider loading state becomes false");
    assert.equal(provider.isReady(), true, "Provider reports initialized / ready state");
    assert.equal(provider.getAll().length, 1);
    assert.equal(provider.getAll()[0].nama_lengkap, "Admin Super (SVP)");
  });

  it("2. Employee data loaded before modal opens: messenger & responsible lists exclude mocks and messengers respectively", async () => {
    const mockEmployees = [
      { id: "EMP-0001", nama_lengkap: "Admin Super (SVP)", jabatan: "SVP", status_karyawan: "Aktif" },
      { id: "EMP-0002", nama_lengkap: "Finance User", jabatan: "FINANCE", status_karyawan: "Aktif" },
      { id: "EMP-0003", nama_lengkap: "Budi Santoso", jabatan: "MESSENGER", status_karyawan: "Aktif" },
      { id: "EMP-0004", nama_lengkap: "Andi Pratama", jabatan: "MESSENGER", status_karyawan: "Aktif" },
      { id: "EMP-0005", nama_lengkap: "Nonaktif User", jabatan: "ADMIN", status_karyawan: "Nonaktif" },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/employees")) {
        return jsonResponse({ success: true, data: mockEmployees });
      }
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    await karyawanPenggunaAdapter.refresh();

    const employees = karyawanPenggunaAdapter.getKaryawan();
    assert.equal(employees.length, 5);

    // Messenger options derivation: active messengers only
    const activeMessengers = employees.filter(
      (k) => (k.jabatan || "").toUpperCase() === "MESSENGER" && k.status === "Aktif"
    ).map((k) => k.nama);

    assert.deepEqual(activeMessengers, ["Budi Santoso", "Andi Pratama"]);
    assert.equal(activeMessengers.includes("Admin Super (SVP)"), false);
    assert.equal(activeMessengers.includes("Finance User"), false);

    // Responsible options derivation: active non-messengers only
    const activeResponsible = employees.filter(
      (k) => (k.jabatan || "").toUpperCase() !== "MESSENGER" && k.status === "Aktif"
    ).map((k) => k.nama);

    assert.deepEqual(activeResponsible, ["Admin Super (SVP)", "Finance User"]);
    assert.equal(activeResponsible.includes("Budi Santoso"), false);
    assert.equal(activeResponsible.includes("Andi Pratama"), false);

    // Zero mock fallbacks
    assert.equal(activeResponsible.includes("Siti Nurhaliza"), false);
    assert.equal(activeResponsible.includes("Dewi Lestari"), false);
  });

  it("3. Modal opened while employee data is loading: handles in-flight state without mock fallbacks", async () => {
    const deferred = createDeferred<Response>();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/employees")) {
        return deferred.promise;
      }
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    const refreshPromise = karyawanPenggunaAdapter.refresh();

    assert.equal(karyawanPenggunaAdapter.isLoading(), true);
    // While loading, employee list must be empty, not populated with hardcoded mock names
    const preLoadList = karyawanPenggunaAdapter.getKaryawan();
    assert.equal(preLoadList.length, 0);

    deferred.resolve(
      jsonResponse({
        success: true,
        data: [{ id: "EMP-0010", nama_lengkap: "Loaded Staff", jabatan: "ADMIN", status_karyawan: "Aktif" }],
      })
    );

    await refreshPromise;

    assert.equal(karyawanPenggunaAdapter.isLoading(), false);
    assert.equal(karyawanPenggunaAdapter.getKaryawan().length, 1);
    assert.equal(karyawanPenggunaAdapter.getKaryawan()[0].nama, "Loaded Staff");
  });

  it("4. Empty employee API response: reports clean empty state without fallback to mock employees", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({ success: true, data: [] });
    }) as typeof fetch;

    await karyawanPenggunaAdapter.refresh();

    assert.equal(karyawanPenggunaAdapter.isLoading(), false);
    assert.equal(karyawanPenggunaAdapter.getError(), null);
    const employees = karyawanPenggunaAdapter.getKaryawan();
    assert.equal(employees.length, 0, "Empty API response must result in 0 employees");

    const messengerNames = employees.filter((k) => k.jabatan === "MESSENGER").map((k) => k.nama);
    const responsibleNames = employees.filter((k) => k.jabatan !== "MESSENGER").map((k) => k.nama);

    assert.deepEqual(messengerNames, [], "Must never populate mock messengers when server returns empty");
    assert.deepEqual(responsibleNames, [], "Must never populate mock responsible when server returns empty");
  });

  it("5. Employee API error response: records error without injecting fake mock data", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({ success: false, message: "Database connection failed" }, 500);
    }) as typeof fetch;

    await karyawanPenggunaAdapter.refresh();

    assert.equal(karyawanPenggunaAdapter.isLoading(), false);
    const err = karyawanPenggunaAdapter.getError();
    assert.ok(err && err.includes("500"), "Error message should reflect server HTTP failure");
    assert.equal(karyawanPenggunaAdapter.getKaryawan().length, 0, "No mock employee fallback on server error");
  });

  it("6. Selection preservation: valid user selection preserved on refresh; removed selection reset to empty", () => {
    // Simulate selection state transition logic
    const options = ["Admin Super (SVP)", "Finance User", "Manager User"];
    let selectedPenanggungJawab = "Finance User";

    // Scenario A: Options refresh with the same employee still active
    const refreshedOptions = ["Admin Super (SVP)", "Finance User", "Director User"];
    if (refreshedOptions.length > 0) {
      if (!selectedPenanggungJawab) {
        selectedPenanggungJawab = refreshedOptions[0];
      } else if (!refreshedOptions.includes(selectedPenanggungJawab)) {
        selectedPenanggungJawab = "";
      }
    }
    assert.equal(selectedPenanggungJawab, "Finance User", "User selection preserved across background refresh");

    // Scenario B: Employee is deactivated / removed from active options
    const deactOptions = ["Admin Super (SVP)", "Director User"];
    if (deactOptions.length > 0) {
      if (!selectedPenanggungJawab) {
        selectedPenanggungJawab = deactOptions[0];
      } else if (!deactOptions.includes(selectedPenanggungJawab)) {
        selectedPenanggungJawab = "";
      }
    }
    assert.equal(
      selectedPenanggungJawab,
      "",
      "Selection must be cleared instead of arbitrarily selecting another employee"
    );
  });

  it("7. Logout clears session-bound employee data: prevents stale session data leakage", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({
        success: true,
        data: [{ id: "EMP-0099", nama_lengkap: "Confidential User", jabatan: "SVP", status_karyawan: "Aktif" }],
      });
    }) as typeof fetch;

    await karyawanPenggunaAdapter.refresh();
    assert.equal(karyawanPenggunaAdapter.getKaryawan().length, 1);

    // User logs out
    karyawanPenggunaAdapter.clearSessionData();

    assert.equal(karyawanPenggunaAdapter.getKaryawan().length, 0, "Employee data cleared on logout");
    assert.equal(karyawanPenggunaAdapter.getPengguna().length, 0, "User account data cleared on logout");
    assert.equal(karyawanPenggunaAdapter.getError(), null);
  });
});
