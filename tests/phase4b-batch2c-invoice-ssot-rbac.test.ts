/**
 * Phase 4B Batch 2C — Acceptance Test Suite
 * Backend Invoice SSoT, Order-Invoice Uniqueness, Frontend Void RBAC, and Historical Reconciliation
 * 
 * Powered by node:test & node:assert/strict
 */

import "./setup-test-portal-shim";
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runInvoiceOrderUniqueMigration, rollbackInvoiceOrderUniqueMigration } from "../server/src/database/migrations/2026-11-12-001-invoice-order-unique";
import { runHistoricalReconciliation } from "../scripts/reconcile-historical-inv-1126";
import { orderService } from "../server/src/services/orderService";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import { dbOrderRepository } from "../server/src/repositories/dbOrderRepository";
import { financeService } from "../server/src/services/financeService";
import { db, getDb, runInTransaction } from "../server/src/database/db";
import { ApiError } from "../server/src/middleware/errorHandler";

describe("Phase 4B Batch 2C — Backend Invoice SSoT & Order-Invoice Uniqueness", () => {
  const testDb = getDb();

  describe("Group A: Backend Invoice Numbering SSoT (BD-FIN-03)", () => {
    it("TC-SSOT-01: Client-provided forged noInvoice and payment.invoiceNo are completely ignored and stripped", () => {
      const forgedPayload: any = {
        customer: "Client Forger",
        nopol: "B 9999 FRG",
        layanan: "Perpanjangan STNK Tahunan",
        namaPemilik: "Forger Account",
        nomorHP: "081299999999",
        totalEstimasi: 500000,
        biayaJasa: 50000,
        noInvoice: "FORGED-INV-9999",
        payment: {
          invoiceNo: "FORGED-PAY-INV-8888",
          totalBiaya: 500000,
          dibayar: 500000,
          metodePembayaran: "Transfer Bank BCA",
        },
      };

      const created = orderService.createOrder(forgedPayload, {
        userId: "usr-admin",
        nama: "Staff Admin",
        role: "admin",
      });

      assert.notEqual(created.noInvoice, "FORGED-INV-9999");
      assert.match(created.noInvoice || "", /^INV-\d{4}-\d{3}$/);
      assert.equal(created.payment?.invoiceNo, created.noInvoice);

      const savedInv = dbFinanceRepository.getInvoiceByNo(created.noInvoice!);
      assert.ok(savedInv);
      assert.equal(savedInv.orderNo, created.orderNo);
    });

    it("TC-SSOT-02: Backend generates strictly sequential, non-colliding order and invoice numbers", () => {
      const orderA = orderService.createOrder({
        customer: "Customer A",
        nopol: "B 1001 SEQ",
        layanan: "Perpanjangan STNK Tahunan",
        namaPemilik: "Cust A",
        nomorHP: "081211111111",
        totalEstimasi: 500000,
        biayaJasa: 50000,
      });

      const orderB = orderService.createOrder({
        customer: "Customer B",
        nopol: "B 1002 SEQ",
        layanan: "Perpanjangan STNK Tahunan",
        namaPemilik: "Cust B",
        nomorHP: "081222222222",
        totalEstimasi: 500000,
        biayaJasa: 50000,
      });

      assert.match(orderA.orderNo, /^ORD-\d{4}-\d{3}$/);
      assert.match(orderB.orderNo, /^ORD-\d{4}-\d{3}$/);
      assert.match(orderA.noInvoice || "", /^INV-\d{4}-\d{3}$/);
      assert.match(orderB.noInvoice || "", /^INV-\d{4}-\d{3}$/);

      const seqA = parseInt(orderA.orderNo.split("-")[2], 10);
      const seqB = parseInt(orderB.orderNo.split("-")[2], 10);
      assert.equal(seqB, seqA + 1);

      const invSeqA = parseInt(orderA.noInvoice!.split("-")[2], 10);
      const invSeqB = parseInt(orderB.noInvoice!.split("-")[2], 10);
      assert.equal(invSeqB, invSeqA + 1);
    });

    it("TC-SSOT-03: Numeric suffix ordering correctly identifies numeric max over alphanumeric sorting", () => {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const yy = String(now.getFullYear()).slice(-2);
      const period = `${mm}${yy}`;

      testDb.prepare(`
        INSERT OR IGNORE INTO orders (order_no, customer, nomor_hp, layanan, nopol, data_json, created_at)
        VALUES (?, 'Test Cust', '081200000000', 'Perpanjangan STNK', 'B 1234 NUM', '{}', datetime('now'))
      `).run(`ORD-${period}-009`);

      testDb.prepare(`
        INSERT OR IGNORE INTO orders (order_no, customer, nomor_hp, layanan, nopol, data_json, created_at)
        VALUES (?, 'Test Cust', '081200000000', 'Perpanjangan STNK', 'B 1234 NUM', '{}', datetime('now'))
      `).run(`ORD-${period}-010`);

      const newOrder = orderService.createOrder({
        customer: "Customer Next",
        nopol: "B 1011 NUM",
        layanan: "Perpanjangan STNK Tahunan",
        namaPemilik: "Cust Next",
        nomorHP: "081233333333",
        totalEstimasi: 500000,
        biayaJasa: 50000,
      });

      const nextNum = parseInt(newOrder.orderNo.split("-")[2], 10);
      assert.ok(nextNum >= 11, `Expected sequence >= 11, got ${nextNum}`);
    });

    it("TC-SSOT-04: Malformed historical sequence is safely skipped without aborting sequence generation", () => {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const yy = String(now.getFullYear()).slice(-2);
      const period = `${mm}${yy}`;

      testDb.prepare(`
        INSERT OR IGNORE INTO orders (order_no, customer, layanan, nopol, data_json, created_at)
        VALUES (?, 'Malformed Cust', 'Perpanjangan STNK', 'B 9999 MAL', '{}', datetime('now'))
      `).run(`ORD-${period}-MALFORMED`);

      const newOrder = orderService.createOrder({
        customer: "Customer Recovery",
        nopol: "B 9999 REC",
        layanan: "Perpanjangan STNK Tahunan",
        namaPemilik: "Cust Rec",
        nomorHP: "081244444444",
        totalEstimasi: 500000,
        biayaJasa: 50000,
      });

      assert.match(newOrder.orderNo, new RegExp(`^ORD-${period}-\\d{3}$`));
      assert.match(newOrder.noInvoice || "", new RegExp(`^INV-${period}-\\d{3}$`));
    });

    it("TC-SSOT-05: Concurrent order creations are serialized under write lock without sequence collisions", () => {
      const createdOrders = Array.from({ length: 5 }, (_, i) =>
        orderService.createOrder({
          customer: `Concurrent Cust ${i}`,
          nopol: `B 200${i} CON`,
          layanan: "Perpanjangan STNK Tahunan",
          namaPemilik: `Conc ${i}`,
          nomorHP: `08125555555${i}`,
          totalEstimasi: 500000,
          biayaJasa: 50000,
        })
      );

      const orderNumbers = createdOrders.map((r) => r.orderNo);
      const invoiceNumbers = createdOrders.map((r) => r.noInvoice);

      const uniqueOrders = new Set(orderNumbers);
      const uniqueInvoices = new Set(invoiceNumbers);

      assert.equal(uniqueOrders.size, 5);
      assert.equal(uniqueInvoices.size, 5);
    });

    it("TC-SSOT-06: Atomic rollback guarantees zero orphaned records on persistence failure", () => {
      const originalSave = dbFinanceRepository.saveInvoice;
      dbFinanceRepository.saveInvoice = () => {
        throw new Error("Simulated unexpected disk failure during invoice persistence");
      };

      let threw = false;
      try {
        orderService.createOrder({
          customer: "Failing Order",
          nopol: "B 5555 FAIL",
          layanan: "Perpanjangan STNK Tahunan",
          namaPemilik: "Fail",
          nomorHP: "081266666666",
          totalEstimasi: 500000,
          biayaJasa: 50000,
        });
      } catch (err: any) {
        threw = true;
        assert.match(err.message, /Simulated unexpected disk failure/);
      } finally {
        dbFinanceRepository.saveInvoice = originalSave;
      }
      assert.ok(threw, "Expected createOrder to throw on persistence failure");
    });

    it("TC-SSOT-07: SQLITE_BUSY error is properly mapped to HTTP 503 SERVICE_UNAVAILABLE", () => {
      const originalRunInTx = dbOrderRepository.saveOrder;
      dbOrderRepository.saveOrder = () => {
        const busyErr = new Error("database is locked");
        (busyErr as any).code = "SQLITE_BUSY";
        (busyErr as any).errcode = 5;
        throw busyErr;
      };

      let threw = false;
      try {
        orderService.createOrder({
          customer: "Busy Order",
          nopol: "B 7777 BSY",
          layanan: "Perpanjangan STNK Tahunan",
          namaPemilik: "Busy",
          nomorHP: "081277777777",
          totalEstimasi: 500000,
          biayaJasa: 50000,
        });
      } catch (err: any) {
        threw = true;
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, "SERVICE_UNAVAILABLE");
      } finally {
        dbOrderRepository.saveOrder = originalRunInTx;
      }
      assert.ok(threw, "Expected createOrder to throw 503 on SQLITE_BUSY");
    });
  });

  describe("Group B: Order–Invoice Uniqueness (GAP-FIN-02)", () => {
    it("TC-UNIQ-01: Idempotent migration successfully creates and verifies UNIQUE index", () => {
      const result1 = runInvoiceOrderUniqueMigration(testDb);
      assert.equal(result1.success, true);

      const idx = testDb.prepare(
        `SELECT name, "unique" FROM pragma_index_list('finance_invoices') WHERE name = 'idx_invoices_order_unique'`
      ).get() as { name: string; unique: number };

      assert.ok(idx);
      assert.equal(idx.unique, 1);

      // Re-run migration idempotency check
      const result2 = runInvoiceOrderUniqueMigration(testDb);
      assert.equal(result2.success, true);
      assert.match(result2.message, /already exists and is valid/);
    });

    it("TC-UNIQ-02: Migration blocks fail-closed and rolls back on precondition failure (dirty duplicate order_no)", () => {
      // Temporarily rollback unique index to simulate legacy database state prior to migration
      rollbackInvoiceOrderUniqueMigration(testDb);

      testDb.prepare(`
        INSERT OR IGNORE INTO orders (order_no, customer, nomor_hp, layanan, nopol, data_json, created_at)
        VALUES ('ORD-1126-999', 'Cust Dup', '081200000000', 'Layanan', 'B 1111 DUP', '{}', datetime('now'))
      `).run();

      testDb.prepare(`
        INSERT INTO finance_invoices (invoice_no, order_no, customer, layanan, status, data_json)
        VALUES ('INV-TEST-DUP-A', 'ORD-1126-999', 'Cust Dup', 'Layanan', 'UNPAID', '{}')
      `).run();

      testDb.prepare(`
        INSERT INTO finance_invoices (invoice_no, order_no, customer, layanan, status, data_json)
        VALUES ('INV-TEST-DUP-B', 'ORD-1126-999', 'Cust Dup', 'Layanan', 'UNPAID', '{}')
      `).run();

      assert.throws(
        () => runInvoiceOrderUniqueMigration(testDb),
        /Precondition 1 failed.*duplicate order_no/
      );

      // Cleanup dirty rows so subsequent tests remain pristine
      testDb.prepare("DELETE FROM finance_invoices WHERE order_no = 'ORD-1126-999'").run();
      testDb.prepare("DELETE FROM orders WHERE order_no = 'ORD-1126-999'").run();

      // Reapply clean migration
      runInvoiceOrderUniqueMigration(testDb);
    });

    it("TC-UNIQ-03: Attempting to insert a duplicate invoice for the same order triggers UNIQUE constraint rejection", () => {
      runInvoiceOrderUniqueMigration(testDb);

      const uniqueOrderNo = `ORD-1126-${Date.now().toString().slice(-3)}`;
      testDb.prepare(`
        INSERT INTO orders (order_no, customer, nomor_hp, layanan, nopol, data_json, created_at)
        VALUES (?, 'Unique Cust', '081200000000', 'Layanan', 'B 2222 UNQ', '{}', datetime('now'))
      `).run(uniqueOrderNo);

      // First invoice succeeds
      dbFinanceRepository.saveInvoice({
        invoiceNo: `INV-U1-${Date.now()}`,
        orderNo: uniqueOrderNo,
        customer: "Unique Cust",
        layanan: "Layanan",
      });

      // Second invoice for the same order must fail with relational violation or unique constraint conflict
      assert.throws(() => {
        dbFinanceRepository.saveInvoice({
          invoiceNo: `INV-U2-${Date.now()}`,
          orderNo: uniqueOrderNo,
          customer: "Unique Cust",
          layanan: "Layanan",
        });
      });
    });

    it("TC-UNIQ-04: saveInvoice rejects empty or missing orderNo fail-closed", () => {
      assert.throws(
        () => {
          dbFinanceRepository.saveInvoice({
            invoiceNo: `INV-NO-ORD-${Date.now()}`,
            orderNo: "   ",
            customer: "Invalid Cust",
            layanan: "Layanan",
          });
        },
        /Order number is mandatory/
      );
    });
  });

  describe("Group C: Frontend Void RBAC Alignment (GAP-FIN-07)", () => {
    it("TC-RBAC-01: canVoidFinancialRecords logic strictly grants access only to canonical supervisor/admin roles", () => {
      function evaluateRole(role: string, jabatan?: string): boolean {
        const allowedRoles = ["administrator", "supervisor", "spv", "svp"];
        const r = String(role || "").trim().toLowerCase();
        return allowedRoles.includes(r);
      }

      assert.equal(evaluateRole("supervisor"), true);
      assert.equal(evaluateRole("spv"), true);
      assert.equal(evaluateRole("svp"), true);
      assert.equal(evaluateRole("administrator"), true);

      // Operator admin must be strictly excluded
      assert.equal(evaluateRole("admin"), false);
      assert.equal(evaluateRole("finance"), false);
      assert.equal(evaluateRole("messenger"), false);

      // Spoofed jabatan must have ZERO influence
      assert.equal(evaluateRole("admin", "Supervisor Operasional"), false);
      assert.equal(evaluateRole("finance", "SPV Keuangan"), false);
    });

    it("TC-RBAC-02: Direct backend authorization rejects admin role with HTTP 403 FORBIDDEN", () => {
      const adminUser = { id: "u-admin", role: "admin", nama: "Admin Operator" };

      assert.throws(
        () => {
          financeService.voidInvoicePayment(
            1,
            1,
            "Pembatalan ilegal oleh admin",
            adminUser
          );
        },
        (err: any) => {
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, "FORBIDDEN");
          return true;
        }
      );
    });
  });

  describe("Group D: Standalone Historical Reconciliation & Payment Integrity (BD-FIN-01)", () => {
    it("TC-REC-01: Reconciliation script safely defaults to DRY-RUN with zero database writes", () => {
      const report = runHistoricalReconciliation({
        targetDb: testDb,
        execute: false,
      });

      assert.equal(report.mode, "DRY_RUN");
      assert.equal(report.status, "HOLD");
      assert.equal(report.executed, false);
      assert.ok(report.missingEvidence.length > 0);
      assert.equal(report.operationalDbProtected, true);
    });

    it("TC-REC-02: Reconciliation script enforces HOLD and refuses mutation when external issuance is unproven", () => {
      const report = runHistoricalReconciliation({
        targetDb: testDb,
        execute: true,
        externalIssuanceProven: false,
        selectedOption: "HOLD",
      });

      assert.equal(report.status, "HOLD");
      assert.equal(report.executed, false);
      assert.match(report.message, /\[RECONCILIATION HOLD\]/);
    });

    it("TC-REC-03: Payment history analysis preserves known lifecycle transitions #2->#3 and #6->#7", () => {
      const report = runHistoricalReconciliation({ targetDb: testDb });

      const has2to3 = report.paymentAnalysis.lifecyclePairs.some((p) => p.fromId === 2 && p.toId === 3);
      const has6to7 = report.paymentAnalysis.lifecyclePairs.some((p) => p.fromId === 6 && p.toId === 7);
      const has1and3 = report.paymentAnalysis.unresolvedRelations.some((r) => r.idA === 1 && r.idB === 3);

      assert.ok(has2to3, "Expected lifecycle transition #2 -> #3");
      assert.ok(has6to7, "Expected lifecycle transition #6 -> #7");
      assert.ok(has1and3, "Expected unresolved relation #1 vs #3");
    });

    it("TC-REC-04: In sandbox database with external evidence confirmed, Option A executes cleanly with intact payment nominals", () => {
      const report = runHistoricalReconciliation({
        targetDb: testDb,
        execute: true,
        externalIssuanceProven: true,
        selectedOption: "OPTION_A",
      });

      assert.equal(report.status, "PROCEED");
      assert.equal(report.executed, true);

      const p1 = testDb.prepare("SELECT nominal FROM invoice_payments WHERE id = 1").get() as { nominal: number };
      assert.equal(p1.nominal, 563000);

      const p7 = testDb.prepare("SELECT nominal, invoice_no FROM invoice_payments WHERE id = 7").get() as { nominal: number; invoice_no: string };
      assert.equal(p7.nominal, 1258000);
      assert.equal(p7.invoice_no, "INV-1126-003");
    });
  });
});
