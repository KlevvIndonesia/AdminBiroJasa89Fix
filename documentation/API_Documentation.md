# COMPLETE API TECHNICAL DOCUMENTATION (REQUEST, RESPONSE & DB RELATIONS)
**Project:** Admin SUN89 / SUNBiroJasa (`d:\Admin\adminsunbirojasa`)  
**Base URL (Development):** `http://localhost:3001` (Proxied via Vite at `/api`)  
**Authentication Scheme:** `Authorization: Bearer <JWT_TOKEN>` (signed with `JWT_SECRET`, verified against `users.token_version` and `users.status = 'Aktif'`)  
**Authorization Scheme:** Role-based (`authorizeRoles`) + Granular Dynamic RBAC Matrix (`authorizePermission` / `authorizeAnyPermission` backed by SQLite table `role_permissions`).

---

## GLOBAL STANDARD HEADERS & ERROR FORMAT

### Standard Request Headers
| Header | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `Authorization` | `string` | Yes (Protected APIs) | `Bearer <JWT>` issued by `POST /api/auth/login` |
| `Content-Type` | `string` | Yes (POST/PUT/PATCH) | `application/json` (or `multipart/form-data` for `/api/documents/upload`) |
| `X-Idempotency-Key` | `string` | Optional (Recommended) | Unique UUID/token for financial & order mutation endpoints (stored in `idempotency_keys`) |
| `X-Public-Api-Key` | `string` | Conditional | Required on `/api/v1/public/*` when `PUBLIC_API_KEY` env variable is configured |

### Standard Error Response Payload
```json
{
  "success": false,
  "error": "Pesan kesalahan yang menjelaskan penyebab kegagalan validasi atau otorisasi",
  "code": "VALIDATION_ERROR | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT",
  "details": []
}
```

---

## 1. [Health & Readiness] `GET /api/health`

### A. API Information
- **API Name:** Health & Readiness — `GET /api/health`
- **Method:** `GET`
- **URL / Endpoint:** `/api/health`
- **Description:** Comprehensive health check probe (verifies SQLite read/write readiness & server status).
- **Authentication Required:** Public (No Token)
- **Role / Permission Access:**
  - **Allowed Roles:** All / Unauthenticated
  - **Dynamic RBAC Permission(s):** `None`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 503 Service Unavailable`
- **Success Response Example:**
```json
{ "status": "ok", "timestamp": "2026-11-15T07:00:00.000Z", "database": "connected" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `schema_migrations`
- **Related / Joined Tables:** `users`
- **CRUD Operations Performed:** **READ (SELECT 1 / PRAGMA check)**
- **Foreign Keys & Relational Mechanics:** Executes lightweight SQLite connectivity check via checkDatabaseHealth().

---

## 2. [Health & Readiness] `GET /api/health/live`

### A. API Information
- **API Name:** Health & Readiness — `GET /api/health/live`
- **Method:** `GET`
- **URL / Endpoint:** `/api/health/live`
- **Description:** Kubernetes/Process liveness probe (confirms Node.js event loop is responsive).
- **Authentication Required:** Public (No Token)
- **Role / Permission Access:**
  - **Allowed Roles:** All / Unauthenticated
  - **Dynamic RBAC Permission(s):** `None`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "status": "alive", "timestamp": "2026-11-15T07:00:00.000Z" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `NONE (Process Memory)`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **NONE**
- **Foreign Keys & Relational Mechanics:** Pure process liveness check without database I/O.

---

## 3. [Health & Readiness] `GET /api/health/ready`

### A. API Information
- **API Name:** Health & Readiness — `GET /api/health/ready`
- **Method:** `GET`
- **URL / Endpoint:** `/api/health/ready`
- **Description:** Readiness probe verifying SQLite WAL connection and schema initialization completion.
- **Authentication Required:** Public (No Token)
- **Role / Permission Access:**
  - **Allowed Roles:** All / Unauthenticated
  - **Dynamic RBAC Permission(s):** `None`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 503 Service Unavailable`
- **Success Response Example:**
```json
{ "status": "ready", "database": "ok" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `schema_migrations`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries SQLite connection health before accepting traffic.

---

## 4. [Authentication] `POST /api/auth/login`

### A. API Information
- **API Name:** Authentication — `POST /api/auth/login`
- **Method:** `POST`
- **URL / Endpoint:** `/api/auth/login`
- **Description:** Authenticates user by email/username/employeeId and password; issues signed JWT and updates last_login.
- **Authentication Required:** Public (Rate-Limited: 20 req / 15m)
- **Role / Permission Access:**
  - **Allowed Roles:** Public (Returns JWT for Admin, SVP, Finance, Messenger)
  - **Dynamic RBAC Permission(s):** `None (Entrypoint)`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `{ "email"?: string, "username"?: string, "identifier"?: string, "password": string }`
- **Validation Rules:** loginSchema: password (required, min 1 char), at least one of email/username/identifier required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 401 Unauthorized | 403 Forbidden (Inactive) | 429 Too Many Requests`
- **Success Response Example:**
```json
{ "success": true, "data": { "token": "eyJhbG...", "user": { "id": 1, "employeeId": "EMP-001", "name": "Admin", "role": "Admin", "email": "admin@sun89.com" } } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers, role_permissions, audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **READ, UPDATE (users.last_login, token_version), CREATE (audit_logs / security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Joins users with employees (employee_id) and messengers; logs login success/failure.

---

## 5. [Authentication] `GET /api/auth/me`

### A. API Information
- **API Name:** Authentication — `GET /api/auth/me`
- **Method:** `GET`
- **URL / Endpoint:** `/api/auth/me`
- **Description:** Returns currently authenticated user profile, employee link, messenger ID (if Messenger), and active role.
- **Authentication Required:** Bearer JWT (authenticateToken)
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `Authenticated Session`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Valid Bearer JWT & active user account in DB.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 1, "employeeId": "EMP-001", "name": "Admin Utama", "role": "Admin", "status": "Aktif" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads users row by JWT userId, joins employees and messengers on employee_id.

---

## 6. [Authentication] `POST /api/auth/change-password`

### A. API Information
- **API Name:** Authentication — `POST /api/auth/change-password`
- **Method:** `POST`
- **URL / Endpoint:** `/api/auth/change-password`
- **Description:** Changes password for the authenticated user, increments token_version to invalidate old sessions.
- **Authentication Required:** Bearer JWT (authenticateToken)
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `Authenticated Session (Self)`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "currentPassword": string, "newPassword": string }`
- **Validation Rules:** changePasswordSchema: currentPassword (required), newPassword (min 8 chars, complexity rules).

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 401 Unauthorized`
- **Success Response Example:**
```json
{ "success": true, "message": "Password berhasil diubah" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **READ, UPDATE (users.password_hash, users.token_version, users.updated_at), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Verifies current password hash, writes new hash, increments token_version.

---

## 7. [Orders] `GET /api/orders`

### A. API Information
- **API Name:** Orders — `GET /api/orders`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders`
- **Description:** Lists active (non-archived) orders with filtering, search, status, date range, and pagination. Messenger role is automatically scoped to assigned orders.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Scoped)
  - **Dynamic RBAC Permission(s):** `manajemenOrder.view | dashboard.view | tugasLapangan.view | finance.profit.view | finance.penjualan1Thn.view | finance.belumBayar.view | finance.cashback.view | finance.labaRugi.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status?, paymentStatus?, serviceId?, samsatId?, messengerId?, search?, startDate?, endDate?, page?, limit?, includeArchived?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional query filters; Messenger role forced to own messengerId.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "orderNo": "ORD-20261115-0001", "status": "Diproses", "paymentStatus": "DP", "isCostVerified": true, "costCompletenessStatus": "VERIFIED" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `customers, vehicles, services, samsat_offices, messengers, finance_invoices, order_timeline_processes, messenger_tasks`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins orders with customers, vehicles, services, samsat_offices, messengers, and aggregates invoice/timeline status.

---

## 8. [Orders] `GET /api/orders/stats`

### A. API Information
- **API Name:** Orders — `GET /api/orders/stats`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/stats`
- **Description:** Returns aggregated order counts by status, payment status, revenue, profit, and completion metrics.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `dashboard.view | manajemenOrder.view | tugasLapangan.view | finance.profit.view | finance.labaRugi.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `startDate?, endDate?, serviceId?, samsatId?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional date range filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "totalOrders": 120, "completedOrders": 85, "inProgressOrders": 25, "pendingPayment": 10, "totalRevenue": 150000000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Aggregates counts and financial totals across non-archived orders.

---

## 9. [Orders] `GET /api/orders/archived`

### A. API Information
- **API Name:** Orders — `GET /api/orders/archived`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/archived`
- **Description:** Lists soft-archived orders (is_archived = 1).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `arsip.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `search?, startDate?, endDate?, page?, limit?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "orderNo": "ORD-20261001-0009", "isArchived": true, "archivedAt": "2026-11-01T10:00:00Z" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `customers, vehicles, services, samsat_offices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries orders WHERE is_archived = 1.

---

## 10. [Orders] `GET /api/orders/archive`

### A. API Information
- **API Name:** Orders — `GET /api/orders/archive`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/archive`
- **Description:** Alias endpoint for GET /api/orders/archived (lists archived orders).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `arsip.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `search?, startDate?, endDate?, page?, limit?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `customers, vehicles, services, samsat_offices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries orders WHERE is_archived = 1.

---

## 11. [Orders] `DELETE /api/orders/archive/clear-all`

### A. API Information
- **API Name:** Orders — `DELETE /api/orders/archive/clear-all`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/orders/archive/clear-all`
- **Description:** Permanently deletes or clears all archived orders that have no protected financial ledger dependencies.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `arsip.clearAll`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Checks for protected financial invoices/payments before deletion.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "deletedCount": 5 }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `order_status_history, order_timeline_processes, order_documents, messenger_tasks, finance_invoices, audit_logs`
- **CRUD Operations Performed:** **DELETE, CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes eligible archived orders and cascades to child order tables; blocks if active verified financial ledger exists.

---

## 12. [Orders] `DELETE /api/orders/archived/clear-all`

### A. API Information
- **API Name:** Orders — `DELETE /api/orders/archived/clear-all`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/orders/archived/clear-all`
- **Description:** Alias for DELETE /api/orders/archive/clear-all.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `arsip.clearAll`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Same as /archive/clear-all.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "deletedCount": 5 }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `order_status_history, order_timeline_processes, order_documents, messenger_tasks, finance_invoices, audit_logs`
- **CRUD Operations Performed:** **DELETE, CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes eligible archived orders.

---

## 13. [Orders] `GET /api/orders/vehicle-lookup/:nopol`

### A. API Information
- **API Name:** Orders — `GET /api/orders/vehicle-lookup/:nopol`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/vehicle-lookup/:nopol`
- **Description:** Looks up existing vehicle & owner details by license plate (nopol) using normalized nopol index.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.create | manajemenOrder.edit | manajemenOrder.view | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `nopol (string, required)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Non-empty nopol path param.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "nopol": "B 1234 XYZ", "merk": "Honda", "tipe": "Vario 160", "customer": { "id": "CUST-01", "name": "Budi" } } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `vehicles`
- **Related / Joined Tables:** `customers, orders`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Uses functional index idx_vehicles_nopol_clean on REPLACE(UPPER(nopol), " ", "") and joins customers.

---

## 14. [Orders] `GET /api/orders/customers/lookup`

### A. API Information
- **API Name:** Orders — `GET /api/orders/customers/lookup`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/customers/lookup`
- **Description:** Searches existing customers by name, phone/WA, or NIK for order autocomplete.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.create | manajemenOrder.edit | manajemenOrder.view | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `q / query / phone / name (string)`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Search query string.

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "CUST-001", "name": "Budi Santoso", "phone": "08123456789" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `customers`
- **Related / Joined Tables:** `vehicles`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Searches customers by name, no_wa, or nik.

---

## 15. [Orders] `POST /api/orders/check-duplicate`

### A. API Information
- **API Name:** Orders — `POST /api/orders/check-duplicate`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/check-duplicate`
- **Description:** Checks whether an active order with the same vehicle nopol and service already exists.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.create | manajemenOrder.edit | kalkulator.createOrder`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "nopol": string, "serviceId"?: string, "excludeOrderNo"?: string }`
- **Validation Rules:** nopol string required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "isDuplicate": false, "existingOrders": [] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `vehicles, services`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries active orders matching normalized nopol and service_id.

---

## 16. [Orders] `POST /api/orders`

### A. API Information
- **API Name:** Orders — `POST /api/orders`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders`
- **Description:** Creates a new order, upserts customer & vehicle, auto-generates 1:1 finance_invoice, initializes status history & timeline, and records initial DP payment if provided.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.create | kalkulator.createOrder`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "customerName": string, "customerPhone": string, "nopol": string, "serviceId": string, "samsatId": string, "biayaPajak": number, "biayaJasa": number, "uangMuka"?: number, "paymentMethodId"?: string, "isCostVerified"?: boolean, ... }`
- **Validation Rules:** createOrderSchema: validates customer, vehicle, serviceId, samsatId, non-negative cost fields, and DP rules.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 403 Forbidden | 409 Conflict (Duplicate)`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "invoiceNo": "INV-20261115-0001", "isCostVerified": true, "costCompletenessStatus": "VERIFIED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `customers, vehicles, finance_invoices, invoice_payments, kas_kantor, order_status_history, order_timeline_processes, messenger_tasks, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE, UPDATE (customers, vehicles)**
- **Foreign Keys & Relational Mechanics:** Atomic SQLite transaction writing orders, customers, vehicles, finance_invoices, order_status_history, and optional invoice_payments/kas_kantor.

---

## 17. [Orders] `GET /api/orders/:orderNo`

### A. API Information
- **API Name:** Orders — `GET /api/orders/:orderNo`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/:orderNo`
- **Description:** Retrieves full order details by orderNo, including customer, vehicle, invoice, payments, timeline, tasks, and documents.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Scoped to assigned)
  - **Dynamic RBAC Permission(s):** `manajemenOrder.view | tugasLapangan.view | arsip.view | finance.profit.view | finance.penjualan1Thn.view | finance.belumBayar.view | finance.cashback.view | finance.labaRugi.view`

### B. Request Parameters
- **Path Parameters:** `orderNo (string, required)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** orderNo path param.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "customer": {}, "vehicle": {}, "invoice": {}, "timeline": [], "tasks": [] } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `customers, vehicles, services, samsat_offices, messengers, finance_invoices, invoice_payments, order_status_history, order_timeline_processes, messenger_tasks, documents`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Aggregates full order graph across 11 related tables.

---

## 18. [Orders] `GET /api/orders/:orderNo/history`

### A. API Information
- **API Name:** Orders — `GET /api/orders/:orderNo/history`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/:orderNo/history`
- **Description:** Retrieves chronological status history entries for an order.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `manajemenOrder.view | tugasLapangan.view | arsip.view`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** orderNo required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": 1, "orderNo": "ORD-20261115-0001", "oldStatus": null, "newStatus": "Draft", "changedAt": "2026-11-15T07:00:00Z" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `order_status_history`
- **Related / Joined Tables:** `orders, users`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads order_status_history WHERE order_no = :orderNo ORDER BY changed_at ASC.

---

## 19. [Orders] `PUT /api/orders/:orderNo`

### A. API Information
- **API Name:** Orders — `PUT /api/orders/:orderNo`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/orders/:orderNo`
- **Description:** Updates order details, vehicle/customer attributes, and synchronizes linked invoice amounts and cost verification status.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.edit`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `Partial order update payload (customer, vehicle, service, samsat, cost breakdown, notes).`
- **Validation Rules:** updateOrderSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "isCostVerified": true } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `customers, vehicles, finance_invoices, order_status_history, laba_rugi_snapshots, audit_logs`
- **CRUD Operations Performed:** **UPDATE, CREATE (order_status_history, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates orders and recalculates finance_invoices totals/remaining_amount inside a transaction.

---

## 20. [Orders] `PATCH /api/orders/:orderNo/status`

### A. API Information
- **API Name:** Orders — `PATCH /api/orders/:orderNo/status`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/orders/:orderNo/status`
- **Description:** Transitions order lifecycle status (e.g., Draft -> Diproses -> Selesai / Dibatalkan) with state machine guards.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Scoped)
  - **Dynamic RBAC Permission(s):** `manajemenOrder.changeStatus | tugasLapangan.updateStatus`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "status": string, "notes"?: string, "cancellationReason"?: string }`
- **Validation Rules:** updateOrderStatusSchema: validates allowed status transitions and cost verification prerequisites.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "status": "Selesai" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `order_status_history, finance_invoices, laba_rugi_snapshots, notification_logs, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices), CREATE (order_status_history, laba_rugi_snapshots, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates orders.status, appends order_status_history, updates invoice status (e.g. CANCELLED if order cancelled with no refund liability).

---

## 21. [Orders] `PATCH /api/orders/:orderNo/payment`

### A. API Information
- **API Name:** Orders — `PATCH /api/orders/:orderNo/payment`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/orders/:orderNo/payment`
- **Description:** Updates order payment status / down payment and synchronizes with finance_invoices and invoice_payments.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.edit | finance.belumBayar.pay`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "uangMuka"?: number, "paymentStatus"?: string, "paymentMethodId"?: string, "proofDocId"?: string, "notes"?: string }`
- **Validation Rules:** Validates payment amount >= 0 and active payment_method_id.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "paymentStatus": "LUNAS" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices, invoice_payments, kas_kantor, payment_methods, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices), CREATE (invoice_payments, kas_kantor, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Synchronizes payment state between orders and finance_invoices.

---

## 22. [Orders] `PATCH /api/orders/:orderNo/assign-messenger`

### A. API Information
- **API Name:** Orders — `PATCH /api/orders/:orderNo/assign-messenger`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/orders/:orderNo/assign-messenger`
- **Description:** Assigns or reassigns a field Messenger to an order and creates/updates messenger_tasks.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.assignMessenger`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "messengerId": string, "taskType"?: string, "notes"?: string }`
- **Validation Rules:** assignMessengerSchema: messengerId must exist and be active.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "assignedMessengerId": "MSG-001" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `messengers, employees, messenger_tasks, order_status_history, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders), CREATE/UPDATE (messenger_tasks), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Sets orders.messenger_id & assigned_messenger_id and upserts messenger_tasks.

---

## 23. [Orders] `POST /api/orders/:orderNo/tasks/:taskType/status`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/tasks/:taskType/status`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/tasks/:taskType/status`
- **Description:** Updates the execution status of a specific messenger field task on an order.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Messenger (Assigned)
  - **Dynamic RBAC Permission(s):** `tugasLapangan.updateStatus | manajemenOrder.edit`

### B. Request Parameters
- **Path Parameters:** `orderNo (string), taskType (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "status": "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED", "notes"?: string }`
- **Validation Rules:** Valid task status enum.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "taskType": "PICKUP_DOCS", "status": "COMPLETED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_tasks`
- **Related / Joined Tables:** `orders, order_timeline_processes, messengers, audit_logs`
- **CRUD Operations Performed:** **UPDATE (messenger_tasks, order_timeline_processes, orders), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates messenger_tasks status and syncs order_timeline_processes.

---

## 24. [Orders] `PATCH /api/orders/:orderNo/tasks/:taskType/status`

### A. API Information
- **API Name:** Orders — `PATCH /api/orders/:orderNo/tasks/:taskType/status`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/orders/:orderNo/tasks/:taskType/status`
- **Description:** PATCH alias for updating a specific messenger task status on an order.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Messenger (Assigned)
  - **Dynamic RBAC Permission(s):** `tugasLapangan.updateStatus | manajemenOrder.edit`

### B. Request Parameters
- **Path Parameters:** `orderNo (string), taskType (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "status": string, "notes"?: string }`
- **Validation Rules:** Valid task status enum.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "status": "COMPLETED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_tasks`
- **Related / Joined Tables:** `orders, order_timeline_processes, messengers, audit_logs`
- **CRUD Operations Performed:** **UPDATE, CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Same handler as POST /:orderNo/tasks/:taskType/status.

---

## 25. [Orders] `PATCH /api/orders/:orderNo/costs`

### A. API Information
- **API Name:** Orders — `PATCH /api/orders/:orderNo/costs`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/orders/:orderNo/costs`
- **Description:** Updates order cost components (PKB, SWDKLLJ, BBNKB, PNBP, Denda, Jasa, Lainnya) and recalculates verification & invoice totals.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.edit | finance.belumBayar.editCost`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "biayaPajak"?: number, "biayaSwdkllj"?: number, "biayaBbnkb"?: number, "biayaPnbp"?: number, "biayaDenda"?: number, "biayaJasa"?: number, "biayaLainnya"?: number, "isCostVerified"?: boolean }`
- **Validation Rules:** All cost fields must be numbers >= 0.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "totalBiaya": 2500000, "isCostVerified": true, "costCompletenessStatus": "VERIFIED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices, laba_rugi_snapshots, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices, laba_rugi_snapshots), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Recalculates order cost completeness, profit, and updates finance_invoices grand_total & remaining_amount.

---

## 26. [Orders] `POST /api/orders/:orderNo/verify-costs`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/verify-costs`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/verify-costs`
- **Description:** Marks order and its linked invoice as cost-verified (VERIFIED) once actual Samsat notice/costs are confirmed.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.verifyCost | manajemenOrder.edit | finance.belumBayar.verify`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "biayaPajak"?: number, "biayaSwdkllj"?: number, "biayaJasa"?: number, "notes"?: string }`
- **Validation Rules:** Requires valid positive total cost and non-draft components.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "isCostVerified": true, "costCompletenessStatus": "VERIFIED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices, order_status_history, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices), CREATE (order_status_history, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Sets orders.is_cost_verified = 1, cost_completeness_status = VERIFIED, and updates finance_invoices.status to VERIFIED/UNPAID/PARTIAL/PAID.

---

## 27. [Orders] `POST /api/orders/:orderNo/finalize-estimate`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/finalize-estimate`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/finalize-estimate`
- **Description:** Converts a PARTIAL_ESTIMATE / draft-estimate order into a finalized cost structure.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.edit | manajemenOrder.verifyCost`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "biayaPajak": number, "biayaSwdkllj"?: number, "biayaBbnkb"?: number, "biayaPnbp"?: number, "biayaDenda"?: number, "biayaJasa": number }`
- **Validation Rules:** Requires complete actual cost breakdown.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "isCostVerified": true, "costCompletenessStatus": "VERIFIED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices, order_status_history, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices), CREATE (order_status_history, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Finalizes estimate values on orders and transitions linked finance_invoices out of DRAFT_ESTIMATE.

---

## 28. [Orders] `PATCH /api/orders/:orderNo/cashback`

### A. API Information
- **API Name:** Orders — `PATCH /api/orders/:orderNo/cashback`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/orders/:orderNo/cashback`
- **Description:** Updates cashback amount or status on an order and synchronizes with finance_invoices.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.edit | finance.cashback.manage`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "cashback": number, "cashbackStatus"?: "NONE" | "PENDING" | "PAID", "notes"?: string }`
- **Validation Rules:** cashback >= 0.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "cashback": 50000, "cashbackStatus": "PENDING" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices, laba_rugi_snapshots, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices, laba_rugi_snapshots), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates orders.cashback and finance_invoices.cashback_amount / cashback_status.

---

## 29. [Orders] `POST /api/orders/:orderNo/archive`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/archive`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/archive`
- **Description:** Soft-archives an order (sets is_archived = 1, archived_at, archived_by).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.archive | arsip.manage`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "reason"?: string }`
- **Validation Rules:** Order must exist and not have blocking in-flight operations.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "isArchived": true } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Sets orders.is_archived = 1, archived_at = CURRENT_TIMESTAMP.

---

## 30. [Orders] `POST /api/orders/:orderNo/restore`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/restore`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/restore`
- **Description:** Restores a soft-archived order back to active orders list (sets is_archived = 0).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `arsip.restore | manajemenOrder.archive`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Order must exist in archive.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "isArchived": false } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Sets orders.is_archived = 0, archived_at = NULL.

---

## 31. [Orders] `POST /api/orders/:orderNo/unarchive`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/unarchive`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/unarchive`
- **Description:** Alias for POST /api/orders/:orderNo/restore.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `arsip.restore | manajemenOrder.archive`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Order must exist.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "isArchived": false } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Sets orders.is_archived = 0.

---

## 32. [Orders] `POST /api/orders/bulk-archive`

### A. API Information
- **API Name:** Orders — `POST /api/orders/bulk-archive`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/bulk-archive`
- **Description:** Soft-archives multiple orders in a single atomic transaction.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.archive | arsip.manage`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "orderNos": string[], "reason"?: string }`
- **Validation Rules:** orderNos non-empty array of strings.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request`
- **Success Response Example:**
```json
{ "success": true, "archivedCount": 3 }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Batch updates orders SET is_archived = 1 WHERE order_no IN (...).

---

## 33. [Orders] `POST /api/orders/bulk-status`

### A. API Information
- **API Name:** Orders — `POST /api/orders/bulk-status`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/bulk-status`
- **Description:** Updates status for multiple orders in batch with per-order validation.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.changeStatus`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "orderNos": string[], "status": string, "notes"?: string }`
- **Validation Rules:** orderNos array and valid target status.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request`
- **Success Response Example:**
```json
{ "success": true, "updatedCount": 4 }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `order_status_history, finance_invoices, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices), CREATE (order_status_history, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Iterates in transaction updating status and recording order_status_history.

---

## 34. [Orders] `POST /api/orders/:orderNo/corrections`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/corrections`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/corrections`
- **Description:** Submits a formal order data/cost correction request for SVP/Admin review.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.requestCorrection | manajemenOrder.edit | koreksiOrder.create`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "correctionType": string, "reason": string, "proposedChanges": object, "linkedDuplicateOrderNo"?: string }`
- **Validation Rules:** reason and proposedChanges required.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "CORR-001", "orderNo": "ORD-20261115-0001", "status": "PENDING" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `order_corrections`
- **Related / Joined Tables:** `orders, audit_logs`
- **CRUD Operations Performed:** **CREATE (order_corrections, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into order_corrections with FK order_no -> orders.order_no.

---

## 35. [Orders] `GET /api/orders/:orderNo/corrections`

### A. API Information
- **API Name:** Orders — `GET /api/orders/:orderNo/corrections`
- **Method:** `GET`
- **URL / Endpoint:** `/api/orders/:orderNo/corrections`
- **Description:** Lists all correction requests associated with a specific order.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.view | koreksiOrder.view`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** orderNo required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "CORR-001", "status": "PENDING" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `order_corrections`
- **Related / Joined Tables:** `orders`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries order_corrections WHERE order_no = :orderNo.

---

## 36. [Orders] `POST /api/orders/:orderNo/cancel-with-refund`

### A. API Information
- **API Name:** Orders — `POST /api/orders/:orderNo/cancel-with-refund`
- **Method:** `POST`
- **URL / Endpoint:** `/api/orders/:orderNo/cancel-with-refund`
- **Description:** Cancels an order that already has verified customer payments and records refund settlement or refund liability.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.changeStatus | finance.belumBayar.refund`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "reason": string, "refundAmount"?: number, "paymentMethodId"?: string, "proofDocId"?: string }`
- **Validation Rules:** Requires cancellation reason; validates refund amount against paid amount.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "status": "Dibatalkan", "refundStatus": "REFUNDED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices, invoice_payments, pengeluaran, kas_kantor, order_status_history, audit_logs`
- **CRUD Operations Performed:** **UPDATE (orders, finance_invoices), CREATE (pengeluaran, kas_kantor, order_status_history, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Atomically cancels order, updates finance_invoices refund state, and posts refund outflow to pengeluaran & kas_kantor.

---

## 37. [Orders] `DELETE /api/orders/:orderNo`

### A. API Information
- **API Name:** Orders — `DELETE /api/orders/:orderNo`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/orders/:orderNo`
- **Description:** Deletes a draft/archived order if and only if no verified financial transactions exist.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenOrder.delete | arsip.delete`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Blocks deletion with 409 Conflict if verified invoice payments or ledger entries exist.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Order berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `finance_invoices, order_status_history, order_timeline_processes, order_documents, messenger_tasks, audit_logs`
- **CRUD Operations Performed:** **DELETE, CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes order and cascades to child records; guarded by financial integrity checks.

---

## 38. [Order Corrections] `GET /api/order-corrections`

### A. API Information
- **API Name:** Order Corrections — `GET /api/order-corrections`
- **Method:** `GET`
- **URL / Endpoint:** `/api/order-corrections`
- **Description:** Lists all order correction requests across all orders with optional status filter.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `koreksiOrder.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status? (PENDING | APPROVED | REJECTED), orderNo?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional status filter.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "CORR-001", "orderNo": "ORD-20261115-0001", "status": "PENDING" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `order_corrections`
- **Related / Joined Tables:** `orders, customers, vehicles`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins order_corrections with orders.

---

## 39. [Order Corrections] `GET /api/order-corrections/:id`

### A. API Information
- **API Name:** Order Corrections — `GET /api/order-corrections/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/order-corrections/:id`
- **Description:** Retrieves a single order correction request by its ID.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `koreksiOrder.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "CORR-001", "orderNo": "ORD-20261115-0001", "proposedChanges": {} } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `order_corrections`
- **Related / Joined Tables:** `orders`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads order_corrections by PK id.

---

## 40. [Order Corrections] `POST /api/order-corrections/:id/review`

### A. API Information
- **API Name:** Order Corrections — `POST /api/order-corrections/:id/review`
- **Method:** `POST`
- **URL / Endpoint:** `/api/order-corrections/:id/review`
- **Description:** Approves or rejects a pending order correction request; if APPROVED, applies proposed changes to the order & invoice atomically.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `koreksiOrder.approve | koreksiOrder.reject | manajemenOrder.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "action": "APPROVE" | "REJECT", "reviewNotes"?: string }`
- **Validation Rules:** reviewOrderCorrectionSchema: action in [APPROVE, REJECT].

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "CORR-001", "status": "APPROVED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `order_corrections`
- **Related / Joined Tables:** `orders, finance_invoices, order_status_history, audit_logs`
- **CRUD Operations Performed:** **UPDATE (order_corrections, orders, finance_invoices), CREATE (order_status_history, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates order_corrections status and applies approved field/cost mutations to orders and finance_invoices.

---

## 41. [Finance] `GET /api/finance/summary`

### A. API Information
- **API Name:** Finance — `GET /api/finance/summary`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/summary`
- **Description:** Returns consolidated financial summary (total revenue, profit, unpaid receivables, pending cashback, Kas Kantor balance, Kas Messenger balance, expenses).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.profit.view | finance.kasKantor.view | finance.kasMessenger.view | finance.penjualan1Thn.view | finance.belumBayar.view | finance.cashback.view | finance.labaRugi.view | dashboard.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `startDate?, endDate?, serviceId?, samsatId?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional date range and filter parameters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "totalProfit": 45000000, "kasKantorBalance": 120000000, "kasMessengerBalance": 5000000, "unpaidTotal": 18000000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `finance_invoices`
- **Related / Joined Tables:** `orders, invoice_payments, kas_kantor, kas_messenger, pengeluaran, messenger_reimbursements, laba_rugi_snapshots`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Aggregates balances and KPIs across finance_invoices, orders, kas_kantor, kas_messenger, and pengeluaran.

---

## 42. [Finance] `GET /api/finance/laba-rugi`

### A. API Information
- **API Name:** Finance — `GET /api/finance/laba-rugi`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/laba-rugi`
- **Description:** Generates Profit & Loss (Laba Rugi) statement with revenue breakdown, operational expenses, messenger reimbursements, cashback deductions, and net profit.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.labaRugi.view | finance.profit.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `startDate?, endDate?, period?, serviceId?, samsatId?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional date range.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "grossRevenue": 85000000, "totalStateCosts": 50000000, "serviceFeeRevenue": 35000000, "operationalExpenses": 6000000, "netProfit": 29000000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `laba_rugi_snapshots`
- **Related / Joined Tables:** `orders, finance_invoices, pengeluaran, messenger_reimbursements, kas_kantor`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Computes P&L from verified orders/invoices, laba_rugi_snapshots, pengeluaran, and messenger_reimbursements.

---

## 43. [Finance] `GET /api/finance/pnl`

### A. API Information
- **API Name:** Finance — `GET /api/finance/pnl`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/pnl`
- **Description:** Alias for GET /api/finance/laba-rugi.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.labaRugi.view | finance.profit.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `startDate?, endDate?, period?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional date range.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "netProfit": 29000000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `laba_rugi_snapshots`
- **Related / Joined Tables:** `orders, finance_invoices, pengeluaran, messenger_reimbursements`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Same controller handler as GET /api/finance/laba-rugi.

---

## 44. [Finance] `GET /api/finance/invoices`

### A. API Information
- **API Name:** Finance — `GET /api/finance/invoices`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/invoices`
- **Description:** Lists finance invoices with customer, order, cost verification, payment history, and receivable status.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.view | finance.profit.view | finance.penjualan1Thn.view | finance.cashback.view | finance.labaRugi.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status?, paymentStatus?, orderNo?, customerId?, search?, startDate?, endDate?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional query filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": 1, "invoiceNo": "INV-20261115-0001", "orderNo": "ORD-20261115-0001", "status": "UNPAID", "grandTotal": 1500000, "paidAmount": 0, "remainingAmount": 1500000 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `finance_invoices`
- **Related / Joined Tables:** `orders, customers, vehicles, services, samsat_offices, invoice_payments, payment_methods`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins finance_invoices with orders, customers, vehicles, and embeds invoice_payments.

---

## 45. [Finance] `GET /api/finance/invoices/:id`

### A. API Information
- **API Name:** Finance — `GET /api/finance/invoices/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/invoices/:id`
- **Description:** Retrieves a single invoice by numeric ID, invoice_no, or order_no with full payment history and documents.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.view | finance.profit.view | finance.penjualan1Thn.view | finance.cashback.view`

### B. Request Parameters
- **Path Parameters:** `id (number | invoiceNo | orderNo)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 1, "invoiceNo": "INV-20261115-0001", "payments": [] } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `finance_invoices`
- **Related / Joined Tables:** `orders, customers, vehicles, invoice_payments, documents, payment_methods`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Fetches finance_invoices row and joins invoice_payments and documents.

---

## 46. [Finance] `POST /api/finance/invoices`

### A. API Information
- **API Name:** Finance — `POST /api/finance/invoices`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/invoices`
- **Description:** Creates or upserts a finance invoice for an existing order (enforces 1:1 unique order_no constraint).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.create | finance.belumBayar.edit | manajemenOrder.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "orderNo": string, "customerId"?: string, "biayaPajak"?: number, "biayaJasa"?: number, "ppnAmount"?: number, "pph23Amount"?: number, "cashbackAmount"?: number, ... }`
- **Validation Rules:** createInvoiceSchema: orderNo required; amounts >= 0.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 200 OK | 400 Bad Request | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 1, "invoiceNo": "INV-20261115-0001", "orderNo": "ORD-20261115-0001" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `finance_invoices`
- **Related / Joined Tables:** `orders, customers, payment_methods, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE / UPDATE (finance_invoices), UPDATE (orders), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Enforces unique order_no index idx_invoices_order_unique and preserves Draft Estimate vs Verified status.

---

## 47. [Finance] `PUT /api/finance/invoices/:id`

### A. API Information
- **API Name:** Finance — `PUT /api/finance/invoices/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/finance/invoices/:id`
- **Description:** Updates invoice line items, taxes (PPN, PPh23), discounts/cashback, or status (with terminal CANCELLED guard).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.edit | finance.cashback.manage`

### B. Request Parameters
- **Path Parameters:** `id (string | number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `Partial invoice fields (biayaPajak, biayaJasa, ppnAmount, pph23Amount, cashbackAmount, notes, status).`
- **Validation Rules:** updateInvoiceSchema; prevents overwriting terminal CANCELLED status unless explicit reactivation.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 1, "invoiceNo": "INV-20261115-0001", "grandTotal": 1650000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `finance_invoices`
- **Related / Joined Tables:** `orders, laba_rugi_snapshots, audit_logs`
- **CRUD Operations Performed:** **UPDATE (finance_invoices, orders, laba_rugi_snapshots), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates finance_invoices and synchronizes orders cost/payment summary.

---

## 48. [Finance] `POST /api/finance/invoices/:id/payments`

### A. API Information
- **API Name:** Finance — `POST /api/finance/invoices/:id/payments`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/invoices/:id/payments`
- **Description:** Records a new customer payment (DP, installment, or full settlement) against an invoice and optionally posts to Kas Kantor / Kas Messenger.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.pay | finance.kasKantor.create`

### B. Request Parameters
- **Path Parameters:** `id (invoice id / invoiceNo / orderNo)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "amount": number, "paymentMethodId": string, "paymentDate"?: string, "targetLedger"?: "KAS_KANTOR" | "KAS_MESSENGER", "proofDocId"?: string, "notes"?: string, "autoVerify"?: boolean }`
- **Validation Rules:** recordPaymentSchema: amount > 0, valid active paymentMethodId, cannot exceed remaining_amount unless overpayment allowed.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "paymentId": 10, "invoiceNo": "INV-20261115-0001", "paidAmount": 1500000, "remainingAmount": 0, "status": "PAID" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `invoice_payments`
- **Related / Joined Tables:** `finance_invoices, orders, kas_kantor, kas_messenger, payment_methods, documents, laba_rugi_snapshots, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE (invoice_payments, kas_kantor/kas_messenger, audit_logs), UPDATE (finance_invoices, orders, laba_rugi_snapshots)**
- **Foreign Keys & Relational Mechanics:** Transactional insert into invoice_payments + ledger posting to kas_kantor/kas_messenger + recalculation of finance_invoices & orders.

---

## 49. [Finance] `POST /api/finance/invoices/:id/payments/:paymentId/verify`

### A. API Information
- **API Name:** Finance — `POST /api/finance/invoices/:id/payments/:paymentId/verify`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/invoices/:id/payments/:paymentId/verify`
- **Description:** Verifies or rejects a pending invoice payment and posts verified inflow to the designated cash ledger.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.verify | finance.kasKantor.verify`

### B. Request Parameters
- **Path Parameters:** `id (invoice identifier), paymentId (number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "status"?: "VERIFIED" | "REJECTED", "paymentMethodId"?: string, "notes"?: string, "rejectionReason"?: string }`
- **Validation Rules:** verifyPaymentSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "paymentId": 10, "verificationStatus": "VERIFIED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `invoice_payments`
- **Related / Joined Tables:** `finance_invoices, orders, kas_kantor, kas_messenger, laba_rugi_snapshots, audit_logs`
- **CRUD Operations Performed:** **UPDATE (invoice_payments, finance_invoices, orders), CREATE (kas_kantor/kas_messenger, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Marks invoice_payments.verification_status = VERIFIED, links kas_kantor_id, and updates invoice paid_amount.

---

## 50. [Finance] `POST /api/finance/invoices/:id/verify-payment`

### A. API Information
- **API Name:** Finance — `POST /api/finance/invoices/:id/verify-payment`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/invoices/:id/verify-payment`
- **Description:** Alias endpoint to verify a payment on an invoice (accepts paymentId in body or verifies latest pending payment).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.verify | finance.kasKantor.verify`

### B. Request Parameters
- **Path Parameters:** `id (invoice identifier)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "paymentId"?: number, "status"?: "VERIFIED" | "REJECTED", "notes"?: string }`
- **Validation Rules:** verifyPaymentSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "status": "PAID" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `invoice_payments`
- **Related / Joined Tables:** `finance_invoices, orders, kas_kantor, audit_logs`
- **CRUD Operations Performed:** **UPDATE (invoice_payments, finance_invoices, orders), CREATE (kas_kantor, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Delegates to the same payment verification transaction.

---

## 51. [Finance] `POST /api/finance/invoices/:id/cashback/pay`

### A. API Information
- **API Name:** Finance — `POST /api/finance/invoices/:id/cashback/pay`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/invoices/:id/cashback/pay`
- **Description:** Disburses pending customer cashback for an invoice/order and records the outflow in Pengeluaran & Kas Kantor.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.cashback.pay | finance.cashback.manage`

### B. Request Parameters
- **Path Parameters:** `id (invoice identifier)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "paymentMethodId": string, "amount"?: number, "proofDocId"?: string, "notes"?: string, "paidDate"?: string }`
- **Validation Rules:** payCashbackSchema: requires active paymentMethodId and pending cashback > 0.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "invoiceNo": "INV-20261115-0001", "cashbackStatus": "PAID" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `finance_invoices`
- **Related / Joined Tables:** `orders, pengeluaran, kas_kantor, documents, payment_methods, laba_rugi_snapshots, audit_logs`
- **CRUD Operations Performed:** **UPDATE (finance_invoices, orders, laba_rugi_snapshots), CREATE (pengeluaran, kas_kantor, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Sets cashback_status = PAID on finance_invoices & orders, creates pengeluaran and kas_kantor KELUAR entries.

---

## 52. [Finance] `POST /api/finance/invoices/:id/refund`

### A. API Information
- **API Name:** Finance — `POST /api/finance/invoices/:id/refund`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/invoices/:id/refund`
- **Description:** Processes a customer refund for an overpaid or cancelled invoice and posts outflow to Kas Kantor & Pengeluaran.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.refund | finance.kasKantor.create`

### B. Request Parameters
- **Path Parameters:** `id (invoice identifier)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "amount": number, "paymentMethodId": string, "reason": string, "proofDocId"?: string }`
- **Validation Rules:** amount > 0, valid paymentMethodId, reason required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "invoiceNo": "INV-20261115-0001", "refundStatus": "REFUNDED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `finance_invoices`
- **Related / Joined Tables:** `orders, invoice_payments, pengeluaran, kas_kantor, payment_methods, audit_logs`
- **CRUD Operations Performed:** **UPDATE (finance_invoices, orders), CREATE (pengeluaran, kas_kantor, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates refund_amount/refund_status on finance_invoices and posts cash outflow.

---

## 53. [Finance] `GET /api/finance/kas-kantor`

### A. API Information
- **API Name:** Finance — `GET /api/finance/kas-kantor`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/kas-kantor`
- **Description:** Lists Kas Kantor (Office Cash/Bank Ledger) transactions with running balances and filter by payment method or date.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.view | finance.labaRugi.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `paymentMethodId?, tipeTransaksi? (MASUK|KELUAR|TRANSFER), kategori?, startDate?, endDate?, search?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional query filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": 1, "tanggal": "2026-11-15", "tipeTransaksi": "MASUK", "nominal": 1500000, "kategori": "Pembayaran Order" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_kantor`
- **Related / Joined Tables:** `payment_methods, documents, orders, finance_invoices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries kas_kantor joined with payment_methods and documents.

---

## 54. [Finance] `POST /api/finance/kas-kantor`

### A. API Information
- **API Name:** Finance — `POST /api/finance/kas-kantor`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/kas-kantor`
- **Description:** Creates a manual Kas Kantor ledger transaction (MASUK or KELUAR).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "tanggal": string, "tipeTransaksi": "MASUK" | "KELUAR", "kategori": string, "nominal": number, "paymentMethodId": string, "keterangan"?: string, "buktiDokumenId"?: string, "orderNo"?: string }`
- **Validation Rules:** createKasKantorSchema: nominal > 0, valid tipeTransaksi, active paymentMethodId.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 15, "tipeTransaksi": "MASUK", "nominal": 5000000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_kantor`
- **Related / Joined Tables:** `payment_methods, pengeluaran, documents, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE (kas_kantor, pengeluaran if KELUAR, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into kas_kantor (and synchronizes with pengeluaran when applicable).

---

## 55. [Finance] `PUT /api/finance/kas-kantor/:id`

### A. API Information
- **API Name:** Finance — `PUT /api/finance/kas-kantor/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/finance/kas-kantor/:id`
- **Description:** Updates an existing Kas Kantor ledger entry.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.edit`

### B. Request Parameters
- **Path Parameters:** `id (number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "tanggal"?: string, "kategori"?: string, "nominal"?: number, "paymentMethodId"?: string, "keterangan"?: string, "buktiDokumenId"?: string }`
- **Validation Rules:** updateKasKantorSchema: nominal > 0 if provided.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 15, "nominal": 5250000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_kantor`
- **Related / Joined Tables:** `payment_methods, documents, audit_logs`
- **CRUD Operations Performed:** **UPDATE (kas_kantor), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates kas_kantor row by PK id.

---

## 56. [Finance] `DELETE /api/finance/kas-kantor/:id`

### A. API Information
- **API Name:** Finance — `DELETE /api/finance/kas-kantor/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/finance/kas-kantor/:id`
- **Description:** Deletes a manual Kas Kantor entry (blocks deletion if locked by verified invoice payment or internal transfer).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.delete`

### B. Request Parameters
- **Path Parameters:** `id (number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Checks for linked invoice_payments or internal_transfers.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Data Kas Kantor berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_kantor`
- **Related / Joined Tables:** `invoice_payments, audit_logs`
- **CRUD Operations Performed:** **DELETE (kas_kantor), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes kas_kantor row if not referenced by protected payment records.

---

## 57. [Finance] `GET /api/finance/kas-messenger`

### A. API Information
- **API Name:** Finance — `GET /api/finance/kas-messenger`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/kas-messenger`
- **Description:** Lists Kas Messenger (Field Petty Cash / Advance Ledger) transactions and per-messenger balances.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Scoped)
  - **Dynamic RBAC Permission(s):** `finance.kasMessenger.view | tugasLapangan.view | reimbursement.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `messengerId?, tipeTransaksi?, startDate?, endDate?, search?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Messenger role automatically scoped to own messenger_id.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": 1, "messengerId": "MSG-001", "tipeTransaksi": "MASUK", "nominal": 1000000 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_messenger`
- **Related / Joined Tables:** `messengers, employees, documents, orders, messenger_reimbursements`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries kas_messenger joined with messengers, employees, and documents.

---

## 58. [Finance] `POST /api/finance/kas-messenger`

### A. API Information
- **API Name:** Finance — `POST /api/finance/kas-messenger`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/kas-messenger`
- **Description:** Records a new Kas Messenger transaction (cash advance top-up MASUK or field expense settlement KELUAR).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasMessenger.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "messengerId": string, "tanggal": string, "tipeTransaksi": "MASUK" | "KELUAR", "kategori": string, "nominal": number, "paymentMethodId"?: string, "keterangan"?: string, "buktiDokumenId"?: string, "orderNo"?: string }`
- **Validation Rules:** createKasMessengerSchema: messengerId required, nominal > 0.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 8, "messengerId": "MSG-001", "nominal": 1000000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_messenger`
- **Related / Joined Tables:** `messengers, kas_kantor, pengeluaran, documents, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE (kas_messenger, kas_kantor if funded from office, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into kas_messenger and links funding outflow from kas_kantor when top-up is disbursed.

---

## 59. [Finance] `PUT /api/finance/kas-messenger/:id`

### A. API Information
- **API Name:** Finance — `PUT /api/finance/kas-messenger/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/finance/kas-messenger/:id`
- **Description:** Updates an existing Kas Messenger transaction.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasMessenger.edit`

### B. Request Parameters
- **Path Parameters:** `id (number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "tanggal"?: string, "kategori"?: string, "nominal"?: number, "keterangan"?: string, "buktiDokumenId"?: string }`
- **Validation Rules:** updateKasMessengerSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 8, "nominal": 1200000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_messenger`
- **Related / Joined Tables:** `messengers, documents, audit_logs`
- **CRUD Operations Performed:** **UPDATE (kas_messenger), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates kas_messenger row by PK id.

---

## 60. [Finance] `DELETE /api/finance/kas-messenger/:id`

### A. API Information
- **API Name:** Finance — `DELETE /api/finance/kas-messenger/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/finance/kas-messenger/:id`
- **Description:** Deletes a Kas Messenger entry if not locked by a paid reimbursement or invoice payment.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasMessenger.delete`

### B. Request Parameters
- **Path Parameters:** `id (number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Checks reimbursement/payment link before deleting.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Data Kas Messenger berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `kas_messenger`
- **Related / Joined Tables:** `messenger_reimbursements, invoice_payments, audit_logs`
- **CRUD Operations Performed:** **DELETE (kas_messenger), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes kas_messenger row.

---

## 61. [Finance] `GET /api/finance/pengeluaran`

### A. API Information
- **API Name:** Finance — `GET /api/finance/pengeluaran`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/pengeluaran`
- **Description:** Lists operational & order-related expense entries (pengeluaran).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.view | finance.labaRugi.view | finance.profit.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `kategori?, paymentMethodId?, messengerId?, startDate?, endDate?, search?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": 1, "tanggal": "2026-11-15", "kategori": "Operasional Kantor", "nominal": 350000 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `pengeluaran`
- **Related / Joined Tables:** `payment_methods, messengers, documents, orders, finance_invoices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries pengeluaran joined with payment_methods, messengers, and documents.

---

## 62. [Finance] `POST /api/finance/pengeluaran`

### A. API Information
- **API Name:** Finance — `POST /api/finance/pengeluaran`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/pengeluaran`
- **Description:** Creates a new expense record (pengeluaran) and automatically posts the corresponding KELUAR entry in Kas Kantor.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.create | finance.labaRugi.createExpense`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "tanggal": string, "kategori": string, "nominal": number, "paymentMethodId": string, "keterangan"?: string, "messengerId"?: string, "buktiDokumenId"?: string, "orderNo"?: string }`
- **Validation Rules:** createPengeluaranSchema: nominal > 0, kategori required, active paymentMethodId.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 12, "kategori": "ATK & Cetak", "nominal": 250000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `pengeluaran`
- **Related / Joined Tables:** `kas_kantor, payment_methods, messengers, documents, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE (pengeluaran, kas_kantor, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Atomically inserts pengeluaran and corresponding kas_kantor outflow.

---

## 63. [Finance] `PUT /api/finance/pengeluaran/:id`

### A. API Information
- **API Name:** Finance — `PUT /api/finance/pengeluaran/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/finance/pengeluaran/:id`
- **Description:** Updates an expense entry (pengeluaran) and syncs linked Kas Kantor entry.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.edit`

### B. Request Parameters
- **Path Parameters:** `id (number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "tanggal"?: string, "kategori"?: string, "nominal"?: number, "paymentMethodId"?: string, "keterangan"?: string, "buktiDokumenId"?: string }`
- **Validation Rules:** updatePengeluaranSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 12, "nominal": 275000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `pengeluaran`
- **Related / Joined Tables:** `kas_kantor, payment_methods, documents, audit_logs`
- **CRUD Operations Performed:** **UPDATE (pengeluaran, kas_kantor), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates pengeluaran row by PK id.

---

## 64. [Finance] `DELETE /api/finance/pengeluaran/:id`

### A. API Information
- **API Name:** Finance — `DELETE /api/finance/pengeluaran/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/finance/pengeluaran/:id`
- **Description:** Deletes an expense record if not locked by a paid reimbursement or verified invoice settlement.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.delete`

### B. Request Parameters
- **Path Parameters:** `id (number)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Checks foreign key references before delete.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Pengeluaran berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `pengeluaran`
- **Related / Joined Tables:** `kas_kantor, messenger_reimbursements, invoice_payments, audit_logs`
- **CRUD Operations Performed:** **DELETE (pengeluaran), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes pengeluaran row.

---

## 65. [Finance] `GET /api/finance/internal-transfers`

### A. API Information
- **API Name:** Finance — `GET /api/finance/internal-transfers`
- **Method:** `GET`
- **URL / Endpoint:** `/api/finance/internal-transfers`
- **Description:** Lists internal treasury transfers between payment methods/accounts.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `fromPaymentMethodId?, toPaymentMethodId?, status?, startDate?, endDate?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "TRF-001", "fromPaymentMethodId": "PM-BCA", "toPaymentMethodId": "PM-CASH", "amount": 5000000, "status": "COMPLETED" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `internal_transfers`
- **Related / Joined Tables:** `payment_methods, documents, kas_kantor`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins internal_transfers with payment_methods (source and destination) and documents.

---

## 66. [Finance] `POST /api/finance/internal-transfers`

### A. API Information
- **API Name:** Finance — `POST /api/finance/internal-transfers`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/internal-transfers`
- **Description:** Executes an atomic internal fund transfer between two distinct active payment methods, creating paired KELUAR and MASUK entries in Kas Kantor.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.transfer | finance.kasKantor.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "fromPaymentMethodId": string, "toPaymentMethodId": string, "amount": number, "adminFee"?: number, "transferDate"?: string, "notes"?: string, "proofDocId"?: string }`
- **Validation Rules:** createInternalTransferSchema: fromPaymentMethodId !== toPaymentMethodId, amount > 0, adminFee >= 0.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "TRF-001", "amount": 5000000, "status": "COMPLETED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `internal_transfers`
- **Related / Joined Tables:** `kas_kantor, pengeluaran, payment_methods, documents, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE (internal_transfers, kas_kantor [2 rows], pengeluaran [if adminFee > 0], audit_logs)**
- **Foreign Keys & Relational Mechanics:** Atomic double-entry transfer across internal_transfers and kas_kantor.

---

## 67. [Finance] `POST /api/finance/internal-transfers/:id/reverse`

### A. API Information
- **API Name:** Finance — `POST /api/finance/internal-transfers/:id/reverse`
- **Method:** `POST`
- **URL / Endpoint:** `/api/finance/internal-transfers/:id/reverse`
- **Description:** Reverses a completed internal transfer by creating a compensating reversal transfer and offsetting Kas Kantor entries.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.kasKantor.transfer | finance.kasKantor.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "reason": string }`
- **Validation Rules:** reason required; original transfer must not already be REVERSED.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "originalId": "TRF-001", "status": "REVERSED", "reversalTransferId": "TRF-002" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `internal_transfers`
- **Related / Joined Tables:** `kas_kantor, payment_methods, audit_logs`
- **CRUD Operations Performed:** **UPDATE (internal_transfers), CREATE (internal_transfers [reversal], kas_kantor, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Uses self-referencing column internal_transfers.reversal_ref_id -> internal_transfers.id.

---

## 68. [Messenger] `GET /api/messenger/my-tasks`

### A. API Information
- **API Name:** Messenger — `GET /api/messenger/my-tasks`
- **Method:** `GET`
- **URL / Endpoint:** `/api/messenger/my-tasks`
- **Description:** Returns active field tasks and assigned orders for the logged-in Messenger (or all tasks for Admin/SVP).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Messenger, Admin, SVP
  - **Dynamic RBAC Permission(s):** `tugasLapangan.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status?, messengerId?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Messenger role automatically scoped to own messengerId.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "TSK-001", "orderNo": "ORD-20261115-0001", "messengerId": "MSG-001", "status": "IN_PROGRESS" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_tasks`
- **Related / Joined Tables:** `orders, customers, vehicles, services, samsat_offices, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins messenger_tasks with orders, vehicles, samsat_offices, and messengers.

---

## 69. [Messenger] `GET /api/messenger/messengers`

### A. API Information
- **API Name:** Messenger — `GET /api/messenger/messengers`
- **Method:** `GET`
- **URL / Endpoint:** `/api/messenger/messengers`
- **Description:** Lists all field Messengers with employee profile, active status, and workload task counts.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `tugasLapangan.view | manajemenOrder.view | manajemenOrder.assignMessenger | finance.kasMessenger.view | reimbursement.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "MSG-001", "employeeId": "EMP-004", "name": "Andi Messenger", "activeTasks": 3 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messengers`
- **Related / Joined Tables:** `employees, users, messenger_tasks, orders`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins messengers with employees (employee_id) and counts active orders/tasks.

---

## 70. [Messenger] `GET /api/messenger/history`

### A. API Information
- **API Name:** Messenger — `GET /api/messenger/history`
- **Method:** `GET`
- **URL / Endpoint:** `/api/messenger/history`
- **Description:** Lists completed historical field tasks for the Messenger (or filtered by messengerId for Admin/SVP).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Messenger (Scoped)
  - **Dynamic RBAC Permission(s):** `tugasLapangan.view | riwayatTugas.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `messengerId?, startDate?, endDate?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Scoped to own messengerId if role is Messenger.

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "TSK-000", "orderNo": "ORD-20261110-0002", "status": "COMPLETED" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_tasks`
- **Related / Joined Tables:** `orders, vehicles, samsat_offices, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries completed messenger_tasks and completed orders assigned to messenger.

---

## 71. [Messenger] `GET /api/messenger/tasks/:orderNo`

### A. API Information
- **API Name:** Messenger — `GET /api/messenger/tasks/:orderNo`
- **Method:** `GET`
- **URL / Endpoint:** `/api/messenger/tasks/:orderNo`
- **Description:** Retrieves all messenger tasks and timeline stages for a specific order.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Messenger (Assigned)
  - **Dynamic RBAC Permission(s):** `tugasLapangan.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** orderNo required; Messenger must be assigned to the order.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "TSK-001", "taskType": "SAMSAT_PROSES", "status": "IN_PROGRESS" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_tasks`
- **Related / Joined Tables:** `orders, order_timeline_processes, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries messenger_tasks and order_timeline_processes WHERE order_no = :orderNo.

---

## 72. [Messenger] `GET /api/messenger/reimbursements`

### A. API Information
- **API Name:** Messenger — `GET /api/messenger/reimbursements`
- **Method:** `GET`
- **URL / Endpoint:** `/api/messenger/reimbursements`
- **Description:** Lists field reimbursement claims with approval/payment status and proof document metadata.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Scoped)
  - **Dynamic RBAC Permission(s):** `reimbursement.view | finance.kasMessenger.view | tugasLapangan.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `messengerId?, status? (PENDING|APPROVED|REJECTED|PAID|VOID), orderNo?, startDate?, endDate?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Messenger role only sees own reimbursements.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "RMB-001", "messengerId": "MSG-001", "amount": 150000, "status": "PENDING" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_reimbursements`
- **Related / Joined Tables:** `messengers, employees, orders, documents, pengeluaran, kas_messenger`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins messenger_reimbursements with messengers, employees, documents, and orders.

---

## 73. [Messenger] `POST /api/messenger/reimbursements`

### A. API Information
- **API Name:** Messenger — `POST /api/messenger/reimbursements`
- **Method:** `POST`
- **URL / Endpoint:** `/api/messenger/reimbursements`
- **Description:** Submits a new field expense reimbursement claim (parkir, tol, fotokopi, biaya lapangan) with optional receipt document.
- **Authentication Required:** Bearer JWT + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Messenger, Admin, SVP
  - **Dynamic RBAC Permission(s):** `reimbursement.create | tugasLapangan.reimbursement`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "messengerId"?: string, "orderNo"?: string, "category": string, "amount": number, "description": string, "expenseDate"?: string, "proofDocId"?: string }`
- **Validation Rules:** createReimbursementSchema: amount > 0, category & description required.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "RMB-002", "status": "PENDING", "amount": 75000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_reimbursements`
- **Related / Joined Tables:** `messengers, employees, orders, documents, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **CREATE (messenger_reimbursements, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into messenger_reimbursements with FK messenger_id -> messengers.id and proof_doc_id -> documents.id.

---

## 74. [Messenger] `PATCH /api/messenger/reimbursements/:id/review`

### A. API Information
- **API Name:** Messenger — `PATCH /api/messenger/reimbursements/:id/review`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/messenger/reimbursements/:id/review`
- **Description:** Reviews (approves or rejects) a pending Messenger reimbursement claim, with optional approved_amount adjustment.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `reimbursement.approve | reimbursement.reject | finance.kasMessenger.verify`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "status": "APPROVED" | "REJECTED", "approvedAmount"?: number, "rejectionReason"?: string, "notes"?: string }`
- **Validation Rules:** reviewReimbursementSchema: status in [APPROVED, REJECTED]; rejectionReason required if REJECTED.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "RMB-002", "status": "APPROVED", "approvedAmount": 75000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_reimbursements`
- **Related / Joined Tables:** `messengers, audit_logs`
- **CRUD Operations Performed:** **UPDATE (messenger_reimbursements), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates status, approved_amount, reviewed_by, reviewed_at on messenger_reimbursements.

---

## 75. [Messenger] `POST /api/messenger/reimbursements/:id/pay`

### A. API Information
- **API Name:** Messenger — `POST /api/messenger/reimbursements/:id/pay`
- **Method:** `POST`
- **URL / Endpoint:** `/api/messenger/reimbursements/:id/pay`
- **Description:** Disburses payment for an APPROVED reimbursement claim, creating linked entries in kas_messenger, pengeluaran, and kas_kantor.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC + Idempotency
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `reimbursement.pay | finance.kasMessenger.pay | finance.kasMessenger.create`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`, optional `X-Idempotency-Key`
- **Request Body & Data Types:** `{ "paymentMethodId": string, "paymentProofDocId"?: string, "notes"?: string, "paidDate"?: string }`
- **Validation Rules:** payReimbursementSchema: claim must be APPROVED (or PENDING with auto-approve), valid active paymentMethodId.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "RMB-002", "status": "PAID", "pengeluaranId": 21, "kasMessengerId": 14 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_reimbursements`
- **Related / Joined Tables:** `kas_messenger, pengeluaran, kas_kantor, payment_methods, documents, audit_logs, idempotency_keys`
- **CRUD Operations Performed:** **UPDATE (messenger_reimbursements), CREATE (kas_messenger, pengeluaran, kas_kantor, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Atomically updates messenger_reimbursements (status=PAID, pengeluaran_id, kas_messenger_id) and posts ledger entries.

---

## 76. [Messenger] `POST /api/messenger/reimbursements/:id/void`

### A. API Information
- **API Name:** Messenger — `POST /api/messenger/reimbursements/:id/void`
- **Method:** `POST`
- **URL / Endpoint:** `/api/messenger/reimbursements/:id/void`
- **Description:** Voids an approved or paid reimbursement claim and reverses linked Kas Messenger / Pengeluaran entries.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `reimbursement.void | finance.kasMessenger.delete`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "reason": string }`
- **Validation Rules:** reason required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "RMB-002", "status": "VOID" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_reimbursements`
- **Related / Joined Tables:** `kas_messenger, pengeluaran, kas_kantor, audit_logs`
- **CRUD Operations Performed:** **UPDATE (messenger_reimbursements), DELETE/CREATE (reversal in kas_messenger, pengeluaran, kas_kantor), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Marks reimbursement VOID and cleans up or reverses associated ledger postings.

---

## 77. [Messenger] `DELETE /api/messenger/reimbursements/:id`

### A. API Information
- **API Name:** Messenger — `DELETE /api/messenger/reimbursements/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/messenger/reimbursements/:id`
- **Description:** Deletes a PENDING/REJECTED reimbursement claim (blocks deletion if already PAID).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Messenger (Own PENDING only)
  - **Dynamic RBAC Permission(s):** `reimbursement.delete | tugasLapangan.reimbursement`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Cannot delete PAID claims without voiding first.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Reimbursement berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `messenger_reimbursements`
- **Related / Joined Tables:** `documents, audit_logs`
- **CRUD Operations Performed:** **DELETE (messenger_reimbursements), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes row from messenger_reimbursements.

---

## 78. [Documents] `POST /api/documents/upload`

### A. API Information
- **API Name:** Documents — `POST /api/documents/upload`
- **Method:** `POST`
- **URL / Endpoint:** `/api/documents/upload`
- **Description:** Uploads a document/image file (PDF, JPG, PNG, WEBP up to 10MB) to isolated storage and creates a metadata row in documents.
- **Authentication Required:** Bearer JWT + Dynamic RBAC (Multipart Upload)
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `Authenticated Session (Used across Order, Finance, Messenger proofs)`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `multipart/form-data: file (binary), category?, orderNo?, invoiceId?, description?`
- **Validation Rules:** Multer file filter (MIME + magic-byte validation, max size limit).

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 401 Unauthorized | 413 Payload Too Large`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "DOC-20261115-001", "fileName": "stnk.jpg", "mimeType": "image/jpeg", "size": 184320 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `orders, finance_invoices, users, audit_logs`
- **CRUD Operations Performed:** **CREATE (documents, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into documents with optional FK order_no -> orders.order_no and invoice_id -> finance_invoices.id.

---

## 79. [Documents] `GET /api/documents/order/:orderNo`

### A. API Information
- **API Name:** Documents — `GET /api/documents/order/:orderNo`
- **Method:** `GET`
- **URL / Endpoint:** `/api/documents/order/:orderNo`
- **Description:** Lists all uploaded documents linked to a specific orderNo.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Assigned)
  - **Dynamic RBAC Permission(s):** `manajemenOrder.view | tugasLapangan.view | arsip.view`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** orderNo required; checks Messenger assignment if role is Messenger.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "DOC-001", "orderNo": "ORD-20261115-0001", "category": "STNK" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `orders, order_documents`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries documents WHERE order_no = :orderNo AND is_deleted = 0.

---

## 80. [Documents] `GET /api/documents/invoice/:invoiceId`

### A. API Information
- **API Name:** Documents — `GET /api/documents/invoice/:invoiceId`
- **Method:** `GET`
- **URL / Endpoint:** `/api/documents/invoice/:invoiceId`
- **Description:** Lists all uploaded documents linked to a specific finance invoice.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `finance.belumBayar.view | finance.kasKantor.view | finance.cashback.view`

### B. Request Parameters
- **Path Parameters:** `invoiceId (number | string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** invoiceId required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "DOC-002", "invoiceId": 1, "category": "BUKTI_BAYAR" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `finance_invoices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries documents WHERE invoice_id = :invoiceId AND is_deleted = 0.

---

## 81. [Documents] `POST /api/documents/:id/ticket`

### A. API Information
- **API Name:** Documents — `POST /api/documents/:id/ticket`
- **Method:** `POST`
- **URL / Endpoint:** `/api/documents/:id/ticket`
- **Description:** Issues a short-lived, single-use or time-bounded ticket_code in document_tickets for secure browser preview/download.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Scoped)
  - **Dynamic RBAC Permission(s):** `Authenticated Session + Resource Ownership/Order Access`

### B. Request Parameters
- **Path Parameters:** `id (document ID)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "purpose"?: "PREVIEW" | "DOWNLOAD" }`
- **Validation Rules:** Verifies caller has access to the parent order/invoice/reimbursement of the document.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "ticket": "TKT-9f8a7b...", "expiresAt": "2026-11-15T07:05:00.000Z" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `document_tickets`
- **Related / Joined Tables:** `documents, users, orders`
- **CRUD Operations Performed:** **CREATE (document_tickets)**
- **Foreign Keys & Relational Mechanics:** Inserts into document_tickets with FK document_id -> documents.id and user_id -> users.id.

---

## 82. [Documents] `GET /api/documents/:id/preview`

### A. API Information
- **API Name:** Documents — `GET /api/documents/:id/preview`
- **Method:** `GET`
- **URL / Endpoint:** `/api/documents/:id/preview`
- **Description:** Streams the binary file inline (Content-Disposition: inline) for browser preview.
- **Authentication Required:** Bearer JWT OR Query Ticket (?ticket=...)
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `Valid JWT or valid unexpired document_tickets.ticket_code`

### B. Request Parameters
- **Path Parameters:** `id (document ID)`
- **Query Parameters:** `ticket? (string)`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Validates JWT or ticket_code against document_tickets (expires_at, document_id).

### C. Response Structure
- **HTTP Status Codes:** `200 OK (Binary Stream) | 401 Unauthorized | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
<Binary File Stream: image/jpeg | application/pdf>
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `document_tickets, orders`
- **CRUD Operations Performed:** **READ, UPDATE (document_tickets.used_at)**
- **Foreign Keys & Relational Mechanics:** Reads file path from documents and validates ticket in document_tickets.

---

## 83. [Documents] `GET /api/documents/:id/download`

### A. API Information
- **API Name:** Documents — `GET /api/documents/:id/download`
- **Method:** `GET`
- **URL / Endpoint:** `/api/documents/:id/download`
- **Description:** Streams the binary file as an attachment download (Content-Disposition: attachment).
- **Authentication Required:** Bearer JWT OR Query Ticket (?ticket=...)
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `Valid JWT or valid unexpired document_tickets.ticket_code`

### B. Request Parameters
- **Path Parameters:** `id (document ID)`
- **Query Parameters:** `ticket? (string)`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Validates JWT or ticket_code.

### C. Response Structure
- **HTTP Status Codes:** `200 OK (Binary Stream) | 401 Unauthorized | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
<Binary File Attachment>
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `document_tickets`
- **CRUD Operations Performed:** **READ, UPDATE (document_tickets.used_at)**
- **Foreign Keys & Relational Mechanics:** Reads file metadata from documents and streams file from UPLOAD_DIR.

---

## 84. [Documents] `GET /api/documents/:id`

### A. API Information
- **API Name:** Documents — `GET /api/documents/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/documents/:id`
- **Description:** Retrieves metadata JSON for a single document by ID.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger (Scoped)
  - **Dynamic RBAC Permission(s):** `Authenticated Session + Resource Access`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "DOC-001", "fileName": "ktp.jpg", "mimeType": "image/jpeg" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `orders, finance_invoices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries documents WHERE id = :id AND is_deleted = 0.

---

## 85. [Documents] `PATCH /api/documents/:id/link-order`

### A. API Information
- **API Name:** Documents — `PATCH /api/documents/:id/link-order`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/documents/:id/link-order`
- **Description:** Links an already-uploaded document to an order_no and/or invoice_id.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `manajemenOrder.edit | manajemenOrder.create | tugasLapangan.updateStatus`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "orderNo"?: string, "invoiceId"?: number, "category"?: string }`
- **Validation Rules:** At least one of orderNo or invoiceId required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "DOC-001", "orderNo": "ORD-20261115-0001" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `orders, finance_invoices, audit_logs`
- **CRUD Operations Performed:** **UPDATE (documents), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates documents.order_no and/or documents.invoice_id.

---

## 86. [Documents] `DELETE /api/documents/:id`

### A. API Information
- **API Name:** Documents — `DELETE /api/documents/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/documents/:id`
- **Description:** Soft-deletes a document (is_deleted = 1) and schedules physical file cleanup via file_deletion_jobs if unreferenced.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `manajemenOrder.edit | finance.kasKantor.delete`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Blocks deletion if document is locked as proof on a verified payment/reimbursement.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Dokumen berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `documents`
- **Related / Joined Tables:** `file_deletion_jobs, document_tickets, invoice_payments, messenger_reimbursements, audit_logs`
- **CRUD Operations Performed:** **UPDATE (documents), CREATE (file_deletion_jobs, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Marks documents.is_deleted = 1 and enqueues physical file removal in file_deletion_jobs.

---

## 87. [Services] `GET /api/services`

### A. API Information
- **API Name:** Services — `GET /api/services`
- **Method:** `GET`
- **URL / Endpoint:** `/api/services`
- **Description:** Lists all biro jasa services (Perpanjangan STNK, Balik Nama, Mutasi, etc.) with active status and base fees.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `masterLayanan.view | manajemenOrder.view | manajemenOrder.create | kalkulator.view | biayaLayanan.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status?, kategori?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "SRV-01", "kodeLayanan": "STNK-1TH", "namaLayanan": "Perpanjangan STNK 1 Tahun", "status": "Aktif" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `services`
- **Related / Joined Tables:** `service_pricing_configs`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads all rows from services.

---

## 88. [Services] `GET /api/services/:id`

### A. API Information
- **API Name:** Services — `GET /api/services/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/services/:id`
- **Description:** Retrieves a single service definition by ID or kode_layanan.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `masterLayanan.view | manajemenOrder.view | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SRV-01", "kodeLayanan": "STNK-1TH", "namaLayanan": "Perpanjangan STNK 1 Tahun" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `services`
- **Related / Joined Tables:** `service_pricing_configs`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads services by PK id.

---

## 89. [Services] `PUT /api/services/:id`

### A. API Information
- **API Name:** Services — `PUT /api/services/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/services/:id`
- **Description:** Updates a service definition (name, description, required documents, base fee, or active status).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `masterLayanan.edit | biayaLayanan.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "namaLayanan"?: string, "kategori"?: string, "biayaJasaDefault"?: number, "estimasiHari"?: number, "syaratDokumen"?: string[], "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** updateServiceSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SRV-01", "biayaJasaDefault": 150000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `services`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (services), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates services row by PK id.

---

## 90. [Services] `DELETE /api/services/:id`

### A. API Information
- **API Name:** Services — `DELETE /api/services/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/services/:id`
- **Description:** Deletes or deactivates a service if not referenced by existing orders.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `masterLayanan.delete`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Blocks hard deletion if orders reference service_id (ON DELETE RESTRICT).

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Layanan berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `services`
- **Related / Joined Tables:** `orders, service_pricing_configs, samsat_operational_tariffs, audit_logs`
- **CRUD Operations Performed:** **DELETE (services), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes from services; cascades to service_pricing_configs/samsat_operational_tariffs if no orders exist.

---

## 91. [Pricing] `GET /api/pricing/effective`

### A. API Information
- **API Name:** Pricing — `GET /api/pricing/effective`
- **Method:** `GET`
- **URL / Endpoint:** `/api/pricing/effective`
- **Description:** Computes the effective combined pricing (service fee + Samsat operational tariffs + base Samsat items) for a given serviceId, samsatId, and vehicle type.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `biayaLayanan.view | hargaSamsat.view | kalkulator.view | manajemenOrder.create | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `serviceId (string), samsatId (string), vehicleType? (Motor|Mobil)`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** serviceId and samsatId query parameters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request`
- **Success Response Example:**
```json
{ "success": true, "data": { "serviceId": "SRV-01", "samsatId": "SMS-01", "biayaJasa": 150000, "operationalTariffs": [] } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `service_pricing_configs`
- **Related / Joined Tables:** `services, samsat_offices, samsat_pricing, samsat_operational_tariffs`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins service_pricing_configs, samsat_operational_tariffs, samsat_pricing, services, and samsat_offices.

---

## 92. [Pricing] `GET /api/pricing/samsat`

### A. API Information
- **API Name:** Pricing — `GET /api/pricing/samsat`
- **Method:** `GET`
- **URL / Endpoint:** `/api/pricing/samsat`
- **Description:** Lists all master Samsat pricing components (samsat_pricing).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `hargaSamsat.view | biayaLayanan.view | kalkulator.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `kategori?, jenisKendaraan?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "SP-01", "namaKomponen": "Cek Fisik Bantuan", "hargaMotor": 50000, "hargaMobil": 100000 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_pricing`
- **Related / Joined Tables:** `samsat_operational_tariffs`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads samsat_pricing rows.

---

## 93. [Pricing] `GET /api/pricing/samsat/:id`

### A. API Information
- **API Name:** Pricing — `GET /api/pricing/samsat/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/pricing/samsat/:id`
- **Description:** Retrieves a single Samsat pricing component by ID.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `hargaSamsat.view | biayaLayanan.view | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SP-01", "namaKomponen": "Cek Fisik Bantuan" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_pricing`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads samsat_pricing WHERE id = :id.

---

## 94. [Pricing] `PUT /api/pricing/samsat/:id`

### A. API Information
- **API Name:** Pricing — `PUT /api/pricing/samsat/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/pricing/samsat/:id`
- **Description:** Updates a master Samsat pricing component.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `hargaSamsat.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "namaKomponen"?: string, "hargaMotor"?: number, "hargaMobil"?: number, "status"?: string }`
- **Validation Rules:** updateSamsatPricingSchema: prices >= 0.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SP-01", "hargaMotor": 60000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_pricing`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (samsat_pricing), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates samsat_pricing by PK id.

---

## 95. [Pricing] `GET /api/pricing/services`

### A. API Information
- **API Name:** Pricing — `GET /api/pricing/services`
- **Method:** `GET`
- **URL / Endpoint:** `/api/pricing/services`
- **Description:** Lists all Service × Samsat pricing configurations (service_pricing_configs).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `biayaLayanan.view | kalkulator.view | manajemenOrder.create | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `serviceId?, samsatId?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "SRV-01:SMS-01", "serviceId": "SRV-01", "samsatId": "SMS-01", "biayaJasaMotor": 120000, "biayaJasaMobil": 180000 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `service_pricing_configs`
- **Related / Joined Tables:** `services, samsat_offices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries service_pricing_configs joined with services and samsat_offices.

---

## 96. [Pricing] `POST /api/pricing/services/batch-replicate`

### A. API Information
- **API Name:** Pricing — `POST /api/pricing/services/batch-replicate`
- **Method:** `POST`
- **URL / Endpoint:** `/api/pricing/services/batch-replicate`
- **Description:** Replicates service pricing configurations from one source Samsat office across multiple target Samsat offices in batch.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `biayaLayanan.edit | biayaLayanan.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "sourceSamsatId": string, "targetSamsatIds": string[], "serviceIds"?: string[], "overwrite"?: boolean }`
- **Validation Rules:** sourceSamsatId and non-empty targetSamsatIds required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request`
- **Success Response Example:**
```json
{ "success": true, "replicatedCount": 24 }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `service_pricing_configs`
- **Related / Joined Tables:** `services, samsat_offices, audit_logs`
- **CRUD Operations Performed:** **CREATE / UPDATE (service_pricing_configs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Batch upserts service_pricing_configs rows in a transaction.

---

## 97. [Pricing] `POST /api/pricing/services`

### A. API Information
- **API Name:** Pricing — `POST /api/pricing/services`
- **Method:** `POST`
- **URL / Endpoint:** `/api/pricing/services`
- **Description:** Creates or upserts a Service × Samsat pricing configuration in service_pricing_configs.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `biayaLayanan.create | biayaLayanan.edit`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "serviceId": string, "samsatId": string, "biayaJasaMotor": number, "biayaJasaMobil": number, "biayaTambahan"?: number, "keterangan"?: string }`
- **Validation Rules:** serviceId, samsatId required; fees >= 0.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 200 OK | 400 Bad Request`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SRV-01:SMS-01", "biayaJasaMotor": 120000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `service_pricing_configs`
- **Related / Joined Tables:** `services, samsat_offices, audit_logs`
- **CRUD Operations Performed:** **CREATE / UPDATE (service_pricing_configs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Upserts service_pricing_configs with composite key id = "${serviceId}:${samsatId}".

---

## 98. [Pricing] `PUT /api/pricing/services/:id`

### A. API Information
- **API Name:** Pricing — `PUT /api/pricing/services/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/pricing/services/:id`
- **Description:** Updates a specific Service × Samsat pricing configuration by ID.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `biayaLayanan.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "biayaJasaMotor"?: number, "biayaJasaMobil"?: number, "biayaTambahan"?: number, "status"?: string }`
- **Validation Rules:** Fee amounts >= 0.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SRV-01:SMS-01", "biayaJasaMotor": 130000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `service_pricing_configs`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (service_pricing_configs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates service_pricing_configs by PK id.

---

## 99. [Pricing] `DELETE /api/pricing/services/:id`

### A. API Information
- **API Name:** Pricing — `DELETE /api/pricing/services/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/pricing/services/:id`
- **Description:** Deletes a Service × Samsat pricing configuration by ID.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `biayaLayanan.delete | biayaLayanan.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "message": "Konfigurasi harga layanan dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `service_pricing_configs`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **DELETE (service_pricing_configs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes from service_pricing_configs WHERE id = :id.

---

## 100. [Pricing] `GET /api/pricing/samsat-tariffs`

### A. API Information
- **API Name:** Pricing — `GET /api/pricing/samsat-tariffs`
- **Method:** `GET`
- **URL / Endpoint:** `/api/pricing/samsat-tariffs`
- **Description:** Lists Samsat operational tariff overrides (samsat_operational_tariffs) filtered by samsatId or serviceId.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `hargaSamsat.view | biayaLayanan.view | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `samsatId?, serviceId?, kodeKabupatenKota?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "SOT-01", "samsatId": "SMS-01", "pricingItemId": "SP-01", "tarifMotor": 55000, "tarifMobil": 110000 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_operational_tariffs`
- **Related / Joined Tables:** `samsat_offices, samsat_pricing, services, wilayah_administratif`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins samsat_operational_tariffs with samsat_offices, samsat_pricing, services, and wilayah_administratif.

---

## 101. [Pricing] `PUT /api/pricing/samsat-tariffs`

### A. API Information
- **API Name:** Pricing — `PUT /api/pricing/samsat-tariffs`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/pricing/samsat-tariffs`
- **Description:** Upserts one or more Samsat operational tariff overrides in samsat_operational_tariffs.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `hargaSamsat.edit | biayaLayanan.edit`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "samsatId": string, "pricingItemId": string, "serviceId"?: string, "tarifMotor": number, "tarifMobil": number } (or array of items)`
- **Validation Rules:** samsatId, pricingItemId, and non-negative tariff amounts required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SOT-01", "tarifMotor": 55000 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_operational_tariffs`
- **Related / Joined Tables:** `samsat_offices, samsat_pricing, services, wilayah_administratif, audit_logs`
- **CRUD Operations Performed:** **CREATE / UPDATE (samsat_operational_tariffs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Upserts samsat_operational_tariffs using UNIQUE(samsat_id, pricing_item_id).

---

## 102. [Pricing] `POST /api/pricing/samsat-tariffs`

### A. API Information
- **API Name:** Pricing — `POST /api/pricing/samsat-tariffs`
- **Method:** `POST`
- **URL / Endpoint:** `/api/pricing/samsat-tariffs`
- **Description:** POST alias to create/upsert Samsat operational tariff overrides.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `hargaSamsat.edit | biayaLayanan.edit`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "samsatId": string, "pricingItemId": string, "tarifMotor": number, "tarifMobil": number }`
- **Validation Rules:** Same as PUT /api/pricing/samsat-tariffs.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 200 OK | 400 Bad Request`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SOT-01" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_operational_tariffs`
- **Related / Joined Tables:** `samsat_offices, samsat_pricing, audit_logs`
- **CRUD Operations Performed:** **CREATE / UPDATE (samsat_operational_tariffs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Same upsert logic as PUT /api/pricing/samsat-tariffs.

---

## 103. [Pricing] `DELETE /api/pricing/samsat-tariffs`

### A. API Information
- **API Name:** Pricing — `DELETE /api/pricing/samsat-tariffs`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/pricing/samsat-tariffs`
- **Description:** Deletes Samsat operational tariff overrides by composite query/body filter (samsatId + pricingItemId).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `hargaSamsat.edit | biayaLayanan.delete`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `samsatId?, pricingItemId?, id?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Requires id or (samsatId + pricingItemId).

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "message": "Tarif operasional Samsat dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_operational_tariffs`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **DELETE (samsat_operational_tariffs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes matching row(s) from samsat_operational_tariffs.

---

## 104. [Pricing] `DELETE /api/pricing/samsat-tariffs/:id`

### A. API Information
- **API Name:** Pricing — `DELETE /api/pricing/samsat-tariffs/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/pricing/samsat-tariffs/:id`
- **Description:** Deletes a specific Samsat operational tariff override by primary key ID.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `hargaSamsat.edit | biayaLayanan.delete`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "message": "Tarif operasional Samsat dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_operational_tariffs`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **DELETE (samsat_operational_tariffs), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes from samsat_operational_tariffs WHERE id = :id.

---

## 105. [Estimation] `GET /api/estimation/templates`

### A. API Information
- **API Name:** Estimation — `GET /api/estimation/templates`
- **Method:** `GET`
- **URL / Endpoint:** `/api/estimation/templates`
- **Description:** Lists all SLA estimation templates (estimation_templates).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `aturanEstimasi.view | kalkulator.view | manajemenOrder.view | manajemenOrder.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "EST-01", "serviceName": "Perpanjangan 1 Tahun", "minDays": 1, "maxDays": 2 } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `estimation_templates`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads all rows from estimation_templates.

---

## 106. [Estimation] `GET /api/estimation/templates/:id`

### A. API Information
- **API Name:** Estimation — `GET /api/estimation/templates/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/estimation/templates/:id`
- **Description:** Retrieves a single estimation template by ID.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `aturanEstimasi.view | kalkulator.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "EST-01", "minDays": 1, "maxDays": 2 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `estimation_templates`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads estimation_templates WHERE id = :id.

---

## 107. [Estimation] `PUT /api/estimation/templates/:id`

### A. API Information
- **API Name:** Estimation — `PUT /api/estimation/templates/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/estimation/templates/:id`
- **Description:** Updates an SLA estimation template (duration days, process steps, notes).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `aturanEstimasi.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "minDays"?: number, "maxDays"?: number, "processSteps"?: string[], "notes"?: string }`
- **Validation Rules:** updateEstimationTemplateSchema: minDays >= 0, maxDays >= minDays.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "EST-01", "minDays": 1, "maxDays": 3 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `estimation_templates`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (estimation_templates), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates estimation_templates by PK id.

---

## 108. [Estimation] `POST /api/estimation/templates/:id/reset`

### A. API Information
- **API Name:** Estimation — `POST /api/estimation/templates/:id/reset`
- **Method:** `POST`
- **URL / Endpoint:** `/api/estimation/templates/:id/reset`
- **Description:** Resets a single estimation template back to factory default SLA parameters.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `aturanEstimasi.edit | aturanEstimasi.reset`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id must match a known default template.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "EST-01", "reset": true } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `estimation_templates`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (estimation_templates), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Restores default values for estimation_templates row.

---

## 109. [Estimation] `POST /api/estimation/reset-all`

### A. API Information
- **API Name:** Estimation — `POST /api/estimation/reset-all`
- **Method:** `POST`
- **URL / Endpoint:** `/api/estimation/reset-all`
- **Description:** Resets all estimation templates in estimation_templates back to factory defaults.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `aturanEstimasi.edit | aturanEstimasi.reset`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "message": "Seluruh template estimasi berhasil direset" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `estimation_templates`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE / CREATE (estimation_templates), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Re-applies default seed values across estimation_templates.

---

## 110. [Wilayah & Samsat] `GET /api/wilayah`

### A. API Information
- **API Name:** Wilayah & Samsat — `GET /api/wilayah`
- **Method:** `GET`
- **URL / Endpoint:** `/api/wilayah`
- **Description:** Lists administrative regions (Kabupaten/Kota & Provinsi) in wilayah_administratif.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `wilayahSamsat.view | hargaSamsat.view | biayaLayanan.view | manajemenOrder.view | manajemenOrder.create | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `provinsi?, search?, status?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "kodeKabupatenKota": "31.74", "namaKabupatenKota": "Kota Adm. Jakarta Selatan", "provinsi": "DKI Jakarta" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `wilayah_administratif`
- **Related / Joined Tables:** `samsat_offices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries wilayah_administratif and optionally includes linked samsat_offices.

---

## 111. [Wilayah & Samsat] `GET /api/wilayah/provinces`

### A. API Information
- **API Name:** Wilayah & Samsat — `GET /api/wilayah/provinces`
- **Method:** `GET`
- **URL / Endpoint:** `/api/wilayah/provinces`
- **Description:** Lists distinct provinces from wilayah_administratif.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `wilayahSamsat.view | manajemenOrder.view | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ "DKI Jakarta", "Jawa Barat", "Banten" ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `wilayah_administratif`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Executes SELECT DISTINCT nama_provinsi FROM wilayah_administratif.

---

## 112. [Wilayah & Samsat] `GET /api/wilayah/:kode`

### A. API Information
- **API Name:** Wilayah & Samsat — `GET /api/wilayah/:kode`
- **Method:** `GET`
- **URL / Endpoint:** `/api/wilayah/:kode`
- **Description:** Retrieves a single administrative region by kode_kabupaten_kota along with its Samsat offices.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `wilayahSamsat.view | manajemenOrder.view | kalkulator.view`

### B. Request Parameters
- **Path Parameters:** `kode (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** kode required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "kodeKabupatenKota": "31.74", "samsatOffices": [] } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `wilayah_administratif`
- **Related / Joined Tables:** `samsat_offices`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads wilayah_administratif by PK kode_kabupaten_kota and joins samsat_offices.

---

## 113. [Wilayah & Samsat] `GET /api/samsat/offices`

### A. API Information
- **API Name:** Wilayah & Samsat — `GET /api/samsat/offices`
- **Method:** `GET`
- **URL / Endpoint:** `/api/samsat/offices`
- **Description:** Lists all Samsat offices (samsat_offices) with administrative region details.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `wilayahSamsat.view | hargaSamsat.view | biayaLayanan.view | manajemenOrder.view | manajemenOrder.create | kalkulator.view | tugasLapangan.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `kodeKabupatenKota?, provinsi?, status?, search?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "SMS-JKS", "namaSamsat": "Samsat Jakarta Selatan", "kodeKabupatenKota": "31.74", "status": "Aktif" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_offices`
- **Related / Joined Tables:** `wilayah_administratif`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins samsat_offices with wilayah_administratif on kode_kabupaten_kota.

---

## 114. [Wilayah & Samsat] `POST /api/samsat/offices`

### A. API Information
- **API Name:** Wilayah & Samsat — `POST /api/samsat/offices`
- **Method:** `POST`
- **URL / Endpoint:** `/api/samsat/offices`
- **Description:** Creates a new Samsat office in samsat_offices (auto-ensuring parent wilayah_administratif exists).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `wilayahSamsat.create | wilayahSamsat.edit`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "namaSamsat": string, "kodeGerai"?: string, "kodeKabupatenKota": string, "alamat"?: string, "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** createSamsatOfficeSchema: namaSamsat and kodeKabupatenKota required.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SMS-DPK", "namaSamsat": "Samsat Depok" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_offices`
- **Related / Joined Tables:** `wilayah_administratif, service_pricing_configs, audit_logs`
- **CRUD Operations Performed:** **CREATE (samsat_offices, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into samsat_offices with FK kode_kabupaten_kota -> wilayah_administratif.kode_kabupaten_kota.

---

## 115. [Wilayah & Samsat] `PUT /api/samsat/offices/:id`

### A. API Information
- **API Name:** Wilayah & Samsat — `PUT /api/samsat/offices/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/samsat/offices/:id`
- **Description:** Updates an existing Samsat office in samsat_offices.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `wilayahSamsat.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "namaSamsat"?: string, "kodeGerai"?: string, "kodeKabupatenKota"?: string, "alamat"?: string, "status"?: string }`
- **Validation Rules:** updateSamsatOfficeSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "SMS-DPK", "status": "Aktif" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_offices`
- **Related / Joined Tables:** `wilayah_administratif, audit_logs`
- **CRUD Operations Performed:** **UPDATE (samsat_offices), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates samsat_offices by PK id.

---

## 116. [Wilayah & Samsat] `DELETE /api/samsat/offices/:id`

### A. API Information
- **API Name:** Wilayah & Samsat — `DELETE /api/samsat/offices/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/samsat/offices/:id`
- **Description:** Deletes a Samsat office if not referenced by existing orders.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `wilayahSamsat.delete`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Blocks deletion with 409 Conflict if orders reference samsat_id.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Kantor Samsat berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_offices`
- **Related / Joined Tables:** `orders, samsat_operational_tariffs, service_pricing_configs, audit_logs`
- **CRUD Operations Performed:** **DELETE (samsat_offices), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes from samsat_offices; cascades to samsat_operational_tariffs.

---

## 117. [Payment Methods] `GET /api/payment-methods`

### A. API Information
- **API Name:** Payment Methods — `GET /api/payment-methods`
- **Method:** `GET`
- **URL / Endpoint:** `/api/payment-methods`
- **Description:** Lists configured payment methods/accounts (Bank Transfer, Cash, E-Wallet, QRIS).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `metodePembayaran.view | manajemenOrder.view | manajemenOrder.create | finance.kasKantor.view | finance.kasMessenger.view | finance.belumBayar.view | finance.cashback.view | reimbursement.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status? (Aktif|Nonaktif), tipe?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "PM-BCA", "namaMetode": "Bank BCA", "nomorRekening": "1234567890", "atasNama": "PT SUN Biro Jasa", "status": "Aktif" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `payment_methods`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads rows from payment_methods.

---

## 118. [Payment Methods] `GET /api/payment-methods/:id`

### A. API Information
- **API Name:** Payment Methods — `GET /api/payment-methods/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/payment-methods/:id`
- **Description:** Retrieves a single payment method by ID.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `metodePembayaran.view | finance.kasKantor.view | manajemenOrder.view`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "PM-BCA", "namaMetode": "Bank BCA" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `payment_methods`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads payment_methods WHERE id = :id.

---

## 119. [Payment Methods] `POST /api/payment-methods`

### A. API Information
- **API Name:** Payment Methods — `POST /api/payment-methods`
- **Method:** `POST`
- **URL / Endpoint:** `/api/payment-methods`
- **Description:** Creates a new payment method/account (enforces unique bank+account number and unique cash method name).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `metodePembayaran.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "namaMetode": string, "tipe": "Transfer Bank" | "Tunai" | "E-Wallet" | "QRIS", "nomorRekening"?: string, "atasNama"?: string, "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** createPaymentMethodSchema: namaMetode and tipe required.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "PM-MANDIRI", "namaMetode": "Bank Mandiri" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `payment_methods`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **CREATE (payment_methods, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into payment_methods (guarded by partial unique indexes idx_payment_methods_unique_bank_account and idx_payment_methods_unique_non_account).

---

## 120. [Payment Methods] `PUT /api/payment-methods/:id`

### A. API Information
- **API Name:** Payment Methods — `PUT /api/payment-methods/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/payment-methods/:id`
- **Description:** Updates an existing payment method.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `metodePembayaran.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "namaMetode"?: string, "tipe"?: string, "nomorRekening"?: string, "atasNama"?: string, "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** updatePaymentMethodSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "PM-MANDIRI", "status": "Aktif" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `payment_methods`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (payment_methods), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates payment_methods by PK id.

---

## 121. [Payment Methods] `PATCH /api/payment-methods/:id/status`

### A. API Information
- **API Name:** Payment Methods — `PATCH /api/payment-methods/:id/status`
- **Method:** `PATCH`
- **URL / Endpoint:** `/api/payment-methods/:id/status`
- **Description:** Toggles or sets the active status (Aktif / Nonaktif) of a payment method.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `metodePembayaran.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "status": "Aktif" | "Nonaktif" }`
- **Validation Rules:** status in [Aktif, Nonaktif].

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "PM-MANDIRI", "status": "Nonaktif" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `payment_methods`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE (payment_methods), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates payment_methods.status.

---

## 122. [Payment Methods] `DELETE /api/payment-methods/:id`

### A. API Information
- **API Name:** Payment Methods — `DELETE /api/payment-methods/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/payment-methods/:id`
- **Description:** Deletes a payment method if not referenced by any financial transactions (invoices, payments, kas_kantor, pengeluaran, transfers).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `metodePembayaran.delete`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Blocks deletion with 409 Conflict if referenced by financial history.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Metode pembayaran berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `payment_methods`
- **Related / Joined Tables:** `finance_invoices, invoice_payments, kas_kantor, pengeluaran, internal_transfers, audit_logs`
- **CRUD Operations Performed:** **DELETE (payment_methods), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes from payment_methods if unreferenced.

---

## 123. [Users] `GET /api/users`

### A. API Information
- **API Name:** Users — `GET /api/users`
- **Method:** `GET`
- **URL / Endpoint:** `/api/users`
- **Description:** Lists all internal user accounts joined with their employee profile.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenUser.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `role?, status?, search?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": 1, "employeeId": "EMP-001", "name": "Admin Utama", "email": "admin@sun89.com", "role": "Admin", "status": "Aktif" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Joins users with employees on employee_id.

---

## 124. [Users] `GET /api/users/:id`

### A. API Information
- **API Name:** Users — `GET /api/users/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/users/:id`
- **Description:** Retrieves a single user account by numeric ID or employee_id.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenUser.view`

### B. Request Parameters
- **Path Parameters:** `id (number | string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 1, "employeeId": "EMP-001", "role": "Admin" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads users row and joins employees.

---

## 125. [Users] `POST /api/users`

### A. API Information
- **API Name:** Users — `POST /api/users`
- **Method:** `POST`
- **URL / Endpoint:** `/api/users`
- **Description:** Creates a new user account linked to an employee (and auto-provisions a messengers row if role is Messenger).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenUser.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "employeeId": string, "name": string, "email": string, "password": string, "role": "Admin" | "SVP" | "Finance" | "Messenger", "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** createUserSchema: unique email & employeeId, strong password, valid role.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 5, "employeeId": "EMP-005", "role": "Finance" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers, audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **CREATE (users, employees if needed, messengers if Messenger, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into users with FK employee_id -> employees.id.

---

## 126. [Users] `PUT /api/users/:id`

### A. API Information
- **API Name:** Users — `PUT /api/users/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/users/:id`
- **Description:** Updates user role, email, status, or profile; increments token_version on role/status change to enforce immediate session re-evaluation.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenUser.edit`

### B. Request Parameters
- **Path Parameters:** `id (number | string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "name"?: string, "email"?: string, "role"?: string, "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** updateUserSchema; prevents deactivating or demoting the last active Admin.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": 5, "role": "SVP", "status": "Aktif" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers, audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **UPDATE (users, employees, messengers), CREATE (audit_logs, security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates users and syncs role/status with employees and messengers.

---

## 127. [Users] `DELETE /api/users/:id`

### A. API Information
- **API Name:** Users — `DELETE /api/users/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/users/:id`
- **Description:** Deactivates or deletes a user account (prevents self-deletion and deletion of the last active Admin).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenUser.delete`

### B. Request Parameters
- **Path Parameters:** `id (number | string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Cannot delete own account or last active Admin.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "User berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers, document_tickets, audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **DELETE / UPDATE (users), CREATE (audit_logs, security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Removes or deactivates user account while preserving historical audit trail.

---

## 128. [Users] `POST /api/users/:id/reset-password`

### A. API Information
- **API Name:** Users — `POST /api/users/:id/reset-password`
- **Method:** `POST`
- **URL / Endpoint:** `/api/users/:id/reset-password`
- **Description:** Administratively resets a user password and increments token_version to revoke active sessions.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `manajemenUser.resetPassword | manajemenUser.edit`

### B. Request Parameters
- **Path Parameters:** `id (number | string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "newPassword": string }`
- **Validation Rules:** resetPasswordSchema: newPassword min 8 chars.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "message": "Password user berhasil direset" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **UPDATE (users.password_hash, users.token_version), CREATE (audit_logs, security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates password_hash and increments token_version on users.

---

## 129. [Users] `GET /api/users/:id/permanent-erasure-preflight`

### A. API Information
- **API Name:** Users — `GET /api/users/:id/permanent-erasure-preflight`
- **Method:** `GET`
- **URL / Endpoint:** `/api/users/:id/permanent-erasure-preflight`
- **Description:** Runs a preflight impact analysis before permanently erasing a user/employee (checks orders, tasks, reimbursements, and ledger references).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin
  - **Dynamic RBAC Permission(s):** `manajemenUser.delete`

### B. Request Parameters
- **Path Parameters:** `id (number | string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Admin role required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "canErase": true, "affectedRecords": { "orders": 0, "reimbursements": 0, "documents": 1 } } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers, orders, messenger_tasks, messenger_reimbursements, documents, document_tickets`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Inspects foreign key dependencies across all user/messenger-linked tables.

---

## 130. [Users] `POST /api/users/:id/permanent-erasure`

### A. API Information
- **API Name:** Users — `POST /api/users/:id/permanent-erasure`
- **Method:** `POST`
- **URL / Endpoint:** `/api/users/:id/permanent-erasure`
- **Description:** Executes irreversible GDPR/permanent erasure of an eligible user account, anonymizing historical references and scheduling file deletion jobs.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin
  - **Dynamic RBAC Permission(s):** `manajemenUser.delete`

### B. Request Parameters
- **Path Parameters:** `id (number | string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "confirmText": string, "reason": string }`
- **Validation Rules:** Requires confirmation token/text and passes preflight checks.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Data pengguna dihapus permanen" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `users`
- **Related / Joined Tables:** `employees, messengers, document_tickets, file_deletion_jobs, security_audit_logs, audit_logs`
- **CRUD Operations Performed:** **DELETE (users, messengers, document_tickets), UPDATE (employees/orders anonymization), CREATE (file_deletion_jobs, security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Transactional erasure + file cleanup job scheduling in file_deletion_jobs.

---

## 131. [Users] `POST /api/users/file-deletion-jobs/:jobId/retry`

### A. API Information
- **API Name:** Users — `POST /api/users/file-deletion-jobs/:jobId/retry`
- **Method:** `POST`
- **URL / Endpoint:** `/api/users/file-deletion-jobs/:jobId/retry`
- **Description:** Retries a failed asynchronous physical file deletion job in file_deletion_jobs.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin
  - **Dynamic RBAC Permission(s):** `manajemenUser.delete`

### B. Request Parameters
- **Path Parameters:** `jobId (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** jobId must exist in file_deletion_jobs.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "FDJ-001", "status": "COMPLETED" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `file_deletion_jobs`
- **Related / Joined Tables:** `security_audit_logs`
- **CRUD Operations Performed:** **UPDATE (file_deletion_jobs), CREATE (security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Attempts fs.unlink on target_path and updates file_deletion_jobs.status & attempts.

---

## 132. [Employees] `GET /api/employees`

### A. API Information
- **API Name:** Employees — `GET /api/employees`
- **Method:** `GET`
- **URL / Endpoint:** `/api/employees`
- **Description:** Lists all employee master records (employees) with linked user account status and messenger profile.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `dataPegawai.view | manajemenUser.view | tugasLapangan.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `divisi?, jabatan?, status?, search?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "EMP-001", "nama": "Admin Utama", "jabatan": "Administrator", "status": "Aktif" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `employees`
- **Related / Joined Tables:** `users, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Left joins employees with users and messengers on employee_id.

---

## 133. [Employees] `GET /api/employees/next-id`

### A. API Information
- **API Name:** Employees — `GET /api/employees/next-id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/employees/next-id`
- **Description:** Generates the next sequential employee ID (e.g. EMP-009).
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `dataPegawai.create | manajemenUser.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK`
- **Success Response Example:**
```json
{ "success": true, "data": { "nextId": "EMP-009" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `employees`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries MAX(id) pattern from employees.

---

## 134. [Employees] `GET /api/employees/:id`

### A. API Information
- **API Name:** Employees — `GET /api/employees/:id`
- **Method:** `GET`
- **URL / Endpoint:** `/api/employees/:id`
- **Description:** Retrieves a single employee record by ID.
- **Authentication Required:** Bearer JWT + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance
  - **Dynamic RBAC Permission(s):** `dataPegawai.view | manajemenUser.view`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** id required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "EMP-001", "nama": "Admin Utama" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `employees`
- **Related / Joined Tables:** `users, messengers`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads employees by PK id.

---

## 135. [Employees] `POST /api/employees`

### A. API Information
- **API Name:** Employees — `POST /api/employees`
- **Method:** `POST`
- **URL / Endpoint:** `/api/employees`
- **Description:** Creates a new employee record in employees (and syncs messengers if jabatan/divisi is Messenger).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `dataPegawai.create`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "id"?: string, "nama": string, "email"?: string, "noHp"?: string, "jabatan": string, "divisi": string, "tanggalMasuk"?: string, "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** createEmployeeSchema: nama, jabatan, divisi required.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "EMP-009", "nama": "Rina Finance" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `employees`
- **Related / Joined Tables:** `messengers, users, audit_logs`
- **CRUD Operations Performed:** **CREATE (employees, messengers if Messenger, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into employees and optionally messengers.

---

## 136. [Employees] `PUT /api/employees/:id`

### A. API Information
- **API Name:** Employees — `PUT /api/employees/:id`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/employees/:id`
- **Description:** Updates an employee record and synchronizes name/status with linked users and messengers rows.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `dataPegawai.edit`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "nama"?: string, "email"?: string, "noHp"?: string, "jabatan"?: string, "divisi"?: string, "status"?: "Aktif" | "Nonaktif" }`
- **Validation Rules:** updateEmployeeSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "EMP-009", "status": "Aktif" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `employees`
- **Related / Joined Tables:** `users, messengers, audit_logs`
- **CRUD Operations Performed:** **UPDATE (employees, users, messengers), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Updates employees and propagates status/name changes to linked users and messengers.

---

## 137. [Employees] `DELETE /api/employees/:id`

### A. API Information
- **API Name:** Employees — `DELETE /api/employees/:id`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/employees/:id`
- **Description:** Deletes an employee record if not constrained by active orders/tasks/reimbursements.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `dataPegawai.delete`

### B. Request Parameters
- **Path Parameters:** `id (string)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Blocks deletion if employee has active operational history.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found | 409 Conflict`
- **Success Response Example:**
```json
{ "success": true, "message": "Data pegawai berhasil dihapus" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `employees`
- **Related / Joined Tables:** `users, messengers, orders, messenger_reimbursements, audit_logs`
- **CRUD Operations Performed:** **DELETE (employees, users, messengers), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Deletes from employees (cascading to users/messengers if unreferenced).

---

## 138. [Permissions (RBAC)] `GET /api/permissions`

### A. API Information
- **API Name:** Permissions (RBAC) — `GET /api/permissions`
- **Method:** `GET`
- **URL / Endpoint:** `/api/permissions`
- **Description:** Returns the authoritative dynamic RBAC permission matrix for all roles from role_permissions.
- **Authentication Required:** Bearer JWT (authenticateToken)
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `Authenticated Session (Required by frontend permissionStore hydration)`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Valid Bearer JWT.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized`
- **Success Response Example:**
```json
{ "success": true, "data": { "Admin": { "dashboard": { "view": true } }, "Finance": { ... } } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `role_permissions`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads all rows from role_permissions and merges with canonical schema defaults.

---

## 139. [Permissions (RBAC)] `PUT /api/permissions/:role`

### A. API Information
- **API Name:** Permissions (RBAC) — `PUT /api/permissions/:role`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/permissions/:role`
- **Description:** Updates the granular RBAC permission tree for a specific role (SVP, Finance, Messenger, or Admin) and invalidates server permission cache.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `hakAkses.edit`

### B. Request Parameters
- **Path Parameters:** `role (Admin | SVP | Finance | Messenger)`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "permissions": object }`
- **Validation Rules:** updateRolePermissionsSchema: valid role name, valid permissions object; prevents locking out Admin from hakAkses.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "role": "Finance", "updatedAt": "2026-11-15T07:00:00Z" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `role_permissions`
- **Related / Joined Tables:** `audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **UPDATE / CREATE (role_permissions), CREATE (audit_logs, security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Upserts role_permissions.permissions_json for the target role and flushes in-memory RBAC cache.

---

## 140. [Permissions (RBAC)] `POST /api/permissions/reset`

### A. API Information
- **API Name:** Permissions (RBAC) — `POST /api/permissions/reset`
- **Method:** `POST`
- **URL / Endpoint:** `/api/permissions/reset`
- **Description:** Resets role_permissions for one or all roles back to factory defaultPermissions.ts matrix.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `hakAkses.edit | hakAkses.reset`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "role"?: "Admin" | "SVP" | "Finance" | "Messenger" }`
- **Validation Rules:** Optional role filter.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "message": "Hak akses berhasil direset ke pengaturan awal" }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `role_permissions`
- **Related / Joined Tables:** `audit_logs, security_audit_logs`
- **CRUD Operations Performed:** **UPDATE / CREATE (role_permissions), CREATE (audit_logs, security_audit_logs)**
- **Foreign Keys & Relational Mechanics:** Overwrites role_permissions with DEFAULT_PERMISSIONS.

---

## 141. [Notifications] `GET /api/notifications/settings`

### A. API Information
- **API Name:** Notifications — `GET /api/notifications/settings`
- **Method:** `GET`
- **URL / Endpoint:** `/api/notifications/settings`
- **Description:** Retrieves global email/WhatsApp notification settings (notification_settings).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `pengaturanNotifikasi.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** None

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "global", "emailEnabled": true, "smtpHost": "smtp.example.com", "smtpPort": 587 } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `notification_settings`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads notification_settings WHERE id = "global".

---

## 142. [Notifications] `PUT /api/notifications/settings`

### A. API Information
- **API Name:** Notifications — `PUT /api/notifications/settings`
- **Method:** `PUT`
- **URL / Endpoint:** `/api/notifications/settings`
- **Description:** Updates global notification settings (SMTP credentials, triggers, sender email).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `pengaturanNotifikasi.edit`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "emailEnabled"?: boolean, "smtpHost"?: string, "smtpPort"?: number, "smtpUser"?: string, "smtpPass"?: string, "senderEmail"?: string }`
- **Validation Rules:** updateNotificationSettingsSchema.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "global", "emailEnabled": true } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `notification_settings`
- **Related / Joined Tables:** `audit_logs`
- **CRUD Operations Performed:** **UPDATE / CREATE (notification_settings), CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Upserts notification_settings row with PK id = "global".

---

## 143. [Notifications] `POST /api/notifications/test-email`

### A. API Information
- **API Name:** Notifications — `POST /api/notifications/test-email`
- **Method:** `POST`
- **URL / Endpoint:** `/api/notifications/test-email`
- **Description:** Sends a test email using the configured notification_settings and logs the attempt in notification_logs.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `pengaturanNotifikasi.edit | pengaturanNotifikasi.test`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "recipientEmail": string, "subject"?: string, "message"?: string }`
- **Validation Rules:** Valid recipientEmail required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 502 Bad Gateway (SMTP Failure)`
- **Success Response Example:**
```json
{ "success": true, "data": { "logId": "NLOG-001", "status": "SENT" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `notification_logs`
- **Related / Joined Tables:** `notification_settings, audit_logs`
- **CRUD Operations Performed:** **READ (notification_settings), CREATE (notification_logs, audit_logs)**
- **Foreign Keys & Relational Mechanics:** Reads SMTP config from notification_settings and writes delivery result to notification_logs.

---

## 144. [Notifications] `GET /api/notifications/logs`

### A. API Information
- **API Name:** Notifications — `GET /api/notifications/logs`
- **Method:** `GET`
- **URL / Endpoint:** `/api/notifications/logs`
- **Description:** Lists outbound notification delivery logs (notification_logs).
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `pengaturanNotifikasi.view | logAudit.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `status?, channel?, recipient?, limit?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "NLOG-001", "recipient": "user@mail.com", "status": "SENT" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `notification_logs`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries notification_logs ORDER BY created_at DESC.

---

## 145. [Audit Logs] `GET /api/audit-logs (Alias: /api/audit)`

### A. API Information
- **API Name:** Audit Logs — `GET /api/audit-logs (Alias: /api/audit)`
- **Method:** `GET`
- **URL / Endpoint:** `/api/audit-logs (Alias: /api/audit)`
- **Description:** Lists immutable system & business audit trail entries (audit_logs) with filtering by module, action, user, or date range.
- **Authentication Required:** Bearer JWT + Role + Dynamic RBAC
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP
  - **Dynamic RBAC Permission(s):** `logAudit.view`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `module?, action?, userId?, startDate?, endDate?, search?, page?, limit?`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Optional query filters.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized | 403 Forbidden`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "AUD-001", "userId": "1", "userName": "Admin", "action": "CREATE_ORDER", "module": "Orders", "timestamp": "2026-11-15T07:00:00Z" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `audit_logs`
- **Related / Joined Tables:** `users`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries audit_logs ordered by timestamp DESC.

---

## 146. [Audit Logs] `POST /api/audit-logs (Alias: /api/audit)`

### A. API Information
- **API Name:** Audit Logs — `POST /api/audit-logs (Alias: /api/audit)`
- **Method:** `POST`
- **URL / Endpoint:** `/api/audit-logs (Alias: /api/audit)`
- **Description:** Appends a new audit log entry (used for explicit client/action audit recording; identity is bound from server JWT).
- **Authentication Required:** Bearer JWT (authenticateToken)
- **Role / Permission Access:**
  - **Allowed Roles:** Admin, SVP, Finance, Messenger
  - **Dynamic RBAC Permission(s):** `Authenticated Session`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `{ "action": string, "module": string, "details"?: string | object, "entityId"?: string }`
- **Validation Rules:** createAuditLogSchema: action and module required.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 401 Unauthorized`
- **Success Response Example:**
```json
{ "success": true, "data": { "id": "AUD-002", "action": "EXPORT_REPORT" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `audit_logs`
- **Related / Joined Tables:** `users`
- **CRUD Operations Performed:** **CREATE (audit_logs)**
- **Foreign Keys & Relational Mechanics:** Inserts into append-only audit_logs table.

---

## 147. [Audit Logs] `DELETE /api/audit-logs (Alias: /api/audit)`

### A. API Information
- **API Name:** Audit Logs — `DELETE /api/audit-logs (Alias: /api/audit)`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/audit-logs (Alias: /api/audit)`
- **Description:** Intentionally rejects audit log deletion with HTTP 405 Method Not Allowed to guarantee audit trail immutability.
- **Authentication Required:** Bearer JWT (Immutable Guard)
- **Role / Permission Access:**
  - **Allowed Roles:** None (Blocked by Design)
  - **Dynamic RBAC Permission(s):** `Immutable Audit Trail Policy`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Always returns 405.

### C. Response Structure
- **HTTP Status Codes:** `405 Method Not Allowed`
- **Success Response Example:**
```json
{ "success": false, "error": "Audit logs are immutable and cannot be deleted or cleared." }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `audit_logs`
- **Related / Joined Tables:** `security_audit_logs`
- **CRUD Operations Performed:** **NONE (Blocked / Immutable)**
- **Foreign Keys & Relational Mechanics:** Protects audit_logs from tampering or truncation.

---

## 148. [Audit Logs] `POST /api/audit-logs/clear (Alias: /api/audit/clear)`

### A. API Information
- **API Name:** Audit Logs — `POST /api/audit-logs/clear (Alias: /api/audit/clear)`
- **Method:** `POST`
- **URL / Endpoint:** `/api/audit-logs/clear (Alias: /api/audit/clear)`
- **Description:** Intentionally rejects clearing audit logs with HTTP 405 Method Not Allowed.
- **Authentication Required:** Bearer JWT (Immutable Guard)
- **Role / Permission Access:**
  - **Allowed Roles:** None (Blocked by Design)
  - **Dynamic RBAC Permission(s):** `Immutable Audit Trail Policy`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Always returns 405.

### C. Response Structure
- **HTTP Status Codes:** `405 Method Not Allowed`
- **Success Response Example:**
```json
{ "success": false, "error": "Audit logs are immutable and cannot be deleted or cleared." }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `audit_logs`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **NONE (Blocked / Immutable)**
- **Foreign Keys & Relational Mechanics:** Enforces append-only audit retention.

---

## 149. [Audit Logs] `DELETE /api/audit-logs/clear (Alias: /api/audit/clear)`

### A. API Information
- **API Name:** Audit Logs — `DELETE /api/audit-logs/clear (Alias: /api/audit/clear)`
- **Method:** `DELETE`
- **URL / Endpoint:** `/api/audit-logs/clear (Alias: /api/audit/clear)`
- **Description:** Intentionally rejects clearing audit logs via DELETE with HTTP 405 Method Not Allowed.
- **Authentication Required:** Bearer JWT (Immutable Guard)
- **Role / Permission Access:**
  - **Allowed Roles:** None (Blocked by Design)
  - **Dynamic RBAC Permission(s):** `Immutable Audit Trail Policy`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Always returns 405.

### C. Response Structure
- **HTTP Status Codes:** `405 Method Not Allowed`
- **Success Response Example:**
```json
{ "success": false, "error": "Audit logs are immutable and cannot be deleted or cleared." }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `audit_logs`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **NONE (Blocked / Immutable)**
- **Foreign Keys & Relational Mechanics:** Enforces append-only audit retention.

---

## 150. [Public Customer API] `GET /api/v1/public/services (Alias: /api/public/services)`

### A. API Information
- **API Name:** Public Customer API — `GET /api/v1/public/services (Alias: /api/public/services)`
- **Method:** `GET`
- **URL / Endpoint:** `/api/v1/public/services (Alias: /api/public/services)`
- **Description:** Lists active services available for public customer order submission and price estimation.
- **Authentication Required:** Public API Security (Rate-Limited 60/min + Optional X-Public-Api-Key)
- **Role / Permission Access:**
  - **Allowed Roles:** External Customer / Public Portal
  - **Dynamic RBAC Permission(s):** `Public Read`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** requirePublicApiSecurity + publicReadRateLimiter.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 401 Unauthorized (if PUBLIC_API_KEY configured & missing) | 429 Too Many Requests`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "SRV-01", "namaLayanan": "Perpanjangan STNK 1 Tahun" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `services`
- **Related / Joined Tables:** `-`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries services WHERE status = "Aktif".

---

## 151. [Public Customer API] `GET /api/v1/public/samsat (Alias: /api/public/samsat)`

### A. API Information
- **API Name:** Public Customer API — `GET /api/v1/public/samsat (Alias: /api/public/samsat)`
- **Method:** `GET`
- **URL / Endpoint:** `/api/v1/public/samsat (Alias: /api/public/samsat)`
- **Description:** Lists active Samsat offices and regions for public customer selection.
- **Authentication Required:** Public API Security (Rate-Limited 60/min)
- **Role / Permission Access:**
  - **Allowed Roles:** External Customer / Public Portal
  - **Dynamic RBAC Permission(s):** `Public Read`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `provinsi?, kodeKabupatenKota?`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** requirePublicApiSecurity + publicReadRateLimiter.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 429 Too Many Requests`
- **Success Response Example:**
```json
{ "success": true, "data": [ { "id": "SMS-JKS", "namaSamsat": "Samsat Jakarta Selatan" } ] }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `samsat_offices`
- **Related / Joined Tables:** `wilayah_administratif`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Queries active samsat_offices joined with wilayah_administratif.

---

## 152. [Public Customer API] `GET /api/v1/public/pricing (Alias: /api/public/pricing)`

### A. API Information
- **API Name:** Public Customer API — `GET /api/v1/public/pricing (Alias: /api/public/pricing)`
- **Method:** `GET`
- **URL / Endpoint:** `/api/v1/public/pricing (Alias: /api/public/pricing)`
- **Description:** Calculates estimated service fee and Samsat tariff for public calculator.
- **Authentication Required:** Public API Security (Rate-Limited 60/min)
- **Role / Permission Access:**
  - **Allowed Roles:** External Customer / Public Portal
  - **Dynamic RBAC Permission(s):** `Public Read`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `serviceId (string), samsatId (string), vehicleType? (Motor|Mobil)`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** serviceId and samsatId required.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 429 Too Many Requests`
- **Success Response Example:**
```json
{ "success": true, "data": { "biayaJasa": 150000, "estimasiHari": "1-2 Hari" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `service_pricing_configs`
- **Related / Joined Tables:** `services, samsat_offices, samsat_pricing, samsat_operational_tariffs, estimation_templates`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads effective public pricing from service_pricing_configs and samsat_operational_tariffs.

---

## 153. [Public Customer API] `POST /api/v1/public/orders (Alias: /api/public/orders)`

### A. API Information
- **API Name:** Public Customer API — `POST /api/v1/public/orders (Alias: /api/public/orders)`
- **Method:** `POST`
- **URL / Endpoint:** `/api/v1/public/orders (Alias: /api/public/orders)`
- **Description:** Submits a new customer order from the public portal/mobile app as a Draft / Partial Estimate order.
- **Authentication Required:** Public API Security (Strict Rate-Limited 10/15m)
- **Role / Permission Access:**
  - **Allowed Roles:** External Customer / Public Portal
  - **Dynamic RBAC Permission(s):** `Public Order Submission`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `-`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `{ "customerName": string, "customerPhone": string, "nopol": string, "serviceId": string, "samsatId": string, "jenisKendaraan": "Motor" | "Mobil", "catatan"?: string }`
- **Validation Rules:** publicCreateOrderSchema: strict sanitization, phone format, nopol format, serviceId & samsatId existence.

### C. Response Structure
- **HTTP Status Codes:** `201 Created | 400 Bad Request | 429 Too Many Requests`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0005", "status": "Draft", "trackingCode": "ORD-20261115-0005" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `customers, vehicles, finance_invoices, order_status_history, order_timeline_processes`
- **CRUD Operations Performed:** **CREATE (orders, customers, vehicles, finance_invoices, order_status_history)**
- **Foreign Keys & Relational Mechanics:** Creates order and initial DRAFT_ESTIMATE invoice inside a transaction.

---

## 154. [Public Customer API] `GET /api/v1/public/orders/tracking (Alias: /api/public/orders/tracking)`

### A. API Information
- **API Name:** Public Customer API — `GET /api/v1/public/orders/tracking (Alias: /api/public/orders/tracking)`
- **Method:** `GET`
- **URL / Endpoint:** `/api/v1/public/orders/tracking (Alias: /api/public/orders/tracking)`
- **Description:** Tracks order progress by query parameters (orderNo and customer phone/nopol verification) returning sanitized public status & timeline.
- **Authentication Required:** Public API Security (Rate-Limited 30/5m)
- **Role / Permission Access:**
  - **Allowed Roles:** External Customer / Public Portal
  - **Dynamic RBAC Permission(s):** `Public Tracking (Requires matching orderNo + phone/nopol verification)`

### B. Request Parameters
- **Path Parameters:** `-`
- **Query Parameters:** `orderNo (string, required), phone? (string), nopol? (string)`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** Requires orderNo and matching phone or nopol to prevent enumeration.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 400 Bad Request | 404 Not Found | 429 Too Many Requests`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "status": "Diproses", "timeline": [] } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `vehicles, services, samsat_offices, order_status_history, order_timeline_processes`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Reads sanitized public projection of orders and order_timeline_processes.

---

## 155. [Public Customer API] `GET /api/v1/public/orders/:orderNo/tracking (Alias: /api/public/orders/:orderNo/tracking)`

### A. API Information
- **API Name:** Public Customer API — `GET /api/v1/public/orders/:orderNo/tracking (Alias: /api/public/orders/:orderNo/tracking)`
- **Method:** `GET`
- **URL / Endpoint:** `/api/v1/public/orders/:orderNo/tracking (Alias: /api/public/orders/:orderNo/tracking)`
- **Description:** Tracks order progress by path parameter :orderNo (with phone/nopol query verification).
- **Authentication Required:** Public API Security (Rate-Limited 30/5m)
- **Role / Permission Access:**
  - **Allowed Roles:** External Customer / Public Portal
  - **Dynamic RBAC Permission(s):** `Public Tracking`

### B. Request Parameters
- **Path Parameters:** `orderNo (string)`
- **Query Parameters:** `phone? (string), nopol? (string)`
- **Headers:** `Content-Type: application/json`, optional `X-Public-Api-Key`
- **Request Body & Data Types:** `-`
- **Validation Rules:** orderNo required + phone/nopol verification.

### C. Response Structure
- **HTTP Status Codes:** `200 OK | 404 Not Found | 429 Too Many Requests`
- **Success Response Example:**
```json
{ "success": true, "data": { "orderNo": "ORD-20261115-0001", "status": "Diproses" } }
```
- **Error Response Example:**
```json
{ "success": false, "error": "Request tidak valid atau akses ditolak oleh kebijakan RBAC." }
```

### D. Database Relationship
- **Main Table Accessed:** `orders`
- **Related / Joined Tables:** `vehicles, services, samsat_offices, order_status_history, order_timeline_processes`
- **CRUD Operations Performed:** **READ**
- **Foreign Keys & Relational Mechanics:** Same tracking projection as GET /orders/tracking.

---
