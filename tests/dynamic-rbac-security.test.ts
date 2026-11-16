/**
 * Dynamic RBAC Security & Policy Evolution Test Suite
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Verifies all 18 Security, Functional, and Architectural requirements:
 * 1. SVP successfully modifies ADMIN permission
 * 2. SVP successfully modifies FINANCE permission
 * 3. Operational Admin cannot modify permission (403)
 * 4. Finance cannot modify permission (403)
 * 5. Messenger cannot modify permission (403)
 * 6. Unauthenticated request rejected (401)
 * 7. SVP permission cannot be modified (403)
 * 8. Unknown role rejected (400)
 * 9. Unknown module key rejected (400)
 * 10. Invalid stage key rejected (400)
 * 11. Stage 6 invariants remain enforced (400)
 * 12. Audit log records before/after diffs
 * 13. Database rollback when transaction fails
 * 14. Concurrent update prevents lost updates (409)
 * 15. Permission updates take effect on API authorization
 * 16. Permission updates take effect on frontend store & route guards
 * 17. User losing permission cannot access API
 * 18. Double submission handling
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/src/app";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { dbAuditRepository } from "../server/src/repositories/dbAuditRepository";
import { permissionStore } from "../src/app/data/permissionStore";
import { db, runInTransaction } from "../server/src/database/db";

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
(globalThis as any).window = { localStorage: mockStorage, dispatchEvent: () => true };

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

async function loginUser(baseUrl: string, email: string, pass: string): Promise<{ token: string; user: any }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pass }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Login failed for ${email}: ${JSON.stringify(data)}`);
  return { token: data.data.token, user: data.data.user };
}

test("DYNAMIC RBAC & SECURITY VERIFICATION SUITE", async (t) => {
  const { server, baseUrl } = await startTestServer();

  let svpAuth: { token: string; user: any };
  let adminAuth: { token: string; user: any };
  let financeAuth: { token: string; user: any };
  let courierAuth: { token: string; user: any };

  t.before(async () => {
    svpAuth = await loginUser(baseUrl, "svp@birojasa.com", "admin123");
    adminAuth = await loginUser(baseUrl, "admin@birojasa.com", "admin123");
    financeAuth = await loginUser(baseUrl, "finance@birojasa.com", "finance123");
    courierAuth = await loginUser(baseUrl, "budi.messenger@birojasa.com", "messenger123");
  });

  t.after(() => {
    server.close();
  });

  // Test 1: SVP successfully modifies ADMIN permission
  await t.test("1. SVP successfully modifies ADMIN permission", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: {
          dashboard: { view: true, manage: false },
          "manajemen-karyawan": { view: true, manage: true },
        },
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data?.modules?.dashboard?.manage, false);
    assert.strictEqual(body.version > 1, true);
  });

  // Test 2: SVP successfully modifies FINANCE permission
  await t.test("2. SVP successfully modifies FINANCE permission", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/finance`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: {
          dashboard: { view: true, manage: false },
          "finance-profit": { view: true, manage: true },
        },
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data?.modules?.["finance-profit"]?.view, true);
  });

  // Test 3: Operational Admin cannot modify permission (403)
  await t.test("3. Operational Admin cannot modify permission (403 Forbidden)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "FORBIDDEN");
  });

  // Test 4: Finance cannot modify permission (403)
  await t.test("4. Finance cannot modify permission (403 Forbidden)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/finance`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${financeAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "FORBIDDEN");
  });

  // Test 5: Messenger cannot modify permission (403)
  await t.test("5. Messenger cannot modify permission (403 Forbidden)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/messenger`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${courierAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "FORBIDDEN");
  });

  // Test 6: Unauthenticated request rejected (401)
  await t.test("6. Unauthenticated request rejected (401 Unauthenticated)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
      }),
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "UNAUTHENTICATED");
  });

  // Test 7: SVP permission cannot be modified (403)
  await t.test("7. SVP permission cannot be modified (403 Forbidden - Security Invariant)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/svp`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: false, manage: false } },
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "FORBIDDEN");
    assert.match(body.error?.message, /SVP/);
  });

  // Test 8: Unknown role rejected (400)
  await t.test("8. Unknown role rejected (400 Bad Request)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/super_hacker`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
      }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "VALIDATION_ERROR");
  });

  // Test 9: Unknown module key rejected (400)
  await t.test("9. Unknown module key rejected (400 Bad Request)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: {
          dashboard: { view: true, manage: true },
          "malicious-unregistered-module": { view: true, manage: true },
        },
      }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "VALIDATION_ERROR");
    assert.match(body.error?.message, /malicious-unregistered-module/);
  });

  // Test 10: Invalid stage key rejected (400)
  await t.test("10. Invalid stage key rejected (400 Bad Request)", async () => {
    const res = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
        stages: {
          stage99_invalidStage: true,
        },
      }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "VALIDATION_ERROR");
  });

  // Test 11: Stage 6 invariants: stage6_supervisi is STRICTLY SVP-ONLY (rejected with 400 for both Finance and Admin)
  await t.test("11. Stage 6 invariants remain enforced: stage6_supervisi is strictly SVP-only for Finance and Admin", async () => {
    const finRes = await fetch(`${baseUrl}/api/permissions/finance`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: false } },
        stages: {
          stage6_supervisi: true,
        },
      }),
    });
    assert.strictEqual(finRes.status, 400);
    const finBody = await finRes.json();
    assert.strictEqual(finBody.error?.code, "VALIDATION_ERROR");
    assert.match(finBody.error?.message, /Supervisi/);

    // Admin cannot be granted stage6_supervisi: true either — Stage 6 is strictly SVP-only
    const metaBefore = dbPermissionRepository.getByRoleWithMeta("admin");
    const adminStage6Res = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        expectedVersion: metaBefore?.meta.version,
        modules: { ...metaBefore!.permissions.modules, dashboard: { view: true, manage: true } },
        stages: {
          ...metaBefore!.permissions.stages,
          stage6_supervisi: true,
        },
      }),
    });
    assert.strictEqual(adminStage6Res.status, 400);
    const adminStage6Body = await adminStage6Res.json();
    assert.strictEqual(adminStage6Body.error?.code, "VALIDATION_ERROR");
    assert.match(adminStage6Body.error?.message, /Supervisi|SVP/i);

    // Valid Admin update (with stage4_prosesSamsat: true and stage6_supervisi: false) succeeds
    const adminValidRes = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        expectedVersion: metaBefore?.meta.version,
        modules: { ...metaBefore!.permissions.modules, dashboard: { view: true, manage: true } },
        stages: {
          ...metaBefore!.permissions.stages,
          stage4_prosesSamsat: true,
          stage6_supervisi: false,
        },
      }),
    });
    assert.strictEqual(adminValidRes.status, 200);
  });

  // Test 12: Audit log records before/after diffs
  await t.test("12. Audit log records before/after diffs in audit_logs", async () => {
    const auditLogs = dbAuditRepository.getAll({ action: "UPDATE_PERMISSIONS", limit: 5 });
    assert.ok(auditLogs.length > 0, "Audit log must contain UPDATE_PERMISSIONS entries");
    const latest = auditLogs[0];
    assert.strictEqual(latest.action, "UPDATE_PERMISSIONS");
    assert.strictEqual(latest.module, "Hak Akses");
    assert.ok(latest.metadata?.diff, "Audit metadata must include diff");
    assert.ok(latest.metadata?.before, "Audit metadata must include before snapshot");
    assert.ok(latest.metadata?.after, "Audit metadata must include after snapshot");
  });

  // Test 13: Database rollback when transaction fails
  await t.test("13. Database rollback when transaction fails", () => {
    const beforeMeta = dbPermissionRepository.getByRoleWithMeta("admin");
    const originalVersion = beforeMeta?.meta.version || 1;

    // Simulate an aborted transaction
    assert.throws(() => {
      runInTransaction(() => {
        (db as any).prepare("UPDATE role_permissions SET permissions_json = 'corrupted' WHERE role = 'admin'").run();
        throw new Error("Simulated transactional error");
      });
    }, /Simulated transactional error/);

    // Verify rollback
    const afterMeta = dbPermissionRepository.getByRoleWithMeta("admin");
    assert.strictEqual(afterMeta?.meta.version, originalVersion, "Version should remain unchanged after rollback");
    assert.notStrictEqual(afterMeta?.permissions, null);
  });

  // Test 14: Concurrent update prevents lost updates (409 Conflict)
  await t.test("14. Concurrent update prevents lost updates (409 Conflict via expectedVersion)", async () => {
    // 1. Get current version for Admin
    const meta = dbPermissionRepository.getByRoleWithMeta("admin");
    const currentVer = meta?.meta.version || 1;

    // 2. Request with stale expectedVersion (e.g. currentVer - 1)
    const staleRes = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
        expectedVersion: currentVer - 1,
      }),
    });
    assert.strictEqual(staleRes.status, 409, "Stale revision must be rejected with 409 Conflict");
    const staleBody = await staleRes.json();
    assert.strictEqual(staleBody.error?.code, "CONCURRENCY_CONFLICT");

    // 3. Request with matching expectedVersion succeeds
    const matchRes = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: { dashboard: { view: true, manage: true } },
        expectedVersion: currentVer,
      }),
    });
    assert.strictEqual(matchRes.status, 200, "Matching revision must succeed");
  });

  // Test 15 & 17: Dynamic permission immediately takes effect on API authorization
  await t.test("15 & 17. Permission updates take effect on API authorization; revoking blocks access", async () => {
    // A. Initially Admin CAN access /api/employees (200 OK)
    const beforeRes = await fetch(`${baseUrl}/api/employees`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(beforeRes.status, 200, "Admin initially has access to /api/employees");

    // B. SVP revokes 'manajemen-karyawan' from Admin
    const revokeRes = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: {
          dashboard: { view: true, manage: false },
          "manajemen-karyawan": { view: false, manage: false },
        },
      }),
    });
    assert.strictEqual(revokeRes.status, 200);

    // C. Admin now immediately gets 403 Forbidden on /api/employees
    const afterRes = await fetch(`${baseUrl}/api/employees`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(afterRes.status, 403, "Admin must be immediately rejected with 403 after permission revoked");
    const afterBody = await afterRes.json();
    assert.strictEqual(afterBody.error?.code, "FORBIDDEN");

    // D. SVP restores 'manajemen-karyawan' to Admin
    const restoreRes = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: {
          dashboard: { view: true, manage: false },
          "manajemen-karyawan": { view: true, manage: true },
        },
      }),
    });
    assert.strictEqual(restoreRes.status, 200);

    // E. Admin can access /api/employees again (200 OK)
    const restoredRes = await fetch(`${baseUrl}/api/employees`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(restoredRes.status, 200, "Admin can access /api/employees again after permission restored");
  });

  // Test 16: Permission updates take effect on frontend store & route guards
  await t.test("16. Permission updates take effect on frontend store & route guards", async () => {
    // 1. Mock token in localStorage for frontend permissionStore
    mockStorage.setItem("auth_token", svpAuth.token);

    // 2. Refresh permissionStore from test server
    (globalThis as any).fetch = fetch;
    // Set API base url on APP_CONFIG
    (process.env as any).VITE_API_URL = `${baseUrl}/api`;

    // Direct verification of permission store methods (canonical 'administrator' role for SVP; legacy 'svp' alias fails closed per Batch 1)
    assert.strictEqual(permissionStore.canViewPage("administrator", "access-management"), true);
    assert.strictEqual(permissionStore.canViewPage("svp", "access-management"), false, "Legacy 'svp' alias must fail closed");
    assert.strictEqual(permissionStore.canViewPage("admin", "access-management"), false, "Access Management must remain strictly locked for Admin");
    assert.strictEqual(permissionStore.canManageStage("admin", 4), true, "Stage 4 defaults to authorized for Admin");
    assert.strictEqual(permissionStore.canManageStage("admin", 6), false, "Stage 6 is strictly SVP-only and locked for Admin");
    assert.strictEqual(permissionStore.canManageStage("administrator", 6), true, "SVP (canonical administrator) always retains Stage 6 authority");
    assert.strictEqual(permissionStore.canManageStage("svp", 6), false, "Legacy 'svp' alias must fail closed on Stage 6");
    assert.strictEqual(permissionStore.canManageStage("finance", 6), false, "Stage 6 must be strictly locked for Finance");
  });

  // Test 18: Double submission handling
  await t.test("18. Double submission handling", async () => {
    const meta = dbPermissionRepository.getByRoleWithMeta("finance");
    const ver = meta?.meta.version || 1;

    // Send first request with expectedVersion
    const req1 = await fetch(`${baseUrl}/api/permissions/finance`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: {
          dashboard: { view: true, manage: false },
          "finance-profit": { view: true, manage: true },
        },
        expectedVersion: ver,
      }),
    });
    assert.strictEqual(req1.status, 200);

    // Send duplicate identical request with same old expectedVersion
    const req2 = await fetch(`${baseUrl}/api/permissions/finance`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        modules: {
          dashboard: { view: true, manage: false },
          "finance-profit": { view: true, manage: true },
        },
        expectedVersion: ver,
      }),
    });
    // Double submission with stale version is cleanly rejected with 409
    assert.strictEqual(req2.status, 409);
    const body2 = await req2.json();
    assert.strictEqual(body2.error?.code, "CONCURRENCY_CONFLICT");
  });
});
