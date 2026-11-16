# SUN89 — PHASE 3B FOUNDATION BASELINE & IMPLEMENTATION CONTRACTS

**Phase:** Phase 3B Step 1 (Foundation & Test Harness)  
**Date:** 2026-11-16  
**Prerequisite Architecture Baseline:** Phase 3A.7 (`Verdict B — BASELINE READY WITH RESTRICTIONS`)  
**Scope Boundary:** Foundation infrastructure, isolated DB harness, deterministic migration framework, schema inventory/comparator, permanent 10-category test layout, and contract/blocker documentation only. Zero M1–M5 domain DDL, zero runtime cutover, zero operational DB mutations.

---

## 1. Verified Repository Architecture (`Step A` Evidence Baseline)

| Area | Actual Implementation | Relevant Files | Status |
|---|---|---|---|
| **Package & TypeScript Configuration** | Unified root ESM package (`"type": "module"`) managing both FE and BE (`typescript ~5.7.3`, `tsx`, Node `node:sqlite`, `node:test`). No separate `server/package.json` exists. Backend typecheck uses `server/tsconfig.json` (`target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`, `types: ["node"]`, `include: ["src/**/*"]`). | `package.json`, `tsconfig.json`, `server/tsconfig.json`, `eslint.config.js` | `VERIFIED` |
| **Database Connection** | `node:sqlite` `DatabaseSync` managed via lazy singleton `getDb()`, read-only accessor `getReadOnlyDb()`, and explicit startup initializer `initDatabase()`. Configures `PRAGMA journal_mode = WAL;`, `PRAGMA foreign_keys = ON;`, and `PRAGMA busy_timeout = 5000;`. Includes operational path guard blocking test contexts and unapproved CLI writes. | `server/src/database/db.ts`, `server/src/config/env.ts`, `server/src/server.ts`, `server/src/app.ts` | `VERIFIED` |
| **Migration Mechanism** | Legacy migrations were split across monolithic `initializeSchema()` / `applySchemaMigrations()` table-init helpers plus individual manual/ad-hoc files (`001_add_nopol_clean_functional_index.sql`, `2026-11-11-001`, `2026-11-12-001`, `2026-11-14-001`, `2026-11-15-001`). Two RBAC/role migrations created minimal `schema_migrations(id, applied_at[, description])` without unified ordering, checksums, failure states, or FK-rebuild TX boundaries. **Extended in Step 1** with `migrationFramework.ts`. | `server/src/database/schema.ts`, `server/src/database/migrations/*.ts`, `server/src/database/migrations/migrationFramework.ts` | `VERIFIED` (Extended compatibly) |
| **Transaction Mechanism** | Synchronously enforced `runInTransaction(fn, customDb?)` using `BEGIN IMMEDIATE;`, per-connection `WeakMap` depth tracking (`getTransactionDepth`), `SAVEPOINT` nesting, fail-closed async/Promise rejection, and connection quarantine (`WeakSet`) on rollback failure. | `server/src/database/db.ts` | `VERIFIED` |
| **Test Database Isolation** | Global runner `scripts/run-test-isolated.cjs` sweeps stale `os.tmpdir()` `sun89_test_*` dirs, spawns each top-level `tests/*.test.ts` with a temp sandbox DB (`DB_PATH`, `UPLOAD_DIR`, `BACKUP_DIR` in `os.tmpdir()`), and auto-applies Phase 4B test columns. **Extended in Step 1** with `isolatedDbHarness.ts` for explicit per-test temp/memory handles without global operational copy dependency. | `scripts/run-test-isolated.cjs`, `server/src/database/testing/isolatedDbHarness.ts` | `VERIFIED` (Extended compatibly) |
| **Backend Test Framework** | Native Node.js `node:test` + `node:assert/strict` executed via `npx --prefer-offline tsx --test <file>`. Note: `scripts/run-test-isolated.cjs` `resolveTestFiles()` only scans top-level `tests/*.test.ts` (non-recursive even when invoked with `tests/**/*.test.ts`). | `package.json`, `scripts/run-test-isolated.cjs`, `tests/*.test.ts` | `VERIFIED` |
| **Schema Inventory** | `schema.ts` creates baseline tables (`services`, `employees`, `users`, `customers`, `customer_accounts`, `vehicles`, `orders`, `finance_invoices`, `invoice_payments`, `kas_kantor`, `kas_messenger`, `samsat_pricing`, `samsat_operational_tariffs`, etc.). **Added in Step 1:** `schemaInventory.ts` inspecting live SQLite catalogs (`sqlite_master`, `table_xinfo`, `foreign_key_list`, `index_list`, `index_xinfo`, triggers, views, PRAGMAs) and semantic diffing. | `server/src/database/schema.ts`, `server/src/database/schemaInventory.ts` | `VERIFIED` |
| **Existing Migration Tests** | Ad-hoc coverage inside `tests/database-safety-backfill-idempotency.test.ts`, `tests/samsat-tariffs-schema.test.ts`, `tests/phase4b-batch2b-transaction-infrastructure.test.ts`, `tests/phase4b-batch2c-invoice-ssot-rbac.test.ts`, and `tests/batch1-identity-rbac-remediation.test.ts`. **Added in Step 1:** dedicated permanent suites `tests/phase3b-01` through `tests/phase3b-04`. | `tests/phase3b-01..04*.test.ts`, legacy `tests/*.test.ts` | `VERIFIED` |
| **Layered Domain Separation** | Backend routes delegate cleanly through Controllers -> Services -> Repositories, though Phase 3A.7 verified `10` active legacy finance/order mutation paths that still mutate invoice/refund fields outside a unified reducer boundary until Phase 3B cutover. | `server/src/controllers/`, `server/src/services/`, `server/src/repositories/` | `GAP FOUND` (Cutover deferred) |

---

## 2. Database & Migration Architecture (`Step C`)

- **Backward-Compatible Registry Table (`schema_migrations`):**  
  `ensureSchemaMigrationsTable()` in `server/src/database/migrations/migrationFramework.ts` preserves existing `schema_migrations(id, applied_at[, description])` rows created by `2026-11-14-001` and `2026-11-15-001`, additively appending missing framework columns (`version_order`, `name`, `checksum`, `status`, `requires_fk_disabled`, `is_reversible`, `execution_ms`, `error_message`, `rolled_back_at`, `contract_json`) and index `idx_schema_migrations_status_order`.
- **Mandatory Migration Contract Fields (`MigrationDefinition`):**  
  Every migration requires `id` (validated ordered format), strictly unique positive `order`, `name`, `purpose`, non-empty `preconditions[]`, `schemaChanges[]`, `postconditions[]`, `rollbackStrategy` (`{ reversible: true, summary }` with `down`, or `{ reversible: false, reason }`), `verificationTests[]`, and `requiresFkDisabled`.
- **Deterministic Ordering & Idempotency:**  
  `sortAndValidateMigrations()` validates contract completeness, rejects duplicate IDs/orders fail-closed, sorts deterministically by `(order ASC, id ASC)`, computes canonical SHA-256 contract checksums, skips already-`APPLIED` entries cleanly, and rejects post-apply checksum drift (`MIGRATION_CHECKSUM_MISMATCH`).
- **Transaction & SQLite FK Boundary Protocol:**
  - `requiresFkDisabled === false`: Verifies `PRAGMA foreign_keys = 1`, runs `checkPreconditions`, executes `up` + `checkPostconditions` + differential `PRAGMA foreign_key_check` + `schema_migrations` update inside `runInTransaction` (`BEGIN IMMEDIATE`).
  - `requiresFkDisabled === true` (e.g., Phase 3B `M2` table rebuild): Executes `checkPreconditions` with `foreign_keys = 1`, captures baseline `PRAGMA foreign_key_check`, disables `PRAGMA foreign_keys = OFF` strictly **outside** the transaction, runs DDL + postconditions + differential `PRAGMA foreign_key_check` + record update atomically inside `BEGIN IMMEDIATE`, commits, and restores `PRAGMA foreign_keys = ON` in `finally` before asserting restoration (`foreign_keys === 1`). Any newly introduced FK violation rolls back atomically (`MIGRATION_FK_INTEGRITY_FAILED`).
- **Failure State & Partial-Application Protection:**  
  Failed runs roll back transactional DDL atomically, persist `status = 'FAILED'` with `error_message` on `schema_migrations`, and block all subsequent migrations (`MIGRATION_BLOCKED_BY_FAILED_STATE`) until cleared via `clearFailedMigrationRecord()` or explicitly retried (`retryFailedIds`).

---

## 3. Isolated Database Test Harness Design (`Step B`)

Implemented in `server/src/database/testing/isolatedDbHarness.ts`:
- **Three Explicit Creation Paths:**
  - `createIsolatedTempDb(options?)`: Creates a unique sandbox folder in `os.tmpdir()` via `fs.mkdtempSync`, configures `PRAGMA busy_timeout` (default `5000`), `PRAGMA journal_mode = WAL`, and `PRAGMA foreign_keys = ON`, verifying pragma states immediately.
  - `openIsolatedDbAtPath(explicitDbPath, options?)`: Requires an explicit non-empty file path validated against operational path guards. Zero default fallback to `CONFIG.DB_PATH`.
  - `createIsolatedMemoryDb(options?)`: Opens private `:memory:` DB with `PRAGMA foreign_keys = ON`. Documents and verifies that SQLite `:memory:` DBs operate with `journal_mode = "memory"` (WAL does not apply to `:memory:`).
- **Multi-Connection Lock Testing:**  
  `handle.openPeerConnection()` opens a tracked second `DatabaseSync` connection against file-backed temp DBs to deterministically test writer contention (`SQLITE_BUSY` / `"database is locked"`), then ensures all peer connections close prior to directory removal.
- **Failure Diagnostics & Windows-Safe Teardown:**  
  `handle.captureDiagnostics(reason, persistToDir)` records active pragmas, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, table list, and `schema_migrations` rows. `handle.cleanup({ preserveOnFailure: true })` preserves artifacts and writes JSON diagnostics before closing; standard `cleanup()` deletes ONLY files/dirs owned by that handle with bounded `EBUSY`/`EPERM` backoff retry.

---

## 4. Schema Inventory & Semantic Diff Mechanism (`Step D`)

Implemented in `server/src/database/schemaInventory.ts`:
- `captureSchemaInventory(db)` captures PRAGMA configuration (`sqliteVersion`, `foreignKeys`, `journalMode`, `busyTimeout`, `recursiveTriggers`, `userVersion`, `encoding`), ordered tables with columns via `PRAGMA table_xinfo` (including nullability, defaults, types, PK ordinals, hidden/generated flags), composite `primaryKey` column lists, normalized `foreignKeys` signatures (`ON DELETE`/`ON UPDATE`/`MATCH`), named/partial/expression `indexes`, `uniqueConstraints`, `triggers`, and `views`.
- `compareSchemas(expected, actual, options?)` detects structural mismatches: missing/unexpected tables & columns, column type/nullability/default/PK ordinal mismatches, primary key definition mismatches, missing/unexpected foreign keys, missing/unexpected/mismatched indexes & unique constraints, missing/unexpected/mismatched triggers & views, plus optional PRAGMA checks. Supports additive-migration preservation flags (`allowUnexpectedTables`, `allowUnexpectedColumns`).

---

## 5. Permanent Regression Test Structure (`Step E`) & Execution Commands

Mapped in `tests/phase3b/testRegistry.ts`:
- **Implemented (Executable Now):**
  - Category 1 (Database Infrastructure): `tests/phase3b-01-db-infrastructure.test.ts`
  - Category 2 (Migration Framework): `tests/phase3b-02-migration-framework.test.ts`
  - Step D (Schema Inventory & Diff): `tests/phase3b-03-schema-inventory.test.ts`
- **Deferred (Explicit Skipped Contracts — Zero Fabricated Passes):**
  - Categories 3–10 (Estimation Domain, Configuration Versioning, Snapshot Immutability, Actual-Cost Domain, Finance Reducer, Event/Projection Consistency, M1–M5 Migration Preservation, Cross-Domain Integration): `tests/phase3b-04-domain-contracts-pending.test.ts`

### Approved Test & Check Commands

```powershell
# Backend TypeScript check
npm run typecheck:server

# Targeted ESLint on Phase 3B Step 1 modules & tests
npx eslint server/src/database/testing/isolatedDbHarness.ts server/src/database/schemaInventory.ts server/src/database/migrations/migrationFramework.ts server/src/database/migrations/phase3bContracts.ts tests/phase3b/testRegistry.ts tests/phase3b-01-db-infrastructure.test.ts tests/phase3b-02-migration-framework.test.ts tests/phase3b-03-schema-inventory.test.ts tests/phase3b-04-domain-contracts-pending.test.ts

# Run Phase 3B foundation regression suites inside isolated temp runner
node scripts/run-test-isolated.cjs tests/phase3b-01-db-infrastructure.test.ts tests/phase3b-02-migration-framework.test.ts tests/phase3b-03-schema-inventory.test.ts tests/phase3b-04-domain-contracts-pending.test.ts
```

*Important Note:* `npm test` runs `node scripts/run-test-isolated.cjs tests/**/*.test.ts`, whose `resolveTestFiles()` implementation reads top-level `tests/*.test.ts` non-recursively. Because `tests/phase3b-01..04*.test.ts` sit directly in `tests/`, they are automatically picked up by both targeted runs and full `npm test`.

---

## 6. Database Safety Guarantees

1. `assertSafeTestDbPath()` and `assertOpenDatabaseIsNotOperational()` fail closed (`[ISOLATED_DB_SAFETY_GUARD]`) on empty/whitespace paths, `file:` URIs, `server/data/database.sqlite` (normalized Windows case-insensitively and symlink-resolved via `realpathSync`), `-wal`/`-shm`/`-journal` siblings, `.bak*` operational backups, ANY file inside `server/data/` or `server/backups/`, and `CONFIG.DB_PATH` whenever pointing at operational storage.
2. `runMigrations()` and `rollbackMigration()` verify every open attached SQLite file via `PRAGMA database_list` against `assertOpenDatabaseIsNotOperational()` unless `allowOperationalWrite: true` is explicitly passed by an authorized operator runner.
3. No global test setup hook mutates or redirects running development servers (`npm run dev:all`).

---

## 7. Known Limitations

1. Operational database rows in `server/data/database.sqlite` were NOT opened or modified in Step 1; actual production data cleanliness (`PRE-FLIGHT #1–#11`) remains `UNVERIFIED` / `BLOCKED` pending operator offline read-only audit.
2. Repo-wide `npm run lint` (`eslint .`) reports pre-existing style warnings across untouched repository files (`@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unused-vars`, `prefer-const`); targeted ESLint on Step 1 deliverables enforces zero errors/warnings.
3. SQLite DDL statements are transactional inside `BEGIN IMMEDIATE`, so transactional rollbacks protect single-migration failure atomicity; however, any multi-migration operator script executed against a persistent DB after commit requires the offline backup/restore protocol (`PF-11`), especially for `M2` (`requiresFkDisabled: true`).
4. SQLite `Direction 2` application invariants (`RefundPayoutService` 9-step TX boundary) cannot be enforced by SQLite triggers alone and remain deferred to Services implementation (`Steps 3–4`).

---

## 8. Deferred Workstreams & Remaining Phase 3A.7 Findings

### Deferred Workstreams
- **M1–M5 DDL Execution & Schema Implementation** (contract descriptors staged in `server/src/database/migrations/phase3bContracts.ts`, zero DDL executed in Step 1).
- Authoritative Backend Estimation Engine (R4/R2 + Mutasi consolidation).
- Immutable Pricing Configuration Versioning & Publish Workflow.
- Order Estimation Snapshot Backfill & Immutability Triggers.
- Stage 5 Actual-Cost Verification Separation & Append-Only Event Ledger.
- Finance Reducer Model A (`FULFILLED`), Payout Event/Projection Service (`RefundPayoutService`), and Legacy Mutation Path Retirement.
- Public API Estimation Endpoints & Runtime Cutover.

### Remaining Phase 3A.7 Findings (`Still Open / Unresolved`)
- **`FND-3A7-01` (P0):** `FULFILLED` semantic Model A contract is locked at design level (`disbursed == approved && cancelled == 0`), **not yet implemented** in TypeScript reducer or SQLite triggers (`DEFERRED` to Step 3–4).
- **`FND-3A7-02` (P0):** `10` active legacy finance/order mutation paths (`dbFinanceRepository`, `orderService`, `orderCorrectionService`, etc.) still exist untouched in runtime code (`GAP FOUND`; deferred until Services/Cutover steps).
- **`FND-3A7-03` (P2):** Exact 27-entity reconciliation inventory (`17` persistent baseline tables mapped + `10` new V2 tables) will be enforced during M1–M5 migration preservation verification (`DEFERRED` to Steps 2–5).
- **Risk Register (`RSK-01..RSK-05`):** All runtime risks (`RSK-01` legacy bypasses, `RSK-02` M2 34/25 column & 16 index preservation, `RSK-03` unverified operational DB anomalies, `RSK-04` WAL contention & `/mobile/*` runtime compatibility, `RSK-05` partial void UI badge confirmation) remain open/tracked.

---

## 9. Dependencies for `M1–M5` & Unresolved Business Decisions (`BD-01`..`BD-09`)

All 9 Business Decisions remain strictly **`UNRESOLVED` / `[OPEN]`** and MUST NOT be assumed silently by engineers:

| ID | Decision Area | Blocked M1–M5 / Feature Scope | Status |
|---|---|---|---|
| **BD-01** | ACC ID R4 vs R2 (`totalEstimasi` calculation policy) | M1 estimation rules & Category 3 parity | `UNRESOLVED` |
| **BD-02** | Mutasi package Rp1 juta / Rp1.5 juta vs 29 detailed items | M1 estimation rules & Mutasi pricing | `UNRESOLVED` |
| **BD-03** | Tarif 29 items R2 vs R4 differentiation | M1 tariff schema & calculation engine | `UNRESOLVED` |
| **BD-04** | Pricing config behavior for in-progress orders | M4 backfill & Category 5 immutability | `UNRESOLVED` |
| **BD-05** | Scheduled config publishing (`effective_from`) | M1 config versioning & publish workflow | `UNRESOLVED` |
| **BD-06** | Stage 5 cost overrun approval threshold | M3 actual-cost escalation & Category 6 | `UNRESOLVED` |
| **BD-07** | Mandatory components per service | M1 estimation validation & Category 3 | `UNRESOLVED` |
| **BD-08** | Order cancellation forfeiture / deduction rules | M2/M3 settlement reducer & Category 7 | `UNRESOLVED` |
| **BD-09** | Cash-capped vs accrual revenue recognition semantics | M2/M3 finance projections & Category 7 | `UNRESOLVED` |

---

## 10. Pre-Flight & Migration Implementation Checklist (For Phase 3B Steps 2–5)

### Pre-Flight 11-Step Hard Blocker (`PF-01`..`PF-11`) — Offline Read-Only Copy Before Any Persistent Migration
- [ ] `PF-01`: `PRAGMA integrity_check; PRAGMA quick_check;` returns `ok` on offline copy
- [ ] `PF-02`: `PRAGMA foreign_keys=ON; PRAGMA foreign_key_check;` returns 0 rows
- [ ] `PF-03`: Live baseline inventory (`schemaInventory.ts`) matches expected 34/25 columns & 16 indexes
- [ ] `PF-04`: Zero orphan references in `finance_invoices`, `invoice_payments`, `service_pricing_configs`
- [ ] `PF-05`: Zero duplicate/null/malformed `finance_invoices.order_no` (`UNIQUE` precondition)
- [ ] `PF-06`: Zero unresolved fractional `REAL` Rupiah values before `INTEGER` cast
- [ ] `PF-07`: Historical `invoice_payments` audit complete (`nominal <= 0` count = 0)
- [ ] `PF-08`: Zero invalid `json_valid(data_json)` rows in `finance_invoices`
- [ ] `PF-09`: Legacy `'ALL'` payout records & non-standard `refund_status` cataloged
- [ ] `PF-10`: Finance ledger baseline (`kas_kantor` vs `invoice_payments` & `dibayar`) reconciled
- [ ] `PF-11`: Offline Backup -> SHA-256 -> Isolated `M1–M5` Dry-Run -> Failure Simulation -> Restore Verify signed off by DB Eng + Finance Lead + Owner

### Step-by-Step Next Implementation Sequence
- [ ] **Step 2 (BD-01..BD-03, BD-05, BD-07 sign-off -> M1):** Implement `M1` estimation & config versioning tables using `MigrationDefinition`, verify preservation via `compareSchemas(..., { allowUnexpectedTables })`, activate Category 3 & 4 tests.
- [ ] **Step 3 (BD-06, BD-08, BD-09 sign-off -> M2 & M3):** Implement `M2` (`requiresFkDisabled: true`, asserting all 34 `finance_invoices` cols, 25 `invoice_payments` cols, and 16 indexes preserved) and `M3` (actual-cost + Model A payout event ledger), activate Category 6, 7, 8, 9 tests.
- [ ] **Step 4 (BD-04 sign-off -> M4):** Implement deterministic historical snapshot & settlement backfill + Read Adapter for legacy orders.
- [ ] **Step 5 (M5 & Runtime Cutover):** Retire all 10 legacy finance/order mutation bypasses (`FND-3A7-02`), install immutability/FSM SQLite triggers (`M5`), run full Category 10 & `/mobile/*` E2E parity suites before any persistent DB maintenance window.
