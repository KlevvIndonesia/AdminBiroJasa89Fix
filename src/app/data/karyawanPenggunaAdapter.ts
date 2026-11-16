/**
 * Karyawan -> Pengguna Authoritative Data Adapter
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Rules (Phase 3 Canonical Integration):
 * 1. `employees` (/api/employees) is the authoritative Single Source of Truth for employee identity and employment.
 * 2. `users` (/api/users) is the authoritative Single Source of Truth for login credentials, roles, and account status.
 * 3. Relationship is maintained via canonical foreign key `users.employee_id REFERENCES employees(id)`.
 * 4. Separation of Concerns: Account status (`statusAkun`) is distinct from employment status (`status_karyawan`).
 * 5. Password reset format is derived from employee date of birth (`tanggalLahir`) in DDMMYYYY format.
 */

import { useState, useEffect } from "react";
import { auditLog } from "../utils/auditLog";
import { userRepository } from "../../data/repositories/userRepository";
import { apiEmployeeProvider } from "../../data/api/apiEmployeeProvider";
import { APP_CONFIG } from "../config/appConfig";
import { permissionStore } from "./permissionStore";

export interface KaryawanRecord {
  id: string; // e.g. "EMP-0001"
  nama: string;
  jabatan: "ADMIN" | "FINANCE" | "SVP" | "MESSENGER" | "CLILEN" | string;
  wilayah: string;
  status: "Aktif" | "Nonaktif" | string;
  noHp: string;
  email: string;
  jenisKelamin: "Laki-laki" | "Perempuan" | string;
  alamat: string;
  gajiPokok: number;
  tanggalBergabung: string;
  tanggalLahir: string; // Format: "YYYY-MM-DD" or "DD/MM/YYYY"
  nikKtp?: string;
  nik_ktp?: string;
  userId?: number | string | null;
  hasAccount?: boolean;
}

export interface PenggunaRecord {
  id: string; // e.g. "1" or "USR-001"
  employeeId: string; // FK -> KaryawanRecord.id (empty string if unlinked)
  nama: string; // Account holder name
  jabatan: string; // Title
  email: string; // Username / email
  role: "admin" | "finance" | "administrator" | "messenger" | "clilen" | string;
  statusAkun: "Aktif" | "Nonaktif" | "Belum Aktif";
  terakhirLogin: string;
  passwordHash?: string; // Masked / In-memory storage
  lastResetAt?: string;
  employeeInfo?: KaryawanRecord | null;
}

/**
 * Convert any date of birth format into strict DDMMYYYY format
 */
export function formatDobToPassword(dobInput: string): string {
  if (!dobInput) return "01011990";
  const str = String(dobInput).trim();

  // YYYY-MM-DD or YYYY/MM/DD
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(str)) {
    const parts = str.split(/[-/]/);
    const y = parts[0];
    const m = parts[1].padStart(2, "0");
    const d = parts[2].padStart(2, "0");
    return `${d}${m}${y}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(str)) {
    const parts = str.split(/[-/]/);
    const d = parts[0].padStart(2, "0");
    const m = parts[1].padStart(2, "0");
    const y = parts[2];
    return `${d}${m}${y}`;
  }

  // Fallback with standard Date
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const d = String(parsed.getDate()).padStart(2, "0");
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const y = String(parsed.getFullYear());
    return `${d}${m}${y}`;
  }

  return "01011990";
}

// In-Memory Authoritative Data Store (backed strictly by API / SQLite)
let karyawanList: KaryawanRecord[] = [];
let penggunaList: PenggunaRecord[] = [];
let employeeApiError: string | null = null;
let userApiError: string | null = null;
let isEmployeesStaleState = false;
let isUsersStaleState = false;
let hasLoadedEmployees = false;
let hasLoadedUsers = false;
let refreshPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function syncFromSources() {
  const canFetchEmployees = permissionStore.canAccessApiEndpoint("employees");
  const canFetchUsers = permissionStore.canAccessApiEndpoint("users");
  const repoError = canFetchUsers && userRepository.getError ? userRepository.getError() : null;
  const empError = canFetchEmployees && apiEmployeeProvider.getError ? apiEmployeeProvider.getError() : null;
  const repoLoading = canFetchUsers && userRepository.isLoading ? userRepository.isLoading() : false;
  const empLoading = canFetchEmployees && apiEmployeeProvider.isLoading ? apiEmployeeProvider.isLoading() : false;

  const users = canFetchUsers ? (userRepository.getAll() || []) : [];
  const rawEmployees = apiEmployeeProvider.getAll();

  const roleMap: Record<string, "admin" | "finance" | "administrator" | "messenger" | "clilen"> = {
    ADMIN: "admin",
    FINANCE: "finance",
    SVP: "administrator",
    MESSENGER: "messenger",
    CLILEN: "clilen",
  };

  // 1. Update Employees domain independently so /api/users failures (e.g. 403 for Admin)
  // NEVER discard or corrupt loaded employees needed by Order Tracking Messenger dropdowns.
  if (!canFetchEmployees) {
    employeeApiError = null;
    isEmployeesStaleState = false;
    hasLoadedEmployees = true;
    karyawanList = [];
  } else if (empError) {
    employeeApiError = empError;
    if (karyawanList.length > 0 || hasLoadedEmployees) {
      isEmployeesStaleState = true;
    }
  } else if (!empLoading || hasLoadedEmployees) {
    employeeApiError = null;
    isEmployeesStaleState = false;
    hasLoadedEmployees = true;

    karyawanList = rawEmployees.map((e: any) => {
      const linkedUser = users.find((u: any) => {
        const uEmpId = String(u.employee_id || u.employeeId || "").trim().toLowerCase();
        const targetEmpId = String(e.id).trim().toLowerCase();
        return (uEmpId && uEmpId === targetEmpId) || (e.user_id && String(u.id) === String(e.user_id));
      });

      const rawJabatan = (e.jabatan || linkedUser?.jabatan || "ADMIN").toUpperCase();
      const statusEmp = (e.status_karyawan === "Aktif" || e.status_karyawan === "TETAP" || e.status === "Aktif") ? "Aktif" : "Nonaktif";

      return {
        id: e.id,
        nama: e.nama_lengkap || e.nama || linkedUser?.nama || "",
        jabatan: rawJabatan,
        wilayah: e.wilayah || "Jakarta",
        status: statusEmp,
        noHp: e.no_hp || e.noHp || linkedUser?.phone || "",
        email: e.user_email || linkedUser?.email || e.email || "",
        jenisKelamin: e.jenis_kelamin || e.jenisKelamin || "Laki-laki",
        alamat: e.alamat_domisili || e.alamat || "Kantor SUN89",
        gajiPokok: Number(e.gaji_pokok ?? e.gajiPokok ?? 0),
        tanggalBergabung: e.tanggal_bergabung || e.tanggalBergabung || "2023-01-01",
        tanggalLahir: e.tgl_lahir || e.tanggalLahir || "2000-01-01",
        nikKtp: e.nik_ktp || e.nikKtp,
        userId: linkedUser?.id || e.user_id || null,
        hasAccount: Boolean(linkedUser || e.user_id),
      };
    });
  }

  // 2. Update Users domain independently
  if (!canFetchUsers) {
    userApiError = null;
    isUsersStaleState = false;
    hasLoadedUsers = true;
    penggunaList = [];
  } else if (repoError) {
    userApiError = repoError;
    if (penggunaList.length > 0 || hasLoadedUsers) {
      isUsersStaleState = true;
    }
  } else if (!repoLoading || hasLoadedUsers) {
    userApiError = null;
    isUsersStaleState = false;
    hasLoadedUsers = true;

    penggunaList = users.map((u: any) => {
      const rawJabatan = (u.jabatan || "ADMIN").toUpperCase();
      const role = (u.role || roleMap[rawJabatan] || "admin").toLowerCase();
      const statusAkun = u.status === "Aktif" ? "Aktif" : (u.status === "Nonaktif" ? "Nonaktif" : "Belum Aktif");
      const empId = u.employee_id || u.employeeId || "";

      const linkedEmployee = karyawanList.find((k) => k.id.toLowerCase() === empId.toLowerCase());

      return {
        id: String(u.id),
        employeeId: empId,
        nama: u.nama,
        jabatan: rawJabatan,
        email: u.email,
        role,
        statusAkun,
        terakhirLogin: u.last_login_at || u.lastLogin || (statusAkun === "Aktif" ? "2026-09-24 14:32" : "-"),
        passwordHash: "********",
        employeeInfo: linkedEmployee || null,
      };
    });
  }

  notify();
}

// Initial subscription to API providers
syncFromSources();
userRepository.subscribe(() => {
  syncFromSources();
});
apiEmployeeProvider.subscribe(() => {
  syncFromSources();
});

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window !== "undefined" && window.localStorage) {
    const token = window.localStorage.getItem("auth_token");
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export const karyawanPenggunaAdapter = {
  // ─── KARYAWAN OPERATIONS ──────────────────────────────────────────────
  getKaryawan(): KaryawanRecord[] {
    return [...karyawanList];
  },

  getKaryawanById(id: string): KaryawanRecord | undefined {
    return karyawanList.find((k) => k.id === id);
  },

  addKaryawan(data: Omit<KaryawanRecord, "id">): KaryawanRecord {
    const nextNum = karyawanList.length + 1;
    const newId = `EMP-${String(nextNum).padStart(4, "0")}`;
    const cleanNik = data.nikKtp || `317508${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 9000 + 1000))}`;

    const newKaryawan: KaryawanRecord = {
      ...data,
      id: newId,
      nikKtp: cleanNik,
    };
    karyawanList = [...karyawanList, newKaryawan];

    auditLog.log({
      userId: "usr-admin-system",
      userName: "Administrator",
      action: "CREATE",
      module: "Karyawan",
      details: `Menambahkan karyawan baru: ${newKaryawan.nama} (${newId})`,
      userRole: "admin",
    });

    apiEmployeeProvider.createEmployee({
      id: newId,
      nik_ktp: cleanNik,
      nama_lengkap: data.nama,
      no_hp: data.noHp,
      tgl_lahir: data.tanggalLahir,
      wilayah: data.wilayah,
      alamat_domisili: data.alamat,
      jabatan: data.jabatan,
      gaji_pokok: data.gajiPokok,
      status_karyawan: data.status,
      tanggal_bergabung: data.tanggalBergabung,
      jenis_kelamin: data.jenisKelamin,
      email: data.email,
      createAccount: Boolean(data.email),
    }).then(() => {
      syncFromSources();
    }).catch((err) => {
      console.error("Failed to create employee on server:", err);
    });

    notify();
    return newKaryawan;
  },

  updateKaryawan(id: string, data: Partial<KaryawanRecord>): boolean {
    const idx = karyawanList.findIndex((k) => k.id === id);
    if (idx === -1) return false;

    const updated = { ...karyawanList[idx], ...data };
    karyawanList[idx] = updated;

    // Sync mirrored name/title in Pengguna list if linked
    penggunaList = penggunaList.map((p) => {
      if (p.employeeId === id) {
        return {
          ...p,
          nama: updated.nama,
          jabatan: updated.jabatan,
          email: updated.email,
        };
      }
      return p;
    });

    auditLog.log({
      userId: "usr-admin-system",
      userName: "Administrator",
      action: "UPDATE",
      module: "Karyawan",
      details: `Mengubah data karyawan: ${updated.nama} (${id})`,
      userRole: "admin",
    });

    apiEmployeeProvider.updateEmployee(id, {
      nama_lengkap: updated.nama,
      no_hp: updated.noHp,
      tgl_lahir: updated.tanggalLahir,
      wilayah: updated.wilayah,
      alamat_domisili: updated.alamat,
      jabatan: updated.jabatan,
      gaji_pokok: updated.gajiPokok,
      status_karyawan: updated.status,
      tanggal_bergabung: updated.tanggalBergabung,
      jenis_kelamin: updated.jenisKelamin,
    }).then(() => {
      syncFromSources();
    }).catch((err) => {
      console.error("Failed to update employee on server:", err);
    });

    notify();
    return true;
  },

  deleteKaryawan(id: string): boolean {
    const target = karyawanList.find((k) => k.id === id);
    if (!target) return false;

    karyawanList = karyawanList.filter((k) => k.id !== id);
    // Unlink associated user account
    penggunaList = penggunaList.map((p) => p.employeeId === id ? { ...p, employeeId: "", employeeInfo: null } : p);

    auditLog.log({
      userId: "usr-admin-system",
      userName: "Administrator",
      action: "DELETE",
      module: "Karyawan",
      details: `Menghapus karyawan: ${target.nama} (${id})`,
      userRole: "admin",
    });

    apiEmployeeProvider.deleteEmployee(id).then(() => {
      syncFromSources();
    }).catch((err) => {
      console.error("Failed to delete employee on server:", err);
    });

    notify();
    return true;
  },

  // ─── PERMANENT ERASURE ────────────────────────────────────────────────
  async preflightPermanentErasure(id: string): Promise<{
    allowed: boolean;
    blockers: { code: string; message: string; details?: any }[];
    target?: any;
    summary?: any;
    error?: string;
  }> {
    try {
      const res = await fetch(`${APP_CONFIG.apiBaseUrl}/users/${encodeURIComponent(id)}/permanent-erasure-preflight`, {
        method: "GET",
        headers: getAuthHeaders(),
      });
      const json = await res.json();
      if (!res.ok) {
        return {
          allowed: false,
          blockers: json.error?.blockers || (json.error?.details?.blockers || [
            { code: json.error?.code || "PREFLIGHT_ERROR", message: json.error?.message || "Gagal memeriksa status penghapusan." }
          ]),
          error: json.error?.message,
        };
      }
      return {
        allowed: json.data?.allowed ?? false,
        blockers: json.data?.blockers || [],
        target: json.data?.target,
        summary: json.data?.summary,
      };
    } catch (err: any) {
      return {
        allowed: false,
        blockers: [{ code: "NETWORK_ERROR", message: err.message || "Gagal terhubung ke backend." }],
        error: err.message,
      };
    }
  },

  async permanentErasure(
    id: string,
    confirmationText: string,
    reason?: string
  ): Promise<{
    success: boolean;
    status?: "COMPLETED" | "DATABASE_COMPLETED";
    fileCleanupPending?: boolean;
    message?: string;
    error?: string;
    blockers?: any[];
  }> {
    if (confirmationText?.trim() !== "HAPUS PERMANEN") {
      return {
        success: false,
        error: "Konfirmasi tidak valid. Anda wajib mengetik teks 'HAPUS PERMANEN'.",
      };
    }

    try {
      const res = await fetch(`${APP_CONFIG.apiBaseUrl}/users/${encodeURIComponent(id)}/permanent-erasure`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ confirmationText: "HAPUS PERMANEN", reason }),
      });
      const json = await res.json();
      if (!res.ok) {
        return {
          success: false,
          error: json.error?.message || "Penghapusan permanen gagal dieksekusi.",
          blockers: json.error?.blockers || (json.error?.details?.blockers || []),
        };
      }

      karyawanList = karyawanList.filter((k) => k.id !== id);
      penggunaList = penggunaList.filter((p) => p.employeeId !== id && p.id !== id);
      karyawanPenggunaAdapter.refresh();
      notify();

      return {
        success: true,
        status: json.data?.status || "COMPLETED",
        fileCleanupPending: json.data?.fileCleanupPending || false,
        message: json.message || "Penghapusan permanen berhasil dilakukan.",
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Gagal menghubungi server untuk penghapusan permanen.",
      };
    }
  },

  // ─── PENGGUNA OPERATIONS ──────────────────────────────────────────────
  getPengguna(): PenggunaRecord[] {
    return [...penggunaList];
  },

  getPenggunaById(id: string): PenggunaRecord | undefined {
    return penggunaList.find((p) => p.id === id);
  },

  getPenggunaByEmployeeId(empId: string): PenggunaRecord | undefined {
    return penggunaList.find((p) => p.employeeId === empId);
  },

  activateAccount(userId: string): boolean {
    const idx = penggunaList.findIndex((p) => p.id === userId);
    if (idx === -1) return false;

    penggunaList[idx] = {
      ...penggunaList[idx],
      statusAkun: "Aktif",
    };

    userRepository.updateUser(userId, { status: "Aktif" });

    auditLog.log({
      userId: "usr-admin-system",
      userName: "Administrator",
      action: "UPDATE",
      module: "Manajemen Pengguna",
      details: `Mengaktifkan akun pengguna: ${penggunaList[idx].nama} (${userId})`,
      userRole: "admin",
    });

    notify();
    return true;
  },

  deactivateAccount(userId: string): boolean {
    const idx = penggunaList.findIndex((p) => p.id === userId);
    if (idx === -1) return false;

    penggunaList[idx] = {
      ...penggunaList[idx],
      statusAkun: "Nonaktif",
    };

    userRepository.updateUser(userId, { status: "Nonaktif" });

    auditLog.log({
      userId: "usr-admin-system",
      userName: "Administrator",
      action: "UPDATE",
      module: "Manajemen Pengguna",
      details: `Menonaktifkan akun pengguna: ${penggunaList[idx].nama} (${userId})`,
      userRole: "admin",
    });

    notify();
    return true;
  },

  updateRole(userId: string, role: PenggunaRecord["role"]): boolean {
    const idx = penggunaList.findIndex((p) => p.id === userId);
    if (idx === -1) return false;

    const savedUserStr = typeof window !== "undefined" ? localStorage.getItem("auth_user") : null;
    let currentUserRole = "admin";
    if (savedUserStr) {
      try { currentUserRole = JSON.parse(savedUserStr).role || "admin"; } catch {}
    }
    const isCallerSvp = currentUserRole === "administrator";

    // Protect SVP account from role change by non-SVP
    if ((penggunaList[idx].role === "administrator" || penggunaList[idx].jabatan === "SVP") && !isCallerSvp) {
      return false;
    }

    if (role === "administrator" && !isCallerSvp) {
      return false;
    }

    const nextJabatan = role === "administrator" ? "SVP" : role.toUpperCase();
    penggunaList[idx] = {
      ...penggunaList[idx],
      role,
      jabatan: nextJabatan,
    };

    userRepository.updateUser(userId, { role, jabatan: nextJabatan });

    auditLog.log({
      userId: "usr-admin-system",
      userName: "Administrator",
      action: "UPDATE",
      module: "Manajemen Pengguna",
      details: `Mengubah role pengguna ${penggunaList[idx].nama} menjadi ${role}`,
      userRole: "admin",
    });

    notify();
    return true;
  },

  async resetPassword(userId: string): Promise<{ success: boolean; newPassword?: string; error?: string }> {
    const user = penggunaList.find((p) => p.id === userId);
    if (!user) return { success: false, error: "Pengguna tidak ditemukan." };

    const savedUserStr = typeof window !== "undefined" ? localStorage.getItem("auth_user") : null;
    let currentUserRole = "admin";
    if (savedUserStr) {
      try { currentUserRole = JSON.parse(savedUserStr).role || "admin"; } catch {}
    }
    const isCallerSvp = currentUserRole === "administrator";

    if ((user.role === "administrator" || user.jabatan === "SVP") && !isCallerSvp) {
      return { success: false, error: "Akun SVP dilindungi oleh sistem dan tidak dapat direset oleh role lain." };
    }

    const employee = karyawanList.find((k) => k.id === user.employeeId);
    const dob = employee?.tanggalLahir || "1990-01-01";
    const newPassword = formatDobToPassword(dob);

    if (userRepository.resetPassword) {
      try {
        await userRepository.resetPassword(userId);
      } catch (err: any) {
        return {
          success: false,
          error: err.message || "Gagal mereset kata sandi pada server.",
        };
      }
    }

    penggunaList = penggunaList.map((p) => {
      if (p.id === userId) {
        return {
          ...p,
          passwordHash: newPassword,
          lastResetAt: new Date().toISOString(),
        };
      }
      return p;
    });

    auditLog.log({
      userId: "usr-admin-system",
      userName: "Administrator",
      action: "RESET_PASSWORD",
      module: "Manajemen Pengguna",
      details: `Reset kata sandi akun ${user.nama} (${userId}) menggunakan tanggal lahir karyawan`,
      userRole: "admin",
    });

    notify();
    return { success: true, newPassword };
  },

  _resetToInitial() {
    syncFromSources();
  },

  isLoading(): boolean {
    const canEmp = permissionStore.canAccessApiEndpoint("employees");
    const canUsr = permissionStore.canAccessApiEndpoint("users");
    const repoLoading = Boolean(canUsr && userRepository.isLoading && userRepository.isLoading());
    const empLoading = Boolean(canEmp && apiEmployeeProvider.isLoading && apiEmployeeProvider.isLoading());
    return repoLoading || empLoading;
  },

  isEmployeeLoading(): boolean {
    if (!permissionStore.canAccessApiEndpoint("employees")) return false;
    return Boolean(apiEmployeeProvider.isLoading && apiEmployeeProvider.isLoading());
  },

  isUserLoading(): boolean {
    if (!permissionStore.canAccessApiEndpoint("users")) return false;
    return Boolean(userRepository.isLoading && userRepository.isLoading());
  },

  getEmployeeError(): string | null {
    if (!permissionStore.canAccessApiEndpoint("employees")) return null;
    return employeeApiError || (apiEmployeeProvider.getError ? apiEmployeeProvider.getError() : null);
  },

  getUserError(): string | null {
    if (!permissionStore.canAccessApiEndpoint("users")) return null;
    return userApiError || (userRepository.getError ? userRepository.getError() : null);
  },

  getError(): string | null {
    return this.getEmployeeError() || this.getUserError();
  },

  isEmployeeStale(): boolean {
    return isEmployeesStaleState;
  },

  isUserStale(): boolean {
    return isUsersStaleState;
  },

  isStale(): boolean {
    return isEmployeesStaleState || isUsersStaleState;
  },

  clearSessionData(): void {
    employeeApiError = null;
    userApiError = null;
    isEmployeesStaleState = false;
    isUsersStaleState = false;
    hasLoadedEmployees = false;
    hasLoadedUsers = false;
    refreshPromise = null;
    if (typeof (userRepository as any).clearSessionData === "function") {
      (userRepository as any).clearSessionData();
    }
    apiEmployeeProvider.clearSessionData();
    karyawanList = [];
    penggunaList = [];
    notify();
  },

  async refresh(options?: { onlyFailed?: boolean; target?: "all" | "employees" | "users" }): Promise<void> {
    if (refreshPromise) {
      return refreshPromise;
    }
    const target = options?.target || "all";
    const onlyFailed = Boolean(options?.onlyFailed);

    refreshPromise = (async () => {
      const tasks: Promise<any>[] = [];
      const canFetchEmp = permissionStore.canAccessApiEndpoint("employees");
      const canFetchUsr = permissionStore.canAccessApiEndpoint("users");

      const shouldFetchEmp =
        canFetchEmp &&
        (target === "all" || target === "employees") &&
        (!onlyFailed || Boolean(employeeApiError));
      const shouldFetchUsr =
        canFetchUsr &&
        (target === "all" || target === "users") &&
        (!onlyFailed || Boolean(userApiError));

      if (shouldFetchEmp) {
        tasks.push(apiEmployeeProvider.initFromApi());
      }
      if (
        shouldFetchUsr &&
        (userRepository as any).getProvider &&
        typeof (userRepository as any).getProvider().initFromApi === "function"
      ) {
        tasks.push((userRepository as any).getProvider().initFromApi());
      }
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
      syncFromSources();
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useKaryawanPengguna() {
  const [, setTick] = useState(0);

  useEffect(() => {
    return karyawanPenggunaAdapter.subscribe(() => {
      setTick((t) => t + 1);
    });
  }, []);

  return {
    karyawan: karyawanPenggunaAdapter.getKaryawan(),
    karyawanList: karyawanPenggunaAdapter.getKaryawan(),
    pengguna: karyawanPenggunaAdapter.getPengguna(),
    penggunaList: karyawanPenggunaAdapter.getPengguna(),
    isLoading: karyawanPenggunaAdapter.isLoading(),
    isKaryawanLoading: karyawanPenggunaAdapter.isEmployeeLoading(),
    isPenggunaLoading: karyawanPenggunaAdapter.isUserLoading(),
    error: karyawanPenggunaAdapter.getError(),
    karyawanError: karyawanPenggunaAdapter.getEmployeeError(),
    penggunaError: karyawanPenggunaAdapter.getUserError(),
    isStale: karyawanPenggunaAdapter.isStale(),
    isKaryawanStale: karyawanPenggunaAdapter.isEmployeeStale(),
    isPenggunaStale: karyawanPenggunaAdapter.isUserStale(),
    refresh: (options?: { onlyFailed?: boolean; target?: "all" | "employees" | "users" }) =>
      karyawanPenggunaAdapter.refresh(options),
    retryFailed: () => karyawanPenggunaAdapter.refresh({ onlyFailed: true }),
    clearSessionData: () => karyawanPenggunaAdapter.clearSessionData(),
    activateAccount: karyawanPenggunaAdapter.activateAccount,
    deactivateAccount: karyawanPenggunaAdapter.deactivateAccount,
    resetPassword: karyawanPenggunaAdapter.resetPassword,
    updateRole: karyawanPenggunaAdapter.updateRole,
    addKaryawan: karyawanPenggunaAdapter.addKaryawan,
    updateKaryawan: karyawanPenggunaAdapter.updateKaryawan,
    deleteKaryawan: karyawanPenggunaAdapter.deleteKaryawan,
    preflightPermanentErasure: karyawanPenggunaAdapter.preflightPermanentErasure,
    permanentErasure: karyawanPenggunaAdapter.permanentErasure,
  };
}
