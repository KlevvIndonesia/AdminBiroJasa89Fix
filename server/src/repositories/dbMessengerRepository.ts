/**
 * SQLite Messenger & Reimbursement Repository
 * Admin SUN89 — Biro Jasa Management System
 */

import { db } from "../database/db";
import { ReimbursementRequest } from "../../../src/domain/messenger/types";

export class DbMessengerRepository {
  public getAllReimbursements(filters?: {
    employeeId?: string;
    orderNo?: string;
    status?: string;
  }): ReimbursementRequest[] {
    let sql = "SELECT * FROM messenger_reimbursements WHERE 1=1";
    const params: any[] = [];

    if (filters?.employeeId) {
      sql += " AND employee_id = ?";
      params.push(filters.employeeId);
    }
    if (filters?.orderNo) {
      sql += " AND order_no = ?";
      params.push(filters.orderNo);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY submitted_at DESC";

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map((r) => this.mapRowToReimbursement(r));
  }

  public getReimbursementById(id: string, targetDb?: any): ReimbursementRequest | undefined {
    const activeDb = targetDb ?? db;
    const stmt = activeDb.prepare("SELECT * FROM messenger_reimbursements WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.mapRowToReimbursement(row);
  }

  public createReimbursement(reimb: ReimbursementRequest, targetDb?: any): void {
    const activeDb = targetDb ?? db;
    const stmt = activeDb.prepare(`
      INSERT INTO messenger_reimbursements (
        id, employee_id, messenger_id, messenger_name, order_no, category, amount,
        approved_amount, rejected_amount, date, note, receipt_url, receipt_name,
        status, items_json, submitted_at, reviewed_at, reviewed_by, review_notes,
        paid_at, paid_by, payment_method, transaction_ref, pengeluaran_id,
        kas_messenger_id, channel, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, datetime('now')
      )
    `);

    stmt.run(
      reimb.id,
      reimb.employeeId,
      (reimb as any).messengerId || null,
      reimb.messengerName,
      reimb.orderNo || null,
      reimb.category,
      reimb.amount,
      reimb.approvedAmount || 0,
      reimb.rejectedAmount || 0,
      reimb.date,
      reimb.note || null,
      reimb.receiptUrl || null,
      reimb.receiptName || null,
      reimb.status,
      reimb.items ? JSON.stringify(reimb.items) : null,
      reimb.submittedAt || new Date().toISOString(),
      reimb.reviewedAt || null,
      reimb.reviewedBy || null,
      reimb.reviewNotes || null,
      reimb.paidAt || null,
      reimb.paidBy || null,
      reimb.paymentMethod || null,
      reimb.transactionRef || null,
      reimb.pengeluaranId || null,
      (reimb as any).kasMessengerId || null,
      (reimb as any).channel || null
    );
  }

  public updateReimbursement(id: string, updates: Partial<ReimbursementRequest>, targetDb?: any): boolean {
    const activeDb = targetDb ?? db;
    const existing = this.getReimbursementById(id, activeDb);
    if (!existing) return false;

    const merged = { ...existing, ...updates };

    const stmt = activeDb.prepare(`
      UPDATE messenger_reimbursements SET
        category = ?,
        amount = ?,
        approved_amount = ?,
        rejected_amount = ?,
        date = ?,
        note = ?,
        receipt_url = ?,
        receipt_name = ?,
        status = ?,
        items_json = ?,
        reviewed_at = ?,
        reviewed_by = ?,
        review_notes = ?,
        paid_at = ?,
        paid_by = ?,
        payment_method = ?,
        transaction_ref = ?,
        pengeluaran_id = ?,
        kas_messenger_id = ?,
        channel = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    const res = stmt.run(
      merged.category,
      merged.amount,
      merged.approvedAmount ?? 0,
      merged.rejectedAmount ?? 0,
      merged.date,
      merged.note || null,
      merged.receiptUrl || null,
      merged.receiptName || null,
      merged.status,
      merged.items ? JSON.stringify(merged.items) : null,
      merged.reviewedAt || null,
      merged.reviewedBy || null,
      merged.reviewNotes || null,
      merged.paidAt || null,
      merged.paidBy || null,
      merged.paymentMethod || null,
      merged.transactionRef || null,
      merged.pengeluaranId || null,
      (merged as any).kasMessengerId || null,
      (merged as any).channel || null,
      id
    );

    return res.changes > 0;
  }

  public getNextReimbursementId(targetDb?: any): string {
    const activeDb = targetDb ?? db;
    const rows = activeDb.prepare("SELECT id FROM messenger_reimbursements").all() as Array<{ id: string }>;
    let maxSeq = 0;
    for (const r of rows) {
      const m = /^REIMB-(\d+)$/i.exec(String(r.id || "").trim());
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
    }
    return `REIMB-${String(maxSeq + 1).padStart(3, "0")}`;
  }

  private mapRowToReimbursement(r: any): ReimbursementRequest {
    return {
      id: r.id,
      employeeId: r.employee_id,
      messengerId: r.messenger_id || undefined,
      messengerName: r.messenger_name,
      orderNo: r.order_no || undefined,
      category: r.category,
      amount: Number(r.amount || 0),
      approvedAmount: r.approved_amount !== null ? Number(r.approved_amount) : undefined,
      rejectedAmount: r.rejected_amount !== null ? Number(r.rejected_amount) : undefined,
      items: r.items_json ? JSON.parse(r.items_json) : undefined,
      date: r.date,
      note: r.note || undefined,
      receiptUrl: r.receipt_url || undefined,
      receiptName: r.receipt_name || undefined,
      status: r.status,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at || undefined,
      reviewedBy: r.reviewed_by || undefined,
      reviewNotes: r.review_notes || undefined,
      paidAt: r.paid_at || undefined,
      paidBy: r.paid_by || undefined,
      paymentMethod: r.payment_method || undefined,
      transactionRef: r.transaction_ref || undefined,
      pengeluaranId: r.pengeluaran_id || undefined,
      kasMessengerId: r.kas_messenger_id ? Number(r.kas_messenger_id) : undefined,
      channel: r.channel || undefined,
    };
  }
}

export const dbMessengerRepository = new DbMessengerRepository();
