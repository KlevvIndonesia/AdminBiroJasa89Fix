/**
 * Phase 4B Batch 2C — Standalone Historical Reconciliation Mechanism (BD-FIN-01)
 * 
 * Safety Rules:
 * 1. Default mode: DRY-RUN (zero SQLite writes).
 * 2. Refuses execution on operational database (server/data/database.sqlite).
 * 3. Enforces HOLD when external invoice issuance status is UNKNOWN.
 * 4. Preserves payment identity, lifecycle transitions (#2 -> #3, #6 -> #7), and unresolved relations (#1 vs #3).
 * 5. Strictly preserves all payment amounts and does not delete historical payment rows.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ReconciliationReport {
  mode: "DRY_RUN" | "LIVE_EXECUTION";
  status: "HOLD" | "PROCEED" | "ABORTED";
  databasePath: string;
  missingEvidence: string[];
  operationalDbProtected: boolean;
  paymentAnalysis: {
    totalRows: number;
    lifecyclePairs: Array<{ fromId: number; toId: number; reason: string }>;
    unresolvedRelations: Array<{ idA: number; idB: number; notes: string }>;
  };
  proposedActions: Array<{
    targetTable: string;
    identifier: string;
    action: string;
    details: Record<string, any>;
  }>;
  executed: boolean;
  message: string;
}

export interface ReconcileOptions {
  dbPath?: string;
  targetDb?: DatabaseSync;
  execute?: boolean;
  externalIssuanceProven?: boolean;
  selectedOption?: "OPTION_A" | "OPTION_B" | "HOLD";
}

export function runHistoricalReconciliation(options: ReconcileOptions = {}): ReconciliationReport {
  const isExecute = options.execute === true;
  const isProven = options.externalIssuanceProven === true;
  const selectedOption = options.selectedOption || "HOLD";

  const resolvedDbPath = options.dbPath
    ? path.resolve(options.dbPath)
    : (process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.resolve(__dirname, "../server/data/database.sqlite"));

  const operationalDbPath = path.resolve(__dirname, "../server/data/database.sqlite");

  // Hard safety guard: Never allow live execution against operational database
  const isTargetingOperational = (!options.targetDb || options.dbPath) && resolvedDbPath === operationalDbPath;
  if (isExecute && isTargetingOperational) {
    throw new Error(
      "[FATAL SAFETY GUARD] Live reconciliation execution against operational database is strictly prohibited!"
    );
  }

  const db = options.targetDb || new DatabaseSync(resolvedDbPath, { readOnly: !isExecute });

  const missingEvidence: string[] = [
    "Fisik kertas kwitansi / copy invoice di kantor kasir operasional belum diperiksa.",
    "Riwayat chat WhatsApp Business dengan customer Frenkye Sitorus dan Mahesa Alghifari belum diverifikasi.",
    "Catatan berita transfer rekening koran bank (BCA/Mandiri) belum direkonsiliasi.",
    "Niat awal pembuatan row migrasi #3 terhadap row #1 belum terdokumentasi secara tertulis."
  ];

  // Inspect invoice_payments rows 1-7
  const paymentRows = db.prepare(
    "SELECT id, order_no, invoice_no, nominal, status_verifikasi, kas_kantor_id, created_at FROM invoice_payments WHERE id <= 7 ORDER BY id"
  ).all() as Array<{
    id: number;
    order_no: string;
    invoice_no: string;
    nominal: number;
    status_verifikasi: string;
    kas_kantor_id: number | null;
    created_at: string;
  }>;

  // Inspect finance_invoices
  const invoices = db.prepare(
    "SELECT id, invoice_no, order_no, customer, total_tagihan, dibayar, status FROM finance_invoices WHERE invoice_no = 'INV-1126-001'"
  ).all() as Array<{
    id: number;
    invoice_no: string;
    order_no: string;
    customer: string;
    total_tagihan: number;
    dibayar: number;
    status: string;
  }>;

  // Inspect orders
  const orders = db.prepare(
    "SELECT order_no, customer FROM orders WHERE order_no IN ('ORD-1126-001', 'ORD-1126-003')"
  ).all() as Array<{ order_no: string; customer: string }>;

  const paymentAnalysis = {
    totalRows: paymentRows.length,
    lifecyclePairs: [
      { fromId: 2, toId: 3, reason: "Transisi status verifikasi backfill: MENUNGGU_VERIFIKASI -> TERVERIFIKASI pada 2026-11-05 05:37:36" },
      { fromId: 6, toId: 7, reason: "Transisi status verifikasi backfill: MENUNGGU_VERIFIKASI -> TERVERIFIKASI pada 2026-11-10 01:07:55" }
    ],
    unresolvedRelations: [
      { idA: 1, idB: 3, notes: "Row #1 dibuat runtime (terhubung kas_kantor ID 2); Row #3 dibuat script migrasi backfill. Hubungan saling menggantikan atau duplikasi belum terbukti." }
    ]
  };

  const proposedActions: Array<{
    targetTable: string;
    identifier: string;
    action: string;
    details: Record<string, any>;
  }> = [];

  // If evidence is NOT proven, HOLD is strictly enforced
  if (!isProven || selectedOption === "HOLD") {
    return {
      mode: isExecute ? "LIVE_EXECUTION" : "DRY_RUN",
      status: "HOLD",
      databasePath: resolvedDbPath,
      missingEvidence,
      operationalDbProtected: true,
      paymentAnalysis,
      proposedActions: [
        {
          targetTable: "finance_invoices",
          identifier: "INV-1126-001",
          action: "HOLD_RECORD",
          details: {
            reason: "External issuance status is UNKNOWN. Operational rows maintained unchanged.",
            runtimeIsolation: "Application uses composite (invoice_no, order_no) to prevent balance bleeding."
          }
        }
      ],
      executed: false,
      message: "[RECONCILIATION HOLD] External invoice issuance status is UNKNOWN. Standalone script safely halts without DML."
    };
  }

  // If external issuance is proven and Option A is selected in isolated test database:
  if (selectedOption === "OPTION_A" && isExecute) {
    // Execute strictly inside transaction
    db.exec("BEGIN IMMEDIATE;");
    try {
      // 1. Re-bind finance_invoices (id: 1) to ORD-1126-001 (Mahesa Alghifari)
      db.prepare(`
        UPDATE finance_invoices
        SET order_no = 'ORD-1126-001', customer = 'Mahesa Alghifari S.Kom', updated_at = datetime('now')
        WHERE invoice_no = 'INV-1126-001'
      `).run();

      // 2. Insert canonical invoice for ORD-1126-003 (Frenkye Sitorus)
      db.prepare(`
        INSERT OR IGNORE INTO finance_invoices (
          invoice_no, order_no, customer, layanan, status, total_tagihan, dibayar, sisa,
          biaya_samsat, pendapatan_jasa, overpayment, settlement_condition, refund_status,
          cashback_nominal, cashback_status, profit_final, profit_status, biaya_jasa,
          biaya_antar_jemput, data_json, updated_at
        ) VALUES (
          'INV-1126-003', 'ORD-1126-003', 'Frenkye Sitorus', 'Perpanjangan STNK Tahunan', 'PAID',
          1258000, 1258000, 0, 1208000, 50000, 0, 'BALANCED', 'NONE',
          0, 'NONE', 50000, 'REALIZED', 50000,
          0, '{"invoiceNo":"INV-1126-003","orderNo":"ORD-1126-003"}', datetime('now')
        )
      `).run();

      // 3. Re-link payment rows 6 and 7 to INV-1126-003
      db.prepare(`
        UPDATE invoice_payments
        SET invoice_no = 'INV-1126-003'
        WHERE id IN (6, 7)
      `).run();

      db.exec("COMMIT;");

      return {
        mode: "LIVE_EXECUTION",
        status: "PROCEED",
        databasePath: resolvedDbPath,
        missingEvidence: [],
        operationalDbProtected: true,
        paymentAnalysis,
        proposedActions: [
          {
            targetTable: "finance_invoices",
            identifier: "INV-1126-001",
            action: "REBIND_TO_ORD_1126_001",
            details: { newOrderNo: "ORD-1126-001" }
          },
          {
            targetTable: "finance_invoices",
            identifier: "INV-1126-003",
            action: "INSERT_INVOICE_FOR_ORD_1126_003",
            details: { invoiceNo: "INV-1126-003", orderNo: "ORD-1126-003" }
          },
          {
            targetTable: "invoice_payments",
            identifier: "ROWS_6_AND_7",
            action: "UPDATE_INVOICE_NO",
            details: { oldInvoiceNo: "INV-1126-001", newInvoiceNo: "INV-1126-003" }
          }
        ],
        executed: true,
        message: "[RECONCILIATION EXECUTED] Historical records cleanly re-bound in sandbox environment under Option A."
      };
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  return {
    mode: "DRY_RUN",
    status: "PROCEED",
    databasePath: resolvedDbPath,
    missingEvidence,
    operationalDbProtected: true,
    paymentAnalysis,
    proposedActions,
    executed: false,
    message: "[DRY RUN COMPLETED] Simulation completed with zero database mutations."
  };
}

// CLI Execution support
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const isExecute = args.includes("--execute");
  const isProven = args.includes("--external-issuance-proven=true");
  const optionArg = args.find((a) => a.startsWith("--option="));
  const selectedOption = (optionArg ? optionArg.split("=")[1] : "HOLD") as any;

  try {
    const report = runHistoricalReconciliation({
      execute: isExecute,
      externalIssuanceProven: isProven,
      selectedOption
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (err: any) {
    console.error("[RECONCILIATION ERROR]", err.message);
    process.exit(1);
  }
}
