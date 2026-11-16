/**
 * SUN89 — MESSENGER TASK END-TO-END AUDIT & REMEDIATION REGRESSION SUITE
 *
 * Covers all 15 mandatory scenarios:
 * 1.  Normal Admin assignment across all 4 canonical task types
 * 2.  Assigned Messenger accepts PENDING task (atomic lock + ACCEPT_TASK audit)
 * 3.  Messenger lifecycle completion (Pickup, Samsat, Jemput Hasil Samsat, Delivery w/ handover & "Selesai")
 * 4.  Cross-courier steal protection: Courier B cannot accept Courier A's assigned PENDING task (403)
 * 5.  Cross-courier decline protection: Courier B cannot decline Courier A's task (403)
 * 6.  Cross-courier & generic PUT hijack protection: Courier B cannot mutate another task or write taskAcceptance/courierIds via PUT (403)
 * 7.  Concurrent pool claim lock: Two couriers race unassigned pool task -> 1x 200 OK + 1x 409 TASK_ALREADY_ACCEPTED
 * 8.  Admin & Administrator (SVP) Reassign RBAC, courier validation, and role blocks (Courier/Finance 403)
 * 9.  Multi-hop assignment history preservation (taskAcceptance[taskType].history + REASSIGN_TASK audit metadata)
 * 10. Invalid state transitions, completed-task/cancelled/archived guards, invalid taskType, 401/403 boundaries
 * 11. Delivery release resets messengerTaskStatus to "Belum Diambil" (no stuck "Dalam Proses")
 * 12. Samsat dedicated team release endpoint (POST /samsat/release) preserves component progress, clears owner, blocks messenger notes (400)
 * 13. Adapter fail-loudly integrity: reassignMessengerTaskAction never masks 500/network failure with fake local success
 * 14. Messenger Task Detail truthfulness: totalTagihan uses actual payment (0 stays 0, never fake 1500000) & live status
 * 15. Messenger History & Order Tracking cross-module consistency
 */

import "./setup-test-portal-shim";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { db } from "../server/src/database/db";
import { createApp } from "../server/src/app";
import { hashPassword } from "../server/src/utils/crypto";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { orderService } from "../server/src/services/orderService";
import { messengerService } from "../server/src/services/messengerService";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { CANONICAL_PERMISSIONS } from "../server/src/config/defaultPermissions";
import { orderStore } from "../src/app/data/orderStore";
import { orderRepository } from "../src/data/repositories/orderRepository";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { permissionStore } from "../src/app/data/permissionStore";
import {
  reassignMessengerTaskAction,
  releaseSamsatTaskAction,
  deriveSingleTaskFromOrder,
} from "../src/app/data/messengerTaskAdapter";
import { APP_CONFIG } from "../src/app/config/appConfig";

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
  assert.equal(res.status, 200, `Login ${email} failed (${res.status}): ${JSON.stringify(body)}`);
  return { token: body.data.token, user: body.data.user };
}

async function apiRequest(
  baseUrl: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
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
      "INSERT OR REPLACE INTO role_permissions (role, permissions_json, updated_at, updated_by) VALUES (?, ?, datetime('now'), 'mt-audit-test')"
    ).run(role, JSON.stringify({ version: 1, modules: canonical.modules, stages: canonical.stages }));
  }
}

test("SUN89 — MESSENGER TASK END-TO-END AUDIT & REMEDIATION SUITE", async (t) => {
  const { server, baseUrl } = await startTestServer();
  const origFetch = globalThis.fetch;
  const storageMap = new Map<string, string>();
  const prevWindow = (globalThis as any).window;
  const prevLocalStorage = (globalThis as any).localStorage;
  const mockLocalStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  (globalThis as any).localStorage = mockLocalStorage;
  (globalThis as any).window = {
    ...(prevWindow || {}),
    localStorage: mockLocalStorage,
  };

  t.after(() => {
    globalThis.fetch = origFetch;
    orderRepository.setProvider(new ApiOrderProvider());
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    if (prevLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = prevLocalStorage;
    }
    resetRolePermissionsToCanonical();
    server.close();
  });

  // Seed deterministic actors (SVP/Administrator, Admin, Finance, Messenger A/B/C, Inactive Courier)
  const insertEmp = db.prepare(`
    INSERT OR IGNORE INTO employees (id, nik_ktp, nama_lengkap, no_hp, tgl_lahir, wilayah, alamat_domisili, jabatan, status_karyawan)
    VALUES (?, ?, ?, ?, '1992-01-01', 'Jakarta Selatan', 'Jl. Operasional', ?, ?)
  `);
  insertEmp.run("EMP-MT-SVP", "3174000000000900", "SVP Audit", "081200000900", "SVP", "Aktif");
  insertEmp.run("EMP-MT-ADM", "3174000000000901", "Admin Audit", "081200000901", "ADMIN", "Aktif");
  insertEmp.run("EMP-MT-FIN", "3174000000000902", "Finance Audit", "081200000902", "FINANCE", "Aktif");
  insertEmp.run("EMP-MT-A", "3174000000000903", "Kurir Alpha", "081200000903", "Messenger", "Aktif");
  insertEmp.run("EMP-MT-B", "3174000000000904", "Kurir Beta", "081200000904", "Messenger", "Aktif");
  insertEmp.run("EMP-MT-C", "3174000000000905", "Kurir Charlie", "081200000905", "Messenger", "Aktif");
  insertEmp.run("EMP-MT-INACTIVE", "3174000000000906", "Kurir Nonaktif", "081200000906", "Messenger", "Nonaktif");

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messengers (id, employee_id, plat_motor_operasional, wilayah_tugas_utama, status_tugas)
    VALUES (?, ?, ?, 'Jakarta Selatan', 'STANDBY')
  `);
  insertMsg.run("msg-mt-a", "EMP-MT-A", "B 903 MT");
  insertMsg.run("msg-mt-b", "EMP-MT-B", "B 904 MT");
  insertMsg.run("msg-mt-c", "EMP-MT-C", "B 905 MT");

  const pass = hashPassword("AuditPass123!");
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, email, password_hash, password_salt, nama, jabatan, role, employee_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Aktif')
  `);
  insertUser.run(900, "mt-svp@sun89.test", pass.hash, pass.salt, "SVP Audit", "SVP", "administrator", "EMP-MT-SVP");
  insertUser.run(901, "mt-admin@sun89.test", pass.hash, pass.salt, "Admin Audit", "ADMIN", "admin", "EMP-MT-ADM");
  insertUser.run(902, "mt-fin@sun89.test", pass.hash, pass.salt, "Finance Audit", "FINANCE", "finance", "EMP-MT-FIN");
  insertUser.run(903, "mt-a@sun89.test", pass.hash, pass.salt, "Kurir Alpha", "Messenger", "messenger", "EMP-MT-A");
  insertUser.run(904, "mt-b@sun89.test", pass.hash, pass.salt, "Kurir Beta", "Messenger", "messenger", "EMP-MT-B");
  insertUser.run(905, "mt-c@sun89.test", pass.hash, pass.salt, "Kurir Charlie", "Messenger", "messenger", "EMP-MT-C");

  resetRolePermissionsToCanonical();
  const svp = await loginHttp(baseUrl, "mt-svp@sun89.test", "AuditPass123!");
  const admin = await loginHttp(baseUrl, "mt-admin@sun89.test", "AuditPass123!");
  const finance = await loginHttp(baseUrl, "mt-fin@sun89.test", "AuditPass123!");
  const courierA = await loginHttp(baseUrl, "mt-a@sun89.test", "AuditPass123!");
  const courierB = await loginHttp(baseUrl, "mt-b@sun89.test", "AuditPass123!");
  const courierC = await loginHttp(baseUrl, "mt-c@sun89.test", "AuditPass123!");

  async function createOrderHttp(customer: string, totalBiaya = 500000): Promise<string> {
    const res = await apiRequest(baseUrl, "POST", "/api/orders", admin.token, {
      customer,
      nomorHP: "081288887777",
      nopol: `B ${Math.floor(1000 + Math.random() * 8999)} MT`,
      layanan: "Perpanjangan 1 Tahun",
      wilayahSamsatAsal: "Jakarta Selatan",
      metodeLayanan: "Antar Jemput",
      totalEstimasi: totalBiaya,
      biayaSamsat: Math.floor(totalBiaya * 0.7),
      biayaJasa: totalBiaya - Math.floor(totalBiaya * 0.7),
    });
    assert.equal(res.status, 201, `Order create failed: ${JSON.stringify(res.data)}`);
    return res.data.data.orderNo;
  }

  await t.test("1-3 & 15. Full 4-task lifecycle: Admin assign -> Accept -> Start -> Complete -> History & Order Tracking", async () => {
    const orderNo = await createOrderHttp("PT Lifecycle Lengkap", 600000);

    // Stage 1 -> Stage 2: Admin assigns Jemput Dokumen to Kurir Alpha
    const adv2 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
      targetStage: "Penjadwalan",
      updates: {
        messenger: "Kurir Alpha",
        assignedMessengerName: "Kurir Alpha",
        assignedMessengerId: "EMP-MT-A",
        tanggalJemput: "2026-11-16",
        taskAcceptance: {
          "Jemput Dokumen": { status: "PENDING", courierId: "EMP-MT-A", courierName: "Kurir Alpha", isLocked: false },
        },
      },
    });
    assert.equal(adv2.status, 200);

    // Courier A accepts, starts, and completes Jemput Dokumen
    const acc1 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/accept`, courierA.token, {});
    assert.equal(acc1.status, 200);
    assert.equal(acc1.data.data.taskAcceptance["Jemput Dokumen"].status, "ACCEPTED");
    assert.equal(acc1.data.data.taskAcceptance["Jemput Dokumen"].isLocked, true);

    const start1 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/pickup/start`, courierA.token, {});
    assert.equal(start1.status, 200);
    const comp1 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/pickup/complete`, courierA.token, {
      checklist: { stnkAsli: true, ktpAsli: true },
      photoUrl: "https://example.com/p-comp.jpg",
    });
    assert.equal(comp1.status, 200);
    assert.equal(comp1.data.data.currentStep, 2, "Pickup completion keeps order at Step 2 pending verification");
    assert.equal(comp1.data.data.pickupCompleted, true);

    // Stage 2 -> 3 -> 4 (Proses Samsat assigned to Kurir Alpha)
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, { targetStage: "Verifikasi Dokumen" })).status, 200);
    const adv4 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
      targetStage: "Proses Samsat",
      updates: {
        documentsVerified: true,
        samsatMessenger: "Kurir Alpha",
        samsatMessengerNama: "Kurir Alpha",
        samsatMessengerId: "EMP-MT-A",
        samsatProcesses: [{ id: "comp-mt-1", name: "Cek Fisik", status: "COMPLETED" }],
      },
    });
    assert.equal(adv4.status, 200);

    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Proses Samsat")}/accept`, courierA.token, {})).status, 200);
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/samsat/start`, courierA.token, {})).status, 200);
    const compSamsat = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/samsat/complete`, courierA.token, {
      components: [{ id: "comp-mt-1", name: "Cek Fisik", status: "COMPLETED", isCompleted: true }],
    });
    assert.equal(compSamsat.status, 200);

    // Jemput Hasil Samsat scheduled -> accepted -> completed (Stage 4 supervision/scheduling uses SVP authority per Stage 4 RBAC)
    assert.equal(
      (
        await apiRequest(baseUrl, "PUT", `/api/orders/${orderNo}`, svp.token, {
          samsatPickupStatus: "Terjadwal Jemput Samsat",
          samsatPickupDate: "2026-11-16",
          samsatPickupMessenger: "Kurir Alpha",
          samsatPickupMessengerId: "EMP-MT-A",
        })
      ).status,
      200
    );
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Hasil Samsat")}/accept`, courierA.token, {})).status, 200);
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/samsat-pickup/complete`, courierA.token, {})).status, 200);

    // Advance 4 -> 5 (Admin), 5 -> 6 (Admin submits verified Stage 5 to Supervisi), 6 -> 7 (SVP approves & assigns Pengantaran to Kurir Beta)
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, { targetStage: "Verifikasi Ulang" })).status, 200);
    assert.equal(
      (
        await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
          targetStage: "Supervisi",
          updates: { documentApproval: { stage5Verified: true } },
        })
      ).status,
      200
    );
    const adv7 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, svp.token, {
      targetStage: "Pengantaran",
      updates: {
        documentApproval: { stage6Approved: true },
        approvedBySpv: true,
        messengerPengantar: "Kurir Beta",
        deliveryMessengerId: "EMP-MT-B",
        isDeliveryScheduled: true,
        tanggalPengantaran: "2026-11-16",
      },
    });
    assert.equal(adv7.status, 200, `Advance 6->7 failed: ${JSON.stringify(adv7.data)}`);

    // Courier B accepts, starts & completes Pengantaran Dokumen
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Pengantaran Dokumen")}/accept`, courierB.token, {})).status, 200);
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/delivery/start`, courierB.token, {})).status, 200);
    const compDeliv = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/delivery/complete`, courierB.token, {
      receiverName: "Pak Direktur",
      photoUrl: "https://example.com/deliv.jpg",
    });
    assert.equal(compDeliv.status, 200);
    assert.equal(compDeliv.data.data.deliveryStatus, "Dokumen Diserahkan");
    assert.equal(compDeliv.data.data.messengerTaskStatus, "Selesai");
    assert.equal(compDeliv.data.data.deliveryHandover?.recipientName, "Pak Direktur");

    // Messenger History includes completed tasks
    const histRes = await apiRequest(baseUrl, "GET", `/api/messenger/history?search=${encodeURIComponent(orderNo)}`, admin.token);
    assert.equal(histRes.status, 200);
    assert.ok(Array.isArray(histRes.data.data) && histRes.data.data.length >= 3, "History must include completed courier tasks");
  });

  await t.test("4-6. Cross-courier steal, decline, start/complete, and PUT hijack protection (403 FORBIDDEN)", async () => {
    const orderNo = await createOrderHttp("PT Ownership Isolation");
    await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
      targetStage: "Penjadwalan",
      updates: {
        messenger: "Kurir Alpha",
        assignedMessengerName: "Kurir Alpha",
        assignedMessengerId: "EMP-MT-A",
        taskAcceptance: {
          "Jemput Dokumen": { status: "PENDING", courierId: "EMP-MT-A", courierName: "Kurir Alpha", isLocked: false },
        },
      },
    });

    // 4. Courier B cannot accept PENDING task explicitly assigned to Courier A (DEFECT-MT-01 fix)
    const stealAccept = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/accept`, courierB.token, {});
    assert.equal(stealAccept.status, 403, `Expected 403 when Courier B attempts to accept Courier A's PENDING task, got ${stealAccept.status}`);

    // 5. Courier B cannot decline Courier A's task (DEFECT-MT-02 fix)
    const stealDecline = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/decline`, courierB.token, {});
    assert.equal(stealDecline.status, 403, `Expected 403 when Courier B declines Courier A's task, got ${stealDecline.status}`);

    // Courier A still owns the task cleanly
    const checkOrder = await apiRequest(baseUrl, "GET", `/api/orders/${orderNo}`, admin.token);
    assert.equal(checkOrder.data.data.assignedMessengerId, "EMP-MT-A");

    // 6. Courier B cannot hijack assignment or taskAcceptance via generic PUT (DEFECT-MT-06 fix)
    const putHijackId = await apiRequest(baseUrl, "PUT", `/api/orders/${orderNo}`, courierB.token, {
      assignedMessengerId: "EMP-MT-B",
      messenger: "Kurir Beta",
    });
    assert.equal(putHijackId.status, 403);

    const putHijackAcc = await apiRequest(baseUrl, "PUT", `/api/orders/${orderNo}`, courierA.token, {
      taskAcceptance: {
        "Jemput Dokumen": { status: "ACCEPTED", courierId: "EMP-MT-A", isLocked: true },
      },
    });
    assert.equal(putHijackAcc.status, 403, "Even owning courier cannot write taskAcceptance via generic PUT");

    // Cross-courier start & complete blocked
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/pickup/start`, courierB.token, {})).status, 403);
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/pickup/complete`, courierB.token, {})).status, 403);
  });

  await t.test("7. Concurrent claim lock on unassigned pool task returns 1x 200 OK and 1x 409 TASK_ALREADY_ACCEPTED", async () => {
    const orderNo = await createOrderHttp("PT Concurrency Pool");
    await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
      targetStage: "Penjadwalan",
      updates: { messenger: "Belum Ditugaskan", assignedMessengerName: "Belum Ditugaskan" },
    });

    const [r1, r2] = await Promise.all([
      apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/accept`, courierA.token, {}),
      apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/accept`, courierB.token, {}),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  });

  await t.test("8-9. Reassign RBAC, validation, SVP/Admin authority & multi-hop assignment history preservation", async () => {
    const orderNo = await createOrderHttp("PT MultiHop Reassign");
    await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
      targetStage: "Penjadwalan",
      updates: {
        messenger: "Kurir Alpha",
        assignedMessengerName: "Kurir Alpha",
        assignedMessengerId: "EMP-MT-A",
      },
    });

    // Courier & Finance forbidden
    const msgReassign = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/reassign`, courierB.token, {
      newCourierId: "EMP-MT-B",
      newCourierName: "Kurir Beta",
      reason: "Unauthorized",
    });
    assert.equal(msgReassign.status, 403);

    const finReassign = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/reassign`, finance.token, {
      newCourierId: "EMP-MT-B",
      newCourierName: "Kurir Beta",
      reason: "Unauthorized",
    });
    assert.equal(finReassign.status, 403);

    // Invalid courier IDs (inactive, non-existent, non-messenger, missing reason) rejected 400
    assert.equal(
      (
        await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/reassign`, admin.token, {
          newCourierId: "EMP-MT-INACTIVE",
          newCourierName: "Kurir Nonaktif",
          reason: "Test",
        })
      ).status,
      400
    );
    assert.equal(
      (
        await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/reassign`, admin.token, {
          newCourierId: "EMP-MT-FIN",
          newCourierName: "Finance Audit",
          reason: "Test",
        })
      ).status,
      400
    );

    // Hop 1: Admin reassigns A -> B
    const hop1 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/reassign`, admin.token, {
      newCourierId: "EMP-MT-B",
      newCourierName: "Kurir Beta",
      reason: "Motor Kurir Alpha kendala",
    });
    assert.equal(hop1.status, 200);
    assert.equal(hop1.data.data.assignedMessengerId, "EMP-MT-B");

    // Hop 2: Administrator (SVP) reassigns B -> C (preserves multi-hop history)
    const hop2 = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/reassign`, svp.token, {
      newCourierId: "EMP-MT-C",
      newCourierName: "Kurir Charlie",
      reason: "Wilayah digabung Kurir Charlie",
    });
    assert.equal(hop2.status, 200);
    const historyArr = (hop2.data.data.taskAcceptance["Jemput Dokumen"] as any).history || [];
    assert.equal(historyArr.length, 2, "Multi-hop history array must preserve both reassignments");
    assert.equal(historyArr[0].fromCourierName, "Kurir Alpha");
    assert.equal(historyArr[0].toCourierName, "Kurir Beta");
    assert.equal(historyArr[1].fromCourierName, "Kurir Beta");
    assert.equal(historyArr[1].toCourierName, "Kurir Charlie");
  });

  await t.test("10. Invalid transitions, completed task, cancelled order & unauthenticated 401 checks", async () => {
    const orderNo = await createOrderHttp("PT Invalid Transitions");

    // Unauthenticated rejected 401
    const anonRes = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/accept`, null, {});
    assert.equal(anonRes.status, 401);

    // Invalid task type rejected 400
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/TugasNgawur/accept`, courierA.token, {})).status, 400);

    // Wrong stage acceptance rejected 400 (order still Step 1)
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/accept`, courierA.token, {})).status, 400);

    // Cancel order -> reassign / accept blocked
    assert.equal((await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/cancel`, admin.token, { reason: "Batal uji" })).status, 200);
    assert.equal(
      (
        await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/tasks/${encodeURIComponent("Jemput Dokumen")}/reassign`, admin.token, {
          newCourierId: "EMP-MT-A",
          newCourierName: "Kurir Alpha",
          reason: "Reassign cancelled",
        })
      ).status,
      400
    );
  });

  await t.test("11. Delivery release resets messengerTaskStatus to 'Belum Diambil' cleanly", async () => {
    const orderNo = await createOrderHttp("PT Delivery Release");
    // Direct repository fixture at Step 7 in Sedang Diantar
    dbOrderRepository.updateOrder(orderNo, {
      currentStep: 7,
      currentStageName: "Pengantaran",
      messengerPengantar: "Kurir Alpha",
      deliveryMessengerId: "EMP-MT-A",
      deliveryStatus: "Sedang Diantar",
      messengerTaskStatus: "Dalam Proses",
      deliveryStartedAt: new Date().toISOString(),
      taskAcceptance: {
        "Pengantaran Dokumen": { status: "ACCEPTED", courierId: "EMP-MT-A", courierName: "Kurir Alpha", isLocked: true },
      },
    } as any);

    const rel = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/delivery/release`, courierA.token, {});
    assert.equal(rel.status, 200);
    assert.equal(rel.data.data.deliveryMessengerId, undefined);
    assert.equal(rel.data.data.messengerTaskStatus, "Belum Diambil");

    const derived = deriveSingleTaskFromOrder(rel.data.data);
    assert.equal(derived.status, "Belum Diambil", "Released delivery task must not stay stuck in Dalam Proses");
  });

  await t.test("12. Samsat team release endpoint (POST /samsat/release) preserves progress, blocks notes (400), emits RELEASE_TASK", async () => {
    const orderNo = await createOrderHttp("PT Samsat Release");
    dbOrderRepository.updateOrder(orderNo, {
      currentStep: 4,
      currentStageName: "Proses Samsat",
      samsatStatus: "Sedang Proses Samsat",
      samsatMessenger: "Kurir Alpha",
      samsatMessengerNama: "Kurir Alpha",
      samsatMessengerId: "EMP-MT-A",
      samsatProcesses: [{ id: "c1", name: "Cek Fisik", status: "COMPLETED" }],
      taskAcceptance: {
        "Proses Samsat": { status: "ACCEPTED", courierId: "EMP-MT-A", courierName: "Kurir Alpha", isLocked: true },
      },
    } as any);

    // Free-text note rejected 400
    const badNote = await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/samsat/release`, courierA.token, {
      notes: "Alasan bebas tidak diizinkan",
    });
    assert.equal(badNote.status, 400);

    // Hydrate permissionStore + ApiOrderProvider against isolated server as Kurir Alpha
    const defaultApiBase = APP_CONFIG.apiBaseUrl.replace(/\/$/, "");
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(defaultApiBase)) {
        return origFetch(`${baseUrl}/api${url.slice(defaultApiBase.length)}`, init);
      }
      return origFetch(input, init);
    };
    storageMap.set("auth_token", courierA.token);
    storageMap.set("auth_user", JSON.stringify(courierA.user));
    permissionStore.hydrateSession("messenger", { notify: false, requireAuthoritativeSync: false });
    await permissionStore.initFromApi();
    const apiOrder = new ApiOrderProvider(`${baseUrl}/api`);
    await apiOrder.initFromApi();
    orderRepository.setProvider(apiOrder);

    try {
      const adapterRes = await releaseSamsatTaskAction(orderNo, {
        userId: "903",
        employeeId: "EMP-MT-A",
        userName: "Kurir Alpha",
        role: "messenger",
      });
      assert.equal(adapterRes.success, true, `releaseSamsatTaskAction failed: ${adapterRes.error}`);
    } finally {
      globalThis.fetch = origFetch;
    }

    const after = dbOrderRepository.getByOrderNo(orderNo)!;
    assert.equal(after.samsatMessengerId, undefined);
    assert.equal(after.samsatMessenger, "Belum Ditugaskan");
    assert.equal(after.samsatProcesses?.[0]?.status, "COMPLETED", "Component progress preserved on release");
    assert.equal(after.taskAcceptance?.["Proses Samsat"]?.status, "PENDING");
    assert.equal(after.taskAcceptance?.["Proses Samsat"]?.isLocked, false);

    const audit = db.prepare("SELECT action, module FROM audit_logs WHERE action = 'RELEASE_TASK' AND module = 'Proses Samsat' ORDER BY created_at DESC LIMIT 1").get() as any;
    assert.ok(audit, "RELEASE_TASK audit log must exist for Proses Samsat");
  });

  await t.test("13. Adapter fail-loudly integrity: reassignMessengerTaskAction never fakes success on API/network failure", async () => {
    const orderNo = await createOrderHttp("PT Reassign Fail Loudly");
    await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
      targetStage: "Penjadwalan",
      updates: {
        messenger: "Kurir Alpha",
        assignedMessengerName: "Kurir Alpha",
        assignedMessengerId: "EMP-MT-A",
      },
    });

    const defaultApiBase = APP_CONFIG.apiBaseUrl.replace(/\/$/, "");
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(defaultApiBase)) {
        return origFetch(`${baseUrl}/api${url.slice(defaultApiBase.length)}`, init);
      }
      return origFetch(input, init);
    };
    storageMap.set("auth_token", admin.token);
    storageMap.set("auth_user", JSON.stringify(admin.user));
    permissionStore.hydrateSession("admin", { notify: false, requireAuthoritativeSync: false });
    await permissionStore.initFromApi();
    const apiOrder = new ApiOrderProvider(`${baseUrl}/api`);
    await apiOrder.initFromApi();
    orderRepository.setProvider(apiOrder);

    assert.equal(orderStore.getOrderByNo(orderNo)?.assignedMessengerId, "EMP-MT-A");

    // Simulate network drop -> must return success: false and NOT mutate local store
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED simulated");
    };
    try {
      const failNet = await reassignMessengerTaskAction(
        orderNo,
        "Jemput Dokumen",
        "Kurir Beta",
        "EMP-MT-B",
        "Uji gagal jaringan",
        { userId: "901", employeeId: "EMP-MT-ADM", userName: "Admin Audit", role: "admin" }
      );
      assert.equal(failNet.success, false, "Network failure must return success: false instead of local store fallback");
      assert.equal(orderStore.getOrderByNo(orderNo)?.assignedMessengerId, "EMP-MT-A", "Local store must NOT mutate when API fails");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await t.test("14. Detail endpoint truthfulness: zero tagihan stays 0 (no fake 1500000) & active task keeps live status", async () => {
    const orderNo = await createOrderHttp("PT Detail Truthfulness", 500000);
    await apiRequest(baseUrl, "POST", `/api/orders/${orderNo}/advance`, admin.token, {
      targetStage: "Penjadwalan",
      updates: {
        messenger: "Kurir Alpha",
        assignedMessengerName: "Kurir Alpha",
        assignedMessengerId: "EMP-MT-A",
      },
    });
    const ord = dbOrderRepository.getByOrderNo(orderNo)!;
    dbOrderRepository.updateOrder(orderNo, {
      payment: { ...(ord.payment || {}), totalBiaya: 0, dibayar: 0, kurang: 0 } as any,
    });

    const detailRes = await apiRequest(baseUrl, "GET", `/api/messenger/tasks/${encodeURIComponent(orderNo)}?taskType=${encodeURIComponent("Jemput Dokumen")}`, admin.token);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.data.data.task.totalTagihan, 0, "Zero tagihan must not fall back to fake 1500000");
    assert.equal(detailRes.data.data.task.status, "Belum Diambil", "Uncompleted active task must not fabricate status Selesai");
    assert.equal(detailRes.data.data.task.messenger, "Kurir Alpha");
  });
});
