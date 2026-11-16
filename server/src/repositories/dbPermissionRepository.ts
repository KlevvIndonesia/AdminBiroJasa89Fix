/**
 * SQLite Role Permissions Repository
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Features:
 * - Transactional persistence via runInTransaction
 * - Concurrency protection with optimistic locking (revision/version)
 * - Anti-tampering protection for SVP/Administrator
 * - Immutable canonical fallback
 */

import { db, runInTransaction } from "../database/db";
import { CANONICAL_PERMISSIONS, RolePermissions, ALL_CANONICAL_MODULES, ALL_STAGE_KEYS, ModulePermission, StageActionPermissions } from "../config/defaultPermissions";

export interface RolePermissionsMeta {
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface PermissionRecordWithMeta {
  permissions: RolePermissions;
  meta: RolePermissionsMeta;
}

export class ConcurrencyConflictError extends Error {
  public code = "CONCURRENCY_CONFLICT";
  public currentVersion: number;
  public expectedVersion?: number;

  constructor(message: string, currentVersion: number, expectedVersion?: number) {
    super(message);
    this.name = "ConcurrencyConflictError";
    this.currentVersion = currentVersion;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * Strict Schema Validation & Normalization for Dynamic RBAC Role Permissions
 * Guarantees:
 * 1. Fail-closed: missing, corrupted, or non-boolean permissions default to false.
 * 2. Explicit false is preserved as permission denial.
 * 3. Submodule fallback only operates when the submodule key was genuinely undefined.
 * 4. Invariant: Stage 6 Supervisi is ALWAYS false for non-SVP roles.
 * 5. Every canonical module key is populated with strict boolean view & manage flags.
 */
export function validateAndNormalizeRolePermissions(raw: any, role: string): RolePermissions {
  const cleanRole = role.toLowerCase().trim();
  const canonicalFallback = CANONICAL_PERMISSIONS[cleanRole] || CANONICAL_PERMISSIONS.admin;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return JSON.parse(JSON.stringify(canonicalFallback));
  }

  const rawModules = raw.modules && typeof raw.modules === "object" && !Array.isArray(raw.modules) ? raw.modules : {};
  const rawStages = raw.stages && typeof raw.stages === "object" && !Array.isArray(raw.stages) ? raw.stages : {};

  const normalizedModules: Record<string, ModulePermission> = {};

  for (const modKey of ALL_CANONICAL_MODULES) {
    const rawMod = rawModules[modKey];

    if (rawMod !== undefined) {
      if (rawMod && typeof rawMod === "object" && !Array.isArray(rawMod)) {
        // Enforce strict boolean types; non-boolean is fail-closed to false
        const strictView = typeof rawMod.view === "boolean" ? rawMod.view : false;
        const strictManage = typeof rawMod.manage === "boolean" ? rawMod.manage : false;
        normalizedModules[modKey] = {
          view: strictView,
          manage: strictManage,
        };
      } else {
        // Malformed non-object: fail-closed to false
        normalizedModules[modKey] = { view: false, manage: false };
      }
    } else {
      // Submodule fallback for legacy records missing the submodule key
      if (modKey === "finance-cashback-pending" || modKey === "finance-belum-bayar") {
        const parentMod = rawModules["finance-tagihan"];
        if (parentMod && typeof parentMod === "object" && !Array.isArray(parentMod)) {
          normalizedModules[modKey] = {
            view: typeof parentMod.view === "boolean" ? parentMod.view : false,
            manage: typeof parentMod.manage === "boolean" ? parentMod.manage : false,
          };
          continue;
        }
      } else if (modKey === "finance-profit-pending") {
        const parentMod = rawModules["finance-profit"];
        if (parentMod && typeof parentMod === "object" && !Array.isArray(parentMod)) {
          normalizedModules[modKey] = {
            view: typeof parentMod.view === "boolean" ? parentMod.view : false,
            manage: typeof parentMod.manage === "boolean" ? parentMod.manage : false,
          };
          continue;
        }
      }

      // Default to canonical default for this role if key is completely absent
      const defaultMod = canonicalFallback.modules[modKey] || { view: false, manage: false };
      normalizedModules[modKey] = {
        view: defaultMod.view,
        manage: defaultMod.manage,
      };
    }
  }

  // Preserve any custom modules cleanly
  for (const [key, val] of Object.entries(rawModules)) {
    if (!normalizedModules[key] && val && typeof val === "object" && !Array.isArray(val)) {
      normalizedModules[key] = {
        view: typeof (val as any).view === "boolean" ? (val as any).view : false,
        manage: typeof (val as any).manage === "boolean" ? (val as any).manage : false,
      };
    }
  }

  // Normalize stages strictly
  const normalizedStages: StageActionPermissions = {
    stage1_verifikasi: false,
    stage2_penjadwalan: false,
    stage3_verifikasiFisik: false,
    stage4_prosesSamsat: false,
    stage5_verifikasiUlang: false,
    stage6_supervisi: false,
    stage7_pengantaran: false,
    stage8_diterima: false,
  };

  for (const stageKey of ALL_STAGE_KEYS) {
    if (stageKey === "stage6_supervisi") {
      // Security Invariant: Stage 6 (Supervisi) is strictly SVP-only across all persisted non-SVP roles (including Admin)
      normalizedStages.stage6_supervisi = false;
      continue;
    }
    const rawVal = rawStages[stageKey];
    if (typeof rawVal === "boolean") {
      normalizedStages[stageKey] = rawVal;
    } else {
      // Missing (undefined) or malformed stage -> fail-closed (false)
      normalizedStages[stageKey] = false;
    }
  }

  return {
    modules: normalizedModules,
    stages: normalizedStages,
  };
}

export class DbPermissionRepository {
  /**
   * Retrieves full permissions matrix for all roles.
   * SVP always inherits canonical full privilege unconditionally.
   */
  public getAll(): Record<string, RolePermissions> {
    const stmt = db.prepare("SELECT role, permissions_json FROM role_permissions");
    const rows = stmt.all() as { role: string; permissions_json: string }[];

    const result: Record<string, RolePermissions> = {
      administrator: JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.administrator)),
      admin: JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.admin)),
      finance: JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.finance)),
      messenger: JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.messenger)),
    };

    for (const r of rows) {
      if (r.role === "svp" || r.role === "administrator") continue; // Protected
      try {
        const parsed = JSON.parse(r.permissions_json);
        result[r.role] = validateAndNormalizeRolePermissions(parsed, r.role);
      } catch (err) {
        console.warn(`[DbPermissionRepository] Error parsing permissions for ${r.role}:`, err);
      }
    }

    return result;
  }

  /**
   * Retrieves full permissions matrix alongside version and update metadata.
   */
  public getAllWithMetadata(): {
    matrix: Record<string, RolePermissions>;
    metadata: Record<string, RolePermissionsMeta>;
  } {
    const stmt = db.prepare("SELECT role, permissions_json, updated_at, updated_by FROM role_permissions");
    const rows = stmt.all() as { role: string; permissions_json: string; updated_at: string; updated_by: string }[];

    const matrix = this.getAll();
    const metadata: Record<string, RolePermissionsMeta> = {
      administrator: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "system" },
      admin: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "system" },
      finance: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "system" },
      messenger: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "system" },
    };

    for (const r of rows) {
      if (r.role === "svp") continue;
      try {
        const parsed = JSON.parse(r.permissions_json);
        metadata[r.role] = {
          version: typeof parsed.version === "number" ? parsed.version : 1,
          updatedAt: r.updated_at || new Date().toISOString(),
          updatedBy: r.updated_by || "system",
        };
      } catch {
        // Fallback
      }
    }

    return { matrix, metadata };
  }

  public getByRole(role: string): RolePermissions | null {
    const cleanRole = role.toLowerCase().trim();
    if (cleanRole === "administrator") {
      return JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.administrator));
    }

    const stmt = db.prepare("SELECT permissions_json FROM role_permissions WHERE role = ?");
    const row = stmt.get(cleanRole) as { permissions_json: string } | undefined;
    if (!row) {
      return CANONICAL_PERMISSIONS[cleanRole] ? JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS[cleanRole])) : null;
    }

    try {
      const parsed = JSON.parse(row.permissions_json);
      return validateAndNormalizeRolePermissions(parsed, cleanRole);
    } catch {
      return CANONICAL_PERMISSIONS[cleanRole] ? JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS[cleanRole])) : null;
    }
  }

  public getByRoleWithMeta(role: string): PermissionRecordWithMeta | null {
    const cleanRole = role.toLowerCase().trim();
    if (cleanRole === "administrator") {
      return {
        permissions: JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS.administrator)),
        meta: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "system" },
      };
    }

    const stmt = db.prepare("SELECT permissions_json, updated_at, updated_by FROM role_permissions WHERE role = ?");
    const row = stmt.get(cleanRole) as { permissions_json: string; updated_at: string; updated_by: string } | undefined;
    if (!row) {
      const canonical = CANONICAL_PERMISSIONS[cleanRole];
      if (!canonical) return null;
      return {
        permissions: JSON.parse(JSON.stringify(canonical)),
        meta: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "system" },
      };
    }

    try {
      const parsed = JSON.parse(row.permissions_json);
      const version = typeof parsed.version === "number" ? parsed.version : 1;
      return {
        permissions: validateAndNormalizeRolePermissions(parsed, cleanRole),
        meta: {
          version,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by || "system",
        },
      };
    } catch {
      const canonical = CANONICAL_PERMISSIONS[cleanRole];
      return canonical
        ? {
            permissions: JSON.parse(JSON.stringify(canonical)),
            meta: { version: 1, updatedAt: row.updated_at, updatedBy: row.updated_by || "system" },
          }
        : null;
    }
  }

  /**
   * Saves role permissions (legacy synchronous wrapper).
   */
  public saveRole(role: string, permissions: RolePermissions, updatedBy = "system"): void {
    this.updateRoleTransactional(role, permissions, updatedBy);
  }

  /**
   * Atomically updates role permissions inside a managed transaction
   * with optimistic concurrency protection.
   */
  public updateRoleTransactional(
    role: string,
    permissions: { modules?: RolePermissions["modules"]; stages?: Partial<RolePermissions["stages"]> },
    updatedBy: string,
    options?: { expectedVersion?: number; lastUpdatedAt?: string }
  ): {
    role: string;
    before: RolePermissions;
    after: RolePermissions;
    version: number;
    updatedAt: string;
    updatedBy: string;
  } {
    const cleanRole = role.toLowerCase().trim();
    if (cleanRole === "svp" || cleanRole === "administrator") {
      throw new Error("Hak akses role SVP bersifat absolut dan tidak dapat diubah (Security Invariant).");
    }

    if (!["admin", "finance", "messenger"].includes(cleanRole)) {
      throw new Error(`Role '${role}' tidak diizinkan untuk dikonfigurasi melalui Dynamic RBAC.`);
    }

    return runInTransaction(() => {
      // 1. Fetch current record
      const stmtSelect = db.prepare("SELECT permissions_json, updated_at, updated_by FROM role_permissions WHERE role = ?");
      const currentRow = stmtSelect.get(cleanRole) as { permissions_json: string; updated_at: string; updated_by: string } | undefined;

      let currentVersion = 1;
      let currentPerms: RolePermissions = CANONICAL_PERMISSIONS[cleanRole]
        ? JSON.parse(JSON.stringify(CANONICAL_PERMISSIONS[cleanRole]))
        : { modules: {}, stages: {} as any };

      if (currentRow) {
        try {
          const parsed = JSON.parse(currentRow.permissions_json);
          currentPerms = {
            modules: parsed.modules || {},
            stages: parsed.stages || {},
          };
          if (typeof parsed.version === "number") {
            currentVersion = parsed.version;
          }
        } catch {
          // ignore corrupted json
        }

        // Concurrency conflict detection (optimistic locking)
        if (options?.expectedVersion !== undefined && options.expectedVersion !== currentVersion) {
          throw new ConcurrencyConflictError(
            `Konflik konkurensi: Versi konfigurasi hak akses saat ini adalah ${currentVersion}, namun request mengirimkan versi ${options.expectedVersion}. Silakan muat ulang halaman.`,
            currentVersion,
            options.expectedVersion
          );
        }

        if (options?.lastUpdatedAt && options.lastUpdatedAt !== currentRow.updated_at) {
          throw new ConcurrencyConflictError(
            `Konflik konkurensi: Konfigurasi hak akses telah diperbarui pada ${currentRow.updated_at} oleh sesi lain. Silakan muat ulang halaman.`,
            currentVersion,
            options.expectedVersion
          );
        }
      }

      // 2. Bump version
      const nextVersion = currentVersion + 1;

      // Validate and normalize permissions before persistence (preserving omitted modules and omitted stages)
      const validated = validateAndNormalizeRolePermissions({
        modules: {
          ...currentPerms.modules,
          ...(permissions.modules || {}),
        },
        stages: {
          ...currentPerms.stages,
          ...(permissions.stages || {}),
          stage6_supervisi: false,
        },
      }, cleanRole);

      const payloadToSave = {
        version: nextVersion,
        modules: validated.modules,
        stages: validated.stages,
      };

      // 3. Persist to SQLite
      const stmtUpsert = db.prepare(`
        INSERT INTO role_permissions (role, permissions_json, updated_at, updated_by)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(role) DO UPDATE SET
          permissions_json = excluded.permissions_json,
          updated_at = datetime('now'),
          updated_by = excluded.updated_by
      `);

      stmtUpsert.run(cleanRole, JSON.stringify(payloadToSave), updatedBy);

      // 4. Fetch the persisted updated_at
      const updatedRow = stmtSelect.get(cleanRole) as { updated_at: string } | undefined;
      const finalUpdatedAt = updatedRow?.updated_at || new Date().toISOString();

      return {
        role: cleanRole,
        before: currentPerms,
        after: {
          modules: validated.modules,
          stages: validated.stages,
        },
        version: nextVersion,
        updatedAt: finalUpdatedAt,
        updatedBy,
      };
    });
  }

  /**
   * Resets manageable roles to canonical defaults inside a managed transaction.
   */
  public resetToDefaults(updatedBy = "system"): { resetRoles: string[] } {
    return runInTransaction(() => {
      const stmt = db.prepare(`
        INSERT INTO role_permissions (role, permissions_json, updated_at, updated_by)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(role) DO UPDATE SET
          permissions_json = excluded.permissions_json,
          updated_at = datetime('now'),
          updated_by = excluded.updated_by
      `);

      const manageableRoles = ["admin", "finance", "messenger"];
      for (const r of manageableRoles) {
        if (CANONICAL_PERMISSIONS[r]) {
          const canonicalPayload = {
            version: 1,
            modules: CANONICAL_PERMISSIONS[r].modules,
            stages: CANONICAL_PERMISSIONS[r].stages,
          };
          stmt.run(r, JSON.stringify(canonicalPayload), updatedBy);
        }
      }

      return { resetRoles: manageableRoles };
    });
  }
}

export const dbPermissionRepository = new DbPermissionRepository();
