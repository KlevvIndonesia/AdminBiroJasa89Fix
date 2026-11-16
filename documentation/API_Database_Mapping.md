# API TO DATABASE MAPPING & ENTITY DEPENDENCY MATRIX
**Project:** Admin SUN89 / SUNBiroJasa (`d:\Admin\adminsunbirojasa`)  
**Scope:** All 148 Canonical API Endpoints mapped to all 42 SQLite Database Tables.

---

## 1. ENDPOINT-TO-TABLE MAPPING TABLE

| API Endpoint | Method | Main Table | Related Tables | Operation |
| :--- | :---: | :--- | :--- | :--- |
| `/api/health` | `GET` | `schema_migrations` | `users` | **READ (SELECT 1 / PRAGMA check)** |
| `/api/health/live` | `GET` | `NONE (Process Memory)` | `-` | **NONE** |
| `/api/health/ready` | `GET` | `schema_migrations` | `-` | **READ** |
| `/api/auth/login` | `POST` | `users` | `employees, messengers, role_permissions, audit_logs, security_audit_logs` | **READ, UPDATE (users.last_login, token_version), CREATE (audit_logs / security_audit_logs)** |
| `/api/auth/me` | `GET` | `users` | `employees, messengers` | **READ** |
| `/api/auth/change-password` | `POST` | `users` | `audit_logs, security_audit_logs` | **READ, UPDATE (users.password_hash, users.token_version, users.updated_at), CREATE (audit_logs)** |
| `/api/orders` | `GET` | `orders` | `customers, vehicles, services, samsat_offices, messengers, finance_invoices, order_timeline_processes, messenger_tasks` | **READ** |
| `/api/orders/stats` | `GET` | `orders` | `finance_invoices` | **READ** |
| `/api/orders/archived` | `GET` | `orders` | `customers, vehicles, services, samsat_offices` | **READ** |
| `/api/orders/archive` | `GET` | `orders` | `customers, vehicles, services, samsat_offices` | **READ** |
| `/api/orders/archive/clear-all` | `DELETE` | `orders` | `order_status_history, order_timeline_processes, order_documents, messenger_tasks, finance_invoices, audit_logs` | **DELETE, CREATE (audit_logs)** |
| `/api/orders/archived/clear-all` | `DELETE` | `orders` | `order_status_history, order_timeline_processes, order_documents, messenger_tasks, finance_invoices, audit_logs` | **DELETE, CREATE (audit_logs)** |
| `/api/orders/vehicle-lookup/:nopol` | `GET` | `vehicles` | `customers, orders` | **READ** |
| `/api/orders/customers/lookup` | `GET` | `customers` | `vehicles` | **READ** |
| `/api/orders/check-duplicate` | `POST` | `orders` | `vehicles, services` | **READ** |
| `/api/orders` | `POST` | `orders` | `customers, vehicles, finance_invoices, invoice_payments, kas_kantor, order_status_history, order_timeline_processes, messenger_tasks, audit_logs, idempotency_keys` | **CREATE, UPDATE (customers, vehicles)** |
| `/api/orders/:orderNo` | `GET` | `orders` | `customers, vehicles, services, samsat_offices, messengers, finance_invoices, invoice_payments, order_status_history, order_timeline_processes, messenger_tasks, documents` | **READ** |
| `/api/orders/:orderNo/history` | `GET` | `order_status_history` | `orders, users` | **READ** |
| `/api/orders/:orderNo` | `PUT` | `orders` | `customers, vehicles, finance_invoices, order_status_history, laba_rugi_snapshots, audit_logs` | **UPDATE, CREATE (order_status_history, audit_logs)** |
| `/api/orders/:orderNo/status` | `PATCH` | `orders` | `order_status_history, finance_invoices, laba_rugi_snapshots, notification_logs, audit_logs` | **UPDATE (orders, finance_invoices), CREATE (order_status_history, laba_rugi_snapshots, audit_logs)** |
| `/api/orders/:orderNo/payment` | `PATCH` | `orders` | `finance_invoices, invoice_payments, kas_kantor, payment_methods, audit_logs` | **UPDATE (orders, finance_invoices), CREATE (invoice_payments, kas_kantor, audit_logs)** |
| `/api/orders/:orderNo/assign-messenger` | `PATCH` | `orders` | `messengers, employees, messenger_tasks, order_status_history, audit_logs` | **UPDATE (orders), CREATE/UPDATE (messenger_tasks), CREATE (audit_logs)** |
| `/api/orders/:orderNo/tasks/:taskType/status` | `POST` | `messenger_tasks` | `orders, order_timeline_processes, messengers, audit_logs` | **UPDATE (messenger_tasks, order_timeline_processes, orders), CREATE (audit_logs)** |
| `/api/orders/:orderNo/tasks/:taskType/status` | `PATCH` | `messenger_tasks` | `orders, order_timeline_processes, messengers, audit_logs` | **UPDATE, CREATE (audit_logs)** |
| `/api/orders/:orderNo/costs` | `PATCH` | `orders` | `finance_invoices, laba_rugi_snapshots, audit_logs` | **UPDATE (orders, finance_invoices, laba_rugi_snapshots), CREATE (audit_logs)** |
| `/api/orders/:orderNo/verify-costs` | `POST` | `orders` | `finance_invoices, order_status_history, audit_logs` | **UPDATE (orders, finance_invoices), CREATE (order_status_history, audit_logs)** |
| `/api/orders/:orderNo/finalize-estimate` | `POST` | `orders` | `finance_invoices, order_status_history, audit_logs` | **UPDATE (orders, finance_invoices), CREATE (order_status_history, audit_logs)** |
| `/api/orders/:orderNo/cashback` | `PATCH` | `orders` | `finance_invoices, laba_rugi_snapshots, audit_logs` | **UPDATE (orders, finance_invoices, laba_rugi_snapshots), CREATE (audit_logs)** |
| `/api/orders/:orderNo/archive` | `POST` | `orders` | `audit_logs` | **UPDATE (orders), CREATE (audit_logs)** |
| `/api/orders/:orderNo/restore` | `POST` | `orders` | `audit_logs` | **UPDATE (orders), CREATE (audit_logs)** |
| `/api/orders/:orderNo/unarchive` | `POST` | `orders` | `audit_logs` | **UPDATE (orders), CREATE (audit_logs)** |
| `/api/orders/bulk-archive` | `POST` | `orders` | `audit_logs` | **UPDATE (orders), CREATE (audit_logs)** |
| `/api/orders/bulk-status` | `POST` | `orders` | `order_status_history, finance_invoices, audit_logs` | **UPDATE (orders, finance_invoices), CREATE (order_status_history, audit_logs)** |
| `/api/orders/:orderNo/corrections` | `POST` | `order_corrections` | `orders, audit_logs` | **CREATE (order_corrections, audit_logs)** |
| `/api/orders/:orderNo/corrections` | `GET` | `order_corrections` | `orders` | **READ** |
| `/api/orders/:orderNo/cancel-with-refund` | `POST` | `orders` | `finance_invoices, invoice_payments, pengeluaran, kas_kantor, order_status_history, audit_logs` | **UPDATE (orders, finance_invoices), CREATE (pengeluaran, kas_kantor, order_status_history, audit_logs)** |
| `/api/orders/:orderNo` | `DELETE` | `orders` | `finance_invoices, order_status_history, order_timeline_processes, order_documents, messenger_tasks, audit_logs` | **DELETE, CREATE (audit_logs)** |
| `/api/order-corrections` | `GET` | `order_corrections` | `orders, customers, vehicles` | **READ** |
| `/api/order-corrections/:id` | `GET` | `order_corrections` | `orders` | **READ** |
| `/api/order-corrections/:id/review` | `POST` | `order_corrections` | `orders, finance_invoices, order_status_history, audit_logs` | **UPDATE (order_corrections, orders, finance_invoices), CREATE (order_status_history, audit_logs)** |
| `/api/finance/summary` | `GET` | `finance_invoices` | `orders, invoice_payments, kas_kantor, kas_messenger, pengeluaran, messenger_reimbursements, laba_rugi_snapshots` | **READ** |
| `/api/finance/laba-rugi` | `GET` | `laba_rugi_snapshots` | `orders, finance_invoices, pengeluaran, messenger_reimbursements, kas_kantor` | **READ** |
| `/api/finance/pnl` | `GET` | `laba_rugi_snapshots` | `orders, finance_invoices, pengeluaran, messenger_reimbursements` | **READ** |
| `/api/finance/invoices` | `GET` | `finance_invoices` | `orders, customers, vehicles, services, samsat_offices, invoice_payments, payment_methods` | **READ** |
| `/api/finance/invoices/:id` | `GET` | `finance_invoices` | `orders, customers, vehicles, invoice_payments, documents, payment_methods` | **READ** |
| `/api/finance/invoices` | `POST` | `finance_invoices` | `orders, customers, payment_methods, audit_logs, idempotency_keys` | **CREATE / UPDATE (finance_invoices), UPDATE (orders), CREATE (audit_logs)** |
| `/api/finance/invoices/:id` | `PUT` | `finance_invoices` | `orders, laba_rugi_snapshots, audit_logs` | **UPDATE (finance_invoices, orders, laba_rugi_snapshots), CREATE (audit_logs)** |
| `/api/finance/invoices/:id/payments` | `POST` | `invoice_payments` | `finance_invoices, orders, kas_kantor, kas_messenger, payment_methods, documents, laba_rugi_snapshots, audit_logs, idempotency_keys` | **CREATE (invoice_payments, kas_kantor/kas_messenger, audit_logs), UPDATE (finance_invoices, orders, laba_rugi_snapshots)** |
| `/api/finance/invoices/:id/payments/:paymentId/verify` | `POST` | `invoice_payments` | `finance_invoices, orders, kas_kantor, kas_messenger, laba_rugi_snapshots, audit_logs` | **UPDATE (invoice_payments, finance_invoices, orders), CREATE (kas_kantor/kas_messenger, audit_logs)** |
| `/api/finance/invoices/:id/verify-payment` | `POST` | `invoice_payments` | `finance_invoices, orders, kas_kantor, audit_logs` | **UPDATE (invoice_payments, finance_invoices, orders), CREATE (kas_kantor, audit_logs)** |
| `/api/finance/invoices/:id/cashback/pay` | `POST` | `finance_invoices` | `orders, pengeluaran, kas_kantor, documents, payment_methods, laba_rugi_snapshots, audit_logs` | **UPDATE (finance_invoices, orders, laba_rugi_snapshots), CREATE (pengeluaran, kas_kantor, audit_logs)** |
| `/api/finance/invoices/:id/refund` | `POST` | `finance_invoices` | `orders, invoice_payments, pengeluaran, kas_kantor, payment_methods, audit_logs` | **UPDATE (finance_invoices, orders), CREATE (pengeluaran, kas_kantor, audit_logs)** |
| `/api/finance/kas-kantor` | `GET` | `kas_kantor` | `payment_methods, documents, orders, finance_invoices` | **READ** |
| `/api/finance/kas-kantor` | `POST` | `kas_kantor` | `payment_methods, pengeluaran, documents, audit_logs, idempotency_keys` | **CREATE (kas_kantor, pengeluaran if KELUAR, audit_logs)** |
| `/api/finance/kas-kantor/:id` | `PUT` | `kas_kantor` | `payment_methods, documents, audit_logs` | **UPDATE (kas_kantor), CREATE (audit_logs)** |
| `/api/finance/kas-kantor/:id` | `DELETE` | `kas_kantor` | `invoice_payments, audit_logs` | **DELETE (kas_kantor), CREATE (audit_logs)** |
| `/api/finance/kas-messenger` | `GET` | `kas_messenger` | `messengers, employees, documents, orders, messenger_reimbursements` | **READ** |
| `/api/finance/kas-messenger` | `POST` | `kas_messenger` | `messengers, kas_kantor, pengeluaran, documents, audit_logs, idempotency_keys` | **CREATE (kas_messenger, kas_kantor if funded from office, audit_logs)** |
| `/api/finance/kas-messenger/:id` | `PUT` | `kas_messenger` | `messengers, documents, audit_logs` | **UPDATE (kas_messenger), CREATE (audit_logs)** |
| `/api/finance/kas-messenger/:id` | `DELETE` | `kas_messenger` | `messenger_reimbursements, invoice_payments, audit_logs` | **DELETE (kas_messenger), CREATE (audit_logs)** |
| `/api/finance/pengeluaran` | `GET` | `pengeluaran` | `payment_methods, messengers, documents, orders, finance_invoices` | **READ** |
| `/api/finance/pengeluaran` | `POST` | `pengeluaran` | `kas_kantor, payment_methods, messengers, documents, audit_logs, idempotency_keys` | **CREATE (pengeluaran, kas_kantor, audit_logs)** |
| `/api/finance/pengeluaran/:id` | `PUT` | `pengeluaran` | `kas_kantor, payment_methods, documents, audit_logs` | **UPDATE (pengeluaran, kas_kantor), CREATE (audit_logs)** |
| `/api/finance/pengeluaran/:id` | `DELETE` | `pengeluaran` | `kas_kantor, messenger_reimbursements, invoice_payments, audit_logs` | **DELETE (pengeluaran), CREATE (audit_logs)** |
| `/api/finance/internal-transfers` | `GET` | `internal_transfers` | `payment_methods, documents, kas_kantor` | **READ** |
| `/api/finance/internal-transfers` | `POST` | `internal_transfers` | `kas_kantor, pengeluaran, payment_methods, documents, audit_logs, idempotency_keys` | **CREATE (internal_transfers, kas_kantor [2 rows], pengeluaran [if adminFee > 0], audit_logs)** |
| `/api/finance/internal-transfers/:id/reverse` | `POST` | `internal_transfers` | `kas_kantor, payment_methods, audit_logs` | **UPDATE (internal_transfers), CREATE (internal_transfers [reversal], kas_kantor, audit_logs)** |
| `/api/messenger/my-tasks` | `GET` | `messenger_tasks` | `orders, customers, vehicles, services, samsat_offices, messengers` | **READ** |
| `/api/messenger/messengers` | `GET` | `messengers` | `employees, users, messenger_tasks, orders` | **READ** |
| `/api/messenger/history` | `GET` | `messenger_tasks` | `orders, vehicles, samsat_offices, messengers` | **READ** |
| `/api/messenger/tasks/:orderNo` | `GET` | `messenger_tasks` | `orders, order_timeline_processes, messengers` | **READ** |
| `/api/messenger/reimbursements` | `GET` | `messenger_reimbursements` | `messengers, employees, orders, documents, pengeluaran, kas_messenger` | **READ** |
| `/api/messenger/reimbursements` | `POST` | `messenger_reimbursements` | `messengers, employees, orders, documents, audit_logs, idempotency_keys` | **CREATE (messenger_reimbursements, audit_logs)** |
| `/api/messenger/reimbursements/:id/review` | `PATCH` | `messenger_reimbursements` | `messengers, audit_logs` | **UPDATE (messenger_reimbursements), CREATE (audit_logs)** |
| `/api/messenger/reimbursements/:id/pay` | `POST` | `messenger_reimbursements` | `kas_messenger, pengeluaran, kas_kantor, payment_methods, documents, audit_logs, idempotency_keys` | **UPDATE (messenger_reimbursements), CREATE (kas_messenger, pengeluaran, kas_kantor, audit_logs)** |
| `/api/messenger/reimbursements/:id/void` | `POST` | `messenger_reimbursements` | `kas_messenger, pengeluaran, kas_kantor, audit_logs` | **UPDATE (messenger_reimbursements), DELETE/CREATE (reversal in kas_messenger, pengeluaran, kas_kantor), CREATE (audit_logs)** |
| `/api/messenger/reimbursements/:id` | `DELETE` | `messenger_reimbursements` | `documents, audit_logs` | **DELETE (messenger_reimbursements), CREATE (audit_logs)** |
| `/api/documents/upload` | `POST` | `documents` | `orders, finance_invoices, users, audit_logs` | **CREATE (documents, audit_logs)** |
| `/api/documents/order/:orderNo` | `GET` | `documents` | `orders, order_documents` | **READ** |
| `/api/documents/invoice/:invoiceId` | `GET` | `documents` | `finance_invoices` | **READ** |
| `/api/documents/:id/ticket` | `POST` | `document_tickets` | `documents, users, orders` | **CREATE (document_tickets)** |
| `/api/documents/:id/preview` | `GET` | `documents` | `document_tickets, orders` | **READ, UPDATE (document_tickets.used_at)** |
| `/api/documents/:id/download` | `GET` | `documents` | `document_tickets` | **READ, UPDATE (document_tickets.used_at)** |
| `/api/documents/:id` | `GET` | `documents` | `orders, finance_invoices` | **READ** |
| `/api/documents/:id/link-order` | `PATCH` | `documents` | `orders, finance_invoices, audit_logs` | **UPDATE (documents), CREATE (audit_logs)** |
| `/api/documents/:id` | `DELETE` | `documents` | `file_deletion_jobs, document_tickets, invoice_payments, messenger_reimbursements, audit_logs` | **UPDATE (documents), CREATE (file_deletion_jobs, audit_logs)** |
| `/api/services` | `GET` | `services` | `service_pricing_configs` | **READ** |
| `/api/services/:id` | `GET` | `services` | `service_pricing_configs` | **READ** |
| `/api/services/:id` | `PUT` | `services` | `audit_logs` | **UPDATE (services), CREATE (audit_logs)** |
| `/api/services/:id` | `DELETE` | `services` | `orders, service_pricing_configs, samsat_operational_tariffs, audit_logs` | **DELETE (services), CREATE (audit_logs)** |
| `/api/pricing/effective` | `GET` | `service_pricing_configs` | `services, samsat_offices, samsat_pricing, samsat_operational_tariffs` | **READ** |
| `/api/pricing/samsat` | `GET` | `samsat_pricing` | `samsat_operational_tariffs` | **READ** |
| `/api/pricing/samsat/:id` | `GET` | `samsat_pricing` | `-` | **READ** |
| `/api/pricing/samsat/:id` | `PUT` | `samsat_pricing` | `audit_logs` | **UPDATE (samsat_pricing), CREATE (audit_logs)** |
| `/api/pricing/services` | `GET` | `service_pricing_configs` | `services, samsat_offices` | **READ** |
| `/api/pricing/services/batch-replicate` | `POST` | `service_pricing_configs` | `services, samsat_offices, audit_logs` | **CREATE / UPDATE (service_pricing_configs), CREATE (audit_logs)** |
| `/api/pricing/services` | `POST` | `service_pricing_configs` | `services, samsat_offices, audit_logs` | **CREATE / UPDATE (service_pricing_configs), CREATE (audit_logs)** |
| `/api/pricing/services/:id` | `PUT` | `service_pricing_configs` | `audit_logs` | **UPDATE (service_pricing_configs), CREATE (audit_logs)** |
| `/api/pricing/services/:id` | `DELETE` | `service_pricing_configs` | `audit_logs` | **DELETE (service_pricing_configs), CREATE (audit_logs)** |
| `/api/pricing/samsat-tariffs` | `GET` | `samsat_operational_tariffs` | `samsat_offices, samsat_pricing, services, wilayah_administratif` | **READ** |
| `/api/pricing/samsat-tariffs` | `PUT` | `samsat_operational_tariffs` | `samsat_offices, samsat_pricing, services, wilayah_administratif, audit_logs` | **CREATE / UPDATE (samsat_operational_tariffs), CREATE (audit_logs)** |
| `/api/pricing/samsat-tariffs` | `POST` | `samsat_operational_tariffs` | `samsat_offices, samsat_pricing, audit_logs` | **CREATE / UPDATE (samsat_operational_tariffs), CREATE (audit_logs)** |
| `/api/pricing/samsat-tariffs` | `DELETE` | `samsat_operational_tariffs` | `audit_logs` | **DELETE (samsat_operational_tariffs), CREATE (audit_logs)** |
| `/api/pricing/samsat-tariffs/:id` | `DELETE` | `samsat_operational_tariffs` | `audit_logs` | **DELETE (samsat_operational_tariffs), CREATE (audit_logs)** |
| `/api/estimation/templates` | `GET` | `estimation_templates` | `-` | **READ** |
| `/api/estimation/templates/:id` | `GET` | `estimation_templates` | `-` | **READ** |
| `/api/estimation/templates/:id` | `PUT` | `estimation_templates` | `audit_logs` | **UPDATE (estimation_templates), CREATE (audit_logs)** |
| `/api/estimation/templates/:id/reset` | `POST` | `estimation_templates` | `audit_logs` | **UPDATE (estimation_templates), CREATE (audit_logs)** |
| `/api/estimation/reset-all` | `POST` | `estimation_templates` | `audit_logs` | **UPDATE / CREATE (estimation_templates), CREATE (audit_logs)** |
| `/api/wilayah` | `GET` | `wilayah_administratif` | `samsat_offices` | **READ** |
| `/api/wilayah/provinces` | `GET` | `wilayah_administratif` | `-` | **READ** |
| `/api/wilayah/:kode` | `GET` | `wilayah_administratif` | `samsat_offices` | **READ** |
| `/api/samsat/offices` | `GET` | `samsat_offices` | `wilayah_administratif` | **READ** |
| `/api/samsat/offices` | `POST` | `samsat_offices` | `wilayah_administratif, service_pricing_configs, audit_logs` | **CREATE (samsat_offices, audit_logs)** |
| `/api/samsat/offices/:id` | `PUT` | `samsat_offices` | `wilayah_administratif, audit_logs` | **UPDATE (samsat_offices), CREATE (audit_logs)** |
| `/api/samsat/offices/:id` | `DELETE` | `samsat_offices` | `orders, samsat_operational_tariffs, service_pricing_configs, audit_logs` | **DELETE (samsat_offices), CREATE (audit_logs)** |
| `/api/payment-methods` | `GET` | `payment_methods` | `-` | **READ** |
| `/api/payment-methods/:id` | `GET` | `payment_methods` | `-` | **READ** |
| `/api/payment-methods` | `POST` | `payment_methods` | `audit_logs` | **CREATE (payment_methods, audit_logs)** |
| `/api/payment-methods/:id` | `PUT` | `payment_methods` | `audit_logs` | **UPDATE (payment_methods), CREATE (audit_logs)** |
| `/api/payment-methods/:id/status` | `PATCH` | `payment_methods` | `audit_logs` | **UPDATE (payment_methods), CREATE (audit_logs)** |
| `/api/payment-methods/:id` | `DELETE` | `payment_methods` | `finance_invoices, invoice_payments, kas_kantor, pengeluaran, internal_transfers, audit_logs` | **DELETE (payment_methods), CREATE (audit_logs)** |
| `/api/users` | `GET` | `users` | `employees, messengers` | **READ** |
| `/api/users/:id` | `GET` | `users` | `employees, messengers` | **READ** |
| `/api/users` | `POST` | `users` | `employees, messengers, audit_logs, security_audit_logs` | **CREATE (users, employees if needed, messengers if Messenger, audit_logs)** |
| `/api/users/:id` | `PUT` | `users` | `employees, messengers, audit_logs, security_audit_logs` | **UPDATE (users, employees, messengers), CREATE (audit_logs, security_audit_logs)** |
| `/api/users/:id` | `DELETE` | `users` | `employees, messengers, document_tickets, audit_logs, security_audit_logs` | **DELETE / UPDATE (users), CREATE (audit_logs, security_audit_logs)** |
| `/api/users/:id/reset-password` | `POST` | `users` | `audit_logs, security_audit_logs` | **UPDATE (users.password_hash, users.token_version), CREATE (audit_logs, security_audit_logs)** |
| `/api/users/:id/permanent-erasure-preflight` | `GET` | `users` | `employees, messengers, orders, messenger_tasks, messenger_reimbursements, documents, document_tickets` | **READ** |
| `/api/users/:id/permanent-erasure` | `POST` | `users` | `employees, messengers, document_tickets, file_deletion_jobs, security_audit_logs, audit_logs` | **DELETE (users, messengers, document_tickets), UPDATE (employees/orders anonymization), CREATE (file_deletion_jobs, security_audit_logs)** |
| `/api/users/file-deletion-jobs/:jobId/retry` | `POST` | `file_deletion_jobs` | `security_audit_logs` | **UPDATE (file_deletion_jobs), CREATE (security_audit_logs)** |
| `/api/employees` | `GET` | `employees` | `users, messengers` | **READ** |
| `/api/employees/next-id` | `GET` | `employees` | `-` | **READ** |
| `/api/employees/:id` | `GET` | `employees` | `users, messengers` | **READ** |
| `/api/employees` | `POST` | `employees` | `messengers, users, audit_logs` | **CREATE (employees, messengers if Messenger, audit_logs)** |
| `/api/employees/:id` | `PUT` | `employees` | `users, messengers, audit_logs` | **UPDATE (employees, users, messengers), CREATE (audit_logs)** |
| `/api/employees/:id` | `DELETE` | `employees` | `users, messengers, orders, messenger_reimbursements, audit_logs` | **DELETE (employees, users, messengers), CREATE (audit_logs)** |
| `/api/permissions` | `GET` | `role_permissions` | `-` | **READ** |
| `/api/permissions/:role` | `PUT` | `role_permissions` | `audit_logs, security_audit_logs` | **UPDATE / CREATE (role_permissions), CREATE (audit_logs, security_audit_logs)** |
| `/api/permissions/reset` | `POST` | `role_permissions` | `audit_logs, security_audit_logs` | **UPDATE / CREATE (role_permissions), CREATE (audit_logs, security_audit_logs)** |
| `/api/notifications/settings` | `GET` | `notification_settings` | `-` | **READ** |
| `/api/notifications/settings` | `PUT` | `notification_settings` | `audit_logs` | **UPDATE / CREATE (notification_settings), CREATE (audit_logs)** |
| `/api/notifications/test-email` | `POST` | `notification_logs` | `notification_settings, audit_logs` | **READ (notification_settings), CREATE (notification_logs, audit_logs)** |
| `/api/notifications/logs` | `GET` | `notification_logs` | `-` | **READ** |
| `/api/audit-logs (Alias: /api/audit)` | `GET` | `audit_logs` | `users` | **READ** |
| `/api/audit-logs (Alias: /api/audit)` | `POST` | `audit_logs` | `users` | **CREATE (audit_logs)** |
| `/api/audit-logs (Alias: /api/audit)` | `DELETE` | `audit_logs` | `security_audit_logs` | **NONE (Blocked / Immutable)** |
| `/api/audit-logs/clear (Alias: /api/audit/clear)` | `POST` | `audit_logs` | `-` | **NONE (Blocked / Immutable)** |
| `/api/audit-logs/clear (Alias: /api/audit/clear)` | `DELETE` | `audit_logs` | `-` | **NONE (Blocked / Immutable)** |
| `/api/v1/public/services (Alias: /api/public/services)` | `GET` | `services` | `-` | **READ** |
| `/api/v1/public/samsat (Alias: /api/public/samsat)` | `GET` | `samsat_offices` | `wilayah_administratif` | **READ** |
| `/api/v1/public/pricing (Alias: /api/public/pricing)` | `GET` | `service_pricing_configs` | `services, samsat_offices, samsat_pricing, samsat_operational_tariffs, estimation_templates` | **READ** |
| `/api/v1/public/orders (Alias: /api/public/orders)` | `POST` | `orders` | `customers, vehicles, finance_invoices, order_status_history, order_timeline_processes` | **CREATE (orders, customers, vehicles, finance_invoices, order_status_history)** |
| `/api/v1/public/orders/tracking (Alias: /api/public/orders/tracking)` | `GET` | `orders` | `vehicles, services, samsat_offices, order_status_history, order_timeline_processes` | **READ** |
| `/api/v1/public/orders/:orderNo/tracking (Alias: /api/public/orders/:orderNo/tracking)` | `GET` | `orders` | `vehicles, services, samsat_offices, order_status_history, order_timeline_processes` | **READ** |

---

## 2. REVERSE INDEX: DATABASE TABLE TO API COVERAGE (ALL 42 TABLES)

| No | Table Name | Direct API Read | Direct API Write | Primary Accessing Modules & Endpoints | Coverage Status |
| :-: | :--- | :---: | :---: | :--- | :--- |
| 1 | `aturan_estimasi` | No | Seed Only | Seeded in `seed.ts`; not yet queried by `/api/estimation` | **Dormant / Missing API** |
| 2 | `audit_logs` | Yes | Yes (Append-Only) | `GET/POST /api/audit-logs`, plus side-effect writes across all mutating controllers | **Active (Core Audit)** |
| 3 | `biaya_layanan` | No | Legacy Migration | Superseded by `service_pricing_configs` (`GET/POST/PUT/DELETE /api/pricing/services`) | **Legacy / Deprecated** |
| 4 | `customer_accounts` | No | No | Schema prepared for external customer portal authentication | **Dormant / Future Portal** |
| 5 | `customers` | Yes | Yes (via Orders) | `GET /api/orders/customers/lookup`, `POST/PUT /api/orders`, `POST /api/v1/public/orders` | **Active (Order-Embedded)** |
| 6 | `document_tickets` | Yes | Yes | `POST /api/documents/:id/ticket`, `GET /api/documents/:id/preview`, `GET /api/documents/:id/download` | **Active** |
| 7 | `documents` | Yes | Yes | `POST /api/documents/upload`, `GET /api/documents/*`, `PATCH /api/documents/:id/link-order`, `DELETE /api/documents/:id` | **Active** |
| 8 | `employees` | Yes | Yes | `GET/POST/PUT/DELETE /api/employees`, `GET /api/employees/next-id`, `/api/users` | **Active** |
| 9 | `estimation_templates` | Yes | Yes | `GET/PUT /api/estimation/templates/:id`, `POST /api/estimation/templates/:id/reset`, `POST /api/estimation/reset-all` | **Active** |
| 10 | `file_deletion_jobs` | Via Retry | Yes | `DELETE /api/documents/:id`, `POST /api/users/:id/permanent-erasure`, `POST /api/users/file-deletion-jobs/:jobId/retry` | **Active** |
| 11 | `finance_invoices` | Yes | Yes | `GET/POST/PUT /api/finance/invoices`, `POST /api/orders`, `PATCH /api/orders/:orderNo/costs` | **Active (Core Finance)** |
| 12 | `harga_dasar_samsat` | No | Legacy Migration | Superseded by `samsat_pricing` and `samsat_operational_tariffs` | **Legacy / Deprecated** |
| 13 | `idempotency_keys` | Yes (Middleware) | Yes (Middleware) | Used by idempotency middleware across `POST /api/orders`, `POST /api/finance/*`, `POST /api/messenger/reimbursements*` | **Active (System Guard)** |
| 14 | `internal_transfers` | Yes | Yes | `GET/POST /api/finance/internal-transfers`, `POST /api/finance/internal-transfers/:id/reverse` | **Active** |
| 15 | `invoice_payments` | Yes | Yes | `POST /api/finance/invoices/:id/payments`, `POST /api/finance/invoices/:id/payments/:paymentId/verify`, `POST /api/orders` | **Active (Core Finance)** |
| 16 | `kas_kantor` | Yes | Yes | `GET/POST/PUT/DELETE /api/finance/kas-kantor`, invoice payment verifications, expenses, cashback, internal transfers | **Active (Core Ledger)** |
| 17 | `kas_messenger` | Yes | Yes | `GET/POST/PUT/DELETE /api/finance/kas-messenger`, reimbursement payouts (`POST /api/messenger/reimbursements/:id/pay`) | **Active (Core Ledger)** |
| 18 | `laba_rugi_snapshots` | Yes | Yes | `GET /api/finance/laba-rugi` (`/pnl`), updated during order/invoice completion & cost updates | **Active** |
| 19 | `master_proses_samsat` | No | Seed Only | Seeded in `seed.ts`; reference table for Samsat stage definitions | **Dormant / Reference** |
| 20 | `messenger_reimbursements` | Yes | Yes | `GET/POST/DELETE /api/messenger/reimbursements`, `PATCH /:id/review`, `POST /:id/pay`, `POST /:id/void` | **Active** |
| 21 | `messenger_tasks` | Yes | Yes | `GET /api/messenger/my-tasks`, `GET /api/messenger/tasks/:orderNo`, `PATCH /api/orders/:orderNo/assign-messenger`, `POST/PATCH /:orderNo/tasks/:taskType/status` | **Active** |
| 22 | `messengers` | Yes | Yes | `GET /api/messenger/messengers`, synced automatically via `/api/employees` and `/api/users` | **Active** |
| 23 | `notification_logs` | Yes | Yes | `GET /api/notifications/logs`, `POST /api/notifications/test-email`, order status notifications | **Active** |
| 24 | `notification_settings` | Yes | Yes | `GET/PUT /api/notifications/settings`, `POST /api/notifications/test-email` | **Active** |
| 25 | `order_corrections` | Yes | Yes | `GET/POST /api/orders/:orderNo/corrections`, `GET /api/order-corrections`, `POST /api/order-corrections/:id/review` | **Active** |
| 26 | `order_documents` | Via Order Delete | Cascade Delete | Created in schema for document checklist per order; cleaned up on order delete | **Partially Used** |
| 27 | `order_status_history` | Yes | Yes | `GET /api/orders/:orderNo/history`, written on `POST /api/orders`, `PATCH /api/orders/:orderNo/status`, `POST /api/orders/bulk-status` | **Active** |
| 28 | `order_timeline_processes` | Yes | Yes | Read in `GET /api/orders/:orderNo` & public tracking; updated via task status transitions | **Active** |
| 29 | `orders` | Yes | Yes | All 31 routes under `/api/orders/*`, `/api/v1/public/orders*`, and joined across `/api/finance/*` and `/api/messenger/*` | **Active (Central Hub)** |
| 30 | `payment_methods` | Yes | Yes | `GET/POST/PUT/PATCH/DELETE /api/payment-methods`, referenced across all finance & order payment endpoints | **Active** |
| 31 | `pengeluaran` | Yes | Yes | `GET/POST/PUT/DELETE /api/finance/pengeluaran`, reimbursement payouts, cashback payouts, order refunds | **Active (Core Ledger)** |
| 32 | `role_permissions` | Yes | Yes | `GET /api/permissions`, `PUT /api/permissions/:role`, `POST /api/permissions/reset`, and read by RBAC middleware on every protected request | **Active (Core Security)** |
| 33 | `samsat_offices` | Yes | Yes | `GET/POST/PUT/DELETE /api/samsat/offices`, `GET /api/v1/public/samsat`, pricing & order endpoints | **Active** |
| 34 | `samsat_operational_tariffs` | Yes | Yes | `GET/POST/PUT/DELETE /api/pricing/samsat-tariffs`, `GET /api/pricing/effective` | **Active (Junction)** |
| 35 | `samsat_pricing` | Yes | Yes | `GET /api/pricing/samsat`, `GET/PUT /api/pricing/samsat/:id`, `GET /api/pricing/effective` | **Active** |
| 36 | `schema_migrations` | Yes | Boot Migration | Read/written during server startup migration runner and health checks | **Active (System)** |
| 37 | `security_audit_logs` | Internal | Yes (Append-Only) | Written by `authController`, `userController` (permanent erasure), `permissionController`, and RBAC violation handlers | **Active (Security Audit)** |
| 38 | `service_pricing_configs` | Yes | Yes | `GET/POST/PUT/DELETE /api/pricing/services`, `POST /api/pricing/services/batch-replicate`, `GET /api/pricing/effective` | **Active (Junction)** |
| 39 | `services` | Yes | Yes | `GET /api/services`, `GET/PUT/DELETE /api/services/:id`, `GET /api/v1/public/services` | **Active** |
| 40 | `users` | Yes | Yes | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/change-password`, `GET/POST/PUT/DELETE /api/users/*` | **Active (Core Auth)** |
| 41 | `vehicles` | Yes | Yes (via Orders) | `GET /api/orders/vehicle-lookup/:nopol`, upserted during `POST/PUT /api/orders` and `POST /api/v1/public/orders` | **Active (Order-Embedded)** |
| 42 | `wilayah_administratif` | Yes | Yes (via Samsat) | `GET /api/wilayah`, `GET /api/wilayah/provinces`, `GET /api/wilayah/:kode`, upserted via `POST /api/samsat/offices` | **Active** |