/**
 * User Routes (Secured & Validated)
 * Admin SUN89 — Biro Jasa Management System
 */

import { Router } from "express";
import {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  preflightPermanentErasure,
  permanentErasureUser,
  retryFileDeletionJob,
} from "../controllers/userController";
import { requireAuth, requireRoles, requireUserSelfOrAdmin, requirePermission } from "../middleware/auth";
import { validateUserMutationPayload } from "../middleware/validation";

export const userRouter = Router();

// List all users (Administrator & Admin only, gated by dynamic permission)
userRouter.get(
  "/",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-pengguna", "view"),
  getUsers
);

// Get user profile (Protected: Administrator, Admin with permission, or self)
userRouter.get(
  "/:id",
  requireAuth,
  requireUserSelfOrAdmin,
  getUserById
);

// User mutations (Administrator & Admin only, gated by dynamic permission)
userRouter.post(
  "/",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-pengguna", "manage"),
  validateUserMutationPayload,
  createUser
);

userRouter.put(
  "/:id",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-pengguna", "manage"),
  validateUserMutationPayload,
  updateUser
);

userRouter.delete(
  "/:id",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-pengguna", "manage"),
  deleteUser
);

// Reset password to date-of-birth (Administrator & Admin only, gated by dynamic permission)
userRouter.post(
  "/:id/reset-password",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-pengguna", "manage"),
  resetUserPassword
);

// Permanent Erasure Preflight Check (Administrator only, gated by dynamic permission)
userRouter.get(
  "/:id/permanent-erasure-preflight",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("manajemen-pengguna", "manage"),
  preflightPermanentErasure
);

// Permanent Erasure Execution (Administrator only, requires 'HAPUS PERMANEN')
userRouter.post(
  "/:id/permanent-erasure",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("manajemen-pengguna", "manage"),
  permanentErasureUser
);

// File Deletion Job Retry (Administrator only)
userRouter.post(
  "/file-deletion-jobs/:jobId/retry",
  requireAuth,
  requireRoles("administrator"),
  requirePermission("manajemen-pengguna", "manage"),
  retryFileDeletionJob
);
