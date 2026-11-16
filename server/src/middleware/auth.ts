/**
 * Authentication and Authorization Middleware
 * Admin SUN89 — Biro Jasa Management System
 */

import { Request, Response, NextFunction } from "express";
import { verifyToken, type TokenPayload } from "../utils/crypto";
import { dbOrderRepository } from "../repositories/dbOrderRepository";
import { dbUserRepository } from "../repositories/dbUserRepository";
import { dbPermissionRepository } from "../repositories/dbPermissionRepository";
import { StageActionPermissions } from "../config/defaultPermissions";
import {
  resolveCanonicalRoleFromUser,
  isCanonicalAdministrator,
  parseStrictUserId,
  parsePositiveDbUserId,
} from "../utils/canonicalIdentity";

export type { TokenPayload };

export interface AuthenticatedRequest<P = any, ResBody = any, ReqBody = any, ReqQuery = any> extends Request<P, ResBody, ReqBody, ReqQuery> {
  user?: TokenPayload | null;
}

export interface TokenValidationResult {
  valid: boolean;
  userPayload: TokenPayload | null;
  errorCode?: "UNAUTHENTICATED" | "REVOKED_IDENTITY" | "ACCOUNT_INACTIVE";
  errorMessage?: string;
}

/**
 * Validates JWT cryptographic signature and strictly enforces real-time database
 * user existence and active status. Immediately rejects revoked/deleted/inactive identities.
 */
export { resolveCanonicalRoleFromUser, isCanonicalAdministrator };

export function validateTokenAndUser(token: string): TokenValidationResult {
  if (!token || typeof token !== "string") {
    return { valid: false, userPayload: null, errorCode: "UNAUTHENTICATED", errorMessage: "Token autentikasi tidak disediakan." };
  }

  const payload = verifyToken(token);
  if (!payload) {
    return { valid: false, userPayload: null, errorCode: "UNAUTHENTICATED", errorMessage: "Token autentikasi tidak valid atau telah kedaluwarsa." };
  }

  // Real-time database verification: user MUST exist and MUST be 'Aktif'
  const parsedUserId = parseStrictUserId(payload.userId);
  if (!parsedUserId.valid) {
    return { valid: false, userPayload: null, errorCode: "UNAUTHENTICATED", errorMessage: "Identitas userId pada token tidak valid secara kanonikal." };
  }
  const dbUser = dbUserRepository.getByIdWithCredentials(parsedUserId.numericId);
  if (!dbUser) {
    return {
      valid: false,
      userPayload: null,
      errorCode: "REVOKED_IDENTITY",
      errorMessage: "Akun pengguna tidak ditemukan atau telah dihapus secara permanen.",
    };
  }

  if (dbUser.status !== "Aktif") {
    return {
      valid: false,
      userPayload: null,
      errorCode: "ACCOUNT_INACTIVE",
      errorMessage: "Akun pengguna telah dinonaktifkan.",
    };
  }

  // Real-time authoritative role & jabatan synchronization from SQLite (Defense against JWT Role Staleness)
  const canonicalRole = resolveCanonicalRoleFromUser(dbUser.jabatan, dbUser.role);
  if (!canonicalRole) {
    return {
      valid: false,
      userPayload: null,
      errorCode: "UNAUTHENTICATED",
      errorMessage: "Akun pengguna tidak memiliki jabatan atau role kanonikal yang valid (fail-closed).",
    };
  }

  const canonicalJabatan = dbUser.jabatan ? dbUser.jabatan.trim() : (canonicalRole === "administrator" ? "SVP" : canonicalRole.toUpperCase());

  // Real-time authoritative employeeId synchronization from SQLite (Defense against Stale Employee Identity)
  // Single Source of Truth: dbUser.employee_id in database.
  const dbEmpId = dbUser.employee_id ? String(dbUser.employee_id).trim() : undefined;
  let authoritativeEmpId: string | undefined = dbEmpId;
  if (typeof payload.employeeId === "string" && !payload.employeeId.trim()) {
    authoritativeEmpId = undefined; // Token explicitly stripped of courier capability (e.g. test isolation)
  }

  const authoritativePayload: TokenPayload = {
    ...payload,
    userId: `usr-${Number(dbUser.id)}`,
    nama: dbUser.nama || payload.nama,
    jabatan: canonicalJabatan,
    role: canonicalRole,
    employeeId: authoritativeEmpId,
  };

  return { valid: true, userPayload: authoritativePayload };
}

function extractToken(req: Request): string {
  const authHeader = req.headers["authorization"];
  return authHeader ? (authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim()) : "";
}

/**
 * Optional authentication: decodes token if provided, but does not block anonymous requests.
 */
export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    return next();
  }

  const result = validateTokenAndUser(token);
  req.user = result.valid ? result.userPayload : null;
  next();
}

/**
 * Mandatory authentication: rejects any request lacking a valid, verified JWT
 * or belonging to a deleted / non-active user.
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  const result = validateTokenAndUser(token);

  if (!result.valid || !result.userPayload) {
    res.status(401).json({
      success: false,
      error: {
        code: result.errorCode || "UNAUTHENTICATED",
        message: result.errorMessage || "Autentikasi diperlukan untuk mengakses resource ini.",
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  req.user = result.userPayload;
  next();
}

/**
 * Role-based authorization: checks if authenticated user possesses one of the allowed roles.
 * Administrator / SVP retains universal access.
 */
export function requireRoles(...allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      const token = extractToken(req);
      const result = validateTokenAndUser(token);
      if (!result.valid || !result.userPayload) {
        res.status(401).json({
          success: false,
          error: {
            code: result.errorCode || "UNAUTHENTICATED",
            message: result.errorMessage || "Autentikasi diperlukan untuk mengakses resource ini.",
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      req.user = result.userPayload;
    }

    const userRole = req.user.role;
    const isSvpOrAdministrator = userRole === "administrator";

    if (!allowedRoles.includes(userRole) && !isSvpOrAdministrator) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `Role '${userRole}' tidak memiliki izin untuk aksi ini. Role yang diizinkan: ${allowedRoles.join(", ")}`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}

/**
 * Stage-level authorization matrix based on application workflow rules.
 */

const STAGE_NAME_TO_KEY: Record<string, keyof StageActionPermissions> = {
  "1": "stage1_verifikasi",
  "verifikasi": "stage1_verifikasi",
  "2": "stage2_penjadwalan",
  "penjadwalan": "stage2_penjadwalan",
  "3": "stage3_verifikasiFisik",
  "verifikasi fisik": "stage3_verifikasiFisik",
  "verifikasi dokumen": "stage3_verifikasiFisik",
  "4": "stage4_prosesSamsat",
  "proses samsat": "stage4_prosesSamsat",
  "samsat": "stage4_prosesSamsat",
  "5": "stage5_verifikasiUlang",
  "verifikasi ulang": "stage5_verifikasiUlang",
  "6": "stage6_supervisi",
  "supervisi": "stage6_supervisi",
  "7": "stage7_pengantaran",
  "pengantaran": "stage7_pengantaran",
  "8": "stage8_diterima",
  "dokumen telah diterima": "stage8_diterima",
  "diterima": "stage8_diterima",
  "selesai": "stage8_diterima",
};

export function resolveStageKey(stage: string | number | undefined): keyof StageActionPermissions | null {
  if (stage === undefined || stage === null) return null;
  if (typeof stage === "number") {
    const keys: (keyof StageActionPermissions)[] = [
      "stage1_verifikasi",
      "stage2_penjadwalan",
      "stage3_verifikasiFisik",
      "stage4_prosesSamsat",
      "stage5_verifikasiUlang",
      "stage6_supervisi",
      "stage7_pengantaran",
      "stage8_diterima",
    ];
    return keys[stage - 1] || null;
  }
  const clean = String(stage).trim().toLowerCase();
  return STAGE_NAME_TO_KEY[clean] || null;
}

export function requireStageAuthority(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    const token = extractToken(req);
    const result = validateTokenAndUser(token);
    if (!result.valid || !result.userPayload) {
      res.status(401).json({
        success: false,
        error: { code: result.errorCode || "UNAUTHENTICATED", message: result.errorMessage || "Autentikasi diperlukan." },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    req.user = result.userPayload;
  }

  const userRole = req.user.role;

  // Administrator / SVP has authority over all 8 stages
  if (userRole === "administrator") {
    return next();
  }

  // Messenger cannot advance order tracking
  if (userRole === "messenger") {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Messenger tidak memiliki akses mutasi Order Tracking." },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Finance cannot mutate operational stages
  if (userRole === "finance") {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Finance tidak berwenang mengubah tahapan operasional order." },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Non-SVP must have dynamic module permission for order tracking
  const perms = dbPermissionRepository.getByRole(userRole);
  if (!perms) {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: `Role '${userRole}' tidak memiliki konfigurasi hak akses terdaftar (fail-closed).` },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const trackingPerm = perms.modules?.["order-tracking"] || perms.modules?.["order-menu"];
  if (!trackingPerm?.manage) {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Akses ditolak: role '${userRole}' tidak memiliki izin 'manage' pada modul 'order-tracking'.`,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const orderNo = req.params?.orderNo;
  const existingOrder = orderNo ? dbOrderRepository.getByOrderNo(orderNo) : null;
  const currentStageName = req.body?.currentStage || existingOrder?.currentStageName || req.params?.stage || "";
  const targetStageStr = req.body?.targetStage || req.body?.nextStage || "";

  // Stage 6 & Rollback protection: Stage 6 Supervisi is strictly SVP-only.
  const isRollback = (req.originalUrl || req.url || "").includes("rollback") || req.path.includes("rollback");
  const stepMap: Record<string, number> = {
    "Verifikasi": 1,
    "Penjadwalan": 2,
    "Verifikasi Fisik": 3,
    "Verifikasi Dokumen": 3,
    "Proses Samsat": 4,
    "Verifikasi Ulang": 5,
    "Supervisi": 6,
    "Pengantaran": 7,
    "Dokumen Telah Diterima": 8,
  };

  const targetStep = typeof req.body?.targetStep === "number" ? req.body.targetStep : (stepMap[targetStageStr] || 0);
  const currentStep = existingOrder?.currentStep || (currentStageName ? stepMap[currentStageName] : 0) || 0;

  if (isRollback && existingOrder) {
    if (currentStep >= 6 || existingOrder.documentApproval?.stage6Approved) {
      if (targetStep <= 6) {
        res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "Akses ditolak: Stage 6 (Supervisi) bersifat eksklusif untuk SVP dan rollback melewati tahap Supervisi hanya dapat dilakukan oleh SVP.",
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }
  }

  // Dynamic stage action permission checking from SQLite role_permissions.stages (strictly fail-closed)
  if (!perms.stages || typeof perms.stages !== "object" || Array.isArray(perms.stages)) {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Akses ditolak: konfigurasi hak akses tahapan (stages) untuk role '${userRole}' tidak ditemukan atau tidak valid (fail-closed).`,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const hasAnyAuthorizedStage = Object.entries(perms.stages).some(
    ([key, val]) => key !== "stage6_supervisi" && val === true
  );
  if (!hasAnyAuthorizedStage) {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Akses ditolak: role '${userRole}' tidak memiliki izin tahapan aktif pada konfigurasi stages (fail-closed).`,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const currentKey = resolveStageKey(currentStageName || currentStep);
  const targetKey = resolveStageKey(targetStageStr || targetStep);

  // Stage 6 (Supervisi) actions are strictly SVP-only regardless of dynamic permission state
  if (currentKey === "stage6_supervisi") {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Stage 6 (Supervisi) bersifat eksklusif untuk SVP.",
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Fail-closed: acting on current stage is authorized ONLY if permission is explicitly true
  if (currentKey && perms.stages[currentKey] !== true) {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Akses ditolak: role '${userRole}' tidak memiliki izin aksi pada tahapan '${currentStageName || currentKey}'.`,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Allow Admin completing Stage 5 (Verifikasi Ulang) to enter Stage 6 (Supervisi) queue for SVP review
  const isValidStage5ToSupervisiSubmission =
    !isRollback && currentStep === 5 && targetStep === 6 && perms.stages.stage5_verifikasiUlang === true;

  if (targetKey === "stage6_supervisi" && !isValidStage5ToSupervisiSubmission) {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Stage 6 (Supervisi) bersifat eksklusif untuk SVP.",
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Fail-closed: transitioning to another target stage is authorized ONLY if permission is explicitly true
  if (targetKey && targetKey !== "stage6_supervisi" && perms.stages[targetKey] !== true) {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Akses ditolak: role '${userRole}' tidak memiliki izin aksi pada tahapan '${targetStageStr || targetKey}'.`,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}

export function requireUserSelfOrAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    const token = extractToken(req);
    const result = validateTokenAndUser(token);
    if (!result.valid || !result.userPayload) {
      res.status(401).json({
        success: false,
        error: { code: result.errorCode || "UNAUTHENTICATED", message: result.errorMessage || "Autentikasi diperlukan." },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    req.user = result.userPayload;
  }

  const targetId = req.params.id;
  const authNumericId = parsePositiveDbUserId(req.user.userId);
  const targetNumericId = parsePositiveDbUserId(targetId);
  const isSelf = authNumericId !== null && targetNumericId !== null && authNumericId === targetNumericId;

  // Self-access is always permitted for authenticated users
  if (isSelf) {
    return next();
  }

  const userRole = req.user.role;
  const isSvp = userRole === "administrator";
  if (isSvp) {
    return next();
  }

  // Non-privileged users cannot access other accounts
  if (userRole !== "admin") {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Anda hanya berwenang mengakses data akun Anda sendiri." },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Admin must have dynamic permission "manajemen-pengguna" view
  const perms = dbPermissionRepository.getByRole(userRole);
  const modPerm = perms?.modules?.["manajemen-pengguna"];
  const hasPerm = modPerm?.view || modPerm?.manage;
  if (!hasPerm) {
    res.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: `Akses ditolak: role '${userRole}' tidak memiliki izin 'view' pada modul 'manajemen-pengguna'.`,
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}

/**
 * Dynamic Permission Middleware
 * Evaluates active module-level permission directly against real-time database state.
 * - SVP/Administrator retains universal unconditional access.
 * - Non-SVP roles are checked against active database configuration in SQLite.
 * - Rejects immediately with 403 Forbidden if permission is disabled.
 */
export type PermissionTarget =
  | string
  | string[]
  | ((req: AuthenticatedRequest) => string | string[]);

export function requirePermission(target: PermissionTarget, action: "view" | "manage" = "view") {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      const token = extractToken(req);
      const result = validateTokenAndUser(token);
      if (!result.valid || !result.userPayload) {
        res.status(401).json({
          success: false,
          error: {
            code: result.errorCode || "UNAUTHENTICATED",
            message: result.errorMessage || "Autentikasi diperlukan.",
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      req.user = result.userPayload;
    }

    const userRole = req.user.role;
    const isSvpOrAdministrator = userRole === "administrator";

    // SVP always full privilege
    if (isSvpOrAdministrator) {
      return next();
    }

    // Dynamic database check from SQLite repository
    const perms = dbPermissionRepository.getByRole(userRole);
    if (!perms) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `Role '${userRole}' tidak memiliki konfigurasi hak akses terdaftar (fail-closed).`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const resolved = typeof target === "function" ? target(req) : target;
    const moduleList = Array.isArray(resolved) ? resolved : [resolved];

    const hasSingleModulePerm = (mod: string): boolean => {
      let modPerm = perms.modules?.[mod];
      // Defensive submodule fallback ONLY when key is strictly undefined
      if (modPerm === undefined) {
        if (mod === "finance-cashback-pending" || mod === "finance-belum-bayar") {
          modPerm = perms.modules?.["finance-tagihan"];
        } else if (mod === "finance-profit-pending") {
          modPerm = perms.modules?.["finance-profit"];
        }
      }
      if (!modPerm || typeof modPerm !== "object") {
        return false; // Malformed / non-object -> fail-closed
      }
      const hasView = modPerm.view === true;
      const hasManage = modPerm.manage === true;
      return action === "manage" ? hasManage : (hasView || hasManage);
    };

    const hasAnyPerm = moduleList.some((m) => hasSingleModulePerm(m));

    if (!hasAnyPerm) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `Akses ditolak: role '${userRole}' tidak memiliki izin '${action}' pada modul '${moduleList.join(" / ")}'.`,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    next();
  };
}
