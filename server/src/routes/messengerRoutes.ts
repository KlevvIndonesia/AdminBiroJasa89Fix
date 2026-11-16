/**
 * Messenger REST API Routes
 * Admin SUN89 — Biro Jasa Management System
 */

import { Router } from "express";
import { requireAuth, requireRoles, requirePermission } from "../middleware/auth";
import {
  getMyTasks,
  getMessengersWithStats,
  getMessengerHistory,
  getTaskDetail,
  getReimbursements,
  createReimbursement,
  reviewReimbursement,
  payReimbursement,
  voidReimbursement,
  deleteReimbursementPermanently,
} from "../controllers/messengerController";

export const messengerRouter = Router();

// 0. Dedicated Courier Assigned Tasks (BD-RBAC-03)
messengerRouter.get(
  "/my-tasks",
  requireAuth,
  requireRoles("messenger", "administrator", "admin"),
  requirePermission("messenger-task", "view"),
  getMyTasks
);

// 1. Messenger Selection & Statistics
messengerRouter.get(
  "/messengers",
  requireAuth,
  requireRoles("administrator", "admin", "finance", "messenger"),
  requirePermission(
    (req) =>
      req.user?.role === "finance"
        ? "finance-kas-messenger"
        : req.user?.role === "messenger"
          ? "messenger-task"
          : ["messenger-task", "finance-kas-messenger", "manajemen-karyawan", "master-karyawan"],
    "view"
  ),
  getMessengersWithStats
);

// 2. Task History List
messengerRouter.get(
  "/history",
  requireAuth,
  requireRoles("administrator", "admin", "finance", "messenger"),
  requirePermission("messenger-history", "view"),
  getMessengerHistory
);

// 3. Task Detail (Chronology, Attachments, Reimbursements)
messengerRouter.get(
  "/tasks/:orderNo",
  requireAuth,
  requireRoles("administrator", "admin", "finance", "messenger"),
  requirePermission(
    (req) =>
      req.user?.role === "finance"
        ? ["messenger-history", "finance-kas-messenger"]
        : ["messenger-task", "messenger-history"],
    "view"
  ),
  getTaskDetail
);

// 4. Reimbursement List
messengerRouter.get(
  "/reimbursements",
  requireAuth,
  requireRoles("administrator", "admin", "finance", "messenger"),
  requirePermission(
    (req) =>
      req.user?.role === "finance"
        ? "finance-kas-messenger"
        : ["messenger-task", "finance-kas-messenger"],
    "view"
  ),
  getReimbursements
);

// 5. Submit Reimbursement
messengerRouter.post(
  "/reimbursements",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["messenger-task", "finance-kas-messenger"], "manage"),
  createReimbursement
);

// 6. Review Reimbursement (Approve / Reject)
messengerRouter.patch(
  "/reimbursements/:id/review",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission("finance-kas-messenger", "manage"),
  reviewReimbursement
);

// 7. Pay / Realize Reimbursement
messengerRouter.post(
  "/reimbursements/:id/pay",
  requireAuth,
  requireRoles("administrator", "finance", "admin"),
  requirePermission("finance-kas-messenger", "manage"),
  payReimbursement
);

// 8. Void / Reversal Reimbursement (Supervisor / Admin only)
messengerRouter.post(
  "/reimbursements/:id/void",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("finance-kas-messenger", "manage"),
  voidReimbursement
);

// 9. Permanent Delete Reimbursement (SVP only)
messengerRouter.delete(
  "/reimbursements/:id",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("finance-kas-messenger", "manage"),
  deleteReimbursementPermanently
);
