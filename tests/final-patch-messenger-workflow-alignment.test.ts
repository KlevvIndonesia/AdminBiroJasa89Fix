import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { hashPassword } from "../server/src/utils/crypto";
import { APP_CONFIG } from "../src/app/config/appConfig";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { orderRepository } from "../src/data/repositories/orderRepository";
import { orderStore } from "../src/app/data/orderStore";
import { permissionStore } from "../src/app/data/permissionStore";
import {
  startSamsatProcessAction,
  updateSamsatSubprogressAction,
  updateMessengerTaskStatusAction,
  deriveSingleTaskFromOrder,
  acceptMessengerTaskAction,
} from "../src/app/data/messengerTaskAdapter";
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

test("FINAL PATCH: Messenger Samsat Start/Subprogress & Task Status Dedicated Endpoints Alignment", async (t) => {
  const { server, baseUrl } = await startTestServer();
  const originalApiBaseUrl = APP_CONFIG.apiBaseUrl;
  const originalOrderProvider = orderRepository.getProvider();
  const originalFetch = globalThis.fetch;

  APP_CONFIG.apiBaseUrl = `${baseUrl}/api`;
  const apiProvider = new ApiOrderProvider();
  orderRepository.setProvider(apiProvider);

  const recordedRequests: Array<{ method: string; url: string; body: any; status: number }> = [];

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = (init?.method || "GET").toUpperCase();
    let parsedBody: any = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    const res = await originalFetch(input, init);
    if (url.includes("/api/orders/")) {
      recordedRequests.push({ method, url, body: parsedBody, status: res.status });
    }
    return res;
  }) as any;

  t.after(() => {
    permissionStore.clearSession();
    apiProvider.clearSessionData();
    apiProvider.destroy();
    globalThis.fetch = originalFetch;
    const timer = (liveSyncManager as any).heartbeatTimer;
    if (timer) {
      clearInterval(timer);
      (liveSyncManager as any).heartbeatTimer = null;
    }
    APP_CONFIG.apiBaseUrl = originalApiBaseUrl;
    orderRepository.setProvider(originalOrderProvider);
    mockStorage.clear();
    server.close();
  });

  async function activateTestSession(role: "messenger" | "admin" | "finance", token: string, user: any) {
    mockStorage.setItem("auth_token", token);
    mockStorage.setItem("auth_user", JSON.stringify({ ...user, role }));
    permissionStore.hydrateSession(role, { notify: false, requireAuthoritativeSync: true });
    await permissionStore.initFromApi();
    await apiProvider.refresh();
  }

  const adminAuth = await loginUser(baseUrl, "admin@birojasa.com", "admin123");
  const financeAuth = await loginUser(baseUrl, "finance@birojasa.com", "finance123");
  const budiAuth = await loginUser(baseUrl, "budi.messenger@birojasa.com", "messenger123");

  // Ensure a second messenger exists for negative ownership tests inside this isolated SQLite copy
  const otherEmpId = "EMP-MSG-OTHER-FP";
  db.prepare(
    `INSERT OR IGNORE INTO employees (
      id, nik_ktp, nama_lengkap, no_hp, tgl_lahir, wilayah, alamat_domisili,
      jabatan, avatar_url, gaji_pokok, status_karyawan, tanggal_bergabung, jenis_kelamin
    ) VALUES (?, ?, ?, ?, '', 'Jakarta Selatan', '', 'Messenger', '', 0, 'Aktif', '2026-01-01', 'Laki-laki')`
  ).run(otherEmpId, "3171999900009999", "Kurir Lain FP", "081200009999");

  const hashed = hashPassword("messenger123");
  db.prepare(
    `INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status, employee_id, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?, 'Aktif', ?, '')`
  ).run(
    "other.fp@birojasa.com",
    hashed.hash,
    hashed.salt,
    "Kurir Lain FP",
    "Messenger",
    "messenger",
    otherEmpId
  );
  const otherAuth = await loginUser(baseUrl, "other.fp@birojasa.com", "messenger123");
  const otherMsgToken = otherAuth.token;

  const budiContext = {
    userId: String(budiAuth.user.id),
    employeeId: String(budiAuth.user.employeeId || "EMP-0004"),
    userName: String(budiAuth.user.nama || "Budi Santoso"),
    role: "messenger",
  };
  const adminContext = {
    userId: String(adminAuth.user.id),
    employeeId: String(adminAuth.user.employeeId || adminAuth.user.id),
    userName: String(adminAuth.user.nama || "Admin Operasional"),
    role: "admin",
  };

  async function createStage4Order(customerLabel: string): Promise<string> {
    const createRes = await originalFetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        customer: customerLabel,
        nomorHP: "081277770001",
        nopol: `B ${Math.floor(1000 + Math.random() * 8999)} FP`,
        layanan: "Perpanjangan 5 Tahun",
        wilayahSamsatAsal: "Jakarta Selatan",
        metodeLayanan: "Datang Langsung",
        totalEstimasi: 900000,
        biayaSamsat: 700000,
        biayaJasa: 200000,
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const created = (await createRes.json()) as any;
    const orderNo = created.data.orderNo as string;

    const advanceRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        targetStage: "Proses Samsat",
        updates: {
          documentsVerified: true,
          samsatMessengerId: budiContext.employeeId,
          samsatMessenger: budiContext.userName,
          samsatMessengerName: budiContext.userName,
          samsatProcesses: [
            { id: "comp-cek-fisik", name: "Cek Fisik", category: "Pokok", basePrice: 150000, status: "NOT_STARTED" },
            { id: "comp-cetak-stnk", name: "Cetak STNK", category: "Pokok", basePrice: 200000, status: "NOT_STARTED" },
          ],
        },
      }),
    });
    assert.strictEqual(advanceRes.status, 200);
    return orderNo;
  }

  await t.test("1. Assigned Messenger starts Samsat & component subprogress with zero PUT carrying samsatStatus", async () => {
    const orderNo = await createStage4Order("FP Customer Samsat 1");

    await activateTestSession("messenger", budiAuth.token, budiAuth.user);

    recordedRequests.length = 0;

    // Accept Proses Samsat first
    const acceptRes = await acceptMessengerTaskAction(orderNo, "Proses Samsat", budiContext);
    assert.strictEqual(acceptRes.success, true, `Accept failed: ${acceptRes.error}`);

    // Start Samsat process (concurrent double-invoke deduplicates to 1 POST)
    const [startRes, startResConcurrent] = await Promise.all([
      startSamsatProcessAction(orderNo, budiContext),
      startSamsatProcessAction(orderNo, budiContext),
    ]);
    assert.strictEqual(startRes.success, true, `startSamsatProcessAction failed: ${startRes.error}`);
    assert.strictEqual(startResConcurrent.success, true, `concurrent startSamsatProcessAction failed: ${startResConcurrent.error}`);
    assert.strictEqual(
      recordedRequests.filter((r) => r.method === "POST" && r.url.endsWith("/samsat/start")).length,
      1,
      "Expected concurrent startSamsatProcessAction calls to deduplicate into 1 network POST"
    );

    // Start specific Samsat component + subprogress
    const subRes = await updateSamsatSubprogressAction(
      orderNo,
      {
        subprogress: "Cek Fisik",
        componentId: "comp-cek-fisik",
        componentUpdate: {
          name: "Cek Fisik",
          status: "IN_PROGRESS",
          estimatedDurationMinutes: 60,
          startedAt: new Date().toISOString(),
        },
      },
      budiContext
    );
    assert.strictEqual(subRes.success, true, `updateSamsatSubprogressAction failed: ${subRes.error}`);

    // Verify zero generic PUT requests were fired and zero 403 occurred
    const putCalls = recordedRequests.filter((r) => r.method === "PUT");
    assert.strictEqual(putCalls.length, 0, `Expected 0 generic PUT calls, got: ${JSON.stringify(putCalls)}`);
    assert.strictEqual(
      recordedRequests.some((r) => r.status === 403),
      false,
      `Expected zero HTTP 403 responses, got: ${JSON.stringify(recordedRequests)}`
    );

    const updated = orderStore.getOrderByNo(orderNo)!;
    assert.strictEqual(updated.samsatStatus, "Sedang Proses Samsat");
    assert.strictEqual(updated.samsatSubstatus, "Sedang Cek Fisik");
    assert.strictEqual((updated as any).currentSamsatProcess, "Sedang Cek Fisik");
    assert.strictEqual((updated.messengerComponentProgress as any)?.["comp-cek-fisik"]?.status, "IN_PROGRESS");

    // Duplicate requests idempotency check
    const dupStartRes = await fetch(`${baseUrl}/api/orders/${orderNo}/samsat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(dupStartRes.status, 200);

    const dupSubRes = await fetch(`${baseUrl}/api/orders/${orderNo}/samsat/subprogress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({
        subprogress: "Cek Fisik",
        componentId: "comp-cek-fisik",
        componentUpdate: { status: "IN_PROGRESS", estimatedDurationMinutes: 60 },
      }),
    });
    assert.strictEqual(dupSubRes.status, 200);
  });

  await t.test("2. Pre-start, free-text note, task acceptance, and ownership guards on /samsat/subprogress", async () => {
    const orderNo = await createStage4Order("FP Customer PreStart");

    // Pre-start subprogress MUST be rejected with 400 SAMSAT_NOT_STARTED
    const preStartRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}/samsat/subprogress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({ subprogress: "Cek Fisik" }),
    });
    assert.strictEqual(preStartRes.status, 400);
    const preStartBody = (await preStartRes.json()) as any;
    assert.strictEqual(preStartBody?.error?.code, "SAMSAT_NOT_STARTED");

    // Wrong / unassigned messenger MUST be rejected with 403
    const otherStartRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}/samsat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherMsgToken}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(otherStartRes.status, 403);

    // PENDING task acceptance MUST block Messenger samsat/start with 403
    await originalFetch(`${baseUrl}/api/orders/${orderNo}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        taskAcceptance: {
          "Proses Samsat": {
            taskType: "Proses Samsat",
            status: "PENDING",
            assignedAt: new Date().toISOString(),
            courierId: budiContext.employeeId,
            courierName: budiContext.userName,
          },
        },
      }),
    });
    const pendingAcceptStartRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}/samsat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(pendingAcceptStartRes.status, 403, "Messenger must accept PENDING task before starting Samsat");

    // Declining task acceptance (without free-text note) succeeds 200 and clears assignment to pool
    const declineRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(declineRes.status, 200);

    // After declining, task is pool / pending acceptance or blocked -> unassigned other messenger cannot subprogress pre-start
    // Re-assign explicitly back to Budi & accept for note validation
    await originalFetch(`${baseUrl}/api/orders/${orderNo}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        samsatMessengerId: budiContext.employeeId,
        samsatMessenger: budiContext.userName,
        samsatMessengerName: budiContext.userName,
      }),
    });
    await originalFetch(`${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({}),
    });
    const startedOk = await originalFetch(`${baseUrl}/api/orders/${orderNo}/samsat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(startedOk.status, 200);

    // Messenger sending free-text note MUST get 400 MESSENGER_NOTES_NOT_ALLOWED
    const noteRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}/samsat/subprogress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({ subprogress: "Cek Fisik", note: "Catatan bebas terlarang" }),
    });
    assert.strictEqual(noteRes.status, 400);
    const noteBody = (await noteRes.json()) as any;
    assert.strictEqual(noteBody?.error?.code, "MESSENGER_NOTES_NOT_ALLOWED");
  });

  await t.test("3. Dedicated task status endpoint POST & PATCH works for Admin & Messenger and rejects invalid transitions", async () => {
    const orderNo = await createStage4Order("FP Customer TaskStatus");
    await originalFetch(`${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
      body: JSON.stringify({}),
    });

    // Admin updates task status via adapter action -> POST /tasks/:taskType/status (zero PUT)
    await activateTestSession("admin", adminAuth.token, adminAuth.user);
    recordedRequests.length = 0;

    const adminPendingRes = await updateMessengerTaskStatusAction(
      orderNo,
      "Pending",
      { taskType: "Proses Samsat", waitingReason: "Berkas menunggu antrean loket", note: "Cek ulang sore" },
      adminContext as any
    );
    assert.strictEqual(adminPendingRes.success, true, `Admin status update failed: ${adminPendingRes.error}`);
    assert.strictEqual(
      recordedRequests.filter((r) => r.method === "PUT").length,
      0,
      "Task status update MUST NOT call generic PUT /api/orders/:orderNo"
    );

    const pendingOrder = orderStore.getOrderByNo(orderNo)!;
    assert.strictEqual(pendingOrder.messengerTaskStatus, "Pending");
    assert.strictEqual(deriveSingleTaskFromOrder(pendingOrder).status, "Pending");

    // Admin resumes via PATCH alias
    const patchResumeRes = await originalFetch(
      `${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({ status: "Dalam Proses", note: "Loket kembali buka" }),
      }
    );
    assert.strictEqual(patchResumeRes.status, 200);
    const resumedBody = (await patchResumeRes.json()) as any;
    assert.strictEqual(resumedBody.data.messengerTaskStatus, "Dalam Proses");

    // Messenger sets WAITING with structured waitingReason (200)
    const msgWaitingRes = await originalFetch(
      `${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
        body: JSON.stringify({ status: "WAITING", waitingReason: "Sistem Samsat offline" }),
      }
    );
    assert.strictEqual(msgWaitingRes.status, 200);

    // Messenger free-text note rejected (400) & revert to Belum Diambil rejected (403)
    const msgNoteErr = await originalFetch(
      `${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
        body: JSON.stringify({ status: "Dalam Proses", note: "Free text" }),
      }
    );
    assert.strictEqual(msgNoteErr.status, 400);

    const msgRevertErr = await originalFetch(
      `${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${budiAuth.token}` },
        body: JSON.stringify({ status: "Belum Diambil" }),
      }
    );
    assert.strictEqual(msgRevertErr.status, 403);

    // Wrong messenger rejected (403)
    const otherMsgErr = await originalFetch(
      `${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherMsgToken}` },
        body: JSON.stringify({ status: "Dalam Proses" }),
      }
    );
    assert.strictEqual(otherMsgErr.status, 403);

    // Invalid transitions & missing fields rejected (400)
    const invalidCases = [
      { taskType: "Proses Samsat", body: { status: "Selesai" } },
      { taskType: "Proses Samsat", body: { status: "Dibatalkan" } },
      { taskType: "Proses Samsat", body: { status: "StatusNgawur" } },
      { taskType: "Proses Samsat", body: { status: "Pending" } },
      { taskType: "Jemput Dokumen", body: { status: "Dalam Proses" } },
      { taskType: "InvalidTaskType", body: { status: "Dalam Proses" } },
    ];
    for (const c of invalidCases) {
      const r = await originalFetch(
        `${baseUrl}/api/orders/${orderNo}/tasks/${encodeURIComponent(c.taskType)}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
          body: JSON.stringify(c.body),
        }
      );
      assert.strictEqual(r.status, 400, `Expected 400 for ${JSON.stringify(c)}, got ${r.status}`);
    }
  });

  await t.test("4. Protected-field PUT guard, RBAC negative boundaries, and Audit Trail", async () => {
    const orderNo = await createStage4Order("FP Customer Security");

    // Generic PUT with samsatStatus or messengerTaskStatus MUST remain 403 PROTECTED_FIELD_VIOLATION
    for (const token of [adminAuth.token, budiAuth.token]) {
      const putSamsatRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ samsatStatus: "Sedang Proses Samsat" }),
      });
      assert.strictEqual(putSamsatRes.status, 403);
      const putSamsatJson = (await putSamsatRes.json()) as any;
      assert.strictEqual(putSamsatJson?.error?.code, "PROTECTED_FIELD_VIOLATION");

      const putStatusRes = await originalFetch(`${baseUrl}/api/orders/${orderNo}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messengerTaskStatus: "Dalam Proses" }),
      });
      assert.strictEqual(putStatusRes.status, 403);
      const putStatusJson = (await putStatusRes.json()) as any;
      assert.strictEqual(putStatusJson?.error?.code, "PROTECTED_FIELD_VIOLATION");
    }

    // Finance = 403, Anonymous = 401
    const finSub = await originalFetch(`${baseUrl}/api/orders/${orderNo}/samsat/subprogress`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ subprogress: "Cek Fisik" }),
    });
    assert.strictEqual(finSub.status, 403);

    const finStatus = await originalFetch(`${baseUrl}/api/orders/${orderNo}/tasks/Proses%20Samsat/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ status: "Dalam Proses" }),
    });
    assert.strictEqual(finStatus.status, 403);

    const anonSub = await originalFetch(`${baseUrl}/api/orders/${orderNo}/samsat/subprogress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subprogress: "Cek Fisik" }),
    });
    assert.strictEqual(anonSub.status, 401);

    const anonStatus = await originalFetch(`${baseUrl}/api/orders/${orderNo}/tasks/Proses%20Samsat/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Dalam Proses" }),
    });
    assert.strictEqual(anonStatus.status, 401);

    // Verify audit logs persisted for both dedicated endpoints
    const subAudits = db
      .prepare(`SELECT action, user_role, module FROM audit_logs WHERE action = 'UPDATE_SAMSAT_SUBPROGRESS'`)
      .all() as any[];
    assert.ok(subAudits.length >= 1, "Expected UPDATE_SAMSAT_SUBPROGRESS audit log entries");

    const statusAudits = db
      .prepare(`SELECT action, user_role, module FROM audit_logs WHERE action = 'UPDATE_TASK_STATUS'`)
      .all() as any[];
    assert.ok(statusAudits.length >= 2, "Expected UPDATE_TASK_STATUS audit log entries");
  });

  await t.test("5. Logout cleanup, lower-privilege/fail-closed isolation, and delayed-response protection", async () => {
    const orderNo = await createStage4Order("FP Customer Session Safety");

    // Scenario 1: Messenger logs in with hydrated permissionStore -> loads own assigned task
    await activateTestSession("messenger", budiAuth.token, budiAuth.user);
    assert.strictEqual(permissionStore.canAccessApiEndpoint("messenger-tasks"), true);
    assert.ok(
      orderStore.getAllOrders().some((o) => o.orderNo === orderNo),
      "Authenticated messenger must see own assigned Stage 4 task"
    );

    // Scenario 2: Logout clears activeOrders, archivedOrders, and fail-closes permissions
    orderStore.clearSessionData();
    permissionStore.clearSession();
    mockStorage.clear();

    assert.strictEqual(orderStore.getAllOrders().length, 0, "Logout must clear all orders from orderStore");
    assert.strictEqual(orderStore.getArchivedOrders().length, 0, "Logout must clear archivedOrders");
    for (const stageList of Object.values(orderStore.getActiveOrders())) {
      assert.strictEqual(stageList.length, 0, "Each stage bucket must be empty after logout");
    }
    assert.strictEqual(permissionStore.canAccessApiEndpoint("orders"), false);
    assert.strictEqual(permissionStore.canAccessApiEndpoint("messenger-tasks"), false);

    // Scenario 3a: Unhydrated session fail-closed (even if token exists without hydrateSession, zero leak)
    mockStorage.setItem("auth_token", otherMsgToken);
    await apiProvider.initFromApi();
    assert.strictEqual(
      orderStore.getAllOrders().length,
      0,
      "Unhydrated session must remain fail-closed and never expose previous orders"
    );

    // Scenario 3b: Lower-privilege / distinct Messenger without assignments must see zero Budi orders
    await activateTestSession("messenger", otherMsgToken, otherAuth.user);
    assert.strictEqual(
      orderStore.getOrderByNo(orderNo),
      undefined,
      "Other messenger account must NOT see Budi's assigned task"
    );
    assert.strictEqual(orderStore.getArchivedOrders().length, 0);

    // Scenario 4: Delayed response from Session A arriving after logout / account switch is aborted & discarded
    await activateTestSession("admin", adminAuth.token, adminAuth.user);
    assert.ok(orderStore.getAllOrders().length >= 1);

    const suiteFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;
    let resolveDelayedFetch!: (res: Response) => void;
    const delayedPromise = new Promise<Response>((resolve) => {
      resolveDelayedFetch = resolve;
    });

    try {
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.endsWith("/api/orders")) {
          capturedSignal = init?.signal;
          return delayedPromise;
        }
        return suiteFetch(input, init);
      }) as any;

      const inFlightInit = apiProvider.initFromApi();

      // Wait a microtask tick so initFromApi dispatches the fetch
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(capturedSignal, "Expected ApiOrderProvider.initFromApi to pass AbortSignal");
      assert.strictEqual(capturedSignal?.aborted, false);

      // Logout / switch to other Messenger while Session A /api/orders request is still in-flight
      orderStore.clearSessionData();
      permissionStore.clearSession();
      mockStorage.clear();
      assert.strictEqual(capturedSignal?.aborted, true, "Logout/clearSessionData must abort in-flight GET fetch");

      // Switch to distinct Messenger before delayed Session A response settles
      globalThis.fetch = suiteFetch;
      await activateTestSession("messenger", otherMsgToken, otherAuth.user);

      // Simulate an un-aborted/slow Session A HTTP payload resolving late
      resolveDelayedFetch(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              "Buat Order & Pembayaran": [
                {
                  id: "stale-a-1",
                  orderNo: "STALE-SESSION-A-999",
                  customer: "Leak Customer",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      await inFlightInit;
      assert.strictEqual(
        orderStore.getOrderByNo("STALE-SESSION-A-999"),
        undefined,
        "Delayed response from invalidated sessionGeneration MUST be discarded"
      );
      assert.strictEqual(
        orderStore.getOrderByNo(orderNo),
        undefined,
        "Delayed Admin snapshot must not leak into subsequent Messenger session"
      );
    } finally {
      globalThis.fetch = suiteFetch;
      orderStore.clearSessionData();
      permissionStore.clearSession();
      mockStorage.clear();
    }
  });
});
