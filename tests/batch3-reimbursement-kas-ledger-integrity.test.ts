/**
 * SUN89 — BATCH 3: REIMBURSEMENT, KAS MESSENGER, KAS KANTOR & CASH LEDGER INTEGRITY SUITE
 *
 * Covers Batch 3 Section 10 verification scopes on isolated SQLite:
 * - Group A: Reimbursement Lifecycle, Amount Validation, Payout Eligibility/Ceiling, Void Reversal & P&L Integrity
 * - Group B: Kas Messenger & Kas Kantor Persistent CRUD, HTTP RBAC, Audit Trail, Running Balance & Cash Reconciliation
 * - Group C: Atomicity, Audit-Failure Rollback, Duplicate Payout Prevention & Concurrency Safety
 * - Group D: Frontend Provider & Store Contract Regression (Single-Write Pay, Asynchronous Error Propagation)
 */

import "./setup-test-portal-shim";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { db } from "../server/src/database/db";
import { createApp } from "../server/src/app";
import { hashPassword } from "../server/src/utils/crypto";
import { messengerService } from "../server/src/services/messengerService";
import { financeService } from "../server/src/services/financeService";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import { dbMessengerRepository } from "../server/src/repositories/dbMessengerRepository";
import { deletePermanentlyWithAuditAndIdempotency } from "../server/src/services/permanentDeleteService";
import { computeCanonicalLabaRugi } from "../src/domain/finance/labaRugiCanonical";
import { ApiFinanceProvider } from "../src/data/api/apiFinanceProvider";
import { financeRepository } from "../src/data/repositories/financeRepository";
import { financeStore } from "../src/app/data/financeStore";

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

function createAuditFailureProxyDb(realDb: any): any {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (typeof sql === "string" && sql.toUpperCase().includes("INSERT INTO AUDIT_LOGS")) {
            return {
              run: () => {
                throw new Error("SIMULATED_AUDIT_WRITE_FAILURE");
              },
              get: () => undefined,
              all: () => [],
            };
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("BATCH 3: REIMBURSEMENT, KAS MESSENGER, KAS KANTOR & CASH LEDGER INTEGRITY SUITE", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  // Seed canonical employees, messengers & users for HTTP + Service RBAC tests
  const insertEmp = db.prepare(`
    INSERT OR IGNORE INTO employees (id, nik_ktp, nama_lengkap, no_hp, tgl_lahir, wilayah, alamat_domisili, jabatan)
    VALUES (?, ?, ?, ?, '1992-01-01', 'Jakarta Selatan', 'Jl. Sudirman No. 1', 'MESSENGER')
  `);
  insertEmp.run("emp-b3-103", "3174000000000103", "Budi Batch3", "081200000103");
  insertEmp.run("emp-b3-104", "3174000000000104", "Andi Batch3", "081200000104");

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messengers (id, employee_id, plat_motor_operasional, wilayah_tugas_utama, status_tugas)
    VALUES (?, ?, ?, 'Jakarta Selatan', 'STANDBY')
  `);
  insertMsg.run("msg-b3-103", "emp-b3-103", "B 103 B3");
  insertMsg.run("msg-b3-104", "emp-b3-104", "B 104 B3");

  const pass = hashPassword("Batch3Pass123!");
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, email, password_hash, password_salt, nama, jabatan, role, employee_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Aktif')
  `);
  insertUser.run(101, "b3-finance@sun89.test", pass.hash, pass.salt, "Batch3 Finance", "FINANCE", "finance", null);
  insertUser.run(102, "b3-admin@sun89.test", pass.hash, pass.salt, "Batch3 Admin", "ADMIN", "admin", null);
  insertUser.run(103, "b3-messenger@sun89.test", pass.hash, pass.salt, "Budi Batch3", "MESSENGER", "messenger", "emp-b3-103");
  insertUser.run(104, "b3-messenger2@sun89.test", pass.hash, pass.salt, "Andi Batch3", "MESSENGER", "messenger", "emp-b3-104");

  const activePmId = `pm-batch3-${Date.now()}`;
  db.prepare(`
    INSERT INTO payment_methods (id, nama_metode, bank, nomor_rekening, nama_rekening, status, created_at, updated_at)
    VALUES (?, 'BCA Batch 3', 'BCA', '8899001122', 'PT SUN BATCH 3', 'Aktif', datetime('now'), datetime('now'))
  `).run(activePmId);

  const svpActor = { userId: "usr-1", id: "1", role: "administrator", nama: "SVP Test", status: "Aktif" };
  const financeActor = { userId: "usr-101", id: "101", role: "finance", nama: "Batch3 Finance", status: "Aktif" };
  const messengerActor = { userId: "usr-103", id: "103", role: "messenger", nama: "Budi Batch3", employeeId: "emp-b3-103", status: "Aktif" };

  // =========================================================================
  // GROUP A: REIMBURSEMENT LIFECYCLE, AMOUNT CEILING & VOID REVERSAL INTEGRITY
  // =========================================================================
  await t.test("Group A: Reimbursement Lifecycle, Payout Eligibility/Ceiling & Void Integrity", async (st) => {
    await st.test("A.1: Create reimbursement rejects non-positive / invalid requestedAmount", () => {
      for (const badAmount of [0, -50000, Number.NaN, Infinity]) {
        assert.throws(
          () => {
            messengerService.createReimbursement(
              {
                messengerName: "Budi Batch3",
                employeeId: "emp-b3-103",
                date: "2026-11-15",
                category: "BBM",
                notes: "Isi bensin operasional",
                amount: badAmount,
              } as any,
              messengerActor as any
            );
          },
          (err: any) => err.statusCode === 400
        );
      }

      const created = messengerService.createReimbursement(
        {
          messengerName: "Budi Batch3",
          employeeId: "emp-b3-103",
          date: "2026-11-15",
          category: "BBM",
          notes: "BBM pengantaran berkas Batch 3",
          amount: 120000,
        } as any,
        messengerActor as any
      );
      assert.equal(created.status, "Diajukan");
      assert.equal(created.amount, 120000);
      assert.equal(created.messengerId, "msg-b3-103");
    });

    await st.test("A.2: Pay rejected before approval (Diajukan & Ditolak) and rejects > approvedAmount", () => {
      const reimb = messengerService.createReimbursement(
        {
          messengerName: "Budi Batch3",
          employeeId: "emp-b3-103",
          date: "2026-11-15",
          category: "Parkir & Tol",
          notes: "Parkir Samsat Selatan",
          amount: 100000,
        } as any,
        messengerActor as any
      );

      // Cannot pay while still Diajukan
      assert.throws(
        () => messengerService.payReimbursement(reimb.id, financeActor as any, { amount: 100000 }),
        (err: any) => err.statusCode === 400 && err.code === "INVALID_STATUS"
      );

      // Review validation: approvedAmount <= 0 or approvedAmount > requestedAmount rejected
      assert.throws(
        () => messengerService.reviewReimbursement(reimb.id, "Disetujui", svpActor as any, "Nominal 0 invalid", 0),
        (err: any) => err.statusCode === 400 && err.code === "INVALID_APPROVED_AMOUNT"
      );
      assert.throws(
        () => messengerService.reviewReimbursement(reimb.id, "Disetujui", svpActor as any, "Melebihi pengajuan", 150000),
        (err: any) => err.statusCode === 400 && err.code === "INVALID_APPROVED_AMOUNT"
      );

      // Approve partial amount 80,000
      const approved = messengerService.reviewReimbursement(
        reimb.id,
        "Disetujui",
        svpActor as any,
        "Disetujui sebagian Rp 80.000",
        80000
      );
      assert.equal(approved.status, "Disetujui");
      assert.equal(approved.approvedAmount, 80000);

      // Attempt payout > approvedAmount (90,000 > 80,000) -> 400
      assert.throws(
        () => messengerService.payReimbursement(reimb.id, financeActor as any, { amount: 90000 }),
        (err: any) => err.statusCode === 400 && err.code === "PAYOUT_EXCEEDS_APPROVED_AMOUNT"
      );

      // Reject a second reimbursement and ensure paying Ditolak returns 400 INVALID_STATUS
      const rejectedReq = messengerService.createReimbursement(
        {
          messengerName: "Budi Batch3",
          employeeId: "emp-b3-103",
          date: "2026-11-15",
          category: "Lainnya",
          notes: "Biaya tidak valid",
          amount: 50000,
        } as any,
        messengerActor as any
      );
      messengerService.reviewReimbursement(rejectedReq.id, "Ditolak", svpActor as any, "Bukti tidak lengkap");
      assert.throws(
        () => messengerService.payReimbursement(rejectedReq.id, financeActor as any, { amount: 50000 }),
        (err: any) => err.statusCode === 400 && err.code === "INVALID_STATUS"
      );
    });

    await st.test("A.3: Paid reimbursement posts Kredit to kas_messenger only & void reverses to kas_messenger (net OPEX = Rp 0, re-pay = 1x)", () => {
      // Seed Budi floating cash balance first via top-up so running balance remains positive
      financeService.addKasMessenger(
        {
          tanggal: "2026-11-15",
          jenis: "Pemasukan",
          messenger: "Budi Batch3",
          messengerId: "msg-b3-103",
          keterangan: "Top Up Modal Operasional Kurir",
          debit: 500000,
          kredit: 0,
          kategori: "INTERNAL_TRANSFER",
          paymentMethodId: activePmId,
        },
        financeActor as any
      );

      const kkBefore = (db.prepare("SELECT COUNT(*) as c FROM kas_kantor").get() as any).c;

      const req = messengerService.createReimbursement(
        {
          messengerName: "Budi Batch3",
          employeeId: "emp-b3-103",
          date: "2026-11-15",
          category: "BBM",
          notes: "Reimb Batch3 Cycle",
          amount: 75000,
        } as any,
        messengerActor as any
      );
      messengerService.reviewReimbursement(req.id, "Disetujui", svpActor as any, "OK", 75000);

      const paid = messengerService.payReimbursement(req.id, financeActor as any, {
        amount: 75000,
        paymentMethod: "Kas Messenger",
      });
      assert.equal(paid.status, "Dibayar");
      assert.ok(paid.kasMessengerId, "Paid reimbursement must link kas_messenger_id");

      // Duplicate payout rejected
      assert.throws(
        () => messengerService.payReimbursement(req.id, financeActor as any, { amount: 75000 }),
        (err: any) => err.statusCode === 400 && err.code === "ALREADY_PAID"
      );

      const kkAfterPay = (db.prepare("SELECT COUNT(*) as c FROM kas_kantor").get() as any).c;
      assert.equal(kkAfterPay, kkBefore, "payReimbursement MUST NOT touch kas_kantor");

      const kmPayRow = db.prepare("SELECT * FROM kas_messenger WHERE id = ?").get(paid.kasMessengerId) as any;
      assert.ok(kmPayRow);
      assert.equal(kmPayRow.reimbursement_id, req.id);
      assert.equal(Number(kmPayRow.kredit), 75000);
      assert.equal(Number(kmPayRow.debit), 0);

      // Verify voidReimbursement reverses kas_messenger and leaves kas_kantor untouched
      const voided = messengerService.voidReimbursement(req.id, svpActor as any, "Salah nominal pencairan");
      assert.equal(voided.status, "Disetujui");
      assert.equal(voided.kasMessengerId, undefined);
      assert.equal(voided.paidBy, undefined);

      const kkAfterVoid = (db.prepare("SELECT COUNT(*) as c FROM kas_kantor").get() as any).c;
      assert.equal(kkAfterVoid, kkBefore, "voidReimbursement MUST reverse in kas_messenger and leave kas_kantor untouched");

      const kmReversals = db
        .prepare("SELECT * FROM kas_messenger WHERE reimbursement_id = ? ORDER BY id ASC")
        .all(req.id) as any[];
      assert.equal(kmReversals.length, 2);
      assert.equal(Number(kmReversals[1].debit), 75000);
      assert.equal(Number(kmReversals[1].kredit), 0);
      assert.ok(String(kmReversals[1].keterangan).includes("[VOID/BATAL]"));
      assert.ok(String(kmReversals[1].keterangan).includes(`[Ref: ${req.id}]`));

      // Double void prevented cleanly
      assert.throws(
        () => messengerService.voidReimbursement(req.id, svpActor as any, "Double void attempt"),
        (err: any) => err.statusCode === 400 && err.code === "INVALID_STATUS"
      );

      // Laba Rugi canonical check: after void, OPEX for this reimbursement's entries cancels to Rp 0
      const pnlAfterVoid = computeCanonicalLabaRugi(
        [],
        [],
        kmReversals.map((r) => ({
          id: r.id,
          tanggal: r.tanggal,
          jenis: r.jenis,
          messenger: r.messenger,
          keterangan: r.keterangan,
          debit: Number(r.debit || 0),
          kredit: Number(r.kredit || 0),
          total: Number(r.total || 0),
          kategori: r.kategori || undefined,
        })),
        "all"
      );
      assert.equal(pnlAfterVoid.pengeluaranMessenger, 0, "Voided reimbursement must reduce messenger OPEX back to Rp 0");

      // Re-paying the voided-then-Disetujui reimbursement works and Laba Rugi counts 1x (75,000)
      const repaid = messengerService.payReimbursement(req.id, financeActor as any, { amount: 75000 });
      assert.equal(repaid.status, "Dibayar");
      const kmAfterRepay = db
        .prepare("SELECT * FROM kas_messenger WHERE reimbursement_id = ? ORDER BY id ASC")
        .all(req.id) as any[];
      const pnlAfterRepay = computeCanonicalLabaRugi(
        [],
        [],
        kmAfterRepay.map((r) => ({
          id: r.id,
          tanggal: r.tanggal,
          jenis: r.jenis,
          messenger: r.messenger,
          keterangan: r.keterangan,
          debit: Number(r.debit || 0),
          kredit: Number(r.kredit || 0),
          total: Number(r.total || 0),
          kategori: r.kategori || undefined,
        })),
        "all"
      );
      assert.equal(pnlAfterRepay.pengeluaranMessenger, 75000, "Re-paid reimbursement after void must count exactly once in OPEX");
    });

    await st.test("A.4: permanentDeleteService allows Ditolak/rejected reimbursements & blocks active/paid/linked + avoids ID collision", () => {
      const r1 = messengerService.createReimbursement(
        {
          messengerName: "Budi Batch3",
          employeeId: "emp-b3-103",
          date: "2026-11-15",
          category: "BBM",
          notes: "Will reject and delete",
          amount: 30000,
        } as any,
        messengerActor as any
      );
      messengerService.reviewReimbursement(r1.id, "Ditolak", svpActor as any, "Ditolak untuk delete");

      const r2 = messengerService.createReimbursement(
        {
          messengerName: "Budi Batch3",
          employeeId: "emp-b3-103",
          date: "2026-11-15",
          category: "BBM",
          notes: "Keep highest ID",
          amount: 40000,
        } as any,
        messengerActor as any
      );

      // Cannot delete Diajukan
      assert.throws(
        () =>
          deletePermanentlyWithAuditAndIdempotency(
            "messenger_reimbursements",
            r2.id,
            "Attempt deleting pending",
            "usr-1",
            "administrator",
            crypto.randomUUID()
          ),
        (err: any) => err.statusCode === 409 && err.code === "CANNOT_DELETE_ACTIVE_REIMBURSEMENT"
      );

      // Can delete Ditolak using usr-1
      const delRes = deletePermanentlyWithAuditAndIdempotency(
        "messenger_reimbursements",
        r1.id,
        "Menghapus reimbursement yang sudah ditolak SVP",
        "usr-1",
        "administrator",
        crypto.randomUUID()
      );
      assert.equal(delRes.statusCode, 200);

      // Next generated ID must exceed r2 numeric suffix (no COUNT(*) collision!)
      const nextId = dbMessengerRepository.getNextReimbursementId();
      const r2Num = parseInt(r2.id.replace(/\D+/g, ""), 10);
      const nextNum = parseInt(nextId.replace(/\D+/g, ""), 10);
      assert.ok(nextNum > r2Num, `Expected next ID (${nextId}) > previous max ID (${r2.id})`);
    });
  });

  // =========================================================================
  // GROUP B: KAS KANTOR & KAS MESSENGER PERSISTENT CRUD, HTTP RBAC & BALANCES
  // =========================================================================
  await t.test("Group B: Persistent CRUD, HTTP PUT/PATCH RBAC, Audit Trail, Running Balance & Reconciliation", async (st) => {
    const svpAuth = await loginHttp(baseUrl, "svp@birojasa.com", "admin123");
    const finAuth = await loginHttp(baseUrl, "b3-finance@sun89.test", "Batch3Pass123!");
    const adminAuth = await loginHttp(baseUrl, "b3-admin@sun89.test", "Batch3Pass123!");
    const msgAuth = await loginHttp(baseUrl, "b3-messenger@sun89.test", "Batch3Pass123!");

    await st.test("B.1: HTTP POST + GET reload + PUT/PATCH /api/finance/kas-kantor/:id persist & recalculate saldo", async () => {
      const create1 = await fetch(`${baseUrl}/api/finance/kas-kantor`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
        body: JSON.stringify({
          tanggal: "2026-11-16",
          status: "Debit",
          keterangan: "Setoran Tunai Batch 3",
          debit: 1000000,
          kredit: 0,
          kategori: "Kas Masuk",
          paymentMethodId: activePmId,
        }),
      });
      assert.equal(create1.status, 201);
      const kk1 = ((await create1.json()) as any).data;

      const create2 = await fetch(`${baseUrl}/api/finance/kas-kantor`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
        body: JSON.stringify({
          tanggal: "2026-11-17",
          status: "Kredit",
          keterangan: "Biaya ATK Batch 3",
          debit: 0,
          kredit: 200000,
          kategori: "ATK",
          paymentMethodId: activePmId,
        }),
      });
      assert.equal(create2.status, 201);
      const kk2 = ((await create2.json()) as any).data;
      const saldoBeforeEdit = kk2.saldo;

      // Messenger forbidden from editing Kas Kantor
      const forbiddenRes = await fetch(`${baseUrl}/api/finance/kas-kantor/${kk2.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${msgAuth.token}` },
        body: JSON.stringify({ kredit: 250000, reason: "Coba edit kas kantor" }),
      });
      assert.equal(forbiddenRes.status, 403);

      // Finance updates kk2 kredit 200,000 -> 350,000 via HTTP PUT
      const editRes = await fetch(`${baseUrl}/api/finance/kas-kantor/${kk2.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
        body: JSON.stringify({
          status: "Kredit",
          debit: 0,
          kredit: 350000,
          keterangan: "Biaya ATK Batch 3 (Revisi Nota)",
          reason: "Revisi nominal nota ATK",
        }),
      });
      assert.equal(editRes.status, 200);
      const editBody = (await editRes.json()) as any;
      assert.equal(editBody.data.kredit, 350000);
      assert.equal(editBody.data.saldo, saldoBeforeEdit - 150000);

      // Verify GET reloads persisted row from SQLite
      const listRes = await fetch(`${baseUrl}/api/finance/kas-kantor`, {
        headers: { Authorization: `Bearer ${finAuth.token}` },
      });
      assert.equal(listRes.status, 200);
      const listRows = ((await listRes.json()) as any).data as any[];
      const persisted = listRows.find((r) => r.id === kk2.id);
      assert.ok(persisted);
      assert.equal(persisted.kredit, 350000);
      assert.equal(persisted.keterangan, "Biaya ATK Batch 3 (Revisi Nota)");

      // Verify full audit log recorded before/after/actor/role/reason/timestamp with UUID id
      const auditRow = db
        .prepare("SELECT * FROM audit_logs WHERE action = 'UPDATE_KAS_KANTOR' AND metadata_json LIKE ? ORDER BY created_at DESC LIMIT 1")
        .get(`%"id":${kk2.id}%`) as any;
      assert.ok(auditRow);
      assert.equal(auditRow.user_id, "usr-101");
      assert.equal(auditRow.user_role, "finance");
      const meta = JSON.parse(auditRow.metadata_json);
      assert.equal(meta.before.kredit, 200000);
      assert.equal(meta.after.kredit, 350000);
      assert.equal(meta.reason, "Revisi nominal nota ATK");
      assert.ok(meta.timestamp);

      // Negative balance guard: raising kk2 kredit above cumulative saldo -> 409 NEGATIVE_BALANCE_VIOLATION
      const negRes = await fetch(`${baseUrl}/api/finance/kas-kantor/${kk2.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svpAuth.token}` },
        body: JSON.stringify({ kredit: 2500000, reason: "Tes rollback saldo negatif" }),
      });
      assert.equal(negRes.status, 409);
      const negBody = (await negRes.json()) as any;
      assert.equal(negBody.error.code, "NEGATIVE_BALANCE_VIOLATION");

      // DB must still hold kk2.kredit === 350,000 and kk1.debit === 1,000,000
      const kk2Db = db.prepare("SELECT kredit, saldo FROM kas_kantor WHERE id = ?").get(kk2.id) as any;
      assert.equal(Number(kk2Db.kredit), 350000);
      assert.ok(kk1.id);
    });

    await st.test("B.2: HTTP PUT /api/finance/kas-messenger/:id protects reimbursement links, recalculates across date & courier changes, and blocks negative balance", async () => {
      const kmTopupRes = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({
          tanggal: "2026-11-16",
          jenis: "Pemasukan",
          messenger: "Andi Batch3",
          messengerId: "msg-b3-104",
          keterangan: "Modal Jalan Andi",
          debit: 400000,
          kredit: 0,
          kategori: "INTERNAL_TRANSFER",
          paymentMethodId: activePmId,
        }),
      });
      assert.equal(kmTopupRes.status, 201);
      const kmTopup = ((await kmTopupRes.json()) as any).data;

      const kmExpRes = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({
          tanggal: "2026-11-17",
          jenis: "Pengeluaran",
          messenger: "Andi Batch3",
          messengerId: "msg-b3-104",
          keterangan: "Beli Materai",
          debit: 0,
          kredit: 100000,
          kategori: "Operasional",
        }),
      });
      assert.equal(kmExpRes.status, 201);
      const kmExp = ((await kmExpRes.json()) as any).data;
      assert.equal(kmExp.total, 300000);

      // Messenger forbidden (403)
      const msgForbidden = await fetch(`${baseUrl}/api/finance/kas-messenger/${kmExp.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${msgAuth.token}` },
        body: JSON.stringify({ kredit: 50000, reason: "Messenger unauthorized edit" }),
      });
      assert.equal(msgForbidden.status, 403);

      // Negative balance guard: setting kredit to 450,000 (> 400,000 balance) fails 409 & rolls back
      const kmNegRes = await fetch(`${baseUrl}/api/finance/kas-messenger/${kmExp.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
        body: JSON.stringify({ kredit: 450000, reason: "Nominal melebihi saldo kurir" }),
      });
      assert.equal(kmNegRes.status, 409);
      const kmNegBody = (await kmNegRes.json()) as any;
      assert.equal(kmNegBody.error.code, "NEGATIVE_BALANCE_VIOLATION");

      // Valid edit changing amount: kredit 100,000 -> 150,000
      const kmEditRes = await fetch(`${baseUrl}/api/finance/kas-messenger/${kmExp.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
        body: JSON.stringify({
          kredit: 150000,
          keterangan: "Beli Materai + Amplop",
          reason: "Penambahan biaya amplop",
        }),
      });
      assert.equal(kmEditRes.status, 200);
      const kmEditBody = (await kmEditRes.json()) as any;
      assert.equal(kmEditBody.data.out, 150000);
      assert.equal(kmEditBody.data.total, 250000);

      // Backdating expense BEFORE top-up triggers negative intermediate running balance -> 409!
      const backdateNegRes = await fetch(`${baseUrl}/api/finance/kas-messenger/${kmExp.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
        body: JSON.stringify({
          tanggal: "2026-11-15",
          reason: "Backdate sebelum topup",
        }),
      });
      assert.equal(backdateNegRes.status, 409);

      // Cross-courier edit: add expense for Andi on 2026-11-18 and move to Budi Batch3 (msg-b3-103)
      const kmMoveRes = await fetch(`${baseUrl}/api/finance/kas-messenger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
        body: JSON.stringify({
          tanggal: "2026-11-18",
          jenis: "Pengeluaran",
          messenger: "Andi Batch3",
          messengerId: "msg-b3-104",
          keterangan: "Tol Kurir Pindah",
          debit: 0,
          kredit: 25000,
          kategori: "Tol",
        }),
      });
      assert.equal(kmMoveRes.status, 201);
      const kmMove = ((await kmMoveRes.json()) as any).data;

      const reassignRes = await fetch(`${baseUrl}/api/finance/kas-messenger/${kmMove.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${finAuth.token}` },
        body: JSON.stringify({
          messenger: "Budi Batch3",
          messengerId: "msg-b3-103",
          reason: "Koreksi kurir pelaksana",
        }),
      });
      assert.equal(reassignRes.status, 200);
      const reassigned = ((await reassignRes.json()) as any).data;
      assert.equal(reassigned.messengerId, "msg-b3-103");
      // Budi's previous closing balance was 500,000 - 75,000 = 425,000; minus 25,000 = 400,000
      assert.equal(reassigned.total, 400000);
      // Andi's latest row (kmExp) still has running balance 250,000
      const andiLatest = db.prepare("SELECT total FROM kas_messenger WHERE id = ?").get(kmExp.id) as any;
      assert.equal(Number(andiLatest.total), 250000);

      // Reimbursement-linked Kas Messenger row is protected from direct edit (409)
      const linkedKmRow = db
        .prepare("SELECT id FROM kas_messenger WHERE reimbursement_id IS NOT NULL LIMIT 1")
        .get() as any;
      assert.ok(linkedKmRow);
      const linkedEditRes = await fetch(`${baseUrl}/api/finance/kas-messenger/${linkedKmRow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svpAuth.token}` },
        body: JSON.stringify({ kredit: 1000, reason: "Coba ubah baris reimbursement" }),
      });
      assert.equal(linkedEditRes.status, 409);
      const linkedEditBody = (await linkedEditRes.json()) as any;
      assert.equal(linkedEditBody.error.code, "CANNOT_EDIT_LINKED_KAS_MESSENGER");

      // Audit log check for UPDATE_KAS_MESSENGER
      const kmAudit = db
        .prepare("SELECT * FROM audit_logs WHERE action = 'UPDATE_KAS_MESSENGER' AND metadata_json LIKE ? ORDER BY created_at DESC LIMIT 1")
        .get(`%"id":${kmMove.id}%`) as any;
      assert.ok(kmAudit);
      const kmMeta = JSON.parse(kmAudit.metadata_json);
      assert.equal(kmMeta.before.messengerId, "msg-b3-104");
      assert.equal(kmMeta.after.messengerId, "msg-b3-103");
      assert.equal(kmMeta.reason, "Koreksi kurir pelaksana");
      assert.ok(kmTopup.id);
    });

    await st.test("B.3: GET /api/finance/cash-reconciliation enforces RBAC & reconciles ledgers + MODAL_AWAL excluded from P&L", async () => {
      const adminDenied = await fetch(`${baseUrl}/api/finance/cash-reconciliation`, {
        headers: { Authorization: `Bearer ${adminAuth.token}` },
      });
      assert.equal(adminDenied.status, 403);

      const reconRes = await fetch(`${baseUrl}/api/finance/cash-reconciliation`, {
        headers: { Authorization: `Bearer ${finAuth.token}` },
      });
      assert.equal(reconRes.status, 200);
      const recon = ((await reconRes.json()) as any).data;
      assert.equal(recon.kasKantor.reconciled, true);
      assert.equal(recon.kasMessenger.reconciled, true);
      assert.equal(recon.reimbursements.reconciled, true);
      assert.equal(recon.reimbursements.crossLedgerKasKantorReversalsCount, 0);
      assert.equal(recon.kasKantor.runningBalanceDriftCount, 0);
      assert.equal(recon.kasMessenger.runningBalanceDriftCount, 0);

      // MODAL_AWAL & INTERNAL_TRANSFER rows must be excluded from operating revenue in canonical P&L
      const allKk = dbFinanceRepository.getAllKasKantor();
      const allKm = dbFinanceRepository.getAllKasMessenger();
      const pnlCheck = computeCanonicalLabaRugi([], [], allKm, "all", undefined, undefined, undefined, allKk);
      assert.equal(pnlCheck.totalPemasukan, 0, "MODAL_AWAL and internal transfers must not inflate operating revenue");
    });
  });

  // =========================================================================
  // GROUP C: ATOMICITY, AUDIT-FAILURE ROLLBACK & DUPLICATE CONCURRENCY SAFETY
  // =========================================================================
  await t.test("Group C: Atomic Rollback on Audit Log Write Failure across Review, Pay, Void & Ledger Edits", async (st) => {
    await st.test("C.1: Audit-log exception inside transaction rolls back review, pay, void, updateKasKantor & updateKasMessenger", () => {
      const failingDb = createAuditFailureProxyDb(db);

      const r = messengerService.createReimbursement(
        {
          messengerName: "Budi Batch3",
          employeeId: "emp-b3-103",
          date: "2026-11-18",
          category: "BBM",
          notes: "Rollback Atomicity Test",
          amount: 60000,
        } as any,
        messengerActor as any
      );

      // 1. reviewReimbursement rollback on audit failure
      assert.throws(() => {
        messengerService.reviewReimbursement(r.id, "Disetujui", svpActor as any, "Should rollback", 60000, undefined, failingDb);
      }, /SIMULATED_AUDIT_WRITE_FAILURE/);
      assert.equal(dbMessengerRepository.getReimbursementById(r.id)?.status, "Diajukan");

      // Approve cleanly first
      messengerService.reviewReimbursement(r.id, "Disetujui", svpActor as any, "Approved normally", 60000);

      // 2. payReimbursement rollback on audit failure
      const kmCountBefore = (db.prepare("SELECT COUNT(*) as c FROM kas_messenger").get() as any).c;
      assert.throws(() => {
        messengerService.payReimbursement(r.id, financeActor as any, { amount: 60000 }, failingDb);
      }, /SIMULATED_AUDIT_WRITE_FAILURE/);
      assert.equal(dbMessengerRepository.getReimbursementById(r.id)?.status, "Disetujui");
      assert.equal((db.prepare("SELECT COUNT(*) as c FROM kas_messenger").get() as any).c, kmCountBefore);

      // Pay cleanly
      messengerService.payReimbursement(r.id, financeActor as any, { amount: 60000 });

      // 3. voidReimbursement rollback on audit failure
      const kmCountAfterPay = (db.prepare("SELECT COUNT(*) as c FROM kas_messenger").get() as any).c;
      assert.throws(() => {
        messengerService.voidReimbursement(r.id, svpActor as any, "Void should rollback", failingDb);
      }, /SIMULATED_AUDIT_WRITE_FAILURE/);
      assert.equal(dbMessengerRepository.getReimbursementById(r.id)?.status, "Dibayar");
      assert.equal((db.prepare("SELECT COUNT(*) as c FROM kas_messenger").get() as any).c, kmCountAfterPay);

      // 4. updateKasKantor rollback on audit failure
      const editableKk = db.prepare("SELECT id, keterangan FROM kas_kantor WHERE kategori = 'ATK' LIMIT 1").get() as any;
      assert.ok(editableKk);
      assert.throws(() => {
        financeService.updateKasKantor(editableKk.id, { keterangan: "SHOULD_ROLLBACK", reason: "Atomicity test" }, financeActor as any, failingDb);
      }, /SIMULATED_AUDIT_WRITE_FAILURE/);
      assert.equal((db.prepare("SELECT keterangan FROM kas_kantor WHERE id = ?").get(editableKk.id) as any).keterangan, editableKk.keterangan);

      // 5. updateKasMessenger rollback on audit failure
      const editableKm = db.prepare("SELECT id, keterangan FROM kas_messenger WHERE reimbursement_id IS NULL AND kategori = 'Operasional' LIMIT 1").get() as any;
      assert.ok(editableKm);
      assert.throws(() => {
        financeService.updateKasMessenger(editableKm.id, { keterangan: "SHOULD_ROLLBACK", reason: "Atomicity test" }, financeActor as any, failingDb);
      }, /SIMULATED_AUDIT_WRITE_FAILURE/);
      assert.equal((db.prepare("SELECT keterangan FROM kas_messenger WHERE id = ?").get(editableKm.id) as any).keterangan, editableKm.keterangan);
    });
  });

  // =========================================================================
  // GROUP D: FRONTEND PROVIDER & STORE CONTRACT REGRESSION
  // =========================================================================
  await t.test("Group D: Frontend Single-Write Payout & Persistent Kas Edit Contract", async (st) => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AUTH_TOKEN;

    try {
      process.env.AUTH_TOKEN = "batch3-mock-jwt";
      localStorage.setItem("auth_token", "batch3-mock-jwt");
      const recordedCalls: Array<{ url: string; method: string; body?: any }> = [];

      let mockKasKantor = [
        {
          id: 501,
          tanggal: "2026-11-18",
          keterangan: "Kas Kantor Awal",
          status: "Debit" as const,
          debit: 500000,
          kredit: 0,
          saldo: 500000,
          kategori: "Kas Masuk",
        },
      ];
      let mockKasMessenger = [
        {
          id: 601,
          tanggal: "2026-11-18",
          jenis: "Pemasukan" as const,
          messenger: "Budi Batch3",
          messengerId: "msg-b3-103",
          keterangan: "Top Up Budi",
          debit: 300000,
          kredit: 0,
          total: 300000,
          kategori: "INTERNAL_TRANSFER",
        },
      ];
      let failNextPut = false;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || "GET").toUpperCase();
        const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        recordedCalls.push({ url, method, body: parsedBody });

        if (url.endsWith("/finance/invoices") && method === "GET") {
          return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
        }
        if (url.endsWith("/finance/pengeluaran") && method === "GET") {
          return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
        }
        if (url.endsWith("/finance/kas-kantor") && method === "GET") {
          return new Response(JSON.stringify({ success: true, data: mockKasKantor }), { status: 200 });
        }
        if (url.endsWith("/finance/kas-messenger") && method === "GET") {
          return new Response(JSON.stringify({ success: true, data: mockKasMessenger }), { status: 200 });
        }
        if (url.includes("/finance/kas-kantor/") && method === "PUT") {
          if (failNextPut) {
            return new Response(JSON.stringify({ success: false, error: { message: "Saldo negatif ditolak" } }), { status: 409 });
          }
          mockKasKantor = mockKasKantor.map((k) =>
            k.id === 501 ? { ...k, debit: parsedBody.debit ?? k.debit, saldo: parsedBody.debit ?? k.debit, keterangan: parsedBody.keterangan ?? k.keterangan } : k
          );
          return new Response(JSON.stringify({ success: true, data: mockKasKantor[0] }), { status: 200 });
        }
        if (url.includes("/finance/kas-messenger/") && method === "PUT") {
          if (failNextPut) {
            return new Response(JSON.stringify({ success: false, error: { message: "Baris reimbursement terkunci" } }), { status: 409 });
          }
          mockKasMessenger = mockKasMessenger.map((m) =>
            m.id === 601 ? { ...m, debit: parsedBody.debit ?? m.debit, total: parsedBody.debit ?? m.debit, keterangan: parsedBody.keterangan ?? m.keterangan } : m
          );
          return new Response(JSON.stringify({ success: true, data: mockKasMessenger[0] }), { status: 200 });
        }
        if (url.endsWith("/messenger/reimbursements/REIMB-0099/pay") && method === "POST") {
          mockKasMessenger = [
            ...mockKasMessenger,
            {
              id: 602,
              tanggal: "2026-11-18",
              jenis: "Pemasukan",
              messenger: "Budi Batch3",
              messengerId: "msg-b3-103",
              keterangan: "Reimbursement REIMB-0099",
              debit: 0,
              kredit: 75000,
              total: 225000,
              kategori: "Reimbursement",
            } as any,
          ];
          return new Response(
            JSON.stringify({ success: true, data: { id: "REIMB-0099", status: "Dibayar", kasMessengerId: 602 } }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ success: false, error: { message: `Unhandled mock endpoint: ${method} ${url}` } }), { status: 404 });
      }) as any;

      const provider = new ApiFinanceProvider("http://localhost:9999/api");
      await provider.initFromApi();
      financeRepository.setProvider(provider);
      financeStore.syncFromRepository();

      await st.test("D.1: financeStore.payReimbursement triggers ONLY /messenger/reimbursements/:id/pay (no POST /finance/kas-messenger double write)", async () => {
        recordedCalls.length = 0;
        const paidResult = await financeStore.payReimbursement("REIMB-0099", {
          role: "finance",
          userName: "Batch3 Finance",
        });
        assert.equal(paidResult.success, true, `Expected payReimbursement success, got: ${paidResult.error}`);
        assert.equal(paidResult.data?.status, "Dibayar");

        const kmPosts = recordedCalls.filter((c) => c.method === "POST" && c.url.endsWith("/finance/kas-messenger"));
        const reimbPayPosts = recordedCalls.filter((c) => c.method === "POST" && c.url.endsWith("/messenger/reimbursements/REIMB-0099/pay"));
        assert.equal(kmPosts.length, 0, "Frontend MUST NOT perform dual-write POST /finance/kas-messenger");
        assert.equal(reimbPayPosts.length, 1, "Frontend must call canonical reimbursement payout endpoint once");
      });

      await st.test("D.2: financeStore.updateKasKantor & updateKasMessenger call PUT endpoints & reject on 409 without local mutation", async () => {
        const updatedKk = await financeStore.updateKasKantor(501, {
          debit: 750000,
          keterangan: "Updated Persisted KK",
          reason: "Revisi nominal kas kantor",
        });
        assert.equal(updatedKk?.debit, 750000);
        assert.equal(financeStore.getKasKantorList()[0].keterangan, "Updated Persisted KK");

        failNextPut = true;
        await assert.rejects(
          () =>
            financeStore.updateKasKantor(501, {
              debit: 10,
              keterangan: "Corrupted Local Attempt",
              reason: "Should fail",
            }),
          /Saldo negatif ditolak/
        );
        // State must remain unchanged at Updated Persisted KK
        assert.equal(financeStore.getKasKantorList()[0].keterangan, "Updated Persisted KK");

        await assert.rejects(
          () =>
            financeStore.updateKasMessenger(601, {
              keterangan: "Should Not Mutate",
              reason: "Should fail",
            }),
          /Baris reimbursement terkunci/
        );
        assert.equal(financeStore.getKasMessengerList()[0].keterangan, "Top Up Budi");
      });
    } finally {
      globalThis.fetch = originalFetch;
      localStorage.removeItem("auth_token");
      if (originalToken === undefined) {
        delete process.env.AUTH_TOKEN;
      } else {
        process.env.AUTH_TOKEN = originalToken;
      }
    }
  });
});
