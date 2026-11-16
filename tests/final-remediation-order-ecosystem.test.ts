import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { CANONICAL_PERMISSIONS } from "../server/src/config/defaultPermissions";
import { runAdminStage4ParityRbacMigration } from "../server/src/database/migrations/2026-11-14-001-admin-stage4-parity-rbac";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { APP_CONFIG } from "../src/app/config/appConfig";
import { permissionStore } from "../src/app/data/permissionStore";
import { apiEmployeeProvider } from "../src/data/api/apiEmployeeProvider";
import { ApiUserProvider } from "../src/data/api/apiUserProvider";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { userRepository } from "../src/data/repositories/userRepository";
import { financeRepository } from "../src/data/repositories/financeRepository";
import { orderRepository } from "../src/data/repositories/orderRepository";
import { karyawanPenggunaAdapter } from "../src/app/data/karyawanPenggunaAdapter";
import { auditLog } from "../src/app/utils/auditLog";
import { liveSyncManager } from "../src/app/utils/useLiveSync";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

const mockStorage = new MemoryStorage();
(globalThis as any).localStorage = mockStorage;
(globalThis as any).window = {
  localStorage: mockStorage,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};

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

async function loginUser(
  baseUrl: string,
  email: string,
  password: string
): Promise<{ token: string; user: any }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = (await res.json()) as any;
  assert.strictEqual(res.status, 200, `Login failed for ${email}: ${JSON.stringify(data)}`);
  return { token: data.data.token, user: data.data.user };
}

test("FINAL REMEDIATION: Persistent RBAC, Messenger Adapter, Permission-Aware Polling & Stage 8 Archive Guard", async (t) => {
  const { server, baseUrl } = await startTestServer();
  const originalApiBaseUrl = APP_CONFIG.apiBaseUrl;
  const originalOrderProvider = orderRepository.getProvider();
  const originalUserProvider = userRepository.getProvider();
  const originalFinanceProvider = financeRepository.getProvider();
  APP_CONFIG.apiBaseUrl = `${baseUrl}/api`;

  t.after(() => {
    liveSyncManager.destroy();
    APP_CONFIG.apiBaseUrl = originalApiBaseUrl;
    orderRepository.setProvider(originalOrderProvider);
    userRepository.setProvider(originalUserProvider);
    financeRepository.setProvider(originalFinanceProvider);
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));
    mockStorage.clear();
    permissionStore.clearSession();
    server.closeAllConnections?.();
    server.close();
  });

  const svpAuth = await loginUser(baseUrl, "svp@birojasa.com", "admin123");
  const adminAuth = await loginUser(baseUrl, "admin@birojasa.com", "admin123");
  const financeAuth = await loginUser(baseUrl, "finance@birojasa.com", "finance123");
  const messengerAuth = await loginUser(baseUrl, "budi.messenger@birojasa.com", "messenger123");

  // ===========================================================================
  // FIX 1: Non-destructive Idempotent Migration + Admin Stage 4 Parity + Stage 6 SVP-Only
  // ===========================================================================
  await t.test("Fix 1: Existing DB migration upgrades Admin Stage 4 parity, locks Stage 6 SVP-only, and preserves custom perms & audits", async () => {
    // Prepare an existing customized DB state (updated by SVP, version 3, custom finance-profit, stale stage4=false & stage6=true)
    const legacyAdminJson = JSON.stringify({
      ...JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)),
      modules: {
        ...JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin.modules)),
        "finance-profit": { view: true, manage: true },
        "order-tracking": { view: true, manage: false },
      },
      stages: {
        ...JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin.stages)),
        stage4_prosesSamsat: false,
        stage6_supervisi: true,
      },
    });
    const staleFinanceJson = JSON.stringify({
      ...JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)),
      stages: {
        ...JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance.stages)),
        stage6_supervisi: true,
      },
    });

    db.prepare(
      `UPDATE role_permissions SET permissions_json = ?, updated_by = 'Admin Super (SVP)' WHERE role = 'admin'`
    ).run(legacyAdminJson);
    db.prepare(
      `UPDATE role_permissions SET permissions_json = ?, updated_by = 'Admin Super (SVP)' WHERE role = 'finance'`
    ).run(staleFinanceJson);
    db.prepare(`DELETE FROM schema_migrations WHERE id = '2026-11-14-001-admin-stage4-parity-rbac'`).run();

    const auditCountBefore = (db.prepare(`SELECT COUNT(*) as cnt FROM audit_logs`).get() as { cnt: number }).cnt;

    const firstRun = runAdminStage4ParityRbacMigration(db);
    assert.strictEqual(firstRun.applied, true);
    assert.strictEqual(firstRun.adminUpdated, true);
    assert.ok(firstRun.otherRolesNormalized >= 1);

    const migratedAdmin = dbPermissionRepository.getByRole("admin")!;
    assert.strictEqual(migratedAdmin.stages.stage4_prosesSamsat, true, "Admin Stage 4 must be upgraded to true");
    assert.strictEqual(migratedAdmin.stages.stage6_supervisi, false, "Admin Stage 6 must be locked false (SVP-only)");
    assert.deepStrictEqual(migratedAdmin.modules["order-tracking"], { view: true, manage: true });
    assert.deepStrictEqual(migratedAdmin.modules["order-menu"], { view: true, manage: true });
    assert.deepStrictEqual(migratedAdmin.modules["buat-order"], { view: true, manage: true });
    assert.deepStrictEqual(migratedAdmin.modules["order-history"], { view: true, manage: true });
    assert.deepStrictEqual(
      migratedAdmin.modules["finance-profit"],
      { view: true, manage: true },
      "Custom non-order module permissions must be preserved non-destructively"
    );

    const migratedFinance = dbPermissionRepository.getByRole("finance")!;
    assert.strictEqual(migratedFinance.stages.stage6_supervisi, false, "Finance Stage 6 must be normalized false");

    const auditCountAfter = (db.prepare(`SELECT COUNT(*) as cnt FROM audit_logs`).get() as { cnt: number }).cnt;
    assert.ok(auditCountAfter >= auditCountBefore, "Existing audit logs must be preserved");

    // Second run must be strictly idempotent
    const secondRun = runAdminStage4ParityRbacMigration(db);
    assert.strictEqual(secondRun.applied, false);
    assert.strictEqual(secondRun.adminUpdated, false);

    // PUT /api/permissions/admin trying to enable stage6_supervisi MUST return 400
    const adminMeta = dbPermissionRepository.getByRoleWithMeta("admin")!;
    const putStage6Res = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        expectedVersion: adminMeta.meta.version,
        modules: adminMeta.permissions.modules,
        stages: {
          ...adminMeta.permissions.stages,
          stage6_supervisi: true,
        },
      }),
    });
    assert.strictEqual(putStage6Res.status, 400);

    // Restore clean canonical permissions for Stage 4..8 API verification
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));

    // Verify Admin full Stage 4 parity + Stage 5 -> Stage 6 submission, then Stage 6 SVP-only boundary
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        customer: "Fix1 Parity Customer",
        nomorHP: "081288887777",
        nopol: "B 4444 REM",
        layanan: "Perpanjangan STNK Tahunan",
        wilayahSamsatAsal: "Jakarta Pusat",
        metodeLayanan: "Datang Langsung",
        totalEstimasi: 500000,
        biayaSamsat: 350000,
        biayaJasa: 150000,
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const created = (await createRes.json()) as any;
    const orderNo = created.data.orderNo;

    // Step 3 -> 4 (Verifikasi Dokumen -> Proses Samsat)
    const step3to4Res = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        targetStage: "Proses Samsat",
        updates: {
          documentsVerified: true,
          samsatMessengerId: "EMP-0004",
          samsatMessengerName: "Budi Santoso",
          samsatProcesses: [{ id: "comp-1", name: "Cek Fisik", status: "COMPLETED" }],
        },
      }),
    });
    assert.strictEqual(step3to4Res.status, 200);

    // Admin manages Stage 4: Samsat process fields & courier assignment + completes Stage 4 flow
    const samsatPutRes = await fetch(`${baseUrl}/api/orders/${orderNo}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        samsatPickupDate: "2026-11-14",
        samsatPickupMessenger: "Budi Santoso",
        samsatPickupMessengerId: "EMP-0004",
      }),
    });
    assert.strictEqual(samsatPutRes.status, 200, "Admin MUST be able to manage Stage 4 Samsat & Messenger assignment");

    // Complete messenger tasks sequentially at Stage 4 so 4 -> 5 prerequisite passes
    const acceptSamsatRes = await fetch(`${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${messengerAuth.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(acceptSamsatRes.status, 200, "accept Proses Samsat failed");
    const samsatDone = await fetch(`${baseUrl}/api/orders/${orderNo}/samsat/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${messengerAuth.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(samsatDone.status, 200);

    const acceptPickupRes = await fetch(`${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Hasil Samsat")}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${messengerAuth.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(acceptPickupRes.status, 200, "accept Jemput Hasil Samsat failed");
    const pickupDone = await fetch(`${baseUrl}/api/orders/${orderNo}/samsat-pickup/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${messengerAuth.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(pickupDone.status, 200);

    const step4to5Res = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({ targetStage: "Verifikasi Ulang", updates: {} }),
    });
    assert.strictEqual(step4to5Res.status, 200, "Admin MUST be able to advance Stage 4 -> 5");

    // Step 5 -> 6 (Admin submits into Stage 6 Supervisi queue)
    const step5to6Res = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        targetStage: "Supervisi",
        updates: {
          documentsVerified: true,
          documentApproval: { stage5Verified: true, stage5VerifiedBy: "Adrian Adhari" },
        },
      }),
    });
    assert.strictEqual(step5to6Res.status, 200, "Admin MUST be able to advance Stage 5 -> 6 into Supervisi queue");

    // Stage 6 actions MUST be 403 for Admin
    const adminApprove6Res = await fetch(`${baseUrl}/api/orders/${orderNo}/approve-documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({ stage: 6, verificationResult: "Approved" }),
    });
    assert.strictEqual(adminApprove6Res.status, 403, "Admin MUST receive 403 on Stage 6 approve-documents");

    const adminStep6to7Res = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({ targetStage: "Pengantaran", updates: { approvedBySpv: true } }),
    });
    assert.strictEqual(adminStep6to7Res.status, 403, "Admin MUST receive 403 advancing out of Stage 6");

    // SVP succeeds at Stage 6
    const svpStep6to7Res = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        targetStage: "Pengantaran",
        updates: {
          approvedBySpv: true,
          deliveryMessengerId: "EMP-0004",
          deliveryMessengerName: "Budi Santoso",
          messengerPengantar: "Budi Santoso",
        },
      }),
    });
    assert.strictEqual(svpStep6to7Res.status, 200, "SVP MUST succeed advancing Stage 6 -> 7");
  });

  // ===========================================================================
  // FIX 2: karyawanPenggunaAdapter Decoupling (Messenger Dropdown Resilience)
  // ===========================================================================
  await t.test("Fix 2: karyawanPenggunaAdapter keeps Messenger karyawanList intact even when /api/users fails 403", async () => {
    const providerUrl = `${baseUrl}/api`;
    const failingUsersProvider = new ApiUserProvider(providerUrl);
    userRepository.setProvider(failingUsersProvider);

    mockStorage.setItem("auth_token", adminAuth.token);
    mockStorage.setItem("auth_user", JSON.stringify(adminAuth.user));
    await permissionStore.initFromApi();

    // Even if user provider fails with 403/network error manually, employees must still hydrate cleanly
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/users")) {
        return new Response(JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "Denied" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input, init);
    };

    try {
      karyawanPenggunaAdapter.clearSessionData();
      await karyawanPenggunaAdapter.refresh({ target: "all" });

      const list = karyawanPenggunaAdapter.getKaryawan();
      assert.ok(list.length > 0, "Karyawan / Messenger list must populate from /api/employees regardless of /api/users");
      const activeMessengers = list.filter(
        (k) => String(k.jabatan || "").toUpperCase() === "MESSENGER" && k.status === "Aktif"
      );
      assert.ok(
        activeMessengers.length >= 2,
        `Active Messenger options must remain available for Stage 2 & 4 dropdowns; got: ${JSON.stringify(list.map((k) => ({ id: k.id, jabatan: k.jabatan, status: k.status })))}`
      );
      assert.strictEqual(karyawanPenggunaAdapter.getEmployeeError(), null, "employeeError must remain null when /api/employees succeeds");
      assert.strictEqual(karyawanPenggunaAdapter.isEmployeeStale(), false);
    } finally {
      (globalThis as any).fetch = origFetch;
    }

    // Verify real /api/employees failure sets karyawanError and targeted retry recovers
    (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/employees")) {
        return new Response(JSON.stringify({ success: false, error: { message: "Employee DB error" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input, init);
    };

    try {
      await karyawanPenggunaAdapter.refresh({ target: "employees" });
      assert.ok(karyawanPenggunaAdapter.getEmployeeError(), "employeeError must reflect /api/employees failure");
    } finally {
      (globalThis as any).fetch = origFetch;
    }

    await karyawanPenggunaAdapter.refresh({ onlyFailed: true });
    assert.strictEqual(karyawanPenggunaAdapter.getEmployeeError(), null, "Targeted retry must clear employeeError after recovery");
  });

  // ===========================================================================
  // FIX 3: Permission-Aware Initial Fetch & Polling Across Roles (Zero 403s)
  // ===========================================================================
  await t.test("Fix 3: Permission-aware client init & LiveSync poll produce zero avoidable 403 responses across Admin, Finance, Messenger", async () => {
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));
    const apiUrl = `${baseUrl}/api`;
    const roleCases = [
      {
        name: "admin",
        auth: adminAuth,
        forbiddenPaths: [
          "/api/users",
          "/api/finance/invoices",
          "/api/finance/kas-kantor",
          "/api/finance/pengeluaran",
          "/api/finance/kas-messenger",
          "/api/audit-logs",
          "/api/messenger/my-tasks",
        ],
        requiredAnyPaths: ["/api/permissions", "/api/employees", "/api/orders"],
      },
      {
        name: "finance",
        auth: financeAuth,
        forbiddenPaths: [
          "/api/users",
          "/api/employees",
          "/api/audit-logs",
          "/api/messenger/my-tasks",
        ],
        requiredAnyPaths: ["/api/permissions", "/api/orders", "/api/finance/invoices", "/api/finance/kas-kantor"],
      },
      {
        name: "messenger",
        auth: messengerAuth,
        forbiddenPaths: [
          "/api/users",
          "/api/employees",
          "/api/orders?",
          "/api/orders/archived",
          "/api/finance/invoices",
          "/api/finance/kas-kantor",
          "/api/finance/pengeluaran",
          "/api/audit-logs",
        ],
        requiredAnyPaths: ["/api/permissions", "/api/messenger/my-tasks", "/api/finance/kas-messenger"],
      },
    ];

    const origFetch = globalThis.fetch;

    for (const rc of roleCases) {
      const requestedUrls: Array<{ url: string; status: number }> = [];
      let fProv: ApiFinanceProvider | null = null;
      (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await origFetch(input, init);
        const url = typeof input === "string" ? input : input.toString();
        requestedUrls.push({ url, status: res.status });
        return res;
      };

      try {
        mockStorage.clear();
        mockStorage.setItem("auth_token", rc.auth.token);
        mockStorage.setItem("auth_user", JSON.stringify(rc.auth.user));

        const uProv = new ApiUserProvider(apiUrl);
        fProv = new ApiFinanceProvider(apiUrl);
        const oProv = new ApiOrderProvider(apiUrl);
        userRepository.setProvider(uProv);
        financeRepository.setProvider(fProv);
        orderRepository.setProvider(oProv);

        // Must await permissionStore first, matching App.tsx boot ordering
        await permissionStore.initFromApi();
        await Promise.all([
          uProv.initFromApi(),
          apiEmployeeProvider.initFromApi(),
          fProv.initFromApi(),
          oProv.initFromApi(),
          auditLog.initFromApi(),
        ]);
        await liveSyncManager.sync({ silent: true });

        const forbiddenHits = requestedUrls.filter((r) =>
          rc.forbiddenPaths.some((fp) =>
            fp.endsWith("?") ? r.url.endsWith("/api/orders") : r.url.includes(fp)
          )
        );
        assert.deepStrictEqual(
          forbiddenHits,
          [],
          `Role ${rc.name} must NOT request forbidden endpoints: ${JSON.stringify(forbiddenHits)}`
        );

        const error403s = requestedUrls.filter((r) => r.status === 403);
        assert.deepStrictEqual(
          error403s,
          [],
          `Role ${rc.name} experienced 403 responses: ${JSON.stringify(error403s)}`
        );

        for (const reqPath of rc.requiredAnyPaths) {
          assert.ok(
            requestedUrls.some((r) => r.url.includes(reqPath)),
            `Role ${rc.name} should request permitted endpoint ${reqPath}`
          );
        }
      } finally {
        fProv?.destroy();
        mockStorage.clear();
        permissionStore.clearSession();
        (globalThis as any).fetch = origFetch;
      }
    }
  });

  // ===========================================================================
  // FIX 4: Stage 8 Archive Backend Integrity Guard
  // ===========================================================================
  await t.test("Fix 4: POST /api/orders/:orderNo/archive strictly requires authoritative Stage 8 state", async () => {
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        customer: "Archive Integrity Test",
        nomorHP: "081277776666",
        nopol: "B 8888 ARC",
        layanan: "Balik Nama Kendaraan",
        wilayahSamsatAsal: "Jakarta Selatan",
        metodeLayanan: "Antar Jemput Dokumen",
        totalEstimasi: 800000,
        biayaSamsat: 600000,
        biayaJasa: 200000,
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const created = (await createRes.json()) as any;
    const orderNo = created.data.orderNo;

    const preStage8Names: Array<[number, string]> = [
      [1, "Verifikasi"],
      [2, "Penjadwalan"],
      [3, "Verifikasi Dokumen"],
      [4, "Proses Samsat"],
      [5, "Verifikasi Ulang"],
      [6, "Supervisi"],
      [7, "Pengantaran"],
    ];

    for (const [step, stageName] of preStage8Names) {
      dbOrderRepository.updateOrder(orderNo, { currentStep: step, currentStageName: stageName });
      const res = await fetch(`${baseUrl}/api/orders/${orderNo}/archive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminAuth.token}`,
        },
        // Even with tampered body attempting to spoof Stage 8
        body: JSON.stringify({
          currentStep: 8,
          currentStageName: "Dokumen Telah Diterima",
          isArchived: true,
        }),
      });
      assert.strictEqual(res.status, 400, `Archive at Stage ${step} (${stageName}) MUST be rejected with 400`);
      const body = (await res.json()) as any;
      assert.strictEqual(body.error?.code, "INVALID_ARCHIVE_STAGE");
    }

    // Cancelled order cannot be archived even if currentStep = 8
    const cancelCreateRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        customer: "Cancelled Archive Test",
        nomorHP: "081266665555",
        nopol: "B 9999 CNC",
        layanan: "Perpanjangan STNK Tahunan",
        wilayahSamsatAsal: "Jakarta Barat",
        metodeLayanan: "Datang Langsung",
        totalEstimasi: 450000,
      }),
    });
    const cancelOrderNo = ((await cancelCreateRes.json()) as any).data.orderNo;
    await fetch(`${baseUrl}/api/orders/${cancelOrderNo}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({ reason: "Customer cancelled" }),
    });
    const archiveCancelledRes = await fetch(`${baseUrl}/api/orders/${cancelOrderNo}/archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
    });
    assert.strictEqual(archiveCancelledRes.status, 400);
    const cancelledBody = (await archiveCancelledRes.json()) as any;
    assert.strictEqual(cancelledBody.error?.code, "ORDER_CANCELLED");

    // Stage 8 order: Finance & Messenger still denied (403); Admin succeeds (200); duplicate is idempotent (200)
    dbOrderRepository.updateOrder(orderNo, {
      currentStep: 8,
      currentStageName: "Dokumen Telah Diterima",
      isReceived: true,
    });

    const finArchiveRes = await fetch(`${baseUrl}/api/orders/${orderNo}/archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${financeAuth.token}`,
      },
    });
    assert.strictEqual(finArchiveRes.status, 403);

    const msgArchiveRes = await fetch(`${baseUrl}/api/orders/${orderNo}/archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${messengerAuth.token}`,
      },
    });
    assert.strictEqual(msgArchiveRes.status, 403);

    const validArchiveRes = await fetch(`${baseUrl}/api/orders/${orderNo}/archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
    });
    assert.strictEqual(validArchiveRes.status, 200);

    const idempotentArchiveRes = await fetch(`${baseUrl}/api/orders/${orderNo}/archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
    });
    assert.strictEqual(idempotentArchiveRes.status, 200);
  });
});
