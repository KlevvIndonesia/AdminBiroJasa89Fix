/**
 * Messenger Domain Service
 * Admin SUN89 — Biro Jasa Management System
 */

import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";
import { dbMessengerRepository } from "../repositories/dbMessengerRepository";
import { dbOrderRepository } from "../repositories/dbOrderRepository";
import { dbFinanceRepository } from "../repositories/dbFinanceRepository";
import { dbAuditRepository } from "../repositories/dbAuditRepository";
import { dbUserRepository } from "../repositories/dbUserRepository";
import { db, runInTransaction } from "../database/db";
import { ApiError } from "../middleware/errorHandler";
import { TokenPayload } from "../utils/crypto";
import { parsePositiveDbUserId } from "../utils/canonicalIdentity";
import {
  ReimbursementRequest,
  MessengerHistoryItem,
  MessengerTaskType,
  ReimbursementCategory,
} from "../../../src/domain/messenger/types";
import { OperationalOrder } from "../../../src/domain/order/types";
import { normalizeReimbursementPayload } from "../utils/aliasNormalizer";

export interface MessengerSummaryStats {
  employeeId: string;
  name: string;
  phone: string;
  wilayah: string;
  status: string;
  completedTasksCount: number;
  lastCompletedDate?: string;
  totalDiajukan: number;
  totalDisetujui: number;
  totalDibayar: number;
  totalMenunggu: number;
  totalDisetujuiBelumDibayar: number;
  totalDitolak: number;
}

export interface TaskDetailResponse {
  task: {
    id: string;
    orderNo: string;
    taskType: MessengerTaskType;
    messenger: string;
    messengerEmployeeId?: string;
    customer: string;
    phone: string;
    nopol: string;
    jenisKendaraan: string;
    layanan: string;
    wilayah: string;
    status: string;
    assignedAt?: string;
    startedAt?: string;
    completedAt: string;
    totalTagihan: number;
    terbayar: number;
    statusBayar: string;
    receiverName?: string;
    relationship?: string;
    notes?: string;
    photoProofUrl?: string;
    rawOrder: OperationalOrder;
  };
  timeline: Array<{
    id: string;
    timestamp: string;
    title: string;
    author: string;
    role?: string;
    type: "ASSIGNMENT" | "PROCESS" | "EVIDENCE" | "REIMBURSEMENT" | "COMPLETION" | "SYSTEM";
    details?: string;
    amount?: number;
    statusBadge?: string;
  }>;
  attachments: Array<{
    id: string;
    name: string;
    type: "PICKUP_PROOF" | "SAMSAT_EVIDENCE" | "DELIVERY_HANDOVER" | "REIMBURSEMENT_RECEIPT" | "OTHER";
    url: string;
    uploadedAt: string;
    uploadedBy: string;
    category?: string;
  }>;
  reimbursements: {
    summary: {
      totalDiajukan: number;
      totalDisetujui: number;
      totalDitolak: number;
      totalDibayar: number;
      totalMenunggu: number;
      totalDisetujuiBelumDibayar: number;
    };
    items: ReimbursementRequest[];
  };
}

function normalizeReimbursementStatus(status?: string | null): "Diajukan" | "Sedang Ditinjau" | "Disetujui" | "Ditolak" | "Dibayar" | string {
  const s = String(status || "").trim().toLowerCase();
  if (s === "diajukan" || s === "pending" || s === "submitted") return "Diajukan";
  if (s === "sedang ditinjau" || s === "in_review" || s === "under_review" || s === "review") return "Sedang Ditinjau";
  if (s === "disetujui" || s === "approved") return "Disetujui";
  if (s === "ditolak" || s === "rejected") return "Ditolak";
  if (s === "dibayar" || s === "paid") return "Dibayar";
  return String(status || "").trim();
}

export function isSamsatOrTaxCategory(category?: string | null): boolean {
  if (!category || typeof category !== "string") return false;
  const normalized = category.trim().toLowerCase().replace(/[\s\-_]+/g, "");
  const forbiddenPatterns = [
    "samsat",
    "pajak",
    "pkb",
    "swdkllj",
    "pnbp",
    "stnk",
    "bpkb",
    "tnkb",
    "plat",
    "mutasi",
    "baliknama",
    "bbn",
    "bbnkb",
    "dendapajak",
    "administrasisamsat",
  ];
  return forbiddenPatterns.some((pattern) => normalized.includes(pattern));
}

export class MessengerService {
  /**
   * Get all messengers with complete stats and expense aggregates
   */
  public getMessengersWithStats(dateFrom?: string, dateTo?: string): MessengerSummaryStats[] {
    // 1. Gather all active messenger identities directly from SQLite (employees and users tables)
    const messengerMap = new Map<string, MessengerSummaryStats>();

    // Load active messengers from employees table
    try {
      const empStmt = db.prepare(`
        SELECT e.id, e.nama_lengkap, e.no_hp, e.wilayah, e.status_karyawan
        FROM employees e
        WHERE UPPER(e.jabatan) = 'MESSENGER' AND e.status_karyawan != 'NONAKTIF'
      `);
      const empRows = empStmt.all() as any[];
      for (const emp of empRows) {
        messengerMap.set(emp.nama_lengkap.toLowerCase(), {
          employeeId: emp.id,
          name: emp.nama_lengkap,
          phone: emp.no_hp || "",
          wilayah: emp.wilayah || "Jakarta",
          status: emp.status_karyawan,
          completedTasksCount: 0,
          totalDiajukan: 0,
          totalDisetujui: 0,
          totalDibayar: 0,
          totalMenunggu: 0,
          totalDisetujuiBelumDibayar: 0,
          totalDitolak: 0,
        });
      }
    } catch (e) {}

    // Load active messenger users from users table
    try {
      const userStmt = db.prepare(`
        SELECT id, nama, email, jabatan, status, employee_id, phone, wilayah
        FROM users
        WHERE UPPER(jabatan) = 'MESSENGER' AND status = 'Aktif'
      `);
      const userRows = userStmt.all() as any[];
      for (const u of userRows) {
        if (!u.employee_id) continue; // Exclude unmapped / inactive accounts
        const key = u.nama.toLowerCase();
        const existing = messengerMap.get(key);
        if (existing) {
          // If user has canonical employee_id, prefer canonical format
          if (u.employee_id) existing.employeeId = u.employee_id;
          if (!existing.phone && u.phone) existing.phone = u.phone;
          if (!existing.wilayah && u.wilayah) existing.wilayah = u.wilayah;
        } else {
          messengerMap.set(key, {
            employeeId: u.employee_id,
            name: u.nama,
            phone: u.phone || "",
            wilayah: u.wilayah || "Jakarta",
            status: u.status,
            completedTasksCount: 0,
            totalDiajukan: 0,
            totalDisetujui: 0,
            totalDibayar: 0,
            totalMenunggu: 0,
            totalDisetujuiBelumDibayar: 0,
            totalDitolak: 0,
          });
        }
      }
    } catch (e) {}

    // 2. Fetch all completed tasks from orders
    const history = this.getAllCompletedTasksInternal();

    // 3. Filter tasks by date range if specified
    const filteredHistory = history.filter((item) => {
      if (!item.completedAt) return true;
      const compDate = item.completedAt.split("T")[0];
      if (dateFrom && compDate < dateFrom) return false;
      if (dateTo && compDate > dateTo) return false;
      return true;
    });

    // Populate completed tasks counts
    for (const item of filteredHistory) {
      const key = item.messenger.toLowerCase();
      const existing = messengerMap.get(key);
      if (existing) {
        existing.completedTasksCount++;
        if (!existing.lastCompletedDate || item.completedAt > existing.lastCompletedDate) {
          existing.lastCompletedDate = item.completedAt;
        }
      }
    }

    // 4. Fetch all reimbursements and calculate non-overlapping aggregates
    const allReimbs = dbMessengerRepository.getAllReimbursements();
    for (const r of allReimbs) {
      if (r.date) {
        if (dateFrom && r.date < dateFrom) continue;
        if (dateTo && r.date > dateTo) continue;
      }

      const key = r.messengerName.toLowerCase();
      let stat = messengerMap.get(key);
      if (!stat) {
        for (const s of messengerMap.values()) {
          if (s.employeeId === r.employeeId) {
            stat = s;
            break;
          }
        }
      }

      if (stat) {
        stat.totalDiajukan += r.amount;
        const approved = r.approvedAmount !== undefined ? r.approvedAmount : (r.status === "Disetujui" || r.status === "Dibayar" ? r.amount : 0);
        const rejected = r.status === "Ditolak" ? r.amount : (r.rejectedAmount || 0);

        stat.totalDisetujui += approved;
        stat.totalDitolak += rejected;

        if (r.status === "Dibayar") {
          stat.totalDibayar += approved;
        } else if (r.status === "Disetujui") {
          stat.totalDisetujuiBelumDibayar += approved;
        } else if (r.status === "Diajukan" || r.status === "Sedang Ditinjau") {
          stat.totalMenunggu += r.amount;
        }
      }
    }

    return Array.from(messengerMap.values());
  }

  /**
   * Get filtered messenger task history
   */
  public getMessengerTaskHistory(filters?: {
    messenger?: string;
    employeeId?: string;
    taskType?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
  }): Array<MessengerHistoryItem & {
    reimbursementSummary: {
      totalDiajukan: number;
      totalDisetujui: number;
      totalDibayar: number;
      totalMenunggu: number;
    };
  }> {
    let tasks = this.getAllCompletedTasksInternal();

    // Filter by messenger name or employeeId
    if (filters?.employeeId && filters?.messenger && filters.messenger !== "all") {
      const target = filters.messenger.toLowerCase();
      const empId = filters.employeeId.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          (t.messengerEmployeeId && t.messengerEmployeeId.toLowerCase() === empId) ||
          (t.messenger && t.messenger.toLowerCase().includes(target))
      );
    } else {
      if (filters?.messenger && filters.messenger !== "all") {
        const target = filters.messenger.toLowerCase();
        tasks = tasks.filter((t) => t.messenger.toLowerCase().includes(target));
      }
      if (filters?.employeeId) {
        const empId = filters.employeeId.toLowerCase();
        tasks = tasks.filter((t) => t.messengerEmployeeId?.toLowerCase() === empId);
      }
    }
    if (filters?.taskType && filters.taskType !== "all") {
      tasks = tasks.filter((t) => t.taskType === filters.taskType);
    }
    if (filters?.dateFrom) {
      tasks = tasks.filter((t) => (t.completedAt ? t.completedAt.split("T")[0] >= filters.dateFrom! : true));
    }
    if (filters?.dateTo) {
      tasks = tasks.filter((t) => (t.completedAt ? t.completedAt.split("T")[0] <= filters.dateTo! : true));
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          t.orderNo.toLowerCase().includes(q) ||
          t.customer.toLowerCase().includes(q) ||
          t.nopol.toLowerCase().includes(q) ||
          t.layanan.toLowerCase().includes(q) ||
          t.messenger.toLowerCase().includes(q)
      );
    }

    // Attach reimbursement summaries per task
    const allReimbs = dbMessengerRepository.getAllReimbursements();

    return tasks.map((task) => {
      const taskReimbs = allReimbs.filter((r) => r.orderNo === task.orderNo);
      let totalDiajukan = 0;
      let totalDisetujui = 0;
      let totalDibayar = 0;
      let totalMenunggu = 0;

      for (const r of taskReimbs) {
        totalDiajukan += r.amount;
        const approved = r.approvedAmount !== undefined ? r.approvedAmount : (r.status === "Disetujui" || r.status === "Dibayar" ? r.amount : 0);
        totalDisetujui += approved;
        if (r.status === "Dibayar") {
          totalDibayar += approved;
        } else if (r.status === "Diajukan" || r.status === "Sedang Ditinjau") {
          totalMenunggu += r.amount;
        }
      }

      return {
        ...task,
        reimbursementSummary: {
          totalDiajukan,
          totalDisetujui,
          totalDibayar,
          totalMenunggu,
        },
      };
    });
  }

  /**
   * Get complete detail of a specific task including chronology, attachments, and expense submissions
   */
  public getTaskDetail(orderNo: string, taskType?: string): TaskDetailResponse {
    const allTasks = this.getAllCompletedTasksInternal();
    const task = allTasks.find(
      (t) => t.orderNo === orderNo && (!taskType || t.taskType === taskType)
    ) || allTasks.find((t) => t.orderNo === orderNo);

    if (!task) {
      // Look up raw order
      const rawOrder = dbOrderRepository.getByOrderNo(orderNo);
      if (!rawOrder) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Tugas atau order '${orderNo}' tidak ditemukan.`);
      }
      return this.buildTaskDetailFromOrder(rawOrder, (taskType as MessengerTaskType) || "Proses Samsat");
    }

    return this.buildTaskDetailFromItem(task);
  }

  /**
   * Get all reimbursements with optional filters
   */
  public getAllReimbursements(filters?: {
    employeeId?: string;
    messengerName?: string;
    orderNo?: string;
    status?: string;
  }): ReimbursementRequest[] {
    if (filters?.employeeId || filters?.messengerName) {
      const all = dbMessengerRepository.getAllReimbursements({
        orderNo: filters.orderNo,
        status: filters.status,
      });

      const targetEmpId = filters.employeeId?.toLowerCase();
      const targetName = filters.messengerName?.toLowerCase();
      const resolvedEmpId = filters.messengerName ? this.resolveMessengerEmpId(filters.messengerName).toLowerCase() : undefined;

      return all.filter((r) => {
        const rEmpId = r.employeeId?.toLowerCase();
        const rName = r.messengerName?.toLowerCase();
        return (
          (targetEmpId && rEmpId === targetEmpId) ||
          (resolvedEmpId && rEmpId === resolvedEmpId) ||
          (targetName && rName === targetName)
        );
      });
    }

    return dbMessengerRepository.getAllReimbursements(filters);
  }

  /**
   * Submit new reimbursement
   */
  public createReimbursement(
    data: Omit<ReimbursementRequest, "id" | "status" | "submittedAt">,
    user?: TokenPayload | null
  ): ReimbursementRequest {
    normalizeReimbursementPayload(data as any);

    // Phase C Rule 1.A / 3.D: Reject Samsat and Tax categories from operational reimbursement
    if (isSamsatOrTaxCategory(data.category)) {
      throw new ApiError(
        400,
        "FORBIDDEN_REIMBURSEMENT_CATEGORY",
        `Biaya resmi Samsat / Pajak ('${data.category}') tidak diperbolehkan diajukan sebagai reimbursement operasional. Biaya Samsat wajib diproses melalui alur penagihan biaya order dan invoice.`
      );
    }
    if (!data.employeeId || !data.messengerName || !data.category || data.amount === undefined || !data.date) {
      throw new ApiError(400, "VALIDATION_ERROR", "Data pengajuan biaya belum lengkap (kategori, nominal, tanggal wajib diisi).");
    }
    const requestedAmount = Number(data.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Nominal pengajuan harus berupa angka yang valid dan lebih besar dari 0.");
    }
    data.amount = requestedAmount;

    // Referential integrity check: order_no if provided must exist
    const rawOrderNo = data.orderNo?.trim();
    if (rawOrderNo && rawOrderNo !== "-") {
      const existingOrder = dbOrderRepository.getByOrderNo(rawOrderNo);
      if (!existingOrder) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${rawOrderNo}' tidak ditemukan.`);
      }
    }

    // Referential integrity check: employee/messenger must exist in users or employees table
    const rawEmpId = data.employeeId.trim();
    const numericId = parsePositiveDbUserId(rawEmpId);
    const userStmt = db.prepare("SELECT id, nama, employee_id, status FROM users WHERE id = ? OR employee_id = ?");
    const matchedUser = userStmt.get(
      numericId ?? -1,
      rawEmpId
    ) as any;

    let matchedEmployee: any = null;
    try {
      const empStmt = db.prepare("SELECT id, nama_lengkap, status_karyawan FROM employees WHERE id = ?");
      matchedEmployee = empStmt.get(rawEmpId);
    } catch (e) {}

    if (!matchedUser && !matchedEmployee) {
      throw new ApiError(404, "USER_NOT_FOUND", `Pegawai/Kurir '${data.messengerName}' (ID: ${data.employeeId}) tidak terdaftar dalam sistem.`);
    }

    if (matchedUser && matchedUser.status === "Nonaktif") {
      throw new ApiError(403, "EMPLOYEE_INACTIVE", "Status akun kurir/pegawai nonaktif.");
    }
    if (matchedEmployee && matchedEmployee.status_karyawan === "NONAKTIF") {
      throw new ApiError(403, "EMPLOYEE_INACTIVE", "Status kurir/pegawai nonaktif.");
    }

    // Caller authorization check: If caller is authenticated as messenger, caller can only submit for their own canonical ID
    if (user && user.role === "messenger") {
      const callerEmpId = (user.employeeId || "").trim();
      if (!callerEmpId || callerEmpId !== rawEmpId) {
        throw new ApiError(403, "FORBIDDEN", "Kurir hanya dapat mengajukan reimbursement atas identitas sendiri.");
      }
    }

    let resolvedMessengerId = (data as any).messengerId || undefined;
    if (!resolvedMessengerId) {
      const mRow = db.prepare("SELECT id FROM messengers WHERE employee_id = ? LIMIT 1").get(rawEmpId) as { id: string } | undefined;
      if (mRow) resolvedMessengerId = mRow.id;
    }

    return runInTransaction(() => {
      const id = dbMessengerRepository.getNextReimbursementId();
      const newReimb: ReimbursementRequest = {
        ...data,
        messengerId: resolvedMessengerId,
        orderNo: rawOrderNo && rawOrderNo !== "-" ? rawOrderNo : undefined,
        id,
        status: "Diajukan",
        submittedAt: new Date().toISOString(),
      };

      dbMessengerRepository.createReimbursement(newReimb);

      // Record audit log
      dbAuditRepository.save({
        id: `audit-reimb-create-${crypto.randomUUID()}`,
        userId: user?.userId || data.employeeId,
        userName: user?.nama || data.messengerName,
        userRole: (user?.role as any) || "messenger",
        action: "CREATE",
        module: "Reimbursement",
        details: `Pengajuan biaya ${newReimb.category} sebesar Rp ${newReimb.amount.toLocaleString("id-ID")}${newReimb.orderNo ? ` (Order ${newReimb.orderNo})` : ""}`,
        metadata: { reimbursementId: id, amount: newReimb.amount, orderNo: newReimb.orderNo },
        createdAt: new Date().toISOString(),
      });

      return newReimb;
    });
  }

  /**
   * Review reimbursement (Approve / Reject)
   */
  public reviewReimbursement(
    id: string,
    decision: "Disetujui" | "Ditolak" | "Sedang Ditinjau",
    user: TokenPayload,
    reviewNotes?: string,
    approvedAmount?: number,
    rejectedAmount?: number,
    targetDb?: DatabaseSync
  ): ReimbursementRequest {
    const activeDb = targetDb ?? db;
    if (user.role === "messenger") {
      throw new ApiError(403, "FORBIDDEN", "Messenger tidak memiliki hak untuk menyetujui pengajuan biaya.");
    }

    const canonicalDecision = normalizeReimbursementStatus(decision);
    if (!["Disetujui", "Ditolak", "Sedang Ditinjau"].includes(canonicalDecision)) {
      throw new ApiError(400, "INVALID_DECISION", `Keputusan review '${decision}' tidak valid.`);
    }

    return runInTransaction(() => {
      const existing = dbMessengerRepository.getReimbursementById(id, activeDb);
      if (!existing) {
        throw new ApiError(404, "NOT_FOUND", `Pengajuan biaya '${id}' tidak ditemukan.`);
      }

      const currentStatus = normalizeReimbursementStatus(existing.status);

      // Phase C Rule 1.A / 3.D: Reject Samsat and Tax categories from approval
      if (canonicalDecision === "Disetujui" && isSamsatOrTaxCategory(existing.category)) {
        throw new ApiError(
          400,
          "FORBIDDEN_REIMBURSEMENT_CATEGORY",
          `Pengajuan biaya kategori '${existing.category}' tidak dapat disetujui karena termasuk biaya resmi Samsat/Pajak yang wajib diproses melalui alur penagihan biaya order dan invoice.`
        );
      }

      if (currentStatus === "Dibayar") {
        throw new ApiError(400, "INVALID_STATE", "Pengajuan biaya sudah dicairkan/dibayar dan tidak dapat diubah lagi.");
      }

      if (currentStatus === "Ditolak") {
        throw new ApiError(400, "ALREADY_REJECTED", "Pengajuan biaya yang sudah ditolak tidak dapat diubah atau disetujui lagi.");
      }

      if (currentStatus === "Disetujui" && canonicalDecision === "Disetujui") {
        throw new ApiError(400, "ALREADY_APPROVED", "Pengajuan biaya ini sudah disetujui sebelumnya.");
      }

      const requestedAmt = Number(existing.amount || 0);
      if (!Number.isFinite(requestedAmt) || requestedAmt <= 0) {
        throw new ApiError(400, "INVALID_REIMBURSEMENT_AMOUNT", "Nominal pengajuan biaya tidak valid (harus lebih besar dari 0).");
      }

      let finalApproved = 0;
      let finalRejected = 0;

      if (canonicalDecision === "Disetujui") {
        const rawApproved = approvedAmount !== undefined ? Number(approvedAmount) : requestedAmt;
        if (!Number.isFinite(rawApproved) || rawApproved <= 0 || rawApproved > requestedAmt) {
          throw new ApiError(
            400,
            "INVALID_APPROVED_AMOUNT",
            `Nominal yang disetujui (${approvedAmount}) harus lebih besar dari 0 dan tidak boleh melebihi nominal pengajuan (Rp ${requestedAmt.toLocaleString("id-ID")}).`
          );
        }
        finalApproved = rawApproved;
        finalRejected = rejectedAmount !== undefined ? Number(rejectedAmount) : Math.max(0, requestedAmt - finalApproved);
        if (!Number.isFinite(finalRejected) || finalRejected < 0 || finalApproved + finalRejected > requestedAmt) {
          throw new ApiError(
            400,
            "INVALID_APPROVED_AMOUNT",
            "Kombinasi nominal disetujui dan ditolak tidak boleh melebihi nominal pengajuan."
          );
        }
      } else if (canonicalDecision === "Ditolak") {
        finalApproved = 0;
        finalRejected = requestedAmt;
      }

      const updates: Partial<ReimbursementRequest> = {
        status: canonicalDecision as any,
        reviewedAt: new Date().toISOString(),
        reviewedBy: user.nama,
        reviewNotes: reviewNotes || undefined,
        approvedAmount: finalApproved,
        rejectedAmount: finalRejected,
      };

      const updatedOk = dbMessengerRepository.updateReimbursement(id, updates, activeDb);
      if (!updatedOk) {
        throw new ApiError(500, "UPDATE_FAILED", `Gagal memperbarui status pengajuan biaya '${id}'.`);
      }

      dbAuditRepository.save({
        id: `audit-reimb-review-${crypto.randomUUID()}`,
        userId: user.userId,
        userName: user.nama,
        userRole: user.role as any,
        action: "UPDATE",
        module: "Reimbursement Review",
        details: `Pengajuan biaya ${id} (${existing.messengerName}) diubah status menjadi ${canonicalDecision}${finalApproved > 0 ? ` (Disetujui Rp ${finalApproved.toLocaleString("id-ID")})` : ""}`,
        metadata: { id, decision: canonicalDecision, requestedAmount: requestedAmt, approvedAmount: finalApproved, rejectedAmount: finalRejected },
        createdAt: new Date().toISOString(),
      }, activeDb);

      return dbMessengerRepository.getReimbursementById(id, activeDb) || { ...existing, ...updates };
    }, activeDb);
  }

  /**
   * Void / Cancel reimbursement payout
   * Strictly reverses the original disbursement inside kas_messenger (NOT kas_kantor),
   * keeping kas_kantor untouched and recalculating messenger running balances.
   */
  public voidReimbursement(
    id: string,
    user: TokenPayload,
    voidReason: string,
    targetDb?: DatabaseSync
  ): ReimbursementRequest {
    const activeDb = targetDb ?? db;
    const allowedRoles = ["administrator"];
    if (!allowedRoles.includes((user.role || "").toLowerCase())) {
      throw new ApiError(403, "FORBIDDEN", "Hanya Supervisor atau Administrator yang berhak membatalkan (void) pencairan reimbursement.");
    }

    if (!voidReason || typeof voidReason !== "string" || !voidReason.trim()) {
      throw new ApiError(400, "MISSING_VOID_REASON", "Alasan pembatalan (voidReason) wajib diisi.");
    }

    return runInTransaction(() => {
      const existing = dbMessengerRepository.getReimbursementById(id, activeDb);
      if (!existing) {
        throw new ApiError(404, "NOT_FOUND", `Pengajuan reimbursement '${id}' tidak ditemukan.`);
      }

      const currentStatus = normalizeReimbursementStatus(existing.status);
      if (currentStatus !== "Dibayar") {
        throw new ApiError(400, "INVALID_STATUS", `Hanya reimbursement berstatus 'Dibayar' yang dapat dibatalkan (status saat ini: '${existing.status}').`);
      }

      // Locate original disbursement entry in kas_messenger
      let origKmRow: any = undefined;
      if (existing.kasMessengerId) {
        origKmRow = activeDb.prepare("SELECT * FROM kas_messenger WHERE id = ?").get(existing.kasMessengerId);
      }
      if (!origKmRow) {
        origKmRow = activeDb.prepare(
          "SELECT * FROM kas_messenger WHERE reimbursement_id = ? AND kredit > 0 ORDER BY id DESC LIMIT 1"
        ).get(id);
      }

      const netDisbRow = activeDb.prepare(
        "SELECT COALESCE(SUM(kredit), 0) - COALESCE(SUM(debit), 0) as netDisbursed FROM kas_messenger WHERE reimbursement_id = ?"
      ).get(id) as { netDisbursed: number } | undefined;

      if (origKmRow && Number(netDisbRow?.netDisbursed ?? 0) <= 0) {
        throw new ApiError(400, "ALREADY_REVERSED", `Pencairan reimbursement '${id}' sudah dibatalkan/direversal sebelumnya.`);
      }

      const nowStr = new Date().toISOString().split("T")[0];
      const nowIso = new Date().toISOString();
      const amountPaid = origKmRow && Number(origKmRow.kredit || 0) > 0
        ? Math.min(Number(origKmRow.kredit), Number(netDisbRow?.netDisbursed ?? origKmRow.kredit))
        : (existing.approvedAmount !== undefined && existing.approvedAmount > 0
          ? existing.approvedAmount
          : existing.amount);

      const targetMessengerId = origKmRow?.messenger_id || existing.messengerId || null;
      const targetMessengerName = origKmRow?.messenger || existing.messengerName;

      // 1. Compensating Reversal in Kas Messenger (Pemasukan/Debit restores courier balance because original payout was Kredit in Kas Messenger)
      const reversalKm = dbFinanceRepository.addKasMessenger({
        tanggal: nowStr,
        jenis: "Pemasukan",
        messenger: targetMessengerName,
        messenger_id: targetMessengerId,
        messengerId: targetMessengerId,
        keterangan: `[VOID/BATAL] Reversal Pencairan Reimbursement: ${targetMessengerName} (${existing.category}) [Ref: ${id}] - ${voidReason.trim()}`,
        in: amountPaid,
        out: 0,
        penanggungJawab: user.nama,
        orderNo: existing.orderNo || undefined,
        reimbursementId: id,
        kategori: "Reimbursement Reversal",
        payment_method_id: null,
        payment_method_snapshot: null,
      }, activeDb);

      // 2. Update Reimbursement status back to Disetujui and clear active payout pointers
      const updates: Partial<ReimbursementRequest> = {
        status: "Disetujui",
        paidAt: undefined,
        paidBy: undefined,
        paymentMethod: undefined,
        transactionRef: undefined,
        kasMessengerId: undefined,
        channel: undefined,
      };
      dbMessengerRepository.updateReimbursement(id, updates, activeDb);

      // 3. Audit Log
      dbAuditRepository.save({
        id: `audit-void-reimb-${crypto.randomUUID()}`,
        userId: user.userId,
        userName: user.nama,
        userRole: user.role as any,
        action: "VOID_REIMBURSEMENT",
        module: "Messenger",
        details: `Void pencairan reimbursement #${id} sebesar Rp ${amountPaid.toLocaleString("id-ID")} untuk kurir ${targetMessengerName} (Reversal Kas Messenger #${reversalKm.id}). Alasan: ${voidReason.trim()}`,
        metadata: {
          id,
          amountPaid,
          voidReason: voidReason.trim(),
          messengerId: targetMessengerId,
          originalKasMessengerId: origKmRow?.id || existing.kasMessengerId || null,
          reversalKasMessengerId: reversalKm.id,
        },
        createdAt: nowIso,
      }, activeDb);

      return dbMessengerRepository.getReimbursementById(id, activeDb) || { ...existing, ...updates };
    }, activeDb);
  }

  /**
   * Pay / Realize reimbursement (strictly disburses from Kas Messenger Kredit, zero mutation to Kas Kantor)
   */
  public payReimbursement(
    id: string,
    user: TokenPayload,
    paymentDetails?: { amount?: number; paymentMethod?: string; transactionRef?: string; channel?: string },
    targetDb?: DatabaseSync
  ): ReimbursementRequest {
    const activeDb = targetDb ?? db;
    if (user.role === "messenger") {
      throw new ApiError(403, "FORBIDDEN", "Messenger tidak memiliki hak untuk merealisasikan pembayaran.");
    }

    if (paymentDetails?.amount !== undefined) {
      const requestedPay = Number(paymentDetails.amount);
      if (!Number.isFinite(requestedPay) || requestedPay <= 0) {
        throw new ApiError(400, "INVALID_PAYOUT_AMOUNT", "Nominal pencairan harus lebih besar dari 0.");
      }
    }

    return runInTransaction(() => {
      const existing = dbMessengerRepository.getReimbursementById(id, activeDb);
      if (!existing) {
        throw new ApiError(404, "NOT_FOUND", `Pengajuan biaya '${id}' tidak ditemukan.`);
      }

      const currentStatus = normalizeReimbursementStatus(existing.status);
      if (currentStatus === "Dibayar") {
        throw new ApiError(400, "ALREADY_PAID", `Pengajuan biaya '${id}' sudah dibayarkan sebelumnya.`);
      }

      if (currentStatus !== "Disetujui") {
        throw new ApiError(
          400,
          "INVALID_STATUS",
          `Pengajuan reimbursement '${id}' berstatus '${existing.status}' dan tidak dapat dicairkan. Hanya pengajuan berstatus 'Disetujui' yang dapat dicairkan.`
        );
      }

      // Phase C Rule 1.A / 3.D: Reject Samsat and Tax categories from payout
      if (isSamsatOrTaxCategory(existing.category)) {
        throw new ApiError(
          400,
          "FORBIDDEN_REIMBURSEMENT_CATEGORY",
          `Pengajuan reimbursement kategori '${existing.category}' tidak dapat dicairkan karena termasuk biaya resmi Samsat/Pajak.`
        );
      }

      const approvedCeiling = Number(existing.approvedAmount ?? 0);
      if (!Number.isFinite(approvedCeiling) || approvedCeiling <= 0 || approvedCeiling > Number(existing.amount || 0)) {
        throw new ApiError(
          400,
          "INVALID_APPROVED_AMOUNT",
          `Nominal disetujui (approvedAmount=${existing.approvedAmount}) tidak valid untuk dicairkan.`
        );
      }

      const amountToPay = paymentDetails?.amount !== undefined ? Number(paymentDetails.amount) : approvedCeiling;
      if (amountToPay > approvedCeiling) {
        throw new ApiError(
          400,
          "PAYOUT_EXCEEDS_APPROVED_AMOUNT",
          `Nominal pencairan Rp ${amountToPay.toLocaleString("id-ID")} melebihi batas nominal yang disetujui (Rp ${approvedCeiling.toLocaleString("id-ID")}).`
        );
      }

      // Idempotency check: verify this reimbursement has no net active disbursement in kas_messenger
      const existingKasCheck = activeDb.prepare(`
        SELECT
          COALESCE(SUM(kredit), 0) - COALESCE(SUM(debit), 0) as netDisbursed,
          MAX(CASE WHEN kredit > 0 THEN id ELSE NULL END) as lastPayoutId
        FROM kas_messenger
        WHERE reimbursement_id = ?
      `).get(id) as { netDisbursed: number; lastPayoutId: number | null } | undefined;

      if (Number(existingKasCheck?.netDisbursed ?? 0) > 0) {
        throw new ApiError(400, "ALREADY_DISBURSED", `Pengajuan reimbursement '${id}' sudah dicairkan pada transaksi Kas Messenger #${existingKasCheck?.lastPayoutId}.`);
      }

      const nowStr = new Date().toISOString().split("T")[0];
      const nowIso = new Date().toISOString();

      // Phase 4B Batch 2B: Payout is cash disbursement strictly recorded as Kredit in Kas Messenger.
      // payment_method_id = NULL, payment_method_snapshot = NULL, reimbursement_id = id.
      // Does NOT touch kas_kantor!
      const kasMessengerItem = dbFinanceRepository.addKasMessenger({
        tanggal: nowStr,
        keterangan: `[KAS KELUAR] Pencairan Reimbursement Kurir: ${existing.messengerName} (${existing.category}) [Ref: ${id}]`,
        jenis: "Pengeluaran",
        messenger: existing.messengerName,
        messenger_id: existing.messengerId || null,
        messengerId: existing.messengerId || null,
        in: 0,
        out: amountToPay,
        penanggungJawab: user.nama,
        orderNo: existing.orderNo || undefined,
        reimbursementId: id,
        kategori: existing.category,
        payment_method_id: null,
        payment_method_snapshot: null,
      }, activeDb);

      // Update reimbursement record
      const updates: Partial<ReimbursementRequest> = {
        status: "Dibayar",
        paidAt: nowIso,
        paidBy: user.nama,
        paymentMethod: paymentDetails?.paymentMethod || "Kas Messenger",
        transactionRef: paymentDetails?.transactionRef || `TRX-REIMB-${id}`,
        channel: paymentDetails?.channel || "Kas Messenger",
        kasMessengerId: kasMessengerItem.id,
      };

      const updatedOk = dbMessengerRepository.updateReimbursement(id, updates, activeDb);
      if (!updatedOk) {
        throw new ApiError(500, "UPDATE_FAILED", `Gagal memperbarui status pencairan reimbursement '${id}'.`);
      }

      // Record audit log
      dbAuditRepository.save({
        id: `audit-reimb-pay-${crypto.randomUUID()}`,
        userId: user.userId,
        userName: user.nama,
        userRole: user.role as any,
        action: "UPDATE",
        module: "Reimbursement Payout",
        details: `Pencairan reimbursement ${id} sebesar Rp ${amountToPay.toLocaleString("id-ID")} kepada ${existing.messengerName} dicatat pada Kas Messenger #${kasMessengerItem.id}`,
        metadata: {
          id,
          requestedAmount: existing.amount,
          approvedAmount: approvedCeiling,
          paidAmount: amountToPay,
          forfeitedRemainder: Math.max(0, approvedCeiling - amountToPay),
          kasMessengerId: kasMessengerItem.id,
          channel: updates.channel,
        },
        createdAt: nowIso,
      }, activeDb);

      return dbMessengerRepository.getReimbursementById(id, activeDb) || { ...existing, ...updates };
    }, activeDb);
  }

  // ==========================================
  // INTERNAL HELPERS
  // ==========================================

  private getAllCompletedTasksInternal(): MessengerHistoryItem[] {
    const active = dbOrderRepository.getAllFlat(false);
    const archived = dbOrderRepository.getAllFlat(true);

    const allOrdersMap = new Map<string, OperationalOrder>();
    for (const ord of [...active, ...archived]) {
      if (ord?.orderNo) allOrdersMap.set(ord.orderNo, ord);
    }

    const allOrders = Array.from(allOrdersMap.values());
    const history: MessengerHistoryItem[] = [];
    const seenIds = new Set<string>();

    for (const order of allOrders) {
      const tagihan = order.payment?.totalBiaya || order.costSnapshot?.totalBiayaJasa || 1500000;
      const terbayar = order.payment?.dibayar || (order.payment?.statusPembayaran === "Lunas" ? tagihan : 0);
      const statusBayar = order.payment?.statusPembayaran || (terbayar >= tagihan ? "Lunas" : "Belum Lunas");

      // 1. Jemput Dokumen
      const hasMessengerForPickup = Boolean(order.messenger || (order as any).assignedMessengerName);
      const isPickupDone =
        order.metodeLayanan !== "Datang Langsung" &&
        hasMessengerForPickup &&
        ((order as any).pickupCompleted ||
          order.messengerTaskStatus === "Dokumen Sudah Tersedia" ||
          order.currentStep >= 3 ||
          Boolean((order as any).pickupCompletedAt) ||
          Boolean(order.pickupProof?.photoProofUrl));

      if (isPickupDone) {
        const histId = `HIST-${order.orderNo}-PICKUP`;
        if (!seenIds.has(histId)) {
          seenIds.add(histId);
          const mName = (order as any).assignedMessengerName || order.messenger || "Kurir Penjemput";
          history.push({
            id: histId,
            orderNo: order.orderNo,
            taskType: "Jemput Dokumen",
            messenger: mName,
            messengerEmployeeId: (order as any).assignedMessengerId || this.resolveMessengerEmpId(mName),
            customer: order.customer,
            phone: order.nomorHP || "-",
            nopol: order.nopol || "-",
            jenisKendaraan: order.jenisKendaraan || "-",
            layanan: order.layanan,
            wilayah: (order as any).alamatPenjemputan?.kota || order.wilayahSamsatAsal || "Wilayah Klien",
            completedAt: (order as any).pickupCompletedAt || order.pickupProof?.completedAt || (order as any).tanggalJemput || order.createdAt,
            totalTagihan: tagihan,
            terbayar,
            statusBayar,
            status: "Selesai",
            keterangan: order.pickupProof?.notes || (order as any).catatanPenjadwalan || order.messengerTaskNotes || "Dokumen berkas berhasil dijemput dari klien",
            photoProofUrl: order.pickupProof?.photoProofUrl,
            rawOrder: order,
          });
        }
      }

      // 2. Samsat Process
      const hasMessengerForSamsat = Boolean((order as any).samsatMessenger || (order as any).samsatMessengerNama || order.messenger);
      const isSamsatDone =
        hasMessengerForSamsat &&
        ((order as any).samsatStatus === "Selesai" ||
          Boolean((order as any).samsatCompletedAt) ||
          order.currentStep >= 5 ||
          Boolean((order as any).samsatPickupProof?.photoProofUrl) ||
          Boolean((order as any).samsatPickupCompletedAt));

      if (isSamsatDone) {
        const histId = `HIST-${order.orderNo}-SAMSAT`;
        if (!seenIds.has(histId)) {
          seenIds.add(histId);
          const mName = (order as any).samsatMessenger || (order as any).samsatMessengerNama || (order as any).assignedMessengerName || order.messenger || "Kurir Samsat";
          history.push({
            id: histId,
            orderNo: order.orderNo,
            taskType: "Proses Samsat",
            messenger: mName,
            messengerEmployeeId: (order as any).samsatMessengerId || this.resolveMessengerEmpId(mName),
            customer: order.customer,
            phone: order.nomorHP || "-",
            nopol: order.nopol || "-",
            jenisKendaraan: order.jenisKendaraan || "-",
            layanan: order.layanan,
            wilayah: order.wilayahSamsatAsal ? (order.wilayahSamsatAsal.toLowerCase().includes("samsat") ? order.wilayahSamsatAsal : `Samsat ${order.wilayahSamsatAsal}`) : "Samsat",
            completedAt: (order as any).samsatCompletedAt || (order as any).tanggalProsesSamsat || order.createdAt,
            totalTagihan: tagihan,
            terbayar,
            statusBayar,
            status: "Selesai",
            keterangan: (order as any).catatanSamsat || (order as any).samsatPickupNotes || "Pengurusan berkas loket Samsat telah diselesaikan",
            photoProofUrl: (order as any).samsatPickupProof?.photoProofUrl,
            rawOrder: order,
          });
        }
      }

      // 3. Pengantaran Dokumen
      const hasMessengerForDelivery = Boolean((order as any).messengerPengantar || (order as any).assignedMessengerName || order.messenger);
      const isDeliveryDone =
        (order as any).metodePengantaran !== "Ambil di Kantor" &&
        hasMessengerForDelivery &&
        ((order as any).deliveryStatus === "Dokumen Diserahkan" ||
          (order as any).isReceived ||
          order.currentStep >= 8 ||
          Boolean(order.deliveryHandover?.completedAt) ||
          Boolean(order.deliveryHandover?.photoProofUrl) ||
          Boolean((order as any).tanggalDiterima));

      if (isDeliveryDone) {
        const histId = `HIST-${order.orderNo}-DELIVERY`;
        if (!seenIds.has(histId)) {
          seenIds.add(histId);
          const mName = (order as any).messengerPengantar || (order as any).assignedMessengerName || order.messenger || "Kurir Pengantar";
          history.push({
            id: histId,
            orderNo: order.orderNo,
            taskType: "Pengantaran Dokumen",
            messenger: mName,
            messengerEmployeeId: (order as any).deliveryMessengerId || this.resolveMessengerEmpId(mName),
            customer: order.customer,
            phone: order.nomorHP || "-",
            nopol: order.nopol || "-",
            jenisKendaraan: order.jenisKendaraan || "-",
            layanan: order.layanan,
            wilayah: (order as any).alamatPengantaran?.kota || order.wilayahSamsatAsal || "Alamat Klien",
            completedAt: (order as any).tanggalDiterima || order.deliveryHandover?.completedAt || (order as any).completedAt || (order as any).tanggalPengantaran || order.createdAt,
            totalTagihan: tagihan,
            terbayar,
            statusBayar,
            status: "Selesai",
            receiverName: order.deliveryHandover?.recipientName || (order as any).receiverName || order.customer,
            relationship: order.deliveryHandover?.relationship || "Pemilik Langsung",
            keterangan: order.deliveryHandover?.notes || (order as any).catatanPengantaran || order.messengerTaskNotes || "Dokumen hasil berhasil diserahkan ke klien",
            photoProofUrl: order.deliveryHandover?.photoProofUrl,
            rawOrder: order,
          });
        }
      }

      // 4. Jemput Hasil Samsat (Phase 4 Dedicated)
      const jemputHasilAcc = (order.taskAcceptance || {})["Jemput Hasil Samsat"] as any;
      const isJemputHasilDone =
        order.samsatPickupStatus === "Dokumen Samsat Diterima di Kantor" ||
        jemputHasilAcc?.status === "COMPLETED" ||
        Boolean(order.samsatPickupCompletedAt);

      if (isJemputHasilDone) {
        const cycle = jemputHasilAcc?.cycle || (order as any).samsatCycle || 1;
        const histId = `HIST-${order.orderNo}-JEMPUT_HASIL-C${cycle}`;
        if (!seenIds.has(histId)) {
          seenIds.add(histId);
          const mName =
            jemputHasilAcc?.completedBy ||
            order.samsatPickupMessengerNama ||
            order.samsatPickupMessenger ||
            jemputHasilAcc?.courierName ||
            "Kurir Jemput Hasil";
          const mId =
            jemputHasilAcc?.completedById ||
            order.samsatPickupMessengerId ||
            jemputHasilAcc?.courierId ||
            this.resolveMessengerEmpId(mName);

          history.push({
            id: histId,
            orderNo: order.orderNo,
            taskType: "Jemput Hasil Samsat",
            messenger: mName,
            messengerEmployeeId: mId,
            customer: order.customer,
            phone: order.nomorHP || "-",
            nopol: order.nopol || "-",
            jenisKendaraan: order.jenisKendaraan || "-",
            layanan: order.layanan,
            wilayah: order.wilayahSamsatAsal ? (order.wilayahSamsatAsal.toLowerCase().includes("samsat") ? order.wilayahSamsatAsal : `Samsat ${order.wilayahSamsatAsal}`) : "Samsat",
            completedAt: order.samsatPickupCompletedAt || jemputHasilAcc?.completedAt || (order as any).updatedAt || order.createdAt,
            totalTagihan: tagihan,
            terbayar,
            statusBayar,
            status: "Selesai",
            keterangan: "Berkas fisik hasil Samsat telah diserahkan dan diterima di kantor",
            photoProofUrl: (order as any).samsatPickupProof || (order as any).samsatResultProof,
            rawOrder: order,
          });
        }
      }
    }

    return history.sort((a, b) => {
      const timeA = new Date(a.completedAt).getTime() || 0;
      const timeB = new Date(b.completedAt).getTime() || 0;
      return timeB - timeA;
    });
  }


  /**
   * BD-RBAC-03: Returns active tasks and orders assigned strictly to the authenticated courier.
   * Strips sensitive financial metrics and filters out any orders not owned by this courier.
   */
  public getMyTasks(user: TokenPayload): Record<string, OperationalOrder[]> {
    const rawActive = dbOrderRepository.getActiveOrders();
    const result: Record<string, OperationalOrder[]> = {
      "Verifikasi": [],
      "Penjadwalan": [],
      "Verifikasi Fisik": [],
      "Proses Samsat": [],
      "Verifikasi Dokumen": [],
      "Supervisi": [],
      "Pengantaran": [],
      "Dokumen Telah Diterima": [],
    };

    const courierEmpId = (user.employeeId || "").trim().toLowerCase();
    // Scope 1: If employeeId is missing, empty, or whitespace, return empty dictionary immediately
    if (!courierEmpId) {
      return result;
    }

    for (const [stage, orders] of Object.entries(rawActive)) {
      if (!Array.isArray(orders)) continue;
      for (const order of orders) {
        if (!order || !order.orderNo) continue;

        // Scope 1: Strictly match against verified employeeId only; zero fallback to courier display name
        const isAssignedPickup =
          Boolean(order.assignedMessengerId && order.assignedMessengerId.trim().toLowerCase() === courierEmpId);

        const isAssignedSamsat =
          Boolean(order.samsatMessengerId && order.samsatMessengerId.trim().toLowerCase() === courierEmpId);

        const isAssignedSamsatPickup =
          Boolean(order.samsatPickupMessengerId && order.samsatPickupMessengerId.trim().toLowerCase() === courierEmpId);

        const isAssignedDelivery =
          Boolean(order.deliveryMessengerId && order.deliveryMessengerId.trim().toLowerCase() === courierEmpId);

        const isAssigned = isAssignedPickup || isAssignedSamsat || isAssignedSamsatPickup || isAssignedDelivery;

        if (isAssigned) {
          const sanitized: OperationalOrder = {
            ...order,
            totalBiaya: order.totalBiaya || 0,
            biayaSamsat: order.biayaSamsat,
            biayaJasa: 0,
            finalBiayaJasa: 0,
          };
          if (!result[stage]) result[stage] = [];
          result[stage].push(sanitized);
        }
      }
    }
    return result;
  }

  public resolveMessengerEmpId(name: string): string {
    if (!name || typeof name !== "string") return "";
    const cleanName = name.trim().toLowerCase();
    try {
      const userStmt = db.prepare(
        "SELECT employee_id FROM users WHERE LOWER(nama) = ? AND employee_id IS NOT NULL LIMIT 1"
      );
      const userRow = userStmt.get(cleanName) as { employee_id: string } | undefined;
      if (userRow?.employee_id) return userRow.employee_id;

      const empStmt = db.prepare(
        "SELECT id FROM employees WHERE LOWER(nama_lengkap) = ? AND status_karyawan != 'NONAKTIF' LIMIT 1"
      );
      const empRow = empStmt.get(cleanName) as { id: string } | undefined;
      if (empRow?.id) return empRow.id;
    } catch (e) {}
    return "";
  }

  private buildTaskDetailFromItem(item: MessengerHistoryItem): TaskDetailResponse {
    const rawOrder = item.rawOrder;
    const orderNo = item.orderNo;

    // 1. Compile chronological timeline events based on actual recorded events
    const timeline: TaskDetailResponse["timeline"] = [];

    if (rawOrder.createdAt) {
      timeline.push({
        id: `tl-${orderNo}-created`,
        timestamp: rawOrder.createdAt,
        title: "Tugas & Order Dibuat",
        author: "Admin Kantor",
        role: "admin",
        type: "SYSTEM",
        details: `Pendaftaran order ${orderNo} (${item.layanan}) berhasil dicatat ke sistem.`,
      });
    }

    if ((rawOrder as any).tanggalPenjadwalan || (rawOrder as any).scheduledDate) {
      timeline.push({
        id: `tl-${orderNo}-assigned`,
        timestamp: (rawOrder as any).tanggalPenjadwalan || (rawOrder as any).scheduledDate || rawOrder.createdAt,
        title: "Tugas Diberikan kepada Messenger",
        author: "Admin Operasional",
        role: "admin",
        type: "ASSIGNMENT",
        details: `Penugasan pekerjaan ${item.taskType} kepada kurir ${item.messenger} (${item.messengerEmployeeId || "Kurir"}).`,
      });
    }

    if ((rawOrder as any).startedAt || (rawOrder as any).tanggalJemput) {
      timeline.push({
        id: `tl-${orderNo}-started`,
        timestamp: (rawOrder as any).startedAt || (rawOrder as any).tanggalJemput || rawOrder.createdAt,
        title: "Messenger Mulai Menangani Tugas",
        author: item.messenger,
        role: "messenger",
        type: "PROCESS",
        details: `Kurir memulai perjalanan menuju lokasi (${item.wilayah}).`,
      });
    }

    // Component updates if available
    if (rawOrder.componentProgress && Array.isArray(rawOrder.componentProgress)) {
      rawOrder.componentProgress.forEach((cp, idx) => {
        if (cp.completedAt) {
          timeline.push({
            id: `tl-${orderNo}-comp-${idx}`,
            timestamp: cp.completedAt,
            title: `Tahapan: ${cp.name} Selesai`,
            author: item.messenger,
            role: "messenger",
            type: "PROCESS",
            details: `Penyelesaian loket Samsat: ${cp.name}${cp.nominal ? ` (Biaya Rp ${cp.nominal.toLocaleString("id-ID")})` : ""}`,
            amount: cp.nominal,
          });
        }
      });
    }

    // Reimbursements linked to this order
    const reimbursements = dbMessengerRepository.getAllReimbursements({ orderNo });
    for (const r of reimbursements) {
      timeline.push({
        id: `tl-reimb-${r.id}-submit`,
        timestamp: r.submittedAt,
        title: `Pengajuan Biaya Operasional: ${r.category}`,
        author: r.messengerName,
        role: "messenger",
        type: "REIMBURSEMENT",
        details: `Pengajuan biaya ${r.category} sebesar Rp ${r.amount.toLocaleString("id-ID")}${r.note ? ` - Catatan: ${r.note}` : ""}`,
        amount: r.amount,
        statusBadge: r.status,
      });

      if (r.reviewedAt && r.reviewedBy) {
        timeline.push({
          id: `tl-reimb-${r.id}-review`,
          timestamp: r.reviewedAt,
          title: `Pengajuan Biaya ${r.id} Ditinjau (${r.status})`,
          author: r.reviewedBy,
          role: "finance",
          type: "REIMBURSEMENT",
          details: `Keputusan: ${r.status}. Disetujui Rp ${(r.approvedAmount || 0).toLocaleString("id-ID")}${r.reviewNotes ? ` (${r.reviewNotes})` : ""}`,
          amount: r.approvedAmount,
          statusBadge: r.status,
        });
      }

      if (r.paidAt && r.paidBy) {
        timeline.push({
          id: `tl-reimb-${r.id}-paid`,
          timestamp: r.paidAt,
          title: `Pencairan Biaya ${r.id} Selesai`,
          author: r.paidBy,
          role: "finance",
          type: "REIMBURSEMENT",
          details: `Realisasi pencairan dana Rp ${(r.approvedAmount || r.amount).toLocaleString("id-ID")} via ${r.paymentMethod || "Kas Kantor"}`,
          amount: r.approvedAmount || r.amount,
          statusBadge: "Dibayar",
        });
      }
    }

    // Attachments / Evidence upload timeline
    if (item.photoProofUrl) {
      timeline.push({
        id: `tl-${orderNo}-proof-upload`,
        timestamp: item.completedAt,
        title: `Bukti Hasil Pekerjaan Diunggah`,
        author: item.messenger,
        role: "messenger",
        type: "EVIDENCE",
        details: `Foto dokumentasi bukti serah terima berkas diunggah oleh ${item.messenger}.`,
      });
    }

    // Completion timeline event
    if (item.completedAt) {
      timeline.push({
        id: `tl-${orderNo}-completed`,
        timestamp: item.completedAt,
        title: `Tugas ${item.taskType} Dinyatakan Selesai`,
        author: item.messenger,
        role: "messenger",
        type: "COMPLETION",
        details: item.keterangan || `Pekerjaan ${item.taskType} berhasil dituntaskan secara resmi.`,
      });
    }

    // Sort timeline chronologically (ascending)
    timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // 2. Attachments / Evidence compilation
    const attachments: TaskDetailResponse["attachments"] = [];

    if (rawOrder.pickupProof?.photoProofUrl) {
      attachments.push({
        id: `att-${orderNo}-pickup`,
        name: "Foto Bukti Penjemputan Berkas",
        type: "PICKUP_PROOF",
        url: rawOrder.pickupProof.photoProofUrl,
        uploadedAt: rawOrder.pickupProof.completedAt || rawOrder.createdAt,
        uploadedBy: item.messenger,
        category: "Jemput Dokumen",
      });
    }

    if (rawOrder.deliveryHandover?.photoProofUrl) {
      attachments.push({
        id: `att-${orderNo}-delivery`,
        name: `Foto Serah Terima (${rawOrder.deliveryHandover.recipientName || "Klien"})`,
        type: "DELIVERY_HANDOVER",
        url: rawOrder.deliveryHandover.photoProofUrl,
        uploadedAt: rawOrder.deliveryHandover.completedAt || item.completedAt,
        uploadedBy: item.messenger,
        category: "Pengantaran Dokumen",
      });
    }

    if (rawOrder.componentProgress && Array.isArray(rawOrder.componentProgress)) {
      rawOrder.componentProgress.forEach((cp: any, idx: number) => {
        if (cp.evidence && Array.isArray(cp.evidence)) {
          cp.evidence.forEach((ev: any, evIdx: number) => {
            attachments.push({
              id: `att-${orderNo}-comp-${idx}-${evIdx}`,
              name: `Bukti Loket: ${cp.name}`,
              type: "SAMSAT_EVIDENCE",
              url: ev.fileUrl,
              uploadedAt: ev.uploadedAt || item.completedAt,
              uploadedBy: ev.uploadedBy || item.messenger,
              category: "Proses Samsat",
            });
          });
        }
      });
    }

    for (const r of reimbursements) {
      if (r.receiptUrl) {
        attachments.push({
          id: `att-reimb-${r.id}`,
          name: `Kuitansi/Struk Pengajuan ${r.id} (${r.category})`,
          type: "REIMBURSEMENT_RECEIPT",
          url: r.receiptUrl,
          uploadedAt: r.submittedAt,
          uploadedBy: r.messengerName,
          category: `Pengajuan Biaya: ${r.category}`,
        });
      }
    }

    // 3. Reimbursements summary
    let totalDiajukan = 0;
    let totalDisetujui = 0;
    let totalDitolak = 0;
    let totalDibayar = 0;
    let totalMenunggu = 0;
    let totalDisetujuiBelumDibayar = 0;

    for (const r of reimbursements) {
      totalDiajukan += r.amount;
      const approved = r.approvedAmount !== undefined ? r.approvedAmount : (r.status === "Disetujui" || r.status === "Dibayar" ? r.amount : 0);
      const rejected = r.status === "Ditolak" ? r.amount : (r.rejectedAmount || 0);

      totalDisetujui += approved;
      totalDitolak += rejected;

      if (r.status === "Dibayar") {
        totalDibayar += approved;
      } else if (r.status === "Disetujui") {
        totalDisetujuiBelumDibayar += approved;
      } else if (r.status === "Diajukan" || r.status === "Sedang Ditinjau") {
        totalMenunggu += r.amount;
      }
    }

    return {
      task: {
        id: item.id,
        orderNo: item.orderNo,
        taskType: item.taskType,
        messenger: item.messenger,
        messengerEmployeeId: item.messengerEmployeeId,
        customer: item.customer,
        phone: item.phone || "-",
        nopol: item.nopol,
        jenisKendaraan: item.jenisKendaraan || "-",
        layanan: item.layanan,
        wilayah: item.wilayah,
        status: item.status,
        assignedAt: (rawOrder as any).tanggalPenjadwalan || rawOrder.createdAt,
        startedAt: (rawOrder as any).startedAt || (rawOrder as any).tanggalJemput,
        completedAt: item.completedAt,
        totalTagihan: item.totalTagihan,
        terbayar: item.terbayar || 0,
        statusBayar: item.statusBayar || "Lunas",
        receiverName: item.receiverName,
        relationship: item.relationship,
        notes: item.keterangan,
        photoProofUrl: item.photoProofUrl,
        rawOrder,
      },
      timeline,
      attachments,
      reimbursements: {
        summary: {
          totalDiajukan,
          totalDisetujui,
          totalDitolak,
          totalDibayar,
          totalMenunggu,
          totalDisetujuiBelumDibayar,
        },
        items: reimbursements,
      },
    };
  }

  private buildTaskDetailFromOrder(rawOrder: OperationalOrder, taskType: MessengerTaskType): TaskDetailResponse {
    const resolvedCourierName =
      taskType === "Proses Samsat"
        ? (rawOrder as any).samsatMessengerNama || rawOrder.samsatMessenger
        : taskType === "Jemput Hasil Samsat"
          ? (rawOrder as any).samsatPickupMessengerNama || (rawOrder as any).samsatPickupMessenger
          : taskType === "Pengantaran Dokumen"
            ? rawOrder.messengerPengantar
            : (rawOrder as any).assignedMessengerName || rawOrder.messenger;

    const resolvedCourierId =
      taskType === "Proses Samsat"
        ? rawOrder.samsatMessengerId
        : taskType === "Jemput Hasil Samsat"
          ? (rawOrder as any).samsatPickupMessengerId
          : taskType === "Pengantaran Dokumen"
            ? (rawOrder as any).deliveryMessengerId
            : (rawOrder as any).assignedMessengerId;

    const isCompleted =
      (taskType === "Jemput Dokumen" && Boolean(rawOrder.pickupCompleted)) ||
      (taskType === "Proses Samsat" && rawOrder.samsatStatus === "Selesai") ||
      (taskType === "Jemput Hasil Samsat" && (rawOrder as any).samsatPickupStatus === "Dokumen Samsat Diterima di Kantor") ||
      (taskType === "Pengantaran Dokumen" && (rawOrder.deliveryStatus === "Dokumen Diserahkan" || Boolean(rawOrder.isReceived)));

    const mStatus = String(rawOrder.messengerTaskStatus || "");
    const derivedStatus = isCompleted
      ? "Selesai"
      : mStatus === "Pending" || mStatus === "Menunggu"
        ? "Pending"
        : mStatus === "Sedang Dijemput" ||
            mStatus === "Dalam Proses" ||
            rawOrder.samsatStatus === "Sedang Proses Samsat" ||
            rawOrder.deliveryStatus === "Sedang Diantar"
          ? "Dalam Proses"
          : "Belum Diambil";

    const item: MessengerHistoryItem = {
      id: `HIST-${rawOrder.orderNo}-CUSTOM`,
      orderNo: rawOrder.orderNo,
      taskType,
      messenger: resolvedCourierName || "Belum Ditugaskan",
      messengerEmployeeId: resolvedCourierId || undefined,
      customer: rawOrder.customer,
      phone: rawOrder.nomorHP || "-",
      nopol: rawOrder.nopol || "-",
      jenisKendaraan: rawOrder.jenisKendaraan || "-",
      layanan: rawOrder.layanan,
      wilayah: rawOrder.wilayahSamsatAsal || "Kantor Samsat",
      completedAt: (rawOrder as any).completedAt || rawOrder.createdAt,
      totalTagihan: rawOrder.payment?.totalBiaya ?? 0,
      terbayar: rawOrder.payment?.dibayar ?? 0,
      statusBayar: rawOrder.payment?.statusPembayaran || "Belum Bayar",
      status: "Selesai",
      rawOrder,
    };

    const detail = this.buildTaskDetailFromItem(item);
    (detail.task as any).status = derivedStatus;
    return detail;
  }
}

export const messengerService = new MessengerService();
