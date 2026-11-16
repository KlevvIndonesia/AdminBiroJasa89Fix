/**
 * Order Routes (Secured & Validated)
 * Admin SUN89 — Biro Jasa Management System
 */

import { Router } from "express";
import {
  getOrders,
  getArchivedOrders,
  getOrderByNo,
  createOrder,
  updateOrder,
  advanceOrder,
  rollbackOrder,
  archiveOrder,
  deleteArchivedOrder,
  hardDeleteOrder,
  clearArchivedOrders,
  verifyPayment,
  cancelOrder,
  requestOrderCorrection,
  approveOrderDocuments,
  verifyOrderCost,
  acceptMessengerTask,
  declineMessengerTask,
  reassignMessengerTask,
  updateMessengerTaskStatus,
  startSamsatProcess,
  updateSamsatSubprogress,
  completeSamsatProcess,
  releaseSamsatTask,
  startPickupTask,
  completePickupTask,
  releasePickupTask,
  startDeliveryTask,
  completeDeliveryTask,
  releaseDeliveryTask,
  reportSamsatPickupKendala,
  recoverSamsatPickupKendala,
  completeSamsatPickupTask,
  getOrderStatusHistory,
} from "../controllers/orderController";
import { requireAuth, requireRoles, requireStageAuthority, requirePermission } from "../middleware/auth";
import {
  validateOrderCreatePayload,
  validateOrderUpdatePayload,
  validateStageTransitionPayload,
  validateOrderCostVerificationPayload,
} from "../middleware/validation";

export const orderRouter = Router();

// Read operations (Protected against anonymous access & gated with dynamic RBAC)
orderRouter.get(
  "/",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission("order-menu", "view"),
  getOrders
);

orderRouter.get(
  "/archived",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission("order-history", "view"),
  getArchivedOrders
);

orderRouter.get(
  "/archive",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission("order-history", "view"),
  getArchivedOrders
);

orderRouter.get(
  "/:orderNo",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission(["order-menu", "order-tracking"], "view"),
  getOrderByNo
);

orderRouter.get(
  "/:orderNo/status-history",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission(["order-menu", "order-tracking"], "view"),
  getOrderStatusHistory
);

// Write operations (Protected with role, stage authority, and dynamic RBAC)
orderRouter.post(
  "/",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("buat-order", "manage"),
  validateOrderCreatePayload,
  createOrder
);

orderRouter.put(
  "/:orderNo",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  validateOrderUpdatePayload,
  updateOrder
);

orderRouter.post(
  "/:orderNo/advance",
  requireAuth,
  requireStageAuthority,
  validateStageTransitionPayload,
  advanceOrder
);

orderRouter.post(
  "/:orderNo/rollback",
  requireAuth,
  requireStageAuthority,
  validateStageTransitionPayload,
  rollbackOrder
);

// Canonical endpoint for clearing all archived orders
orderRouter.delete(
  "/archive/clear-all",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-history", "manage"),
  clearArchivedOrders
);

// Backward-compatibility route alias for legacy callers
orderRouter.delete(
  "/archived/clear-all",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-history", "manage"),
  clearArchivedOrders
);

orderRouter.post(
  "/:orderNo/archive",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-history", "manage"),
  archiveOrder
);

orderRouter.delete(
  "/:orderNo/archive",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-history", "manage"),
  deleteArchivedOrder
);

orderRouter.delete(
  "/:orderNo",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-menu", "manage"),
  hardDeleteOrder
);

orderRouter.post(
  "/:orderNo/verify-payment",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission("finance-tagihan", "manage"),
  verifyPayment
);

orderRouter.post(
  "/:orderNo/cancel",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission(["order-menu", "order-tracking"], "manage"),
  cancelOrder
);

orderRouter.post(
  "/:orderNo/request-correction",
  requireAuth,
  requireRoles("administrator", "admin", "finance"),
  requirePermission(["order-menu", "order-tracking"], "manage"),
  requestOrderCorrection
);

orderRouter.post(
  "/:orderNo/verify-cost",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-tracking", "manage"),
  validateOrderCostVerificationPayload,
  verifyOrderCost
);

orderRouter.post(
  "/:orderNo/approve-documents",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-tracking", "manage"),
  approveOrderDocuments
);

// Task Lifecycle Operations: Accept, Decline, Reassign
orderRouter.post(
  "/:orderNo/tasks/:taskType/accept",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["messenger-task", "order-tracking"], "manage"),
  acceptMessengerTask
);

orderRouter.post(
  "/:orderNo/tasks/:taskType/decline",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["messenger-task", "order-tracking"], "manage"),
  declineMessengerTask
);

orderRouter.post(
  "/:orderNo/tasks/:taskType/reassign",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-tracking", "manage"),
  reassignMessengerTask
);

orderRouter.post(
  "/:orderNo/tasks/:taskType/status",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["messenger-task", "order-tracking"], "manage"),
  updateMessengerTaskStatus
);

orderRouter.patch(
  "/:orderNo/tasks/:taskType/status",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["messenger-task", "order-tracking"], "manage"),
  updateMessengerTaskStatus
);

// Samsat Lifecycle Operations: Start, Subprogress & Complete
orderRouter.post(
  "/:orderNo/samsat/start",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  startSamsatProcess
);

orderRouter.post(
  "/:orderNo/samsat/subprogress",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  updateSamsatSubprogress
);

orderRouter.post(
  "/:orderNo/samsat/complete",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  completeSamsatProcess
);

orderRouter.post(
  "/:orderNo/samsat/release",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  releaseSamsatTask
);

// Pickup Lifecycle Operations: Start, Complete & Release (Scope A, B, C)
orderRouter.post(
  "/:orderNo/pickup/start",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  startPickupTask
);

orderRouter.post(
  "/:orderNo/pickup/complete",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  completePickupTask
);

orderRouter.post(
  "/:orderNo/pickup/release",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  releasePickupTask
);

// Delivery Lifecycle Operations: Start, Complete & Release (Scope A, B, C)
orderRouter.post(
  "/:orderNo/delivery/start",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  startDeliveryTask
);

orderRouter.post(
  "/:orderNo/delivery/complete",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  completeDeliveryTask
);

orderRouter.post(
  "/:orderNo/delivery/release",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  releaseDeliveryTask
);

// Phase 4: Jemput Hasil Samsat & Kendala Workflow Operations
orderRouter.post(
  "/:orderNo/samsat-pickup/kendala",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  reportSamsatPickupKendala
);

orderRouter.post(
  "/:orderNo/samsat-pickup/recover",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("order-tracking", "manage"),
  recoverSamsatPickupKendala
);

orderRouter.post(
  "/:orderNo/samsat-pickup/complete",
  requireAuth,
  requireRoles("administrator", "admin", "messenger"),
  requirePermission(["order-tracking", "messenger-task"], "manage"),
  completeSamsatPickupTask
);
