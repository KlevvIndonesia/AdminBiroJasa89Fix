/**
 * Dynamic Permission Management Controller
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Evolution from BD-RBAC-06:
 * - Dynamic RBAC authorized strictly for SVP (Administrator)
 * - Editable roles: ADMIN and FINANCE
 * - SVP remains immutable (fail-closed)
 * - Strict schema validation against CANONICAL_MODULE_KEYS & invariants
 * - Concurrency conflict detection via optimistic locking
 * - Atomic persistence with rollback guarantees via runInTransaction
 * - Append-only audit logging with detailed before/after diffs
 */

import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { dbPermissionRepository, ConcurrencyConflictError } from "../repositories/dbPermissionRepository";
import { dbAuditRepository } from "../repositories/dbAuditRepository";
import { validatePermissionPayload } from "../validators/permissionValidator";

/**
 * Checks if the authenticated actor possesses authoritative SVP / Administrator privileges.
 */
function isAuthorizedSvp(req: AuthenticatedRequest): boolean {
  if (!req.user) return false;
  const role = (req.user.role || "").toLowerCase().trim();
  return role === "administrator";
}

/**
 * GET /api/permissions
 * Retrieves canonical permission matrix and version metadata.
 */
export async function getPermissions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { matrix, metadata } = dbPermissionRepository.getAllWithMetadata();
    res.json({
      success: true,
      data: matrix,
      metadata,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/permissions/:role
 * Dynamically updates role permissions for ADMIN or FINANCE.
 * Strictly gated by authoritative SVP credentials.
 */
export async function updateRolePermissions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Strict Actor Authorization
    if (!isAuthorizedSvp(req)) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Hanya SVP (Administrator) yang berwenang mengubah konfigurasi hak akses.",
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const targetRole = req.params.role;

    // 2. Strict Schema & Invariant Validation
    const validation = validatePermissionPayload(targetRole, req.body);
    if (!validation.valid) {
      res.status(validation.statusCode).json({
        success: false,
        error: {
          code: validation.statusCode === 403 ? "FORBIDDEN" : "VALIDATION_ERROR",
          message: validation.errors[0]?.message || "Payload validasi hak akses tidak valid.",
          details: validation.errors,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { role, permissions, expectedVersion, lastUpdatedAt } = validation.data;
    const actorName = req.user?.nama || "Administrator (SVP)";
    const actorId = req.user?.userId || "usr-system";

    // 3. Transactional Update with Concurrency Protection
    const result = dbPermissionRepository.updateRoleTransactional(
      role,
      permissions,
      actorName,
      { expectedVersion, lastUpdatedAt }
    );

    // 4. Calculate Granular Diff for Audit Logging
    const diff: Record<string, { before: any; after: any }> = {};
    for (const [modKey, modPerm] of Object.entries(result.after.modules)) {
      const beforeMod = result.before.modules[modKey];
      if (!beforeMod || beforeMod.view !== modPerm.view || beforeMod.manage !== modPerm.manage) {
        diff[modKey] = {
          before: beforeMod || { view: false, manage: false },
          after: modPerm,
        };
      }
    }

    // 5. Append-Only Audit Logging
    try {
      dbAuditRepository.save({
        id: `audit-perm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        userId: actorId,
        userName: actorName,
        userRole: req.user?.role || "administrator",
        action: "UPDATE_PERMISSIONS",
        module: "Hak Akses",
        details: `Memperbarui matriks hak akses untuk role ${role.toUpperCase()} (Versi ${result.version}).`,
        metadata: {
          targetRole: role,
          version: result.version,
          updatedAt: result.updatedAt,
          diff,
          before: result.before,
          after: result.after,
        },
        createdAt: new Date().toISOString(),
      });
    } catch (auditErr) {
      console.warn("[PermissionController] Audit logging warning:", auditErr);
    }

    // 6. Success Response
    res.status(200).json({
      success: true,
      message: `Hak akses untuk role ${role.toUpperCase()} berhasil disimpan.`,
      data: result.after,
      version: result.version,
      updatedAt: result.updatedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    if (err instanceof ConcurrencyConflictError || err.code === "CONCURRENCY_CONFLICT") {
      res.status(409).json({
        success: false,
        error: {
          code: "CONCURRENCY_CONFLICT",
          message: err.message,
          currentVersion: err.currentVersion,
          expectedVersion: err.expectedVersion,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (err.message && err.message.includes("SVP")) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: err.message,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next(err);
  }
}

/**
 * POST /api/permissions/reset
 * Resets manageable roles to canonical factory defaults.
 * Strictly gated by authoritative SVP credentials.
 */
export async function resetPermissions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!isAuthorizedSvp(req)) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Hanya SVP (Administrator) yang berwenang mereset hak akses.",
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const actorName = req.user?.nama || "Administrator (SVP)";
    const actorId = req.user?.userId || "usr-system";

    const { resetRoles } = dbPermissionRepository.resetToDefaults(actorName);
    const { matrix, metadata } = dbPermissionRepository.getAllWithMetadata();

    // Record Audit Log
    try {
      dbAuditRepository.save({
        id: `audit-reset-perm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        userId: actorId,
        userName: actorName,
        userRole: req.user?.role || "administrator",
        action: "RESET_PERMISSIONS",
        module: "Hak Akses",
        details: `Mereset hak akses seluruh role operasional (${resetRoles.join(", ").toUpperCase()}) ke konfigurasi standar pabrik.`,
        metadata: {
          resetRoles,
          resetAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      });
    } catch (auditErr) {
      console.warn("[PermissionController] Audit logging warning:", auditErr);
    }

    res.status(200).json({
      success: true,
      message: "Seluruh hak akses operasional berhasil direset ke standar pabrik.",
      data: matrix,
      metadata,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}
