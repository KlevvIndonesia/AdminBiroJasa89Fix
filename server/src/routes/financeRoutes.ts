/**
 * Finance Routes (Secured & Validated)
 * Admin SUN89 — Biro Jasa Management System
 */

import { Router } from "express";
import {
  getInvoices,
  getProfitList,
  getLabaRugiSummary,
  getInvoiceById,
  getInvoicePayments,
  payInvoice,
  verifyInvoicePayment,
  payoutCashback,
  completeCashback,
  getCashbackHistory,
  completeInvoice,
  getKasKantor,
  addKasKantor,
  updateKasKantor,
  deleteKasKantor,
  getPengeluaran,
  addPengeluaran,
  deletePengeluaran,
  getKasMessenger,
  addKasMessenger,
  updateKasMessenger,
  deleteKasMessenger,
  getCashReconciliation,
  voidInvoicePayment,
  voidCashbackPayout,
  getVoidAuditHistory,
  transferMessengerToOffice,
  transferOfficeToMessenger,
} from "../controllers/financeController";
import { requireAuth, requireRoles, requirePermission } from "../middleware/auth";
import {
  validateInvoicePaymentPayload,
  validateKasKantorPayload,
  validatePengeluaranPayload,
} from "../middleware/validation";

export const financeRouter = Router();

// Read operations (Protected from anonymous access & restricted to authorized roles with dynamic RBAC)
financeRouter.get(
  "/invoices",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-tagihan", "view"),
  getInvoices
);

financeRouter.get(
  "/laba-rugi",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-laba-rugi", "view"),
  getLabaRugiSummary
);

financeRouter.get(
  "/pnl",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-laba-rugi", "view"),
  getLabaRugiSummary
);

financeRouter.get(
  "/profit",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-profit", "view"),
  getProfitList
);

financeRouter.get(
  "/invoices/:id",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-tagihan", "view"),
  getInvoiceById
);

financeRouter.get(
  "/invoices/:invoiceNo/payments",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-tagihan", "view"),
  getInvoicePayments
);

// Payment mutation (Strictly Administrator & Finance with amount validation and dynamic RBAC)
financeRouter.post(
  "/invoices/:id/pay",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-tagihan", "manage"),
  validateInvoicePaymentPayload,
  payInvoice
);

// Payment verification (Administrator, Finance, Admin & Supervisor / SPV with dynamic RBAC)
financeRouter.post(
  "/invoices/:id/payments/:paymentId/verify",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-tagihan", "manage"),
  verifyInvoicePayment
);

financeRouter.post(
  "/invoices/:id/verify-payment",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-tagihan", "manage"),
  verifyInvoicePayment
);

financeRouter.get(
  "/cashback-history",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-cashback-pending", "view"),
  getCashbackHistory
);

financeRouter.post(
  "/invoices/:id/cashback-payout",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-cashback-pending", "manage"),
  payoutCashback
);

financeRouter.post(
  "/invoices/:id/cashback-complete",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-cashback-pending", "manage"),
  completeCashback
);

financeRouter.post(
  "/invoices/:id/complete",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-tagihan", "manage"),
  completeInvoice
);

// Void / Cancel payment (Strictly Administrator & Supervisor / SPV with dynamic RBAC)
financeRouter.post(
  "/invoices/:id/payments/:paymentId/void",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("finance-tagihan", "manage"),
  voidInvoicePayment
);

// Void / Cancel cashback payout (Strictly Administrator & Supervisor / SPV with dynamic RBAC)
financeRouter.post(
  "/invoices/:id/cashback-payout/void",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("finance-cashback-pending", "manage"),
  voidCashbackPayout
);

// Void Audit History Log (Strictly Administrator & Supervisor / SPV with dynamic RBAC)
financeRouter.get(
  "/audit/void-history",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("audit-log", "view"),
  getVoidAuditHistory
);

// Kas Kantor read (Protected with dynamic RBAC)
financeRouter.get(
  "/kas-kantor",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-kas-kantor", "view"),
  getKasKantor
);

// Kas Kantor mutation (Administrator & Finance with debit/credit validation and dynamic RBAC)
financeRouter.post(
  "/kas-kantor",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-kas-kantor", "manage"),
  validateKasKantorPayload,
  addKasKantor
);

financeRouter.put(
  "/kas-kantor/:id",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-kas-kantor", "manage"),
  updateKasKantor
);

financeRouter.patch(
  "/kas-kantor/:id",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-kas-kantor", "manage"),
  updateKasKantor
);

financeRouter.delete(
  "/kas-kantor/:id",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("finance-kas-kantor", "manage"),
  deleteKasKantor
);

// Pengeluaran read (Protected with dynamic RBAC)
financeRouter.get(
  "/pengeluaran",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-pengeluaran", "view"),
  getPengeluaran
);

// Pengeluaran mutation (Administrator & Finance with dynamic RBAC)
financeRouter.post(
  "/pengeluaran",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-pengeluaran", "manage"),
  validatePengeluaranPayload,
  addPengeluaran
);

financeRouter.delete(
  "/pengeluaran/:id",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("finance-pengeluaran", "manage"),
  deletePengeluaran
);

// Kas Messenger (Database Connected with dynamic RBAC)
financeRouter.get(
  "/kas-messenger",
  requireAuth,
  requireRoles("administrator", "admin", "finance", "messenger"),
  requirePermission((req) => req.user?.role === "messenger" ? "messenger-task" : "finance-kas-messenger", "view"),
  getKasMessenger
);

financeRouter.post(
  "/kas-messenger",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-kas-messenger", "manage"),
  addKasMessenger
);

financeRouter.put(
  "/kas-messenger/:id",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-kas-messenger", "manage"),
  updateKasMessenger
);

financeRouter.patch(
  "/kas-messenger/:id",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-kas-messenger", "manage"),
  updateKasMessenger
);

financeRouter.get(
  "/cash-reconciliation",
  requireAuth,
  requireRoles("administrator", "finance"),
  requirePermission("finance-kas-kantor", "view"),
  getCashReconciliation
);

financeRouter.delete(
  "/kas-messenger/:id",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("finance-kas-messenger", "manage"),
  deleteKasMessenger
);

// Internal Transfer: Setor Sisa Kas Messenger ke Kas Kantor (Dynamic RBAC)
financeRouter.post(
  "/transfer/messenger-to-office",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-kas-messenger", "manage"),
  transferMessengerToOffice
);

// Internal Transfer: Kas Kantor ke Messenger (Panjar/Uang Jalan) (Dynamic RBAC)
financeRouter.post(
  "/transfer/office-to-messenger",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-kas-kantor", "manage"),
  transferOfficeToMessenger
);
