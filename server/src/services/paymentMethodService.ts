/**
 * Payment Method Service
 * Admin SUN89 — Biro Jasa Management System
 */

import { dbPaymentMethodRepository, PaymentMethodEntity } from "../repositories/dbPaymentMethodRepository";
import { dbAuditRepository } from "../repositories/dbAuditRepository";
import { ApiError } from "../middleware/errorHandler";
import { TokenPayload } from "../middleware/auth";
import { DatabaseSync } from "node:sqlite";
import { getDb, runInTransaction } from "../database/db";

export class PaymentMethodService {
  public getAll(optionsOrActiveOnly?: boolean | { status?: string; activeOnly?: boolean }, targetDb?: DatabaseSync): PaymentMethodEntity[] {
    if (typeof optionsOrActiveOnly === "boolean") {
      return optionsOrActiveOnly ? dbPaymentMethodRepository.getActive(targetDb) : dbPaymentMethodRepository.getAll(targetDb);
    }
    if (optionsOrActiveOnly?.status) {
      return dbPaymentMethodRepository.getByStatus(optionsOrActiveOnly.status, targetDb);
    }
    if (optionsOrActiveOnly?.activeOnly) {
      return dbPaymentMethodRepository.getActive(targetDb);
    }
    return dbPaymentMethodRepository.getAll(targetDb);
  }

  public getById(id: string): PaymentMethodEntity | undefined {
    return dbPaymentMethodRepository.getById(id);
  }

  public create(
    data: {
      nama_metode: string;
      bank?: string;
      nama_rekening?: string;
      nomor_rekening?: string;
      status?: "Aktif" | "Nonaktif";
    },
    user?: TokenPayload | null
  ): PaymentMethodEntity {
    const rawNama = (data.nama_metode || "").trim();
    if (!rawNama) {
      throw new ApiError(400, "VALIDATION_ERROR", "Metode pembayaran wajib dipilih.");
    }

    let namaMetode = rawNama;
    if (rawNama.toLowerCase() === "cash" || rawNama.toLowerCase() === "tunai") {
      namaMetode = "Tunai";
    } else if (rawNama.toLowerCase() === "transfer bank" || rawNama.toLowerCase().includes("transfer")) {
      namaMetode = "Transfer Bank";
    } else {
      throw new ApiError(400, "VALIDATION_ERROR", "Metode pembayaran hanya boleh 'Transfer Bank' atau 'Tunai'.");
    }

    const status = data.status || "Aktif";

    // ─── CASE 1: TUNAI ──────────────────────────────────────────────────────────
    if (namaMetode === "Tunai") {
      // Enforcement: Hanya boleh ada 1 record Tunai aktif
      if (status === "Aktif") {
        const activeTunai = dbPaymentMethodRepository.getActiveTunai();
        if (activeTunai) {
          throw new ApiError(409, "DUPLICATE_TUNAI", "Metode pembayaran Tunai yang aktif sudah terdaftar. Hanya diperbolehkan satu metode Tunai aktif.");
        }
      }

      // Bersihkan nilai bank dan rekening lama
      const created = dbPaymentMethodRepository.create({
        nama_metode: "Tunai",
        bank: "Tunai",
        nama_rekening: "",
        nomor_rekening: "",
        status,
      });

      try {
        dbAuditRepository.save({
          id: `log-paymethod-crt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          userId: user?.userId || "usr-system",
          userName: user?.nama || "Admin API",
          userRole: user?.role || "admin",
          action: "CREATE",
          module: "Master Data - Metode Pembayaran",
          details: `Menambahkan metode pembayaran Tunai.`,
          metadata: {
            recordId: created.id,
            oldData: null,
            newData: created,
          },
          createdAt: new Date().toISOString(),
        });
      } catch (auditErr) {
        console.warn("[PaymentMethodService] Failed to record audit log:", auditErr);
      }

      return created;
    }

    // ─── CASE 2: TRANSFER BANK ─────────────────────────────────────────────────
    const bank = (data.bank || "").trim();
    if (!bank) {
      throw new ApiError(400, "VALIDATION_ERROR", "Bank / penyedia pembayaran wajib diisi untuk transfer bank.");
    }

    const namaRekening = (data.nama_rekening || "").trim();
    if (!namaRekening) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nama pemilik rekening wajib diisi untuk transfer bank.");
    }

    const nomorRekening = (data.nomor_rekening || "").trim();
    if (!nomorRekening) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nomor rekening wajib diisi untuk transfer bank.");
    }

    // Rejection: Duplikasi rekening yang sama ditolak
    const duplicate = dbPaymentMethodRepository.getByAccount(bank, nomorRekening);
    if (duplicate) {
      throw new ApiError(409, "DUPLICATE_ACCOUNT", `Rekening ${bank} dengan nomor '${nomorRekening}' sudah terdaftar.`);
    }

    const created = dbPaymentMethodRepository.create({
      nama_metode: "Transfer Bank",
      bank,
      nama_rekening: namaRekening,
      nomor_rekening: nomorRekening,
      status,
    });

    try {
      dbAuditRepository.save({
        id: `log-paymethod-crt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        userId: user?.userId || "usr-system",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: "CREATE",
        module: "Master Data - Metode Pembayaran",
        details: `Menambahkan metode pembayaran Transfer Bank '${bank}' no. rekening '${nomorRekening}'.`,
        metadata: {
          recordId: created.id,
          oldData: null,
          newData: created,
        },
        createdAt: new Date().toISOString(),
      });
    } catch (auditErr) {
      console.warn("[PaymentMethodService] Failed to record audit log:", auditErr);
    }

    return created;
  }

  public update(id: string, updates: Partial<PaymentMethodEntity>, user?: TokenPayload | null): PaymentMethodEntity {
    const existing = dbPaymentMethodRepository.getById(id);
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", "Metode pembayaran tidak ditemukan.");
    }

    let namaMetode = existing.nama_metode;
    if (updates.nama_metode !== undefined) {
      const rawNama = updates.nama_metode.trim();
      if (!rawNama) throw new ApiError(400, "VALIDATION_ERROR", "Metode pembayaran tidak boleh kosong.");
      if (rawNama.toLowerCase() === "cash" || rawNama.toLowerCase() === "tunai") {
        namaMetode = "Tunai";
      } else if (rawNama.toLowerCase() === "transfer bank" || rawNama.toLowerCase().includes("transfer")) {
        namaMetode = "Transfer Bank";
      } else {
        throw new ApiError(400, "VALIDATION_ERROR", "Metode pembayaran hanya boleh 'Transfer Bank' atau 'Tunai'.");
      }
    }

    const status = updates.status !== undefined ? updates.status : existing.status;

    // ─── CASE 1: TUNAI ──────────────────────────────────────────────────────────
    if (namaMetode === "Tunai") {
      // Enforcement: Hanya boleh ada 1 record Tunai aktif
      if (status === "Aktif") {
        const activeTunai = dbPaymentMethodRepository.getActiveTunai();
        if (activeTunai && activeTunai.id !== id) {
          throw new ApiError(409, "DUPLICATE_TUNAI", "Metode pembayaran Tunai yang aktif sudah terdaftar. Hanya diperbolehkan satu metode Tunai aktif.");
        }
      }

      // Bersihkan nilai bank & rekening lama
      const updated = dbPaymentMethodRepository.update(id, {
        nama_metode: "Tunai",
        bank: "Tunai",
        nama_rekening: "",
        nomor_rekening: "",
        status,
      });

      if (!updated) throw new ApiError(500, "UPDATE_FAILED", "Gagal memperbarui metode pembayaran.");

      const isDeactivated = status === "Nonaktif" && existing.status === "Aktif";
      try {
        dbAuditRepository.save({
          id: `log-paymethod-upd-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          userId: user?.userId || "usr-system",
          userName: user?.nama || "Admin API",
          userRole: user?.role || "admin",
          action: isDeactivated ? "DEACTIVATE" : "UPDATE",
          module: "Master Data - Metode Pembayaran",
          details: `${isDeactivated ? "Menonaktifkan" : "Memperbarui"} metode pembayaran Tunai.`,
          metadata: {
            recordId: updated.id,
            oldData: existing,
            newData: updated,
          },
          createdAt: new Date().toISOString(),
        });
      } catch (auditErr) {
        console.warn("[PaymentMethodService] Failed to record audit log:", auditErr);
      }

      return updated;
    }

    // ─── CASE 2: TRANSFER BANK ─────────────────────────────────────────────────
    const bank = updates.bank !== undefined ? updates.bank.trim() : (existing.bank === "Tunai" ? "" : existing.bank);
    if (!bank) {
      throw new ApiError(400, "VALIDATION_ERROR", "Bank / penyedia pembayaran wajib diisi untuk transfer bank.");
    }

    const namaRekening = updates.nama_rekening !== undefined ? updates.nama_rekening.trim() : existing.nama_rekening;
    if (!namaRekening) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nama pemilik rekening wajib diisi untuk transfer bank.");
    }

    const nomorRekening = updates.nomor_rekening !== undefined ? updates.nomor_rekening.trim() : existing.nomor_rekening;
    if (!nomorRekening) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nomor rekening wajib diisi untuk transfer bank.");
    }

    // Rejection: Duplikasi rekening yang sama ditolak (kecuali record yang sedang diedit)
    const duplicate = dbPaymentMethodRepository.getByAccount(bank, nomorRekening);
    if (duplicate && duplicate.id !== id) {
      throw new ApiError(409, "DUPLICATE_ACCOUNT", `Rekening ${bank} dengan nomor '${nomorRekening}' sudah digunakan oleh data metode pembayaran lain.`);
    }

    const updated = dbPaymentMethodRepository.update(id, {
      nama_metode: "Transfer Bank",
      bank,
      nama_rekening: namaRekening,
      nomor_rekening: nomorRekening,
      status,
    });

    if (!updated) throw new ApiError(500, "UPDATE_FAILED", "Gagal memperbarui metode pembayaran.");

    const isDeactivated = status === "Nonaktif" && existing.status === "Aktif";
    try {
      dbAuditRepository.save({
        id: `log-paymethod-upd-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        userId: user?.userId || "usr-system",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: isDeactivated ? "DEACTIVATE" : "UPDATE",
        module: "Master Data - Metode Pembayaran",
        details: `${isDeactivated ? "Menonaktifkan" : "Memperbarui"} metode pembayaran Transfer Bank '${updated.bank}' (${updated.nomor_rekening}).`,
        metadata: {
          recordId: updated.id,
          oldData: existing,
          newData: updated,
        },
        createdAt: new Date().toISOString(),
      });
    } catch (auditErr) {
      console.warn("[PaymentMethodService] Failed to record audit log:", auditErr);
    }

    return updated;
  }

  public delete(id: string, user?: TokenPayload | null, targetDb?: DatabaseSync): { success: boolean; deactivated?: boolean; message: string } {
    const activeDb = targetDb ?? getDb();
    return runInTransaction(() => {
      const existing = dbPaymentMethodRepository.getById(id, activeDb);
      if (!existing) {
        throw new ApiError(404, "NOT_FOUND", "Metode pembayaran tidak ditemukan.");
      }

      const res = dbPaymentMethodRepository.delete(id, activeDb);
      if (!res.success) {
        throw new ApiError(409, "CANNOT_DELETE_REFERENCED_PAYMENT_METHOD", res.message || "Metode pembayaran ini tidak dapat dihapus permanen.");
      }

      try {
        dbAuditRepository.save({
          id: `log-paymethod-del-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          userId: user?.userId || "usr-system",
          userName: user?.nama || "Admin API",
          userRole: user?.role || "admin",
          action: "DELETE",
          module: "Master Data - Metode Pembayaran",
          details: `Menghapus permanen metode pembayaran '${existing.nama_metode}' (${existing.bank || "-"}).`,
          metadata: {
            recordId: id,
            oldData: existing,
            newData: null,
          },
          createdAt: new Date().toISOString(),
        });
      } catch (auditErr) {
        console.warn("[PaymentMethodService] Failed to record audit log:", auditErr);
      }

      return {
        success: true,
        deactivated: false,
        message: res.message || `Metode '${existing.nama_metode}' (${existing.bank}) berhasil dihapus permanen.`,
      };
    }, activeDb);
  }
}

export const paymentMethodService = new PaymentMethodService();
