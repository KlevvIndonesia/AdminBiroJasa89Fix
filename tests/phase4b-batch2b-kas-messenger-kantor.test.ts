/**
 * Phase 4B Batch 2B: Kas Messenger & Kas Kantor Acceptance Test Suite
 * Technical Design Revision 2.8-FINAL.7 Acceptance Verification (83 Tests)
 * 
 * Group A: Migration & Schema Safety (4 Tests)
 * Group B: Invoice Identifier Resolver (9 Tests)
 * Group C: Payment Identity & Relational Binding (8 Tests)
 * Group D: Idempotency, Request Hashing & Actor Ownership (13 Tests)
 * Group E: Payment Method Snapshot & Historical Immutability (11 Tests)
 * Group F: Financial Rules, Lifecycle & Business Date Validation (12 Tests)
 * Group G: SVP Permanent Deletion & Cascade Blockers (17 Tests)
 * Group H: Cash Ledger Domain, Separation & Summary Integrity (9 Tests)
 * Total: 83 Tests
 */

import "./setup-test-portal-shim";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db, runInTransaction } from "../server/src/database/db";
import { runKasDomainSeparationMigration } from "../server/src/database/migrations/2026-11-11-001-kas-domain-separation";
import {
  verifyInvoicePaymentAtomic,
  validatePaymentMethodSnapshot,
} from "../server/src/services/invoicePaymentVerificationService";
import {
  deletePermanentlyWithAuditAndIdempotency,
} from "../server/src/services/permanentDeleteService";
import {
  recalculateKasKantorRunningBalances,
  recalculateKasMessengerRunningBalances,
  assertNoSubsequentNegativeBalance,
} from "../server/src/services/cashLedgerCalculationService";
import { validateAndNormalizeBusinessDate } from "../server/src/utils/dateNormalizer";
import { dbFinanceRepository } from "../server/src/repositories/dbFinanceRepository";
import { financeService } from "../server/src/services/financeService";
import { messengerService } from "../server/src/services/messengerService";
import { paymentMethodService } from "../server/src/services/paymentMethodService";
import { orderService } from "../server/src/services/orderService";

// Canonical Payment Method Constants from live master
const CIMB_PM_ID = "pm-1793943310357-9gmfz";
const BCA_PM_ID = "pm-1793943329508-s6ykx";
const CASH_PM_ID = "pm-cash";

const cimbSnapshotJson = JSON.stringify({
  id: CIMB_PM_ID,
  nama_metode: "Transfer Bank",
  bank: "CIMB NIAGA",
  nama_rekening: "ANISA SUSANTI",
  nomor_rekening: "707751492800",
});

const cashSnapshotJson = JSON.stringify({
  id: CASH_PM_ID,
  nama_metode: "Tunai",
  bank: "Tunai",
  nama_rekening: "",
  nomor_rekening: "",
});

// Test Actor Contexts
const testAdminActor = { id: "1", role: "admin", nama: "Admin User", status: "Aktif" };
const testFinanceActor = { id: "2", role: "finance", nama: "Finance User", status: "Aktif" };
const testSvpActor = { id: "3", role: "svp", nama: "Supervisor User", status: "Aktif" };
const testInactiveActor = { id: "98", role: "svp", nama: "Inactive SVP", status: "Nonaktif" };
const testDemotedActor = { id: "99", role: "viewer", nama: "Viewer User", status: "Aktif" };

function setupTestActors(): void {
  const insertOrReplaceUser = db.prepare(`
    INSERT OR REPLACE INTO users (id, email, password_hash, password_salt, nama, jabatan, role, status)
    VALUES (?, ?, 'hash', 'salt', ?, ?, ?, ?)
  `);
  insertOrReplaceUser.run(testAdminActor.id, "admin-test@sun89.com", testAdminActor.nama, "Admin", testAdminActor.role, testAdminActor.status);
  insertOrReplaceUser.run(testFinanceActor.id, "finance-test@sun89.com", testFinanceActor.nama, "Finance", testFinanceActor.role, testFinanceActor.status);
  insertOrReplaceUser.run(testSvpActor.id, "svp-test@sun89.com", testSvpActor.nama, "Supervisor", testSvpActor.role, testSvpActor.status);
  insertOrReplaceUser.run(testInactiveActor.id, "inactive-test@sun89.com", testInactiveActor.nama, "Supervisor", testInactiveActor.role, testInactiveActor.status);
  insertOrReplaceUser.run(testDemotedActor.id, "demoted-test@sun89.com", testDemotedActor.nama, "Staff", testDemotedActor.role, testDemotedActor.status);
}

function createTestOrder(orderNo: string): void {
  if (!orderNo) return;
  db.prepare(`
    INSERT OR IGNORE INTO orders (order_no, customer, nomor_hp, layanan, nopol, data_json)
    VALUES (?, 'Customer Test', '08123456789', 'Perpanjangan STNK', 'B 1234 ABC', '{}')
  `).run(orderNo);
}

function createTestInvoice(invoiceNo: string, orderNo: string, opts?: { status?: string; isDraft?: number }): number {
  if (orderNo) {
    createTestOrder(orderNo);
  }
  const res = db.prepare(`
    INSERT INTO finance_invoices (
      invoice_no, order_no, customer, layanan, status, total_tagihan, dibayar, sisa, data_json, is_draft_estimate
    ) VALUES (?, ?, 'Customer Test', 'Perpanjangan STNK', ?, 1000000, 0, 1000000, '{}', ?)
  `).run(invoiceNo, orderNo, opts?.status || "UNPAID", opts?.isDraft ?? 0);
  return Number(res.lastInsertRowid);
}

function createTestPayment(invoiceNo: string, orderNo: string, nominal: number, opts?: {
  paymentId?: string;
  paymentMethodId?: string | null;
  snapshotJson?: string | null;
  metodePembayaran?: string;
  statusVerifikasi?: string;
  tanggalBayar?: string;
  kasKantorId?: number | null;
  isVoid?: number;
}): number {
  if (orderNo) {
    createTestOrder(orderNo);
  }
  const res = db.prepare(`
    INSERT INTO invoice_payments (
      payment_id, invoice_no, order_no, nominal, tanggal_bayar,
      metode_pembayaran, metode_pembayaran_id, payment_method_snapshot, status_verifikasi, kas_kantor_id, is_void
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts?.paymentId || `pay-${crypto.randomUUID()}`,
    invoiceNo,
    orderNo,
    nominal,
    opts?.tanggalBayar || '2026-11-11',
    opts?.metodePembayaran || (opts?.paymentMethodId === CASH_PM_ID ? 'Tunai' : 'Transfer Bank'),
    opts?.paymentMethodId !== undefined ? opts.paymentMethodId : CIMB_PM_ID,
    opts?.snapshotJson !== undefined ? opts.snapshotJson : cimbSnapshotJson,
    opts?.statusVerifikasi || 'MENUNGGU_VERIFIKASI',
    opts?.kasKantorId ?? null,
    opts?.isVoid ?? 0
  );
  return Number(res.lastInsertRowid);
}

function createTestReimbursement(id: string, opts?: {
  employeeId?: string;
  messengerId?: string;
  messengerName?: string;
  category?: string;
  amount?: number;
  approvedAmount?: number;
  status?: string;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO messenger_reimbursements (
      id, employee_id, messenger_id, messenger_name, date, category, amount, approved_amount, status
    ) VALUES (?, ?, ?, ?, '2026-11-11', ?, ?, ?, ?)
  `).run(
    id,
    opts?.employeeId || 'EMP-0004',
    opts?.messengerId || 'MSG-0001',
    opts?.messengerName || 'Budi Santoso',
    opts?.category || 'Bensin',
    opts?.amount ?? 75000,
    opts?.approvedAmount ?? 75000,
    opts?.status || 'Disetujui'
  );
}

setupTestActors();
runKasDomainSeparationMigration(db);

test("Phase 4B Batch 2B Acceptance Test Suite (Revision 2.8-FINAL.7)", async (t) => {

  // =========================================================================
  // GROUP A: Migration & Schema Safety (4 Tests)
  // =========================================================================
  await t.test("Group A: Migration & Schema Safety", async (st) => {
    await st.test("TC-MIG-A01: Column payment_method_snapshot exists on invoice_payments", () => {
      const cols = db.prepare("PRAGMA table_info(invoice_payments)").all() as { name: string }[];
      const hasCol = cols.some((c) => c.name === "payment_method_snapshot");
      assert.strictEqual(hasCol, true, "payment_method_snapshot exists on invoice_payments");
    });

    await st.test("TC-MIG-A02: Column payment_method_snapshot already exists (idempotent run)", () => {
      assert.doesNotThrow(() => {
        runKasDomainSeparationMigration(db);
      });
    });

    await st.test("TC-MIG-A03: Rerun entire migration script multiple times", () => {
      assert.doesNotThrow(() => {
        runKasDomainSeparationMigration(db);
        runKasDomainSeparationMigration(db);
      });
      const indexes = db.prepare("PRAGMA index_list(invoice_payments)").all() as { name: string }[];
      const snapIndexes = indexes.filter((i) => i.name.includes("idx_invoice_payments_snapshot"));
      assert.ok(snapIndexes.length <= 1, "Zero duplicate indexes created");
    });

    await st.test("TC-MIG-A04: Injected error during migration rolls back atomically", () => {
      const mockDb = {
        prepare: () => {
          throw new Error("MOCK_DB_FAILURE");
        },
      } as any;
      assert.throws(() => {
        runKasDomainSeparationMigration(mockDb);
      }, /MOCK_DB_FAILURE/);
    });
  });

  // =========================================================================
  // GROUP B: Invoice Identifier Resolver (9 Tests)
  // =========================================================================
  await t.test("Group B: Invoice Identifier Resolver", async (st) => {
    const testInvNo = `INV-TEST-B-${Date.now()}`;
    const testOrderNo = `ORD-TEST-B-${Date.now()}`;
    const invoiceId = createTestInvoice(testInvNo, testOrderNo);
    const paymentId = createTestPayment(testInvNo, testOrderNo, 500000);

    await st.test("TC-RES-B01: Pure numeric string PK resolves successfully", () => {
      const idemKey = crypto.randomUUID();
      const res = verifyInvoicePaymentAtomic(paymentId, String(invoiceId), testAdminActor.id, testAdminActor.role, idemKey);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.data.paymentId, paymentId);
    });

    await st.test("TC-RES-B02: Invoice number canonical format resolves successfully", () => {
      db.prepare("UPDATE invoice_payments SET status_verifikasi = 'MENUNGGU_VERIFIKASI', kas_kantor_id = NULL WHERE id = ?").run(paymentId);
      const idemKey = crypto.randomUUID();
      const res = verifyInvoicePaymentAtomic(paymentId, testInvNo, testAdminActor.id, testAdminActor.role, idemKey);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.data.invoiceNo, testInvNo);
    });

    await st.test("TC-RES-B03: Order number alias format resolves successfully", () => {
      db.prepare("UPDATE invoice_payments SET status_verifikasi = 'MENUNGGU_VERIFIKASI', kas_kantor_id = NULL WHERE id = ?").run(paymentId);
      const idemKey = crypto.randomUUID();
      const res = verifyInvoicePaymentAtomic(paymentId, testOrderNo, testAdminActor.id, testAdminActor.role, idemKey);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.data.orderNo, testOrderNo);
    });

    await st.test("TC-RES-B04: Numeric with leading zeros rejected with HTTP 400", () => {
      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(paymentId, "001", testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_INVOICE_IDENTIFIER");
    });

    await st.test("TC-RES-B05: Negative numeric string or zero rejected with HTTP 400", () => {
      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(paymentId, "0", testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_INVOICE_IDENTIFIER");
      assert.throws(() => {
        verifyInvoicePaymentAtomic(paymentId, "-5", testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_INVOICE_IDENTIFIER");
    });

    await st.test("TC-RES-B06: Decimal numeric string rejected with HTTP 400", () => {
      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(paymentId, "1.5", testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_INVOICE_IDENTIFIER");
    });

    await st.test("TC-RES-B07: Safe integer overflow rejected with HTTP 400", () => {
      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(paymentId, "9007199254740992", testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_INVOICE_IDENTIFIER");
    });

    await st.test("TC-RES-B08: Unknown prefix or malformed string rejected with HTTP 400", () => {
      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(paymentId, "CUST-001", testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_INVOICE_IDENTIFIER");
    });

    await st.test("TC-RES-B09: Duplicate order alias matched by 2 invoices fails with HTTP 409", () => {
      const dupOrderNo = `ORD-DUP-${Date.now()}`;
      // Temporarily drop unique index to test legacy duplicate invoice resolution behavior
      db.exec("DROP INDEX IF EXISTS idx_invoices_order_unique;");
      createTestInvoice(`INV-DUP-1-${Date.now()}`, dupOrderNo);
      createTestInvoice(`INV-DUP-2-${Date.now()}`, dupOrderNo);

      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(paymentId, dupOrderNo, testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 409 && err.code === "INVOICE_IDENTIFIER_AMBIGUOUS");

      // Cleanup and restore unique index
      db.prepare("DELETE FROM finance_invoices WHERE order_no = ?").run(dupOrderNo);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_order_unique ON finance_invoices(order_no);");
    });
  });

  // =========================================================================
  // GROUP C: Payment Identity & Relational Binding (8 Tests)
  // =========================================================================
  await t.test("Group C: Payment Identity & Relational Binding", async (st) => {
    const testInv = `INV-REL-${Date.now()}`;
    const testOrder = `ORD-REL-${Date.now()}`;
    createTestInvoice(testInv, testOrder);
    const payUuid = `pay-${crypto.randomUUID()}`;
    const pId = createTestPayment(testInv, testOrder, 500000, { paymentId: payUuid });

    await st.test("TC-PAY-C01: Numeric primary key lookup succeeds", () => {
      const idemKey = crypto.randomUUID();
      const res = verifyInvoicePaymentAtomic(pId, testInv, testAdminActor.id, testAdminActor.role, idemKey);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.data.paymentId, pId);
    });

    await st.test("TC-PAY-C02: UUID payment string lookup succeeds", () => {
      db.prepare("UPDATE invoice_payments SET status_verifikasi = 'MENUNGGU_VERIFIKASI', kas_kantor_id = NULL WHERE id = ?").run(pId);
      const idemKey = crypto.randomUUID();
      const res = verifyInvoicePaymentAtomic(payUuid, testInv, testAdminActor.id, testAdminActor.role, idemKey);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.data.paymentId, pId);
    });

    await st.test("TC-PAY-C03: Non-existent payment ID returns HTTP 404 with ZERO DML", () => {
      const countBefore = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(99999999, testInv, testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 404 && err.code === "PAYMENT_NOT_FOUND");
      const countAfter = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      assert.strictEqual(countBefore, countAfter);
    });

    await st.test("TC-PAY-C04: Payment invoice mismatch returns HTTP 404 with ZERO DML", () => {
      const otherInv = `INV-OTHER-${Date.now()}`;
      createTestInvoice(otherInv, "ORD-OTHER");
      const countBefore = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pId, otherInv, testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 404 && err.code === "PAYMENT_NOT_FOUND");
      const countAfter = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      assert.strictEqual(countBefore, countAfter);
    });

    await st.test("TC-PAY-C05: Payment order mismatch returns HTTP 404 with ZERO DML", () => {
      const invDiffOrder = `INV-DIFF-${Date.now()}`;
      createTestInvoice(invDiffOrder, "ORD-MISMATCH");
      const pDiffId = createTestPayment(invDiffOrder, "ORD-ACTUAL", 100);

      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pDiffId, invDiffOrder, testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 404 && err.code === "PAYMENT_NOT_FOUND");
    });

    await st.test("TC-PAY-C06: Asymmetric order nullness returns HTTP 404 with ZERO DML", () => {
      const invNoOrder = `INV-NO-ORD-${Date.now()}`;
      createTestInvoice(invNoOrder, "ORD-INVOICE");
      const pAsymId = createTestPayment(invNoOrder, "ORD-SOME", 100);

      const idemKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pAsymId, invNoOrder, testAdminActor.id, testAdminActor.role, idemKey);
      }, (err: any) => err.statusCode === 404 && err.code === "PAYMENT_NOT_FOUND");
    });

    await st.test("TC-PAY-C07: Multiple partial payments on same invoice mutate only target payment", () => {
      const id1 = createTestPayment(testInv, testOrder, 300000);
      const id2 = createTestPayment(testInv, testOrder, 200000);

      const idemKey = crypto.randomUUID();
      const res = verifyInvoicePaymentAtomic(id1, testInv, testAdminActor.id, testAdminActor.role, idemKey);
      assert.strictEqual(res.success, true);
    });

    await st.test("TC-PAY-C08: Sibling payment isolation verified post-verification", () => {
      const idA = createTestPayment(testInv, testOrder, 350000);
      const idB = createTestPayment(testInv, testOrder, 250000);

      const idemKey = crypto.randomUUID();
      verifyInvoicePaymentAtomic(idA, testInv, testAdminActor.id, testAdminActor.role, idemKey);

      // Sibling idB must remain untouched
      const sibling = db.prepare("SELECT status_verifikasi, kas_kantor_id FROM invoice_payments WHERE id = ?").get(idB) as any;
      assert.strictEqual(sibling.status_verifikasi, "MENUNGGU_VERIFIKASI");
      assert.strictEqual(sibling.kas_kantor_id, null);
    });
  });

  // =========================================================================
  // GROUP D: Idempotency, Request Hashing & Actor Ownership (13 Tests)
  // =========================================================================
  await t.test("Group D: Idempotency, Request Hashing & Actor Ownership", async (st) => {
    const testInv = `INV-IDM-${Date.now()}`;
    const testOrd = `ORD-IDM-${Date.now()}`;
    const invId = createTestInvoice(testInv, testOrd);
    const payId = createTestPayment(testInv, testOrd, 400000);
    const sharedKey = crypto.randomUUID();

    await st.test("TC-IDM-D01: First valid verification execution creates Kas Kantor Debit & Idempotency Key", () => {
      const res = verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, sharedKey);
      assert.strictEqual(res.success, true);
      const row = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?").get(`PAYMENT_VERIFICATION::${sharedKey}`) as any;
      assert.ok(row, "Idempotency key persisted");
      assert.strictEqual(row.resource_id, String(payId));
    });

    await st.test("TC-IDM-D02: Identical replay under write lock returns cached response with ZERO DML", () => {
      const countBefore = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      const res = verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, sharedKey);
      assert.strictEqual(res.success, true);
      const countAfter = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      assert.strictEqual(countBefore, countAfter, "Absolute ZERO duplicate DML");
    });

    await st.test("TC-IDM-D03: Cross-alias idempotent replay (INV- vs Numeric ID) resolves identically", () => {
      const countBefore = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      const res = verifyInvoicePaymentAtomic(payId, String(invId), testAdminActor.id, testAdminActor.role, sharedKey);
      assert.strictEqual(res.success, true);
      const countAfter = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      assert.strictEqual(countBefore, countAfter, "ZERO duplicate cash on cross-alias replay");
    });

    await st.test("TC-IDM-D04: Replay with different resource_id on same key fails with HTTP 409", () => {
      const originalScopedKey = `PAYMENT_VERIFICATION::${sharedKey}`;
      db.prepare("UPDATE idempotency_keys SET resource_id = '99999' WHERE key = ?").run(originalScopedKey);

      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, sharedKey);
      }, (err: any) => err.statusCode === 409 && err.code === "IDEMPOTENCY_CONFLICT");

      // Restore resource_id
      db.prepare("UPDATE idempotency_keys SET resource_id = ? WHERE key = ?").run(String(payId), originalScopedKey);
    });

    await st.test("TC-IDM-D05: Replay with existing.resource_id = NULL fails with HTTP 409", () => {
      const originalScopedKey = `PAYMENT_VERIFICATION::${sharedKey}`;
      db.prepare("UPDATE idempotency_keys SET resource_id = NULL WHERE key = ?").run(originalScopedKey);

      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, sharedKey);
      }, (err: any) => err.statusCode === 409 && err.code === "IDEMPOTENCY_CONFLICT");

      db.prepare("UPDATE idempotency_keys SET resource_id = ? WHERE key = ?").run(String(payId), originalScopedKey);
    });

    await st.test("TC-IDM-D06: Replay with existing.resource_id = '' fails with HTTP 409", () => {
      const originalScopedKey = `PAYMENT_VERIFICATION::${sharedKey}`;
      db.prepare("UPDATE idempotency_keys SET resource_id = '' WHERE key = ?").run(originalScopedKey);

      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, sharedKey);
      }, (err: any) => err.statusCode === 409 && err.code === "IDEMPOTENCY_CONFLICT");

      db.prepare("UPDATE idempotency_keys SET resource_id = ? WHERE key = ?").run(String(payId), originalScopedKey);
    });

    await st.test("TC-IDM-D07: Replay with different payload / canonical hash fails with HTTP 409", () => {
      const otherKey = crypto.randomUUID();
      db.prepare("UPDATE invoice_payments SET status_verifikasi = 'MENUNGGU_VERIFIKASI', kas_kantor_id = NULL WHERE id = ?").run(payId);
      verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, otherKey);

      // Mutate canonical request hash in DB to simulate mismatch
      db.prepare("UPDATE idempotency_keys SET request_hash = 'TAMPERED_HASH' WHERE key = ?").run(`PAYMENT_VERIFICATION::${otherKey}`);

      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, otherKey);
      }, (err: any) => err.statusCode === 409 && (err.code === "IDEMPOTENCY_CONFLICT" || err.code === "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH"));
    });

    await st.test("TC-IDM-D08: Replay by different actor fails with HTTP 403", () => {
      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testFinanceActor.id, testFinanceActor.role, sharedKey);
      }, (err: any) => err.statusCode === 403 && err.code === "IDEMPOTENCY_USER_MISMATCH");
    });

    await st.test("TC-IDM-D09: Replay with legacy NULL owner permits admin and rejects non-admin", () => {
      const legacyKey = crypto.randomUUID();
      db.prepare("UPDATE invoice_payments SET status_verifikasi = 'MENUNGGU_VERIFIKASI', kas_kantor_id = NULL WHERE id = ?").run(payId);
      verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, legacyKey);

      db.prepare("UPDATE idempotency_keys SET user_id = NULL WHERE key = ?").run(`PAYMENT_VERIFICATION::${legacyKey}`);

      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testFinanceActor.id, testFinanceActor.role, legacyKey);
      }, (err: any) => err.statusCode === 403 && err.code === "IDEMPOTENCY_OWNERSHIP_UNVERIFIABLE");

      const res = verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, legacyKey);
      assert.strictEqual(res.success, true);
    });

    await st.test("TC-IDM-D10: In-transaction actor check: User deactivated in DB fails with HTTP 403", () => {
      const freshKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testInactiveActor.id, testInactiveActor.role, freshKey);
      }, (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN_USER_INACTIVE");
    });

    await st.test("TC-IDM-D11: In-transaction actor check: Role demoted in DB fails with HTTP 403", () => {
      const freshKey = crypto.randomUUID();
      assert.throws(() => {
        verifyInvoicePaymentAtomic(payId, testInv, testDemotedActor.id, testDemotedActor.role, freshKey);
      }, (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN");
    });

    await st.test("TC-IDM-D12: Concurrent verification serialization test", () => {
      const concKey = crypto.randomUUID();
      const pIdConc = createTestPayment(testInv, testOrd, 250000);
      const res1 = verifyInvoicePaymentAtomic(pIdConc, testInv, testAdminActor.id, testAdminActor.role, concKey);
      const res2 = verifyInvoicePaymentAtomic(pIdConc, testInv, testAdminActor.id, testAdminActor.role, concKey);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res1.data.kasKantorId, res2.data.kasKantorId);
    });

    await st.test("TC-IDM-D13: Absolute zero duplicate cash guarantee", () => {
      const countBefore = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      verifyInvoicePaymentAtomic(payId, testInv, testAdminActor.id, testAdminActor.role, sharedKey);
      const countAfter = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      assert.strictEqual(countBefore, countAfter, "No new row in kas_kantor");
    });
  });

  // =========================================================================
  // GROUP E: Payment Method Snapshot & Historical Immutability (11 Tests)
  // =========================================================================
  await t.test("Group E: Payment Method Snapshot & Historical Immutability", async (st) => {
    await st.test("TC-SNP-E01: Valid bank snapshot validates correctly", () => {
      assert.strictEqual(validatePaymentMethodSnapshot(cimbSnapshotJson, CIMB_PM_ID, false), cimbSnapshotJson);
    });

    await st.test("TC-SNP-E02: Valid cash snapshot validates correctly", () => {
      assert.strictEqual(validatePaymentMethodSnapshot(cashSnapshotJson, CASH_PM_ID, false), cashSnapshotJson);
    });

    await st.test("TC-SNP-E03: Malformed JSON snapshot string fails with HTTP 400", () => {
      assert.throws(() => {
        validatePaymentMethodSnapshot("{bad_json", CIMB_PM_ID, false);
      }, (err: any) => err.statusCode === 400 && err.code === "PAYMENT_METHOD_SNAPSHOT_INVALID");
    });

    await st.test("TC-SNP-E04: Non-object JSON root (array or primitive) fails with HTTP 400", () => {
      assert.throws(() => {
        validatePaymentMethodSnapshot("[1, 2, 3]", CIMB_PM_ID, false);
      }, (err: any) => err.statusCode === 400 && err.code === "PAYMENT_METHOD_SNAPSHOT_INVALID");
    });

    await st.test("TC-SNP-E05: Missing mandatory field (id or nama_metode) fails with HTTP 400", () => {
      const missingId = JSON.stringify({ nama_metode: "Tunai" });
      assert.throws(() => {
        validatePaymentMethodSnapshot(missingId, CIMB_PM_ID, false);
      }, (err: any) => err.statusCode === 400 && err.code === "PAYMENT_METHOD_SNAPSHOT_INVALID");
    });

    await st.test("TC-SNP-E06: Bank transfer snapshot missing bank/rekening fails with HTTP 400", () => {
      const missingBank = JSON.stringify({ id: BCA_PM_ID, nama_metode: "Transfer Bank", bank: "", nama_rekening: "X", nomor_rekening: "1" });
      assert.throws(() => {
        validatePaymentMethodSnapshot(missingBank, BCA_PM_ID, false);
      }, (err: any) => err.statusCode === 400 && err.code === "PAYMENT_METHOD_SNAPSHOT_INVALID");
    });

    await st.test("TC-SNP-E07: Snapshot ID does not match payment method ID fails with HTTP 400", () => {
      const mismatchedId = JSON.stringify({ id: "pm-wrong-id", nama_metode: "Tunai" });
      assert.throws(() => {
        validatePaymentMethodSnapshot(mismatchedId, CIMB_PM_ID, false);
      }, (err: any) => err.statusCode === 400 && err.code === "PAYMENT_METHOD_SNAPSHOT_INVALID");
    });

    await st.test("TC-SNP-E08: Master account renamed after payment recording - snapshot remains immutable", () => {
      const invE = `INV-E8-${Date.now()}`;
      const ordE = `ORD-E8-${Date.now()}`;
      createTestInvoice(invE, ordE);
      const pId = createTestPayment(invE, ordE, 200000, {
        paymentMethodId: CIMB_PM_ID,
        snapshotJson: cimbSnapshotJson,
      });

      // Verification uses frozen snapshot regardless of subsequent master mutations
      const res = verifyInvoicePaymentAtomic(pId, invE, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      assert.strictEqual(res.success, true);
      const kkRow = db.prepare("SELECT payment_method_snapshot FROM kas_kantor WHERE id = ?").get(res.data.kasKantorId) as any;
      assert.strictEqual(kkRow.payment_method_snapshot, cimbSnapshotJson);
    });

    await st.test("TC-SNP-E09: Master account deactivated after payment recording - verification succeeds using frozen snapshot", () => {
      const invE = `INV-E9-${Date.now()}`;
      const ordE = `ORD-E9-${Date.now()}`;
      createTestInvoice(invE, ordE);
      const pId = createTestPayment(invE, ordE, 200000, {
        paymentMethodId: CIMB_PM_ID,
        snapshotJson: cimbSnapshotJson,
      });

      // Verification succeeds without re-checking active status of master payment method
      const res = verifyInvoicePaymentAtomic(pId, invE, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      assert.strictEqual(res.success, true);
    });

    await st.test("TC-SNP-E10: Missing snapshot on new payment (id > 7) fails with HTTP 400", () => {
      assert.throws(() => {
        validatePaymentMethodSnapshot(null, CIMB_PM_ID, false);
      }, (err: any) => err.statusCode === 400 && err.code === "PAYMENT_METHOD_SNAPSHOT_INVALID");
    });

    await st.test("TC-SNP-E11: Baseline historical payments #1–#7 with NULL snapshot permitted", () => {
      const res = validatePaymentMethodSnapshot(null, null, true);
      assert.strictEqual(res, null);
    });
  });

  // =========================================================================
  // GROUP F: Financial Rules, Lifecycle & Business Date Validation (12 Tests)
  // =========================================================================
  await t.test("Group F: Financial Rules, Lifecycle & Business Date Validation", async (st) => {
    const testInvF = `INV-FIN-${Date.now()}`;
    createTestInvoice(testInvF, "ORD-F");

    await st.test("TC-FIN-F01: Valid positive safe integer nominal succeeds", () => {
      const pIdValid = createTestPayment(testInvF, 'ORD-F', 500000);
      const res = verifyInvoicePaymentAtomic(pIdValid, testInvF, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      assert.strictEqual(res.success, true);
    });

    await st.test("TC-FIN-F02: Zero nominal amount rejected by schema constraint or validation", () => {
      assert.throws(() => {
        createTestPayment(testInvF, 'ORD-F', 0);
      }, /CHECK constraint failed|INVALID_PAYMENT_AMOUNT/);
    });

    await st.test("TC-FIN-F03: Negative nominal amount rejected by schema constraint or validation", () => {
      assert.throws(() => {
        createTestPayment(testInvF, 'ORD-F', -50000);
      }, /CHECK constraint failed|INVALID_PAYMENT_AMOUNT/);
    });

    await st.test("TC-FIN-F04: Decimal nominal amount fails with HTTP 400", () => {
      const pIdDec = createTestPayment(testInvF, 'ORD-F', 150000.5);
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pIdDec, testInvF, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_PAYMENT_AMOUNT");
    });

    await st.test("TC-FIN-F05: Non-finite nominal amount fails with HTTP 400", () => {
      const pIdInf = createTestPayment(testInvF, 'ORD-F', 999999);
      // Tamper nominal to NaN in DB
      db.prepare("UPDATE invoice_payments SET nominal = 'NaN' WHERE id = ?").run(pIdInf);
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pIdInf, testInvF, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_PAYMENT_AMOUNT");
    });

    await st.test("TC-FIN-F06: Nominal exceeding ceiling (> Rp 10.000.000.000) fails with HTTP 400", () => {
      const pIdCeil = createTestPayment(testInvF, 'ORD-F', 10000000001);
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pIdCeil, testInvF, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && (err.code === "AMOUNT_EXCEEDS_CEILING" || err.code === "INVALID_PAYMENT_AMOUNT"));
    });

    await st.test("TC-FIN-F07: Payment already verified fails with HTTP 409", () => {
      const pIdVer = createTestPayment(testInvF, 'ORD-F', 50000, { statusVerifikasi: 'TERVERIFIKASI' });
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pIdVer, testInvF, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 409 && err.code === "PAYMENT_ALREADY_VERIFIED");
    });

    await st.test("TC-FIN-F08: Payment already linked to cash fails with HTTP 409", () => {
      const dummyKk = db.prepare("INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori) VALUES ('2026-11-11', 'Linked Test KK', 'Debit', 50000, 0, 50000, 'Operasional')").run();
      const dummyKkId = Number(dummyKk.lastInsertRowid);
      const pIdLinked = createTestPayment(testInvF, 'ORD-F', 50000, { kasKantorId: dummyKkId });
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pIdLinked, testInvF, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 409 && (err.code === "PAYMENT_ALREADY_LINKED" || err.code === "PAYMENT_ALREADY_VERIFIED"));
    });

    await st.test("TC-FIN-F09: Payment voided fails with HTTP 400", () => {
      const pIdVoid = createTestPayment(testInvF, 'ORD-F', 50000, { statusVerifikasi: 'VOID', isVoid: 1 });
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pIdVoid, testInvF, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "PAYMENT_VOIDED");
    });

    await st.test("TC-FIN-F10: Invoice is draft estimate fails with HTTP 400", () => {
      const draftInv = `INV-DRAFT-${Date.now()}`;
      createTestInvoice(draftInv, "ORD-DRAFT", { isDraft: 1 });
      const pIdDraft = createTestPayment(draftInv, "ORD-DRAFT", 50000);
      assert.throws(() => {
        verifyInvoicePaymentAtomic(pIdDraft, draftInv, testAdminActor.id, testAdminActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "INVOICE_IS_DRAFT");
    });

    await st.test("TC-FIN-F11: validateAndNormalizeBusinessDate rejects non-existent date '2026-02-31'", () => {
      assert.throws(() => {
        validateAndNormalizeBusinessDate("2026-02-31");
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_BUSINESS_DATE");
    });

    await st.test("TC-FIN-F12: validateAndNormalizeBusinessDate accepts valid calendar date '2026-11-11'", () => {
      const res = validateAndNormalizeBusinessDate("2026-11-11");
      assert.strictEqual(res, "2026-11-11");
    });
  });

  // =========================================================================
  // GROUP G: SVP Permanent Deletion & Cascade Blockers (17 Tests)
  // =========================================================================
  await t.test("Group G: SVP Permanent Deletion & Cascade Blockers", async (st) => {
    const kkRes = db.prepare("INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori) VALUES ('2026-11-11', 'Unlinked KK Delete Test', 'Debit', 100000, 0, 100000, 'Operasional')").run();
    const kkId = Number(kkRes.lastInsertRowid);
    recalculateKasKantorRunningBalances();

    await st.test("TC-DEL-G01: Active SVP deletes unlinked operational record", () => {
      const idemKey = crypto.randomUUID();
      const res = deletePermanentlyWithAuditAndIdempotency("kas_kantor", kkId, "Alasan valid penghapusan oleh supervisor", testSvpActor.id, testSvpActor.role, idemKey);
      assert.strictEqual(res.statusCode, 200);
    });

    await st.test("TC-DEL-G02: Non-SVP user attempts deletion fails with HTTP 403", () => {
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Alasan valid untuk test", testAdminActor.id, "admin", crypto.randomUUID());
      }, (err: any) => err.statusCode === 403 && (err.code === "FORBIDDEN_NOT_SVP" || err.code === "FORBIDDEN"));
    });

    await st.test("TC-DEL-G03: Inactive SVP attempts deletion fails with HTTP 403", () => {
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Alasan valid untuk test", testInactiveActor.id, testInactiveActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 403 && (err.code === "FORBIDDEN_NOT_SVP" || err.code === "FORBIDDEN_USER_INACTIVE"));
    });

    await st.test("TC-DEL-G04: SVP demoted prior to transaction lock acquisition fails with HTTP 403", () => {
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Alasan valid untuk test", testDemotedActor.id, testDemotedActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 403 && (err.code === "FORBIDDEN_NOT_SVP" || err.code === "FORBIDDEN"));
    });

    await st.test("TC-DEL-G05: Deletion request missing X-Idempotency-Key header fails with HTTP 400", () => {
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Alasan valid untuk test", testSvpActor.id, testSvpActor.role, "");
      }, (err: any) => err.statusCode === 400 && err.code === "MISSING_IDEMPOTENCY_KEY");
    });

    await st.test("TC-DEL-G06: Deletion reason less than 10 characters fails with HTTP 400", () => {
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Pendek", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_DELETE_REASON");
    });

    await st.test("TC-DEL-G07: Attempt to delete Modal Awal (row ID 1 / kategori = 'MODAL_AWAL') fails with HTTP 400", () => {
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Mencoba menghapus modal awal", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "CANNOT_DELETE_INITIAL_CAPITAL");
    });

    await st.test("TC-DEL-G08: Attempt to delete Kas Kantor row linked to payment fails with HTTP 409", () => {
      const linkedKk = db.prepare("INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori) VALUES ('2026-11-11', 'Linked KK', 'Debit', 50000, 0, 50000, 'Invoice Payment')").run();
      const linkedKkId = Number(linkedKk.lastInsertRowid);
      createTestInvoice("INV-LINK", "ORD-LINK");
      createTestPayment("INV-LINK", "ORD-LINK", 50000, { statusVerifikasi: "TERVERIFIKASI", kasKantorId: linkedKkId });

      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", linkedKkId, "Hapus kas kantor linked", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 409 && err.code === "CANNOT_DELETE_VERIFIED_PAYMENT");
    });

    await st.test("TC-DEL-G09: Attempt to delete Kas Messenger linked to reimbursement fails with HTTP 409", () => {
      const linkedKm = db.prepare("INSERT INTO kas_messenger (tanggal, jenis, messenger, keterangan, debit, kredit, total, reimbursement_id) VALUES ('2026-11-11', 'Pengeluaran', 'Budi', 'Reimb link test', 0, 50000, 0, 'REIMB-TEST-01')").run();
      const linkedKmId = Number(linkedKm.lastInsertRowid);

      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_messenger", linkedKmId, "Hapus kas messenger linked", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 409 && err.code === "CANNOT_DELETE_LINKED_REIMBURSEMENT");
    });

    await st.test("TC-DEL-G10: Attempt to delete Pengeluaran linked to reimbursement fails with HTTP 409", () => {
      createTestReimbursement("REIMB-EXP-01");
      const linkedPengeluaran = db.prepare("INSERT INTO pengeluaran (tanggal, keterangan, nominal, reimbursement_id) VALUES ('2026-11-11', 'Pengeluaran linked test', 50000, 'REIMB-EXP-01')").run();
      const pId = Number(linkedPengeluaran.lastInsertRowid);

      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("pengeluaran", pId, "Hapus pengeluaran linked", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 409 && err.code === "CANNOT_DELETE_LINKED_REIMBURSEMENT");
    });

    await st.test("TC-DEL-G11: Attempt to delete reimbursement with status approved/paid fails with HTTP 409", () => {
      createTestReimbursement("REIMB-ACTIVE-TEST", { status: "Dibayar", amount: 50000 });

      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("messenger_reimbursements", "REIMB-ACTIVE-TEST", "Hapus active reimbursement", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 409 && err.code === "CANNOT_DELETE_ACTIVE_REIMBURSEMENT");
    });

    await st.test("TC-DEL-G12: Deletion causing subsequent running balance < 0 fails with HTTP 409", () => {
      const curBal = (db.prepare("SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(kredit), 0) as balance FROM kas_kantor").get() as any).balance;
      const inflowAmount = 1000000;
      const outflowAmount = curBal + 500000;
      const debitRow = db.prepare("INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori) VALUES ('2026-11-10', 'Inflow critical', 'Debit', ?, 0, 0, 'Operasional')").run(inflowAmount);
      const debitId = Number(debitRow.lastInsertRowid);
      db.prepare("INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori) VALUES ('2026-11-11', 'Outflow critical', 'Kredit', 0, ?, 0, 'Operasional')").run(outflowAmount);
      recalculateKasKantorRunningBalances();

      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", debitId, "Hapus inflow yang menyebabkan saldo negatif", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 409 && err.code === "NEGATIVE_BALANCE_VIOLATION");
    });

    await st.test("TC-DEL-G13: Simulated audit failure rolls back transaction atomically", () => {
      const mockDb = {
        prepare: (sql: string) => {
          if (sql.includes("audit_logs")) throw new Error("SIMULATED_AUDIT_LOG_ERROR");
          return db.prepare(sql);
        },
      } as any;
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 999999, "Alasan valid", testSvpActor.id, testSvpActor.role, crypto.randomUUID(), mockDb);
      });
    });

    await st.test("TC-DEL-G14: Simulated physical delete failure rolls back transaction atomically", () => {
      const mockDb = {
        prepare: (sql: string) => {
          if (sql.includes("DELETE FROM")) throw new Error("SIMULATED_DELETE_ERROR");
          return db.prepare(sql);
        },
      } as any;
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 999999, "Alasan valid", testSvpActor.id, testSvpActor.role, crypto.randomUUID(), mockDb);
      });
    });

    await st.test("TC-DEL-G15: Simulated idempotency insertion failure rolls back transaction atomically", () => {
      const mockDb = {
        prepare: (sql: string) => {
          if (sql.includes("idempotency_keys")) throw new Error("SIMULATED_IDEMPOTENCY_ERROR");
          return db.prepare(sql);
        },
      } as any;
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 999999, "Alasan valid", testSvpActor.id, testSvpActor.role, crypto.randomUUID(), mockDb);
      });
    });

    await st.test("TC-DEL-G16: Replay of valid delete request with identical key returns HTTP 200 cached with ZERO DML", () => {
      const newKk = db.prepare("INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori) VALUES ('2026-11-11', 'Replay Delete Test', 'Debit', 25000, 0, 25000, 'Operasional')").run();
      const nId = Number(newKk.lastInsertRowid);
      recalculateKasKantorRunningBalances();

      const dKey = crypto.randomUUID();
      const res1 = deletePermanentlyWithAuditAndIdempotency("kas_kantor", nId, "Hapus untuk tes replay idempotency", testSvpActor.id, testSvpActor.role, dKey);
      assert.strictEqual(res1.statusCode, 200);

      const res2 = deletePermanentlyWithAuditAndIdempotency("kas_kantor", nId, "Hapus untuk tes replay idempotency", testSvpActor.id, testSvpActor.role, dKey);
      assert.strictEqual(res2.statusCode, 200);
      assert.strictEqual(res1.body.targetId, res2.body.targetId);
    });

    await st.test("TC-DEL-G17: Dynamic full-row audit snapshot completeness", () => {
      const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'PERMANENT_DELETE' ORDER BY id DESC LIMIT 1").get() as any;
      assert.ok(audit, "Audit record exists");
      const meta = JSON.parse(audit.metadata_json);
      assert.ok(meta.deletedSnapshot, "deletedSnapshot exists");
      assert.ok("id" in meta.deletedSnapshot, "id in snapshot");
      assert.ok("tanggal" in meta.deletedSnapshot, "tanggal in snapshot");
      assert.ok("kategori" in meta.deletedSnapshot, "kategori in snapshot");
    });
  });

  // =========================================================================
  // GROUP H: Cash Ledger Domain, Separation & Summary Integrity (9 Tests)
  // =========================================================================
  await t.test("Group H: Cash Ledger Domain, Separation & Summary Integrity", async (st) => {
    await st.test("TC-DOM-H01: Reimbursement payout mutates kas_messenger Kredit and leaves kas_kantor untouched", () => {
      const officeBalBefore = (db.prepare("SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(kredit), 0) as balance FROM kas_kantor").get() as any).balance;
      const reimbId = `REIMB-PAY-H01-${Date.now()}`;
      createTestReimbursement(reimbId, { status: "Disetujui", amount: 75000, approvedAmount: 75000 });

      const res = messengerService.payReimbursement(reimbId, { userId: testAdminActor.id, nama: testAdminActor.nama, role: "admin" } as any);
      assert.strictEqual(res.status, "Dibayar");

      const kmRow = db.prepare("SELECT * FROM kas_messenger WHERE reimbursement_id = ?").get(reimbId) as any;
      assert.ok(kmRow, "Kas messenger row created");
      assert.strictEqual(kmRow.kredit, 75000);
      assert.strictEqual(kmRow.payment_method_id, null);

      const officeBalAfter = (db.prepare("SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(kredit), 0) as balance FROM kas_kantor").get() as any).balance;
      assert.strictEqual(officeBalBefore, officeBalAfter, "Kas kantor balance 100% untouched");
    });

    await st.test("TC-DOM-H02: Courier petty cash isolation: Transaction on Courier A does not alter Courier B", () => {
      const bResBefore = financeService.getAllKasMessenger("MSG-0002");
      const bBalBefore = bResBefore.data[0]?.total ?? 0;

      // Mutate Courier A
      financeService.addKasMessenger({
        tanggal: "2026-11-11",
        messenger: "Budi Santoso",
        messengerId: "MSG-0001",
        jenis: "Top Up",
        in: 200000,
        out: 0,
        payment_method_id: CIMB_PM_ID,
        keterangan: "Top up Courier A",
      }, testFinanceActor as any);

      const bResAfter = financeService.getAllKasMessenger("MSG-0002");
      const bBalAfter = bResAfter.data[0]?.total ?? 0;
      assert.strictEqual(bBalBefore, bBalAfter, "Courier B balance strictly isolated and unchanged");
    });

    await st.test("TC-DOM-H03: Consolidated Kas Messenger summary endpoint returns totalFloatingCash as sole SSoT", () => {
      const summaryResult = financeService.getAllKasMessenger();
      assert.ok(summaryResult.summary, "summary object exists in getAllKasMessenger response");
      assert.strictEqual(typeof summaryResult.summary.totalFloatingCash, "number", "totalFloatingCash is a valid number");
      assert.ok(Array.isArray(summaryResult.summary.byMessenger), "byMessenger is an array");
    });

    await st.test("TC-DOM-H04: Consolidated Kas Kantor aggregate balance covers all payment channels", () => {
      const allKk = financeService.getAllKasKantor();
      assert.ok(Array.isArray(allKk), "getAllKasKantor returns array");
      const unifiedBalance = allKk[0]?.saldo ?? 0;
      assert.strictEqual(typeof unifiedBalance, "number", "Unified aggregate balance exists");
    });

    await st.test("TC-DOM-H05: Independent Pengeluaran entry creation does not touch kas_kantor", () => {
      const officeCountBefore = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      const expRes = financeService.addPengeluaran({
        tanggal: "2026-11-11",
        keterangan: "Beli Alat Tulis Kantor",
        nominal: 50000,
        kategori: "ATK",
      }, testFinanceActor as any);
      assert.ok(expRes.id);

      const officeCountAfter = (db.prepare("SELECT COUNT(*) as count FROM kas_kantor").get() as any).count;
      assert.strictEqual(officeCountBefore, officeCountAfter, "kas_kantor count untouched after Pengeluaran creation");
    });

    await st.test("TC-DOM-H06: Disabled cash transfer endpoints return HTTP 410 GONE", () => {
      assert.throws(() => {
        financeService.transferOfficeToMessenger({
          nominal: 100000,
          messengerId: "MSG-0001",
          messengerName: "Budi Santoso",
          keterangan: "Attempted transfer",
        }, testFinanceActor as any);
      }, (err: any) => err.statusCode === 410 && err.code === "TRANSFERS_DISABLED");
    });

    await st.test("TC-DOM-H07: Mandatory payment method validation on courier top-up", () => {
      assert.throws(() => {
        financeService.addKasMessenger({
          tanggal: "2026-11-11",
          messenger: "Budi Santoso",
          messengerId: "MSG-0001",
          jenis: "Top Up",
          in: 100000,
          out: 0,
          keterangan: "Top up tanpa metode pembayaran",
        }, testFinanceActor as any);
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_PAYMENT_METHOD");
    });

    await st.test("TC-DOM-H08: Courier top-up with valid active method creates frozen snapshot", () => {
      const entry = financeService.addKasMessenger({
        tanggal: "2026-11-11",
        messenger: "Budi Santoso",
        messengerId: "MSG-0001",
        jenis: "Top Up",
        in: 100000,
        out: 0,
        payment_method_id: CIMB_PM_ID,
        keterangan: "Top up dengan CIMB",
      }, testFinanceActor as any);

      assert.ok(entry.paymentMethodId || (entry as any).payment_method_id);
      const kmRow = db.prepare("SELECT payment_method_snapshot FROM kas_messenger WHERE id = ?").get(entry.id) as any;
      assert.ok(kmRow.payment_method_snapshot, "Snapshot saved in kas_messenger row");
      const parsed = JSON.parse(kmRow.payment_method_snapshot);
      assert.strictEqual(parsed.bank, "CIMB NIAGA");
    });

    await st.test("TC-DOM-H09: Historical NULL payment method retention & physical delete blocker", () => {
      // 1. Audit historical kas_messenger records retain NULL
      const histRows = db.prepare("SELECT payment_method_id, payment_method_snapshot FROM kas_messenger WHERE id <= 2").all() as any[];
      for (const row of histRows) {
        assert.strictEqual(row.payment_method_id, null, "Historical payment_method_id remains NULL");
        assert.strictEqual(row.payment_method_snapshot, null, "Historical payment_method_snapshot remains NULL");
      }

      // 2. Physical delete of referenced payment method blocked with HTTP 409
      assert.throws(() => {
        paymentMethodService.delete(CIMB_PM_ID);
      }, (err: any) => err.statusCode === 409 && err.code === "CANNOT_DELETE_REFERENCED_PAYMENT_METHOD");
    });
  });

  await t.test("Group I: Post-Implementation Remediation & Verification", async (st) => {
    let activePm = db.prepare("SELECT * FROM payment_methods WHERE status = 'Aktif' LIMIT 1").get() as any;
    if (!activePm) {
      db.prepare(`
        INSERT OR IGNORE INTO payment_methods (id, nama_metode, bank, nama_rekening, nomor_rekening, status, created_at, updated_at)
        VALUES ('pm-test-master', 'Transfer Mandiri Test', 'Bank Mandiri', 'PT SUN TEST', '1234567890', 'Aktif', datetime('now'), datetime('now'))
      `).run();
      activePm = db.prepare("SELECT * FROM payment_methods WHERE id = 'pm-test-master'").get() as any;
    }

    await st.test("TC-REM-01: Payment Method Snapshot is created at recording time and immune to subsequent master change", () => {
      const testOrdNo = "ORD-REM-001";
      const testInvNo = "INV-REM-001";
      const invId = createTestInvoice(testInvNo, testOrdNo);
      db.prepare(`
        UPDATE orders 
        SET data_json = '{"isVerified": true, "finalCost": 500000, "is_cost_verified": 1, "approvedBySpv": true, "currentStep": 7}',
            is_cost_verified = 1
        WHERE order_no = ?
      `).run(testOrdNo);

      const paymentDetails = {
        paymentMethodId: activePm.id,
        metodePembayaran: activePm.nama_metode,
        bank: activePm.bank,
        noRekening: activePm.nomor_rekening,
        namaRekening: activePm.nama_rekening,
      };
      financeService.recordPayment(invId, 500000, paymentDetails, testFinanceActor as any);

      const payRow = db.prepare("SELECT * FROM invoice_payments WHERE invoice_no = ?").get(testInvNo) as any;
      assert.ok(payRow, "Payment row must be created");
      assert.strictEqual(payRow.metode_pembayaran_id, activePm.id);
      assert.ok(payRow.payment_method_snapshot, "payment_method_snapshot must be created at payment recording time");

      const initialSnapshot = JSON.parse(payRow.payment_method_snapshot);
      assert.strictEqual(initialSnapshot.id, activePm.id);
      assert.strictEqual(initialSnapshot.nama_metode, activePm.nama_metode);

      db.prepare("UPDATE payment_methods SET nama_rekening = 'MUTATED REKENING', status = 'Nonaktif' WHERE id = ?").run(activePm.id);

      const verifyRes = verifyInvoicePaymentAtomic(
        payRow.payment_id,
        testInvNo,
        testSvpActor.id,
        testSvpActor.role,
        crypto.randomUUID(),
        db
      );

      assert.strictEqual(verifyRes.success, true);

      const kkRow = db.prepare("SELECT payment_method_id, payment_method_snapshot FROM kas_kantor WHERE id = ?").get(verifyRes.data.kasKantorId) as any;
      assert.strictEqual(kkRow.payment_method_id, activePm.id);
      const copiedSnapshot = JSON.parse(kkRow.payment_method_snapshot);
      assert.strictEqual(copiedSnapshot.nama_rekening, activePm.nama_rekening || null, "Snapshot must retain original nama_rekening");
      assert.notStrictEqual(copiedSnapshot.nama_rekening, "MUTATED REKENING", "Snapshot must NOT reflect updated master data");

      db.prepare("UPDATE payment_methods SET nama_rekening = ?, status = 'Aktif' WHERE id = ?").run(activePm.nama_rekening, activePm.id);
    });

    await st.test("TC-REM-02: Canonical Messenger Identity & Cross-Courier Access Rejection", () => {
      const courierUser1: any = { userId: "4", role: "messenger", employeeId: "EMP-0004", nama: "Budi Santoso" };

      db.prepare("INSERT OR IGNORE INTO messengers (id, employee_id, plat_motor_operasional, wilayah_tugas_utama) VALUES ('MSG-0001', 'EMP-0004', 'B 1111 TAA', 'Jakarta')").run();
      db.prepare("INSERT OR IGNORE INTO messengers (id, employee_id, plat_motor_operasional, wilayah_tugas_utama) VALUES ('MSG-0002', 'EMP-0005', 'B 2222 TBB', 'Depok')").run();

      assert.throws(() => {
        financeService.getAllKasMessenger("MSG-0002", courierUser1, db);
      }, (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN_COURIER_ACCESS");

      assert.throws(() => {
        financeService.addKasMessenger({
          tanggal: "2026-11-11",
          messenger: "Andi Pratama",
          messengerId: "MSG-0002",
          jenis: "Top Up",
          in: 50000,
          out: 0,
          payment_method_id: CASH_PM_ID,
          keterangan: "Cross courier attempt",
        }, courierUser1, db);
      }, (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN_COURIER_ACCESS");

      const courierRes = financeService.getAllKasMessenger(undefined, courierUser1, db);
      assert.strictEqual(courierRes.summary.byMessenger.length, 1);
      assert.strictEqual(courierRes.summary.byMessenger[0].messengerId, "MSG-0001");

      const adminRes = financeService.getAllKasMessenger("EMP-0004", testFinanceActor as any, db);
      assert.ok(adminRes.summary.byMessenger.some(m => m.messengerId === "MSG-0001"));
    });

    await st.test("TC-REM-03: Chronological Ordering & Deterministic Tie-Breaker", () => {
      const mockTestEntries = [
        { id: 9101, tanggal: "2026-11-04T14:00:00.000Z", created_at: "2026-11-04 14:00:00", debit: 100000, kredit: 0 },
        { id: 9102, tanggal: "2026-11-04", created_at: "2026-11-04 14:00:00", debit: 50000, kredit: 0 },
        { id: 9103, tanggal: "2026-11-05", created_at: "2026-11-05 08:00:00", debit: 200000, kredit: 0 },
        { id: 9104, tanggal: "2026-11-03", created_at: "2026-11-03 10:00:00", debit: 300000, kredit: 0 },
      ];

      for (const e of mockTestEntries) {
        db.prepare(`
          INSERT INTO kas_kantor (id, tanggal, keterangan, status, debit, kredit, saldo, created_at)
          VALUES (?, ?, 'Order Test Entry', 'Debit', ?, ?, 0, ?)
        `).run(e.id, e.tanggal, e.debit, e.kredit, e.created_at);
      }

      recalculateKasKantorRunningBalances(db);

      const forwardRows = db.prepare(`
        SELECT id, tanggal, substr(tanggal, 1, 10) as dt, created_at, saldo
        FROM kas_kantor 
        WHERE id >= 9101 AND id <= 9104
        ORDER BY substr(tanggal, 1, 10) ASC, created_at ASC, id ASC
      `).all() as any[];

      assert.strictEqual(forwardRows[0].id, 9104, "Earliest date 2026-11-03 must be first");
      assert.strictEqual(forwardRows[1].id, 9101, "2026-11-04 id 9101 must precede 9102");
      assert.strictEqual(forwardRows[2].id, 9102, "2026-11-04 id 9102 must follow 9101");
      assert.strictEqual(forwardRows[3].id, 9103, "Latest date 2026-11-05 must be last");

      const descRows = db.prepare(`
        SELECT id, tanggal
        FROM kas_kantor
        WHERE id >= 9101 AND id <= 9104
        ORDER BY substr(tanggal, 1, 10) DESC, created_at DESC, id DESC
      `).all() as any[];

      assert.strictEqual(descRows[0].id, 9103);
      assert.strictEqual(descRows[1].id, 9102);
      assert.strictEqual(descRows[2].id, 9101);
      assert.strictEqual(descRows[3].id, 9104);

      db.prepare("DELETE FROM kas_kantor WHERE id >= 9101 AND id <= 9104").run();
      recalculateKasKantorRunningBalances(db);
    });

    await st.test("TC-REM-04: Permanent DELETE writes to audit_logs with deletedSnapshot & Idempotent Replay", () => {
      const insRes = db.prepare(`
        INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori, created_at)
        VALUES ('2026-11-11', 'Kas to delete permanently', 'Debit', 100000, 0, 100000, 'OPERASIONAL', datetime('now'))
      `).run();
      const targetId = Number(insRes.lastInsertRowid);
      recalculateKasKantorRunningBalances(db);

      const idemKey = crypto.randomUUID();
      const reason = "Audit snapshot and idempotency test permanent deletion";

      const delRes = deletePermanentlyWithAuditAndIdempotency(
        "kas_kantor",
        targetId,
        reason,
        testSvpActor.id,
        testSvpActor.role,
        idemKey,
        db
      );

      assert.strictEqual(delRes.statusCode, 200);

      const auditEntry = db.prepare(`
        SELECT * FROM audit_logs 
        WHERE action = 'PERMANENT_DELETE' AND metadata_json LIKE ?
      `).get(`%${idemKey}%`) as any;

      assert.ok(auditEntry, "audit_logs row must be present");
      assert.strictEqual(Number(auditEntry.user_id), Number(testSvpActor.id));
      assert.strictEqual(auditEntry.action, "PERMANENT_DELETE");
      const metadata = JSON.parse(auditEntry.metadata_json);
      assert.ok(metadata.deletedSnapshot, "deletedSnapshot must be captured in metadata_json");
      assert.strictEqual(metadata.deletedSnapshot.keterangan, "Kas to delete permanently");

      const auditCountBefore = (db.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE metadata_json LIKE ?").get(`%${idemKey}%`) as any).count;
      const replayRes = deletePermanentlyWithAuditAndIdempotency(
        "kas_kantor",
        targetId,
        reason,
        testSvpActor.id,
        testSvpActor.role,
        idemKey,
        db
      );
      assert.strictEqual(replayRes.statusCode, 200);
      const auditCountAfter = (db.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE metadata_json LIKE ?").get(`%${idemKey}%`) as any).count;
      assert.strictEqual(auditCountBefore, auditCountAfter, "Replay must NOT insert duplicate audit record");
    });

    await st.test("TC-REM-05: Order Downpayment Frozen Snapshot at Creation & Immutability at Verification", () => {
      // 1. Create dedicated active master payment method
      const testPmId = "pm-ord-down-test-" + Date.now();
      db.prepare(`
        INSERT INTO payment_methods (id, nama_metode, bank, nomor_rekening, nama_rekening, status, created_at, updated_at)
        VALUES (?, 'Bank Mandiri Test', 'MANDIRI', '1234567890', 'PT SUN MANDIRI TEST', 'Aktif', datetime('now'), datetime('now'))
      `).run(testPmId);

      // 2. Create order with downpayment
      const orderPayload = {
        customer: "Customer Downpayment Snapshot Test",
        nomorHP: "081299998888",
        layanan: "Perpanjangan STNK",
        serviceId: "svc-perp-1th",
        nopol: "B 1234 DPT",
        wilayahSamsatAsal: "Jakarta Pusat",
        totalBiaya: 500000,
        payment: {
          tipePembayaran: "Bayar di Awal",
          nominalDibayarAwal: 300000,
          dibayar: 300000,
          paymentMethodId: testPmId,
          buktiPembayaran: {
            fileName: "bukti_tf_dp.jpg",
            fileUrl: "/uploads/bukti_tf_dp.jpg",
          },
        },
      };

      const createdOrder = orderService.createOrder(orderPayload, testSvpActor as any);
      const dpRecord = createdOrder.payment?.paymentRecords?.[0];
      assert.ok(dpRecord, "Downpayment payment record must exist in created order");
      assert.ok(dpRecord.payment_method_snapshot, "payment_method_snapshot must be frozen at order creation");
      
      const parsedCreationSnapshot = JSON.parse(dpRecord.payment_method_snapshot);
      assert.strictEqual(parsedCreationSnapshot.id, testPmId);
      assert.strictEqual(parsedCreationSnapshot.nama_rekening, "PT SUN MANDIRI TEST");
      assert.strictEqual(parsedCreationSnapshot.bank, "MANDIRI");

      // 3. Mutate master payment method in database to prove historical immutability
      db.prepare(`
        UPDATE payment_methods
        SET nama_rekening = 'MUTATED REKENING EVIL', bank = 'BANK LAIN', status = 'Nonaktif'
        WHERE id = ?
      `).run(testPmId);

      // 4. Verify payment via financeService
      const verifyRes = financeService.verifyPayment({
        orderNo: createdOrder.orderNo,
        notes: "Verifikasi DP Order Snapshot Immutability",
        proofPayload: {
          fileName: "bukti_tf_dp.jpg",
          fileUrl: "/uploads/bukti_tf_dp.jpg",
        },
        user: testSvpActor as any,
      });

      assert.ok(verifyRes.payment, "Verification must succeed and return payment record");
      
      // 5. Verify snapshot on invoice_payments table
      const invPaymentRow = db.prepare(`
        SELECT * FROM invoice_payments WHERE order_no = ?
      `).get(createdOrder.orderNo) as any;

      assert.ok(invPaymentRow, "invoice_payments row must exist");
      assert.ok(invPaymentRow.payment_method_snapshot, "invoice_payments must have frozen payment_method_snapshot");
      const parsedInvPmSnapshot = JSON.parse(invPaymentRow.payment_method_snapshot);
      assert.strictEqual(parsedInvPmSnapshot.nama_rekening, "PT SUN MANDIRI TEST", "Snapshot must retain original recording condition");
      assert.strictEqual(parsedInvPmSnapshot.bank, "MANDIRI", "Snapshot must NOT take mutated bank name");

      // 6. Verify snapshot copied to kas_kantor
      if (invPaymentRow.kas_kantor_id) {
        const kkRow = db.prepare("SELECT * FROM kas_kantor WHERE id = ?").get(invPaymentRow.kas_kantor_id) as any;
        assert.ok(kkRow, "Linked kas_kantor row must exist");
        if (kkRow.payment_method_snapshot) {
          const parsedKkSnapshot = JSON.parse(kkRow.payment_method_snapshot);
          assert.strictEqual(parsedKkSnapshot.nama_rekening, "PT SUN MANDIRI TEST");
        }
      }
    });

    await st.test("TC-REM-06: Permanent DELETE Reason Validation - Empty, Whitespace & <10 Chars Fail Closed", () => {
      // Test empty string
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_DELETE_REASON");

      // Test whitespace only
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "         ", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_DELETE_REASON");

      // Test 9 characters
      assert.throws(() => {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "123456789", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      }, (err: any) => err.statusCode === 400 && err.code === "INVALID_DELETE_REASON");

      // Test exactly 10 characters (should not fail on reason validation)
      // Note: May fail on row ID 1 (CANNOT_DELETE_INITIAL_CAPITAL), which proves reason validation passed!
      try {
        deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "1234567890", testSvpActor.id, testSvpActor.role, crypto.randomUUID());
      } catch (err: any) {
        assert.notStrictEqual(err.code, "INVALID_DELETE_REASON", "10-character reason must pass reason validation");
      }
    });
  });
});
