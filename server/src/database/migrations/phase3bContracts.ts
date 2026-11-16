/**
 * Phase 3B Migration Contract Metadata (M1–M5 Planned Stage Descriptors)
 * Admin SUN89 — Biro Jasa Management System
 *
 * IMPORTANT (Phase 3B Step 1 Boundary):
 * - This file defines versioned CONTRACT METADATA ONLY.
 * - NO M1–M5 DDL or runtime schema mutations are implemented or executed here.
 * - All M1–M5 domain migrations remain DEFERRED until Step 2+ and closure of required BD blockers.
 */

import type { MigrationContract } from "./migrationFramework";

export interface PlannedPhase3BMigrationContract extends MigrationContract {
  stageCode: "M1" | "M2" | "M3" | "M4" | "M5";
  implementationStatus: "DEFERRED";
  blockingDecisions: string[];
  requiredPreflightChecks: string[];
}

export const PHASE_3B_PREFLIGHT_GATES: ReadonlyArray<{
  code: string;
  description: string;
  appliesTo: Array<"M1" | "M2" | "M3" | "M4" | "M5">;
}> = [
  { code: "PF-01", description: "DB Integrity Check (PRAGMA integrity_check; PRAGMA quick_check; on read-only copy)", appliesTo: ["M1", "M2", "M3", "M4", "M5"] },
  { code: "PF-02", description: "FK Baseline Check (PRAGMA foreign_keys=ON; PRAGMA foreign_key_check; on read-only copy)", appliesTo: ["M1", "M2", "M3", "M4", "M5"] },
  { code: "PF-03", description: "Table & Index Inventory matching baseline columns and 16 explicit indexes", appliesTo: ["M1", "M2", "M3", "M4", "M5"] },
  { code: "PF-04", description: "Orphan Ref Detection across finance_invoices, invoice_payments, and service_pricing_configs", appliesTo: ["M2", "M3"] },
  { code: "PF-05", description: "Duplicate / Malformed Invoice-Order 1:1 Uniqueness Check on finance_invoices.order_no", appliesTo: ["M2"] },
  { code: "PF-06", description: "Fractional REAL Rupiah Check prior to INTEGER conversion in M2", appliesTo: ["M2"] },
  { code: "PF-07", description: "Historical Payment Inventory (voids, unlinked kas_kantor_id, nominal <= 0 check)", appliesTo: ["M2", "M3", "M4"] },
  { code: "PF-08", description: "Refund & Payout JSON Validity Check (json_valid(data_json) and refundedAmount summary)", appliesTo: ["M2", "M3", "M4"] },
  { code: "PF-09", description: "Legacy Payout 'ALL' & Non-Standard refund_status Inventory", appliesTo: ["M2", "M4"] },
  { code: "PF-10", description: "Finance Ledger Baseline Reconciliation (kas_kantor vs invoice_payments & dibayar)", appliesTo: ["M3", "M4", "M5"] },
  { code: "PF-11", description: "Offline Backup & Restore 10-Step Verification Protocol (mandatory hard-stop gate before M2)", appliesTo: ["M1", "M2", "M3", "M4", "M5"] },
];

export const UNRESOLVED_BUSINESS_DECISIONS = [
  { id: "BD-01", area: "ACC ID R4 vs R2 (totalEstimasi calculation policy)", status: "UNRESOLVED" },
  { id: "BD-02", area: "Mutasi package Rp1 juta / Rp1.5 juta vs 29 detailed items", status: "UNRESOLVED" },
  { id: "BD-03", area: "Tarif 29 items R2 vs R4 differentiation", status: "UNRESOLVED" },
  { id: "BD-04", area: "Pricing config behavior for in-progress orders", status: "UNRESOLVED" },
  { id: "BD-05", area: "Scheduled config publishing (effective_from)", status: "UNRESOLVED" },
  { id: "BD-06", area: "Stage 5 cost overrun approval threshold", status: "UNRESOLVED" },
  { id: "BD-07", area: "Mandatory components per service", status: "UNRESOLVED" },
  { id: "BD-08", area: "Order cancellation forfeiture / deduction rules", status: "UNRESOLVED" },
  { id: "BD-09", area: "Cash-capped vs accrual revenue recognition semantics", status: "UNRESOLVED" },
] as const;

export const PHASE_3B_PLANNED_CONTRACTS: ReadonlyArray<PlannedPhase3BMigrationContract> = [
  {
    stageCode: "M1",
    implementationStatus: "DEFERRED",
    id: "2026-11-17-001-m1-estimation-config-versioning",
    order: 1001,
    name: "M1: Estimation & Configuration Versioning Schema",
    purpose: "Introduce immutable pricing configuration version tables and order estimation snapshot schema without altering legacy tables.",
    preconditions: ["PF-01", "PF-02", "PF-03", "PF-11"],
    schemaChanges: ["Planned additive pricing revision & estimation snapshot tables (DEFERRED to Phase 3B Step 2)."],
    postconditions: ["All baseline tables and indexes remain unmodified and preserved (compareSchemas allowUnexpectedTables whitelist)."],
    rollbackStrategy: {
      reversible: true,
      summary: "Additive tables only prior to cutover; reversible by dropping newly introduced M1 tables in test/pre-cutover environments.",
    },
    verificationTests: ["tests/phase3b-04-domain-contracts-pending.test.ts#category-4-config-versioning"],
    requiresFkDisabled: false,
    blockingDecisions: ["BD-01", "BD-02", "BD-03", "BD-04", "BD-05", "BD-07"],
    requiredPreflightChecks: ["PF-01", "PF-02", "PF-03", "PF-11"],
  },
  {
    stageCode: "M2",
    implementationStatus: "DEFERRED",
    id: "2026-11-17-002-m2-finance-table-rebuild-and-constraints",
    order: 1002,
    name: "M2: Finance Invoices & Payments Constraint Hardening (Table Rebuild)",
    purpose: "Rebuild finance_invoices / invoice_payments preserving all baseline columns and 16+ indexes while enforcing stricter integrity constraints.",
    preconditions: ["M1 applied", "PF-01", "PF-02", "PF-03", "PF-04", "PF-05", "PF-06", "PF-07", "PF-08", "PF-09", "PF-11"],
    schemaChanges: ["Controlled SQLite table rebuild for finance_invoices / invoice_payments with full column and index preservation (DEFERRED)."],
    postconditions: [
      "Zero baseline columns lost (34 finance_invoices + 25 invoice_payments cols preserved).",
      "All 16 retained explicit indexes recreated and verified via SchemaInventory.",
      "PRAGMA foreign_key_check reports zero violations before COMMIT.",
    ],
    rollbackStrategy: {
      reversible: false,
      reason: "Table rebuild modifies constraint topology in place; restore from verified pre-M2 snapshot backup if rollback required post-cutover.",
    },
    verificationTests: ["tests/phase3b-04-domain-contracts-pending.test.ts#category-9-migration-preservation"],
    requiresFkDisabled: true,
    blockingDecisions: ["BD-08", "BD-09"],
    requiredPreflightChecks: ["PF-01", "PF-02", "PF-03", "PF-04", "PF-05", "PF-06", "PF-07", "PF-08", "PF-09", "PF-11"],
  },
  {
    stageCode: "M3",
    implementationStatus: "DEFERRED",
    id: "2026-11-17-003-m3-actual-cost-and-payout-events",
    order: 1003,
    name: "M3: Actual Cost & Append-Only Payout Event Ledger",
    purpose: "Add append-only actual-cost verification events and payout event/projection tables separating operational stages from financial state.",
    preconditions: ["M2 applied", "PF-04", "PF-07", "PF-08", "PF-10", "PF-11"],
    schemaChanges: ["Planned append-only event tables and triggers/check constraints (DEFERRED)."],
    postconditions: ["Bidirectional event-projection invariants hold cleanly."],
    rollbackStrategy: {
      reversible: true,
      summary: "Additive tables prior to cutover; reversible in pre-cutover environments.",
    },
    verificationTests: [
      "tests/phase3b-04-domain-contracts-pending.test.ts#category-6-actual-cost",
      "tests/phase3b-04-domain-contracts-pending.test.ts#category-8-event-projection",
    ],
    requiresFkDisabled: false,
    blockingDecisions: ["BD-06", "BD-08", "BD-09"],
    requiredPreflightChecks: ["PF-01", "PF-02", "PF-03", "PF-04", "PF-07", "PF-08", "PF-10", "PF-11"],
  },
  {
    stageCode: "M4",
    implementationStatus: "DEFERRED",
    id: "2026-11-17-004-m4-historical-snapshot-backfill",
    order: 1004,
    name: "M4: Historical Order Snapshot & Settlement Projection Backfill",
    purpose: "Deterministically backfill legacy orders and settlements into versioned projections without altering historical billed totals.",
    preconditions: ["M3 applied", "PF-07", "PF-08", "PF-09", "PF-10", "PF-11"],
    schemaChanges: ["Additive backfill rows only; non-destructive on legacy columns (DEFERRED)."],
    postconditions: ["100% reconciliation parity between legacy invoice/payment totals and Model A FULFILLED projection."],
    rollbackStrategy: {
      reversible: false,
      reason: "Data backfill merges historical records into event projections; rollback relies on pre-M4 snapshot backup.",
    },
    verificationTests: ["tests/phase3b-04-domain-contracts-pending.test.ts#category-10-cross-domain"],
    requiresFkDisabled: false,
    blockingDecisions: ["BD-04", "BD-08", "BD-09"],
    requiredPreflightChecks: ["PF-01", "PF-02", "PF-03", "PF-07", "PF-08", "PF-09", "PF-10", "PF-11"],
  },
  {
    stageCode: "M5",
    implementationStatus: "DEFERRED",
    id: "2026-11-17-005-m5-authoritative-cutover-hardening",
    order: 1005,
    name: "M5: Authoritative Calculation Cutover & Immutability Enforcement",
    purpose: "Activate final immutability guards and database triggers once all BD-01..BD-09 decisions and parity suites pass.",
    preconditions: ["M4 applied", "All BD-01..BD-09 resolved", "Zero parity diffs", "PF-10", "PF-11"],
    schemaChanges: ["Planned immutability triggers and cutover constraints (DEFERRED)."],
    postconditions: ["Snapshot immutability and FSM transition triggers enforced at SQLite layer."],
    rollbackStrategy: {
      reversible: true,
      summary: "Trigger drop restores prior write paths during emergency cutover fallback window.",
    },
    verificationTests: ["tests/phase3b-04-domain-contracts-pending.test.ts#category-5-snapshot-immutability"],
    requiresFkDisabled: false,
    blockingDecisions: ["BD-01", "BD-02", "BD-03", "BD-04", "BD-05", "BD-06", "BD-07", "BD-08", "BD-09"],
    requiredPreflightChecks: ["PF-01", "PF-02", "PF-03", "PF-10", "PF-11"],
  },
];
