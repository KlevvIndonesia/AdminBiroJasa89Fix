/**
 * SUN89 — BATCH 4: CASHBACK PERSISTENCE & LABA RUGI INTEGRITY SUITE
 *
 * Covers Batch 4 verification requirements on isolated SQLite:
 * - Group A: Cashback Completion DB Persistence, Paid Prerequisite, Duplicate Guard, RBAC & Audit Trail
 * - Group B: Frontend Provider/Store Persistence & Fail-Closed Error Propagation (Cashback & Closing Invoice)
 * - Group C: Canonical Asia/Jakarta (WIB) Date Parsing & Half-Open Period Filtering
 * - Group D: Canonical Laba Rugi Aggregation, Classification, Zero Double-Count & Non-Operating Exclusions
 * - Group E: CSV & PDF Export Integrity, Injection Escaping & Empty Table Safety
 */

import "./setup-test-portal-shim";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { db } from "../server/src/database/db";
import { createApp } from "../server/src/app";
import { hashPassword } from "../server/src/utils/crypto";
import { financeService } from "../server/src/services/financeService";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";
import { financeRepository } from "../src/data/repositories/financeRepository";
import { financeStore } from "../src/app/data/financeStore";
import { permissionStore } from "../src/app/data/permissionStore";
import {
  parseWibDateInfo,
  parseDateFlexibleWib,
  getPeriodBoundsWib,
  matchesPeriodWib,
  isValidCalendarDate,
} from "../src/domain/finance/datePeriod";
import { computeCanonicalLabaRugi } from "../src/domain/finance/labaRugiCanonical";
import {
  exportLabaRugiToCSV,
  exportLabaRugiToPDF,
  escapeCSVCell,
  escapeHtml,
} from "../src/app/utils/financeExport";

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

function ensureUser(params: {
  email: string;
  nama: string;
  role: string;
  password: string;
  employeeId?: string | null;
}): number {
  const existing = db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)").get(params.email) as { id: number } | undefined;
  const pass = hashPassword(params.password);
  if (existing) {
    db.prepare(
      `UPDATE users SET nama = ?, role = ?, password_hash = ?, password_salt = ?, employee_id = ?, status = 'Aktif', failed_attempts = 0, locked_until = NULL WHERE id = ?`
    ).run(params.nama, params.role, pass.hash, pass.salt, params.employeeId ?? null, existing.id);
    return existing.id;
  }
  const resolvedJabatan = params.role.toLowerCase() === "administrator" ? "SVP" : params.role.toUpperCase();
  const info = db
    .prepare(
      `INSERT INTO users (nama, email, password_hash, password_salt, jabatan, role, employee_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Aktif')`
    )
    .run(params.nama, params.email, pass.hash, pass.salt, resolvedJabatan, params.role, params.employeeId ?? null);
  return Number(info.lastInsertRowid);
}

function seedOverpaidOrCashbackInvoice(params: {
  invoiceNo: string;
  orderNo: string;
  customer: string;
  totalTagihan: number;
  dibayar: number;
  biayaSamsat: number;
  cashback?: number;
  cashbackStatus?: string;
  overpayment?: number;
  refundStatus?: string;
  isCancelled?: boolean;
}): number {
  const nowStr = "2026-11-10T10:00:00.000Z";
  const overpayment = params.overpayment ?? Math.max(0, params.dibayar - params.totalTagihan);
  const cashback = params.cashback ?? 0;
  const dataJson = {
    invoiceNo: params.invoiceNo,
    invoice: params.invoiceNo,
    orderNo: params.orderNo,
    customer: params.customer,
    layanan: "Perpanjangan 1 Tahun",
    nopol: "B 4444 TST",
    tanggal: "2026-11-10",
    totalTagihan: params.totalTagihan,
    dibayar: params.dibayar,
    terbayar: params.dibayar,
    sisa: Math.max(0, params.totalTagihan - params.dibayar),
    status: params.isCancelled ? "CANCELLED" : "PAID",
    billingStatus: params.isCancelled ? "CANCELLED" : "PAID",
    isCancelled: Boolean(params.isCancelled),
    biayaSamsat: params.biayaSamsat,
    profit: params.isCancelled ? 0 : Math.max(0, params.totalTagihan - params.biayaSamsat),
    profitStatus: "PENDING",
    cashback,
    cashbackStatus: params.cashbackStatus || "PENDING",
    overpayment,
    refundStatus: params.refundStatus || (overpayment > 0 ? "NONE" : "NONE"),
    isSupervisiApproved: true,
    hasFinalCost: true,
    isCostVerified: true,
    payoutHistory: [],
    payoutVersion: 0,
  };

  db.prepare(
    `INSERT OR IGNORE INTO orders (order_no, customer, nomor_hp, layanan, nopol, payment_status, total_biaya, current_step, tanggal_masuk_berkas, data_json)
     VALUES (?, ?, '081200004444', ?, 'B 4444 TST', 'Lunas', ?, 7, '2026-11-10', ?)`
  ).run(
    params.orderNo,
    params.customer,
    "Perpanjangan 1 Tahun",
    params.totalTagihan,
    JSON.stringify({
      orderNo: params.orderNo,
      customer: params.customer,
      layanan: "Perpanjangan 1 Tahun",
      nopol: "B 4444 TST",
      currentStep: 7,
      currentStageName: params.isCancelled ? "Dibatalkan" : "Selesai",
      isCancelled: Boolean(params.isCancelled),
      isVerified: true,
      approvedBySpv: true,
      finalCost: params.totalTagihan,
      documentApproval: { stage5Verified: true, stage6Approved: true },
      isSupervisiApproved: true,
      hasFinalCost: true,
      isCostVerified: true,
      biayaFinal: { biayaSamsat: params.biayaSamsat, total: params.totalTagihan },
      payment: { invoiceNo: params.invoiceNo, totalTagihan: params.totalTagihan, dibayar: params.dibayar },
    })
  );

  const info = db
    .prepare(
      `INSERT INTO finance_invoices (
         invoice_no, order_no, customer, layanan, status, total_tagihan, dibayar, sisa,
         data_json, created_at, updated_at, biaya_samsat, pendapatan_jasa,
         overpayment, settlement_condition, refund_status, cashback_nominal, cashback_status,
         profit_final, profit_status
       ) VALUES (?, ?, ?, 'Perpanjangan 1 Tahun', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
    )
    .run(
      params.invoiceNo,
      params.orderNo,
      params.customer,
      params.isCancelled ? "CANCELLED" : "PAID",
      params.totalTagihan,
      params.dibayar,
      JSON.stringify(dataJson),
      nowStr,
      nowStr,
      params.biayaSamsat,
      Math.max(0, params.totalTagihan - params.biayaSamsat),
      overpayment,
      overpayment > 0 ? "OVERPAID" : "BALANCED",
      dataJson.refundStatus,
      cashback,
      dataJson.cashbackStatus,
      dataJson.profit
    );

  return Number(info.lastInsertRowid);
}

test("Batch 4 Group A: Cashback persistence, paid prerequisite, duplicate guard, RBAC & audit trail", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const suffix = crypto.randomBytes(4).toString("hex");
  const pwd = `B4Test!${suffix}`;
  const empId = `emp-b4-${suffix}`;
  db.prepare(
    `INSERT OR IGNORE INTO employees (id, nik_ktp, nama_lengkap, no_hp, tgl_lahir, wilayah, alamat_domisili, jabatan)
     VALUES (?, ?, 'Batch4 Messenger', '081200009999', '1992-01-01', 'Jakarta Selatan', 'Jl. Test', 'MESSENGER')`
  ).run(empId, `31740000${suffix.slice(0, 8)}`);
  db.prepare(
    `INSERT OR IGNORE INTO messengers (id, employee_id, plat_motor_operasional, wilayah_tugas_utama, status_tugas)
     VALUES (?, ?, 'B 9999 B4', 'Jakarta Selatan', 'STANDBY')`
  ).run(`msg-b4-${suffix}`, empId);

  ensureUser({
    email: `b4-finance-${suffix}@sun89.local`,
    nama: "Batch4 Finance",
    role: "finance",
    password: pwd,
  });
  ensureUser({
    email: `b4-admin-${suffix}@sun89.local`,
    nama: "Batch4 Admin",
    role: "administrator",
    password: pwd,
  });
  ensureUser({
    email: `b4-messenger-${suffix}@sun89.local`,
    nama: "Batch4 Messenger",
    role: "messenger",
    password: pwd,
    employeeId: empId,
  });

  try {
    const finAuth = await loginHttp(baseUrl, `b4-finance-${suffix}@sun89.local`, pwd);
    const adminAuth = await loginHttp(baseUrl, `b4-admin-${suffix}@sun89.local`, pwd);
    const msgAuth = await loginHttp(baseUrl, `b4-messenger-${suffix}@sun89.local`, pwd);

    // Seed invoice with commission cashback still PENDING (not yet paid out)
    const invId = seedOverpaidOrCashbackInvoice({
      invoiceNo: `INV-B4-${suffix}`,
      orderNo: `ORD-B4-${suffix}`,
      customer: "PT Batch Empat",
      totalTagihan: 1500000,
      dibayar: 1500000,
      biayaSamsat: 1000000,
      cashback: 150000,
      cashbackStatus: "PENDING",
      overpayment: 0,
    });

    // 1. RBAC: Messenger denied (403)
    const forbiddenComplete = await fetch(`${baseUrl}/api/finance/invoices/${invId}/cashback-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${msgAuth.token}` },
      body: JSON.stringify({ catatan: "Unauthorized attempt" }),
    });
    assert.equal(forbiddenComplete.status, 403);

    const forbiddenHistory = await fetch(`${baseUrl}/api/finance/cashback-history`, {
      headers: { Authorization: `Bearer ${msgAuth.token}` },
    });
    assert.equal(forbiddenHistory.status, 403);

    // 2. Prerequisite guard: Cannot complete cashback before payout
    const preCompleteRes = await fetch(`${baseUrl}/api/finance/invoices/${invId}/cashback-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
      body: JSON.stringify({ catatan: "Before payout" }),
    });
    assert.equal(preCompleteRes.status, 400);

    // 3. Payout commission -> status becomes PAID/REALIZED, stays in active queue until Selesai
    const payoutRes = await fetch(`${baseUrl}/api/finance/invoices/${invId}/cashback-payout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
      body: JSON.stringify({
        nominal: 150000,
        paymentType: "KOMISI",
        bank: "BCA",
        noRekening: "8899001122",
        namaRekening: "PT Batch Empat",
        penerima: "PT Batch Empat",
        buktiPembayaran: {
          fileName: "proof.png",
          fileType: "image",
          fileUrl: "https://example.local/proof.png",
        },
        expectedVersion: 0,
        idempotencyKey: `b4-payout-${suffix}`,
      }),
    });
    assert.equal(payoutRes.status, 200, `Payout failed: ${await payoutRes.clone().text()}`);

    const dbAfterPayout = dbFinanceRepository.getInvoiceById(invId)!;
    assert.equal(dbAfterPayout.cashbackStatus, "REALIZED");
    assert.equal(dbAfterPayout.cashbackCompletionStatus, "PAID");

    // 4. Complete cashback persistently -> stored in SQLite + audit_logs
    const completeRes = await fetch(`${baseUrl}/api/finance/invoices/${invId}/cashback-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
      body: JSON.stringify({
        catatan: "Sudah serah terima bukti transfer ke rekanan",
        idempotencyKey: `b4-complete-${suffix}`,
      }),
    });
    assert.equal(completeRes.status, 200, `Complete failed: ${await completeRes.clone().text()}`);
    const completeBody = (await completeRes.json()) as any;
    assert.equal(completeBody.data.cashbackCompletionStatus, "COMPLETED");
    assert.ok(completeBody.data.cashbackCompletedAt);
    assert.equal(completeBody.data.cashbackCompletionNotes, "Sudah serah terima bukti transfer ke rekanan");

    // Verify columns persisted directly in SQLite (survives restart/reload)
    const sqlRow = db
      .prepare("SELECT cashback_completion_status, cashback_completed_at, cashback_completed_by FROM finance_invoices WHERE id = ?")
      .get(invId) as any;
    assert.equal(sqlRow.cashback_completion_status, "COMPLETED");
    assert.ok(sqlRow.cashback_completed_at);
    assert.equal(sqlRow.cashback_completed_by, "Batch4 Finance");

    // Verify DB audit log created
    const auditRows = db
      .prepare("SELECT action, module, details, metadata_json, user_name FROM audit_logs WHERE action = 'COMPLETE_CASHBACK'")
      .all() as any[];
    const auditRow = auditRows.find((r) => {
      try {
        return Number(JSON.parse(r.metadata_json || "{}").invoiceId) === invId;
      } catch {
        return false;
      }
    });
    assert.ok(auditRow, "COMPLETE_CASHBACK audit log row must exist");
    assert.equal(auditRow.module, "Cashback Terpending");
    assert.equal(auditRow.user_name, "Batch4 Finance");

    // 5. Duplicate completion guard (distinct idempotencyKey -> 409)
    const dupCompleteRes = await fetch(`${baseUrl}/api/finance/invoices/${invId}/cashback-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
      body: JSON.stringify({
        catatan: "Duplicate attempt",
        idempotencyKey: `b4-complete-dup-${suffix}`,
      }),
    });
    assert.equal(dupCompleteRes.status, 409);

    // 6. Cashback history endpoint lists completed item
    const historyRes = await fetch(`${baseUrl}/api/finance/cashback-history`, {
      headers: { Authorization: `Bearer ${finAuth.token}` },
    });
    assert.equal(historyRes.status, 200);
    const historyBody = (await historyRes.json()) as any;
    assert.ok(historyBody.data.some((row: any) => Number(row.id) === invId && row.cashbackCompletionStatus === "COMPLETED"));

    // 7. Void after completed throws/blocks clean 409 (using authorized administrator role)
    const voidRes = await fetch(`${baseUrl}/api/finance/invoices/${invId}/cashback-payout/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ reason: "Coba void setelah selesai", payoutType: "KOMISI" }),
    });
    assert.equal(voidRes.status, 409);

    // 8. Cancelled order with processed overpayment refund (cashback=0) can be completed cleanly
    const cancelledId = seedOverpaidOrCashbackInvoice({
      invoiceNo: `INV-B4C-${suffix}`,
      orderNo: `ORD-B4C-${suffix}`,
      customer: "Customer Batal Refund",
      totalTagihan: 800000,
      dibayar: 800000,
      biayaSamsat: 0,
      cashback: 0,
      overpayment: 800000,
      refundStatus: "PROCESSED",
      isCancelled: true,
    });
    const cancelCompleteRes = await fetch(`${baseUrl}/api/finance/invoices/${cancelledId}/cashback-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
      body: JSON.stringify({ catatan: "Arsip refund order batal", idempotencyKey: `b4-cancel-${suffix}` }),
    });
    assert.equal(cancelCompleteRes.status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Batch 4 Group B: Frontend provider/store reload persistence & fail-closed UI error propagation", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const suffix = crypto.randomBytes(4).toString("hex");
  const pwd = `B4Ui!${suffix}`;
  const origFetch = globalThis.fetch;
  let provider1: ApiFinanceProvider | null = null;
  let provider2: ApiFinanceProvider | null = null;

  try {
    ensureUser({
      email: `b4-uifin-${suffix}@sun89.local`,
      nama: "Batch4 UI Finance",
      role: "finance",
      password: pwd,
    });

    const auth = await loginHttp(baseUrl, `b4-uifin-${suffix}@sun89.local`, pwd);
    const invId = seedOverpaidOrCashbackInvoice({
      invoiceNo: `INV-B4U-${suffix}`,
      orderNo: `ORD-B4U-${suffix}`,
      customer: "Reload Persistence Customer",
      totalTagihan: 1200000,
      dibayar: 1200000,
      biayaSamsat: 800000,
      cashback: 300000,
      overpayment: 0,
      refundStatus: "NONE",
    });

    globalThis.fetch = ((input: any, init?: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      const rewritten = urlStr.startsWith("/api/") ? `${baseUrl}${urlStr}` : urlStr;
      return origFetch(rewritten, init);
    }) as typeof fetch;

    (globalThis as any).localStorage.setItem("auth_token", auth.token);
    permissionStore.hydrateSession("finance", { notify: true, requireAuthoritativeSync: false });

    provider1 = new ApiFinanceProvider();
    financeRepository.setProvider(provider1);

    await financeService.payoutCashback(
      invId,
      {
        nominal: 300000,
        paymentType: "KOMISI",
        bank: "BCA",
        noRekening: "12345678",
        namaRekening: "Reload Persistence Customer",
        penerima: "Reload Persistence Customer",
        buktiPembayaran: {
          fileName: "p2.png",
          fileType: "image",
          fileUrl: "https://example.local/p2.png",
        },
        expectedVersion: 0,
        idempotencyKey: `b4-uipayout-${suffix}`,
      },
      { userId: `usr-${auth.user.id}`, id: String(auth.user.id), nama: "Batch4 UI Finance", role: "finance" } as any
    );

    await provider1.initFromApi();
    (financeStore as any).syncFromRepository();

    // Paid cashback remains in Active queue (not history yet)
    assert.ok(
      financeStore.getCashbackPendingList().some((c) => Number(c.id) === invId && c.status === "Dibayar"),
      "Paid cashback must stay in active pending list until Selesai is clicked"
    );
    assert.ok(
      !financeStore.getCashbackHistoryList().some((c) => Number(c.id) === invId),
      "Paid but uncompleted cashback must NOT be in completed history yet"
    );

    // Fail-closed test: server error keeps item in pending queue
    (globalThis as any).localStorage.setItem("auth_token", "invalid-token");
    await assert.rejects(
      () => financeStore.completeCashback(invId, { catatan: "Should fail", idempotencyKey: `fail-${suffix}` }),
      /./
    );
    assert.ok(
      financeStore.getCashbackPendingList().some((c) => Number(c.id) === invId),
      "Server failure must preserve item in active cashback queue"
    );

    // Restore valid token & complete persistently
    (globalThis as any).localStorage.setItem("auth_token", auth.token);
    await financeStore.completeCashback(invId, { catatan: "Arsip valid", idempotencyKey: `ok-${suffix}` });
    assert.ok(!financeStore.getCashbackPendingList().some((c) => Number(c.id) === invId));
    assert.ok(financeStore.getCashbackHistoryList().some((c) => Number(c.id) === invId));

    // Simulate fresh browser reload: brand-new provider instance hydrates from DB
    (provider1 as any)?.destroy?.();
    provider2 = new ApiFinanceProvider();
    financeRepository.setProvider(provider2);
    await provider2.initFromApi();
    (financeStore as any).syncFromRepository();

    assert.ok(
      !financeStore.getCashbackPendingList().some((c) => Number(c.id) === invId),
      "Completed cashback MUST NOT reappear in active queue after browser reload"
    );
    const reloadedHistory = financeStore.getCashbackHistoryList().find((c) => Number(c.id) === invId);
    assert.ok(reloadedHistory, "Completed cashback MUST appear in history after reload");
    assert.equal(reloadedHistory.cashbackCompletionNotes, "Arsip valid");

    // Also verify completeInvoice fails closed when unauthorized (does not mark COMPLETED optimistically)
    (globalThis as any).localStorage.setItem("auth_token", "invalid-token");
    await assert.rejects(() => financeStore.completeInvoice(invId, "Tester"), /./);
    const stillNotCompleted = financeStore.getInvoices().find((i) => Number(i.id) === invId);
    assert.notEqual(stillNotCompleted?.billingStatus, "COMPLETED");
  } finally {
    (provider1 as any)?.destroy?.();
    (provider2 as any)?.destroy?.();
    globalThis.fetch = origFetch;
    (globalThis as any).localStorage.removeItem("auth_token");
    permissionStore.clearSession();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Batch 4 Group C: Canonical Asia/Jakarta (WIB) date parsing & half-open period bounds", () => {
  // 1. Valid formats & WIB day shift
  const utcLate = parseWibDateInfo("2026-11-15T18:00:00.000Z"); // 01:00 WIB Nov 16
  assert.equal(utcLate?.ymd, "2026-11-16");

  const sqliteDt = parseWibDateInfo("2026-11-15 17:30:00"); // UTC -> 00:30 WIB Nov 16
  assert.equal(sqliteDt?.ymd, "2026-11-16");

  const dmy = parseWibDateInfo("05/11/2026");
  assert.equal(dmy?.ymd, "2026-11-05");

  const indo = parseWibDateInfo("Senin, 21 Oktober 2026");
  assert.equal(indo?.ymd, "2026-10-21");

  const febLeap = parseWibDateInfo("2024-02-29");
  assert.equal(febLeap?.ymd, "2024-02-29");

  // 2. Fail closed on invalid calendar / empty / dash dates
  assert.equal(isValidCalendarDate(2025, 2, 29), false);
  assert.equal(parseDateFlexibleWib("2025-02-29"), null);
  assert.equal(parseDateFlexibleWib("2026-02-31"), null);
  assert.equal(parseDateFlexibleWib("2026-13-01"), null);
  assert.equal(parseDateFlexibleWib(""), null);
  assert.equal(parseDateFlexibleWib("-"), null);
  assert.equal(parseDateFlexibleWib(null), null);

  // 3. Half-open bounds in WIB
  const ref = new Date("2026-11-15T12:00:00+07:00"); // Sunday, Nov 15, 2026 WIB
  const dailyBounds = getPeriodBoundsWib("daily", ref);
  assert.equal(dailyBounds.startYmd, "2026-11-15");
  assert.equal(dailyBounds.endYmd, "2026-11-15");
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-11-15T23:59:59+07:00"), "daily", ref), true);
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-11-16T00:00:00+07:00"), "daily", ref), false);
  assert.equal(matchesPeriodWib(null, "daily", ref), false);

  // Weekly Mon..Sun: Nov 9..Nov 15
  const weeklyBounds = getPeriodBoundsWib("weekly", ref);
  assert.equal(weeklyBounds.startYmd, "2026-11-09");
  assert.equal(weeklyBounds.endYmd, "2026-11-15");
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-11-09"), "weekly", ref), true);
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-11-08"), "weekly", ref), false);
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-11-16T00:00:00+07:00"), "weekly", ref), false);

  // Monthly Nov 2026: Oct 31 17:00Z = Nov 1 00:00 WIB -> included
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-10-31T17:00:00.000Z"), "monthly", ref), true);
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-10-31T23:59:59+07:00"), "monthly", ref), false);

  // Yearly 2026 vs 2025/2027
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-12-31T23:59:59+07:00"), "yearly", ref), true);
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2025-12-31T23:59:59+07:00"), "yearly", ref), false);

  // Custom range
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-10-21"), "custom", ref, "2026-10-20", "2026-10-25"), true);
  assert.equal(matchesPeriodWib(parseDateFlexibleWib("2026-10-26"), "custom", ref, "2026-10-20", "2026-10-25"), false);
});

test("Batch 4 Group D: Canonical Laba Rugi aggregation, zero double-count & non-operating exclusions", () => {
  const ref = new Date("2026-11-15T12:00:00+07:00");

  const invoices: any[] = [
    // Nov active paid invoice with realized cashback (100k)
    {
      id: 1,
      invoice: "INV-NOV-1",
      orderNo: "ORD-NOV-1",
      customer: "Customer Nov 1",
      tanggal: "2026-11-10",
      status: "PAID",
      totalTagihan: 1_000_000,
      dibayar: 1_000_000,
      terbayar: 1_000_000,
      sisa: 0,
      biayaSamsat: 400_000,
      profit: 600_000,
      profitStatus: "REALIZED",
      cashback: 100_000,
      cashbackStatus: "REALIZED",
      overpayment: 0,
    },
    // Nov unpaid/pending invoice (200k unpaid, 150k pending profit, 25k pending cashback)
    {
      id: 2,
      invoice: "INV-NOV-2",
      orderNo: "ORD-NOV-2",
      customer: "Customer Nov 2",
      tanggal: "2026-11-11",
      status: "UNPAID",
      totalTagihan: 500_000,
      dibayar: 300_000,
      terbayar: 300_000,
      sisa: 200_000,
      biayaSamsat: 100_000,
      profit: 150_000,
      profitStatus: "PENDING",
      cashback: 25_000,
      cashbackStatus: "PENDING",
      overpayment: 0,
    },
    // Nov pending-verification invoice (Guard 6 holds revenue=0 and places 150k into pendingProfit)
    {
      id: 21,
      invoice: "INV-NOV-3",
      orderNo: "ORD-NOV-3",
      customer: "Customer Nov 3 Pending Cost",
      tanggal: "2026-11-11",
      status: "PAID",
      totalTagihan: 500_000,
      dibayar: 500_000,
      terbayar: 500_000,
      sisa: 0,
      biayaSamsat: 350_000,
      costVerificationStatus: "PENDING_VERIFICATION",
      profit: 150_000,
      profitStatus: "PENDING",
      cashback: 0,
      cashbackStatus: "NONE",
      overpayment: 0,
    },
    // Oct invoice (MUST be excluded from Nov monthly totals including pendingProfit/pendingUnpaidBalance!)
    {
      id: 3,
      invoice: "INV-OCT-1",
      orderNo: "ORD-OCT-1",
      customer: "Customer Oct",
      tanggal: "2026-10-15",
      status: "UNPAID",
      totalTagihan: 900_000,
      dibayar: 0,
      terbayar: 0,
      sisa: 900_000,
      biayaSamsat: 500_000,
      costVerificationStatus: "PENDING_VERIFICATION",
      profit: 400_000,
      profitStatus: "PENDING",
      cashback: 50_000,
      cashbackStatus: "PENDING",
      overpayment: 0,
    },
    // Cancelled invoice (must have 0 revenue, 0 pendingProfit)
    {
      id: 4,
      invoice: "INV-CAN-1",
      orderNo: "ORD-CAN-1",
      customer: "Cancelled Customer",
      tanggal: "2026-11-12",
      status: "CANCELLED",
      isCancelled: true,
      totalTagihan: 750_000,
      dibayar: 0,
      terbayar: 0,
      sisa: 0,
      biayaSamsat: 300_000,
      costVerificationStatus: "PENDING_VERIFICATION",
      profit: 450_000,
      profitStatus: "PENDING",
      cashback: 0,
      cashbackStatus: "NONE",
    },
    // Invalid date invoice (must be excluded from bounded periods & flagged in diagnostics)
    {
      id: 5,
      invoice: "INV-BAD-DATE",
      orderNo: "ORD-BAD-DATE",
      customer: "Bad Date",
      tanggal: "2026-02-31",
      status: "UNPAID",
      totalTagihan: 400_000,
      dibayar: 0,
      terbayar: 0,
      sisa: 400_000,
      biayaSamsat: 0,
      costVerificationStatus: "PENDING_VERIFICATION",
      profit: 400_000,
      profitStatus: "PENDING",
    },
  ];

  const kasKantor: any[] = [
    // Capital injection -> EXCLUDED from operating revenue
    {
      id: 1,
      tanggal: "2026-11-01",
      status: "Debit",
      debit: 50_000_000,
      kredit: 0,
      kategori: "MODAL_AWAL",
      keterangan: "Setoran Modal Owner November",
    },
    // Invoice payment mirror -> EXCLUDED from operating cash-in (no double count with INV-NOV-1)
    {
      id: 2,
      tanggal: "2026-11-10",
      status: "Debit",
      debit: 1_000_000,
      kredit: 0,
      kategori: "PEMBAYARAN_INVOICE",
      invoiceNo: "INV-NOV-1",
      keterangan: "Pembayaran: INV-NOV-1 - Customer Nov 1",
    },
    // Internal transfer -> Rp 0
    {
      id: 3,
      tanggal: "2026-11-10",
      status: "Debit",
      debit: 2_000_000,
      kredit: 0,
      kategori: "INTERNAL_TRANSFER",
      keterangan: "[SETORAN KURIR] TRF-M2O",
    },
    // Cashback payout mirror in Kas Kantor -> must NOT double-count against realizedCashback (100k)!
    {
      id: 4,
      tanggal: "2026-11-10",
      status: "Kredit",
      debit: 0,
      kredit: 100_000,
      kategori: "PEMBAYARAN_CASHBACK",
      invoiceNo: "INV-NOV-1",
      keterangan: "Pencairan komisi rekanan: INV-NOV-1",
    },
    // Customer refund -> EXCLUDED from OPEX
    {
      id: 5,
      tanggal: "2026-11-11",
      status: "Kredit",
      debit: 0,
      kredit: 300_000,
      kategori: "CUSTOMER_REFUND",
      keterangan: "Pengembalian kelebihan bayar Customer X",
    },
    // Voided expense -> EXCLUDED
    {
      id: 6,
      tanggal: "2026-11-11",
      status: "Kredit",
      debit: 0,
      kredit: 999_000,
      keterangan: "[VOID] Biaya dibatalkan",
    },
    // Legitimate office OPEX
    {
      id: 7,
      tanggal: "2026-11-12",
      status: "Kredit",
      debit: 0,
      kredit: 50_000,
      kategori: "Operasional Kantor",
      keterangan: "Beli kertas dan tinta printer",
    },
  ];

  const monthly = computeCanonicalLabaRugi(
    invoices,
    [],
    [],
    "monthly",
    undefined,
    undefined,
    undefined,
    kasKantor,
    ref
  );

  // Invoice inflows in Nov: INV-NOV-1 (1,000,000, Samsat 400,000) + INV-NOV-2 (300,000, proportional Samsat 60,000)
  assert.equal(monthly.totalPemasukan, 1_300_000);
  assert.equal(monthly.totalBiayaSamsat, 460_000);
  assert.equal(monthly.totalPendapatanJasa, 840_000);
  // Expenses: ONLY 50k OPEX + 100k realizedCashback (NOT 200k cashback, NOT 300k refund, NOT 999k void)
  assert.equal(monthly.pengeluaranKantor, 50_000);
  assert.equal(monthly.realizedCashback, 100_000);
  assert.equal(monthly.totalBebanOperasional, 150_000);
  assert.equal(monthly.labaRugiBersih, 840_000 - 150_000);
  assert.equal(monthly.kasKantorDebitNonInternal, 0, "Modal, invoice mirror, and internal transfer must stay out of operating cash-in");

  // Pending metrics strictly period-filtered (Oct 900k & InvalidDate 400k excluded!)
  assert.equal(monthly.pendingUnpaidBalance, 200_000);
  assert.equal(monthly.pendingProfit, 150_000);
  assert.equal(monthly.pendingCashback, 25_000);
  assert.ok((monthly.invalidDateDiagnostics || []).some((d) => d.reference === "INV-BAD-DATE"));
});

test("Batch 4 Group E: Export CSV & PDF escaping, empty table rows safety & exact summary parity", async () => {
  // Formula & HTML escaping checks (RFC 4180 + formula prefix sanitization)
  assert.equal(escapeCSVCell("=CMD|' /C calc'!A0"), "'=CMD|' /C calc'!A0");
  assert.equal(escapeCSVCell('=HYPERLINK("a","b")'), "\"'=HYPERLINK(\"\"a\"\",\"\"b\"\")\"");
  assert.ok(escapeCSVCell("=1+1").includes("'=1+1"));
  assert.equal(escapeHtml(`<script>alert("xss")</script>`), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");

  // Mock browser globals for CSV & PDF export verification
  const origWindow = (globalThis as any).window;
  const origDocument = (globalThis as any).document;
  const origURL = (globalThis as any).URL;
  const origBlob = (globalThis as any).Blob;
  let capturedHtml = "";
  let capturedCsvParts: any[] = [];

  class MockBlob {
    constructor(parts: any[]) {
      capturedCsvParts = parts;
    }
  }
  (globalThis as any).Blob = MockBlob;
  (globalThis as any).URL = {
    createObjectURL: () => "blob:mock-csv",
    revokeObjectURL: () => {},
  };
  let printCalled = false;
  (globalThis as any).document = {
    ...(origDocument || {}),
    body: {
      appendChild: () => {},
      removeChild: () => {},
      contains: () => false,
    },
    createElement: () => ({
      setAttribute: () => {},
      click: () => {},
      style: {},
    }),
  };
  (globalThis as any).window = {
    open: () => ({
      document: {
        open: () => {},
        write: (html: string) => {
          capturedHtml = html;
        },
        close: () => {},
      },
      focus: () => {},
      print: () => {
        printCalled = true;
      },
    }),
  };

  try {
    exportLabaRugiToCSV({
      periodLabel: `=CMD|' /C calc'!A0`,
      labaBersih: {
        amount: 690_000,
        baseAmount: 690_000,
        isSurplus: true,
        basisText: `=HACKER("basis")`,
      },
      componentFilters: {
        includeProfitPending: true,
        includeCashbackPending: false,
        includeTagihanCustomer: true,
      },
      tableRows: [
        {
          sumber: `=EVIL("row")`,
          uangMasuk: 1_300_000,
          uangKeluar: 610_000,
          profitPending: 150_000,
          cashbackPending: 25_000,
          tagihanCustomer: 200_000,
          keterangan: `=SUM(A1:A2)`,
        },
      ],
    });
    const csvText = capturedCsvParts.join("");
    assert.ok(csvText.includes(`"PERIODE",'=CMD|' /C calc'!A0`));
    assert.ok(csvText.includes(`"LABA RUGI BERSIH",690000`));
    assert.ok(csvText.includes(`"'=EVIL(""row"")"`));

    exportLabaRugiToPDF(
      {
        periodLabel: `Nov <script>alert(1)</script>`,
        labaBersih: {
          amount: 690_000,
          baseAmount: 690_000,
          isSurplus: true,
          basisText: `=HACKER("basis")`,
        },
        componentFilters: {
          includeProfitPending: true,
          includeCashbackPending: false,
          includeTagihanCustomer: true,
        },
        printedBy: `<b>Admin</b>`,
        tableRows: [],
      },
      "download"
    );
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal(printCalled, true, "Download PDF dispatch should invoke previewWindow.print()");
    assert.ok(capturedHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!capturedHtml.includes("<script>alert(1)</script>"));
    assert.ok(capturedHtml.includes(`colspan="6"`), "Empty PDF table row must span all 6 header columns");
  } finally {
    (globalThis as any).Blob = origBlob;
    (globalThis as any).URL = origURL;
    (globalThis as any).document = origDocument;
    if (origWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = origWindow;
    }
  }
});
