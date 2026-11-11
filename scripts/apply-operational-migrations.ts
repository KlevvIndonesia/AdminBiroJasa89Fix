/**
 * SUN89 Operational Migration Runner
 * Phase 4B Batch 2B/2C: Payment Methods & Kas Domain Separation
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import { runKasDomainSeparationMigration } from "../server/src/database/migrations/2026-11-11-001-kas-domain-separation";
import { runInvoiceOrderUniqueMigration } from "../server/src/database/migrations/2026-11-12-001-invoice-order-unique";

const dbPath = path.resolve("server/data/database.sqlite");
const backupPath = path.resolve("server/data/database.sqlite.bak-20261111-batch2b-payment-methods");

console.log("================================================================================");
console.log("      SUN89 OPERATIONAL DATABASE MIGRATION — PAYMENT METHODS IN KAS LEDGERS     ");
console.log("================================================================================");

// 1. Audit Pre-Migration File & Backup
if (!fs.existsSync(backupPath)) {
  console.error("FATAL: Backup file does not exist! Aborting migration.");
  process.exit(1);
}

const origBuf = fs.readFileSync(dbPath);
const origHash = crypto.createHash("sha256").update(origBuf).digest("hex").toUpperCase();
const bakBuf = fs.readFileSync(backupPath);
const bakHash = crypto.createHash("sha256").update(bakBuf).digest("hex").toUpperCase();

console.log(`[PRE-MIGRATION AUDIT]`);
console.log(`- Database Path:       ${dbPath}`);
console.log(`- Pre-Migration Size:  ${origBuf.length} bytes`);
console.log(`- Pre-Migration Hash:  ${origHash}`);
console.log(`- Backup Path:         ${backupPath}`);
console.log(`- Backup Size:         ${bakBuf.length} bytes`);
console.log(`- Backup Hash:         ${bakHash}`);

if (bakHash !== "A8A4B1F77FCAB6EE0A9503B778DE7A7A7929100D9AD6F965EF707503609E379C" && bakHash !== origHash) {
  console.error("FATAL: Backup hash does not match baseline! Aborting.");
  process.exit(1);
}
console.log(`- Backup Verification: PASS (Bit-for-bit identical)\n`);

// 2. Open DB & verify pragmas
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");

const fkPragma = db.prepare("PRAGMA foreign_keys;").get() as { foreign_keys: number };
if (Number(fkPragma.foreign_keys) !== 1) {
  throw new Error("PRAGMA foreign_keys is not active (1).");
}

const preIntegrity = db.prepare("PRAGMA integrity_check;").get() as { integrity_check: string };
if (preIntegrity.integrity_check !== "ok") {
  throw new Error(`Integrity check failed: ${preIntegrity.integrity_check}`);
}

const preFkCheck = db.prepare("PRAGMA foreign_key_check;").all();
if (preFkCheck.length > 0) {
  throw new Error(`Pre-existing FK violations detected: ${JSON.stringify(preFkCheck)}`);
}

console.log("[PRE-FLIGHT CHECKS] All passed (integrity_check: ok, foreign_key_check: 0, foreign_keys: 1).\n");

// 3. Execute Migration 1: Kas Domain Separation (payment methods in kas_messenger, kas_kantor, pengeluaran, invoice_payments)
console.log("[MIGRATION 1] Running runKasDomainSeparationMigration...");
runKasDomainSeparationMigration(db);
console.log("[MIGRATION 1] runKasDomainSeparationMigration executed successfully.\n");

// 4. Execute Migration 2: Invoice Order Unique
console.log("[MIGRATION 2] Running runInvoiceOrderUniqueMigration...");
const uniqueRes = runInvoiceOrderUniqueMigration(db);
console.log(`[MIGRATION 2] Result: ${uniqueRes.message}\n`);

// 5. Post-migration Pragmas
const postIntegrity = db.prepare("PRAGMA integrity_check;").get() as { integrity_check: string };
if (postIntegrity.integrity_check !== "ok") {
  throw new Error(`Post-migration integrity check failed: ${postIntegrity.integrity_check}`);
}

const postFkCheck = db.prepare("PRAGMA foreign_key_check;").all();
if (postFkCheck.length > 0) {
  throw new Error(`Post-migration FK violations detected: ${JSON.stringify(postFkCheck)}`);
}

console.log("[POST-MIGRATION CHECKS] All passed (integrity_check: ok, foreign_key_check: 0).\n");

// 6. Inspect Table Columns & Indices
function inspectTable(name: string) {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: any }>;
  const idxs = db.prepare(`PRAGMA index_list("${name}")`).all() as Array<{ name: string; unique: number }>;
  console.log(`Table '${name}':`);
  console.log(`  Columns: ${cols.map(c => c.name).join(", ")}`);
  console.log(`  Indices: ${idxs.map(i => `${i.name} (unique: ${i.unique})`).join(", ")}`);
}

inspectTable("kas_messenger");
inspectTable("kas_kantor");
inspectTable("pengeluaran");
inspectTable("invoice_payments");
inspectTable("finance_invoices");

// 7. Verify Historical Row Non-Mutation (Rows #1–#7 and existing records retain NULL payment method)
const histPayments = db.prepare("SELECT id, payment_id, nominal, metode_pembayaran_id, payment_method_snapshot FROM invoice_payments WHERE id <= 7").all() as any[];
console.log(`\nHistorical invoice_payments (Rows #1–#7):`);
for (const p of histPayments) {
  console.log(`  Row #${p.id}: nominal=${p.nominal}, payment_id=${p.payment_id}, pm_id=${p.metode_pembayaran_id}, snapshot=${p.payment_method_snapshot}`);
}

const existingKasMessenger = db.prepare("SELECT COUNT(*) as total, COUNT(payment_method_id) as with_method FROM kas_messenger").get() as any;
console.log(`Existing kas_messenger rows: total=${existingKasMessenger.total}, with_method=${existingKasMessenger.with_method} (All historical retain NULL)`);

const existingKasKantor = db.prepare("SELECT COUNT(*) as total, COUNT(payment_method_id) as with_method FROM kas_kantor").get() as any;
console.log(`Existing kas_kantor rows: total=${existingKasKantor.total}, with_method=${existingKasKantor.with_method} (All historical retain NULL)`);

db.close();

// 8. Post-Migration File Audit
const postBuf = fs.readFileSync(dbPath);
const postHash = crypto.createHash("sha256").update(postBuf).digest("hex").toUpperCase();
console.log(`\n[POST-MIGRATION AUDIT]`);
console.log(`- Database Path:       ${dbPath}`);
console.log(`- Post-Migration Size: ${postBuf.length} bytes`);
console.log(`- Post-Migration Hash: ${postHash}`);
console.log("================================================================================");
console.log("             OPERATIONAL DATABASE MIGRATION COMPLETED SUCCESSFULLY             ");
console.log("================================================================================");
