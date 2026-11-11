/**
 * SUN89 — Phase 4B Batch 2B/2C: End-to-End Payment Methods Integration Test Suite
 * Tests 11 required scenarios:
 * 1. Top-up Kas Messenger with Tunai
 * 2. Top-up Kas Messenger with Bank Transfer
 * 3. Reject Top-up Kas Messenger without Payment Method
 * 4. Payout Reimbursement Kas Messenger strictly NULL Payment Method
 * 5. Kas Kantor with Tunai
 * 6. Kas Kantor with Bank Transfer
 * 7. Invoice Payment Verification snapshot replication to Kas Kantor
 * 8. Master method modification/deactivation does not mutate frozen snapshots
 * 9. Persistence & reload verification
 * 10. Historical records without payment method remain safe (NULL preserved)
 * 11. Running balances, audit logs, and relational integrity intact
 */

import "./setup-test-portal-shim";
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { db } from "../server/src/database/db";
import { runKasDomainSeparationMigration } from "../server/src/database/migrations/2026-11-11-001-kas-domain-separation";
import { runInvoiceOrderUniqueMigration } from "../server/src/database/migrations/2026-11-12-001-invoice-order-unique";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import { financeService } from "../server/src/services/financeService";

describe("SUN89 — Payment Methods Kas Messenger & Kas Kantor E2E Suite", () => {
  test.before(() => {
    runKasDomainSeparationMigration(db);
    runInvoiceOrderUniqueMigration(db);
  });

  it("1. Tambah top-up Kas Messenger dengan Tunai (pm-cash)", () => {
    const entry = financeService.addKasMessenger(
      {
        tanggal: "2026-11-11",
        jenis: "Petty cash",
        messenger: "Budi Santoso",
        keterangan: "Top up kas kecil kurir mingguan",
        in: 250000,
        out: 0,
        payment_method_id: "pm-cash",
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    assert.ok(entry.id > 0, "ID harus bernilai positif");
    assert.equal(entry.in, 250000);
    assert.equal(entry.paymentMethodId, "pm-cash");
    assert.ok(entry.paymentMethodSnapshot, "Snapshot harus tersedia");

    const snap = JSON.parse(entry.paymentMethodSnapshot!);
    assert.equal(snap.id, "pm-cash");
    assert.equal(snap.nama_metode, "Tunai");
    assert.equal(snap.bank, "Tunai");

    // Direct DB check
    const row = db.prepare("SELECT * FROM kas_messenger WHERE id = ?").get(entry.id) as any;
    assert.equal(row.payment_method_id, "pm-cash");
    assert.ok(row.payment_method_snapshot.includes("Tunai"));
  });

  it("2. Tambah top-up Kas Messenger dengan rekening bank (BCA)", () => {
    const bcaId = "pm-1793943329508-s6ykx"; // BCA ANISA SUSANTI
    const entry = financeService.addKasMessenger(
      {
        tanggal: "2026-11-11",
        jenis: "Operasional",
        messenger: "Budi Santoso",
        keterangan: "Transfer top-up operasional kurir via BCA",
        in: 500000,
        out: 0,
        payment_method_id: bcaId,
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    assert.equal(entry.paymentMethodId, bcaId);
    assert.ok(entry.paymentMethodSnapshot);
    const snap = JSON.parse(entry.paymentMethodSnapshot!);
    assert.equal(snap.bank, "BCA");
    assert.equal(snap.nomor_rekening, "7175095764");
    assert.equal(snap.nama_rekening, "ANISA SUSANTI");
  });

  it("3. Tolak top-up Kas Messenger tanpa metode pembayaran fail-closed", () => {
    assert.throws(
      () => {
        financeService.addKasMessenger(
          {
            tanggal: "2026-11-11",
            jenis: "Petty cash",
            messenger: "Budi Santoso",
            keterangan: "Top up tanpa metode",
            in: 300000,
            out: 0,
            // payment_method_id omitted
          },
          { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
          db
        );
      },
      (err: any) => err.code === "INVALID_PAYMENT_METHOD" || err.message.includes("Metode pembayaran wajib"),
      "Harus menolak top-up kas messenger tanpa metode pembayaran"
    );
  });

  it("4. Payout reimbursement / kas keluar kurir strictly memiliki NULL metode pembayaran", () => {
    // Top up first to establish courier balance
    financeService.addKasMessenger(
      {
        tanggal: "2026-11-11",
        jenis: "Petty cash",
        messenger: "Budi Santoso",
        keterangan: "Top up awal modal kurir",
        in: 100000,
        out: 0,
        payment_method_id: "pm-cash",
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    // Even if client speculatively provides payment_method_id, backend must enforce NULL
    const entry = financeService.addKasMessenger(
      {
        tanggal: "2026-11-11",
        jenis: "Operasional",
        messenger: "Budi Santoso",
        keterangan: "Pembelian bensin dan tambal ban",
        in: 0,
        out: 75000,
        payment_method_id: "pm-cash", // Speculative!
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    assert.equal(entry.out, 75000);
    assert.equal(entry.paymentMethodId || null, null, "Payment method ID harus strictly null untuk pengeluaran");
    assert.equal(entry.paymentMethodSnapshot || null, null, "Snapshot harus strictly null untuk pengeluaran");

    const row = db.prepare("SELECT * FROM kas_messenger WHERE id = ?").get(entry.id) as any;
    assert.equal(row.payment_method_id, null);
    assert.equal(row.payment_method_snapshot, null);
  });

  it("5. Tambah transaksi Kas Kantor dengan metode Tunai (pm-cash)", () => {
    const entry = financeService.addKasKantor(
      {
        tanggal: "2026-11-11",
        status: "Debit",
        kategori: "Operasional",
        keterangan: "Penerimaan tunai kas kantor",
        debit: 500000,
        kredit: 0,
        payment_method_id: "pm-cash",
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    assert.ok(entry.id > 0);
    assert.equal(entry.debit, 500000);
    assert.equal(entry.paymentMethodId, "pm-cash");
    assert.ok(entry.paymentMethodSnapshot);

    const snap = JSON.parse(entry.paymentMethodSnapshot!);
    assert.equal(snap.id, "pm-cash");
    assert.equal(snap.nama_metode, "Tunai");
    assert.equal(snap.bank, "Tunai");

    const row = db.prepare("SELECT * FROM kas_kantor WHERE id = ?").get(entry.id) as any;
    assert.equal(row.payment_method_id, "pm-cash");
    assert.ok(row.payment_method_snapshot.includes("Tunai"));
  });

  it("6. Tambah transaksi Kas Kantor dengan rekening bank (CIMB NIAGA)", () => {
    const cimbId = "pm-1793943310357-9gmfz"; // CIMB NIAGA
    const entry = financeService.addKasKantor(
      {
        tanggal: "2026-11-11",
        status: "Debit",
        kategori: "Operasional",
        keterangan: "Penerimaan transfer CIMB Niaga",
        debit: 750000,
        kredit: 0,
        payment_method_id: cimbId,
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    assert.equal(entry.paymentMethodId, cimbId);
    assert.ok(entry.paymentMethodSnapshot);
    const snap = JSON.parse(entry.paymentMethodSnapshot!);
    assert.equal(snap.bank, "CIMB NIAGA");
    assert.equal(snap.nomor_rekening, "707751492800");
    assert.equal(snap.nama_rekening, "ANISA SUSANTI");

    const row = db.prepare("SELECT * FROM kas_kantor WHERE id = ?").get(entry.id) as any;
    assert.equal(row.payment_method_id, cimbId);
    assert.ok(row.payment_method_snapshot.includes("CIMB NIAGA"));
  });

  it("7. Verifikasi pembayaran invoice menyalin snapshot ke Kas Kantor", () => {
    const orderNo = "ORD-TEST-VERIF-001";
    const invNo = "INV-TEST-VERIF-001";
    const pmId = "pm-1793943329508-s6ykx"; // BCA

    // Setup order and invoice
    db.prepare(`
      INSERT OR REPLACE INTO orders (order_no, customer, nomor_hp, layanan, nopol, payment_status, total_biaya, data_json, created_at, updated_at)
      VALUES (?, 'Client Verif', '08129999999', 'Perpanjangan STNK', 'B 9999 TST', 'Belum Lunas', 1000000, '{}', datetime('now'), datetime('now'))
    `).run(orderNo);

    db.prepare(`
      INSERT OR REPLACE INTO finance_invoices (invoice_no, order_no, customer, layanan, status, total_tagihan, dibayar, sisa, data_json, created_at, updated_at)
      VALUES (?, ?, 'Client Verif', 'Perpanjangan STNK', 'UNPAID', 1000000, 0, 1000000, '{}', datetime('now'), datetime('now'))
    `).run(invNo, orderNo);

    const frozenSnapshot = JSON.stringify({
      id: pmId,
      nama_metode: "Transfer Bank",
      bank: "BCA",
      nomor_rekening: "7175095764",
      nama_rekening: "ANISA SUSANTI",
    });

    const paymentId = `pay-${crypto.randomUUID()}`;
    // Record invoice payment with frozen snapshot
    const pmt = dbFinanceRepository.recordInvoicePayment({
      paymentId: paymentId,
      invoiceNo: invNo,
      orderNo: orderNo,
      nominal: 1000000,
      metodePembayaran: "Transfer BCA",
      metode_pembayaran_id: pmId,
      payment_method_snapshot: frozenSnapshot,
      statusVerifikasi: "MENUNGGU_VERIFIKASI",
    }, db);

    assert.ok(pmt && pmt.id > 0);

    // Verify payment using financeService.verifyPayment
    const verifyResult = financeService.verifyPayment({
      orderNo: orderNo,
      invoiceNo: invNo,
      paymentId: paymentId,
      verifierName: "Supervisor User",
      user: { userId: "usr-spv", role: "supervisor", nama: "Supervisor", username: "spv" } as any,
      proofPayload: { fileName: "bukti-transfer.jpg", fileUrl: "/uploads/bukti-transfer.jpg" },
    });

    assert.ok(verifyResult.kasItem, "Kas kantor ID harus terbit");

    // Check Kas Kantor entry created by verification
    const kasRow = db.prepare("SELECT * FROM kas_kantor WHERE id = ?").get(verifyResult.kasItem.id) as any;
    assert.equal(kasRow.payment_method_id, pmId);
    assert.equal(kasRow.payment_method_snapshot, frozenSnapshot, "Snapshot pada kas_kantor harus identik dengan invoice_payments");
  });

  it("8. Mutasi master metode pembayaran tidak mengubah snapshot transaksi historis", () => {
    const muamalatId = "pm-1793943359922-z6f4i";

    // 1. Catat transaksi dengan master metode Muamalat
    const entry = financeService.addKasKantor(
      {
        tanggal: "2026-11-11",
        status: "Debit",
        kategori: "Operasional",
        keterangan: "Penerimaan rekening Muamalat",
        debit: 400000,
        kredit: 0,
        payment_method_id: muamalatId,
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    const initialSnapshot = entry.paymentMethodSnapshot;
    assert.ok(initialSnapshot?.includes("SUN DELAPAN SEMBILAN CV"));

    // 2. Ubah / nonaktifkan master metode pembayaran di database
    db.prepare(`
      UPDATE payment_methods 
      SET nama_rekening = 'REKENING TELAH BERUBAH', bank = 'BANK MODIFIKASI', status = 'Nonaktif'
      WHERE id = ?
    `).run(muamalatId);

    // 3. Baca kembali transaksi kas kantor
    const fetched = dbFinanceRepository.getKasKantorById(entry.id, db);
    assert.ok(fetched);
    assert.equal(fetched.paymentMethodSnapshot, initialSnapshot, "Snapshot historis tidak boleh terpengaruh perubahan master");
    assert.ok(fetched.paymentMethodSnapshot?.includes("SUN DELAPAN SEMBILAN CV"), "Nama rekening lama harus tetap tersimpan");
  });

  it("9. Persistence: Data metode pembayaran tetap tampil setelah instance di-reload", () => {
    const entry = financeService.addKasMessenger(
      {
        tanggal: "2026-11-11",
        jenis: "Petty cash",
        messenger: "Budi Santoso",
        keterangan: "Top up reload check",
        in: 120000,
        out: 0,
        payment_method_id: "pm-cash",
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    // Open an independent fresh connection directly to on-disk database to verify persistence
    const reloadedConn = new DatabaseSync(process.env.DB_PATH!);
    reloadedConn.exec("PRAGMA foreign_keys = ON;");

    const list = dbFinanceRepository.getAllKasMessenger(undefined, reloadedConn);
    const found = list.find((m) => m.id === entry.id);

    reloadedConn.close();

    assert.ok(found, "Record harus ditemukan setelah reload");
    assert.equal(found.paymentMethodId, "pm-cash");
    assert.ok(found.paymentMethodSnapshot);
    const snap = JSON.parse(found.paymentMethodSnapshot);
    assert.equal(snap.nama_metode, "Tunai");
  });

  it("10. Transaksi historis tanpa metode pembayaran tetap aman (NULL dipertahankan)", () => {
    // Insert a historical row without payment method
    db.prepare(`
      INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, penanggung_jawab, created_at)
      VALUES ('2026-10-01', 'Transaksi lama era sebelum migrasi', 'Debit', 500000, 0, 500000, 'Staff Lama', datetime('now'))
    `).run();

    const allKantor = dbFinanceRepository.getAllKasKantor(db);
    const hist = allKantor.find((k) => k.keterangan === "Transaksi lama era sebelum migrasi");

    assert.ok(hist);
    assert.equal(hist.paymentMethodId, undefined);
    assert.equal(hist.paymentMethodSnapshot, undefined);

    // Historical invoice_payments rows #1-#7
    const rows = db.prepare("SELECT id, payment_id, metode_pembayaran_id, payment_method_snapshot FROM invoice_payments WHERE id <= 7").all() as any[];
    for (const r of rows) {
      assert.equal(r.metode_pembayaran_id, null);
      assert.equal(r.payment_method_snapshot, null);
    }
  });

  it("11. Saldo berjalan, audit logs, dan relasi tidak rusak", () => {
    const m1 = financeService.addKasMessenger(
      {
        tanggal: "2026-11-11",
        jenis: "Petty cash",
        messenger: "Andi Pratama",
        keterangan: "Top up 1",
        in: 200000,
        out: 0,
        payment_method_id: "pm-cash",
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    const m2 = financeService.addKasMessenger(
      {
        tanggal: "2026-11-11",
        jenis: "Operasional",
        messenger: "Andi Pratama",
        keterangan: "Pengeluaran 1",
        in: 0,
        out: 50000,
      },
      { userId: "usr-admin", role: "administrator", nama: "Admin User", username: "admin" } as any,
      db
    );

    const list = dbFinanceRepository.getAllKasMessenger(undefined, db);
    const r1 = list.find((x) => x.id === m1.id);
    const r2 = list.find((x) => x.id === m2.id);

    assert.ok(r1 && r2);
    // Running total must be calculated accurately
    assert.equal(r1.total, 200000);
    assert.equal(r2.total, 150000);

    // Audit logs recorded
    const logs = db.prepare("SELECT * FROM audit_logs WHERE user_id = 'usr-admin'").all();
    assert.ok(logs.length > 0, "Audit logs harus mencatat aktivitas admin");
  });
});
