/**
 * SQLite Payment Method Repository
 * Admin SUN89 — Biro Jasa Management System
 */

import { db, getDb } from "../database/db";
import type { DatabaseSync } from "node:sqlite";

export interface PaymentMethodEntity {
  id: string;
  nama_metode: string;
  bank: string;
  nama_rekening: string;
  nomor_rekening: string;
  status: "Aktif" | "Nonaktif";
  created_at?: string;
  updated_at?: string;
}

export class DbPaymentMethodRepository {
  public getAll(targetDb?: DatabaseSync): PaymentMethodEntity[] {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare("SELECT * FROM payment_methods ORDER BY created_at ASC");
    return stmt.all() as PaymentMethodEntity[];
  }

  public getByStatus(status: string, targetDb?: DatabaseSync): PaymentMethodEntity[] {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare("SELECT * FROM payment_methods WHERE LOWER(TRIM(status)) = LOWER(TRIM(?)) ORDER BY created_at ASC");
    return stmt.all(status) as PaymentMethodEntity[];
  }

  public getActive(targetDb?: DatabaseSync): PaymentMethodEntity[] {
    return this.getByStatus("Aktif", targetDb);
  }

  public getById(id: string, targetDb?: DatabaseSync): PaymentMethodEntity | undefined {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare("SELECT * FROM payment_methods WHERE id = ?");
    return stmt.get(id) as PaymentMethodEntity | undefined;
  }

  public getByNama(nama: string, targetDb?: DatabaseSync): PaymentMethodEntity | undefined {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare("SELECT * FROM payment_methods WHERE LOWER(nama_metode) = LOWER(?)");
    return stmt.get(nama) as PaymentMethodEntity | undefined;
  }

  public getByAccount(bank: string, nomorRekening: string, targetDb?: DatabaseSync): PaymentMethodEntity | undefined {
    const cleanBank = (bank || "").trim().toLowerCase();
    const cleanNomor = (nomorRekening || "").trim();
    if (!cleanBank || !cleanNomor) return undefined;
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare(`
      SELECT * FROM payment_methods 
      WHERE nama_metode = 'Transfer Bank' 
        AND LOWER(bank) = ? 
        AND nomor_rekening = ?
    `);
    return stmt.get(cleanBank, cleanNomor) as PaymentMethodEntity | undefined;
  }

  public getActiveTunai(targetDb?: DatabaseSync): PaymentMethodEntity | undefined {
    const activeDb = targetDb ?? getDb();
    const stmt = activeDb.prepare(`
      SELECT * FROM payment_methods 
      WHERE (nama_metode = 'Tunai' OR nama_metode = 'Cash' OR LOWER(bank) = 'tunai' OR LOWER(bank) = 'cash') AND status = 'Aktif'
    `);
    return stmt.get() as PaymentMethodEntity | undefined;
  }

  public create(data: Omit<PaymentMethodEntity, "id" | "created_at" | "updated_at">): PaymentMethodEntity {
    const id = `pm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const stmt = db.prepare(`
      INSERT INTO payment_methods (id, nama_metode, bank, nama_rekening, nomor_rekening, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    stmt.run(
      id,
      data.nama_metode.trim(),
      data.bank.trim(),
      (data.nama_rekening || "").trim(),
      (data.nomor_rekening || "").trim(),
      data.status || "Aktif"
    );
    return this.getById(id)!;
  }

  public update(id: string, updates: Partial<PaymentMethodEntity>): PaymentMethodEntity | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const merged = {
      nama_metode: updates.nama_metode !== undefined ? updates.nama_metode.trim() : existing.nama_metode,
      bank: updates.bank !== undefined ? updates.bank.trim() : existing.bank,
      nama_rekening: updates.nama_rekening !== undefined ? updates.nama_rekening.trim() : existing.nama_rekening,
      nomor_rekening: updates.nomor_rekening !== undefined ? updates.nomor_rekening.trim() : existing.nomor_rekening,
      status: updates.status !== undefined ? updates.status : existing.status,
    };

    const stmt = db.prepare(`
      UPDATE payment_methods
      SET nama_metode = ?, bank = ?, nama_rekening = ?, nomor_rekening = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(
      merged.nama_metode,
      merged.bank,
      merged.nama_rekening,
      merged.nomor_rekening,
      merged.status,
      id
    );

    return this.getById(id)!;
  }

  public isUsedInTransactions(id: string, targetDb?: DatabaseSync): boolean {
    const activeDb = targetDb ?? getDb();
    try {
      // 1. Check in kas_kantor
      const kkStmt = activeDb.prepare("SELECT COUNT(*) as count FROM kas_kantor WHERE payment_method_id = ?");
      const kkCount = (kkStmt.get(id) as { count: number } | undefined)?.count || 0;
      if (kkCount > 0) return true;

      // 2. Check in kas_messenger
      const kmStmt = activeDb.prepare("SELECT COUNT(*) as count FROM kas_messenger WHERE payment_method_id = ?");
      const kmCount = (kmStmt.get(id) as { count: number } | undefined)?.count || 0;
      if (kmCount > 0) return true;

      // 3. Check in pengeluaran
      const expStmt = activeDb.prepare("SELECT COUNT(*) as count FROM pengeluaran WHERE payment_method_id = ?");
      const expCount = (expStmt.get(id) as { count: number } | undefined)?.count || 0;
      if (expCount > 0) return true;

      // 4. Check in invoice_payments
      const payStmt = activeDb.prepare("SELECT COUNT(*) as count FROM invoice_payments WHERE metode_pembayaran_id = ?");
      const payCount = (payStmt.get(id) as { count: number } | undefined)?.count || 0;
      if (payCount > 0) return true;

      return false;
    } catch {
      return false;
    }
  }

  public delete(id: string, targetDb?: DatabaseSync): { success: boolean; message?: string } {
    const activeDb = targetDb ?? getDb();
    const existing = this.getById(id, activeDb);
    if (!existing) {
      return { success: false, message: "Metode pembayaran tidak ditemukan" };
    }

    if (this.isUsedInTransactions(id, activeDb)) {
      return {
        success: false,
        message: "Metode pembayaran telah direferensikan dalam transaksi keuangan dan tidak dapat dihapus permanen. Gunakan penonaktifan status.",
      };
    }

    const stmt = activeDb.prepare("DELETE FROM payment_methods WHERE id = ?");
    stmt.run(id);
    return {
      success: true,
      message: `Metode '${existing.nama_metode}' (${existing.bank}) berhasil dihapus permanen.`,
    };
  }
}

export const dbPaymentMethodRepository = new DbPaymentMethodRepository();
