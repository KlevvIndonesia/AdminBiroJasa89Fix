/**
 * Permission Validation Engine
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Strict Schema Validation for Dynamic RBAC:
 * - Target role allowlist: strictly 'admin' and 'finance'
 * - SVP and Administrator are immutable (fail-closed)
 * - Messenger cannot be modified through this interface
 * - Canonical module key validation against CANONICAL_MODULE_KEYS
 * - Canonical stage action permission validation
 * - Security invariants enforcement (Stage 6 Supervisi and Access Management lockdown)
 */

import { RolePermissions, StageActionPermissions, ModulePermission } from "../config/defaultPermissions";

export const CANONICAL_MODULE_KEYS = [
  "dashboard",
  // Finance
  "finance",
  "finance-profit",
  "finance-kas-messenger",
  "finance-kas-kantor",
  "finance-pengeluaran",
  "finance-penjualan",
  "finance-tagihan",
  "finance-laba-rugi",
  "finance-belum-bayar",
  "finance-profit-pending",
  "finance-cashback-pending",
  // Master Data
  "master-data",
  "master-layanan",
  "master-samsat",
  "master-biaya-layanan",
  "master-harga-dasar-samsat",
  "master-metode-pembayaran",
  // Manajemen
  "manajemen",
  "manajemen-karyawan",
  "master-karyawan",
  "manajemen-pengguna",
  "master-pengguna",
  "access-management",
  "audit-log",
  // Messenger
  "messenger-menu",
  "messenger-task",
  "messenger-history",
  // Order
  "order-menu",
  "buat-order",
  "order-tracking",
  "order-history",
  // Generic
  "settings",
  "profile",
] as const;

export const CANONICAL_STAGE_KEYS = [
  "stage1_verifikasi",
  "stage2_penjadwalan",
  "stage3_verifikasiFisik",
  "stage4_prosesSamsat",
  "stage5_verifikasiUlang",
  "stage6_supervisi",
  "stage7_pengantaran",
  "stage8_diterima",
] as const;

export const EDITABLE_ROLES = ["admin", "finance"] as const;

export interface PermissionValidationError {
  field: string;
  message: string;
}

export interface PartialPermissionUpdate {
  modules?: Record<string, ModulePermission>;
  stages?: Partial<StageActionPermissions>;
}

export interface ValidatedPermissionPayload {
  role: "admin" | "finance";
  permissions: PartialPermissionUpdate;
  expectedVersion?: number;
  lastUpdatedAt?: string;
}

/**
 * Validates permission mutation payload with strict security invariants.
 */
export function validatePermissionPayload(
  targetRole: string,
  body: any
): { valid: true; data: ValidatedPermissionPayload } | { valid: false; errors: PermissionValidationError[]; statusCode: number } {
  const errors: PermissionValidationError[] = [];
  const cleanRole = (targetRole || "").toLowerCase().trim();

  // 1. Role validation
  if (cleanRole === "svp" || cleanRole === "administrator") {
    return {
      valid: false,
      statusCode: 403,
      errors: [
        {
          field: "role",
          message: "Hak akses role SVP bersifat absolut dan tidak dapat dimodifikasi (Security Invariant).",
        },
      ],
    };
  }

  if (cleanRole === "messenger") {
    return {
      valid: false,
      statusCode: 400,
      errors: [
        {
          field: "role",
          message: "Role 'messenger' tidak diizinkan untuk dikonfigurasi melalui antarmuka Hak Akses.",
        },
      ],
    };
  }

  if (!EDITABLE_ROLES.includes(cleanRole as any)) {
    return {
      valid: false,
      statusCode: 400,
      errors: [
        {
          field: "role",
          message: `Role '${targetRole}' tidak valid. Role yang didukung untuk konfigurasi dinamis: ${EDITABLE_ROLES.join(", ")}.`,
        },
      ],
    };
  }

  // 2. Body structure validation
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      valid: false,
      statusCode: 400,
      errors: [{ field: "body", message: "Payload request harus berupa object JSON valid." }],
    };
  }

  // Top-level key allowlist
  const allowedTopKeys = ["modules", "stages", "expectedVersion", "lastUpdatedAt"];
  for (const key of Object.keys(body)) {
    if (!allowedTopKeys.includes(key)) {
      errors.push({
        field: key,
        message: `Property top-level '${key}' tidak dikenal. Property yang diizinkan: ${allowedTopKeys.join(", ")}.`,
      });
    }
  }

  // 3. Require at least one of modules or stages (supports partial module-only, stage-only, or combined updates)
  if (body.modules === undefined && body.stages === undefined) {
    errors.push({ field: "body", message: "Payload wajib menyertakan field 'modules' atau 'stages'." });
  }

  let hasValidModules = false;
  if (body.modules !== undefined) {
    if (!body.modules || typeof body.modules !== "object" || Array.isArray(body.modules)) {
      errors.push({ field: "modules", message: "Field 'modules' wajib berupa object pemetaan permission modul." });
    } else {
      hasValidModules = true;
      const canonicalSet = new Set<string>(CANONICAL_MODULE_KEYS);
      for (const [modKey, modPerm] of Object.entries(body.modules)) {
        if (!canonicalSet.has(modKey)) {
          errors.push({
            field: `modules.${modKey}`,
            message: `Module key '${modKey}' tidak dikenal dalam skema sistem.`,
          });
          continue;
        }

        if (!modPerm || typeof modPerm !== "object" || Array.isArray(modPerm)) {
          errors.push({
            field: `modules.${modKey}`,
            message: `Permission untuk modul '${modKey}' harus berupa object { view: boolean, manage: boolean }.`,
          });
          continue;
        }

        const permObj = modPerm as Record<string, any>;
        // Check unknown properties in module permission
        for (const pKey of Object.keys(permObj)) {
          if (pKey !== "view" && pKey !== "manage") {
            errors.push({
              field: `modules.${modKey}.${pKey}`,
              message: `Property '${pKey}' pada modul '${modKey}' tidak dikenal. Hanya 'view' dan 'manage' yang diizinkan.`,
            });
          }
        }

        if (typeof permObj.view !== "boolean") {
          errors.push({
            field: `modules.${modKey}.view`,
            message: `Nilai 'view' pada modul '${modKey}' harus berupa boolean.`,
          });
        }

        if (typeof permObj.manage !== "boolean") {
          errors.push({
            field: `modules.${modKey}.manage`,
            message: `Nilai 'manage' pada modul '${modKey}' harus berupa boolean.`,
          });
        }

        // Security Invariant: Non-SVP roles CANNOT have manage access to access-management
        if (modKey === "access-management" && permObj.manage === true) {
          errors.push({
            field: `modules.${modKey}.manage`,
            message: "Role non-SVP tidak boleh diberikan izin 'manage' pada modul Hak Akses (Anti-Privilege Escalation).",
          });
        }
      }
    }
  }

  // 4. Stages validation (strictly preserve omitted stages — NEVER pre-fill missing keys with false!)
  let partialStages: Partial<StageActionPermissions> | undefined;

  if (body.stages !== undefined) {
    if (!body.stages || typeof body.stages !== "object" || Array.isArray(body.stages)) {
      errors.push({ field: "stages", message: "Field 'stages' harus berupa object stage permissions." });
    } else {
      partialStages = {};
      const stageSet = new Set<string>(CANONICAL_STAGE_KEYS);
      for (const [stKey, stVal] of Object.entries(body.stages)) {
        if (!stageSet.has(stKey)) {
          errors.push({
            field: `stages.${stKey}`,
            message: `Stage key '${stKey}' tidak dikenal dalam workflow 8 tahap.`,
          });
          continue;
        }

        if (typeof stVal !== "boolean") {
          errors.push({
            field: `stages.${stKey}`,
            message: `Nilai permission stage '${stKey}' harus berupa boolean.`,
          });
          continue;
        }

        // Stage 6 (Supervisi) is strictly exclusive to SVP/Administrator and cannot be granted to Admin, Finance, or Messenger
        if (stKey === "stage6_supervisi" && stVal === true) {
          errors.push({
            field: `stages.${stKey}`,
            message: "Stage 6 (Supervisi) bersifat eksklusif untuk role SVP dan tidak dapat diberikan kepada Admin, Finance, atau Messenger.",
          });
          continue;
        }

        (partialStages as any)[stKey] = stVal;
      }
    }
  }

  // 5. Concurrency parameters
  if (body.expectedVersion !== undefined && (typeof body.expectedVersion !== "number" || isNaN(body.expectedVersion))) {
    errors.push({ field: "expectedVersion", message: "Field 'expectedVersion' harus berupa number." });
  }

  if (body.lastUpdatedAt !== undefined && typeof body.lastUpdatedAt !== "string") {
    errors.push({ field: "lastUpdatedAt", message: "Field 'lastUpdatedAt' harus berupa ISO string timestamp." });
  }

  if (errors.length > 0) {
    return {
      valid: false,
      statusCode: 400,
      errors,
    };
  }

  const validatedModules: Record<string, ModulePermission> | undefined = hasValidModules ? {} : undefined;
  if (validatedModules && body.modules) {
    for (const [k, v] of Object.entries(body.modules)) {
      const mod = v as { view: boolean; manage: boolean };
      validatedModules[k] = {
        view: Boolean(mod.view),
        manage: k === "access-management" ? false : Boolean(mod.manage),
      };
    }
  }

  return {
    valid: true,
    data: {
      role: cleanRole as "admin" | "finance",
      permissions: {
        ...(validatedModules !== undefined ? { modules: validatedModules } : {}),
        ...(partialStages !== undefined ? { stages: { ...partialStages, stage6_supervisi: false } } : {}),
      },
      expectedVersion: body.expectedVersion,
      lastUpdatedAt: body.lastUpdatedAt,
    },
  };
}
