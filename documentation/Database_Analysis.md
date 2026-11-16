# ARCHITECTURAL & DATABASE TECHNICAL ANALYSIS
**Project:** Admin SUN89 / SUNBiroJasa (`d:\Admin\adminsunbirojasa`)  
**Author Role:** Senior System Analyst, Database Architect & Backend Engineer  
**Date:** 2026-11-15

---

## 1. SYSTEM ARCHITECTURE & TECHNOLOGY STACK

| Layer | Technology / Component | Implementation Details |
| :--- | :--- | :--- |
| **Runtime & Language** | Node.js `v22.19.0` + TypeScript | Uses native Node.js `node:sqlite` (`DatabaseSync`) synchronous SQLite driver |
| **Backend Framework** | Express.js | Modular layered architecture: `routes -> middleware -> controllers -> services -> repositories -> SQLite` |
| **Database Engine** | SQLite 3 (Single-File Relational DB) | Configured with `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = 5000` |
| **Frontend Stack** | React 18 + Vite + TypeScript + Tailwind | Uses API-driven state stores (`orderStore`, `financeStore`, `permissionStore`, etc.) with live polling/event sync |
| **Authentication** | Stateless JWT + Stateful `token_version` | `Authorization: Bearer <token>`; verified against live `users.status = 'Aktif'` and `users.token_version` on every request |
| **Authorization (RBAC)** | Hybrid Role + Dynamic Permission Matrix | Role guards (`Admin`, `SVP`, `Finance`, `Messenger`) + granular JSON matrix persisted in `role_permissions` |
| **Operational Safety** | Write-Protection Guard in `schema.ts` | Blocks accidental test/script writes to `server/data/database.sqlite` unless explicitly authorized |

---

## 2. CORE BUSINESS LOGIC & DATA INTEGRITY RULES

### 2.1 Order & Cost Verification Lifecycle (`orders` ↔ `finance_invoices`)
1. **1:1 Order-to-Invoice Invariant:** Migration `2026-11-12-001-invoice-order-unique.ts` enforces a strict `UNIQUE` index `idx_invoices_order_unique` on `finance_invoices(order_no)`. Every order has at most one canonical invoice.
2. **Draft Estimate vs Verified Cost Separation:**
   - Orders created via the calculator or public portal with incomplete/estimated state costs carry `is_cost_verified = 0` and `cost_completeness_status = 'PARTIAL_ESTIMATE'`.
   - Their corresponding invoice in `finance_invoices` is persisted as `DRAFT_ESTIMATE` (never prematurely `VERIFIED`), preventing unverified estimates from polluting verified revenue/receivable reports.
   - Once actual Samsat tax notice figures are confirmed via `POST /api/orders/:orderNo/verify-costs` or `POST /api/orders/:orderNo/finalize-estimate`, `is_cost_verified` becomes `1` (`VERIFIED`) and the invoice transitions to `VERIFIED` / `UNPAID` / `PARTIAL` / `PAID`.
3. **Terminal Cancelled Invoice Protection & Refund Liability:**
   - When an order is cancelled (`Dibatalkan`), if customer payments (`paid_amount > 0`) have already been collected, the system preserves the refund liability rather than silently zeroing out the invoice.
   - Once an invoice reaches `CANCELLED` status with no remaining refund liability, `dbFinanceRepository.saveInvoice()` protects the terminal `CANCELLED` state against accidental overwrite.

### 2.2 Treasury & Double-Entry Cash Domain Separation (`kas_kantor`, `kas_messenger`, `pengeluaran`, `internal_transfers`)
1. **Domain Separation (Migration `2026-11-11-001-kas-domain-separation.ts`):**
   - `kas_kantor` records office bank/cash inflows and outflows.
   - `kas_messenger` records field messenger petty-cash advances (`MASUK`) and field operational settlements (`KELUAR`).
   - `pengeluaran` records categorized operational and order-level expenses.
2. **Internal Transfers (`internal_transfers`):**
   - Moving funds between two `payment_methods` creates an atomic record in `internal_transfers` alongside paired `KELUAR` and `MASUK` ledger rows in `kas_kantor`.
   - Reversing a transfer (`POST /api/finance/internal-transfers/:id/reverse`) creates a compensating transfer linked via the self-referencing foreign key `reversal_ref_id -> internal_transfers.id`.
3. **Messenger Reimbursement Settlement (`messenger_reimbursements`):**
   - Lifecycle: `PENDING` -> `APPROVED` / `REJECTED` -> `PAID` (or `VOID`).
   - Paying a reimbursement (`POST /api/messenger/reimbursements/:id/pay`) atomically links the claim to `pengeluaran_id` and `kas_messenger_id`.

### 2.3 Dynamic RBAC & Session Hydration Architecture
1. **Backend Enforcement:** `server/src/middleware/auth.ts` loads the role's JSON permission tree from `role_permissions` (cached in-memory with automatic invalidation on `PUT /api/permissions/:role` and `POST /api/permissions/reset`).
2. **Frontend Fail-Closed Hydration:** `src/app/App.tsx` calls `hydrateSession(role, { notify: false })`, awaits `permissionStore.initFromApi()` from `GET /api/permissions`, and only notifies store subscribers after authoritative permissions are loaded—preventing premature unauthorized API calls.

---

## 3. STRUCTURAL DATABASE ISSUES & DISCREPANCIES IDENTIFIED

Based on direct inspection of `server/src/database/schema.ts`, migrations, repositories, and live SQLite catalog introspection, the following structural issues were identified:

| Severity | Issue ID | Category | Affected Tables / Columns | Detailed Finding |
| :---: | :---: | :--- | :--- | :--- |
| **MEDIUM** | **DB-01** | **23 Unconstrained Logical Foreign Keys** | `finance_invoices.order_no`, `service_pricing_configs.(service_id, samsat_id)`, `kas_kantor.(order_no, invoice_no)`, `pengeluaran.(order_no, invoice_no)`, `messenger_reimbursements.(order_no, pengeluaran_id, kas_messenger_id)` | While 54 foreign keys are declared in SQL DDL, 23 relational columns omit `REFERENCES ...` clauses in `CREATE TABLE`. Although application services enforce them in transactions, adding formal SQL FK constraints would provide database-level referential guarantees. |
| **MEDIUM** | **DB-02** | **Legacy Duplicate Pricing Tables Still in Schema** | `biaya_layanan` vs `service_pricing_configs`; `harga_dasar_samsat` vs `samsat_pricing` + `samsat_operational_tariffs` | `schema.ts` still creates `biaya_layanan` and `harga_dasar_samsat` and `samsat_offices.id_biaya_layanan` even though all active Pricing APIs (`/api/pricing/*`) use `service_pricing_configs`, `samsat_pricing`, and `samsat_operational_tariffs`. |
| **LOW** | **DB-03** | **Dual Estimation Tables (`aturan_estimasi` vs `estimation_templates`)** | `aturan_estimasi`, `estimation_templates` | Both tables exist in SQLite and are seeded in `seed.ts`, but `estimationController.ts` only queries/mutates `estimation_templates`, leaving `aturan_estimasi` unused by the REST API. |
| **LOW** | **DB-04** | **Mixed Primary Key Conventions (INTEGER vs TEXT)** | 8 `INTEGER AUTOINCREMENT` tables vs 34 `TEXT` PK tables; `audit_logs.user_id` (`TEXT`) vs `users.id` (`INTEGER`) | `users.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, whereas `audit_logs.user_id`, `security_audit_logs.user_id`, `documents.uploaded_by_id`, and `idempotency_keys.user_id` are stored as `TEXT`. Meanwhile `document_tickets.user_id` and `order_status_history.changed_by_id` are `INTEGER`. |
| **LOW** | **DB-05** | **Dual Messenger Columns on `orders`** | `orders.messenger_id` and `orders.assigned_messenger_id` | Both columns exist on `orders` with `REFERENCES messengers(id)`. Repositories keep them synchronized, but having two columns for the same relationship adds cognitive overhead. |
| **LOW** | **DB-06** | **Dormant Supporting Tables Without Dedicated Endpoints** | `customer_accounts`, `master_proses_samsat`, `order_documents` | These 3 tables are created and indexed at boot but lack dedicated controller/service endpoints. |

---

## 4. ACTIONABLE ARCHITECTURAL RECOMMENDATIONS

1. **Formalize Logical Foreign Keys in Next Migration:**
   - Add explicit `FOREIGN KEY (order_no) REFERENCES orders(order_no) ON DELETE RESTRICT` on `finance_invoices`, and explicit FKs on `service_pricing_configs(service_id, samsat_id)` and `messenger_reimbursements(pengeluaran_id, kas_messenger_id)`.
2. **Deprecate & Sunset Legacy Tables (`biaya_layanan`, `harga_dasar_samsat`):**
   - Mark `biaya_layanan` and `harga_dasar_samsat` as read-only archive views or remove them in a future major schema cleanup migration once no legacy tests reference them.
3. **Standardize User ID Foreign Key Types:**
   - Standardize all user reference columns (`user_id`, `uploaded_by_id`, `changed_by_id`) to a single canonical type or consistently join via `CAST(user_id AS INTEGER)` / `employee_id`.
4. **Complete Missing CRUD Endpoints:**
   - Implement `POST /api/services`, `GET /api/security-audit-logs`, and dedicated read/manage endpoints for `customers` and `vehicles` as listed in [API_Endpoint_List.md](file:///d:/Admin/adminsunbirojasa/documentation/API_Endpoint_List.md).