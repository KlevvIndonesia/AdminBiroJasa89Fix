import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { APP_CONFIG } from "../src/app/config/appConfig";
import { orderStore } from "../src/app/data/orderStore";
import { orderRepository } from "../src/data/repositories/orderRepository";
import { ApiOrderProvider } from "../src/data/api/apiOrderProvider";
import { dbPermissionRepository } from "../server/src/repositories/dbPermissionRepository";
import { CANONICAL_PERMISSIONS } from "../server/src/config/defaultPermissions";

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
  const data = (await res.json()) as any;
  if (!data.success || !data.data?.token) {
    throw new Error(`Login failed for ${email}: ${JSON.stringify(data)}`);
  }
  return { token: data.data.token, user: data.data.user };
}

test("Order Workflow - Complete Stage 1 to Stage 8 lifecycle & Archive via ApiOrderProvider", async (t) => {
  const { server, baseUrl } = await startTestServer();
  const originalApiBaseUrl = APP_CONFIG.apiBaseUrl;
  const originalProvider = orderRepository.getProvider();
  APP_CONFIG.apiBaseUrl = `${baseUrl}/api`;
  orderRepository.setProvider(new ApiOrderProvider(`${baseUrl}/api`));

  t.after(() => {
    APP_CONFIG.apiBaseUrl = originalApiBaseUrl;
    orderRepository.setProvider(originalProvider);
    server.close();
  });

  dbPermissionRepository.saveRole("admin", JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)));
  const adminAuth = await loginUser(baseUrl, "admin@birojasa.com", "admin123");
  const svpAuth = await loginUser(baseUrl, "svp@birojasa.com", "admin123");
  const courierAuth = await loginUser(baseUrl, "budi.messenger@birojasa.com", "messenger123");

  mockStorage.setItem("auth_token", adminAuth.token);
  mockStorage.setItem("auth_user", JSON.stringify(adminAuth.user));

  // 1. BUAT ORDER: Stage 1 (Verifikasi)
  const createdOrder = await orderStore.addOrderAsync({
    customer: "Workflow Hero",
    namaPemilik: "Workflow Hero",
    nomorHP: "081234567890",
    nopol: "B 7777 WFL",
    layanan: "Mutasi Antar Samsat",
    wilayahSamsatAsal: "Jakarta Timur",
    wilayahSamsatTujuan: "Jakarta Barat",
    nominalPkbTerakhir: 300000,
    metodeLayanan: "Antar Jemput Dokumen",
    payment: {
      tipePembayaran: "Bayar di Akhir",
      metodePembayaran: "Cash",
      statusPembayaran: "Belum Bayar",
      totalBiaya: 493000,
      dibayar: 0,
      kurang: 493000,
    },
  });

  const orderNo = createdOrder.orderNo;
  assert.ok(orderNo, "Order number should be generated");
  assert.strictEqual(createdOrder.currentStageName, "Verifikasi");
  assert.strictEqual(createdOrder.currentStep, 1);

  // STAGE 1 -> STAGE 2: Penjadwalan
  const s1Result = await orderStore.advanceOrderAsync(orderNo, "Penjadwalan", {
    tanggalJemput: "2026-10-05",
    waktuPenjadwalan: "09:00",
    messenger: "Budi Santoso",
    assignedMessengerName: "Budi Santoso",
    assignedMessengerId: courierAuth.user.employeeId || "EMP-0004",
  });
  assert.ok(s1Result && typeof s1Result === "object", "Advance to Stage 2 should succeed");
  let currentOrder = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(currentOrder?.currentStageName, "Penjadwalan");
  assert.strictEqual(currentOrder?.currentStep, 2);

  // Courier real pickup execution (required DB prerequisite for Stage 2 -> 3)
  const acceptJemputRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}/tasks/${encodeURIComponent("Jemput Dokumen")}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
    body: JSON.stringify({}),
  });
  const acceptJemputJson = await acceptJemputRes.json();
  assert.strictEqual(acceptJemputRes.status, 200, `accept Jemput Dokumen failed: ${JSON.stringify(acceptJemputJson)}`);

  const pickupStartRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}/pickup/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
    body: JSON.stringify({}),
  });
  const pickupStartJson = await pickupStartRes.json();
  assert.strictEqual(pickupStartRes.status, 200, `pickup/start failed: ${JSON.stringify(pickupStartJson)}`);

  const pickupCompleteRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}/pickup/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
    body: JSON.stringify({ checklist: { stnkAsli: true } }),
  });
  const pickupCompleteJson = await pickupCompleteRes.json();
  assert.strictEqual(pickupCompleteRes.status, 200, `pickup/complete failed: ${JSON.stringify(pickupCompleteJson)}`);

  // STAGE 2 -> STAGE 3: Verifikasi Dokumen
  const s2Result = await orderStore.advanceOrderAsync(orderNo, "Verifikasi Dokumen", {
    statusVerifikasiDokumen: "Lengkap",
    catatanOrder: "Semua dokumen fisik telah diterima dari messenger",
  });
  assert.ok(s2Result && typeof s2Result === "object", "Advance to Stage 3 should succeed");
  currentOrder = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(currentOrder?.currentStageName, "Verifikasi Dokumen");
  assert.strictEqual(currentOrder?.currentStep, 3);

  // STAGE 3 -> STAGE 4: Proses Samsat
  const s3Result = await orderStore.advanceOrderAsync(orderNo, "Proses Samsat", {
    documentsVerified: true,
    samsatMessengerId: "EMP-0004",
    samsatMessengerName: "Budi Santoso",
    samsatProcesses: [{ id: "comp-1", name: "Cek Fisik", status: "COMPLETED" }],
  });
  assert.ok(s3Result && typeof s3Result === "object", "Advance to Stage 4 should succeed");
  currentOrder = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(currentOrder?.currentStageName, "Proses Samsat");
  assert.strictEqual(currentOrder?.currentStep, 4);

  // Complete Samsat + Jemput Hasil Samsat (required DB prerequisite for Stage 4 -> 5)
  const acceptSamsatRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}/tasks/${encodeURIComponent("Proses Samsat")}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
    body: JSON.stringify({}),
  });
  const acceptSamsatJson = await acceptSamsatRes.json();
  assert.strictEqual(acceptSamsatRes.status, 200, `accept Proses Samsat failed: ${JSON.stringify(acceptSamsatJson)}`);

  const samsatCompleteRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}/samsat/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
    body: JSON.stringify({}),
  });
  const samsatCompleteJson = await samsatCompleteRes.json();
  assert.strictEqual(samsatCompleteRes.status, 200, `samsat/complete failed: ${JSON.stringify(samsatCompleteJson)}`);

  const assignPickupRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
    body: JSON.stringify({
      samsatPickupDate: "2026-10-06",
      samsatPickupMessenger: "Budi Santoso",
      samsatPickupMessengerId: "EMP-0004",
    }),
  });
  const assignPickupJson = await assignPickupRes.json();
  assert.strictEqual(assignPickupRes.status, 200, `PUT samsatPickup failed: ${JSON.stringify(assignPickupJson)}`);

  const acceptPickupRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}/tasks/${encodeURIComponent("Jemput Hasil Samsat")}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
    body: JSON.stringify({}),
  });
  const acceptPickupJson = await acceptPickupRes.json();
  assert.strictEqual(acceptPickupRes.status, 200, `accept Jemput Hasil Samsat failed: ${JSON.stringify(acceptPickupJson)}`);

  const samsatPickupRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(orderNo)}/samsat-pickup/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
    body: JSON.stringify({}),
  });
  const samsatPickupJson = await samsatPickupRes.json();
  assert.strictEqual(samsatPickupRes.status, 200, `samsat-pickup/complete failed: ${JSON.stringify(samsatPickupJson)}`);

  // STAGE 4 -> STAGE 5: Verifikasi Ulang
  const s4Result = await orderStore.advanceOrderAsync(orderNo, "Verifikasi Ulang", {});
  assert.ok(s4Result && typeof s4Result === "object", "Advance to Stage 5 should succeed");
  currentOrder = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(currentOrder?.currentStageName, "Verifikasi Ulang");
  assert.strictEqual(currentOrder?.currentStep, 5);

  // STAGE 5 -> STAGE 6: Supervisi
  const s5Result = await orderStore.advanceOrderAsync(orderNo, "Supervisi", {
    verifiedBy: "Admin Operasional",
    documentsVerified: true,
    documentApproval: {
      stage5Verified: true,
      stage5VerifiedBy: "Admin Operasional",
      stage5VerifiedAt: new Date().toISOString(),
    },
  });
  assert.ok(s5Result && typeof s5Result === "object", "Advance to Stage 6 should succeed");
  currentOrder = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(currentOrder?.currentStageName, "Supervisi");
  assert.strictEqual(currentOrder?.currentStep, 6);

  // STAGE 6 -> STAGE 7: Pengantaran (Stage 6 Supervisi is STRICTLY SVP-ONLY!)
  await assert.rejects(
    () =>
      orderStore.advanceOrderAsync(orderNo, "Pengantaran", {
        approvedBySpv: true,
        messengerPengantar: "Budi Santoso",
        deliveryMessengerId: "EMP-0004",
        deliveryMessengerName: "Budi Santoso",
      }),
    /SVP|Supervisi|403/i,
    "Admin must be rejected at Stage 6 Supervisi (SVP-only)"
  );

  // Switch session to SVP for Stage 6 Supervisi approval
  mockStorage.setItem("auth_token", svpAuth.token);
  mockStorage.setItem("auth_user", JSON.stringify(svpAuth.user));
  const s6Result = await orderStore.advanceOrderAsync(orderNo, "Pengantaran", {
    approvedBySpv: true,
    messengerPengantar: "Budi Santoso",
    deliveryMessengerId: "EMP-0004",
    deliveryMessengerName: "Budi Santoso",
  });
  assert.ok(s6Result && typeof s6Result === "object", "Advance to Stage 7 should succeed for SVP");
  currentOrder = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(currentOrder?.currentStageName, "Pengantaran");
  assert.strictEqual(currentOrder?.currentStep, 7);

  // Restore Admin session for Stage 7 -> Stage 8 and Archive
  mockStorage.setItem("auth_token", adminAuth.token);
  mockStorage.setItem("auth_user", JSON.stringify(adminAuth.user));

  // Direct delivery completion + STAGE 7 -> STAGE 8: Dokumen Telah Diterima
  await orderStore.completeDeliveryDirectAsync(orderNo, { receiverName: "Workflow Hero Sendiri" });
  const s7Result = await orderStore.advanceOrderAsync(orderNo, "Dokumen Telah Diterima", {
    catatanOrder: "Dokumen telah diserahkan dan tanda terima ditandatangani",
  });
  assert.ok(s7Result && typeof s7Result === "object", "Advance to Stage 8 should succeed");
  currentOrder = orderStore.getOrderByNo(orderNo);
  assert.strictEqual(currentOrder?.currentStageName, "Dokumen Telah Diterima");
  assert.strictEqual(currentOrder?.currentStep, 8);
  assert.strictEqual(currentOrder?.customer, "Workflow Hero");
  assert.strictEqual(currentOrder?.nopol, "B 7777 WFL");

  // STAGE 8 -> ARCHIVE (Riwayat Order)
  const archiveResult = await orderStore.archiveOrderAsync(orderNo);
  assert.strictEqual(archiveResult, true, "Archiving order should succeed");

  const archivedOrders = orderStore.getArchivedOrders();
  assert.ok(archivedOrders.some((o) => o.orderNo === orderNo), "Should be in archivedOrders list");
});

test("Order Workflow - Advance non-existent order rejects with ActionApiError / 401 or 404", async () => {
  await assert.rejects(() => orderStore.advanceOrderAsync("ORD-NON-EXISTENT", "Penjadwalan", {}));
});
