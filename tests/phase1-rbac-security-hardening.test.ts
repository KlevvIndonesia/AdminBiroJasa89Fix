/**
 * Phase 1 Critical Security Hardening Test Suite
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Verifies all 17 Security, Privilege Escalation Defense, and Dynamic RBAC requirements:
 * 
 * Part 1: Employee Provisioning & SVP Defense
 * 1. Admin creates regular employee -> succeeds (201)
 * 2. Admin creates employee with jabatan SVP without account -> rejected (403)
 * 3. Admin creates employee with jabatan SVP with account -> rejected (403)
 * 4. Finance creates employee with jabatan SVP -> rejected (403)
 * 5. Messenger creates employee with jabatan SVP -> rejected (403)
 * 6. Admin updates employee jabatan to SVP -> rejected (403)
 * 7. SVP creates employee with jabatan SVP -> succeeds (201)
 * 8. Authorization failure does not leave partial/orphan records in DB (atomicity)
 * 
 * Part 2: User Management Dynamic RBAC
 * 9. Admin with manajemen-pengguna.view reads users -> succeeds (200)
 * 10. Admin after view revoked receives 403 on GET /api/users
 * 11. Admin with manajemen-pengguna.manage performs mutations -> succeeds (201/200)
 * 12. Admin after manage revoked receives 403 on mutations
 * 13. Finance cannot perform mutations on /api/users (403)
 * 14. Messenger cannot perform mutations on /api/users (403)
 * 15. Unauthenticated request to /api/users receives 401
 * 16. Self-access policy remains valid: courier reads own profile, blocked from other profiles
 * 17. SVP universal bypass: SVP retains full access regardless of role permissions
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";

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

test("PHASE 1: CRITICAL DYNAMIC RBAC SECURITY HARDENING SUITE", async (t) => {
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

  // ───────────────────────────────────────────────────────────────────────────
  // Part 1: Employee Provisioning & SVP Defense
  // ───────────────────────────────────────────────────────────────────────────

  // 1. Admin creates regular employee -> succeeds (201)
  await t.test("1. Admin creates regular employee -> succeeds (201)", async () => {
    const nik = "3201010101010001";
    const res = await fetch(`${baseUrl}/api/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        nik_ktp: nik,
        nama_lengkap: "Karyawan Biasa",
        jabatan: "Staff Operasional",
        gaji_pokok: 4500000,
        status_karyawan: "TETAP",
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data?.nama_lengkap, "Karyawan Biasa");
  });

  // 2. Admin creates employee with jabatan SVP without account -> rejected (403)
  await t.test("2. Admin creates employee with jabatan SVP without account -> rejected (403)", async () => {
    const nik = "3201010101010002";
    const res = await fetch(`${baseUrl}/api/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        nik_ktp: nik,
        nama_lengkap: "Fake SVP Employee",
        jabatan: "SVP",
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error?.message, /SVP/i);

    // Verify employee was NOT created
    const count = db.prepare("SELECT COUNT(*) as c FROM employees WHERE nik_ktp = ?").get(nik) as { c: number };
    assert.strictEqual(count.c, 0);
  });

  // 3. Admin creates employee with jabatan SVP with account -> rejected (403)
  await t.test("3. Admin creates employee with jabatan SVP with account -> rejected (403)", async () => {
    const nik = "3201010101010003";
    const email = "fake.svp@birojasa.com";
    const res = await fetch(`${baseUrl}/api/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        nik_ktp: nik,
        nama_lengkap: "Escalation Target",
        jabatan: "SVP",
        createAccount: true,
        email,
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.success, false);

    // Verify neither employee NOR user was created in SQLite
    const empCount = db.prepare("SELECT COUNT(*) as c FROM employees WHERE nik_ktp = ?").get(nik) as { c: number };
    assert.strictEqual(empCount.c, 0);

    const userCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE email = ?").get(email) as { c: number };
    assert.strictEqual(userCount.c, 0);
  });

  // 4. Finance creates employee with jabatan SVP -> rejected (403)
  await t.test("4. Finance creates employee with jabatan SVP -> rejected (403)", async () => {
    const nik = "3201010101010004";
    const res = await fetch(`${baseUrl}/api/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${financeAuth.token}`,
      },
      body: JSON.stringify({
        nik_ktp: nik,
        nama_lengkap: "Finance Attempted SVP",
        jabatan: "SVP",
      }),
    });
    assert.strictEqual(res.status, 403);
  });

  // 5. Messenger creates employee with jabatan SVP -> rejected (403)
  await t.test("5. Messenger creates employee with jabatan SVP -> rejected (403)", async () => {
    const nik = "3201010101010005";
    const res = await fetch(`${baseUrl}/api/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${courierAuth.token}`,
      },
      body: JSON.stringify({
        nik_ktp: nik,
        nama_lengkap: "Courier Attempted SVP",
        jabatan: "SVP",
      }),
    });
    assert.strictEqual(res.status, 403);
  });

  // 6. Admin updates employee jabatan to SVP -> rejected (403)
  await t.test("6. Admin updates employee jabatan to SVP -> rejected (403)", async () => {
    // First, find an existing regular employee
    const existingEmp = db.prepare("SELECT id FROM employees WHERE jabatan != 'SVP' LIMIT 1").get() as { id: string };
    assert.ok(existingEmp);

    const res = await fetch(`${baseUrl}/api/employees/${existingEmp.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        jabatan: "SVP",
      }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error?.message, /SVP/i);
  });

  // 7. SVP creates employee with jabatan SVP -> succeeds (201)
  await t.test("7. SVP creates employee with jabatan SVP -> succeeds (201)", async () => {
    const nik = "3201010101010007";
    const res = await fetch(`${baseUrl}/api/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
      },
      body: JSON.stringify({
        nik_ktp: nik,
        nama_lengkap: "Official Deputy SVP",
        jabatan: "SVP",
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.data?.jabatan, "SVP");
  });

  // 8. Authorization failure does not leave partial/orphan records in DB (atomicity)
  await t.test("8. Authorization failure does not leave partial/orphan records in DB (atomicity)", async () => {
    const nik = "3201010101010008";
    const email = "atomic.test@birojasa.com";

    // Attempt creation with unauthorized role 'administrator'
    const res = await fetch(`${baseUrl}/api/employees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        nik_ktp: nik,
        nama_lengkap: "Atomic Test Karyawan",
        jabatan: "Staff",
        role: "administrator",
        createAccount: true,
        email,
      }),
    });
    assert.strictEqual(res.status, 403);

    // Atomicity assertion: employee MUST NOT exist in DB because transaction rolled back
    const emp = db.prepare("SELECT * FROM employees WHERE nik_ktp = ?").get(nik);
    assert.strictEqual(emp, undefined);

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    assert.strictEqual(user, undefined);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Part 2: User Management Dynamic RBAC
  // ───────────────────────────────────────────────────────────────────────────

  // 9. Admin with manajemen-pengguna.view reads users -> succeeds (200)
  await t.test("9. Admin with manajemen-pengguna.view reads users -> succeeds (200)", async () => {
    // Ensure permission is active
    dbPermissionRepository.updateRoleTransactional("admin", {
      modules: { "manajemen-pengguna": { view: true, manage: true } },
    }, "Test Setup");

    const res = await fetch(`${baseUrl}/api/users`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.data));
  });

  // 10. Admin after view revoked receives 403 on GET /api/users
  await t.test("10. Admin after view revoked receives 403 on GET /api/users", async () => {
    // Revoke view permission
    dbPermissionRepository.updateRoleTransactional("admin", {
      modules: { "manajemen-pengguna": { view: false, manage: false } },
    }, "Test Revoke");

    const res = await fetch(`${baseUrl}/api/users`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error?.code, "FORBIDDEN");
    assert.match(body.error?.message, /manajemen-pengguna/i);
  });

  // 11. Admin with manajemen-pengguna.manage performs mutations -> succeeds (201/200)
  await t.test("11. Admin with manajemen-pengguna.manage performs mutations -> succeeds (201/200)", async () => {
    // Restore permission
    dbPermissionRepository.updateRoleTransactional("admin", {
      modules: { "manajemen-pengguna": { view: true, manage: true } },
    }, "Test Restore");

    const email = `test.user.${Date.now()}@birojasa.com`;
    const createRes = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        nama: "Test Dynamic User",
        email,
        jabatan: "ADMIN",
        status: "Aktif",
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const createdBody = await createRes.json();
    const createdId = createdBody.data.id;

    // Update user
    const updateRes = await fetch(`${baseUrl}/api/users/${createdId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        nama: "Updated Dynamic User",
      }),
    });
    assert.strictEqual(updateRes.status, 200);

    // Reset password
    const resetRes = await fetch(`${baseUrl}/api/users/${createdId}/reset-password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(resetRes.status, 200);
  });

  // 12. Admin after manage revoked receives 403 on mutations
  await t.test("12. Admin after manage revoked receives 403 on mutations", async () => {
    // Grant view only, revoke manage
    dbPermissionRepository.updateRoleTransactional("admin", {
      modules: { "manajemen-pengguna": { view: true, manage: false } },
    }, "Test Revoke Manage");

    // Mutation 1: Create
    const createRes = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminAuth.token}`,
      },
      body: JSON.stringify({
        nama: "Should Fail",
        email: "fail@birojasa.com",
        jabatan: "ADMIN",
      }),
    });
    assert.strictEqual(createRes.status, 403);
    const bodyCreate = await createRes.json();
    assert.match(bodyCreate.error?.message, /manajemen-pengguna/i);

    // Mutation 2: Delete
    const deleteRes = await fetch(`${baseUrl}/api/users/999`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(deleteRes.status, 403);

    // Mutation 3: Reset password
    const resetRes = await fetch(`${baseUrl}/api/users/999/reset-password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(resetRes.status, 403);
  });

  // 13. Finance cannot perform mutations on /api/users (403)
  await t.test("13. Finance cannot perform mutations on /api/users (403)", async () => {
    const res = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${financeAuth.token}`,
      },
      body: JSON.stringify({
        nama: "Finance Created",
        email: "finance.fail@birojasa.com",
        jabatan: "ADMIN",
      }),
    });
    assert.strictEqual(res.status, 403);
  });

  // 14. Messenger cannot perform mutations on /api/users (403)
  await t.test("14. Messenger cannot perform mutations on /api/users (403)", async () => {
    const res = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${courierAuth.token}`,
      },
      body: JSON.stringify({
        nama: "Messenger Created",
        email: "messenger.fail@birojasa.com",
        jabatan: "ADMIN",
      }),
    });
    assert.strictEqual(res.status, 403);
  });

  // 15. Unauthenticated request to /api/users receives 401
  await t.test("15. Unauthenticated request to /api/users receives 401", async () => {
    const res = await fetch(`${baseUrl}/api/users`);
    assert.strictEqual(res.status, 401);
  });

  // 16. Self-access policy remains valid: courier reads own profile, blocked from other profiles
  await t.test("16. Self-access policy remains valid: courier reads own profile, blocked from other profiles", async () => {
    const myId = courierAuth.user.id;
    // Courier reads own profile
    const selfRes = await fetch(`${baseUrl}/api/users/${myId}`, {
      headers: { Authorization: `Bearer ${courierAuth.token}` },
    });
    assert.strictEqual(selfRes.status, 200);
    const selfBody = await selfRes.json();
    assert.strictEqual(selfBody.data?.id, myId);

    // Courier attempts to read another user's profile (e.g. SVP id 1)
    const otherRes = await fetch(`${baseUrl}/api/users/1`, {
      headers: { Authorization: `Bearer ${courierAuth.token}` },
    });
    assert.strictEqual(otherRes.status, 403);
  });

  // 17. SVP universal bypass: SVP retains full access regardless of role permissions
  await t.test("17. SVP universal bypass: SVP retains full access regardless of role permissions", async () => {
    const res = await fetch(`${baseUrl}/api/users`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
  });
});
