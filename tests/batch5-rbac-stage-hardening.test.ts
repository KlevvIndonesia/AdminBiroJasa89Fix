/**
 * SUN89 — BATCH 5: DYNAMIC RBAC HARDENING, FAIL-CLOSED STAGE AUTHORIZATION & EXPLICIT ZERO PROFIT REGRESSION SUITE
 *
 * Covers:
 * - Workstream 1 (F-B5-01): Dynamic RBAC enforcement (`requirePermission`) on all 10 routes in `messengerRoutes.ts`
 * - Workstream 2 (F-B5-02): Strict fail-closed Stage authorization in `requireStageAuthority` (`auth.ts`)
 *   and `validateAndNormalizeRolePermissions` (`dbPermissionRepository.ts`) across all 7 stage cases
 * - Phase 2 Regression: `calculateCanonicalInvoiceTotals` explicit zero Samsat cost vs explicit zero promotional invoice
 */

import "./setup-test-portal-shim";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { db } from "../server/src/database/db";
import { createApp } from "../server/src/app";
import { hashPassword } from "../server/src/utils/crypto";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { orderService } from "../server/src/services/orderService";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { CANONICAL_PERMISSIONS } from "../server/src/config/defaultPermissions";
import { calculateCanonicalInvoiceTotals } from "../server/src/services/canonicalInvoiceCalculator";

function startTestServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = createApp();
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function loginHttp(baseUrl: string, email: string, password: string): Promise<{ token: string; user: any }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, `Expected 200 login for ${email}, got ${res.status}: ${JSON.stringify(body)}`);
  return { token: body.data.token, user: body.data.user };
}

async function apiRequest(
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(extraHeaders || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function resetRolePermissionsToCanonical() {
  for (const role of ["administrator", "admin", "finance", "messenger"] as const) {
    const canonical = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS[role]));
    db.prepare(
      "INSERT OR REPLACE INTO role_permissions (role, permissions_json, updated_at, updated_by) VALUES (?, ?, datetime('now'), 'test-setup')"
    ).run(role, JSON.stringify({ version: 1, modules: canonical.modules, stages: canonical.stages }));
  }
}

test("SUN89 BATCH 5: Dynamic RBAC Hardening & Fail-Closed Stage Authorization Suite", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => {
    resetRolePermissionsToCanonical();
    server.close();
  });

  // Seed canonical employees, messengers & users for HTTP RBAC tests
  const insertEmp = db.prepare(`
    INSERT OR IGNORE INTO employees (id, nik_ktp, nama_lengkap, no_hp, tgl_lahir, wilayah, alamat_domisili, jabatan)
    VALUES (?, ?, ?, ?, '1992-01-01', 'Jakarta Selatan', 'Jl. Sudirman No. 1', ?)
  `);
  insertEmp.run("emp-b5-500", "3174000000000500", "Batch5 SVP", "081200000500", "SVP");
  insertEmp.run("emp-b5-501", "3174000000000501", "Batch5 Finance", "081200000501", "FINANCE");
  insertEmp.run("emp-b5-502", "3174000000000502", "Batch5 Admin", "081200000502", "ADMIN");
  insertEmp.run("emp-b5-503", "3174000000000503", "Budi Batch5", "081200000503", "MESSENGER");

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messengers (id, employee_id, plat_motor_operasional, wilayah_tugas_utama, status_tugas)
    VALUES (?, ?, ?, 'Jakarta Selatan', 'STANDBY')
  `);
  insertMsg.run("msg-b5-503", "emp-b5-503", "B 503 B5");

  const pass = hashPassword("Batch5Pass123!");
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, email, password_hash, password_salt, nama, jabatan, role, employee_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Aktif')
  `);
  insertUser.run(500, "b5-svp@sun89.test", pass.hash, pass.salt, "Batch5 SVP", "SVP", "administrator", "emp-b5-500");
  insertUser.run(501, "b5-finance@sun89.test", pass.hash, pass.salt, "Batch5 Finance", "FINANCE", "finance", "emp-b5-501");
  insertUser.run(502, "b5-admin@sun89.test", pass.hash, pass.salt, "Batch5 Admin", "ADMIN", "admin", "emp-b5-502");
  insertUser.run(503, "b5-messenger@sun89.test", pass.hash, pass.salt, "Budi Batch5", "MESSENGER", "messenger", "emp-b5-503");

  const { token: svpToken } = await loginHttp(baseUrl, "b5-svp@sun89.test", "Batch5Pass123!");
  const { token: financeToken } = await loginHttp(baseUrl, "b5-finance@sun89.test", "Batch5Pass123!");
  const { token: adminToken } = await loginHttp(baseUrl, "b5-admin@sun89.test", "Batch5Pass123!");
  const { token: messengerToken } = await loginHttp(baseUrl, "b5-messenger@sun89.test", "Batch5Pass123!");

  const adminActor = {
    userId: "usr-502",
    id: 502,
    nama: "Batch5 Admin",
    role: "admin" as const,
  };

  resetRolePermissionsToCanonical();
  const testOrder = orderService.createOrder(
    {
      customer: "PT Batch 5 Messenger Task",
      nomorHP: "081200005555",
      layanan: "Perpanjangan 1 Tahun",
      serviceId: "svc-perp-1th",
      nopol: "B 5001 B5M",
      messenger: "Budi Batch5",
      assignedMessengerId: "emp-b5-503",
      assignedMessengerName: "Budi Batch5",
      biayaJasa: 250000,
      biayaAntarJemput: 50000,
      pkb: 500000,
      swdkllj: 143000,
      biayaSamsat: 643000,
      totalEstimasi: 943000,
      isCostVerified: true,
      costCompletenessStatus: "COMPLETE",
      costSnapshot: {
        totalEstimasi: 943000,
        biayaJasa: 250000,
        biayaSamsat: 643000,
        biayaAntarJemput: 50000,
        completenessStatus: "COMPLETE",
      },
    } as any,
    adminActor
  );
  // Ensure assignedMessengerId is persisted on raw order JSON so messenger task detail BOLA check passes for Budi Batch5
  const persistedTestOrder = dbOrderRepository.getByOrderNo(testOrder.orderNo)!;
  dbOrderRepository.saveOrder({
    ...persistedTestOrder,
    messenger: "Budi Batch5",
    assignedMessengerId: "emp-b5-503",
    assignedMessengerName: "Budi Batch5",
  } as any);

  // =========================================================================
  // WORKSTREAM 1 (F-B5-01): MESSENGER DYNAMIC RBAC ENFORCEMENT
  // =========================================================================

  await t.test("F-B5-01.1: Legitimate operations succeed across all 10 messenger routes when dynamic permissions are granted", async () => {
    resetRolePermissionsToCanonical();

    // 0. GET /api/messenger/my-tasks (messenger, admin)
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/my-tasks", messengerToken)).status, 200);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/my-tasks", adminToken)).status, 200);

    // 1. GET /api/messenger/messengers (messenger, finance, admin, administrator)
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/messengers", messengerToken)).status, 200);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/messengers", financeToken)).status, 200);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/messengers", adminToken)).status, 200);

    // 2. GET /api/messenger/history (messenger, finance, admin)
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/history", messengerToken)).status, 200);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/history", financeToken)).status, 200);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/history", adminToken)).status, 200);

    // 3. GET /api/messenger/tasks/:orderNo (messenger assigned, finance, admin)
    assert.strictEqual(
      (await apiRequest(baseUrl, "GET", `/api/messenger/tasks/${testOrder.orderNo}`, messengerToken)).status,
      200
    );
    assert.strictEqual(
      (await apiRequest(baseUrl, "GET", `/api/messenger/tasks/${testOrder.orderNo}`, financeToken)).status,
      200
    );
    assert.strictEqual(
      (await apiRequest(baseUrl, "GET", `/api/messenger/tasks/${testOrder.orderNo}`, adminToken)).status,
      200
    );

    // 4. GET /api/messenger/reimbursements (messenger, finance, admin)
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/reimbursements", messengerToken)).status, 200);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/reimbursements", financeToken)).status, 200);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/reimbursements", adminToken)).status, 200);

    // 5. POST /api/messenger/reimbursements (messenger creates reimbursement #1)
    const createReimb1 = await apiRequest(baseUrl, "POST", "/api/messenger/reimbursements", messengerToken, {
      date: "2026-11-15",
      category: "BBM",
      notes: "BBM jemput berkas B5-1",
      amount: 35000,
      orderNo: testOrder.orderNo,
    });
    assert.strictEqual(createReimb1.status, 201, `Expected 201 on createReimbursement, got ${createReimb1.status}: ${JSON.stringify(createReimb1.data)}`);
    const reimb1Id = createReimb1.data.data.id;
    assert.ok(reimb1Id);

    // 6. PATCH /api/messenger/reimbursements/:id/review (finance approves reimbursement #1)
    const reviewReimb1 = await apiRequest(
      baseUrl,
      "PATCH",
      `/api/messenger/reimbursements/${reimb1Id}/review`,
      financeToken,
      {
        decision: "APPROVED",
        approvedAmount: 35000,
        reviewNotes: "Disetujui penuh oleh Finance",
      }
    );
    assert.strictEqual(reviewReimb1.status, 200, `Expected 200 on reviewReimbursement, got ${reviewReimb1.status}: ${JSON.stringify(reviewReimb1.data)}`);

    // 7. POST /api/messenger/reimbursements/:id/pay (finance pays reimbursement #1)
    const payReimb1 = await apiRequest(
      baseUrl,
      "POST",
      `/api/messenger/reimbursements/${reimb1Id}/pay`,
      financeToken,
      {
        amount: 35000,
        paymentMethod: "Tunai",
        transactionRef: "REF-B5-PAY-1",
      }
    );
    assert.strictEqual(payReimb1.status, 200, `Expected 200 on payReimbursement, got ${payReimb1.status}: ${JSON.stringify(payReimb1.data)}`);

    // 8. POST /api/messenger/reimbursements/:id/void (SVP/administrator voids paid reimbursement #1)
    const voidReimb1 = await apiRequest(
      baseUrl,
      "POST",
      `/api/messenger/reimbursements/${reimb1Id}/void`,
      svpToken,
      {
        voidReason: "Koreksi pengujian Batch 5 void reimbursement",
      }
    );
    assert.strictEqual(voidReimb1.status, 200, `Expected 200 on voidReimbursement, got ${voidReimb1.status}: ${JSON.stringify(voidReimb1.data)}`);

    // 9. DELETE /api/messenger/reimbursements/:id (create reimbursement #2, reject it, then SVP permanently deletes it)
    const createReimb2 = await apiRequest(baseUrl, "POST", "/api/messenger/reimbursements", messengerToken, {
      date: "2026-11-15",
      category: "Parkir & Tol",
      notes: "Parkir Samsat B5-2",
      amount: 15000,
      orderNo: testOrder.orderNo,
    });
    assert.strictEqual(createReimb2.status, 201);
    const reimb2Id = createReimb2.data.data.id;

    const rejectReimb2 = await apiRequest(
      baseUrl,
      "PATCH",
      `/api/messenger/reimbursements/${reimb2Id}/review`,
      financeToken,
      {
        decision: "REJECTED",
        reviewNotes: "Ditolak untuk pengujian delete reimbursement Batch 5",
      }
    );
    assert.strictEqual(rejectReimb2.status, 200);

    const deleteReimb2 = await apiRequest(
      baseUrl,
      "DELETE",
      `/api/messenger/reimbursements/${reimb2Id}`,
      svpToken,
      {
        reason: "Input duplikat pengujian Batch 5 untuk penghapusan permanen",
      },
      { "x-idempotency-key": crypto.randomUUID() }
    );
    assert.strictEqual(deleteReimb2.status, 200, `Expected 200 on deleteReimbursement, got ${deleteReimb2.status}: ${JSON.stringify(deleteReimb2.data)}`);
  });

  await t.test("F-B5-01.2: Revoking dynamic permissions in role_permissions immediately blocks corresponding messenger routes with 403 FORBIDDEN", async () => {
    resetRolePermissionsToCanonical();

    // Seed an unpaid reimbursement for review/pay/void/delete permission revocation tests
    const seedReimb = await apiRequest(baseUrl, "POST", "/api/messenger/reimbursements", messengerToken, {
      date: "2026-11-15",
      category: "Parkir & Tol",
      notes: "Tol dalam kota B5 RBAC test",
      amount: 25000,
      orderNo: testOrder.orderNo,
    });
    assert.strictEqual(seedReimb.status, 201);
    const targetReimbId = seedReimb.data.data.id;

    // A. Revoke messenger-task and messenger-history from 'messenger' role
    const messengerPerms = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.messenger));
    messengerPerms.modules["messenger-task"] = { view: false, manage: false };
    messengerPerms.modules["messenger-history"] = { view: false, manage: false };
    dbPermissionRepository.updateRoleTransactional("messenger", messengerPerms, "svp-test");

    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/my-tasks", messengerToken)).status, 403);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/messengers", messengerToken)).status, 403);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/history", messengerToken)).status, 403);
    assert.strictEqual(
      (await apiRequest(baseUrl, "GET", `/api/messenger/tasks/${testOrder.orderNo}`, messengerToken)).status,
      403
    );
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/reimbursements", messengerToken)).status, 403);
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "POST", "/api/messenger/reimbursements", messengerToken, {
          date: "2026-11-15",
          category: "BBM",
          notes: "Harus ditolak 403",
          amount: 20000,
        })
      ).status,
      403
    );

    // B. Revoke finance-kas-messenger and messenger-history from 'finance' role
    const financePerms = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance));
    financePerms.modules["finance-kas-messenger"] = { view: false, manage: false };
    financePerms.modules["messenger-history"] = { view: false, manage: false };
    dbPermissionRepository.updateRoleTransactional("finance", financePerms, "svp-test");

    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/messengers", financeToken)).status, 403);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/history", financeToken)).status, 403);
    assert.strictEqual(
      (await apiRequest(baseUrl, "GET", `/api/messenger/tasks/${testOrder.orderNo}`, financeToken)).status,
      403
    );
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/reimbursements", financeToken)).status, 403);
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "PATCH", `/api/messenger/reimbursements/${targetReimbId}/review`, financeToken, {
          decision: "APPROVED",
          approvedAmount: 25000,
        })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "POST", `/api/messenger/reimbursements/${targetReimbId}/pay`, financeToken, {
          amount: 25000,
          paymentMethod: "Tunai",
        })
      ).status,
      403
    );

    // C. Revoke finance-kas-messenger and messenger-task from 'admin' role -> blocks create, review, pay, my-tasks, reimbursements
    const adminPerms = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin));
    adminPerms.modules["finance-kas-messenger"] = { view: false, manage: false };
    adminPerms.modules["messenger-task"] = { view: false, manage: false };
    dbPermissionRepository.updateRoleTransactional("admin", adminPerms, "svp-test");

    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/my-tasks", adminToken)).status, 403);
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/reimbursements", adminToken)).status, 403);
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "POST", "/api/messenger/reimbursements", adminToken, {
          employeeId: "emp-b5-503",
          messengerName: "Budi Batch5",
          date: "2026-11-15",
          category: "BBM",
          notes: "Harus ditolak 403",
          amount: 20000,
        })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "PATCH", `/api/messenger/reimbursements/${targetReimbId}/review`, adminToken, {
          decision: "APPROVED",
          approvedAmount: 25000,
        })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "POST", `/api/messenger/reimbursements/${targetReimbId}/pay`, adminToken, {
          amount: 25000,
          paymentMethod: "Tunai",
        })
      ).status,
      403
    );

    // D. Static role restrictions remain enforced when permissions are restored
    resetRolePermissionsToCanonical();
    assert.strictEqual((await apiRequest(baseUrl, "GET", "/api/messenger/my-tasks", financeToken)).status, 403);
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "PATCH", `/api/messenger/reimbursements/${targetReimbId}/review`, messengerToken, {
          decision: "APPROVED",
        })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "POST", `/api/messenger/reimbursements/${targetReimbId}/void`, financeToken, {
          voidReason: "Finance tidak boleh void reimbursement",
        })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "POST", `/api/messenger/reimbursements/${targetReimbId}/void`, adminToken, {
          voidReason: "Admin biasa tidak boleh void reimbursement",
        })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "DELETE", `/api/messenger/reimbursements/${targetReimbId}`, financeToken, {
          reason: "Finance tidak boleh hapus reimbursement",
        })
      ).status,
      403
    );
    assert.strictEqual(
      (
        await apiRequest(baseUrl, "DELETE", `/api/messenger/reimbursements/${targetReimbId}`, adminToken, {
          reason: "Admin biasa tidak boleh hapus permanen reimbursement",
        })
      ).status,
      403
    );
  });

  // =========================================================================
  // WORKSTREAM 2 (F-B5-02): STRICT FAIL-CLOSED STAGE AUTHORIZATION
  // =========================================================================

  await t.test("F-B5-02: requireStageAuthority and validateAndNormalizeRolePermissions enforce strict fail-closed boolean===true across all 7 stage cases", async () => {
    resetRolePermissionsToCanonical();

    const stageOrder = orderService.createOrder(
      {
        customer: "PT Batch 5 Stage Auth",
        nomorHP: "081200006666",
        layanan: "Perpanjangan 1 Tahun",
        serviceId: "svc-perp-1th",
        nopol: "B 5002 STG",
        biayaJasa: 250000,
        biayaAntarJemput: 50000,
        pkb: 500000,
        swdkllj: 143000,
        biayaSamsat: 643000,
        totalEstimasi: 943000,
      },
      adminActor
    );
    assert.strictEqual(stageOrder.currentStep, 1);

    // Case 1: Missing current stage permission (stage1_verifikasi omitted/undefined in stored JSON) -> 403 FORBIDDEN
    const rawMissingCurrent = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin));
    delete rawMissingCurrent.stages.stage1_verifikasi;
    db.prepare("UPDATE role_permissions SET permissions_json = ? WHERE role = 'admin'").run(
      JSON.stringify(rawMissingCurrent)
    );
    const normalizedMissingCurrent = dbPermissionRepository.getByRole("admin")!;
    assert.strictEqual(
      normalizedMissingCurrent.stages.stage1_verifikasi,
      false,
      "Missing stage key in DB JSON must normalize to false (fail-closed), never true"
    );
    const resCase1 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, adminToken, {
      targetStage: "Penjadwalan",
      updates: { isVerified: true },
    });
    assert.strictEqual(resCase1.status, 403, "Case 1: Missing current stage permission must be rejected with 403");

    // Case 2: Missing target stage permission (stage2_penjadwalan omitted/undefined in stored JSON) -> 403 FORBIDDEN
    const rawMissingTarget = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin));
    delete rawMissingTarget.stages.stage2_penjadwalan;
    db.prepare("UPDATE role_permissions SET permissions_json = ? WHERE role = 'admin'").run(
      JSON.stringify(rawMissingTarget)
    );
    const normalizedMissingTarget = dbPermissionRepository.getByRole("admin")!;
    assert.strictEqual(
      normalizedMissingTarget.stages.stage2_penjadwalan,
      false,
      "Missing target stage key in DB JSON must normalize to false (fail-closed)"
    );
    const resCase2 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, adminToken, {
      targetStage: "Penjadwalan",
      updates: { isVerified: true },
    });
    assert.strictEqual(resCase2.status, 403, "Case 2: Missing target stage permission must be rejected with 403");

    // Case 3: Empty stages object (stages: {}) -> 403 FORBIDDEN
    const rawEmptyStages = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin));
    rawEmptyStages.stages = {};
    db.prepare("UPDATE role_permissions SET permissions_json = ? WHERE role = 'admin'").run(
      JSON.stringify(rawEmptyStages)
    );
    const resCase3 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, adminToken, {
      targetStage: "Penjadwalan",
      updates: { isVerified: true },
    });
    assert.strictEqual(resCase3.status, 403, "Case 3: Empty stages object must be rejected with 403");

    // Case 4: Explicit false on current or target stage -> 403 FORBIDDEN
    const rawFalseTarget = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin));
    rawFalseTarget.stages.stage1_verifikasi = true;
    rawFalseTarget.stages.stage2_penjadwalan = false;
    db.prepare("UPDATE role_permissions SET permissions_json = ? WHERE role = 'admin'").run(
      JSON.stringify(rawFalseTarget)
    );
    const resCase4 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, adminToken, {
      targetStage: "Penjadwalan",
      updates: { isVerified: true },
    });
    assert.strictEqual(resCase4.status, 403, "Case 4: Explicit false target stage must be rejected with 403");

    // Case 5: Explicit true on both current (Stage 1) and target (Stage 2) -> 200 OK
    resetRolePermissionsToCanonical();
    const resCase5 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, adminToken, {
      targetStage: "Penjadwalan",
      updates: {
        isVerified: true,
        tanggalJemput: "2026-11-16",
        messenger: "Budi Batch5",
        assignedMessengerName: "Budi Batch5",
        assignedMessengerId: "emp-b5-503",
      },
    });
    assert.strictEqual(resCase5.status, 200, `Case 5: Explicit true stage permissions must succeed (got ${resCase5.status}: ${JSON.stringify(resCase5.data)})`);
    assert.strictEqual(resCase5.data.data.currentStep, 2);

    // Case 6 & Case 7: Legitimate Stage 5 -> Stage 6 submission by admin, and Stage 6 administrator-only access
    const preStage5Order = dbOrderRepository.getByOrderNo(stageOrder.orderNo)!;
    dbOrderRepository.saveOrder({
      ...preStage5Order,
      currentStep: 5,
      currentStageName: "Verifikasi Ulang",
      isVerified: true,
      pickupCompleted: true,
      documentsVerified: true,
      samsatStatus: "Selesai",
      samsatPickupStatus: "Dokumen Samsat Diterima di Kantor",
      isCostVerified: true,
      costCompletenessStatus: "COMPLETE",
      documentApproval: {
        ...(preStage5Order.documentApproval || {}),
        stage5Verified: true,
      },
      samsatProcesses: (preStage5Order.samsatProcesses || []).map((p: any) => ({
        ...p,
        status: "COMPLETED",
        isCompleted: true,
        actualCost: p.basePrice || 100000,
      })),
    } as any);

    // Admin with stage5_verifikasiUlang === true can submit Stage 5 -> Stage 6 (Supervisi)
    const resStage5To6 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, adminToken, {
      targetStage: "Supervisi",
      updates: {
        finalCost: 943000,
        biayaSamsat: 643000,
        biayaJasa: 250000,
        documentsVerified: true,
        documentApproval: {
          stage5Verified: true,
          stage5VerifiedBy: "Batch5 Admin",
          stage5VerifiedAt: new Date().toISOString(),
        },
      },
    });
    assert.strictEqual(resStage5To6.status, 200, `Case 7: Admin with stage5_verifikasiUlang === true can submit to Stage 6 (got ${resStage5To6.status}: ${JSON.stringify(resStage5To6.data)})`);
    assert.strictEqual(resStage5To6.data.data.currentStep, 6);

    // At Stage 6, even if stage6_supervisi: true is injected into admin's DB row, admin is strictly denied 403
    const tamperedAdmin = JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin));
    tamperedAdmin.stages.stage6_supervisi = true;
    db.prepare("UPDATE role_permissions SET permissions_json = ? WHERE role = 'admin'").run(
      JSON.stringify(tamperedAdmin)
    );
    const resAdminAtStage6 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, adminToken, {
      targetStage: "Pengantaran",
      updates: { approvedBySpv: true },
    });
    assert.strictEqual(resAdminAtStage6.status, 403, "Case 6: Non-administrator must be denied 403 at Stage 6");

    const resFinanceAtStage6 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, financeToken, {
      targetStage: "Pengantaran",
      updates: { approvedBySpv: true },
    });
    assert.strictEqual(resFinanceAtStage6.status, 403, "Case 6: Finance must be denied 403 at Stage 6");

    // Administrator (SVP) succeeds at Stage 6 -> Stage 7
    const resSvpAtStage6 = await apiRequest(baseUrl, "POST", `/api/orders/${stageOrder.orderNo}/advance`, svpToken, {
      targetStage: "Pengantaran",
      updates: {
        approvedBySpv: true,
        tanggalPengantaran: "2026-11-17",
        messengerPengantar: "Budi Batch5",
        deliveryMessengerId: "emp-b5-503",
        deliveryMessengerName: "Budi Batch5",
      },
    });
    assert.strictEqual(resSvpAtStage6.status, 200, `Case 6: Administrator (SVP) must succeed at Stage 6 (got ${resSvpAtStage6.status}: ${JSON.stringify(resSvpAtStage6.data)})`);
    assert.strictEqual(resSvpAtStage6.data.data.currentStep, 7);
  });

  // =========================================================================
  // PHASE 2 REGRESSION: EXPLICIT ZERO SAMSAT COST VS EXPLICIT ZERO PROMO INVOICE
  // =========================================================================

  await t.test("Phase 2 Regression: calculateCanonicalInvoiceTotals preserves revenue on explicit zero Samsat cost while keeping Rp 0 promo revenue at 0", () => {
    const paidServiceZeroSamsat = calculateCanonicalInvoiceTotals({
      invoiceNo: "INV-B5-ZERO-SAMSAT",
      orderNo: "ORD-B5-ZERO-SAMSAT",
      totalTagihan: 250000,
      biayaSamsat: 0,
      isExplicitZero: true,
      payments: [
        {
          invoice_no: "INV-B5-ZERO-SAMSAT",
          order_no: "ORD-B5-ZERO-SAMSAT",
          nominal: 250000,
          status_verifikasi: "TERVERIFIKASI",
          is_void: 0,
        },
      ],
    });
    assert.strictEqual(paidServiceZeroSamsat.status, "PAID");
    assert.strictEqual(paidServiceZeroSamsat.recognizedRevenue, 250000);
    assert.strictEqual(paidServiceZeroSamsat.matchedCOGS, 0);
    assert.strictEqual(paidServiceZeroSamsat.grossProfit, 250000);

    const promoZeroInvoice = calculateCanonicalInvoiceTotals({
      invoiceNo: "INV-B5-PROMO-ZERO",
      orderNo: "ORD-B5-PROMO-ZERO",
      totalTagihan: 0,
      biayaSamsat: 0,
      isExplicitZero: true,
      payments: [],
    });
    assert.strictEqual(promoZeroInvoice.status, "PAID");
    assert.strictEqual(promoZeroInvoice.recognizedRevenue, 0);
    assert.strictEqual(promoZeroInvoice.grossProfit, 0);
  });

  // =========================================================================
  // AUD-F01: PUT /api/permissions/:role PARTIAL UPDATE PRESERVES OMITTED STAGES
  // =========================================================================

  await t.test("AUD-F01: PUT /api/permissions/admin supports module-only, partial-stage, and full-stage updates without wiping omitted stages", async () => {
    resetRolePermissionsToCanonical();

    // 1. Module-only update (stages omitted) must preserve all existing stages 1-5 & 7-8 = true
    const modOnlyRes = await apiRequest(baseUrl, "PUT", "/api/permissions/admin", svpToken, {
      modules: { dashboard: { view: true, manage: false } },
    });
    assert.strictEqual(modOnlyRes.status, 200, `Module-only update failed: ${JSON.stringify(modOnlyRes.data)}`);
    assert.strictEqual(modOnlyRes.data.data.stages.stage1_verifikasi, true);
    assert.strictEqual(modOnlyRes.data.data.stages.stage2_penjadwalan, true);
    assert.strictEqual(modOnlyRes.data.data.stages.stage3_verifikasiFisik, true);
    assert.strictEqual(modOnlyRes.data.data.stages.stage4_prosesSamsat, true);
    assert.strictEqual(modOnlyRes.data.data.stages.stage5_verifikasiUlang, true);
    assert.strictEqual(modOnlyRes.data.data.stages.stage6_supervisi, false);
    assert.strictEqual(modOnlyRes.data.data.stages.stage7_pengantaran, true);
    assert.strictEqual(modOnlyRes.data.data.stages.stage8_diterima, true);
    assert.strictEqual(modOnlyRes.data.data.modules["finance-kas-messenger"].manage, true, "Untouched module permission must be preserved");

    // 2. Partial-stage update (only stage3_verifikasiFisik: false) must preserve other stages
    const partialStageRes = await apiRequest(baseUrl, "PUT", "/api/permissions/admin", svpToken, {
      stages: { stage3_verifikasiFisik: false },
    });
    assert.strictEqual(partialStageRes.status, 200, `Partial-stage update failed: ${JSON.stringify(partialStageRes.data)}`);
    assert.strictEqual(partialStageRes.data.data.stages.stage1_verifikasi, true, "Omitted stage1 must remain true");
    assert.strictEqual(partialStageRes.data.data.stages.stage2_penjadwalan, true, "Omitted stage2 must remain true");
    assert.strictEqual(partialStageRes.data.data.stages.stage3_verifikasiFisik, false, "Explicitly updated stage3 must become false");
    assert.strictEqual(partialStageRes.data.data.stages.stage4_prosesSamsat, true, "Omitted stage4 must remain true");
    assert.strictEqual(partialStageRes.data.data.stages.stage5_verifikasiUlang, true, "Omitted stage5 must remain true");
    assert.strictEqual(partialStageRes.data.data.stages.stage6_supervisi, false, "Stage 6 invariant must remain false");
    assert.strictEqual(partialStageRes.data.data.stages.stage7_pengantaran, true, "Omitted stage7 must remain true");
    assert.strictEqual(partialStageRes.data.data.stages.stage8_diterima, true, "Omitted stage8 must remain true");

    // 3. Omitted stage preservation verified live via OrderTracking advance endpoint (Stage 1 -> Stage 2)
    const liveOrd = orderService.createOrder(
      { customer: "PT AUD-F01 Check", nomorHP: "081200001122", nopol: "B 1122 AUD", layanan: "Perpanjangan 1 Tahun", totalEstimasi: 450000, biayaSamsat: 300000, biayaJasa: 150000 },
      adminActor as any
    );
    const liveAdv = await apiRequest(baseUrl, "POST", `/api/orders/${liveOrd.orderNo}/advance`, adminToken, {
      targetStage: "Penjadwalan",
      updates: { isVerified: true, tanggalJemput: "2026-11-16", messenger: "Budi Batch5", assignedMessengerName: "Budi Batch5", assignedMessengerId: "emp-b5-503" },
    });
    assert.strictEqual(liveAdv.status, 200, "Admin Stage 1->2 advance must succeed because omitted stage1 & stage2 were preserved");

    // 4. Full-stage update works & keeps stage6_supervisi false
    const fullStageRes = await apiRequest(baseUrl, "PUT", "/api/permissions/admin", svpToken, {
      modules: CANONICAL_PERMISSIONS.admin.modules,
      stages: {
        stage1_verifikasi: true,
        stage2_penjadwalan: true,
        stage3_verifikasiFisik: true,
        stage4_prosesSamsat: true,
        stage5_verifikasiUlang: true,
        stage6_supervisi: false,
        stage7_pengantaran: true,
        stage8_diterima: true,
      },
    });
    assert.strictEqual(fullStageRes.status, 200);
    assert.strictEqual(fullStageRes.data.data.stages.stage3_verifikasiFisik, true);

    // 5. Invalid payloads rejected 400
    assert.strictEqual((await apiRequest(baseUrl, "PUT", "/api/permissions/admin", svpToken, {})).status, 400);
    assert.strictEqual((await apiRequest(baseUrl, "PUT", "/api/permissions/admin", svpToken, { stages: { stage6_supervisi: true } })).status, 400);
    assert.strictEqual((await apiRequest(baseUrl, "PUT", "/api/permissions/admin", svpToken, { stages: { stage99: true } })).status, 400);

    // 6. Unauthorized callers rejected 403 / 401
    assert.strictEqual((await apiRequest(baseUrl, "PUT", "/api/permissions/admin", adminToken, { stages: { stage3_verifikasiFisik: false } })).status, 403);
    assert.strictEqual((await apiRequest(baseUrl, "PUT", "/api/permissions/admin", financeToken, { stages: { stage3_verifikasiFisik: false } })).status, 403);
    assert.strictEqual((await apiRequest(baseUrl, "PUT", "/api/permissions/admin", messengerToken, { stages: { stage3_verifikasiFisik: false } })).status, 403);
    const unauthPut = await fetch(`${baseUrl}/api/permissions/admin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stages: { stage3_verifikasiFisik: false } }),
    });
    assert.strictEqual(unauthPut.status, 401);
  });

  // =========================================================================
  // AUD-F02 & AUD-F05: CANONICAL ADMIN KAS MESSENGER DEFAULTS, RESET & FAIL-CLOSED FRONTEND STAGES
  // =========================================================================

  await t.test("AUD-F02 & AUD-F05: Admin finance-kas-messenger defaults match backend/frontend across reset & frontend stages fail closed", async () => {
    const { permissionStore } = await import("../src/app/data/permissionStore");

    // 1. Both backend CANONICAL_PERMISSIONS and frontend permissionStore agree admin has finance-kas-messenger { view: true, manage: true }
    assert.deepStrictEqual(CANONICAL_PERMISSIONS.admin.modules["finance-kas-messenger"], { view: true, manage: true });
    assert.strictEqual(permissionStore.canViewPage("admin", "finance-kas-messenger"), true);
    assert.strictEqual(permissionStore.canManageModule("admin", "finance-kas-messenger"), true);

    // 2. HTTP POST /api/permissions/reset restores admin finance-kas-messenger { view: true, manage: true }
    const resetRes = await apiRequest(baseUrl, "POST", "/api/permissions/reset", svpToken, {});
    assert.strictEqual(resetRes.status, 200);
    const getPermsRes = await apiRequest(baseUrl, "GET", "/api/permissions", adminToken);
    assert.strictEqual(getPermsRes.status, 200);
    assert.deepStrictEqual(getPermsRes.data.data.admin.modules["finance-kas-messenger"], { view: true, manage: true });
    assert.deepStrictEqual(getPermsRes.data.data.admin.modules["finance-profit"], { view: false, manage: false });

    // 3. Admin can view and manage Kas Messenger & Reimbursements with canonical reset defaults
    const adminKasGet = await apiRequest(baseUrl, "GET", "/api/finance/kas-messenger", adminToken);
    assert.strictEqual(adminKasGet.status, 200);
    const adminKasPost = await apiRequest(baseUrl, "POST", "/api/finance/kas-messenger", adminToken, {
      tanggal: "2026-11-16",
      jenis: "Pemasukan",
      messengerId: "msg-b5-503",
      messenger: "Budi Batch5",
      keterangan: "Panjar Operasional AUD-F02",
      debit: 50000,
      kredit: 0,
      kategori: "Operasional",
      paymentMethodId: "pm-cash",
    });
    assert.strictEqual(adminKasPost.status, 201, `Expected 201 for Admin POST kas-messenger, got ${adminKasPost.status}: ${JSON.stringify(adminKasPost.data)}`);

    // 4. Finance and Messenger roles keep their respective permissions
    assert.deepStrictEqual(getPermsRes.data.data.finance.modules["finance-kas-messenger"], { view: true, manage: true });
    assert.deepStrictEqual(getPermsRes.data.data.messenger.modules["messenger-task"], { view: true, manage: true });
    assert.deepStrictEqual(getPermsRes.data.data.messenger.modules["order-tracking"], { view: false, manage: false });

    // 5. AUD-F05: Frontend permissionStore.canManageStage strictly fails closed on missing stages, undefined, unknown roles, and svp alias
    const matrix = permissionStore.getMatrix();
    const prevFinanceStages = { ...matrix.finance.stages };
    try {
      (matrix.finance as any).stages = {}; // Missing all stage keys
      for (const s of [1, 2, 3, 4, 5, 6, 7, 8]) {
        assert.strictEqual(permissionStore.canManageStage("finance", s), false, `Missing stage key must return false for stage ${s}`);
      }
      (matrix.finance as any).stages = undefined;
      assert.strictEqual(permissionStore.canManageStage("finance", 1), false, "Undefined stages must return false");
      assert.strictEqual(permissionStore.canManageStage("unknown_role", 1), false, "Unknown role must return false");
      assert.strictEqual(permissionStore.canManageStage(undefined, 1), false, "Undefined role must return false");
      assert.strictEqual(permissionStore.canManageStage("svp", 6), false, "Legacy 'svp' alias must fail closed");
      assert.strictEqual(permissionStore.canManageStage("administrator", 6), true, "Canonical 'administrator' retains Stage 6");
    } finally {
      matrix.finance.stages = prevFinanceStages;
    }
  });
});
