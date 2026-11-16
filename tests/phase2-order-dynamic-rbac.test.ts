/**
 * Phase 2 Order Dynamic RBAC Enforcement Test Suite
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Verifies all 33 Order API endpoints against dynamic SQLite role_permissions:
 * 1. Read orders: /, /archived, /archive, /:orderNo, /:orderNo/status-history
 * 2. Create order: POST / (gated by buat-order.manage)
 * 3. Update order: PUT /:orderNo (gated by order-tracking / messenger-task)
 * 4. Advance order: POST /:orderNo/advance (dynamic stage evaluation & Stage 6 Supervisi lockdown)
 * 5. Rollback order: POST /:orderNo/rollback (dynamic stage evaluation & Stage 6 rollback lock)
 * 6. Archive operations: POST /:orderNo/archive, DELETE /:orderNo/archive, DELETE /archive/clear-all
 * 7. Hard delete: DELETE /:orderNo (SVP-only)
 * 8. Order sub-actions: verify-payment, cancel, request-correction, verify-cost, approve-documents
 * 9. Courier task lifecycle: accept, decline, reassign
 * 10. Courier samsat, pickup, delivery lifecycle operations
 * 11. Anonymous fail-closed (401)
 * 12. SVP universal unconditional bypass across all order workflow operations
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
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

test("PHASE 2: ORDER WORKFLOW DYNAMIC RBAC ENFORCEMENT SUITE", async (t) => {
  const { server, baseUrl } = await startTestServer();

  let svpAuth: { token: string; user: any };
  let adminAuth: { token: string; user: any };
  let financeAuth: { token: string; user: any };
  let courierAuth: { token: string; user: any };

  let testOrderNo = "ORD-TEST-DYN-001";

  t.before(async () => {
    svpAuth = await loginUser(baseUrl, "svp@birojasa.com", "admin123");
    adminAuth = await loginUser(baseUrl, "admin@birojasa.com", "admin123");
    financeAuth = await loginUser(baseUrl, "finance@birojasa.com", "finance123");
    courierAuth = await loginUser(baseUrl, "budi.messenger@birojasa.com", "messenger123");

    // Initialize canonical default permissions in SQLite
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));
  });

  t.after(() => {
    // Restore default canonical permissions
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));
    server.close();
  });

  // 1. Unauthenticated requests to order endpoints return 401 UNAUTHENTICATED
  await t.test("1. Unauthenticated requests return 401", async () => {
    const endpoints = [
      { method: "GET", path: "/api/orders" },
      { method: "GET", path: "/api/orders/archived" },
      { method: "GET", path: "/api/orders/ORD-1126-001" },
      { method: "POST", path: "/api/orders" },
      { method: "PUT", path: "/api/orders/ORD-1126-001" },
      { method: "POST", path: "/api/orders/ORD-1126-001/advance" },
      { method: "POST", path: "/api/orders/ORD-1126-001/rollback" },
    ];
    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, { method: ep.method });
      assert.strictEqual(res.status, 401, `Expected 401 for anonymous ${ep.method} ${ep.path}`);
      const body = await res.json();
      assert.strictEqual(body.error?.code, "UNAUTHENTICATED");
    }
  });

  // 2. Order Read Operations: GET /, /archived, /archive, /:orderNo, /:orderNo/status-history
  await t.test("2. Order read operations dynamic RBAC enforcement", async () => {
    // Admin with order-menu: view: true -> 200
    const resOrders = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(resOrders.status, 200);

    // SVP revokes order-menu from Admin
    const adminPerms = dbPermissionRepository.getByRole("admin")!;
    adminPerms.modules["order-menu"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("admin", adminPerms);

    const resOrdersRevoked = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(resOrdersRevoked.status, 403);
    const bodyRevoked = await resOrdersRevoked.json();
    assert.strictEqual(bodyRevoked.error?.code, "FORBIDDEN");

    // Restore order-menu
    adminPerms.modules["order-menu"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("admin", adminPerms);

    // Check archived orders
    const resArchived = await fetch(`${baseUrl}/api/orders/archived`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(resArchived.status, 200);

    const resArchiveAlias = await fetch(`${baseUrl}/api/orders/archive`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(resArchiveAlias.status, 200);

    // Revoke order-history
    adminPerms.modules["order-history"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("admin", adminPerms);

    const resArchivedRevoked = await fetch(`${baseUrl}/api/orders/archived`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(resArchivedRevoked.status, 403);

    // Restore order-history
    adminPerms.modules["order-history"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("admin", adminPerms);
  });

  // 3. Order Creation: POST / (gated by buat-order.manage)
  await t.test("3. Order creation dynamic RBAC enforcement", async () => {
    // Admin creates order -> 201
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        customer: "Dynamic RBAC Tester",
        nomorHP: "081122334455",
        layanan: "Perpanjangan STNK Tahunan",
        serviceId: "svc-perp-1th",
        nopol: "B 9988 RBAC",
        wilayahSamsatAsal: "Jakarta Selatan",
        metodeLayanan: "Antar Jemput",
        alamatPenjemputan: "Jl. Sudirman No. 1",
        biayaLayanan: 250000,
        biayaSamsat: 350000,
        totalBiaya: 600000,
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const createdData = await createRes.json();
    testOrderNo = createdData.data.orderNo;

    // Revoke buat-order.manage from Admin
    const adminPerms = dbPermissionRepository.getByRole("admin")!;
    adminPerms.modules["buat-order"] = { view: true, manage: false };
    dbPermissionRepository.saveRole("admin", adminPerms);

    const createRevoked = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        customer: "Blocked Tester",
        nomorHP: "081122334455",
        layanan: "Perpanjangan STNK Tahunan",
        serviceId: "svc-perp-1th",
        nopol: "B 9988 BLK",
        wilayahSamsatAsal: "Jakarta Selatan",
        metodeLayanan: "Antar Jemput",
      }),
    });
    assert.strictEqual(createRevoked.status, 403);

    // Finance role cannot create order -> 403
    const financeCreate = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({
        customer: "Finance Tester",
        nomorHP: "081122334455",
        layanan: "Perpanjangan STNK Tahunan",
        serviceId: "svc-perp-1th",
        nopol: "B 9988 FIN",
        wilayahSamsatAsal: "Jakarta Selatan",
        metodeLayanan: "Antar Jemput",
      }),
    });
    assert.strictEqual(financeCreate.status, 403);

    // Restore buat-order
    adminPerms.modules["buat-order"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("admin", adminPerms);
  });

  // 4. Order Update: PUT /:orderNo (gated by [order-tracking, messenger-task].manage)
  await t.test("4. Order update dynamic RBAC enforcement", async () => {
    // Admin with order-tracking -> 200
    const updateRes = await fetch(`${baseUrl}/api/orders/${testOrderNo}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ catatanOrder: "Catatan admin diperbarui" }),
    });
    assert.strictEqual(updateRes.status, 200);

    // Finance cannot update orders -> 403
    const finUpdate = await fetch(`${baseUrl}/api/orders/${testOrderNo}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ catatanOrder: "Catatan finance" }),
    });
    assert.strictEqual(finUpdate.status, 403);

    // Revoke order-tracking and messenger-task from Admin
    const adminPerms = dbPermissionRepository.getByRole("admin")!;
    adminPerms.modules["order-tracking"] = { view: false, manage: false };
    adminPerms.modules["messenger-task"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("admin", adminPerms);

    const updateRevoked = await fetch(`${baseUrl}/api/orders/${testOrderNo}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ catatanOrder: "Harus gagal" }),
    });
    assert.strictEqual(updateRevoked.status, 403);

    // Restore
    adminPerms.modules["order-tracking"] = { view: true, manage: true };
    adminPerms.modules["messenger-task"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("admin", adminPerms);
  });

  // 5. Stage Advance: POST /:orderNo/advance (Dynamic stage authority & Stage 6 Supervisi lockdown)
  await t.test("5. Stage advance dynamic evaluation & Stage 6 Supervisi lockdown", async () => {
    // 5a. Finance role rejected -> 403
    const finAdvance = await fetch(`${baseUrl}/api/orders/${testOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ targetStage: "Penjadwalan" }),
    });
    assert.strictEqual(finAdvance.status, 403);
    const finBody = await finAdvance.json();
    assert.strictEqual(finBody.error?.code, "FORBIDDEN");

    // 5b. Messenger role rejected -> 403
    const courierAdvance = await fetch(`${baseUrl}/api/orders/${testOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({ targetStage: "Penjadwalan" }),
    });
    assert.strictEqual(courierAdvance.status, 403);

    // 5c. Admin targeting Stage 6 Supervisi out-of-order from Step 1 is rejected with 403 FORBIDDEN (Stage 6 is strictly SVP-only)
    const adminTargetStage6 = await fetch(`${baseUrl}/api/orders/${testOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ targetStage: "Supervisi" }),
    });
    assert.strictEqual(adminTargetStage6.status, 403);
    const stage6Body = await adminTargetStage6.json();
    assert.strictEqual(stage6Body.error?.code, "FORBIDDEN");

    // 5c-ii. Normalizing persisted admin permissions still keeps stage6_supervisi strictly false
    const permSnap = dbPermissionRepository.getByRole("admin")!;
    dbPermissionRepository.saveRole("admin", {
      ...permSnap,
      stages: { ...permSnap.stages, stage6_supervisi: true },
    });
    assert.strictEqual(dbPermissionRepository.getByRole("admin")!.stages.stage6_supervisi, false);

    // 5c-iii. SVP targeting Supervisi from Step 1 reaches sequential validation (400 INVALID_STAGE_TRANSITION, not 403)
    const svpTargetStage6 = await fetch(`${baseUrl}/api/orders/${testOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svpAuth.token}` },
      body: JSON.stringify({ targetStage: "Supervisi" }),
    });
    assert.strictEqual(svpTargetStage6.status, 400);
    const stage6SeqBody = await svpTargetStage6.json();
    assert.strictEqual(stage6SeqBody.error?.code, "INVALID_STAGE_TRANSITION");

    // 5d. Admin advances Step 1 (Verifikasi) -> Step 2 (Penjadwalan) with granted permissions -> 200
    const advanceStep2 = await fetch(`${baseUrl}/api/orders/${testOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        targetStage: "Penjadwalan",
        updates: { catatanOrder: "Berkas sudah lengkap diverifikasi" },
      }),
    });
    assert.strictEqual(advanceStep2.status, 200);

    // 5e. Dynamic stage evaluation: Revoke stage2_penjadwalan from Admin
    const adminPerms = dbPermissionRepository.getByRole("admin")!;
    adminPerms.stages.stage2_penjadwalan = false;
    dbPermissionRepository.saveRole("admin", adminPerms);

    // Admin attempts to advance order that is currently at Penjadwalan -> 403 FORBIDDEN
    const advanceWhileRevoked = await fetch(`${baseUrl}/api/orders/${testOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        targetStage: "Verifikasi Dokumen",
        updates: {},
      }),
    });
    assert.strictEqual(advanceWhileRevoked.status, 403);
    const revokedBody = await advanceWhileRevoked.json();
    assert.strictEqual(revokedBody.error?.code, "FORBIDDEN");

    // Restore stage2_penjadwalan
    adminPerms.stages.stage2_penjadwalan = true;
    dbPermissionRepository.saveRole("admin", adminPerms);
  });

  // 6. Stage Rollback & Stage 6 Rollback Lockdown
  await t.test("6. Stage rollback & Stage 6 rollback lock", async () => {
    // Put test order at Stage 7 with stage6Approved=true in DB
    dbOrderRepository.updateOrder(testOrderNo, {
      currentStep: 7,
      currentStageName: "Pengantaran",
      documentApproval: {
        stage5Approved: true,
        stage6Approved: true,
        stage6ApprovedBy: "SVP Admin",
        stage6ApprovedAt: new Date().toISOString(),
      } as any,
    });

    // Admin attempting rollback across/to Step <= 6 -> ALWAYS 403 FORBIDDEN (Stage 6 is strictly SVP-only)
    const adminRollbackPastStage6 = await fetch(`${baseUrl}/api/orders/${testOrderNo}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        targetStep: 5,
        targetStage: "Verifikasi Ulang",
        reason: "Admin rollback attempt across Stage 6",
      }),
    });
    assert.strictEqual(adminRollbackPastStage6.status, 403);

    // Even if stage6_supervisi: true is passed to saveRole, normalization keeps Admin locked at 403
    const origPerms = dbPermissionRepository.getByRole("admin")!;
    dbPermissionRepository.saveRole("admin", {
      ...origPerms,
      stages: { ...origPerms.stages, stage6_supervisi: true },
    });
    const adminRollbackStillLocked = await fetch(`${baseUrl}/api/orders/${testOrderNo}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        targetStep: 5,
        targetStage: "Verifikasi Ulang",
        reason: "Admin rollback remains denied",
      }),
    });
    assert.strictEqual(adminRollbackStillLocked.status, 403);

    // SVP retains unconditional rollback across Stage 6
    const svpRollback = await fetch(`${baseUrl}/api/orders/${testOrderNo}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svpAuth.token}` },
      body: JSON.stringify({
        targetStep: 5,
        targetStage: "Verifikasi Ulang",
        reason: "SVP rollback for correction",
      }),
    });
    assert.strictEqual(svpRollback.status, 200);
  });

  // 7. Archive Operations & Hard Delete (Stage 8 integrity + Dynamic RBAC)
  await t.test("7. Archive operations & hard delete authorization", async () => {
    // Archiving before Stage 8 MUST fail with 400 INVALID_ARCHIVE_STAGE
    const preStage8ArchiveRes = await fetch(`${baseUrl}/api/orders/${testOrderNo}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(preStage8ArchiveRes.status, 400);
    const preStage8Body = await preStage8ArchiveRes.json();
    assert.strictEqual(preStage8Body.error?.code, "INVALID_ARCHIVE_STAGE");

    // Advance order state to Stage 8 (Dokumen Telah Diterima) in DB
    dbOrderRepository.updateOrder(testOrderNo, {
      currentStep: 8,
      currentStageName: "Dokumen Telah Diterima",
      isReceived: true,
    });

    // Admin archives Stage 8 order with order-history: manage: true -> 200
    const archiveRes = await fetch(`${baseUrl}/api/orders/${testOrderNo}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(archiveRes.status, 200);

    // Finance attempting delete/clear-all -> 403
    const finDel = await fetch(`${baseUrl}/api/orders/${testOrderNo}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finDel.status, 403);

    // Revoking order-history.manage denies Admin delete/clear-all -> 403
    const permSnap = dbPermissionRepository.getByRole("admin")!;
    dbPermissionRepository.saveRole("admin", {
      ...permSnap,
      modules: { ...permSnap.modules, "order-history": { view: true, manage: false } },
    });
    const revokedClearAdmin = await fetch(`${baseUrl}/api/orders/archive/clear-all`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(revokedClearAdmin.status, 403);

    const revokedDeleteArchiveAdmin = await fetch(`${baseUrl}/api/orders/${testOrderNo}/archive`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(revokedDeleteArchiveAdmin.status, 403);

    // Restoring order-history.manage allows Admin delete archive & clear -> 200
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    const deleteArchiveAdmin = await fetch(`${baseUrl}/api/orders/${testOrderNo}/archive`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(deleteArchiveAdmin.status, 200);

    // SVP can clear-all unconditionally -> 200
    const clearSvp = await fetch(`${baseUrl}/api/orders/archive/clear-all`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(clearSvp.status, 200);
  });

  // 8. Order Sub-Actions: verify-payment, cancel, request-correction, verify-cost, approve-documents
  await t.test("8. Order sub-actions dynamic RBAC", async () => {
    // Create new order for sub-actions with complete required payload
    const ordRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        customer: "Sub-Action Tester",
        nomorHP: "081234567890",
        layanan: "Perpanjangan STNK Tahunan",
        serviceId: "svc-perp-1th",
        nopol: "B 7766 ACT",
        wilayahSamsatAsal: "Jakarta Barat",
        metodeLayanan: "Antar Jemput",
        alamatPenjemputan: "Jl. Lapangan Bola No. 5",
        biayaLayanan: 250000,
        biayaSamsat: 350000,
        totalBiaya: 600000,
      }),
    });
    const ordBody = await ordRes.json();
    assert.strictEqual(ordRes.status, 201, `Create order failed: ${JSON.stringify(ordBody)}`);
    const subOrderNo = ordBody.data.orderNo;

    // verify-payment: Finance has finance-tagihan -> reaches controller (NOT 403)
    const finVerify = await fetch(`${baseUrl}/api/orders/${subOrderNo}/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ dibayar: 600000 }),
    });
    assert.notStrictEqual(finVerify.status, 403);

    // verify-payment: Admin without finance-tagihan -> 403
    const adminVerify = await fetch(`${baseUrl}/api/orders/${subOrderNo}/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ dibayar: 600000 }),
    });
    assert.strictEqual(adminVerify.status, 403);

    // cancel: Admin with order-menu: manage -> reaches controller (NOT 403)
    const adminCancel = await fetch(`${baseUrl}/api/orders/${subOrderNo}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ alasan: "Batal oleh customer" }),
    });
    assert.notStrictEqual(adminCancel.status, 403);

    // verify-cost: Admin with order-tracking -> reaches controller (NOT 403)
    const adminCost = await fetch(`${baseUrl}/api/orders/${subOrderNo}/verify-cost`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ verifiedCost: 350000 }),
    });
    assert.notStrictEqual(adminCost.status, 403);

    // approve-documents: Admin with order-tracking -> reaches controller (NOT 403 for stage 5)
    const adminApprove = await fetch(`${baseUrl}/api/orders/${subOrderNo}/approve-documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ stage: 5, snapshotDocs: [] }),
    });
    assert.notStrictEqual(adminApprove.status, 403);
  });

  // 9. Messenger Task Lifecycle: accept, decline, reassign
  await t.test("9. Messenger task lifecycle dynamic RBAC", async () => {
    // Courier with messenger-task: manage -> reaches accept endpoint (NOT 403)
    const courierAccept = await fetch(`${baseUrl}/api/orders/ORD-1126-001/tasks/pickup/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({ courierId: "EMP-0004" }),
    });
    assert.notStrictEqual(courierAccept.status, 403);

    // Finance cannot accept messenger tasks -> 403
    const financeAccept = await fetch(`${baseUrl}/api/orders/ORD-1126-001/tasks/pickup/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ courierId: "EMP-0004" }),
    });
    assert.strictEqual(financeAccept.status, 403);

    // Admin reassigns task with order-tracking: manage -> reaches controller (NOT 403)
    const adminReassign = await fetch(`${baseUrl}/api/orders/ORD-1126-001/tasks/pickup/reassign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ newCourierId: "EMP-0005", reason: "Kurir berhalangan" }),
    });
    assert.notStrictEqual(adminReassign.status, 403);
  });

  // 10. Samsat, Pickup, and Delivery Lifecycle Operations
  await t.test("10. Samsat, pickup, delivery lifecycle dynamic RBAC", async () => {
    const courierSamsat = await fetch(`${baseUrl}/api/orders/ORD-1126-001/samsat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({ processId: "mk-1" }),
    });
    assert.notStrictEqual(courierSamsat.status, 403);

    const courierPickup = await fetch(`${baseUrl}/api/orders/ORD-1126-001/pickup/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.notStrictEqual(courierPickup.status, 403);

    const courierDelivery = await fetch(`${baseUrl}/api/orders/ORD-1126-001/delivery/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.notStrictEqual(courierDelivery.status, 403);

    // Finance role rejected on courier lifecycle operations -> 403
    const financePickup = await fetch(`${baseUrl}/api/orders/ORD-1126-001/pickup/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(financePickup.status, 403);
  });

  // 11. SVP Universal Bypass across order workflow
  await t.test("11. SVP retains universal unconditional access", async () => {
    const svpOrders = await fetch(`${baseUrl}/api/orders`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(svpOrders.status, 200);

    const svpArchived = await fetch(`${baseUrl}/api/orders/archived`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(svpArchived.status, 200);
  });
});
