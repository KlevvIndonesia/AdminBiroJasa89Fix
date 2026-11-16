/**
 * Order Tracking Workflow Transitions & RBAC Integration Tests
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Verifies all 8 stages, context-aware validation, RBAC, prerequisite gating,
 * generic PUT protection, and atomic transaction handling.
 */

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { CANONICAL_PERMISSIONS } from "../server/src/config/defaultPermissions";
import { normalizeToWibCalendarDate } from "../server/src/utils/dateNormalizer";

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

async function loginUser(baseUrl: string, email: string, pass: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pass }),
  });
  const data = await res.json() as any;
  if (!data.success || !data.data?.token) {
    throw new Error(`Login failed for ${email}: ${JSON.stringify(data)}`);
  }
  return data.data.token;
}

test("Order Tracking Workflow - Comprehensive 8 Stages & RBAC Security Verification", async (t) => {
  const { server, baseUrl } = await startTestServer();

  try {
    // 0. Sync canonical sandbox permissions & authenticate test users (Admin, SVP, Messenger)
    dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
    dbPermissionRepository.saveRole("finance", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)));
    const adminToken = await loginUser(baseUrl, "admin@birojasa.com", "admin123");
    const svpToken = await loginUser(baseUrl, "svp@birojasa.com", "admin123");
    const courierToken = await loginUser(baseUrl, "budi.messenger@birojasa.com", "messenger123");

    // 1. Create a pristine test order starting at Stage 1 (Verifikasi)
    const orderNo = `ORD-TEST-${Date.now()}`;
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        orderNo,
        customer: "Budi Transisi",
        nomorHP: "081234567899",
        nopol: "B 8888 TRN",
        layanan: "Perpanjangan STNK Tahunan",
        wilayahSamsatAsal: "Jakarta Timur",
        totalEstimasi: 500000,
        biayaSamsat: 350000,
        biayaJasa: 150000,
        metodeLayanan: "Antar Jemput Dokumen",
        payment: {
          tipePembayaran: "Bayar di Akhir",
          statusPembayaran: "Belum Bayar",
          totalBiaya: 500000,
          dibayar: 0,
          kurang: 500000,
        },
      }),
    });

    assert.strictEqual(createRes.status, 201, "Order creation should succeed");
    const createData = (await createRes.json()) as any;
    const actualOrderNo = createData.data.orderNo;
    assert.ok(actualOrderNo, "Canonical orderNo must be returned");
    assert.strictEqual(createData.data.currentStep, 1);
    assert.strictEqual(createData.data.currentStageName, "Verifikasi");

    // =========================================================================
    // SECURITY GUARD: Generic PUT /api/orders/:orderNo MUST reject protected fields
    // =========================================================================
    const genericPutRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        isVerified: true,
        currentStep: 5,
        finalCost: 1000000,
      }),
    });
    assert.strictEqual(
      genericPutRes.status,
      403,
      "Generic PUT must reject protected fields (isVerified, currentStep, finalCost)"
    );

    // Generic PUT MUST ALSO reject operational completion / forged status fields
    const forgedPutCases: Array<[string, Record<string, any>]> = [
      ["pickupCompleted: true", { pickupCompleted: true }],
      ["messengerTaskStatus: Dokumen Sudah Tersedia", { messengerTaskStatus: "Dokumen Sudah Tersedia" }],
      ["isScheduled: true without scheduling payload", { isScheduled: true }],
      ["samsatStatus: Selesai", { samsatStatus: "Selesai" }],
      ["samsatPickupStatus: Dokumen Samsat Diterima di Kantor", { samsatPickupStatus: "Dokumen Samsat Diterima di Kantor" }],
      ["deliveryStatus: Dokumen Diserahkan", { deliveryStatus: "Dokumen Diserahkan" }],
      ["isReceived: true", { isReceived: true }],
    ];
    for (const [label, bodyPayload] of forgedPutCases) {
      const forgedRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(bodyPayload),
      });
      assert.strictEqual(forgedRes.status, 403, `Generic PUT must reject ${label} with 403 PROTECTED_FIELD_VIOLATION`);
      const forgedData = (await forgedRes.json()) as any;
      assert.strictEqual(forgedData.error?.code, "PROTECTED_FIELD_VIOLATION");
    }

    // =========================================================================
    // SECURITY GUARD: Illegal forward jump (Step 1 -> Step 4 or Step 6) must fail
    // =========================================================================
    const illegalJumpRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Proses Samsat",
      }),
    });
    assert.strictEqual(illegalJumpRes.status, 400, "Skipping stages (1 -> 4) must be rejected");
    const illegalJumpData = (await illegalJumpRes.json()) as any;
    assert.strictEqual(illegalJumpData.error.code, "INVALID_STAGE_TRANSITION");

    // Database state assertion: verifying no mutation occurred after illegal jump rejection
    const dbRowAfterFailedJump = db.prepare("SELECT current_step, current_stage_name FROM orders WHERE order_no = ?").get(actualOrderNo) as any;
    assert.strictEqual(dbRowAfterFailedJump.current_step, 1, "DB current_step must remain 1 after failed jump");
    assert.strictEqual(dbRowAfterFailedJump.current_stage_name, "Verifikasi", "DB current_stage_name must remain Verifikasi");

    // =========================================================================
    // SECURITY GUARD: Advance endpoint must reject client forged lifecycle keys
    // =========================================================================
    const forgedLifecycleRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Penjadwalan",
        updates: {
          currentStep: 99,
          isCancelled: true,
        },
      }),
    });
    assert.strictEqual(forgedLifecycleRes.status, 403, "Client forged currentStep/isCancelled must be rejected");

    // =========================================================================
    // TRANSITION 1 -> 2: Verifikasi -> Penjadwalan (Assign real Courier EMP-0004)
    // =========================================================================
    const step1to2Res = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Penjadwalan",
        updates: {
          isVerified: true,
          tanggalJemput: "2026-11-10",
          messenger: "Budi Santoso",
          assignedMessengerName: "Budi Santoso",
          assignedMessengerId: "EMP-0004",
          catatanPenjadwalan: "Jemput di kantor customer jam 10",
        },
      }),
    });
    assert.strictEqual(step1to2Res.status, 200, "Advance Step 1 -> 2 must succeed");
    const step1to2Data = (await step1to2Res.json()) as any;
    assert.strictEqual(step1to2Data.data.currentStep, 2);
    assert.strictEqual(step1to2Data.data.currentStageName, "Penjadwalan");
    assert.strictEqual(step1to2Data.data.isVerified, true);
    assert.strictEqual(step1to2Data.data.messenger, "Budi Santoso");

    // Legitimate Admin PUT scheduling update (with date & messenger) MUST remain allowed
    const legitPutScheduleRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        isScheduled: true,
        messengerTaskStatus: "Terjadwal Jemput",
        tanggalJemput: "2026-11-10",
        assignedMessengerId: "EMP-0004",
        assignedMessengerName: "Budi Santoso",
      }),
    });
    assert.strictEqual(legitPutScheduleRes.status, 200, "Legitimate Admin PUT scheduling must remain allowed");

    // =========================================================================
    // TRANSITION 2 -> 3: Penjadwalan -> Verifikasi Dokumen
    // Prerequisite: DB pickupCompleted required; client forged updates.pickupCompleted MUST NOT bypass!
    // =========================================================================
    const step2to3ForgedRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Verifikasi Dokumen",
        updates: { pickupCompleted: true, messengerTaskStatus: "Dokumen Sudah Tersedia" },
      }),
    });
    assert.strictEqual(step2to3ForgedRes.status, 400, "Step 2 -> 3 with forged client pickupCompleted without DB completion must be rejected");
    const step2to3ForgedData = (await step2to3ForgedRes.json()) as any;
    assert.strictEqual(step2to3ForgedData.error.code, "PREREQUISITE_NOT_MET");

    // Execute real courier pickup flow: start -> complete
    const pickupStartRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/pickup/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierToken}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(pickupStartRes.status, 200, "Courier start pickup must succeed");

    const pickupCompleteRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/pickup/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierToken}` },
      body: JSON.stringify({ pickupChecklist: { stnkAsli: true, bpkbAsli: true, ktpAsli: true } }),
    });
    assert.strictEqual(pickupCompleteRes.status, 200, "Courier complete pickup must succeed");

    // Advance Step 2 -> 3 now that DB confirms pickupCompleted
    const step2to3Res = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Verifikasi Dokumen",
        updates: {},
      }),
    });
    assert.strictEqual(step2to3Res.status, 200, "Advance Step 2 -> 3 after real DB pickup completion must succeed");
    const step2to3Data = (await step2to3Res.json()) as any;
    assert.strictEqual(step2to3Data.data.currentStep, 3);
    assert.strictEqual(step2to3Data.data.currentStageName, "Verifikasi Dokumen");

    // =========================================================================
    // TRANSITION 3 -> 4: Verifikasi Dokumen -> Proses Samsat
    // Prerequisite: documentsVerified required!
    // =========================================================================
    const step3to4NoDocsRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Proses Samsat",
        updates: {},
      }),
    });
    assert.strictEqual(step3to4NoDocsRes.status, 400, "Step 3 -> 4 without documentsVerified must be rejected");

    const step3to4Res = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Proses Samsat",
        updates: {
          documentsVerified: true,
          samsatMessengerId: "EMP-0004",
          samsatMessengerName: "Budi Santoso",
          samsatProcesses: [
            { id: "comp-1", name: "Pendaftaran Samsat", status: "COMPLETED" },
            { id: "comp-2", name: "Kasir Pembayaran", status: "COMPLETED" },
          ],
        },
      }),
    });
    assert.strictEqual(step3to4Res.status, 200, "Advance Step 3 -> 4 must succeed");
    const step3to4Data = (await step3to4Res.json()) as any;
    assert.strictEqual(step3to4Data.data.currentStep, 4);
    assert.strictEqual(step3to4Data.data.currentStageName, "Proses Samsat");

    // =========================================================================
    // TRANSITION 4 -> 5: Proses Samsat -> Verifikasi Ulang
    // Must enforce DB Samsat completion + Jemput Hasil Samsat (reject forged flags!)
    // =========================================================================
    const step4to5ForgedRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Verifikasi Ulang",
        updates: {
          samsatStatus: "Selesai",
          samsatPickupStatus: "Dokumen Samsat Diterima di Kantor",
        },
      }),
    });
    assert.strictEqual(step4to5ForgedRes.status, 400, "Forged client samsatStatus/samsatPickupStatus without DB completion must be rejected (400)");

    // Complete Samsat + Schedule & Complete Jemput Hasil Samsat via real endpoints
    const samsatCompRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/samsat/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierToken}` },
      body: JSON.stringify({
        components: [
          { id: "comp-1", name: "Pendaftaran Samsat", status: "COMPLETED", isCompleted: true },
          { id: "comp-2", name: "Kasir Pembayaran", status: "COMPLETED", isCompleted: true },
        ],
      }),
    });
    assert.strictEqual(samsatCompRes.status, 200, "Samsat complete must succeed");

    // Still cannot advance Stage 4 -> 5 BEFORE Jemput Hasil Samsat finishes!
    const step4to5BeforePickupRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ targetStage: "Verifikasi Ulang", updates: {} }),
    });
    assert.strictEqual(step4to5BeforePickupRes.status, 400, "Stage 4 -> 5 must require Jemput Hasil Samsat completion in DB");

    // Schedule, accept & complete Jemput Hasil Samsat
    const schedJemputRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        samsatPickupStatus: "Terjadwal Jemput Samsat",
        samsatPickupDate: "2026-11-11",
        samsatPickupMessenger: "Budi Santoso",
        samsatPickupMessengerId: "EMP-0004",
      }),
    });
    assert.strictEqual(schedJemputRes.status, 200);

    const accJemputRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/tasks/${encodeURIComponent("Jemput Hasil Samsat")}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierToken}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(accJemputRes.status, 200);

    const compJemputRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/samsat-pickup/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierToken}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(compJemputRes.status, 200);

    const step4to5Res = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ targetStage: "Verifikasi Ulang", updates: {} }),
    });
    assert.strictEqual(step4to5Res.status, 200, "Advance Step 4 -> 5 after real DB Samsat + pickup must succeed");
    const step4to5Data = (await step4to5Res.json()) as any;
    assert.strictEqual(step4to5Data.data.currentStep, 5);
    assert.strictEqual(step4to5Data.data.currentStageName, "Verifikasi Ulang");

    // =========================================================================
    // TRANSITION 5 -> 6: Verifikasi Ulang -> Supervisi
    // Prerequisite: documentApproval.stage5Verified or documentsVerified
    // =========================================================================
    const step5to6Res = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Supervisi",
        updates: {
          finalCost: 520000,
          biayaSamsat: 370000,
          biayaJasa: 150000,
          documentsVerified: true,
          documentApproval: {
            stage5Verified: true,
            stage5VerifiedBy: "Admin Loket",
            stage5VerifiedAt: new Date().toISOString(),
          },
        },
      }),
    });
    assert.strictEqual(step5to6Res.status, 200, "Advance Step 5 -> 6 must succeed");
    const step5to6Data = (await step5to6Res.json()) as any;
    assert.strictEqual(step5to6Data.data.currentStep, 6);
    assert.strictEqual(step5to6Data.data.currentStageName, "Supervisi");
    assert.strictEqual(step5to6Data.data.finalCost, 520000);

    // =========================================================================
    // TRANSITION 6 -> 7: Supervisi -> Pengantaran
    // Final Policy: Stage 6 (Supervisi) is STRICTLY SVP-ONLY!
    // Admin MUST receive 403 FORBIDDEN on Stage 6; SVP succeeds with 200.
    // =========================================================================
    const adminStage6Res = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ targetStage: "Pengantaran", updates: { approvedBySpv: true } }),
    });
    assert.strictEqual(adminStage6Res.status, 403, "Admin must receive 403 at Stage 6 Supervisi (SVP-only)");
    const adminStage6Data = (await adminStage6Res.json()) as any;
    assert.strictEqual(adminStage6Data.error.code, "FORBIDDEN");

    // SVP approves Stage 6 Supervisi & advances Stage 6 -> Stage 7
    const step6to7SvpRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpToken}`,
      },
      body: JSON.stringify({
        targetStage: "Pengantaran",
        updates: {
          approvedBySpv: true,
          tanggalPengantaran: "2026-11-12",
          messengerPengantar: "Budi Santoso",
          deliveryMessengerId: "EMP-0004",
          deliveryMessengerName: "Budi Santoso",
        },
      }),
    });
    assert.strictEqual(step6to7SvpRes.status, 200, "SVP advancing Step 6 -> 7 must succeed");
    const step6to7Data = (await step6to7SvpRes.json()) as any;
    assert.strictEqual(step6to7Data.data.currentStep, 7);
    assert.strictEqual(step6to7Data.data.currentStageName, "Pengantaran");
    assert.strictEqual(step6to7Data.data.approvedBySpv, true);
    assert.ok(step6to7Data.data.spvApprovedAt, "spvApprovedAt must be populated by server");

    // =========================================================================
    // TRANSITION 7 -> 8: Pengantaran -> Dokumen Telah Diterima
    // Forged updates.isReceived without DB delivery completion MUST fail with 400!
    // =========================================================================
    const step7to8ForgedRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Dokumen Telah Diterima",
        updates: {
          isReceived: true,
          deliveryStatus: "Dokumen Diserahkan",
          receiverName: "Budi Customer",
        },
      }),
    });
    assert.strictEqual(step7to8ForgedRes.status, 400, "Forged updates.isReceived without DB delivery completion must fail (400)");

    // Complete delivery via real /delivery/complete endpoint (Admin/Courier/SVP supported)
    const completeDeliveryRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/delivery/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        receiverName: "Budi Customer",
      }),
    });
    assert.strictEqual(completeDeliveryRes.status, 200, "Completing delivery via /delivery/complete must succeed");

    const step7to8Res = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Dokumen Telah Diterima",
        updates: {},
      }),
    });
    assert.strictEqual(step7to8Res.status, 200, "Advance Step 7 -> 8 after DB delivery completion must succeed");
    const step7to8Data = (await step7to8Res.json()) as any;
    assert.strictEqual(step7to8Data.data.currentStep, 8);
    assert.strictEqual(step7to8Data.data.currentStageName, "Dokumen Telah Diterima");
    assert.strictEqual(step7to8Data.data.isReceived, true);

    // WIB date consistency assertion: utc-midnight edge normalizes cleanly to Asia/Jakarta calendar date
    assert.strictEqual(normalizeToWibCalendarDate("2026-11-10T20:30:00.000Z"), "2026-11-11", "Late UTC converts to next WIB date");

    // =========================================================================
    // FINAL ARCHIVING: Stage 8 -> Arsip via POST /orders/:orderNo/archive
    // =========================================================================
    const archiveRes = await fetch(`${baseUrl}/api/orders/${actualOrderNo}/archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    assert.strictEqual(archiveRes.status, 200, "Archiving order must succeed via /archive endpoint");
    const archiveData = (await archiveRes.json()) as any;
    assert.strictEqual(archiveData.success, true);

    // Verify order is now archived in GET /api/orders/archived
    const archivedListRes = await fetch(`${baseUrl}/api/orders/archived`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const archivedListData = (await archivedListRes.json()) as any;
    const isFoundInArchive = archivedListData.data.some((o: any) => o.orderNo === actualOrderNo);
    assert.strictEqual(isFoundInArchive, true, "Archived order must appear in archived list");

    // =========================================================================
    // DATANG LANGSUNG SHORTCUT: Step 1 -> Step 3
    // =========================================================================
    const directOrderNo = `ORD-DIRECT-${Date.now()}`;
    const directCreateRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        customer: "Siti Langsung",
        nomorHP: "081299991111",
        nopol: "B 1234 DIR",
        layanan: "Balik Nama Kendaraan",
        wilayahSamsatAsal: "Jakarta Selatan",
        metodeLayanan: "Datang Langsung",
        totalEstimasi: 750000,
        biayaSamsat: 550000,
        biayaJasa: 200000,
      }),
    });
    const directCreateData = (await directCreateRes.json()) as any;
    const actualDirectOrderNo = directCreateData.data.orderNo;

    // Verify order created with Datang Langsung is automatically initialized at Step 3 (Verifikasi Dokumen)
    assert.strictEqual(directCreateData.data.currentStep, 3, "Datang Langsung starts at Step 3");
    assert.strictEqual(directCreateData.data.currentStageName, "Verifikasi Dokumen");

    // Also test: an order starting at Stage 1 switching to Datang Langsung and advancing 1 -> 3
    const switchOrderRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        customer: "Tono Beralih",
        nomorHP: "081299992222",
        nopol: "B 5678 SWH",
        layanan: "Perpanjangan STNK Tahunan",
        wilayahSamsatAsal: "Jakarta Barat",
        metodeLayanan: "Antar Jemput Dokumen",
        totalEstimasi: 500000,
        biayaSamsat: 350000,
        biayaJasa: 150000,
      }),
    });
    const switchOrderData = (await switchOrderRes.json()) as any;
    const switchOrderNo = switchOrderData.data.orderNo;
    assert.strictEqual(switchOrderData.data.currentStep, 1);

    // Forging updates.metodeLayanan = 'Datang Langsung' during /advance on an 'Antar Jemput' DB order MUST be rejected (400)
    const forgedSwitchRes = await fetch(`${baseUrl}/api/orders/${switchOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Verifikasi Dokumen",
        updates: {
          metodeLayanan: "Datang Langsung",
          isVerified: true,
          pickupCompleted: true,
        },
      }),
    });
    assert.strictEqual(forgedSwitchRes.status, 400, "Client forged updates.metodeLayanan in /advance must NOT bypass Stage 2");

    // Legitimately update metodeLayanan in DB via PUT, then Stage 1 -> 3 succeeds
    const putSwitchRes = await fetch(`${baseUrl}/api/orders/${switchOrderNo}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ metodeLayanan: "Datang Langsung" }),
    });
    assert.strictEqual(putSwitchRes.status, 200);

    const switchAdvanceRes = await fetch(`${baseUrl}/api/orders/${switchOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Verifikasi Dokumen",
        updates: {
          isVerified: true,
        },
      }),
    });
    assert.strictEqual(switchAdvanceRes.status, 200, "Advancing 1 -> 3 after DB record confirms Datang Langsung must succeed");
    const switchData = (await switchAdvanceRes.json()) as any;
    assert.strictEqual(switchData.data.currentStep, 3);
    assert.strictEqual(switchData.data.currentStageName, "Verifikasi Dokumen");

  } finally {
    server.close();
  }
});

test("Order Workflow - Extended Boundary Validations, Concurrency, and DB Persistence Verification", async (t) => {
  const { server, baseUrl } = await startTestServer();

  try {
    const adminToken = await loginUser(baseUrl, "admin@birojasa.com", "admin123");

    // 1. Create a pristine test order starting at Step 1 (Verifikasi)
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        customer: "Budi Validasi",
        nomorHP: "081288887777",
        nopol: "B 1234 VAL",
        layanan: "Perpanjangan STNK Tahunan",
        wilayahSamsatAsal: "Jakarta Selatan",
        totalEstimasi: 500000,
        biayaSamsat: 350000,
        biayaJasa: 150000,
        metodeLayanan: "Antar Jemput Dokumen",
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const createData = await createRes.json() as any;
    const orderNo = createData.data.orderNo;
    assert.ok(orderNo);
    const initialRow = db.prepare("SELECT current_step, current_stage_name, updated_at FROM orders WHERE order_no = ?").get(orderNo) as any;
    assert.strictEqual(initialRow.current_step, 1);
    assert.strictEqual(initialRow.current_stage_name, "Verifikasi");

    // SCENARIO: Validasi Gagal Tidak Meninggalkan Perubahan Parsial (DB Assertion)
    const initialAuditCount = (db.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE action = 'ADVANCE_STAGE' AND metadata_json LIKE ?").get(`%${orderNo}%`) as any).count;
    const failRes = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Proses Samsat",
        updates: {
          catatanPenjadwalan: "Catatan Tidak Sah Yang Tidak Boleh Tersimpan",
        },
      }),
    });
    assert.strictEqual(failRes.status, 400);
    const failData = await failRes.json() as any;
    assert.strictEqual(failData.error.code, "INVALID_STAGE_TRANSITION");

    // DB Assertions: current_step, current_stage_name, updated_at, data_json, audit logs
    const rowAfterFail = db.prepare("SELECT current_step, current_stage_name, updated_at, data_json FROM orders WHERE order_no = ?").get(orderNo) as any;
    assert.strictEqual(rowAfterFail.current_step, 1, "current_step must remain 1 in database");
    assert.strictEqual(rowAfterFail.current_stage_name, "Verifikasi", "current_stage_name must remain Verifikasi in database");
    assert.strictEqual(rowAfterFail.updated_at, initialRow.updated_at, "updated_at must remain unchanged in database");
    const parsedDataJson = JSON.parse(rowAfterFail.data_json || "{}");
    assert.strictEqual(parsedDataJson.catatanPenjadwalan, undefined, "Illegal update must not be persisted into data_json");
    const afterFailAuditCount = (db.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE action = 'ADVANCE_STAGE' AND metadata_json LIKE ?").get(`%${orderNo}%`) as any).count;
    assert.strictEqual(afterFailAuditCount, initialAuditCount, "Audit log must not record failed advance");

    // SCENARIO: Tahap 1 -> Tahap 2 (Valid Sequential Advance)
    const step1to2Res = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Penjadwalan",
        updates: { isVerified: true, messenger: "Kurir Penguji" },
      }),
    });
    assert.strictEqual(step1to2Res.status, 200);
    const rowStep2 = db.prepare("SELECT current_step, current_stage_name FROM orders WHERE order_no = ?").get(orderNo) as any;
    assert.strictEqual(rowStep2.current_step, 2);
    assert.strictEqual(rowStep2.current_stage_name, "Penjadwalan");

    // SCENARIO: Tahap yang sama (Idempotency Rule)
    const idempotentRes = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Penjadwalan",
        updates: { catatanPenjadwalan: "Update catatan di tahap yang sama" },
      }),
    });
    assert.strictEqual(idempotentRes.status, 200, "Same stage advance must be accepted idempotently");
    const idempotentData = await idempotentRes.json() as any;
    assert.strictEqual(idempotentData.data.currentStep, 2);
    assert.strictEqual(idempotentData.data.currentStageName, "Penjadwalan");
    const rowIdempotent = db.prepare("SELECT current_step, current_stage_name, data_json FROM orders WHERE order_no = ?").get(orderNo) as any;
    assert.strictEqual(rowIdempotent.current_step, 2);
    assert.strictEqual(rowIdempotent.current_stage_name, "Penjadwalan");
    assert.ok(rowIdempotent.data_json.includes("Update catatan di tahap yang sama"));

    // SCENARIO: Transisi Mundur via /advance Ditolak (Harus via /rollback)
    const backwardAdvanceRes = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Verifikasi",
      }),
    });
    assert.strictEqual(backwardAdvanceRes.status, 400, "Backward transition via /advance must be rejected");
    const backwardAdvanceData = await backwardAdvanceRes.json() as any;
    assert.strictEqual(backwardAdvanceData.error.code, "INVALID_STAGE_TRANSITION");

    // SCENARIO: Transisi Mundur via /rollback Berhasil (Existing Business Rules)
    const rollbackRes = await fetch(`${baseUrl}/api/orders/${orderNo}/rollback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Verifikasi",
        updates: { catatan: "Rollback ke Verifikasi untuk pengecekan ulang" },
      }),
    });
    assert.strictEqual(rollbackRes.status, 200, "Valid rollback via /rollback must succeed");
    const rowRollback = db.prepare("SELECT current_step, current_stage_name FROM orders WHERE order_no = ?").get(orderNo) as any;
    assert.strictEqual(rowRollback.current_step, 1);
    assert.strictEqual(rowRollback.current_stage_name, "Verifikasi");

    // SCENARIO: Order Dibatalkan (Cannot be advanced)
    const cancelRes = await fetch(`${baseUrl}/api/orders/${orderNo}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        reason: "Customer membatalkan permintaan layanan",
      }),
    });
    assert.strictEqual(cancelRes.status, 200);
    const advanceCancelledRes = await fetch(`${baseUrl}/api/orders/${orderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Penjadwalan",
      }),
    });
    assert.strictEqual(advanceCancelledRes.status, 400);
    const advanceCancelledData = await advanceCancelledRes.json() as any;
    assert.strictEqual(advanceCancelledData.error.code, "ORDER_CANCELLED");

    // SCENARIO: Order Tidak Ditemukan (404)
    const ghostRes = await fetch(`${baseUrl}/api/orders/ORD-GHOST-NOT-FOUND/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Penjadwalan",
      }),
    });
    assert.strictEqual(ghostRes.status, 404);
    const ghostData = await ghostRes.json() as any;
    assert.strictEqual(ghostData.error.code, "ORDER_NOT_FOUND");

    // SCENARIO: Order Selesai (Terminal Step 8 Cannot Advance Further)
    const completedOrderNo = `ORD-COMPL-${Date.now()}`;
    db.prepare(`
      INSERT INTO orders (order_no, customer, nomor_hp, layanan, nopol, current_step, current_stage_name, payment_status, total_biaya, data_json, created_at, updated_at)
      VALUES (?, 'Customer Selesai', '081299998888', 'Perpanjangan 1 Tahun', 'B 9999 FIN', 8, 'Dokumen Telah Diterima', 'Lunas', 500000, '{"currentStep":8,"currentStageName":"Dokumen Telah Diterima"}', datetime('now'), datetime('now'))
    `).run(completedOrderNo);

    const advanceCompletedRes = await fetch(`${baseUrl}/api/orders/${completedOrderNo}/advance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        targetStage: "Pengantaran",
      }),
    });
    assert.strictEqual(advanceCompletedRes.status, 400, "Completed order cannot advance to another stage");
    const advanceCompletedData = await advanceCompletedRes.json() as any;
    assert.strictEqual(advanceCompletedData.error.code, "INVALID_STAGE_TRANSITION");

    // SCENARIO: Dua Request Bersamaan (Concurrency & Atomicity Check)
    const concCreateRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        customer: "Customer Konkuren",
        nomorHP: "081211110000",
        nopol: "B 1010 CNC",
        layanan: "Perpanjangan STNK Tahunan",
        totalEstimasi: 500000,
        biayaSamsat: 350000,
        biayaJasa: 150000,
      }),
    });
    assert.strictEqual(concCreateRes.status, 201);
    const concCreateData = await concCreateRes.json() as any;
    const concOrderNo = concCreateData.data.orderNo;
    assert.ok(concOrderNo);

    const [concRes1, concRes2] = await Promise.all([
      fetch(`${baseUrl}/api/orders/${concOrderNo}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ targetStage: "Penjadwalan", updates: { isVerified: true, messenger: "Kurir Alpha" } }),
      }),
      fetch(`${baseUrl}/api/orders/${concOrderNo}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ targetStage: "Penjadwalan", updates: { isVerified: true, messenger: "Kurir Beta" } }),
      }),
    ]);
    assert.strictEqual(concRes1.status, 200, "First concurrent request must succeed");
    assert.strictEqual(concRes2.status, 200, "Second concurrent request must succeed (idempotent same stage)");
    const concDbRow = db.prepare("SELECT current_step, current_stage_name FROM orders WHERE order_no = ?").get(concOrderNo) as any;
    assert.strictEqual(concDbRow.current_step, 2, "DB state must strictly be Step 2 after concurrent requests");
    assert.strictEqual(concDbRow.current_stage_name, "Penjadwalan");

  } finally {
    server.close();
  }
});
