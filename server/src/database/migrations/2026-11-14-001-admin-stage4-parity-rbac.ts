import { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "../db";
import { CANONICAL_PERMISSIONS } from "../../config/defaultPermissions";

export const ADMIN_STAGE4_PARITY_MIGRATION_ID = "2026-11-14-001-admin-stage4-parity-rbac";

/**
 * Non-destructive, versioned, idempotent RBAC migration:
 * - Upgrades existing Admin role permissions (regardless of `updated_by` or JSON version)
 *   so Admin Operasional has full parity in Order, Order Tracking (Stages 1-5, 7-8),
 *   and Rekap Order, including `stage4_prosesSamsat: true`.
 * - Enforces the SVP-only security invariant: `stage6_supervisi` is strictly `false`
 *   for all persisted non-SVP roles (`admin`, `finance`, `messenger`).
 * - Preserves all custom module permissions on other modules and preserves audit history.
 * - Tracked in `schema_migrations` so repeated runs are strictly idempotent.
 */
export function runAdminStage4ParityRbacMigration(targetDb: DatabaseSync): {
  applied: boolean;
  adminUpdated: boolean;
  otherRolesNormalized: number;
} {
  // Ensure role_permissions table exists before migrating
  const tables = targetDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_permissions'")
    .all() as Array<{ name: string }>;
  if (tables.length === 0) {
    return { applied: false, adminUpdated: false, otherRolesNormalized: 0 };
  }

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT
    );
  `);

  return runInTransaction(() => {
    const alreadyApplied = targetDb
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(ADMIN_STAGE4_PARITY_MIGRATION_ID) as { id: string } | undefined;

    if (alreadyApplied) {
      return { applied: false, adminUpdated: false, otherRolesNormalized: 0 };
    }

    const adminRow = targetDb
      .prepare("SELECT permissions_json, updated_by FROM role_permissions WHERE role = 'admin'")
      .get() as { permissions_json: string; updated_by: string | null } | undefined;

    if (!adminRow) {
      // Table has not been seeded yet; defer marking applied until after role_permissions is populated
      return { applied: false, adminUpdated: false, otherRolesNormalized: 0 };
    }

    let adminUpdated = false;
    let parsedAdmin: any;
    try {
      parsedAdmin = JSON.parse(adminRow.permissions_json);
    } catch {
      parsedAdmin = {};
    }

    const currentModules = parsedAdmin && typeof parsedAdmin.modules === "object" && parsedAdmin.modules !== null
      ? { ...parsedAdmin.modules }
      : { ...CANONICAL_PERMISSIONS.admin.modules };
    const currentStages = parsedAdmin && typeof parsedAdmin.stages === "object" && parsedAdmin.stages !== null
      ? { ...parsedAdmin.stages }
      : { ...CANONICAL_PERMISSIONS.admin.stages };

    const requiredOrderModules = ["order-menu", "buat-order", "order-tracking", "order-history"] as const;
    for (const modKey of requiredOrderModules) {
      const existingMod = currentModules[modKey];
      if (!existingMod || existingMod.view !== true || existingMod.manage !== true) {
        currentModules[modKey] = { view: true, manage: true };
        adminUpdated = true;
      }
    }

    const targetAdminStages: Record<string, boolean> = {
      stage1_verifikasi: true,
      stage2_penjadwalan: true,
      stage3_verifikasiFisik: true,
      stage4_prosesSamsat: true,
      stage5_verifikasiUlang: true,
      stage6_supervisi: false, // Security Invariant: Stage 6 Supervisi is strictly SVP-only
      stage7_pengantaran: true,
      stage8_diterima: true,
    };

    for (const [stKey, targetVal] of Object.entries(targetAdminStages)) {
      if (currentStages[stKey] !== targetVal) {
        currentStages[stKey] = targetVal;
        adminUpdated = true;
      }
    }

    if (adminUpdated) {
      const nextPayload = {
        ...parsedAdmin,
        version: typeof parsedAdmin.version === "number" ? parsedAdmin.version : 1,
        modules: currentModules,
        stages: currentStages,
      };
      targetDb
        .prepare("UPDATE role_permissions SET permissions_json = ?, updated_at = datetime('now') WHERE role = 'admin'")
        .run(JSON.stringify(nextPayload));
    }

    // Enforce Stage 6 SVP-only invariant across finance/messenger rows non-destructively
    let otherRolesNormalized = 0;
    for (const nonSvpRole of ["finance", "messenger"]) {
      const row = targetDb
        .prepare("SELECT permissions_json FROM role_permissions WHERE role = ?")
        .get(nonSvpRole) as { permissions_json: string } | undefined;
      if (!row) continue;
      try {
        const parsed = JSON.parse(row.permissions_json);
        if (parsed?.stages && parsed.stages.stage6_supervisi === true) {
          parsed.stages.stage6_supervisi = false;
          targetDb
            .prepare("UPDATE role_permissions SET permissions_json = ?, updated_at = datetime('now') WHERE role = ?")
            .run(JSON.stringify(parsed), nonSvpRole);
          otherRolesNormalized++;
        }
      } catch {
        // Ignore non-JSON rows non-destructively
      }
    }

    targetDb
      .prepare("INSERT INTO schema_migrations (id, description) VALUES (?, ?)")
      .run(
        ADMIN_STAGE4_PARITY_MIGRATION_ID,
        "Non-destructive upgrade for Admin Order & Stage 4 parity with strict Stage 6 SVP-only lock"
      );

    return { applied: true, adminUpdated, otherRolesNormalized };
  }, targetDb);
}
