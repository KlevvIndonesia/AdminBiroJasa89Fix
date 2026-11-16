/**
 * Canonical Identity & Role Resolution Module
 * Admin SUN89 — Biro Jasa Management System
 *
 * Single source of truth for:
 * - Strict prefixed user ID parsing (usr-<id> <-> positive integer users.id)
 * - Canonical 4-role normalization (administrator, admin, finance, messenger)
 * - Conflict detection between authoritative jabatan and stored role
 * - Legacy SVP row boundary handling (jabatan="SVP", role="svp" -> "administrator")
 * - Authoritative SQLite actor verification inside auth middleware & transactions
 */

import { db } from "../database/db";

export const CANONICAL_ROLES = ["administrator", "admin", "finance", "messenger"] as const;
export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

export type ParsedUserIdResult =
  | {
      valid: true;
      numericId: number;
      canonicalUserId: string;
    }
  | {
      valid: false;
      reason: string;
    };

export interface AuthenticatedDbActor {
  numericUserId: number;
  canonicalUserId: string;
  email: string;
  employeeId: string | null;
  nama: string;
  jabatan: string | null;
  storedRole: string | null;
  canonicalRole: CanonicalRole;
  status: string;
  isLegacySvpRole: boolean;
}

export type ActorResolutionFailureCode =
  | "FORBIDDEN_INVALID_ACTOR"
  | "FORBIDDEN_USER_NOT_FOUND"
  | "FORBIDDEN_USER_INACTIVE"
  | "FORBIDDEN_INVALID_ROLE";

export type ActorResolutionResult =
  | {
      ok: true;
      actor: AuthenticatedDbActor;
    }
  | {
      ok: false;
      statusCode: 403;
      code: ActorResolutionFailureCode;
      message: string;
    };

const JABATAN_TO_CANONICAL_ROLE: Readonly<Record<string, CanonicalRole>> = {
  SVP: "administrator",
  ADMIN: "admin",
  FINANCE: "finance",
  MESSENGER: "messenger",
  KURIR: "messenger",
};

const STRICT_CANONICAL_USER_ID_REGEX = /^(?:usr-)?([1-9]\d*)$/;

/**
 * Strictly parses a user identifier into a positive safe integer DB PK and canonical "usr-<id>" string.
 * Rejects malformed, zero, negative, decimal, leading-zero, whitespace-padded, scientific-notation,
 * employee-ID ("EMP-*"), or arbitrary non-numeric strings.
 */
export function parseStrictUserId(input: unknown): ParsedUserIdResult {
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input <= 0) {
      return { valid: false, reason: "INVALID_NUMERIC_USER_ID" };
    }
    return {
      valid: true,
      numericId: input,
      canonicalUserId: `usr-${input}`,
    };
  }

  if (typeof input !== "string" || input.length === 0) {
    return { valid: false, reason: "EMPTY_OR_NON_STRING_USER_ID" };
  }

  const match = STRICT_CANONICAL_USER_ID_REGEX.exec(input);
  if (!match) {
    return { valid: false, reason: "MALFORMED_USER_ID" };
  }

  const numericId = Number(match[1]);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return { valid: false, reason: "UNSAFE_INTEGER_USER_ID" };
  }

  return {
    valid: true,
    numericId,
    canonicalUserId: `usr-${numericId}`,
  };
}

/**
 * Convenience wrapper returning positive integer DB user ID or null.
 */
export function parsePositiveDbUserId(input: unknown): number | null {
  const parsed = parseStrictUserId(input);
  return parsed.valid ? parsed.numericId : null;
}

/**
 * Convenience wrapper returning canonical "usr-<id>" string or null.
 */
export function normalizeCanonicalUserId(input: unknown): string | null {
  const parsed = parseStrictUserId(input);
  return parsed.valid ? parsed.canonicalUserId : null;
}

/**
 * Normalizes a direct role string strictly against the 4 canonical roles
 * (plus "kurir" -> "messenger" for historical field parity).
 * Legacy privilege aliases ("svp", "spv", "supervisor") and unknown values return null.
 */
export function normalizeCanonicalRole(role?: string | null): CanonicalRole | null {
  if (typeof role !== "string") return null;
  const norm = role.toLowerCase().trim();
  if (!norm) return null;

  if (norm === "administrator") return "administrator";
  if (norm === "admin") return "admin";
  if (norm === "finance") return "finance";
  if (norm === "messenger" || norm === "kurir") return "messenger";

  return null;
}

/**
 * Maps an authoritative employee/user jabatan string to one of the 4 canonical roles.
 * Unknown jabatan values fail closed (null).
 */
export function mapJabatanToCanonicalRole(jabatan?: string | null): CanonicalRole | null {
  if (typeof jabatan !== "string") return null;
  const norm = jabatan.toUpperCase().trim();
  if (!norm) return null;
  return JABATAN_TO_CANONICAL_ROLE[norm] ?? null;
}

/**
 * Resolves canonical user role from authoritative `jabatan` and persisted `storedRole`.
 * Fail-closed guarantees:
 * 1. Unknown non-empty `jabatan` ALWAYS returns null (never falls back to "admin" or `storedRole`).
 * 2. When `jabatan` maps to a canonical role AND `storedRole` is non-empty:
 *    - Legacy exception: `jabatan === "SVP"` with `storedRole === "svp"` resolves deterministically to `"administrator"`.
 *    - Historical alias: `jabatan === "MESSENGER" | "KURIR"` with `storedRole === "kurir"` resolves to `"messenger"`.
 *    - Otherwise `storedRole` MUST match the mapped canonical role; any mismatch fails closed (null).
 * 3. When `jabatan` is empty/null, `storedRole` must match one of the 4 canonical roles (rejecting "svp"/"spv"/"supervisor").
 */
export function resolveCanonicalRoleFromUser(
  jabatan?: string | null,
  storedRole?: string | null
): CanonicalRole | null {
  const upperJabatan = typeof jabatan === "string" ? jabatan.toUpperCase().trim() : "";
  const lowerStored = typeof storedRole === "string" ? storedRole.toLowerCase().trim() : "";

  if (upperJabatan) {
    const mappedRole = JABATAN_TO_CANONICAL_ROLE[upperJabatan];
    if (!mappedRole) {
      return null;
    }

    if (lowerStored) {
      const isLegacySvpMatch = upperJabatan === "SVP" && lowerStored === "svp";
      const isMessengerKurirMatch = mappedRole === "messenger" && lowerStored === "kurir";
      if (lowerStored !== mappedRole && !isLegacySvpMatch && !isMessengerKurirMatch) {
        return null;
      }
    }

    return mappedRole;
  }

  return normalizeCanonicalRole(lowerStored);
}

/**
 * Authoritative check for canonical administrator (SVP) privilege.
 * Never checks legacy "svp", "spv", or "supervisor" aliases.
 */
export function isCanonicalAdministrator(user?: { role?: string | null } | null): boolean {
  if (!user) return false;
  return normalizeCanonicalRole(user.role) === "administrator";
}

/**
 * Resolves and verifies an actor against SQLite `users` inside the active connection/transaction.
 * Accepts canonical `"usr-<id>"` or positive integer `id` via strict parser.
 * Fails closed on malformed IDs, missing users, inactive users, conflicting jabatan/role, or unknown role.
 */
export function resolveAuthenticatedDbActor(
  actorInput: unknown,
  targetDb: typeof db = db
): ActorResolutionResult {
  const parsed = parseStrictUserId(actorInput);
  if (!parsed.valid) {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN_INVALID_ACTOR",
      message: "Akses ditolak: Identitas aktor tidak valid atau tidak terformat kanonikal.",
    };
  }

  const row = targetDb
    .prepare(
      `SELECT id, email, employee_id, nama, jabatan, role, status
       FROM users
       WHERE id = ?`
    )
    .get(parsed.numericId) as
    | {
        id: number;
        email: string;
        employee_id: string | null;
        nama: string;
        jabatan: string | null;
        role: string | null;
        status: string;
      }
    | undefined;

  if (!row) {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN_USER_NOT_FOUND",
      message: "Akses ditolak: Identitas aktor tidak ditemukan di database.",
    };
  }

  if (row.status !== "Aktif") {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN_USER_INACTIVE",
      message: "Akses ditolak: Akun pengguna tidak aktif.",
    };
  }

  const canonicalRole = resolveCanonicalRoleFromUser(row.jabatan, row.role);
  if (!canonicalRole) {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN_INVALID_ROLE",
      message: "Akses ditolak: Akun tidak memiliki jabatan atau role kanonikal yang valid.",
    };
  }

  const isLegacySvpRole =
    (row.jabatan || "").toUpperCase().trim() === "SVP" &&
    (row.role || "").toLowerCase().trim() === "svp";

  return {
    ok: true,
    actor: {
      numericUserId: Number(row.id),
      canonicalUserId: `usr-${Number(row.id)}`,
      email: row.email,
      employeeId: row.employee_id || null,
      nama: row.nama,
      jabatan: row.jabatan ?? null,
      storedRole: row.role ?? null,
      canonicalRole,
      status: row.status,
      isLegacySvpRole,
    },
  };
}
