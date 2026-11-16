/**
 * Phase 3B Permanent Regression Test Category Registry
 *
 * Documents the 10-category test taxonomy mandated by Phase 3B Step 1 (Step E).
 * Categories 1, 2, and Schema Inventory utilities are implemented and executable now.
 * Categories 3–10 remain explicitly DEFERRED to Steps 2–5 and are never falsified as passing.
 */

export interface Phase3BTestCategoryDescriptor {
  categoryNumber: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  key: string;
  title: string;
  targetPhaseStep: string;
  status: "IMPLEMENTED" | "DEFERRED";
  entryFile: string;
  notes: string;
}

export const PHASE_3B_TEST_CATEGORIES: ReadonlyArray<Phase3BTestCategoryDescriptor> = [
  {
    categoryNumber: 1,
    key: "database-infrastructure",
    title: "Database Infrastructure & Isolation Tests",
    targetPhaseStep: "Phase 3B Step 1 (Step B)",
    status: "IMPLEMENTED",
    entryFile: "tests/phase3b-01-db-infrastructure.test.ts",
    notes: "Disposable temp/memory DBs, operational path rejection, WAL/FK/busy_timeout, TX commit/rollback, lock contention, cleanup.",
  },
  {
    categoryNumber: 2,
    key: "migration-framework",
    title: "Migration Framework & Schema Inventory Tests",
    targetPhaseStep: "Phase 3B Step 1 (Steps C & D)",
    status: "IMPLEMENTED",
    entryFile: "tests/phase3b-02-migration-framework.test.ts + tests/phase3b-03-schema-inventory.test.ts",
    notes: "Ordered deterministic IDs, schema_migrations tracking, duplicate/checksum guards, TX/FK rebuild protocol, rollback, schema diff inspector.",
  },
  {
    categoryNumber: 3,
    key: "estimation-domain",
    title: "Authoritative Backend Estimation Domain Tests",
    targetPhaseStep: "Phase 3B Step 2+",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Blocked on M1 & estimation engine consolidation + BD-01, BD-02, BD-03, BD-07.",
  },
  {
    categoryNumber: 4,
    key: "configuration-versioning",
    title: "Immutable Configuration Versioning Tests",
    targetPhaseStep: "Phase 3B Step 2+",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Blocked on M1 config revision tables, publish workflow & BD-05.",
  },
  {
    categoryNumber: 5,
    key: "snapshot-immutability",
    title: "Order Estimation Snapshot Immutability Tests",
    targetPhaseStep: "Phase 3B Step 2–5",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Blocked on M1/M5 snapshot columns, triggers, and BD-04.",
  },
  {
    categoryNumber: 6,
    key: "actual-cost-domain",
    title: "Stage 5 Actual-Cost Verification Domain Tests",
    targetPhaseStep: "Phase 3B Step 3+",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Blocked on M3 actual-cost FSM separation and BD-06.",
  },
  {
    categoryNumber: 7,
    key: "finance-reducer",
    title: "Finance Reducer & Model A FULFILLED Settlement Tests",
    targetPhaseStep: "Phase 3B Step 3–4",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Blocked on M2/M3 settlement reducer implementation & BD-08, BD-09.",
  },
  {
    categoryNumber: 8,
    key: "finance-event-projection",
    title: "Finance Bidirectional Event / Projection Consistency Tests",
    targetPhaseStep: "Phase 3B Step 3–4",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Blocked on M3 append-only payout event ledger implementation.",
  },
  {
    categoryNumber: 9,
    key: "migration-preservation",
    title: "M1–M5 Schema, Index & Historical Data Preservation Tests",
    targetPhaseStep: "Phase 3B Steps 2–5",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Will execute real M1–M5 DDL using Step 1 SchemaInventory & MigrationFramework.",
  },
  {
    categoryNumber: 10,
    key: "cross-domain-integration",
    title: "End-to-End Cross-Domain Order -> Stage 5 -> Invoice -> Finance Integration Tests",
    targetPhaseStep: "Phase 3B Step 5",
    status: "DEFERRED",
    entryFile: "tests/phase3b-04-domain-contracts-pending.test.ts",
    notes: "Blocked on M1–M5 completion, runtime cutover, and BD-01..BD-09 closure.",
  },
];
