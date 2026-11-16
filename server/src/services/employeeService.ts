/**
 * Employee Management Domain Service
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Canonical service for employee lifecycle:
 * Authoritative single source of truth for identity, employment data, and demographic records.
 */

import { dbEmployeeRepository, EmployeeEntity, EmployeeCreateInput, EmployeeUpdateInput } from "../repositories/dbEmployeeRepository";
import { dbUserRepository } from "../repositories/dbUserRepository";
import { dbAuditRepository } from "../repositories/dbAuditRepository";
import { ApiError } from "../middleware/errorHandler";
import { TokenPayload, hashPassword } from "../utils/crypto";
import { runInTransaction } from "../database/db";
import { mapJabatanToCanonicalRole, normalizeCanonicalRole } from "../utils/canonicalIdentity";

export class EmployeeService {
  public getAll(): EmployeeEntity[] {
    return dbEmployeeRepository.getAll();
  }

  public getById(id: string): EmployeeEntity {
    const employee = dbEmployeeRepository.getById(id);
    if (!employee) {
      throw new ApiError(404, "EMPLOYEE_NOT_FOUND", `Karyawan ID '${id}' tidak ditemukan.`);
    }
    return employee;
  }

  public generateNextId(): string {
    return dbEmployeeRepository.generateNextId();
  }

  public createEmployee(
    payload: EmployeeCreateInput & {
      email?: string;
      role?: string;
      createAccount?: boolean;
    },
    user?: TokenPayload | null
  ): EmployeeEntity {
    // 1. Strict SVP privilege escalation defense
    const isCallerSvp = user?.role === "administrator";
    const targetJabatan = (payload.jabatan || "").toUpperCase().trim();
    const targetRole = ((payload as any).role || "").toLowerCase().trim();

    if ((targetJabatan === "SVP" || targetRole === "administrator") && !isCallerSvp) {
      throw new ApiError(403, "FORBIDDEN", "Hanya Administrator / SVP yang berwenang membuat atau menetapkan karyawan dengan jabatan/role SVP.");
    }

    // 2. Strict payload validation
    if (!payload.nik_ktp || !payload.nama_lengkap) {
      throw new ApiError(400, "VALIDATION_ERROR", "Field NIK KTP dan Nama Lengkap wajib diisi.");
    }

    const cleanNik = payload.nik_ktp.trim();
    if (!/^\d{16}$/.test(cleanNik)) {
      throw new ApiError(400, "INVALID_NIK", "NIK KTP harus terdiri dari tepat 16 digit angka.");
    }

    const existingByNik = dbEmployeeRepository.getByNik(cleanNik);
    if (existingByNik) {
      throw new ApiError(409, "NIK_ALREADY_EXISTS", `Karyawan dengan NIK '${cleanNik}' sudah terdaftar.`);
    }

    if (payload.gaji_pokok !== undefined && Number(payload.gaji_pokok) < 0) {
      throw new ApiError(400, "INVALID_SALARY", "Gaji pokok tidak boleh bernilai negatif.");
    }

    const employeeId = payload.id || dbEmployeeRepository.generateNextId();

    // 3. Atomic creation of employee and optional associated user account
    return runInTransaction(() => {
      const created = dbEmployeeRepository.create({
        id: employeeId,
        nik_ktp: cleanNik,
        nama_lengkap: payload.nama_lengkap.trim(),
        no_hp: payload.no_hp || null,
        tgl_lahir: payload.tgl_lahir || null,
        wilayah: payload.wilayah || null,
        alamat_domisili: payload.alamat_domisili || null,
        jabatan: payload.jabatan || null,
        avatar_url: payload.avatar_url || null,
        gaji_pokok: payload.gaji_pokok !== undefined ? Number(payload.gaji_pokok) : 0,
        status_karyawan: payload.status_karyawan || "Aktif",
        tanggal_bergabung: payload.tanggal_bergabung || null,
        jenis_kelamin: payload.jenis_kelamin || "Laki-laki",
      });

      // Optional user account provisioning (atomic rollback if fails)
      if (payload.createAccount && payload.email) {
        const email = payload.email.trim();
        const existingUser = dbUserRepository.getByEmailWithCredentials(email);
        if (existingUser) {
          throw new ApiError(409, "EMAIL_EXISTS", `Akun pengguna dengan email '${email}' sudah terdaftar.`);
        }

        // Derive initial password from DOB (DDMMYYYY) or fallback
        let initialPassword = "admin123";
        if (payload.tgl_lahir) {
          const dob = payload.tgl_lahir.replace(/[^0-9]/g, "");
          if (dob.length >= 8) {
            if (payload.tgl_lahir.includes("-")) {
              const parts = payload.tgl_lahir.split("-");
              if (parts.length === 3) {
                initialPassword = `${parts[2].padStart(2, "0")}${parts[1].padStart(2, "0")}${parts[0]}`;
              }
            } else {
              initialPassword = dob.slice(0, 8);
            }
          }
        }

        const { hash, salt } = hashPassword(initialPassword);
        const resolvedFromRole = payload.role ? normalizeCanonicalRole(payload.role) : null;
        const resolvedFromJabatan = payload.jabatan ? mapJabatanToCanonicalRole(payload.jabatan) : null;
        const assignedRole = resolvedFromRole || resolvedFromJabatan;
        if (!assignedRole) {
          throw new ApiError(400, "INVALID_ROLE", "Jabatan atau role akun tidak valid. Gunakan salah satu role kanonikal.");
        }
        if (assignedRole === "administrator" && !isCallerSvp) {
          throw new ApiError(403, "FORBIDDEN", "Hanya Administrator / SVP yang berwenang menetapkan role administrator pada akun pengguna.");
        }

        dbUserRepository.createUser({
          email,
          password_hash: hash,
          password_salt: salt,
          nama: payload.nama_lengkap.trim(),
          jabatan: payload.jabatan || "Staff",
          role: assignedRole,
          status: "Aktif",
          employee_id: employeeId,
          avatar_url: payload.avatar_url || null,
        });
      }

      // Audit log
      dbAuditRepository.save({
        id: `log-emp-create-${Date.now()}`,
        userId: user?.userId || "usr-admin",
        userName: user?.nama || "Admin",
        userRole: user?.role || "admin",
        action: "CREATE_EMPLOYEE",
        module: "Manajemen Karyawan",
        details: `Menambahkan karyawan baru ${created.nama_lengkap} (${created.id})`,
        metadata: { employeeId: created.id, nik: cleanNik },
        createdAt: new Date().toISOString(),
      });

      return dbEmployeeRepository.getById(employeeId) || created;
    });
  }

  public updateEmployee(
    id: string,
    updates: EmployeeUpdateInput & { status?: string; nama?: string; noHp?: string; tanggalLahir?: string; tanggalBergabung?: string; jenisKelamin?: string; gajiPokok?: number; alamat?: string },
    user?: TokenPayload | null
  ): EmployeeEntity {
    const isCallerSvp = user?.role === "administrator";
    const existing = this.getById(id);
    const existingJabatan = (existing.jabatan || "").toUpperCase().trim();

    // Protect existing SVP employee from being tampered with by non-SVP
    if (existingJabatan === "SVP" && !isCallerSvp) {
      throw new ApiError(403, "FORBIDDEN", "Data karyawan SVP dilindungi oleh sistem dan tidak dapat dimodifikasi oleh role lain.");
    }

    // Prevent non-SVP from promoting employee to SVP
    const targetJabatan = (updates.jabatan !== undefined ? String(updates.jabatan) : "").toUpperCase().trim();
    const targetRole = (updates as any).role !== undefined ? String((updates as any).role).toLowerCase().trim() : "";
    if ((targetJabatan === "SVP" || targetRole === "administrator") && !isCallerSvp) {
      throw new ApiError(403, "FORBIDDEN", "Hanya Administrator / SVP yang berwenang menetapkan jabatan/role SVP.");
    }

    // Map any camelCase alias keys
    const normalizedUpdates: EmployeeUpdateInput = {
      nik_ktp: updates.nik_ktp,
      nama_lengkap: updates.nama_lengkap || updates.nama,
      no_hp: updates.no_hp ?? updates.noHp,
      tgl_lahir: updates.tgl_lahir ?? updates.tanggalLahir,
      wilayah: updates.wilayah,
      alamat_domisili: updates.alamat_domisili ?? updates.alamat,
      jabatan: updates.jabatan,
      avatar_url: updates.avatar_url,
      gaji_pokok: updates.gaji_pokok ?? updates.gajiPokok,
      status_karyawan: updates.status_karyawan || updates.status,
      tanggal_bergabung: updates.tanggal_bergabung ?? updates.tanggalBergabung,
      jenis_kelamin: updates.jenis_kelamin ?? updates.jenisKelamin,
    };

    if (normalizedUpdates.nik_ktp !== undefined) {
      const cleanNik = normalizedUpdates.nik_ktp.trim();
      if (!/^\d{16}$/.test(cleanNik)) {
        throw new ApiError(400, "INVALID_NIK", "NIK KTP harus terdiri dari tepat 16 digit angka.");
      }
      const existingByNik = dbEmployeeRepository.getByNik(cleanNik);
      if (existingByNik && existingByNik.id !== id) {
        throw new ApiError(409, "NIK_ALREADY_EXISTS", `NIK '${cleanNik}' sudah digunakan oleh karyawan lain.`);
      }
      normalizedUpdates.nik_ktp = cleanNik;
    }

    if (normalizedUpdates.gaji_pokok !== undefined && Number(normalizedUpdates.gaji_pokok) < 0) {
      throw new ApiError(400, "INVALID_SALARY", "Gaji pokok tidak boleh bernilai negatif.");
    }

    return runInTransaction(() => {
      dbEmployeeRepository.update(id, normalizedUpdates);

      // Audit log
      dbAuditRepository.save({
        id: `log-emp-update-${Date.now()}`,
        userId: user?.userId || "usr-admin",
        userName: user?.nama || "Admin",
        userRole: user?.role || "admin",
        action: "UPDATE_EMPLOYEE",
        module: "Manajemen Karyawan",
        details: `Memperbarui data karyawan ${existing.nama_lengkap} (${id})`,
        metadata: { employeeId: id, updates: normalizedUpdates },
        createdAt: new Date().toISOString(),
      });

      return this.getById(id);
    });
  }

  public deleteEmployee(id: string, user?: TokenPayload | null): boolean {
    const existing = this.getById(id);
    const existingJabatan = (existing.jabatan || "").toUpperCase().trim();

    // Protect SVP employee from deletion
    if (existingJabatan === "SVP") {
      throw new ApiError(403, "FORBIDDEN", "Data karyawan SVP dilindungi oleh sistem dan tidak dapat dihapus.");
    }

    // Blocker check: active operational history
    if (dbEmployeeRepository.hasActiveOperationalHistory(id)) {
      throw new ApiError(
        400,
        "ACTIVE_OPERATIONAL_BLOCKER",
        `Karyawan ${existing.nama_lengkap} (${id}) memiliki data operasional aktif (reimbursement/kas/messenger). Gunakan fitur Permanent Erasure untuk penghapusan menyeluruh yang mematuhi integritas data.`
      );
    }

    return runInTransaction(() => {
      const deleted = dbEmployeeRepository.delete(id);

      // Audit log
      dbAuditRepository.save({
        id: `log-emp-delete-${Date.now()}`,
        userId: user?.userId || "usr-admin",
        userName: user?.nama || "Admin",
        userRole: user?.role || "admin",
        action: "DELETE_EMPLOYEE",
        module: "Manajemen Karyawan",
        details: `Menghapus karyawan ${existing.nama_lengkap} (${id})`,
        metadata: { deletedEmployeeId: id, nama: existing.nama_lengkap },
        createdAt: new Date().toISOString(),
      });

      return deleted;
    });
  }
}

export const employeeService = new EmployeeService();
