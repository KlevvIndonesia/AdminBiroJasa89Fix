import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { orderService } from "../server/src/services/orderService";
import { orderCorrectionService } from "../server/src/services/orderCorrectionService";
import { financeService } from "../server/src/services/financeService";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import { permissionStore } from "../src/app/data/permissionStore";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";

function createTestServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = createApp();
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 3000;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

async function loginCanonicalUser(baseUrl: string, email: string, password: string): Promise<{ token: string; user: any }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, `Login gagal untuk ${email}: ${JSON.stringify(body)}`);
  assert.ok(body?.data?.token, `Token wajib tersedia untuk ${email}`);
  return { token: body.data.token, user: body.data.user };
}

test("P0/P1 Production Defect Remediation Regression Suite", async (t) => {
  const { server, baseUrl } = await createTestServer();

  t.after(() => {
    if (typeof (server as any).closeAllConnections === "function") {
      (server as any).closeAllConnections();
    }
    server.close();
  });

  const svpSession = await loginCanonicalUser(baseUrl, "svp@birojasa.com", "admin123");
  const adminSession = await loginCanonicalUser(baseUrl, "admin@birojasa.com", "admin123");
  const financeSession = await loginCanonicalUser(baseUrl, "finance@birojasa.com", "finance123");

  const svpHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${svpSession.token}`,
  };
  const financeHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${financeSession.token}`,
  };

  await t.test("P0-1: createOrder returns authoritative isCostVerified and costCompletenessStatus matching SQLite", async () => {
    const partialIdemKey = `idem-p01-partial-${Date.now()}`;
    const completeIdemKey = `idem-p01-complete-${Date.now()}`;

    const partialResult = orderService.createOrderWithIdempotency(
      {
        customer: "PT Partial Estimate P01",
        nomorHP: "081211110001",
        layanan: "Mutasi Luar Daerah",
        nopol: "B 1001 P01",
        biayaJasa: 250000,
        biayaAntarJemput: 25000,
        biayaLainnya: 0,
        totalBiaya: 275000,
        completenessStatus: "PARTIAL_ESTIMATE",
        costSnapshot: {
          completenessStatus: "PARTIAL_ESTIMATE",
          hasUnconfiguredTariff: true,
          breakdown: [
            { name: "Jasa", amount: 250000, status: "CONFIGURED" },
            { name: "PKB", amount: 0, status: "UNCONFIGURED" },
          ],
        },
      } as any,
      adminSession.user,
      partialIdemKey
    );

    assert.equal(partialResult.isExisting, false);
    assert.equal(partialResult.order.isCostVerified, false);
    assert.equal(partialResult.order.costCompletenessStatus, "PARTIAL_ESTIMATE");

    const persistedPartial = dbOrderRepository.getByOrderNo(partialResult.order.orderNo)!;
    assert.equal(partialResult.order.isCostVerified, persistedPartial.isCostVerified);
    assert.equal(partialResult.order.costCompletenessStatus, persistedPartial.costCompletenessStatus);

    const rawPartialRow = db
      .prepare("SELECT is_cost_verified, cost_completeness_status FROM orders WHERE order_no = ?")
      .get(partialResult.order.orderNo) as any;
    assert.equal(rawPartialRow.is_cost_verified, 0);
    assert.equal(rawPartialRow.cost_completeness_status, "PARTIAL_ESTIMATE");

    // Idempotency replay returns identical authoritative fields
    const partialReplay = orderService.createOrderWithIdempotency(
      {
        customer: "PT Partial Estimate P01",
        nomorHP: "081211110001",
        layanan: "Mutasi Luar Daerah",
        nopol: "B 1001 P01",
        biayaJasa: 250000,
        biayaAntarJemput: 25000,
        biayaLainnya: 0,
        totalBiaya: 275000,
        completenessStatus: "PARTIAL_ESTIMATE",
        costSnapshot: {
          completenessStatus: "PARTIAL_ESTIMATE",
          hasUnconfiguredTariff: true,
          breakdown: [
            { name: "Jasa", amount: 250000, status: "CONFIGURED" },
            { name: "PKB", amount: 0, status: "UNCONFIGURED" },
          ],
        },
      } as any,
      adminSession.user,
      partialIdemKey
    );
    assert.equal(partialReplay.isExisting, true);
    assert.equal(partialReplay.order.isCostVerified, false);
    assert.equal(partialReplay.order.costCompletenessStatus, "PARTIAL_ESTIMATE");

    // COMPLETE order
    const completeResult = orderService.createOrderWithIdempotency(
      {
        customer: "PT Complete P01",
        nomorHP: "081211110002",
        layanan: "Perpanjangan STNK",
        nopol: "B 1002 P01",
        biayaSamsat: 400000,
        biayaJasa: 150000,
        biayaAntarJemput: 0,
        biayaLainnya: 0,
        totalBiaya: 550000,
        completenessStatus: "COMPLETE",
      } as any,
      adminSession.user,
      completeIdemKey
    );

    assert.equal(completeResult.isExisting, false);
    assert.equal(completeResult.order.isCostVerified, true);
    assert.equal(completeResult.order.costCompletenessStatus, "COMPLETE");

    const rawCompleteRow = db
      .prepare("SELECT is_cost_verified, cost_completeness_status FROM orders WHERE order_no = ?")
      .get(completeResult.order.orderNo) as any;
    assert.equal(rawCompleteRow.is_cost_verified, 1);
    assert.equal(rawCompleteRow.cost_completeness_status, "COMPLETE");
  });

  await t.test("P0-2: PARTIAL_ESTIMATE order generates PENDING_VERIFICATION draft invoice while COMPLETE remains VERIFIED", async () => {
    const partialOrder = orderService.createOrder(
      {
        customer: "Customer Draft Invoice P02",
        nomorHP: "081222220001",
        layanan: "Balik Nama Kendaraan",
        nopol: "B 2001 P02",
        biayaJasa: 300000,
        biayaAntarJemput: 0,
        biayaLainnya: 0,
        totalBiaya: 300000,
        completenessStatus: "PARTIAL_ESTIMATE",
        costSnapshot: {
          completenessStatus: "PARTIAL_ESTIMATE",
          hasUnconfiguredTariff: true,
        },
      } as any,
      svpSession.user
    );

    const draftInvoice = dbFinanceRepository.getInvoiceByOrderNo(partialOrder.orderNo);
    assert.ok(draftInvoice, "Initial invoice must exist for PARTIAL_ESTIMATE order");
    assert.equal(draftInvoice!.costVerificationStatus, "PENDING_VERIFICATION");
    assert.equal(draftInvoice!.isDraftEstimate, true);

    const allInvs = dbFinanceRepository.getAllInvoices();
    const fromAll = allInvs.find((i) => i.orderNo === partialOrder.orderNo);
    assert.ok(fromAll);
    assert.equal(fromAll!.costVerificationStatus, "PENDING_VERIFICATION");
    assert.equal(fromAll!.isDraftEstimate, true);

    // Payment pay API must reject unverified draft invoice with COST_VERIFICATION_REQUIRED
    const payRes = await fetch(`${baseUrl}/api/finance/invoices/${draftInvoice!.id}/pay`, {
      method: "POST",
      headers: financeHeaders,
      body: JSON.stringify({
        nominal: 100000,
        metodePembayaran: "Transfer Bank",
        namaBank: "BCA",
      }),
    });
    const payBody = (await payRes.json()) as any;
    assert.equal(payRes.status, 400);
    assert.equal(payBody.error?.code, "COST_VERIFICATION_REQUIRED");

    // COMPLETE order invoice defaults cleanly to VERIFIED / non-draft
    const completeOrder = orderService.createOrder(
      {
        customer: "Customer Complete Invoice P02",
        nomorHP: "081222220002",
        layanan: "Perpanjangan Tahunan",
        nopol: "B 2002 P02",
        biayaSamsat: 350000,
        biayaJasa: 150000,
        biayaAntarJemput: 0,
        biayaLainnya: 0,
        totalBiaya: 500000,
        completenessStatus: "COMPLETE",
      } as any,
      svpSession.user
    );
    const verifiedInvoice = dbFinanceRepository.getInvoiceByOrderNo(completeOrder.orderNo)!;
    assert.equal(verifiedInvoice.costVerificationStatus, "VERIFIED");
    assert.equal(verifiedInvoice.isDraftEstimate, false);
  });

  await t.test("P0-3: verifyOrderCost rejects cancelled order with 400 ORDER_CANCELLED and zero side effects", async () => {
    const targetOrder = orderService.createOrder(
      {
        customer: "Customer Cancelled Verify P03",
        nomorHP: "081233330001",
        layanan: "Mutasi STNK",
        nopol: "B 3001 P03",
        biayaJasa: 200000,
        biayaAntarJemput: 0,
        biayaLainnya: 0,
        totalBiaya: 200000,
        completenessStatus: "PARTIAL_ESTIMATE",
        costSnapshot: { completenessStatus: "PARTIAL_ESTIMATE", hasUnconfiguredTariff: true },
      } as any,
      svpSession.user
    );

    await orderService.cancelOrder(
      targetOrder.orderNo,
      "Dibatalkan pelanggan sebelum verifikasi biaya",
      svpSession.user
    );

    const beforeOrderRow = db
      .prepare("SELECT is_cost_verified, cost_completeness_status, current_stage_name, data_json FROM orders WHERE order_no = ?")
      .get(targetOrder.orderNo) as any;
    const beforeInvoiceRow = db
      .prepare("SELECT cost_verification_status, is_draft_estimate, status, total_tagihan, data_json FROM finance_invoices WHERE order_no = ?")
      .get(targetOrder.orderNo) as any;
    const beforeAuditCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM audit_logs WHERE details LIKE ?").get(`%${targetOrder.orderNo}%`) as any
    ).cnt;

    assert.throws(
      () =>
        orderService.verifyOrderCost(
          targetOrder.orderNo,
          { finalBiayaSamsat: 500000, notes: "Should reject" },
          svpSession.user
        ),
      (err: any) => err?.statusCode === 400 && err?.code === "ORDER_CANCELLED"
    );

    const httpRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(targetOrder.orderNo)}/verify-cost`, {
      method: "POST",
      headers: svpHeaders,
      body: JSON.stringify({ finalBiayaSamsat: 500000, notes: "HTTP reject check" }),
    });
    const httpBody = (await httpRes.json()) as any;
    assert.equal(httpRes.status, 400);
    assert.equal(httpBody.error?.code, "ORDER_CANCELLED");

    const afterOrderRow = db
      .prepare("SELECT is_cost_verified, cost_completeness_status, current_stage_name, data_json FROM orders WHERE order_no = ?")
      .get(targetOrder.orderNo) as any;
    const afterInvoiceRow = db
      .prepare("SELECT cost_verification_status, is_draft_estimate, status, total_tagihan, data_json FROM finance_invoices WHERE order_no = ?")
      .get(targetOrder.orderNo) as any;
    const afterAuditCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM audit_logs WHERE details LIKE ?").get(`%${targetOrder.orderNo}%`) as any
    ).cnt;

    assert.deepEqual(afterOrderRow, beforeOrderRow);
    assert.deepEqual(afterInvoiceRow, beforeInvoiceRow);
    assert.equal(afterAuditCount, beforeAuditCount);
  });

  await t.test("P0-4: CANCELLED invoice status and deposit overpayment liability are preserved across all read paths", async () => {
    // 4A. Cancelled order with partial deposit (500,000 paid on 1,200,000 invoice -> overpayment refund liability = 500,000)
    const depositOrder = orderService.createOrder(
      {
        customer: "Customer Cancelled Deposit P04",
        nomorHP: "081244440001",
        layanan: "Balik Nama",
        nopol: "B 4001 P04",
        biayaSamsat: 800000,
        biayaJasa: 400000,
        biayaAntarJemput: 0,
        biayaLainnya: 0,
        totalBiaya: 1200000,
        completenessStatus: "COMPLETE",
      } as any,
      adminSession.user
    );

    dbOrderRepository.updateOrder(depositOrder.orderNo, {
      currentStep: 7,
      isVerified: true,
      approvedBySpv: true,
    });
    const depositInvInitial = dbFinanceRepository.getInvoiceByOrderNo(depositOrder.orderNo)!;
    financeService.recordPayment(
      depositInvInitial.id,
      500000,
      {
        metodePembayaran: "Transfer Bank",
        namaBank: "BCA",
        buktiPembayaran: {
          fileName: "bukti-dp.jpg",
          fileType: "image",
          fileUrl: "/uploads/bukti-dp.jpg",
        },
      },
      financeSession.user
    );
    financeService.verifyPayment({
      orderNo: depositOrder.orderNo,
      invoiceId: depositInvInitial.id,
      confirmedAmount: 500000,
      user: financeSession.user,
    });

    await orderService.cancelOrder(
      depositOrder.orderNo,
      "Batal setelah bayar DP",
      svpSession.user
    );

    const byOrder = dbFinanceRepository.getInvoiceByOrderNo(depositOrder.orderNo)!;
    const byId = dbFinanceRepository.getInvoiceById(byOrder.id)!;
    const byNo = dbFinanceRepository.getInvoiceByNo(byOrder.invoiceNo)!;
    const fromAll = dbFinanceRepository.getAllInvoices().find((i) => i.orderNo === depositOrder.orderNo)!;

    for (const inv of [byOrder, byId, byNo, fromAll]) {
      assert.equal(inv.status, "CANCELLED");
      assert.equal(inv.billingStatus, "CANCELLED");
      assert.equal(inv.overpayment, 500000);
      assert.equal(inv.refundStatus, "PENDING");
      assert.equal(inv.settlementCondition, "OVERPAID");
    }

    // 4B. Cancelled via correction service
    const corrOrder = orderService.createOrder(
      {
        customer: "Customer Cancelled Correction P04",
        nomorHP: "081244440002",
        layanan: "Perpanjangan STNK",
        nopol: "B 4002 P04",
        biayaSamsat: 300000,
        biayaJasa: 150000,
        biayaAntarJemput: 0,
        biayaLainnya: 0,
        totalBiaya: 450000,
        completenessStatus: "COMPLETE",
      } as any,
      adminSession.user
    );

    const correction = orderCorrectionService.requestCorrection(
      corrOrder.orderNo,
      { category: "DUPLICATE", reason: "Salah input data order" },
      adminSession.user
    );
    orderCorrectionService.reviewCorrection(
      correction.id,
      { decision: "approve", reviewNotes: "Approved in P0-4 regression test" },
      svpSession.user
    );

    const corrInvByOrder = dbFinanceRepository.getInvoiceByOrderNo(corrOrder.orderNo)!;
    const corrInvFromAll = dbFinanceRepository.getAllInvoices().find((i) => i.orderNo === corrOrder.orderNo)!;
    assert.equal(corrInvByOrder.status, "CANCELLED");
    assert.equal(corrInvByOrder.billingStatus, "CANCELLED");
    assert.equal(corrInvFromAll.status, "CANCELLED");
    assert.equal(corrInvFromAll.billingStatus, "CANCELLED");

    // 4C. Non-cancelled invoice still computes canonical payment status accurately
    const activeOrder = orderService.createOrder(
      {
        customer: "Customer Active P04",
        nomorHP: "081244440003",
        layanan: "Perpanjangan STNK",
        nopol: "B 4003 P04",
        biayaSamsat: 200000,
        biayaJasa: 100000,
        biayaAntarJemput: 0,
        biayaLainnya: 0,
        totalBiaya: 300000,
        completenessStatus: "COMPLETE",
      } as any,
      adminSession.user
    );
    dbOrderRepository.updateOrder(activeOrder.orderNo, {
      currentStep: 7,
      isVerified: true,
      approvedBySpv: true,
    });
    const activeInvInitial = dbFinanceRepository.getInvoiceByOrderNo(activeOrder.orderNo)!;
    financeService.recordPayment(
      activeInvInitial.id,
      300000,
      {
        metodePembayaran: "Transfer Bank",
        namaBank: "BCA",
        buktiPembayaran: {
          fileName: "bukti-lunas.jpg",
          fileType: "image",
          fileUrl: "/uploads/bukti-lunas.jpg",
        },
      },
      financeSession.user
    );
    financeService.verifyPayment({
      orderNo: activeOrder.orderNo,
      invoiceId: activeInvInitial.id,
      confirmedAmount: 300000,
      user: financeSession.user,
    });
    const activeInv = dbFinanceRepository.getInvoiceByOrderNo(activeOrder.orderNo)!;
    const activeInvAll = dbFinanceRepository.getAllInvoices().find((i) => i.orderNo === activeOrder.orderNo)!;
    assert.equal(activeInv.status, "PAID");
    assert.equal(activeInvAll.status, "PAID");
    assert.equal(activeInv.sisa, 0);
  });

  await t.test("P1-5: Permission hydration distinguishes hydrating/unauthenticated/authenticated/forbidden, fails closed, and recovers", async () => {
    const origWindow = (globalThis as any).window;
    const origLocalStorage = (globalThis as any).localStorage;
    const origFetch = globalThis.fetch;

    const storageMap = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
      setItem: (k: string, v: string) => {
        storageMap.set(k, String(v));
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
      clear: () => {
        storageMap.clear();
      },
    };

    const requestedUrls: string[] = [];
    let provider: ApiFinanceProvider | null = null;

    try {
      (globalThis as any).localStorage = mockStorage;
      (globalThis as any).window = {
        localStorage: mockStorage,
        dispatchEvent: () => true,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      (globalThis as any).fetch = async (url: string) => {
        requestedUrls.push(String(url));
        if (String(url).includes("/finance/invoices")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: [
                {
                  id: 901,
                  invoiceNo: "INV-P15-001",
                  orderNo: "ORD-P15-001",
                  customer: "Hydration Recovery Customer",
                  layanan: "STNK",
                  nopol: "B 901 HYD",
                  totalTagihan: 500000,
                  dibayar: 0,
                  sisa: 500000,
                  status: "UNPAID",
                },
              ],
            }),
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [] }),
        } as any;
      };

      // 1. Unauthenticated: no token, fail-closed, zero requests
      permissionStore.clearSession();
      storageMap.clear();
      assert.equal(permissionStore.getSessionAuthStatus(), "unauthenticated");
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), false);
      provider = new ApiFinanceProvider("http://localhost:9999/api");
      assert.equal(provider.getAuthStatus(), "unauthenticated");
      await provider.initFromApi();
      assert.equal(requestedUrls.length, 0);

      // 2. Hydrating: opaque auth_token exists BEFORE role is hydrated -> fail-closed & deferred fetch
      storageMap.set("auth_token", "opaque-session-token-without-jwt-role");
      assert.equal(permissionStore.getSessionAuthStatus(), "hydrating");
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), false);
      assert.equal(provider.getAuthStatus(), "hydrating");

      await provider.initFromApi();
      assert.equal(requestedUrls.length, 0, "Must emit zero requests while role is still hydrating");
      assert.equal(provider.hasPendingHydrationFetch(), true);

      // 3. Hydration completes with finance role -> provider recovers automatically
      permissionStore.hydrateSession("finance");
      assert.equal(permissionStore.getSessionAuthStatus(), "authenticated");
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), true);

      // Wait a tick for async subscription recovery fetch to finish
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(provider.getAuthStatus(), "authenticated");
      assert.ok(
        requestedUrls.some((u) => u.endsWith("/finance/invoices")),
        "Deferred finance-invoices fetch must execute once session role hydrates"
      );
      assert.equal(provider.getInvoices().length, 1);
      assert.equal(provider.getInvoices()[0].invoiceNo, "INV-P15-001");

      // 4. Logout clears cached data & blocks subsequent fetches
      requestedUrls.length = 0;
      storageMap.clear();
      permissionStore.clearSession();
      assert.equal(provider.getAuthStatus(), "unauthenticated");
      assert.equal(provider.getInvoices().length, 0, "Cached invoices must be cleared on logout");
      await provider.initFromApi();
      assert.equal(requestedUrls.length, 0);

      // 5. Messenger cannot access /finance/invoices (and unknown role is completely forbidden)
      storageMap.set("auth_token", "opaque-messenger-token");
      permissionStore.hydrateSession("messenger");
      await provider.initFromApi();
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), false);
      assert.ok(
        !requestedUrls.some((u) => u.endsWith("/finance/invoices") || u.endsWith("/finance/kas-kantor") || u.endsWith("/finance/pengeluaran")),
        "Messenger must never request restricted finance endpoints"
      );

      requestedUrls.length = 0;
      storageMap.set("auth_token", "opaque-unknown-token");
      permissionStore.hydrateSession("guest");
      await provider.initFromApi();
      assert.equal(provider.getAuthStatus(), "forbidden");
      assert.equal(requestedUrls.length, 0);
      assert.equal(provider.getInvoices().length, 0);

      // 6. Dynamic role revocation for finance when finance permissions are removed
      storageMap.set("auth_token", "opaque-finance-token-2");
      permissionStore.hydrateSession("finance");
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(provider.getAuthStatus(), "authenticated");
      assert.equal(provider.getInvoices().length, 1);

      // Partial revocation of finance-tagihan must immediately clear cached invoices
      permissionStore.updateModulePermission("finance", "finance-tagihan", { view: false, manage: false });
      assert.equal(provider.getInvoices().length, 0, "Revoking finance-tagihan must clear cached invoices");

      // Full revocation of remaining finance endpoints transitions provider to forbidden
      permissionStore.updateModulePermission("finance", "finance-kas-kantor", { view: false, manage: false });
      permissionStore.updateModulePermission("finance", "finance-pengeluaran", { view: false, manage: false });
      permissionStore.updateModulePermission("finance", "finance-kas-messenger", { view: false, manage: false });

      assert.equal(provider.getAuthStatus(), "forbidden");
      assert.equal(provider.getInvoices().length, 0, "Revoking all finance permissions must clear cached invoices");
    } finally {
      provider?.destroy();
      permissionStore.clearSession();
      if (origWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = origWindow;
      }
      if (origLocalStorage === undefined) {
        delete (globalThis as any).localStorage;
      } else {
        (globalThis as any).localStorage = origLocalStorage;
      }
      globalThis.fetch = origFetch;
    }
  });

  await t.test("Phase 1: Login hydration waits for /api/permissions, prevents premature requests, and fails closed without DEFAULT_PERMISSIONS", async () => {
    const origWindow = (globalThis as any).window;
    const origLocalStorage = (globalThis as any).localStorage;
    const origFetch = globalThis.fetch;

    const storageMap = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
      setItem: (k: string, v: string) => {
        storageMap.set(k, String(v));
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
      clear: () => {
        storageMap.clear();
      },
    };

    const requestedUrls: string[] = [];
    let permissionsShouldFail = true;
    let provider: ApiFinanceProvider | null = null;

    try {
      (globalThis as any).localStorage = mockStorage;
      (globalThis as any).window = {
        localStorage: mockStorage,
        dispatchEvent: () => true,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      (globalThis as any).fetch = async (url: string) => {
        const u = String(url);
        requestedUrls.push(u);
        if (u.endsWith("/permissions") || u.includes("/api/permissions")) {
          if (permissionsShouldFail) {
            return {
              ok: false,
              status: 500,
              json: async () => ({ success: false, error: { message: "Matrix error" } }),
            } as any;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                finance: {
                  modules: { "finance-tagihan": { view: false, manage: false }, "finance-kas-kantor": { view: true, manage: true } },
                  stages: {},
                },
              },
            }),
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [] }),
        } as any;
      };

      permissionStore.clearSession();
      storageMap.set("auth_token", "opaque-finance-login-token");
      provider = new ApiFinanceProvider("http://localhost:9999/api");

      // Silent login hydration before /api/permissions responds: no premature notification or Finance requests
      permissionStore.hydrateSession("finance", { notify: false, requireAuthoritativeSync: true });
      assert.equal(permissionStore.isAwaitingAuthoritativeMatrix(), true);
      assert.equal(permissionStore.getSessionAuthStatus(), "hydrating");
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), false);
      assert.equal(requestedUrls.length, 0);

      // /api/permissions fails -> fail closed, ZERO fallback to DEFAULT_PERMISSIONS
      await permissionStore.initFromApi();
      assert.equal(permissionStore.hasInitializedFromApi(), false);
      assert.equal(permissionStore.hasHydrationFailed(), true);
      assert.equal(permissionStore.getSessionAuthStatus(), "forbidden");
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), false);
      assert.equal(permissionStore.canViewPage("finance", "finance-tagihan"), false);
      assert.equal(permissionStore.canManageStage("admin", 1), false);
      assert.ok(
        !requestedUrls.some((u) => u.includes("/finance/")),
        `Failed hydration must emit zero Finance HTTP requests, got: ${JSON.stringify(requestedUrls)}`
      );

      // Recovery: when /api/permissions succeeds with finance-tagihan revoked, finance-invoices stays denied while permitted kas-kantor fetches
      requestedUrls.length = 0;
      permissionsShouldFail = false;
      permissionStore.hydrateSession("finance", { notify: false, requireAuthoritativeSync: true });
      await permissionStore.initFromApi();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(permissionStore.hasHydrationFailed(), false);
      assert.equal(permissionStore.getSessionAuthStatus(), "authenticated");
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), false);
      assert.equal(permissionStore.canAccessApiEndpoint("finance-kas-kantor"), true);
      assert.ok(
        !requestedUrls.some((u) => u.includes("/finance/invoices")),
        `Revoked finance-tagihan must prevent /finance/invoices request even on recovery: ${JSON.stringify(requestedUrls)}`
      );

      // Simulate hard browser reload: start with an authenticated token but NO hydrated session role
      requestedUrls.length = 0;
      storageMap.clear();
      permissionStore.clearSession();
      storageMap.set("auth_token", "opaque-reload-finance-token");

      assert.equal(permissionStore.getSessionAuthStatus(), "hydrating");
      assert.equal(permissionStore.canAccessApiEndpoint("finance-invoices"), false);

      const { liveSyncManager } = await import("../src/app/utils/useLiveSync");
      const { serviceStore } = await import("../src/app/data/serviceStore");
      const { paymentMethodStore } = await import("../src/app/data/paymentMethodStore");
      const { financeStore } = await import("../src/app/data/financeStore");
      const { estimationStore } = await import("../src/app/data/estimationStore");
      const { pricingStore } = await import("../src/app/data/pricingStore");
      const reloadFinanceProvider = new ApiFinanceProvider("http://localhost:9999/api");

      try {
        // Trigger actual store & LiveSync initialization paths before role/permission hydration
        await Promise.all([
          liveSyncManager.sync({ silent: true }),
          serviceStore.initFromApi(),
          paymentMethodStore.initFromApi(),
          financeStore.refreshReimbursements(),
          estimationStore.initFromBackend(),
          pricingStore.initFromApi(),
          reloadFinanceProvider.initFromApi(),
        ]);

        assert.equal(
          requestedUrls.length,
          0,
          `Hard reload before session & permission hydration must emit zero premature requests across all stores: ${JSON.stringify(requestedUrls)}`
        );

        // Complete auth role resolution + authoritative /api/permissions hydration (with finance-tagihan revoked)
        storageMap.set("auth_user", JSON.stringify({ role: "finance", nama: "Finance Reload" }));
        permissionsShouldFail = false;
        permissionStore.hydrateSession("finance", { notify: false, requireAuthoritativeSync: true });
        assert.equal(
          permissionStore.canViewPage("finance", "finance-tagihan"),
          false,
          "Stage/page checks must remain fail-closed while awaiting authoritative /api/permissions sync"
        );
        await permissionStore.initFromApi();
        await new Promise((r) => setTimeout(r, 30));

        await Promise.all([
          serviceStore.initFromApi(),
          paymentMethodStore.initFromApi(),
          financeStore.refreshReimbursements(),
          estimationStore.initFromBackend(),
          pricingStore.initFromApi(),
          reloadFinanceProvider.initFromApi(),
          liveSyncManager.sync({ silent: true }),
        ]);

        assert.equal(permissionStore.getSessionAuthStatus(), "authenticated");
        assert.ok(requestedUrls.some((u) => u.includes("/permissions")), "Authoritative /api/permissions must execute");
        assert.ok(requestedUrls.some((u) => u.endsWith("/services")), "Authorized /services must load after hydration");
        assert.ok(requestedUrls.some((u) => u.includes("/payment-methods")), "Authorized /payment-methods must load after hydration");
        assert.ok(requestedUrls.some((u) => u.includes("/messenger/reimbursements")), "Authorized /messenger/reimbursements must load after hydration");
        assert.ok(requestedUrls.some((u) => u.endsWith("/finance/kas-kantor")), "Authorized /finance/kas-kantor must load after hydration");
        assert.ok(
          !requestedUrls.some((u) => u.includes("/finance/invoices")),
          `Revoked finance-tagihan must remain blocked after reload hydration: ${JSON.stringify(requestedUrls)}`
        );

        // Re-verify reload when /api/permissions fails stays fail-closed across permissionStore & all stores
        requestedUrls.length = 0;
        storageMap.clear();
        permissionStore.clearSession();
        storageMap.set("auth_token", "opaque-reload-fail-token");
        storageMap.set("auth_user", JSON.stringify({ role: "finance", nama: "Finance Fail" }));
        permissionsShouldFail = true;

        permissionStore.hydrateSession("finance", { notify: false, requireAuthoritativeSync: true });
        await permissionStore.initFromApi();
        await Promise.all([
          serviceStore.initFromApi(),
          paymentMethodStore.initFromApi(),
          financeStore.refreshReimbursements(),
          estimationStore.initFromBackend(),
          pricingStore.initFromApi(),
          reloadFinanceProvider.initFromApi(),
          liveSyncManager.sync({ silent: true }),
        ]);

        assert.equal(permissionStore.hasHydrationFailed(), true);
        assert.equal(permissionStore.getSessionAuthStatus(), "forbidden");
        assert.equal(permissionStore.canViewPage("finance", "finance-tagihan"), false);
        assert.ok(
          requestedUrls.every((u) => u.includes("/permissions")),
          `Failed permission hydration must keep all downstream stores fail-closed, got: ${JSON.stringify(requestedUrls)}`
        );
      } finally {
        reloadFinanceProvider.destroy();
        liveSyncManager.destroy();
      }
    } finally {
      provider?.destroy();
      storageMap.clear();
      permissionStore.clearSession();
      if (origWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = origWindow;
      }
      if (origLocalStorage === undefined) {
        delete (globalThis as any).localStorage;
      } else {
        (globalThis as any).localStorage = origLocalStorage;
      }
      globalThis.fetch = origFetch;
    }
  });

  await t.test("Phase 2: CANCELLED invoice status, refundLiability, and payoutVersion stay protected across order & repository writes", async () => {
    const cancelledOrder = orderService.createOrder(
      {
        customer: "PT Phase2 Cancel Guard",
        nomorHP: "081233344455",
        layanan: "Balik Nama (BBN)",
        nopol: "B 2022 CNL",
        totalBiaya: 2_000_000,
        biayaJasa: 500_000,
        biayaAntarJemput: 0,
        biayaLainnya: 1_500_000,
        completenessStatus: "COMPLETE",
      } as any,
      adminSession.user
    );
    const invRow = dbFinanceRepository.getInvoiceByOrderNo(cancelledOrder.orderNo)!;
    assert.ok(invRow?.id);

    // Advance order to Stage 7 so financial deposit can be recorded cleanly
    dbOrderRepository.updateOrder(cancelledOrder.orderNo, {
      currentStep: 7,
      currentStageName: "Supervisi",
      approvedBySpv: true,
      isVerified: true,
      finalCost: 2_000_000,
    });

    // Record deposit of 800,000 before cancellation using an active seeded payment method
    const activePm = db
      .prepare("SELECT id, nama_metode, bank FROM payment_methods WHERE LOWER(status) = 'aktif' LIMIT 1")
      .get() as any;
    assert.ok(activePm?.id, "At least one active payment method must exist in isolated DB");
    financeService.recordPayment(
      invRow.id!,
      800_000,
      {
        paymentMethodId: activePm.id,
        metodePembayaran: activePm.nama_metode,
        namaBank: activePm.bank || undefined,
        catatan: "DP 1 Cancellation Guard",
        tanggal: "2026-06-05",
        buktiPembayaran: {
          fileName: "bukti-p2.jpg",
          fileType: "image",
          fileUrl: "/uploads/bukti-p2.jpg",
        },
      },
      svpSession.user
    );
    financeService.verifyPayment({
      orderNo: cancelledOrder.orderNo,
      invoiceId: invRow.id!,
      confirmedAmount: 800_000,
      user: svpSession.user,
    });

    // Cancel order with active deposit -> routes overpayment/refundLiability and marks invoice CANCELLED
    await orderService.cancelOrder(cancelledOrder.orderNo, "Dibatalkan oleh customer untuk uji integritas CANCELLED", svpSession.user);
    const invAfterCancel = dbFinanceRepository.getInvoiceByOrderNo(cancelledOrder.orderNo)!;
    assert.equal(invAfterCancel.status, "CANCELLED");
    assert.equal(invAfterCancel.billingStatus, "CANCELLED");
    assert.equal(invAfterCancel.overpayment, 800_000);
    assert.equal(invAfterCancel.refundStatus, "PENDING");
    const initialPayoutVersion = Number((invAfterCancel as any).payoutVersion || 0);

    // 1. Metadata update via orderService.updateOrder (SVP, Admin, and internal actor) MUST keep CANCELLED & refund fields intact
    for (const actor of [
      svpSession.user,
      adminSession.user,
      { userId: "usr-internal", nama: "Internal Service", role: "administrator" },
    ]) {
      const updated = orderService.updateOrder(
        cancelledOrder.orderNo,
        { notes: `Safe metadata note by ${actor.nama}`, statusPembayaran: "Lunas" } as any,
        actor
      );
      assert.ok(updated);
      const afterOrderUpdate = dbFinanceRepository.getInvoiceByOrderNo(cancelledOrder.orderNo)!;
      assert.equal(afterOrderUpdate.status, "CANCELLED", `Actor ${actor.nama} must not un-cancel invoice`);
      assert.equal(afterOrderUpdate.billingStatus, "CANCELLED", `Actor ${actor.nama} must keep billingStatus=CANCELLED`);
      assert.equal(afterOrderUpdate.overpayment, 800_000);
      assert.equal(afterOrderUpdate.refundStatus, "PENDING");
      assert.equal(Number((afterOrderUpdate as any).payoutVersion || 0), initialPayoutVersion);
    }

    // 2. Direct internal saveInvoice / updateInvoice cannot revive CANCELLED invoice into PAID/PARTIAL/UNPAID/ACTIVE
    dbFinanceRepository.saveInvoice({
      ...invAfterCancel,
      status: "PAID" as any,
      billingStatus: "ACTIVE" as any,
      dibayar: 2_000_000,
      sisa: 0,
      overpayment: 0,
      refundStatus: "NONE" as any,
      payoutVersion: 99,
    });
    const afterDirectSave = dbFinanceRepository.getInvoiceByOrderNo(cancelledOrder.orderNo)!;
    assert.equal(afterDirectSave.status, "CANCELLED");
    assert.equal(afterDirectSave.billingStatus, "CANCELLED");
    assert.equal(afterDirectSave.overpayment, 800_000);
    assert.equal(afterDirectSave.refundStatus, "PENDING");
    assert.equal(Number((afterDirectSave as any).payoutVersion || 0), initialPayoutVersion);

    dbFinanceRepository.updateInvoice(invRow.id!, {
      status: "UNPAID" as any,
      billingStatus: "ACTIVE" as any,
      dibayar: 0,
      sisa: 2_000_000,
      overpayment: 0,
      settlementCondition: "UNDERPAID",
    });
    const afterDirectUpdate = dbFinanceRepository.getInvoiceByOrderNo(cancelledOrder.orderNo)!;
    assert.equal(afterDirectUpdate.status, "CANCELLED");
    assert.equal(afterDirectUpdate.billingStatus, "CANCELLED");
    assert.equal(afterDirectUpdate.overpayment, 800_000);
    assert.equal(afterDirectUpdate.refundStatus, "PENDING");

    // 3. completeInvoice and voidInvoicePayment reject CANCELLED invoices
    assert.throws(
      () => financeService.completeInvoice(invRow.id!, svpSession.user),
      (err: any) => err?.code === "ORDER_CANCELLED"
    );

    const activePaymentRow = db
      .prepare("SELECT id FROM invoice_payments WHERE invoice_no = ? AND IFNULL(is_void, 0) = 0 LIMIT 1")
      .get(invAfterCancel.invoiceNo) as any;
    assert.ok(activePaymentRow?.id);
    assert.throws(
      () => financeService.voidInvoicePayment(invRow.id!, activePaymentRow.id, "Alasan void yang cukup panjang untuk validasi", svpSession.user),
      (err: any) => err?.code === "ORDER_CANCELLED"
    );
  });
});
