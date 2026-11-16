/**
 * Phase 2 Security Hardening Test Suite
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Verifies all security findings remediated in Phase 2:
 * 1. SVP retains universal access across operational & administrative endpoints.
 * 2. SVP demoted to ADMIN immediately loses SVP privileges on next request (JWT Staleness defense).
 * 3. Operational Admin does not obtain SVP privileges (403 on SVP-exclusive endpoints).
 * 4. Old token cannot retain revoked module permissions (immediate dynamic enforcement).
 * 5. Deactivated user (status = 'Nonaktif') is immediately rejected with 401 UNAUTHENTICATED.
 * 6. Malformed permission records in SQLite are handled fail-closed (access denied).
 * 7. Explicit false is never converted to granted permission (submodule fallback safety).
 * 8. Payment verification endpoints (/verify-payment and /payments/:paymentId/verify) maintain strict parity.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
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

test("PHASE 2 SECURITY HARDENING: AUDIT FINDINGS REMEDIATION SUITE", async (t) => {
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

    // Ensure canonical permissions are initialized
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));
  });

  t.after(() => {
    // Restore default state
    db.prepare("UPDATE users SET jabatan = 'SVP', role = 'administrator', status = 'Aktif' WHERE email = 'svp@birojasa.com'").run();
    db.prepare("UPDATE users SET jabatan = 'ADMIN', role = 'admin', status = 'Aktif' WHERE email = 'admin@birojasa.com'").run();
    db.prepare("UPDATE users SET jabatan = 'FINANCE', role = 'finance', status = 'Aktif' WHERE email = 'finance@birojasa.com'").run();

    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));

    server.close();
  });

  // TEST 1: SVP can access all authorized operations
  await t.test("1. SVP retains universal access to authorized operations", async () => {
    const endpoints = [
      "/api/finance/invoices",
      "/api/finance/laba-rugi",
      "/api/finance/kas-kantor",
      "/api/finance/audit/void-history",
      "/api/orders",
      "/api/orders/archived",
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`, {
        headers: { Authorization: `Bearer ${svpAuth.token}` },
      });
      assert.strictEqual(res.status, 200, `Expected 200 for SVP on ${ep}, got ${res.status}`);
    }
  });

  // TEST 2: SVP demoted to ADMIN immediately loses SVP privileges on next request (JWT Staleness Defense)
  await t.test("2. Immediate demotion revocation: demoted SVP loses privileges on next request", async () => {
    // A. While SVP in DB, token can access SVP-only endpoint
    // DELETE /api/finance/kas-kantor/kk-test requires role 'svp'
    const preRes = await fetch(`${baseUrl}/api/finance/kas-kantor/kk-test`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svpAuth.token}` },
      body: JSON.stringify({ reason: "SVP test delete" }),
    });
    // Not 403 because user is authenticated and recognized as SVP
    assert.notStrictEqual(preRes.status, 403, "SVP should not be forbidden on kas-kantor delete");

    // B. Demote user in SQLite: change jabatan to ADMIN, role to admin
    db.prepare("UPDATE users SET jabatan = 'ADMIN', role = 'admin' WHERE email = 'svp@birojasa.com'").run();

    // C. Next request using the EXACT SAME JWT token (which claims role='administrator', jabatan='SVP')
    const postRes = await fetch(`${baseUrl}/api/finance/kas-kantor/kk-test`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svpAuth.token}` },
      body: JSON.stringify({ reason: "Attempt after demotion" }),
    });

    // Authoritative SQLite state must be evaluated -> User is now ADMIN -> HTTP 403 FORBIDDEN
    assert.strictEqual(postRes.status, 403, `Expected 403 for demoted user, got ${postRes.status}`);
    const postBody = await postRes.json();
    assert.strictEqual(postBody.error?.code, "FORBIDDEN");

    // D. Demoted user loses SVP-exclusive Hak Akses management privilege immediately
    const hakAksesRes = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svpAuth.token}` },
      body: JSON.stringify({ modules: {}, stages: {} }),
    });
    assert.strictEqual(hakAksesRes.status, 403, "Demoted user must immediately lose SVP Hak Akses privilege");

    // E. Restore SVP in DB
    db.prepare("UPDATE users SET jabatan = 'SVP', role = 'administrator' WHERE email = 'svp@birojasa.com'").run();

    const restoredRes = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(restoredRes.status, 200, "Restored SVP must regain access");
  });

  // TEST 3: Operational Admin does not obtain SVP privileges
  await t.test("3. Operational Admin does not obtain SVP privileges", async () => {
    // 3a. Kas Kantor Delete (SVP-only) -> 403
    const kkDelete = await fetch(`${baseUrl}/api/finance/kas-kantor/kk-1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ reason: "Admin unauthorized attempt" }),
    });
    assert.strictEqual(kkDelete.status, 403);

    // 3b. Pengeluaran Delete (SVP-only) -> 403
    const pDelete = await fetch(`${baseUrl}/api/finance/pengeluaran/p-1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ reason: "Admin unauthorized attempt" }),
    });
    assert.strictEqual(pDelete.status, 403);

    // 3c. Access Management (Hak Akses) remains strictly SVP-only -> 403 for Admin
    const hakAksesAdmin = await fetch(`${baseUrl}/api/permissions/finance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ modules: {}, stages: {} }),
    });
    assert.strictEqual(hakAksesAdmin.status, 403);

    // 3d. Admin cannot manage Order Delete / Clear Archive when Dynamic RBAC revokes order-menu / order-history
    const prevAdmin = dbPermissionRepository.getByRole("admin")!;
    dbPermissionRepository.saveRole("admin", {
      ...prevAdmin,
      modules: {
        ...prevAdmin.modules,
        "order-menu": { view: true, manage: false },
        "order-history": { view: true, manage: false },
      },
    });
    const ordDelete = await fetch(`${baseUrl}/api/orders/ORD-1126-001`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(ordDelete.status, 403);

    const clearArchive = await fetch(`${baseUrl}/api/orders/archive/clear-all`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(clearArchive.status, 403);
    dbPermissionRepository.saveRole("admin", prevAdmin);
  });

  // TEST 4: Old token cannot retain revoked module permissions
  await t.test("4. Old token cannot retain revoked module permissions", async () => {
    // Finance by default has finance-tagihan -> 200
    const finResBefore = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finResBefore.status, 200);

    // Revoke finance-tagihan from Finance in SQLite
    const finPerms = dbPermissionRepository.getByRole("finance")!;
    finPerms.modules["finance-tagihan"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("finance", finPerms);

    // Same active token immediately rejected with 403
    const finResAfter = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finResAfter.status, 403);

    // Restore
    finPerms.modules["finance-tagihan"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", finPerms);
  });

  // TEST 5: Deactivated user (status = 'Nonaktif') is immediately rejected
  await t.test("5. Deactivated user identity is rejected with 401 UNAUTHENTICATED", async () => {
    // Admin user deactivated in SQLite
    db.prepare("UPDATE users SET status = 'Nonaktif' WHERE email = 'admin@birojasa.com'").run();

    const deactRes = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(deactRes.status, 401);
    const body = await deactRes.json();
    assert.strictEqual(body.error?.code, "ACCOUNT_INACTIVE");

    // Restore
    db.prepare("UPDATE users SET status = 'Aktif' WHERE email = 'admin@birojasa.com'").run();

    const reactRes = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(reactRes.status, 200);
  });

  // TEST 6: Malformed permission object in SQLite is rejected fail-closed
  await t.test("6. Malformed permission records rejected fail-closed", async () => {
    // Insert malformed JSON into role_permissions for admin
    const malformedPayload = {
      version: 99,
      modules: {
        "buat-order": "not-an-object", // Malformed
        "order-menu": { view: "yes-truthy-string", manage: 12345 }, // Invalid types
      },
      stages: {
        stage1_verifikasi: "granted", // Invalid type
      },
    };

    db.prepare("UPDATE role_permissions SET permissions_json = ? WHERE role = 'admin'").run(
      JSON.stringify(malformedPayload)
    );

    // Admin attempts to create order -> "buat-order" malformed -> fail-closed to false -> 403
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        customer: "Malformed Tester",
        nomorHP: "081122334455",
        layanan: "Perpanjangan STNK Tahunan",
        serviceId: "svc-perp-1th",
        nopol: "B 1234 MLF",
        wilayahSamsatAsal: "Jakarta Selatan",
        metodeLayanan: "Antar Jemput",
        alamatPenjemputan: "Jl. Tes No. 1",
        biayaLayanan: 250000,
        biayaSamsat: 350000,
        totalBiaya: 600000,
      }),
    });
    assert.strictEqual(createRes.status, 403, "Malformed module permission must fail-closed to 403");

    // Restore canonical permissions
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
  });

  // TEST 7: Explicit false is never converted to permission (submodule fallback safety)
  await t.test("7. Explicit false is strictly preserved as denial (submodule fallback safety)", async () => {
    // Set finance-tagihan: true, but finance-cashback-pending: false explicitly
    const finPerms = dbPermissionRepository.getByRole("finance")!;
    finPerms.modules["finance-tagihan"] = { view: true, manage: true };
    finPerms.modules["finance-cashback-pending"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("finance", finPerms);

    // Call cashback payout endpoint
    const cbRes = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST/cashback-payout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ amount: 50000 }),
    });
    assert.strictEqual(cbRes.status, 403, "Explicit false on submodule must reject even when parent is true");

    // Restore
    finPerms.modules["finance-cashback-pending"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", finPerms);
  });

  // TEST 8: Payment Verification Endpoints Parity (/verify-payment vs /payments/:paymentId/verify)
  await t.test("8. Payment verification endpoints maintain strict parity", async () => {
    const testIdempotencyKey = crypto.randomUUID();

    // 8a. Anonymous access: both reject with 401
    const anonRes1 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId: "pay-1" }),
    });
    assert.strictEqual(anonRes1.status, 401);

    const anonRes2 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/payments/pay-1/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(anonRes2.status, 401);

    // 8b. Unauthorized role: Courier is rejected with 403 on both
    const courierRes1 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({ paymentId: "pay-1" }),
    });
    assert.strictEqual(courierRes1.status, 403);

    const courierRes2 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/payments/pay-1/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(courierRes2.status, 403);

    // 8c. Revoked permission: When finance-tagihan.manage is revoked, both reject with 403
    const finPerms = dbPermissionRepository.getByRole("finance")!;
    finPerms.modules["finance-tagihan"] = { view: true, manage: false };
    dbPermissionRepository.saveRole("finance", finPerms);

    const revokedRes1 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ paymentId: "pay-1" }),
    });
    assert.strictEqual(revokedRes1.status, 403);

    const revokedRes2 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/payments/pay-1/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(revokedRes2.status, 403);

    // Restore
    finPerms.modules["finance-tagihan"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", finPerms);

    // 8d. Missing idempotency key check: both reject with 400 MISSING_IDEMPOTENCY_KEY
    const noKeyRes1 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ paymentId: "pay-1" }),
    });
    assert.strictEqual(noKeyRes1.status, 400);
    const noKeyBody1 = await noKeyRes1.json();
    assert.strictEqual(noKeyBody1.error?.code, "MISSING_IDEMPOTENCY_KEY");

    const noKeyRes2 = await fetch(`${baseUrl}/api/finance/invoices/INV-001/payments/pay-1/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(noKeyRes2.status, 400);
    const noKeyBody2 = await noKeyRes2.json();
    assert.strictEqual(noKeyBody2.error?.code, "MISSING_IDEMPOTENCY_KEY");
  });
});
