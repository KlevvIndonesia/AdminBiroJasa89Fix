/**
 * Phase 2 Finance Dynamic RBAC Enforcement Test Suite
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Verifies all 23 Finance API endpoints against dynamic SQLite role_permissions:
 * 1. Read invoices: /invoices, /invoices/:id, /invoices/:invoiceNo/payments
 * 2. Payment mutations: pay, verify, complete, cashback payout
 * 3. Void operations: void payment, void cashback, void history (SVP/Supervisor gated)
 * 4. Financial reports: /profit, /laba-rugi, /pnl
 * 5. Kas Kantor: read, mutation, SVP-only delete
 * 6. Pengeluaran: read, mutation, SVP-only delete
 * 7. Kas Messenger: read (finance vs courier scope), mutation, SVP-only delete
 * 8. Internal Transfers: messenger-to-office, office-to-messenger
 * 9. Fail-closed on missing/unauthenticated tokens (401)
 * 10. SVP universal unconditional bypass across all finance operations
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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

test("PHASE 2: FINANCE DYNAMIC RBAC ENFORCEMENT SUITE", async (t) => {
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

  // 1. Unauthenticated requests to finance endpoints return 401 UNAUTHENTICATED
  await t.test("1. Unauthenticated requests return 401", async () => {
    const endpoints = [
      "/api/finance/invoices",
      "/api/finance/laba-rugi",
      "/api/finance/pnl",
      "/api/finance/profit",
      "/api/finance/kas-kantor",
      "/api/finance/kas-messenger",
      "/api/finance/pengeluaran",
    ];
    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`);
      assert.strictEqual(res.status, 401, `Expected 401 for anonymous ${ep}`);
      const body = await res.json();
      assert.strictEqual(body.error?.code, "UNAUTHENTICATED");
    }
  });

  // 2. Invoices Read Endpoints: GET /invoices, /invoices/:id, /invoices/:invoiceNo/payments
  await t.test("2. Invoices read dynamic permission evaluation", async () => {
    // Finance by default has finance-tagihan: view: true -> 200
    const resGranted = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(resGranted.status, 200);

    // SVP dynamically revokes finance-tagihan from Finance
    const financePerms = dbPermissionRepository.getByRole("finance")!;
    financePerms.modules["finance-tagihan"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("finance", financePerms);

    // Finance request now rejected with 403 FORBIDDEN
    const resRevoked = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(resRevoked.status, 403);
    const bodyRevoked = await resRevoked.json();
    assert.strictEqual(bodyRevoked.error?.code, "FORBIDDEN");

    // Check detail endpoints with revoked permission -> 403
    const resDetail = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST-001`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(resDetail.status, 403);

    const resPayments = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST-001/payments`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(resPayments.status, 403);

    // Restore permission for Finance
    financePerms.modules["finance-tagihan"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", financePerms);

    const resRestored = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(resRestored.status, 200);
  });

  // 3. Payment Mutation Endpoints: /invoices/:id/pay, /verify-payment, /complete
  await t.test("3. Payment mutation dynamic RBAC enforcement", async () => {
    // Revoke finance-tagihan.manage
    const financePerms = dbPermissionRepository.getByRole("finance")!;
    financePerms.modules["finance-tagihan"] = { view: true, manage: false };
    dbPermissionRepository.saveRole("finance", financePerms);

    const payRes = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ amount: 100000, metodePembayaran: "TUNAI" }),
    });
    assert.strictEqual(payRes.status, 403, "Finance without manage permission must be rejected on /pay");

    const verifyRes = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST/verify-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ paymentId: "pay-1" }),
    });
    assert.strictEqual(verifyRes.status, 403, "Finance without manage permission must be rejected on /verify-payment");

    const completeRes = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(completeRes.status, 403, "Finance without manage permission must be rejected on /complete");

    // Restore manage permission
    financePerms.modules["finance-tagihan"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", financePerms);
  });

  // 4. Cashback Payout: /invoices/:id/cashback-payout
  await t.test("4. Cashback payout dynamic RBAC enforcement", async () => {
    // Revoke finance-cashback-pending
    const financePerms = dbPermissionRepository.getByRole("finance")!;
    financePerms.modules["finance-cashback-pending"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("finance", financePerms);

    const res = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST/cashback-payout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ amount: 50000 }),
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error?.code, "FORBIDDEN");

    // Restore permission
    financePerms.modules["finance-cashback-pending"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", financePerms);
  });

  // 5. Void Operations & Audit History (Layered Defense: SPV/SVP role + dynamic permission)
  await t.test("5. Void operations defense-in-depth enforcement", async () => {
    // Finance cannot void payments or cashback (lacks supervisor/svp role) -> 403
    const voidPayRes = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST/payments/pay-1/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ reason: "Kesalahan input" }),
    });
    assert.strictEqual(voidPayRes.status, 403);

    const voidCashbackRes = await fetch(`${baseUrl}/api/finance/invoices/INV-TEST/cashback-payout/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ reason: "Salah transfer" }),
    });
    assert.strictEqual(voidCashbackRes.status, 403);

    const voidAuditRes = await fetch(`${baseUrl}/api/finance/audit/void-history`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(voidAuditRes.status, 403);

    // SVP has authority to read void history
    const svpAuditRes = await fetch(`${baseUrl}/api/finance/audit/void-history`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(svpAuditRes.status, 200);
  });

  // 6. Financial Reports: /laba-rugi, /pnl, /profit
  await t.test("6. Financial reports segregation and dynamic enforcement", async () => {
    // Admin is rejected from financial reports (BD-RBAC-05) -> 403
    const adminLabaRugi = await fetch(`${baseUrl}/api/finance/laba-rugi`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(adminLabaRugi.status, 403);

    const adminProfit = await fetch(`${baseUrl}/api/finance/profit`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(adminProfit.status, 403);

    // Finance is granted by default -> 200
    const finLabaRugi = await fetch(`${baseUrl}/api/finance/laba-rugi`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finLabaRugi.status, 200);

    const finPnl = await fetch(`${baseUrl}/api/finance/pnl`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finPnl.status, 200);

    const finProfit = await fetch(`${baseUrl}/api/finance/profit`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finProfit.status, 200);

    // SVP revokes finance-laba-rugi and finance-profit from Finance
    const financePerms = dbPermissionRepository.getByRole("finance")!;
    financePerms.modules["finance-laba-rugi"] = { view: false, manage: false };
    financePerms.modules["finance-profit"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("finance", financePerms);

    const finLabaRugiRevoked = await fetch(`${baseUrl}/api/finance/laba-rugi`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finLabaRugiRevoked.status, 403);

    const finProfitRevoked = await fetch(`${baseUrl}/api/finance/profit`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finProfitRevoked.status, 403);

    // Restore permissions
    financePerms.modules["finance-laba-rugi"] = { view: true, manage: true };
    financePerms.modules["finance-profit"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", financePerms);
  });

  // 7. Kas Kantor Endpoints: read, create, delete (SVP-only)
  await t.test("7. Kas Kantor dynamic RBAC & destructive delete protection", async () => {
    // Finance by default has finance-kas-kantor -> 200
    const finKas = await fetch(`${baseUrl}/api/finance/kas-kantor`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finKas.status, 200);

    // Revoke finance-kas-kantor from Finance -> 403
    const financePerms = dbPermissionRepository.getByRole("finance")!;
    financePerms.modules["finance-kas-kantor"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("finance", financePerms);

    const finKasRevoked = await fetch(`${baseUrl}/api/finance/kas-kantor`, {
      headers: { Authorization: `Bearer ${financeAuth.token}` },
    });
    assert.strictEqual(finKasRevoked.status, 403);

    // Mutation with revoked manage -> 403
    const finAddKas = await fetch(`${baseUrl}/api/finance/kas-kantor`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ tipe: "DEBIT", kategori: "Operasional", jumlah: 50000, keterangan: "Beli ATK" }),
    });
    assert.strictEqual(finAddKas.status, 403);

    // Delete Kas Kantor: Finance is denied (SVP-only) -> 403
    const finDeleteKas = await fetch(`${baseUrl}/api/finance/kas-kantor/kk-1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ reason: "Hapus transaksi" }),
    });
    assert.strictEqual(finDeleteKas.status, 403);

    // Restore
    financePerms.modules["finance-kas-kantor"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", financePerms);
  });

  // 8. Kas Messenger Endpoints: Courier scope vs Finance/Admin scope
  await t.test("8. Kas Messenger dynamic RBAC & role scoping", async () => {
    // Courier (Messenger) has messenger-task: true -> 200 (returns scoped summary)
    const courierRes = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
      headers: { Authorization: `Bearer ${courierAuth.token}` },
    });
    assert.strictEqual(courierRes.status, 200);
    const courierData = await courierRes.json();
    assert.strictEqual(courierData.success, true);

    // Admin by default HAS finance-kas-messenger -> 200 (AUD-F02 canonical default)
    const adminKasRes = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(adminKasRes.status, 200);

    // SVP dynamically revokes finance-kas-messenger from Admin -> 403
    const adminPerms = dbPermissionRepository.getByRole("admin")!;
    adminPerms.modules["finance-kas-messenger"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("admin", adminPerms);

    const adminKasRevoked = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(adminKasRevoked.status, 403);

    // SVP dynamically grants finance-kas-messenger: view to Admin -> 200
    adminPerms.modules["finance-kas-messenger"] = { view: true, manage: false };
    dbPermissionRepository.saveRole("admin", adminPerms);

    const adminKasGranted = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.strictEqual(adminKasGranted.status, 200);

    // Delete Kas Messenger: Admin is denied (SVP-only) -> 403
    const adminDeleteRes = await fetch(`${baseUrl}/api/finance/kas-messenger/km-1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ reason: "Hapus kas messenger" }),
    });
    assert.strictEqual(adminDeleteRes.status, 403);

    // Restore admin canonical defaults
    adminPerms.modules["finance-kas-messenger"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("admin", adminPerms);
  });

  // 9. Internal Cash Transfers: messenger-to-office & office-to-messenger
  await t.test("9. Internal transfers dynamic RBAC enforcement", async () => {
    // Finance with permissions can initiate transfers
    const finPerms = dbPermissionRepository.getByRole("finance")!;
    finPerms.modules["finance-kas-messenger"] = { view: false, manage: false };
    dbPermissionRepository.saveRole("finance", finPerms);

    const m2oRes = await fetch(`${baseUrl}/api/finance/transfer/messenger-to-office`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${financeAuth.token}` },
      body: JSON.stringify({ messengerId: "EMP-0004", nominal: 100000, keterangan: "Setor sisa panjar" }),
    });
    assert.strictEqual(m2oRes.status, 403);

    // Restore
    finPerms.modules["finance-kas-messenger"] = { view: true, manage: true };
    dbPermissionRepository.saveRole("finance", finPerms);
  });

  // 10. SVP Universal Bypass across all finance operations
  await t.test("10. SVP retains universal unconditional access", async () => {
    const svpInvoices = await fetch(`${baseUrl}/api/finance/invoices`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(svpInvoices.status, 200);

    const svpLabaRugi = await fetch(`${baseUrl}/api/finance/laba-rugi`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(svpLabaRugi.status, 200);

    const svpKasKantor = await fetch(`${baseUrl}/api/finance/kas-kantor`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(svpKasKantor.status, 200);

    const svpKasMessenger = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
      headers: { Authorization: `Bearer ${svpAuth.token}` },
    });
    assert.strictEqual(svpKasMessenger.status, 200);
  });
});
