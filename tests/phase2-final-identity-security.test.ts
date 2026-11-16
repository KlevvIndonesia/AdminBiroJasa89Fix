/**
 * Phase 2 Final Identity Security Review Test Suite
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Verifies all 9 Identity Security requirements:
 * 1. Unknown jabatan + unknown storedRole is rejected fail-closed (401).
 * 2. Null/empty jabatan with invalid storedRole is rejected fail-closed (401).
 * 3. Operational ADMIN continues to obtain role 'admin' and access admin routes.
 * 4. SVP continues to obtain role 'administrator' with universal access.
 * 5. SVP demotion to ADMIN takes effect immediately on next request using existing token.
 * 6. Employee A reassigned to Employee B in SQLite is immediately updated on next request.
 * 7. Old token cannot use Employee A identity after database update (403 on courier ownership).
 * 8. Messenger cannot access or execute tasks belonging to other Messengers (cross-courier isolation).
 * 9. User without employee association (employee_id is NULL) cannot bypass ownership enforcement.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { generateToken, hashPassword } from "../server/src/utils/crypto";
import { resolveCanonicalRoleFromUser } from "../server/src/middleware/auth";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { CANONICAL_PERMISSIONS } from "../server/src/config/defaultPermissions";

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

test("PHASE 2 FINAL IDENTITY SECURITY REVIEW SUITE", async (t) => {
  const { server, baseUrl } = await startTestServer();

  let svpAuth: { token: string; user: any };
  let adminAuth: { token: string; user: any };
  let financeAuth: { token: string; user: any };
  let courier1Auth: { token: string; user: any };
  let courier3Auth: { token: string; user: any };

  t.before(async () => {
    svpAuth = await loginUser(baseUrl, "svp@birojasa.com", "admin123");
    adminAuth = await loginUser(baseUrl, "admin@birojasa.com", "admin123");
    financeAuth = await loginUser(baseUrl, "finance@birojasa.com", "finance123");
    courier1Auth = await loginUser(baseUrl, "budi.messenger@birojasa.com", "messenger123"); // EMP-0004, user id: 4
    courier3Auth = await loginUser(baseUrl, "andi.messenger@birojasa.com", "messenger123"); // EMP-0005, user id: 5

    // Initialize default permissions
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));
  });

  t.after(() => {
    // Restore default seed states
    db.prepare("UPDATE users SET jabatan = 'SVP', role = 'administrator', status = 'Aktif', employee_id = 'EMP-0001' WHERE email = 'svp@birojasa.com'").run();
    db.prepare("UPDATE users SET jabatan = 'ADMIN', role = 'admin', status = 'Aktif', employee_id = 'EMP-0002' WHERE email = 'admin@birojasa.com'").run();
    db.prepare("UPDATE users SET jabatan = 'FINANCE', role = 'finance', status = 'Aktif', employee_id = 'EMP-0003' WHERE email = 'finance@birojasa.com'").run();
    db.prepare("UPDATE users SET jabatan = 'MESSENGER', role = 'messenger', status = 'Aktif', employee_id = 'EMP-0004' WHERE email = 'budi.messenger@birojasa.com'").run();
    db.prepare("UPDATE users SET jabatan = 'MESSENGER', role = 'messenger', status = 'Aktif', employee_id = 'EMP-0005' WHERE email = 'andi.messenger@birojasa.com'").run();
    db.prepare("UPDATE users SET jabatan = 'MESSENGER', role = 'messenger', status = 'Aktif', employee_id = 'EMP-0006' WHERE email = 'messenger@birojasa.com'").run();
    server.close();
  });

  // =========================================================================
  // UNIT VERIFICATION: resolveCanonicalRoleFromUser Fail-Closed Behavior
  // =========================================================================
  await t.test("Unit: resolveCanonicalRoleFromUser fail-closed matrix", () => {
    // Canonical valid roles
    assert.strictEqual(resolveCanonicalRoleFromUser("SVP", "administrator"), "administrator");
    assert.strictEqual(resolveCanonicalRoleFromUser("ADMIN", "admin"), "admin");
    assert.strictEqual(resolveCanonicalRoleFromUser("FINANCE", "finance"), "finance");
    assert.strictEqual(resolveCanonicalRoleFromUser("MESSENGER", "messenger"), "messenger");
    assert.strictEqual(resolveCanonicalRoleFromUser("KURIR", "messenger"), "messenger");

    // Empty/null jabatan with valid storedRole (legacy compatibility)
    assert.strictEqual(resolveCanonicalRoleFromUser(null, "admin"), "admin");
    assert.strictEqual(resolveCanonicalRoleFromUser("", "finance"), "finance");
    assert.strictEqual(resolveCanonicalRoleFromUser(undefined, "administrator"), "administrator");

    // Unknown jabatan must NEVER fall back to storedRole "admin"
    assert.strictEqual(resolveCanonicalRoleFromUser("MAGANG", "admin"), null);
    assert.strictEqual(resolveCanonicalRoleFromUser("UNKNOWN", "admin"), null);
    assert.strictEqual(resolveCanonicalRoleFromUser("OPERATOR", "admin"), null);

    // Unknown jabatan and unknown storedRole
    assert.strictEqual(resolveCanonicalRoleFromUser("MAGANG", "unknown"), null);
    assert.strictEqual(resolveCanonicalRoleFromUser("UNKNOWN", "invalid"), null);

    // Empty jabatan with invalid storedRole
    assert.strictEqual(resolveCanonicalRoleFromUser(null, "invalid"), null);
    assert.strictEqual(resolveCanonicalRoleFromUser("", "guest"), null);
    assert.strictEqual(resolveCanonicalRoleFromUser("", ""), null);
  });

  // =========================================================================
  // SCENARIO 1: Unknown jabatan + unknown storedRole is rejected (401)
  // =========================================================================
  await t.test("Scenario 1: Unknown jabatan + unknown storedRole is rejected with 401 UNAUTHENTICATED", async () => {
    const { hash, salt } = hashPassword("secret123");
    const email = `unknown.role.${Date.now()}@birojasa.com`;
    const ins = db.prepare(`
      INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status)
      VALUES (?, ?, ?, 'Unknown Role User', 'MAGANG', 'unknown_role', 'Aktif')
    `).run(email, hash, salt);
    const userId = Number(ins.lastInsertRowid);

    const forgedToken = generateToken({
      userId: `usr-${userId}`,
      email,
      nama: "Unknown Role User",
      jabatan: "MAGANG",
      role: "admin", // Token attempts to claim admin, but SQLite has unmapped role
    });

    // Attempt direct API access to protected operational endpoint
    const res = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${forgedToken}` },
    });

    assert.strictEqual(res.status, 401, "Unknown role must be rejected with 401 Unauthorized");
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error?.code, "UNAUTHENTICATED");
    assert.match(body.error?.message, /tidak memiliki jabatan atau role kanonikal yang valid/i);
  });

  // =========================================================================
  // SCENARIO 2: Null/empty jabatan with invalid storedRole is rejected (401)
  // =========================================================================
  await t.test("Scenario 2: Null/empty jabatan with invalid storedRole is rejected with 401 UNAUTHENTICATED", async () => {
    const { hash, salt } = hashPassword("secret123");
    const email = `empty.jabatan.${Date.now()}@birojasa.com`;
    const ins = db.prepare(`
      INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status)
      VALUES (?, ?, ?, 'Empty Jabatan User', '', 'guest_staff', 'Aktif')
    `).run(email, hash, salt);
    const userId = Number(ins.lastInsertRowid);

    const token = generateToken({
      userId: `usr-${userId}`,
      email,
      nama: "Empty Jabatan User",
      jabatan: "",
      role: "guest_staff",
    });

    const res = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.strictEqual(res.status, 401, "Null/empty jabatan with invalid storedRole must be rejected with 401");
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error?.code, "UNAUTHENTICATED");
  });

  // =========================================================================
  // SCENARIO 3: Operational ADMIN continues to get role 'admin'
  // =========================================================================
  await t.test("Scenario 3: Operational ADMIN continues to get role 'admin' with correct access boundary", async () => {
    assert.strictEqual(adminAuth.user.role, "admin");
    assert.strictEqual(adminAuth.user.jabatan, "ADMIN");

    // 1. Admin can access order list (200 OK)
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(orderRes.status, 200);

    // 2. Admin cannot access SVP-exclusive endpoint (403 Forbidden)
    const svpOnlyRes = await fetch(`${baseUrl}/api/finance/kas-kantor/kas-1`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(svpOnlyRes.status, 403, "Admin must be blocked from SVP-only endpoint");
  });

  // =========================================================================
  // SCENARIO 4: SVP continues to get role 'administrator'
  // =========================================================================
  await t.test("Scenario 4: SVP continues to get role 'administrator' with universal access", async () => {
    assert.strictEqual(svpAuth.user.role, "administrator");
    assert.strictEqual(svpAuth.user.jabatan, "SVP");

    // 1. SVP can access admin routes
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(orderRes.status, 200);

    // 2. SVP can access finance routes
    const invoiceRes = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(invoiceRes.status, 200);

    // 3. SVP can access permissions endpoint
    const permRes = await fetch(`${baseUrl}/api/permissions`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(permRes.status, 200);

    // 4. SVP can mutate permissions; Admin is rejected with 403
    const adminPutPerm = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({ modules: {} }),
    });
    assert.strictEqual(adminPutPerm.status, 403, "Admin must not mutate role permissions");
  });

  // =========================================================================
  // SCENARIO 5: SVP demotion takes effect immediately on next request
  // =========================================================================
  await t.test("Scenario 5: Demoting SVP to ADMIN takes effect immediately on next request", async () => {
    // Demote SVP to ADMIN in database
    db.prepare("UPDATE users SET jabatan = 'ADMIN', role = 'admin' WHERE email = 'svp@birojasa.com'").run();

    try {
      // Use existing SVP token issued prior to demotion
      const deleteRes = await fetch(`${baseUrl}/api/finance/kas-kantor/kas-1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${svpAuth.token}` },
      });

      assert.strictEqual(deleteRes.status, 403, "Demoted SVP must immediately lose SVP privilege on next request");
      const body = await deleteRes.json();
      assert.strictEqual(body.error?.code, "FORBIDDEN");
    } finally {
      // Restore SVP
      db.prepare("UPDATE users SET jabatan = 'SVP', role = 'administrator' WHERE email = 'svp@birojasa.com'").run();
    }
  });

  // =========================================================================
  // SCENARIO 6: Employee A changed to Employee B in database after token issuance
  // =========================================================================
  await t.test("Scenario 6: Employee A reassigned to Employee B in SQLite is immediately updated on next request", async () => {
    // In database, order ORD-1126-003 is in 'Proses Samsat' with samsatMessengerId = 'EMP-0005'.
    // User 5 (courier3Auth) initially has employee_id = 'EMP-0005'.
    const initialRes = await fetch(`${baseUrl}/api/messenger/my-tasks`, {
      headers: { Authorization: `Bearer ${courier3Auth.token}` },
    });
    assert.strictEqual(initialRes.status, 200);
    const initialBody = await initialRes.json();
    const initSamsat = initialBody.data["Proses Samsat"] || [];
    assert.ok(initSamsat.some((o: any) => o.orderNo === "ORD-1126-003"), "Courier 3 (EMP-0005) must see ORD-1126-003 in Samsat tasks initially");

    // Free EMP-0006 from user 6, then reassign User 5 to EMP-0006 in database
    db.prepare("UPDATE users SET employee_id = NULL WHERE id = 6").run();
    db.prepare("UPDATE users SET employee_id = 'EMP-0006' WHERE id = 5").run();

    try {
      // Query using existing token minted with employeeId = 'EMP-0005'
      const afterRes = await fetch(`${baseUrl}/api/messenger/my-tasks`, {
        headers: { Authorization: `Bearer ${courier3Auth.token}` },
      });
      assert.strictEqual(afterRes.status, 200);
      const afterBody = await afterRes.json();

      // Because req.user.employeeId is now authoritative from DB ('EMP-0006'):
      // User 5 must no longer see tasks assigned to former employee EMP-0005
      const afterSamsat = afterBody.data["Proses Samsat"] || [];
      assert.strictEqual(
        afterSamsat.some((o: any) => o.orderNo === "ORD-1126-003"),
        false,
        "User 5 must immediately lose visibility of tasks assigned to former employee EMP-0005"
      );
    } finally {
      // Restore User 5 and User 6
      db.prepare("UPDATE users SET employee_id = 'EMP-0005' WHERE id = 5").run();
      db.prepare("UPDATE users SET employee_id = 'EMP-0006' WHERE id = 6").run();
    }
  });

  // =========================================================================
  // SCENARIO 7: Old token cannot use Employee A identity after DB update
  // =========================================================================
  await t.test("Scenario 7: Old token cannot use Employee A identity after DB update", async () => {
    // User 5 re-assigned to EMP-0006 in DB (avoiding unique constraint by freeing user 6 first)
    db.prepare("UPDATE users SET employee_id = NULL WHERE id = 6").run();
    db.prepare("UPDATE users SET employee_id = 'EMP-0006' WHERE id = 5").run();

    try {
      // Attempt to execute startSamsatProcess on ORD-1126-003 (assigned to EMP-0005)
      // Using courier3Auth.token which was minted with employeeId = "EMP-0005"
      const actionRes = await fetch(`${baseUrl}/api/orders/ORD-1126-003/samsat/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${courier3Auth.token}`,
        },
      });

      assert.strictEqual(actionRes.status, 403, "Action must be forbidden because DB employeeId is EMP-0006, not EMP-0005");
      const body = await actionRes.json();
      assert.strictEqual(body.error?.code, "FORBIDDEN");
      assert.match(body.error?.message, /ditugaskan kepada kurir lain|bukan penugasan aktif Anda/i);
    } finally {
      // Restore
      db.prepare("UPDATE users SET employee_id = 'EMP-0005' WHERE id = 5").run();
      db.prepare("UPDATE users SET employee_id = 'EMP-0006' WHERE id = 6").run();
    }
  });

  // =========================================================================
  // SCENARIO 8: Messenger cannot access tasks belonging to other Messengers
  // =========================================================================
  await t.test("Scenario 8: Messenger cannot access tasks belonging to other Messengers (cross-courier isolation)", async () => {
    // Courier 1 (EMP-0004) attempts to start Samsat process on ORD-1126-003 (assigned to EMP-0005)
    const samsatRes = await fetch(`${baseUrl}/api/orders/ORD-1126-003/samsat/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${courier1Auth.token}`,
      },
    });

    assert.strictEqual(samsatRes.status, 403, "Courier 1 must be forbidden from acting on Courier 3's task");
    const samsatBody = await samsatRes.json();
    assert.strictEqual(samsatBody.error?.code, "FORBIDDEN");
    assert.match(samsatBody.error?.message, /ditugaskan kepada kurir lain|bukan penugasan aktif Anda/i);
  });

  // =========================================================================
  // SCENARIO 9: User without employee association cannot bypass ownership enforcement
  // =========================================================================
  await t.test("Scenario 9: User without employee association cannot bypass ownership enforcement", async () => {
    // Unbind employee from User 5 in database
    db.prepare("UPDATE users SET employee_id = NULL WHERE id = 5").run();

    try {
      // 1. my-tasks returns zero tasks across all stages
      const tasksRes = await fetch(`${baseUrl}/api/messenger/my-tasks`, {
        headers: { Authorization: `Bearer ${courier3Auth.token}` },
      });
      assert.strictEqual(tasksRes.status, 200);
      const tasksBody = await tasksRes.json();
      for (const stage of Object.keys(tasksBody.data)) {
        assert.strictEqual(tasksBody.data[stage].length, 0, `Stage ${stage} must have 0 orders when employee_id is NULL in DB`);
      }

      // 2. Courier action is strictly rejected with 403 Forbidden
      const actionRes = await fetch(`${baseUrl}/api/orders/ORD-1126-003/samsat/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${courier3Auth.token}`,
        },
      });

      assert.strictEqual(actionRes.status, 403, "Unlinked messenger must be rejected with 403 Forbidden");
      const actionBody = await actionRes.json();
      assert.strictEqual(actionBody.error?.code, "FORBIDDEN");
      assert.match(actionBody.error?.message, /tidak valid atau tidak memiliki employeeId kanonikal/i);
    } finally {
      // Restore
      db.prepare("UPDATE users SET employee_id = 'EMP-0005' WHERE id = 5").run();
    }
  });
});
