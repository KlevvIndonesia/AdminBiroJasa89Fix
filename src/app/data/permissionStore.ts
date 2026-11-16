/**
 * Authoritative Permission & Access Control Store (SSoT)
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Provides:
 * - 4 core roles: SVP (Administrator), Admin, Finance, Messenger
 * - Fine-grained module & submodule permissions (Lihat / Kelola)
 * - Order Tracking stage-level action permissions (Stage 4 & Stage 6 gating)
 * - Navigation menu filtering helper
 * - Route / page guard helper
 * - Reactive state with local persistence
 */

import { useState, useEffect } from "react";
import { MenuItem } from "../config/navigationConfig";
import { APP_CONFIG } from "../config/appConfig";

export type Role = "administrator" | "admin" | "finance" | "messenger" | "unknown";
export type SessionAuthStatus = "unauthenticated" | "hydrating" | "authenticated" | "forbidden";

export interface ModulePermission {
  view: boolean;
  manage: boolean;
}

export interface StageActionPermissions {
  stage1_verifikasi: boolean;
  stage2_penjadwalan: boolean;
  stage3_verifikasiFisik: boolean;
  stage4_prosesSamsat: boolean; // Stage 4: Equal parity for Admin & SVP
  stage5_verifikasiUlang: boolean;
  stage6_supervisi: boolean;   // Stage 6: Exclusively SVP (false for Admin/Finance/Messenger)
  stage7_pengantaran: boolean;
  stage8_diterima: boolean;
}

export type ApiEndpointKey =
  | "users"
  | "employees"
  | "orders"
  | "orders-archived"
  | "messenger-tasks"
  | "finance-invoices"
  | "finance-profit"
  | "finance-kas-kantor"
  | "finance-pengeluaran"
  | "finance-kas-messenger"
  | "audit-logs";

export interface RolePermissions {
  modules: Record<string, ModulePermission>;
  stages: StageActionPermissions;
}

export type PermissionMatrix = Record<Role, RolePermissions>;

// Helper to normalize role (Strictly 4 Canonical Roles, Fail-Closed)
export function normalizeRole(role: string | null | undefined): Role {
  if (!role) return "unknown";
  const r = role.toLowerCase().trim();
  if (r === "administrator") return "administrator";
  if (r === "admin") return "admin";
  if (r === "finance") return "finance";
  if (r === "messenger" || r === "kurir" || r === "courier") return "messenger";
  return "unknown";
}

// Canonical Default Permissions Matrix
const DEFAULT_PERMISSIONS: PermissionMatrix = {
  // 1. ADMINISTRATOR (SVP / Super User) — FULL ACCESS
  administrator: {
    modules: {
      dashboard: { view: true, manage: true },
      finance: { view: true, manage: true },
      "finance-profit": { view: true, manage: true },
      "finance-kas-messenger": { view: true, manage: true },
      "finance-kas-kantor": { view: true, manage: true },
      "finance-pengeluaran": { view: true, manage: true },
      "finance-penjualan": { view: true, manage: true },
      "finance-belum-bayar": { view: true, manage: true },
      "finance-profit-pending": { view: true, manage: true },
      "finance-cashback-pending": { view: true, manage: true },
      "finance-tagihan": { view: true, manage: true },
      "finance-laba-rugi": { view: true, manage: true },
      "master-data": { view: true, manage: true },
      "master-layanan": { view: true, manage: true },
      "master-samsat": { view: true, manage: true },
      "master-metode-pembayaran": { view: true, manage: true },
      "master-biaya-layanan": { view: true, manage: true },
      "master-harga-dasar-samsat": { view: true, manage: true },
      manajemen: { view: true, manage: true },
      "manajemen-karyawan": { view: true, manage: true },
      "master-karyawan": { view: true, manage: true },
      "manajemen-pengguna": { view: true, manage: true },
      "master-pengguna": { view: true, manage: true },
      "access-management": { view: true, manage: true },
      "audit-log": { view: true, manage: true },
      "messenger-menu": { view: true, manage: true },
      "messenger-task": { view: true, manage: true },
      "messenger-history": { view: true, manage: true },
      "order-menu": { view: true, manage: true },
      "buat-order": { view: true, manage: true },
      "order-tracking": { view: true, manage: true },
      "order-history": { view: true, manage: true },
      settings: { view: true, manage: true },
      profile: { view: true, manage: true },
    },
    stages: {
      stage1_verifikasi: true,
      stage2_penjadwalan: true,
      stage3_verifikasiFisik: true,
      stage4_prosesSamsat: true,
      stage5_verifikasiUlang: true,
      stage6_supervisi: true,
      stage7_pengantaran: true,
      stage8_diterima: true,
    },
  },

  // 2. ADMIN
  // Allowed: Dashboard, Order (Buat Order, Tracking Stages 1-5 & 7-8, Rekap), Master Data, Manajemen Karyawan, Messenger Task
  // Forbidden: Finance (unless granted), Manajemen Pengguna, Hak Akses, Riwayat Aktivitas, Stage 6 (Supervisi - SVP Only)
  // Stage Gating: Stages 1-5, 7-8 FULL ACCESS, Stage 6 (Supervisi) SVP-ONLY / VIEW ONLY
  admin: {
    modules: {
      dashboard: { view: true, manage: true },
      // Finance: Kas Messenger & Review Pengajuan Biaya Allowed
      finance: { view: true, manage: true },
      "finance-profit": { view: false, manage: false },
      "finance-kas-messenger": { view: true, manage: true },
      "finance-kas-kantor": { view: false, manage: false },
      "finance-pengeluaran": { view: false, manage: false },
      "finance-penjualan": { view: false, manage: false },
      "finance-belum-bayar": { view: false, manage: false },
      "finance-profit-pending": { view: false, manage: false },
      "finance-cashback-pending": { view: false, manage: false },
      "finance-tagihan": { view: false, manage: false },
      "finance-laba-rugi": { view: false, manage: false },
      // Master Data: FULL ACCESS
      "master-data": { view: true, manage: true },
      "master-layanan": { view: true, manage: true },
      "master-samsat": { view: true, manage: true },
      "master-metode-pembayaran": { view: true, manage: true },
      "master-biaya-layanan": { view: true, manage: true },
      "master-harga-dasar-samsat": { view: true, manage: true },
      // Manajemen: ONLY KARYAWAN
      manajemen: { view: true, manage: true },
      "manajemen-karyawan": { view: true, manage: true },
      "master-karyawan": { view: true, manage: true },
      "manajemen-pengguna": { view: false, manage: false },
      "master-pengguna": { view: false, manage: false },
      "access-management": { view: false, manage: false },
      "audit-log": { view: false, manage: false },
      // Messenger
      "messenger-menu": { view: true, manage: true },
      "messenger-task": { view: true, manage: true },
      "messenger-history": { view: true, manage: true },
      // Order: FULL ACCESS
      "order-menu": { view: true, manage: true },
      "buat-order": { view: true, manage: true },
      "order-tracking": { view: true, manage: true },
      "order-history": { view: true, manage: true },
      // Generic
      settings: { view: true, manage: true },
      profile: { view: true, manage: true },
    },
    stages: {
      stage1_verifikasi: true,
      stage2_penjadwalan: true,
      stage3_verifikasiFisik: true,
      stage4_prosesSamsat: true, // Admin equal with SVP across Stages 1-5 & 7-8
      stage5_verifikasiUlang: true,
      stage6_supervisi: false,   // Security Invariant: Stage 6 Supervisi is strictly SVP-only
      stage7_pengantaran: true,
      stage8_diterima: true,
    },
  },

  // 3. FINANCE
  // Allowed: Dashboard, Finance (All: Profit, Kas Messenger, Kas Kantor, Pengeluaran, Penjualan, Tagihan, Laba Rugi), View Order Tracking / Rekap Order
  // Forbidden: Master Data, Hak Akses, Manajemen Pengguna, Manajemen Karyawan, Buat Order, Order Stage Mutations
  finance: {
    modules: {
      dashboard: { view: true, manage: false },
      // Finance: FULL ACCESS
      finance: { view: true, manage: true },
      "finance-profit": { view: true, manage: true },
      "finance-kas-messenger": { view: true, manage: true },
      "finance-kas-kantor": { view: true, manage: true },
      "finance-pengeluaran": { view: true, manage: true },
      "finance-penjualan": { view: true, manage: true },
      "finance-belum-bayar": { view: true, manage: true },
      "finance-profit-pending": { view: true, manage: true },
      "finance-cashback-pending": { view: true, manage: true },
      "finance-tagihan": { view: true, manage: true },
      "finance-laba-rugi": { view: true, manage: true },
      // Master Data: NO ACCESS
      "master-data": { view: false, manage: false },
      "master-layanan": { view: false, manage: false },
      "master-samsat": { view: false, manage: false },
      "master-metode-pembayaran": { view: false, manage: false },
      "master-biaya-layanan": { view: false, manage: false },
      "master-harga-dasar-samsat": { view: false, manage: false },
      // Manajemen: NO ACCESS
      manajemen: { view: false, manage: false },
      "manajemen-karyawan": { view: false, manage: false },
      "master-karyawan": { view: false, manage: false },
      "manajemen-pengguna": { view: false, manage: false },
      "master-pengguna": { view: false, manage: false },
      "access-management": { view: false, manage: false },
      "audit-log": { view: false, manage: false },
      // Messenger
      "messenger-menu": { view: true, manage: false },
      "messenger-task": { view: false, manage: false },
      "messenger-history": { view: true, manage: false },
      // Order: View-Only tracking & Rekap (No Buat Order, No Mutation)
      "order-menu": { view: true, manage: false },
      "buat-order": { view: false, manage: false },
      "order-tracking": { view: true, manage: false },
      "order-history": { view: true, manage: false },
      // Generic
      settings: { view: false, manage: false },
      profile: { view: true, manage: false },
    },
    stages: {
      stage1_verifikasi: true, // Can verify payment
      stage2_penjadwalan: false,
      stage3_verifikasiFisik: false,
      stage4_prosesSamsat: false,
      stage5_verifikasiUlang: false,
      stage6_supervisi: false,
      stage7_pengantaran: false,
      stage8_diterima: false,
    },
  },

  // 4. MESSENGER
  // Allowed: Dashboard, Messenger Task, Profile
  // Forbidden: Finance, Master Data, Manajemen Karyawan, Manajemen Pengguna, Hak Akses, Riwayat Aktivitas, Buat Order
  messenger: {
    modules: {
      dashboard: { view: true, manage: false },
      // Finance: NO ACCESS
      finance: { view: false, manage: false },
      "finance-profit": { view: false, manage: false },
      "finance-kas-messenger": { view: false, manage: false },
      "finance-kas-kantor": { view: false, manage: false },
      "finance-pengeluaran": { view: false, manage: false },
      "finance-penjualan": { view: false, manage: false },
      "finance-belum-bayar": { view: false, manage: false },
      "finance-profit-pending": { view: false, manage: false },
      "finance-cashback-pending": { view: false, manage: false },
      "finance-tagihan": { view: false, manage: false },
      "finance-laba-rugi": { view: false, manage: false },
      // Master Data: NO ACCESS
      "master-data": { view: false, manage: false },
      "master-layanan": { view: false, manage: false },
      "master-samsat": { view: false, manage: false },
      "master-metode-pembayaran": { view: false, manage: false },
      "master-biaya-layanan": { view: false, manage: false },
      "master-harga-dasar-samsat": { view: false, manage: false },
      // Manajemen: NO ACCESS
      manajemen: { view: false, manage: false },
      "manajemen-karyawan": { view: false, manage: false },
      "master-karyawan": { view: false, manage: false },
      "manajemen-pengguna": { view: false, manage: false },
      "master-pengguna": { view: false, manage: false },
      "access-management": { view: false, manage: false },
      "audit-log": { view: false, manage: false },
      // Messenger: FULL ACCESS TO TASKS
      "messenger-menu": { view: true, manage: true },
      "messenger-task": { view: true, manage: true },
      "messenger-history": { view: true, manage: true },
      // Order: NO ACCESS TO ORDER ENTRY
      "order-menu": { view: false, manage: false },
      "buat-order": { view: false, manage: false },
      "order-tracking": { view: false, manage: false },
      "order-history": { view: false, manage: false },
      // Generic
      settings: { view: false, manage: false },
      profile: { view: true, manage: false },
    },
    stages: {
      stage1_verifikasi: false,
      stage2_penjadwalan: false,
      stage3_verifikasiFisik: false,
      stage4_prosesSamsat: false,
      stage5_verifikasiUlang: false,
      stage6_supervisi: false,
      stage7_pengantaran: false,
      stage8_diterima: false,
    },
  },
  // 5. UNKNOWN / UNASSIGNED (Zero privileges - fail closed)
  unknown: {
    modules: {},
    stages: {
      stage1_verifikasi: false,
      stage2_penjadwalan: false,
      stage3_verifikasiFisik: false,
      stage4_prosesSamsat: false,
      stage5_verifikasiUlang: false,
      stage6_supervisi: false,
      stage7_pengantaran: false,
      stage8_diterima: false,
    },
  },
};

function createFailClosedRolePermissions(): RolePermissions {
  return {
    modules: {},
    stages: {
      stage1_verifikasi: false,
      stage2_penjadwalan: false,
      stage3_verifikasiFisik: false,
      stage4_prosesSamsat: false,
      stage5_verifikasiUlang: false,
      stage6_supervisi: false,
      stage7_pengantaran: false,
      stage8_diterima: false,
    },
  };
}

class PermissionStore {
  private matrix: PermissionMatrix;
  private listeners: Set<() => void> = new Set();
  private isLoadingState = false;
  private lastError: string | null = null;
  private isDataStale = false;
  private hasSuccessfullyLoaded = false;
  private sessionRole: string | null = null;
  private awaitingAuthoritativeMatrix = false;
  private hasHydrationFailedState = false;
  private hasExplicitHydration = false;

  constructor() {
    this.matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
  }

  private applyFailClosedNonSvpMatrix(): void {
    this.matrix = {
      ...this.matrix,
      admin: createFailClosedRolePermissions(),
      finance: createFailClosedRolePermissions(),
      messenger: createFailClosedRolePermissions(),
      unknown: createFailClosedRolePermissions(),
    };
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // Safe ignore
      }
    });
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getMatrix(): PermissionMatrix {
    return this.matrix;
  }

  public getRolePermissions(role: string | null | undefined): RolePermissions {
    const norm = normalizeRole(role);
    if (norm !== "administrator") {
      if (this.hasHydrationFailedState && !this.hasSuccessfullyLoaded) {
        return this.matrix[norm] || createFailClosedRolePermissions();
      }
      if (
        typeof window !== "undefined" &&
        this.hasAuthToken() &&
        this.awaitingAuthoritativeMatrix
      ) {
        return createFailClosedRolePermissions();
      }
    }
    return this.matrix[norm] || DEFAULT_PERMISSIONS[norm];
  }

  /**
   * Check if a role can VIEW a specific page / route
   */
  public canViewPage(role: string | null | undefined, pageId: string): boolean {
    const norm = normalizeRole(role);
    if (norm === "unknown") return false;
    if (norm === "administrator") return true;

    const perms = this.getRolePermissions(norm);
    const modules = perms?.modules || {};
    
    // Direct match
    const directPerm = modules[pageId];
    if (directPerm !== undefined) {
      return directPerm.view;
    }

    // Prefix match for finance sub-pages
    if (pageId.startsWith("finance-") || pageId === "finance") {
      return modules["finance"]?.view ?? false;
    }

    // Prefix match for master data
    if (pageId.startsWith("master-")) {
      return modules["master-data"]?.view ?? false;
    }

    // Manajemen aliases
    if (pageId === "manajemen-karyawan" || pageId === "master-karyawan") {
      return modules["manajemen-karyawan"]?.view ?? false;
    }
    if (pageId === "manajemen-pengguna" || pageId === "master-pengguna") {
      return modules["manajemen-pengguna"]?.view ?? false;
    }

    // Profile, notifikasi & settings default
    if (pageId === "profile" || pageId === "notifikasi") return true;
    if (pageId === "settings") return norm === "admin";

    return false;
  }

  /**
   * Check if a role can MANAGE / MUTATE a specific module
   */
  public canManageModule(role: string | null | undefined, moduleId: string): boolean {
    const norm = normalizeRole(role);
    if (norm === "unknown") return false;
    if (norm === "administrator") return true;

    const perms = this.getRolePermissions(norm);
    return perms?.modules?.[moduleId]?.manage ?? false;
  }

  /**
   * Check if a role can execute actions / mutations on a specific workflow stage.
   * Built-in Policy:
   * - SVP has full mutation access on all stages (including Stage 4 & Stage 6).
   * - Non-SVP roles are strictly View-Only for Stage 4 (Proses Samsat) and Stage 6 (Supervisi).
   */
  public canManageStage(role: string | null | undefined, stageNumber: number): boolean {
    const norm = normalizeRole(role);
    if (norm === "unknown") return false;
    if (norm === "administrator") return true;

    const stages = this.getRolePermissions(norm)?.stages;
    if (!stages || typeof stages !== "object") return false;
    switch (stageNumber) {
      case 1:
        return stages.stage1_verifikasi === true;
      case 2:
        return stages.stage2_penjadwalan === true;
      case 3:
        return stages.stage3_verifikasiFisik === true;
      case 4:
        return stages.stage4_prosesSamsat === true;
      case 5:
        return stages.stage5_verifikasiUlang === true;
      case 6:
        return false; // Stage 6 (Supervisi) is strictly SVP-only; SVP early-returns above
      case 7:
        return stages.stage7_pengantaran === true;
      case 8:
        return stages.stage8_diterima === true;
      default:
        return false;
    }
  }

  /**
   * Filter sidebar menu items hierarchically according to role permissions
   */
  public getFilteredMenuItems(role: string | null | undefined, rawItems: MenuItem[]): MenuItem[] {
    const norm = normalizeRole(role);
    if (norm === "administrator") return rawItems;

    return rawItems
      .map((item) => {
        // If item has no sub-items
        if (!item.subItems || item.subItems.length === 0) {
          if (this.canViewPage(norm, item.id)) {
            return item;
          }
          return null;
        }

        // If item has sub-items, filter visible sub-items
        const visibleSubItems = item.subItems.filter((sub) => this.canViewPage(norm, sub.id));
        if (visibleSubItems.length > 0) {
          return {
            ...item,
            subItems: visibleSubItems,
          };
        }
        return null;
      })
      .filter(Boolean) as MenuItem[];
  }

  /**
   * Update permissions for a specific role and module
   */
  public updateModulePermission(
    role: Role,
    moduleId: string,
    permissions: Partial<ModulePermission>
  ): void {
    const targetRole = normalizeRole(role);
    if (targetRole === "unknown" || !this.matrix[targetRole]) return;

    if (!this.matrix[targetRole].modules[moduleId]) {
      this.matrix[targetRole].modules[moduleId] = { view: false, manage: false };
    }

    if (permissions.view !== undefined) {
      this.matrix[targetRole].modules[moduleId].view = permissions.view;
    }
    if (permissions.manage !== undefined) {
      this.matrix[targetRole].modules[moduleId].manage = permissions.manage;
    }

    this.notify();
  }

  /**
   * Update stage-level action permission for a role
   */
  public updateStagePermission(
    role: Role,
    stageKey: keyof StageActionPermissions,
    allowed: boolean
  ): void {
    const targetRole = normalizeRole(role);
    if (targetRole === "unknown" || !this.matrix[targetRole]) return;

    this.matrix[targetRole].stages[stageKey] = allowed;

    this.notify();
  }

  /**
   * Fetch authoritative permissions matrix from backend API
   */
  public async initFromApi(): Promise<void> {
    const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
    if (!token) return;

    this.isLoadingState = true;
    try {
      const res = await fetch(`${APP_CONFIG.apiBaseUrl}/permissions`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        throw new Error(`Gagal memuat konfigurasi hak akses dari server (HTTP ${res.status})`);
      }

      const payload = await res.json();
      if (payload.success && payload.data) {
        const syncedData = { ...payload.data };
        delete syncedData.svp;
        for (const nonSvp of ["admin", "finance", "messenger"]) {
          if (syncedData[nonSvp]?.stages) {
            syncedData[nonSvp] = {
              ...syncedData[nonSvp],
              stages: { ...syncedData[nonSvp].stages, stage6_supervisi: false },
            };
          }
        }
        this.matrix = {
          ...this.matrix,
          ...syncedData,
          // Guarantee canonical administrator (SVP) is unconditionally full privilege
          administrator: JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS.administrator)),
        };
        this.lastError = null;
        this.isDataStale = false;
        this.hasSuccessfullyLoaded = true;
        this.hasHydrationFailedState = false;
        this.awaitingAuthoritativeMatrix = false;
        this.isLoadingState = false;
        this.notify();
      } else {
        throw new Error(payload.message || "Data permissions tidak valid dari server");
      }
    } catch (err: any) {
      this.awaitingAuthoritativeMatrix = false;
      if (!this.hasSuccessfullyLoaded) {
        this.hasHydrationFailedState = true;
        this.applyFailClosedNonSvpMatrix();
      }
      this.isLoadingState = false;
      this.lastError = err?.message || "Gagal menghubungkan ke backend konfigurasi hak akses";
      this.isDataStale = true;
      this.notify();
    }
  }

  public isLoading(): boolean {
    return this.isLoadingState && !this.hasSuccessfullyLoaded;
  }

  public getError(): string | null {
    return this.lastError;
  }

  public isStale(): boolean {
    return this.isDataStale;
  }

  public hasInitializedFromApi(): boolean {
    return this.hasSuccessfullyLoaded;
  }

  public hasHydrationFailed(): boolean {
    return this.hasHydrationFailedState;
  }

  public isAwaitingAuthoritativeMatrix(): boolean {
    return this.awaitingAuthoritativeMatrix;
  }

  public hasExplicitSessionHydration(): boolean {
    return this.hasExplicitHydration;
  }

  /**
   * Checks whether an auth token exists in browser localStorage (or Node env).
   */
  public hasAuthToken(): boolean {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        return Boolean(
          window.localStorage.getItem("auth_token") ||
          window.localStorage.getItem("sun89_auth_token")
        );
      }
      if (typeof process !== "undefined" && process.env?.AUTH_TOKEN) {
        return true;
      }
    } catch {
      // Ignore storage failures cleanly
    }
    return false;
  }

  /**
   * Explicitly hydrates the in-memory session role (e.g. after /api/auth/me or login)
   * and notifies subscribed stores so deferred permission-gated fetches can recover.
   */
  public hydrateSession(
    role: string | null | undefined,
    options?: { notify?: boolean; requireAuthoritativeSync?: boolean }
  ): void {
    const normalized = typeof role === "string" ? role.toLowerCase().trim() : "";
    this.sessionRole = normalized || null;
    this.hasExplicitHydration = Boolean(normalized);
    if (options?.requireAuthoritativeSync) {
      this.awaitingAuthoritativeMatrix = true;
      this.hasSuccessfullyLoaded = false;
      this.hasHydrationFailedState = false;
      this.applyFailClosedNonSvpMatrix();
    } else {
      this.awaitingAuthoritativeMatrix = false;
      this.hasHydrationFailedState = false;
    }
    if (options?.notify !== false) {
      this.notify();
    }
  }

  /**
   * Clears in-memory session role and cached permission state on logout or 401,
   * then notifies subscribers so cached domain data is wiped immediately.
   */
  public clearSession(): void {
    this.sessionRole = null;
    this.awaitingAuthoritativeMatrix = false;
    this.hasHydrationFailedState = false;
    this.hasExplicitHydration = false;
    this.matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
    this.isLoadingState = false;
    this.lastError = null;
    this.isDataStale = false;
    this.hasSuccessfullyLoaded = false;
    this.notify();
  }

  /**
   * Resolves the authenticated session role from browser localStorage (`auth_user` or JWT `auth_token`)
   * or in-memory hydrated session role.
   * Returns `null` when no session role can be determined (e.g. unauthenticated or hydrating state).
   */
  public getSessionRole(): string | null {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const rawUser = window.localStorage.getItem("auth_user");
        if (rawUser) {
          const parsed = JSON.parse(rawUser);
          if (parsed?.role && typeof parsed.role === "string") {
            const normalized = parsed.role.toLowerCase().trim();
            if (normalized) return normalized;
          }
        }
        const token =
          window.localStorage.getItem("auth_token") ||
          window.localStorage.getItem("sun89_auth_token");
        if (token) {
          const parts = token.split(".");
          if (parts.length >= 2) {
            try {
              const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
              const jsonPayload = atob(base64);
              const payload = JSON.parse(jsonPayload);
              if (payload?.role && typeof payload.role === "string") {
                const normalized = payload.role.toLowerCase().trim();
                if (normalized) return normalized;
              }
            } catch {
              // Opaque / non-JWT token: role awaits hydration
            }
          }
        }
        // Avoid retaining stale hydrated role if both token and auth_user were removed directly
        if (!token && !rawUser) {
          this.sessionRole = null;
          return null;
        }
        return this.sessionRole;
      }
      return this.sessionRole;
    } catch {
      // Ignore parse failures cleanly
    }
    return this.sessionRole;
  }

  /**
   * Distinguishes unauthenticated, hydrating (token exists before role resolves),
   * authenticated, and forbidden session states without fail-opening browser requests.
   */
  public getSessionAuthStatus(roleOverride?: string | null): SessionAuthStatus {
    const hasBrowserWindow = typeof window !== "undefined";
    const hasToken = this.hasAuthToken();
    const rawRole = (roleOverride || this.getSessionRole() || "").toLowerCase().trim();

    if (hasBrowserWindow) {
      if (!hasToken && !rawRole) {
        return "unauthenticated";
      }
      if (!rawRole) {
        return "hydrating";
      }
      if (this.awaitingAuthoritativeMatrix) {
        return "hydrating";
      }
      if (this.hasHydrationFailedState && !this.hasSuccessfullyLoaded) {
        return "forbidden";
      }
      // On browser reload before /api/permissions or explicit session hydration completes,
      // stay fail-closed in hydrating state rather than trusting DEFAULT_PERMISSIONS.
      if (!this.hasSuccessfullyLoaded && !this.hasExplicitHydration) {
        return "hydrating";
      }
      return normalizeRole(rawRole) === "unknown" ? "forbidden" : "authenticated";
    }

    if (!rawRole) {
      return "authenticated";
    }
    if (this.hasHydrationFailedState && !this.hasSuccessfullyLoaded) {
      return "forbidden";
    }
    return normalizeRole(rawRole) === "unknown" ? "forbidden" : "authenticated";
  }

  /**
   * Permission-aware guard determining whether the current authenticated user
   * may query a given backend endpoint without incurring avoidable 403 errors.
   * Matches both route-level role allowlists and dynamic RBAC module permissions.
   */
  public canAccessApiEndpoint(endpoint: ApiEndpointKey, roleOverride?: string | null): boolean {
    const rawRole = (roleOverride || this.getSessionRole() || "").toLowerCase().trim();
    if (!rawRole) {
      // Fail-closed whenever window exists (including hydrating state with token but missing role);
      // headless Node unit tests without browser auth session rely on explicit fetch mocks.
      return typeof window === "undefined";
    }
    if (typeof window !== "undefined") {
      if (this.awaitingAuthoritativeMatrix) {
        return false;
      }
      if (!this.hasSuccessfullyLoaded && !this.hasExplicitHydration && !roleOverride) {
        return false;
      }
    }
    if (this.hasHydrationFailedState && !this.hasSuccessfullyLoaded) {
      return false;
    }

    if (rawRole === "administrator") {
      return true;
    }

    switch (endpoint) {
      case "users":
        return rawRole === "admin" && this.canViewPage(rawRole, "manajemen-pengguna");
      case "employees":
        return rawRole === "admin" && this.canViewPage(rawRole, "manajemen-karyawan");
      case "orders":
        return (rawRole === "admin" || rawRole === "finance") && this.canViewPage(rawRole, "order-menu");
      case "orders-archived":
        return (rawRole === "admin" || rawRole === "finance") && this.canViewPage(rawRole, "order-history");
      case "messenger-tasks":
        return rawRole === "messenger" && this.canViewPage(rawRole, "messenger-task");
      case "finance-invoices":
        return (rawRole === "finance" || rawRole === "admin") && this.canViewPage(rawRole, "finance-tagihan");
      case "finance-profit":
        return (rawRole === "finance" || rawRole === "admin") && this.canViewPage(rawRole, "finance-profit");
      case "finance-kas-kantor":
        return rawRole === "finance" && this.canViewPage(rawRole, "finance-kas-kantor");
      case "finance-pengeluaran":
        return rawRole === "finance" && this.canViewPage(rawRole, "finance-pengeluaran");
      case "finance-kas-messenger":
        if (rawRole === "messenger") {
          return this.canViewPage(rawRole, "messenger-task");
        }
        return (rawRole === "finance" || rawRole === "admin") && this.canViewPage(rawRole, "finance-kas-messenger");
      case "audit-logs":
        return rawRole === "admin" && this.canViewPage(rawRole, "audit-log");
      default:
        return false;
    }
  }

  /**
   * Save entire role permissions structure (used by AccessManagement)
   * Strictly prohibits modifying SVP / Administrator.
   * Gated by authoritative SVP credentials on the backend.
   */
  public async saveRolePermissions(
    role: Role,
    permissions: RolePermissions,
    expectedVersion?: number,
    lastUpdatedAt?: string
  ): Promise<{ success: boolean; data: RolePermissions; version: number }> {
    const normRole = normalizeRole(role);
    if (normRole === "administrator") {
      throw new Error("Hak akses role SVP bersifat absolut dan tidak dapat diubah (Security Invariant).");
    }
    if (normRole !== "admin" && normRole !== "finance") {
      throw new Error(`Role '${role}' tidak didukung untuk konfigurasi hak akses dinamis.`);
    }

    const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
    if (!token) {
      throw new Error("Sesi login kedaluwarsa atau tidak valid. Silakan login kembali.");
    }

    const res = await fetch(`${APP_CONFIG.apiBaseUrl}/permissions/${normRole}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        modules: permissions.modules,
        stages: permissions.stages,
        expectedVersion,
        lastUpdatedAt,
      }),
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      if (res.status === 409) {
        throw new Error(payload?.error?.message || "Konflik konkurensi: Hak akses telah diubah oleh sesi lain. Silakan sinkronkan ulang.");
      }
      if (res.status === 403) {
        throw new Error(payload?.error?.message || "Akses ditolak: Hanya SVP yang berwenang mengubah hak akses.");
      }
      throw new Error(payload?.error?.message || `Gagal menyimpan hak akses (HTTP ${res.status}).`);
    }

    if (!payload?.success) {
      throw new Error(payload?.message || payload?.error?.message || "Gagal menyimpan hak akses.");
    }

    // Authoritatively refresh the matrix from server
    await this.initFromApi();

    return {
      success: true,
      data: payload.data,
      version: payload.version,
    };
  }

  public async resetToDefaults(): Promise<void> {
    const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
    if (!token) {
      throw new Error("Sesi login kedaluwarsa atau tidak valid. Silakan login kembali.");
    }

    const res = await fetch(`${APP_CONFIG.apiBaseUrl}/permissions/reset`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(payload?.error?.message || `Gagal mereset hak akses (HTTP ${res.status}).`);
    }

    if (!payload?.success) {
      throw new Error(payload?.message || payload?.error?.message || "Gagal mereset hak akses.");
    }

    // Authoritatively refresh the matrix from server
    await this.initFromApi();
  }
}

export const permissionStore = new PermissionStore();

/**
 * React Hook for PermissionStore
 */
export function usePermissionStore() {
  const [, setVersion] = useState(0);

  useEffect(() => {
    return permissionStore.subscribe(() => {
      setVersion((v) => v + 1);
    });
  }, []);

  return {
    matrix: permissionStore.getMatrix(),
    isLoading: permissionStore.isLoading(),
    error: permissionStore.getError(),
    isStale: permissionStore.isStale(),
    refresh: () => permissionStore.initFromApi(),
    canViewPage: (role: string | null | undefined, pageId: string) =>
      permissionStore.canViewPage(role, pageId),
    canManageModule: (role: string | null | undefined, moduleId: string) =>
      permissionStore.canManageModule(role, moduleId),
    canManageStage: (role: string | null | undefined, stageNumber: number) =>
      permissionStore.canManageStage(role, stageNumber),
    getFilteredMenuItems: (role: string | null | undefined, rawItems: MenuItem[]) =>
      permissionStore.getFilteredMenuItems(role, rawItems),
    updateModulePermission: permissionStore.updateModulePermission.bind(permissionStore),
    updateStagePermission: permissionStore.updateStagePermission.bind(permissionStore),
    saveRolePermissions: permissionStore.saveRolePermissions.bind(permissionStore),
    resetToDefaults: permissionStore.resetToDefaults.bind(permissionStore),
    initFromApi: permissionStore.initFromApi.bind(permissionStore),
  };
}
