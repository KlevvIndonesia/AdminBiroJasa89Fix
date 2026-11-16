/**
 * Manual Database Migration Preparation: Normalize Legacy SVP Role to Canonical 'administrator'
 * ID: 2026-11-15-001-normalize-svp-role-to-administrator
 *
 * SAFETY POLICY (Batch 1 Remediation):
 * - NEVER auto-executed on server startup (not wired into schema.ts, seed.ts, or app.ts).
 * - Requires explicit operator review via preview/dry-run and manual approval.
 * - Transactional & idempotent via `schema_migrations`.
 * - Strictly targets rows where LOWER(TRIM(role)) = 'svp' AND UPPER(TRIM(jabatan)) = 'SVP'.
 * - Preserves `jabatan`, `employee_id`, password credentials, `role_permissions`, and historical `audit_logs`.
 * - Does NOT auto-upgrade anomalous rows where role = 'svp' but jabatan != 'SVP'.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db, runInTransaction } from "../db";

export const LEGACY_SVP_MIGRATION_ID = "2026-11-15-001-normalize-svp-role-to-administrator";

export interface MigrationUserPreviewRow {
  id: number;
  email: string;
  nama: string;
  jabatan: string | null;
  role: string | null;
  status: string;
  employee_id: string | null;
}

export interface LegacySvpMigrationPreview {
  migrationId: string;
  alreadyApplied: boolean;
  targetUsers: MigrationUserPreviewRow[];
  anomalousUsers: MigrationUserPreviewRow[];
  countToUpdate: number;
}

export interface LegacySvpMigrationApplyResult {
  migrationId: string;
  applied: boolean;
  alreadyApplied: boolean;
  updatedCount: number;
  updatedUserIds: number[];
  anomalousSkippedIds: number[];
}

export interface LegacySvpMigrationRollbackResult {
  migrationId: string;
  rolledBack: boolean;
  revertedCount: number;
  revertedUserIds: number[];
}

function ensureSchemaMigrationsTable(targetDb: DatabaseSync): void {
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function isMigrationApplied(targetDb: DatabaseSync): boolean {
  const tableRow = targetDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!tableRow) return false;

  const existing = targetDb
    .prepare("SELECT 1 as ok FROM schema_migrations WHERE id = ?")
    .get(LEGACY_SVP_MIGRATION_ID) as { ok: number } | undefined;
  return Boolean(existing);
}

/**
 * Strictly read-only dry-run preview identifying rows eligible for migration
 * vs anomalous legacy 'svp' rows lacking authoritative 'SVP' jabatan.
 */
export function previewLegacySvpRoleMigration(targetDb: DatabaseSync = db): LegacySvpMigrationPreview {
  const alreadyApplied = isMigrationApplied(targetDb);

  const targetUsers = targetDb
    .prepare(
      `SELECT id, email, nama, jabatan, role, status, employee_id
       FROM users
       WHERE LOWER(TRIM(COALESCE(role, ''))) = 'svp'
         AND UPPER(TRIM(COALESCE(jabatan, ''))) = 'SVP'
       ORDER BY id ASC`
    )
    .all() as unknown as MigrationUserPreviewRow[];

  const anomalousUsers = targetDb
    .prepare(
      `SELECT id, email, nama, jabatan, role, status, employee_id
       FROM users
       WHERE LOWER(TRIM(COALESCE(role, ''))) = 'svp'
         AND UPPER(TRIM(COALESCE(jabatan, ''))) != 'SVP'
       ORDER BY id ASC`
    )
    .all() as unknown as MigrationUserPreviewRow[];

  return {
    migrationId: LEGACY_SVP_MIGRATION_ID,
    alreadyApplied,
    targetUsers,
    anomalousUsers,
    countToUpdate: targetUsers.length,
  };
}

/**
 * Executes the idempotent transactional migration inside a BEGIN IMMEDIATE write lock.
 * Requires explicit caller invocation (not wired into automatic server startup).
 */
export function runLegacySvpRoleMigration(
  targetDb: DatabaseSync = db,
  options?: { approvedBy?: string; note?: string }
): LegacySvpMigrationApplyResult {
  const approvedBy = (options?.approvedBy || "manual-operator").trim() || "manual-operator";

  return runInTransaction(() => {
    ensureSchemaMigrationsTable(targetDb);

    if (isMigrationApplied(targetDb)) {
      return {
        migrationId: LEGACY_SVP_MIGRATION_ID,
        applied: false,
        alreadyApplied: true,
        updatedCount: 0,
        updatedUserIds: [],
        anomalousSkippedIds: [],
      };
    }

    const preview = previewLegacySvpRoleMigration(targetDb);
    const updatedUserIds = preview.targetUsers.map((u) => Number(u.id));
    const anomalousSkippedIds = preview.anomalousUsers.map((u) => Number(u.id));

    if (updatedUserIds.length > 0) {
      targetDb
        .prepare(
          `UPDATE users
           SET role = 'administrator',
               updated_at = datetime('now')
           WHERE LOWER(TRIM(COALESCE(role, ''))) = 'svp'
             AND UPPER(TRIM(COALESCE(jabatan, ''))) = 'SVP'`
        )
        .run();
    }

    targetDb
      .prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))`)
      .run(LEGACY_SVP_MIGRATION_ID);

    const hasAuditTable = Boolean(
      targetDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'")
        .get()
    );
    if (hasAuditTable) {
      targetDb
        .prepare(
          `INSERT INTO audit_logs (id, user_id, user_name, user_role, action, module, details, metadata_json, created_at)
           VALUES (?, ?, ?, ?, 'MIGRATION_APPLY', 'Database Migration', ?, ?, datetime('now'))`
        )
        .run(
          `log-mig-${crypto.randomUUID()}`,
          "usr-system",
          approvedBy,
          "administrator",
          `Applied migration ${LEGACY_SVP_MIGRATION_ID}: updated ${updatedUserIds.length} SVP user(s) to canonical role 'administrator'.`,
          JSON.stringify({
            migrationId: LEGACY_SVP_MIGRATION_ID,
            updatedUserIds,
            anomalousSkippedIds,
            note: options?.note || "Manual approved Batch 1 SVP role normalization",
          })
        );
    }

    return {
      migrationId: LEGACY_SVP_MIGRATION_ID,
      applied: true,
      alreadyApplied: false,
      updatedCount: updatedUserIds.length,
      updatedUserIds,
      anomalousSkippedIds,
    };
  }, targetDb);
}

/**
 * Transactional rollback procedure restoring previously migrated user rows back to legacy role = 'svp'.
 */
export function rollbackLegacySvpRoleMigration(
  targetDb: DatabaseSync = db,
  options?: { approvedBy?: string; targetUserIds?: number[] }
): LegacySvpMigrationRollbackResult {
  const approvedBy = (options?.approvedBy || "manual-operator").trim() || "manual-operator";

  return runInTransaction(() => {
    ensureSchemaMigrationsTable(targetDb);

    if (!isMigrationApplied(targetDb)) {
      return {
        migrationId: LEGACY_SVP_MIGRATION_ID,
        rolledBack: false,
        revertedCount: 0,
        revertedUserIds: [],
      };
    }

    let targetUserIds = options?.targetUserIds ? [...options.targetUserIds] : [];
    if (targetUserIds.length === 0) {
      const hasAuditTable = Boolean(
        targetDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'")
          .get()
      );
      if (hasAuditTable) {
        const auditRow = targetDb
          .prepare(
            `SELECT metadata_json FROM audit_logs
             WHERE action = 'MIGRATION_APPLY' AND metadata_json LIKE ?
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(`%${LEGACY_SVP_MIGRATION_ID}%`) as { metadata_json: string } | undefined;
        if (auditRow?.metadata_json) {
          try {
            const parsed = JSON.parse(auditRow.metadata_json);
            if (Array.isArray(parsed.updatedUserIds)) {
              targetUserIds = parsed.updatedUserIds.map(Number).filter((n: number) => Number.isSafeInteger(n) && n > 0);
            }
          } catch {}
        }
      }
    }

    const revertedUserIds: number[] = [];
    if (targetUserIds.length > 0) {
      const placeholders = targetUserIds.map(() => "?").join(", ");
      const res = targetDb
        .prepare(
          `UPDATE users
           SET role = 'svp',
               updated_at = datetime('now')
           WHERE id IN (${placeholders})
             AND UPPER(TRIM(COALESCE(jabatan, ''))) = 'SVP'
             AND LOWER(TRIM(COALESCE(role, ''))) = 'administrator'`
        )
        .run(...targetUserIds);
      if (res.changes > 0) {
        revertedUserIds.push(...targetUserIds);
      }
    }

    targetDb
      .prepare("DELETE FROM schema_migrations WHERE id = ?")
      .run(LEGACY_SVP_MIGRATION_ID);

    const hasAuditTable = Boolean(
      targetDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'")
        .get()
    );
    if (hasAuditTable) {
      targetDb
        .prepare(
          `INSERT INTO audit_logs (id, user_id, user_name, user_role, action, module, details, metadata_json, created_at)
           VALUES (?, ?, ?, ?, 'MIGRATION_ROLLBACK', 'Database Migration', ?, ?, datetime('now'))`
        )
        .run(
          `log-mig-rb-${crypto.randomUUID()}`,
          "usr-system",
          approvedBy,
          "administrator",
          `Rolled back migration ${LEGACY_SVP_MIGRATION_ID} (${revertedUserIds.length} user(s) reverted).`,
          JSON.stringify({
            migrationId: LEGACY_SVP_MIGRATION_ID,
            revertedUserIds,
          })
        );
    }

    return {
      migrationId: LEGACY_SVP_MIGRATION_ID,
      rolledBack: true,
      revertedCount: revertedUserIds.length,
      revertedUserIds,
    };
  }, targetDb);
}
