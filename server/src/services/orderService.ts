/**
 * Order Domain Service
 * Admin SUN89 — Biro Jasa Management System
 */

import crypto from "node:crypto";
import { dbOrderRepository } from "../repositories/dbOrderRepository";
import { dbFinanceRepository } from "../repositories/dbFinanceRepository";
import { dbAuditRepository } from "../repositories/dbAuditRepository";
import { dbDocumentRepository } from "../repositories/dbDocumentRepository";
import { dbNotificationSettingsRepository } from "../repositories/dbNotificationSettingsRepository";
import { notificationConfigService } from "./notificationConfigService";
import { OperationalOrder, StageName, STAGES, getDefaultSamsatProcesses, ServiceRequirementsSnapshot } from "../../../src/domain/order/types";
import { serviceRepository, ServiceEntity } from "../repositories/dbServiceRepository";
import { dbWilayahRepository } from "../repositories/dbWilayahRepository";
import { dbPaymentMethodRepository } from "../repositories/dbPaymentMethodRepository";
import { dbPermissionRepository } from "../repositories/dbPermissionRepository";
import { buildServiceRequirementsSnapshot } from "../utils/serviceSnapshot";
import { normalizeToWibCalendarDate } from "../utils/dateNormalizer";
import { ApiError } from "../middleware/errorHandler";
import { TokenPayload } from "../utils/crypto";
import { db, runInTransaction } from "../database/db";
import { assertNoProtectedFieldViolations, normalizeOrderPayload } from "../utils/aliasNormalizer";
import { validateOrderPricingSanity } from "../utils/pricingSanityCheck";
import { resolveCanonicalActorEmployeeId } from "../utils/actorResolver";
import { resolveCanonicalSamsatCogs } from "../../../src/domain/finance/samsatCogs";
import { generateCanonicalPaymentId, formatScopedIdempotencyKey } from "../utils/canonicalHasher";
import { financeService } from "./financeService";

export const CANONICAL_SERVICES_MAP: Record<string, { id: string; nama: string }> = {
  // 1. Perpanjangan 1 Tahun
  "svc-perp-1th": { id: "svc-perp-1th", nama: "Perpanjangan 1 Tahun" },
  "perp_1thn": { id: "svc-perp-1th", nama: "Perpanjangan 1 Tahun" },
  "perpanjangan 1 tahun": { id: "svc-perp-1th", nama: "Perpanjangan 1 Tahun" },
  "tahunan": { id: "svc-perp-1th", nama: "Perpanjangan 1 Tahun" },
  "perpanjangan stnk tahunan": { id: "svc-perp-1th", nama: "Perpanjangan 1 Tahun" },
  "perpanjangan stnk": { id: "svc-perp-1th", nama: "Perpanjangan 1 Tahun" },

  // 2. Perpanjangan 5 Tahun
  "svc-perp-5th": { id: "svc-perp-5th", nama: "Perpanjangan 5 Tahun" },
  "perp_5thn": { id: "svc-perp-5th", nama: "Perpanjangan 5 Tahun" },
  "perpanjangan 5 tahun": { id: "svc-perp-5th", nama: "Perpanjangan 5 Tahun" },
  "5 tahunan": { id: "svc-perp-5th", nama: "Perpanjangan 5 Tahun" },
  "perpanjangan plat 5 tahun": { id: "svc-perp-5th", nama: "Perpanjangan 5 Tahun" },
  "ganti plat 5 tahun": { id: "svc-perp-5th", nama: "Perpanjangan 5 Tahun" },

  // 3. Mutasi Asal Samsat
  "svc-mut-asal": { id: "svc-mut-asal", nama: "Mutasi Asal Samsat" },
  "mut_asal": { id: "svc-mut-asal", nama: "Mutasi Asal Samsat" },
  "mutasi asal samsat": { id: "svc-mut-asal", nama: "Mutasi Asal Samsat" },
  "mutasi antar samsat": { id: "svc-mut-asal", nama: "Mutasi Asal Samsat" },
  "mutasi as": { id: "svc-mut-asal", nama: "Mutasi Asal Samsat" },
  "mutasi satu daerah": { id: "svc-mut-asal", nama: "Mutasi Asal Samsat" },
  "mutasi lokal": { id: "svc-mut-asal", nama: "Mutasi Asal Samsat" },

  // 4. Mutasi Antar Daerah
  "svc-mut-antar": { id: "svc-mut-antar", nama: "Mutasi Antar Daerah" },
  "mut_antar": { id: "svc-mut-antar", nama: "Mutasi Antar Daerah" },
  "mutasi antar daerah": { id: "svc-mut-antar", nama: "Mutasi Antar Daerah" },
  "mutasi luar daerah": { id: "svc-mut-antar", nama: "Mutasi Antar Daerah" },
  "mutasi ld": { id: "svc-mut-antar", nama: "Mutasi Antar Daerah" },
  "mutasi keluar daerah": { id: "svc-mut-antar", nama: "Mutasi Antar Daerah" },

  // 5. Balik Nama
  "svc-balik-nama": { id: "svc-balik-nama", nama: "Balik Nama" },
  "balik_nama": { id: "svc-balik-nama", nama: "Balik Nama" },
  "balik nama": { id: "svc-balik-nama", nama: "Balik Nama" },
  "bbn": { id: "svc-balik-nama", nama: "Balik Nama" },
  "bbn-kb": { id: "svc-balik-nama", nama: "Balik Nama" },

  // 6. Tarik Berkas
  "svc-tarik-berkas": { id: "svc-tarik-berkas", nama: "Tarik Berkas" },
  "tarik_berkas": { id: "svc-tarik-berkas", nama: "Tarik Berkas" },
  "tarik berkas": { id: "svc-tarik-berkas", nama: "Tarik Berkas" },
  "cabut berkas": { id: "svc-tarik-berkas", nama: "Tarik Berkas" },

  // 7. Duplikat STNK
  "svc-duplikat-stnk": { id: "svc-duplikat-stnk", nama: "Duplikat STNK" },
  "duplikat_stnk": { id: "svc-duplikat-stnk", nama: "Duplikat STNK" },
  "duplikat stnk": { id: "svc-duplikat-stnk", nama: "Duplikat STNK" },
  "stnk hilang": { id: "svc-duplikat-stnk", nama: "Duplikat STNK" },
};

export function resolveServiceIdentity(
  serviceIdInput?: string | null,
  layananInput?: string | null
): { serviceId: string | null; namaLayanan: string } {
  const normSvcId = (serviceIdInput || "").trim().toLowerCase();
  if (normSvcId) {
    // 1. Check database first
    const dbSvc = serviceRepository.getById(normSvcId);
    if (dbSvc) {
      return { serviceId: dbSvc.id, namaLayanan: dbSvc.nama_layanan };
    }
    // 2. Check canonical map
    if (CANONICAL_SERVICES_MAP[normSvcId]) {
      const match = CANONICAL_SERVICES_MAP[normSvcId];
      return { serviceId: match.id, namaLayanan: match.nama };
    }
  }

  const normLayanan = (layananInput || "").trim().toLowerCase();
  if (normLayanan) {
    // Check database by name or code
    const allDb = serviceRepository.getAll();
    const dbMatch = allDb.find(
      (s) => s.nama_layanan.toLowerCase() === normLayanan || s.kode_layanan.toLowerCase() === normLayanan
    );
    if (dbMatch) {
      return { serviceId: dbMatch.id, namaLayanan: dbMatch.nama_layanan };
    }
    if (CANONICAL_SERVICES_MAP[normLayanan]) {
      const match = CANONICAL_SERVICES_MAP[normLayanan];
      return { serviceId: match.id, namaLayanan: match.nama };
    }
  }

  return {
    serviceId: serviceIdInput || null,
    namaLayanan: layananInput || "Layanan Standar",
  };
}


export interface CancelOrderOptions {
  skipRefundPending?: boolean;
}

export interface SamsatValidationResult {
  allowed: boolean;
  code?: string;
  error?: string;
  totalComponents: number;
  completedComponents: number;
  incompleteComponents: string[];
}

/**
 * Authoritative Samsat Component Completion Validation
 * Gathers components from messengerComponentProgress and samsatProcesses without fragile fallback.
 * Enforces that all required components must be COMPLETED.
 * Blocks completion if any component is WAITING, IN_PROGRESS, or NOT_STARTED.
 * Blocks completion if component collection is empty, unless explicit service exemption applies.
 */
export function validateSamsatCompletion(order: OperationalOrder): SamsatValidationResult {
  const serviceId = (order as any).service_id || (order as any).serviceId || "";
  const layanan = (order.layanan || "").toLowerCase().trim();

  // Explicit Service Exemption Rule:
  // Only explicitly non-Samsat or administrative services (e.g. 'svc-lainnya', 'LAINNYA') are exempt.
  const isExemptService =
    serviceId === "svc-lainnya" ||
    serviceId.toUpperCase() === "LAINNYA" ||
    layanan === "lainnya" ||
    (order as any).kategoriLayanan === "LAINNYA";

  const componentMap = new Map<string, { id: string; name: string; status: string }>();

  // 1. From samsatProcesses
  if (Array.isArray(order.samsatProcesses)) {
    for (const p of order.samsatProcesses) {
      if (!p || !p.name) continue;
      const id = String(p.id || p.name).trim();
      const rawStatus = (p.status || "").trim();
      let normalizedStatus = "NOT_STARTED";
      if (rawStatus === "Selesai" || rawStatus === "COMPLETED") {
        normalizedStatus = "COMPLETED";
      } else if (rawStatus === "Dalam Proses" || rawStatus === "IN_PROGRESS") {
        normalizedStatus = "IN_PROGRESS";
      } else if (rawStatus === "Menunggu" || rawStatus === "WAITING") {
        normalizedStatus = "WAITING";
      } else if (rawStatus === "NOT_REQUIRED" || rawStatus === "Tidak Diperlukan") {
        normalizedStatus = "NOT_STARTED";
      }
      componentMap.set(id, { id, name: p.name, status: normalizedStatus });
    }
  }

  // 2. From messengerComponentProgress (overlay live progress)
  if (order.messengerComponentProgress && typeof order.messengerComponentProgress === "object") {
    for (const [id, comp] of Object.entries(order.messengerComponentProgress)) {
      if (!comp || !comp.name) continue;
      const rawStatus = (comp.status || "").trim();
      let normalizedStatus = "NOT_STARTED";
      if (rawStatus === "COMPLETED" || rawStatus === "Selesai") {
        normalizedStatus = "COMPLETED";
      } else if (rawStatus === "IN_PROGRESS" || rawStatus === "Dalam Proses") {
        normalizedStatus = "IN_PROGRESS";
      } else if (rawStatus === "WAITING" || rawStatus === "Menunggu") {
        normalizedStatus = "WAITING";
      } else if (rawStatus === "NOT_REQUIRED" || rawStatus === "Tidak Diperlukan") {
        normalizedStatus = "NOT_STARTED";
      }
      const compKey = String(comp.componentId || id).trim();
      componentMap.set(compKey, {
        id: compKey,
        name: comp.name,
        status: normalizedStatus,
      });
    }
  }

  const allComponents = Array.from(componentMap.values());

  // Rule: Empty component collection check
  if (allComponents.length === 0) {
    if (isExemptService) {
      return {
        allowed: true,
        totalComponents: 0,
        completedComponents: 0,
        incompleteComponents: [],
      };
    }
    return {
      allowed: false,
      code: "SAMSAT_COMPONENTS_REQUIRED",
      error: `Layanan '${order.layanan || serviceId}' mewajibkan komponen loket Samsat. Daftar komponen tidak boleh kosong.`,
      totalComponents: 0,
      completedComponents: 0,
      incompleteComponents: ["(Semua Komponen Wajib Belum Ada)"],
    };
  }

  // Check if ALL components are COMPLETED
  const incomplete = allComponents.filter((c) => c.status !== "COMPLETED");
  if (incomplete.length > 0) {
    const incompleteNames = incomplete.map((c) => `${c.name} (${c.status})`).join(", ");
    return {
      allowed: false,
      code: "SAMSAT_COMPONENTS_INCOMPLETE",
      error: `Terdapat ${incomplete.length} komponen loket Samsat yang belum selesai: ${incompleteNames}. Seluruh komponen wajib selesai (COMPLETED) sebelum menyelesaikan Samsat.`,
      totalComponents: allComponents.length,
      completedComponents: allComponents.length - incomplete.length,
      incompleteComponents: incomplete.map((c) => c.name),
    };
  }

  return {
    allowed: true,
    totalComponents: allComponents.length,
    completedComponents: allComponents.length,
    incompleteComponents: [],
  };
}

/**
 * Validates that an order is currently eligible for Samsat lifecycle processing (Step 4, Not Cancelled).
 * DEFECT-P2-01 Remediation
 */
export function assertValidSamsatStageAndStatus(order: OperationalOrder): void {
  if ((order as any).isCancelled || order.currentStageName === "Dibatalkan" || (order as any).status === "Dibatalkan") {
    throw new ApiError(400, "ORDER_CANCELLED", `Order '${order.orderNo}' sudah dibatalkan.`);
  }

  const stageList = STAGES as readonly string[];
  const currentStep = order.currentStep !== undefined
    ? Number(order.currentStep)
    : (order.currentStageName ? stageList.indexOf(order.currentStageName as any) + 1 : 0);

  const isSamsatStage = currentStep === 4 || order.currentStageName === "Proses Samsat";
  if (!isSamsatStage) {
    throw new ApiError(
      400,
      "INVALID_STAGE",
      `Order '${order.orderNo}' berada pada tahap '${order.currentStageName || "Tidak Diketahui"}' (Step ${currentStep}), bukan pada tahap Proses Samsat.`
    );
  }
}

/**
 * Validates canonical Messenger assignment identity against the order.
 * Strictly prevents generic fallbacks (EMP-MSG) or display-name spoofing.
 * Canonical Identity Contract:
 * - employeeId is authoritative primary identifier.
 * - userId is secondary account identifier.
 * - Display names (nama, userName) are NEVER used for authorization.
 * DEFECT-P2-02, Phase 3.1 & Phase 4 Canonical Remediation
 */
export function assertMessengerOwnership(
  order: OperationalOrder,
  user: TokenPayload | null | undefined,
  taskContext: "SAMSAT" | "PICKUP" | "DELIVERY" | "SAMSAT_PICKUP" | "ANY" = "ANY"
): { messengerId: string; messengerName: string } {
  if (!user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Autentikasi diperlukan.");
  }
  const role = (user.role || "").toLowerCase();
  if (role === "admin" || role === "administrator") {
    const courierName = user.nama || (user as any).userName || "Petugas Operasional";
    const courierId = (user as any).employeeId || user.userId || "EMP-ADMIN";
    return { messengerId: courierId, messengerName: courierName };
  }

  if (role !== "messenger") {
    throw new ApiError(403, "FORBIDDEN", "Hanya Messenger atau Admin yang memiliki wewenang untuk tugas ini.");
  }

  const messengerId = (user as any).employeeId;
  if (!messengerId || messengerId === "EMP-MSG" || messengerId === "EMP-SAMSAT" || messengerId === "Belum Ditugaskan" || messengerId === "-") {
    throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak memiliki employeeId kanonikal.");
  }
  const messengerName = user.nama || (user as any).userName || "Messenger";

  const matchesId = (idToCheck?: string) => {
    if (!idToCheck || idToCheck === "Belum Ditugaskan" || idToCheck === "-") return false;
    return idToCheck === messengerId ||
           (user.employeeId && idToCheck === user.employeeId) ||
           (user.userId && idToCheck === user.userId);
  };

  if (taskContext === "SAMSAT") {
    const assignedId = order.samsatMessengerId;
    const acceptance = order.taskAcceptance?.["Proses Samsat"];
    const isAssigned = matchesId(assignedId) || (acceptance?.isLocked && matchesId(acceptance?.courierId));
    if (!isAssigned) {
      if (!assignedId || assignedId === "Belum Ditugaskan") {
        throw new ApiError(403, "FORBIDDEN", `Tugas Samsat pada order '${order.orderNo}' masih berada di pool dan belum diambil. Ambil tugas terlebih dahulu.`);
      }
      throw new ApiError(403, "FORBIDDEN", `Akses ditolak: Tugas Samsat pada order '${order.orderNo}' ditugaskan kepada kurir lain.`);
    }
  } else if (taskContext === "PICKUP") {
    const assignedId = order.assignedMessengerId;
    const acceptance = order.taskAcceptance?.["Jemput Dokumen"];
    const isAssigned = matchesId(assignedId) || (acceptance?.isLocked && matchesId(acceptance?.courierId));
    if (!isAssigned) {
      if (!assignedId || assignedId === "Belum Ditugaskan") {
        throw new ApiError(403, "FORBIDDEN", `Tugas Penjemputan pada order '${order.orderNo}' masih berada di pool dan belum diambil. Ambil tugas terlebih dahulu.`);
      }
      throw new ApiError(403, "FORBIDDEN", `Akses ditolak: Tugas Penjemputan pada order '${order.orderNo}' bukan penugasan aktif Anda.`);
    }
  } else if (taskContext === "DELIVERY") {
    const assignedId = (order as any).deliveryMessengerId;
    const acceptance = order.taskAcceptance?.["Pengantaran Dokumen"];
    const isAssigned = matchesId(assignedId) || (acceptance?.isLocked && matchesId(acceptance?.courierId));
    if (!isAssigned) {
      if (!assignedId || assignedId === "Belum Ditugaskan") {
        throw new ApiError(403, "FORBIDDEN", `Tugas Pengantaran pada order '${order.orderNo}' masih berada di pool dan belum diambil. Ambil tugas terlebih dahulu.`);
      }
      throw new ApiError(403, "FORBIDDEN", `Akses ditolak: Tugas Pengantaran pada order '${order.orderNo}' bukan penugasan aktif Anda.`);
    }
  } else if (taskContext === "SAMSAT_PICKUP") {
    const assignedId = order.samsatPickupMessengerId;
    const acceptance = order.taskAcceptance?.["Jemput Hasil Samsat"];
    const isAssigned = matchesId(assignedId) || (acceptance?.isLocked && matchesId(acceptance?.courierId));
    if (!isAssigned) {
      if (!assignedId || assignedId === "Belum Ditugaskan") {
        throw new ApiError(403, "FORBIDDEN", `Tugas Jemput Hasil Samsat pada order '${order.orderNo}' masih berada di pool dan belum diambil. Ambil tugas terlebih dahulu.`);
      }
      throw new ApiError(403, "FORBIDDEN", `Akses ditolak: Tugas Jemput Hasil Samsat pada order '${order.orderNo}' bukan penugasan aktif Anda.`);
    }
  } else if (taskContext === "ANY") {
    const samsatAcc = order.taskAcceptance?.["Proses Samsat"];
    const pickupAcc = order.taskAcceptance?.["Jemput Dokumen"];
    const deliveryAcc = order.taskAcceptance?.["Pengantaran Dokumen"];
    const samsatPickupAcc = order.taskAcceptance?.["Jemput Hasil Samsat"];

    const isAssigned =
      matchesId(order.samsatMessengerId) ||
      matchesId(order.assignedMessengerId) ||
      matchesId((order as any).deliveryMessengerId) ||
      matchesId(order.samsatPickupMessengerId) ||
      (samsatAcc?.isLocked && matchesId(samsatAcc.courierId)) ||
      (pickupAcc?.isLocked && matchesId(pickupAcc.courierId)) ||
      (deliveryAcc?.isLocked && matchesId(deliveryAcc.courierId)) ||
      (samsatPickupAcc?.isLocked && matchesId(samsatPickupAcc.courierId));

    if (!isAssigned) {
      throw new ApiError(403, "FORBIDDEN", `Akses ditolak: Anda tidak memiliki penugasan aktif pada order '${order.orderNo}'.`);
    }
  }

  return { messengerId, messengerName };
}

/**
 * Ensures messenger callers cannot act on tasks whose acceptance record is PENDING, DECLINED, or SUPERSEDED.
 */
function assertMessengerTaskAcceptanceValid(
  order: OperationalOrder,
  taskType: string,
  user: TokenPayload
): void {
  const role = (user.role || "").toLowerCase();
  if (role !== "messenger") return;
  const acc = (order.taskAcceptance || {})[taskType];
  if (acc?.status === "SUPERSEDED") {
    throw new ApiError(400, "TASK_SUPERSEDED", `Tugas ${taskType} ini sudah tidak berlaku (superseded).`);
  }
  if (acc?.status === "DECLINED" || acc?.status === "PENDING") {
    throw new ApiError(
      403,
      "FORBIDDEN",
      `Tugas ${taskType} pada order '${order.orderNo}' belum diterima. Terima tugas terlebih dahulu.`
    );
  }
}

/**
 * Deep clones order payload non-destructively so caller's original object is never mutated.
 */
function cloneOrderPayload<T>(input: T): T {
  if (input === null || typeof input !== "object") return input;
  if (input instanceof Date) return new Date(input.getTime()) as any;
  if (input instanceof RegExp) return new RegExp(input.source, input.flags) as any;
  if (Array.isArray(input)) return input.map(cloneOrderPayload) as any;
  const copy: any = {};
  for (const key of Object.keys(input as any)) {
    copy[key] = cloneOrderPayload((input as any)[key]);
  }
  return copy;
}

/**
 * Constructs a deterministic canonical representation of the business order payload
 * for stable idempotency hashing.
 */
function buildCanonicalOrderPayload(data: any): Record<string, any> {
  return {
    customer: String(data.customer || "").trim().replace(/\s+/g, " "),
    nomorHP: String(data.nomorHP || "").trim().replace(/[\s\-\.]/g, ""),
    layanan: String(data.layanan || "").trim().toLowerCase().replace(/\s+/g, " "),
    nopol: String(data.nopol || "").trim().toUpperCase().replace(/[\s\-\.]/g, ""),
    wilayahSamsatAsal: String(data.wilayahSamsatAsal || data.samsatAsalId || data.samsat_asal_id || "").trim().toLowerCase(),
    totalEstimasi: Number(data.totalBiaya || data.totalEstimasi || data.payment?.totalBiaya || 0),
  };
}

export class OrderService {
  private orderCounter = 0;
  private idempotencyCache = new Map<string, { order: OperationalOrder; timestamp: number }>();

  constructor() {
    try {
      // 1. Scan ALL orders (including archived) to prevent counter reset
      const activeOrders = dbOrderRepository.getAllFlat(false);
      const archivedOrders = dbOrderRepository.getAllFlat(true);
      const allOrders = [...activeOrders, ...archivedOrders];
      if (allOrders.length > 0) {
        const nums = allOrders
          .map((o) => parseInt(o.orderNo.replace(/\D/g, ""), 10))
          .filter((n) => !isNaN(n));
        if (nums.length > 0) {
          this.orderCounter = Math.max(0, ...nums);
        }
      }

      // 2. Direct atomic SQLite query across all historical rows to guarantee highest sequence
      const row = db
        .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(order_no, 5) AS INTEGER)), 0) AS maxSeq FROM orders")
        .get() as { maxSeq: number } | undefined;
      if (row && typeof row.maxSeq === "number" && row.maxSeq > this.orderCounter) {
        this.orderCounter = row.maxSeq;
      }
    } catch {
      // safe fallback if schema not yet initialized
    }
  }

  public getActiveOrders(): Record<StageName, OperationalOrder[]> {
    return dbOrderRepository.getActiveOrders();
  }

  public getAllFlat(archived = false): OperationalOrder[] {
    return dbOrderRepository.getAllFlat(archived);
  }

  public getOrdersPaginated(options: {
    page?: number;
    pageSize?: number;
    archived?: boolean;
    stage?: string;
    search?: string;
  }) {
    return dbOrderRepository.getOrdersPaginated(options);
  }

  public getByOrderNo(orderNo: string): OperationalOrder {
    const order = dbOrderRepository.getByOrderNo(orderNo);
    if (!order) {
      throw new ApiError(404, "ORDER_NOT_FOUND", `Order dengan nomor '${orderNo}' tidak ditemukan.`);
    }
    return order;
  }

  public createOrder(data: any, user?: TokenPayload | null, idempotencyKey?: string): OperationalOrder {
    return this.createOrderWithIdempotency(data, user, idempotencyKey).order;
  }

  public createOrderWithIdempotency(
    rawInput: any,
    user?: TokenPayload | null,
    idempotencyKey?: string
  ): { order: OperationalOrder; isExisting: boolean } {
    if (!rawInput || typeof rawInput !== "object") {
      throw new ApiError(400, "VALIDATION_ERROR", "Data order wajib berupa objek yang valid.");
    }

    // 1. Non-destructively clone the input data to preserve caller's reference
    const data = cloneOrderPayload(rawInput);

    // 2. Canonicalize incoming fields and resolve alias conflicts FIRST
    normalizeOrderPayload(data);

    const resolvedKey = (idempotencyKey || data.clientRequestId || data.idempotencyKey)?.trim();
    let requestHash = "";

    if (resolvedKey) {
      const canonicalPayload = buildCanonicalOrderPayload(data);
      requestHash = crypto.createHash("sha256").update(JSON.stringify(canonicalPayload)).digest("hex");

      try {
        const scopedKey = formatScopedIdempotencyKey("CREATE_ORDER", resolvedKey);
        // 1. Primary Lookup: Look for new scoped key (CREATE_ORDER::${resolvedKey})
        let getStmt = db.prepare("SELECT key, scope, user_id, request_hash, resource_id, response_json FROM idempotency_keys WHERE key = ?");
        let record = getStmt.get(scopedKey) as { key: string; scope: string; user_id: string | null; request_hash: string; resource_id: string | null; response_json: string } | undefined;

        // 2. Dual-Read Fallback: Look for legacy unprefixed key matching CREATE_ORDER scope
        if (!record) {
          getStmt = db.prepare("SELECT key, scope, user_id, request_hash, resource_id, response_json FROM idempotency_keys WHERE key = ? AND scope = 'CREATE_ORDER'");
          record = getStmt.get(resolvedKey) as any;
        }

        if (record) {
          // Ownership verification
          if (record.user_id !== null && record.user_id !== undefined) {
            if (user?.userId && record.user_id !== user.userId) {
              throw new ApiError(403, "IDEMPOTENCY_USER_MISMATCH", "Idempotency key milik pengguna lain.");
            }
          } else {
            // Historical record with NULL user_id: non-admin callers rejected fail-closed
            const userRole = (user?.role || "").toLowerCase();
            const isAdmin = userRole === "admin" || userRole === "administrator";
            if (!isAdmin) {
              throw new ApiError(403, "IDEMPOTENCY_OWNERSHIP_UNVERIFIABLE", "Kepemilikan record historis tidak dapat diverifikasi; hubungi administrator.");
            }
          }

          if (record.request_hash !== requestHash) {
            throw new ApiError(422, "IDEMPOTENCY_CONFLICT", "Idempotency key sudah digunakan untuk permintaan order dengan data yang berbeda.");
          }
          if (record.resource_id && record.resource_id !== "IN_PROGRESS") {
            const existing = dbOrderRepository.getByOrderNo(record.resource_id);
            if (existing) {
              this.idempotencyCache.set(resolvedKey, { order: existing, timestamp: Date.now() });
              return { order: existing, isExisting: true };
            }
          }
          // If IN_PROGRESS, wait for concurrent request to finish
          if (record.resource_id === "IN_PROGRESS") {
            const startWait = Date.now();
            while (Date.now() - startWait < 3000) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
              const polled = getStmt.get(resolvedKey) as any;
              if (polled && polled.resource_id && polled.resource_id !== "IN_PROGRESS") {
                const existing = dbOrderRepository.getByOrderNo(polled.resource_id);
                if (existing) {
                  this.idempotencyCache.set(resolvedKey, { order: existing, timestamp: Date.now() });
                  return { order: existing, isExisting: true };
                }
              }
            }
          }
        } else {
          // Reserve the key atomically using SQLite PRIMARY KEY constraint
          try {
            const reserveStmt = db.prepare(`
              INSERT INTO idempotency_keys (key, scope, user_id, request_hash, resource_id, response_json, created_at)
              VALUES (?, 'CREATE_ORDER', ?, ?, 'IN_PROGRESS', '{}', datetime('now'))
            `);
            reserveStmt.run(resolvedKey, user?.userId || "usr-system", requestHash);
          } catch (reserveErr: any) {
            // Concurrent race condition: another request inserted between get and insert
            const raced = getStmt.get(resolvedKey) as any;
            if (raced) {
              if (raced.request_hash !== requestHash) {
                throw new ApiError(422, "IDEMPOTENCY_CONFLICT", "Idempotency key sudah digunakan untuk permintaan order dengan data yang berbeda.");
              }
              const startWait = Date.now();
              while (Date.now() - startWait < 3000) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
                const polled = getStmt.get(resolvedKey) as any;
                if (polled && polled.resource_id && polled.resource_id !== "IN_PROGRESS") {
                  const existing = dbOrderRepository.getByOrderNo(polled.resource_id);
                  if (existing) {
                    this.idempotencyCache.set(resolvedKey, { order: existing, timestamp: Date.now() });
                    return { order: existing, isExisting: true };
                  }
                }
              }
            }
          }
        }
      } catch (err: any) {
        if (err instanceof ApiError) throw err;
        // In case idempotency_keys table has any issue, fall back to memory / flat search safely
        if (this.idempotencyCache.has(resolvedKey)) {
          const cached = this.idempotencyCache.get(resolvedKey)!;
          const existing = dbOrderRepository.getByOrderNo(cached.order.orderNo);
          if (existing) return { order: existing, isExisting: true };
        }
      }

      // Backward compatibility fallback for legacy orders without idempotency_keys entry
      const allRecent = dbOrderRepository.getAllFlat(false);
      const legacyExisting = allRecent.find((o) => (o as any).clientRequestId === resolvedKey);
      if (legacyExisting) {
        this.idempotencyCache.set(resolvedKey, { order: legacyExisting, timestamp: Date.now() });
        return { order: legacyExisting, isExisting: true };
      }
    }

    try {
    if (!data.customer || !data.nomorHP || !data.layanan || !data.nopol) {
      throw new ApiError(400, "VALIDATION_ERROR", "Data wajib belum lengkap (customer, nomorHP, layanan, nopol).");
    }

    // Server-side Pricing Sanity & Anti-Tampering Guard
    const pricingSanity = validateOrderPricingSanity(data);
    if (!pricingSanity.isValid) {
      throw new ApiError(
        400,
        pricingSanity.errorCode || "VALIDATION_ERROR",
        pricingSanity.errorMessage || "Kalkulasi harga order tidak valid atau terindikasi manipulasi."
      );
    }

    const resolvedTanggalBerkas = (data as any).tanggalMasukBerkas || (data as any).tanggal_masuk_berkas || undefined;
    const nowStr = new Date().toISOString();

    const parsePeriodMMYY = (dateVal?: string): string => {
      if (!dateVal) {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const yy = String(d.getFullYear()).slice(-2);
        return `${mm}${yy}`;
      }
      const iso = dateVal.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (iso) {
        const yy = iso[1].slice(-2);
        const mm = iso[2].padStart(2, "0");
        return `${mm}${yy}`;
      }
      const slash = dateVal.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (slash) {
        const mm = slash[2].padStart(2, "0");
        const yy = slash[3].slice(-2);
        return `${mm}${yy}`;
      }
      const d = new Date(dateVal);
      if (!isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const yy = String(d.getFullYear()).slice(-2);
        return `${mm}${yy}`;
      }
      const dNow = new Date();
      return `${String(dNow.getMonth() + 1).padStart(2, "0")}${String(dNow.getFullYear()).slice(-2)}`;
    };

    const targetMMYY = parsePeriodMMYY(resolvedTanggalBerkas || nowStr);

    // BD-FIN-03: Strip & Ignore client-provided invoice numbers
    if (data.noInvoice !== undefined || (data.payment && (data.payment as any).invoiceNo !== undefined)) {
      console.warn(`[SSoT INVOICE] Client-provided invoice number ignored. Authoritative backend number will be generated.`);
    }

    let orderNo = (data.orderNo || "").trim();
    const orderPattern = new RegExp(`^ORD-${targetMMYY}-\\d+$`);
    let isTaken = false;
    if (orderNo && orderPattern.test(orderNo)) {
      try {
        const existing = db.prepare("SELECT 1 FROM orders WHERE order_no = ?").get(orderNo);
        if (existing) isTaken = true;
      } catch {
        // safe fallback
      }
    }
    if (isTaken && (data as any).rejectDuplicateOrder) {
      throw new ApiError(409, "DUPLICATE_RECORD", `Nomor order '${orderNo}' sudah terdaftar.`);
    }

    // Preliminary tentative numbering for pre-transaction structure assembly
    let preliminaryOrderNo = orderNo;
    if (!preliminaryOrderNo || !orderPattern.test(preliminaryOrderNo) || isTaken) {
      let maxSeq = 0;
      try {
        const orderRows = db.prepare("SELECT order_no FROM orders WHERE order_no GLOB ?").all(`ORD-${targetMMYY}-*`) as { order_no: string }[];
        for (const r of orderRows) {
          const m = r.order_no.match(new RegExp(`^ORD-${targetMMYY}-(\\d+)$`));
          if (m) {
            const seq = parseInt(m[1], 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
          }
        }
      } catch {}
      preliminaryOrderNo = `ORD-${targetMMYY}-${String(maxSeq + 1).padStart(3, "0")}`;
    }

    const preliminaryParts = preliminaryOrderNo.split("-");
    const preliminarySuffix = preliminaryParts.length >= 3 ? preliminaryParts[2] : "001";
    const matchingInvoiceNo = `INV-${targetMMYY}-${preliminarySuffix}`;
    let resolvedNoInvoice = matchingInvoiceNo;

    const resolvedMetodeLayanan = data.metodeLayanan || data.costSnapshot?.metodeLayanan || "Antar Jemput";
    const isDatangLangsung = resolvedMetodeLayanan === "Datang Langsung";
    const initialStep = isDatangLangsung ? 3 : 1;
    const initialStageName: StageName = isDatangLangsung ? "Verifikasi Dokumen" : "Verifikasi";

    const resolvedStatusPengerjaan = data.salesSnapshotStatus || data.statusPengerjaan;

    // Service Validation & Canonical Resolution (Phase B)
    const rawServiceId = (data as any).service_id || (data as any).serviceId;
    let masterService: ServiceEntity | undefined = undefined;

    if (rawServiceId && String(rawServiceId).trim()) {
      const cleanId = String(rawServiceId).trim();
      masterService = serviceRepository.getById(cleanId);
      if (!masterService) {
        throw new ApiError(400, "INVALID_SERVICE", `Layanan dengan ID '${cleanId}' tidak ditemukan di database.`);
      }
      if (Number(masterService.status_aktif) !== 1) {
        throw new ApiError(400, "SERVICE_INACTIVE", `Layanan '${masterService.nama_layanan}' sedang nonaktif dan tidak dapat digunakan untuk order baru.`);
      }
    } else {
      const resolvedSvc = resolveServiceIdentity(null, data.layanan);
      if (resolvedSvc.serviceId) {
        masterService = serviceRepository.getById(resolvedSvc.serviceId);
      }
      if (!masterService && data.layanan) {
        masterService = serviceRepository.getByKode(data.layanan) ||
          serviceRepository.getAll().find((s) => s.nama_layanan.toLowerCase() === String(data.layanan).toLowerCase());
      }
    }

    const resolvedLayanan = masterService ? masterService.nama_layanan : (data.layanan || "Layanan Standar");
    const resolvedServiceId = masterService ? masterService.id : (rawServiceId || null);

    // Samsat Asal Validation & Canonical Resolution (Phase C)
    const rawSamsatAsalId = (data as any).samsat_asal_id || (data as any).samsatAsalId;
    let resolvedSamsatAsalId: string | null = null;
    let resolvedSamsatAsal: string = (data as any).samsat_asal || (data as any).samsatAsal || data.wilayahSamsatAsal || "Jakarta Timur";

    if (rawSamsatAsalId && String(rawSamsatAsalId).trim()) {
      const cleanAsalId = String(rawSamsatAsalId).trim();
      const officeAsal = dbWilayahRepository.getSamsatOfficeById(cleanAsalId);
      if (!officeAsal) {
        throw new ApiError(400, "INVALID_SAMSAT", `Samsat Asal dengan ID '${cleanAsalId}' tidak ditemukan di database.`);
      }
      if (Number(officeAsal.status_aktif) === 0) {
        throw new ApiError(400, "SAMSAT_INACTIVE", `Samsat Asal '${officeAsal.name}' sedang nonaktif.`);
      }
      resolvedSamsatAsalId = officeAsal.id;
      resolvedSamsatAsal = officeAsal.wilayah || officeAsal.name;
    } else if (resolvedSamsatAsal) {
      const allOffices = dbWilayahRepository.getAllSamsatOffices();
      const matched = allOffices.find(
        (o) => o.wilayah.toLowerCase() === resolvedSamsatAsal.toLowerCase() || o.name.toLowerCase() === resolvedSamsatAsal.toLowerCase()
      );
      if (matched) {
        resolvedSamsatAsalId = matched.id;
      }
    }

    // Samsat Tujuan Validation & Canonical Resolution (Phase C)
    const requiresSamsatTujuan = masterService
      ? Number(masterService.memerlukan_samsat_tujuan) === 1
      : resolvedLayanan.toLowerCase().includes("mutasi");

    const rawSamsatTujuanId = (data as any).samsat_tujuan_id || (data as any).samsatTujuanId;
    let resolvedSamsatTujuanId: string = "-";
    let resolvedSamsatTujuan: string = (data as any).samsat_tujuan || (data as any).samsatTujuan || data.wilayahSamsatTujuan || "-";

    if (requiresSamsatTujuan) {
      if (rawSamsatTujuanId && rawSamsatTujuanId !== "-") {
        const cleanTujuanId = String(rawSamsatTujuanId).trim();
        const officeTujuan = dbWilayahRepository.getSamsatOfficeById(cleanTujuanId);
        if (!officeTujuan) {
          throw new ApiError(400, "INVALID_SAMSAT", `Samsat Tujuan dengan ID '${cleanTujuanId}' tidak ditemukan di database.`);
        }
        if (Number(officeTujuan.status_aktif) === 0) {
          throw new ApiError(400, "SAMSAT_INACTIVE", `Samsat Tujuan '${officeTujuan.name}' sedang nonaktif.`);
        }
        resolvedSamsatTujuanId = officeTujuan.id;
        resolvedSamsatTujuan = officeTujuan.wilayah || officeTujuan.name;
      } else if (resolvedSamsatTujuan && resolvedSamsatTujuan !== "-") {
        const allOffices = dbWilayahRepository.getAllSamsatOffices();
        const matched = allOffices.find(
          (o) => o.wilayah.toLowerCase() === resolvedSamsatTujuan.toLowerCase() || o.name.toLowerCase() === resolvedSamsatTujuan.toLowerCase()
        );
        if (matched) {
          resolvedSamsatTujuanId = matched.id;
        }
      }
    }

    // Payment Method Validation (Phase F)
    const incomingPaymentMethod = data.payment?.metodePembayaran || data.metodePembayaran;
    if (incomingPaymentMethod && typeof incomingPaymentMethod === "string") {
      const cleanPm = incomingPaymentMethod.trim();
      const isCashOrDeferred = cleanPm === "Tunai" || cleanPm === "Cash" || cleanPm.includes("Cash") || cleanPm.includes("Bayar di Akhir");
      if (!isCashOrDeferred) {
        const activePms = dbPaymentMethodRepository.getActive();
        const pmMatched = activePms.find(
          (m) => m.nama_metode.toLowerCase() === cleanPm.toLowerCase() ||
                 (m.bank && cleanPm.toLowerCase().includes(m.bank.toLowerCase()))
        );
        const allPms = dbPaymentMethodRepository.getAll();
        const inactiveMatch = allPms.find(
          (m) => (m.nama_metode.toLowerCase() === cleanPm.toLowerCase() ||
                 (m.bank && cleanPm.toLowerCase().includes(m.bank.toLowerCase()))) && m.status === "Nonaktif"
        );
        if (inactiveMatch) {
          throw new ApiError(400, "PAYMENT_METHOD_INACTIVE", `Metode pembayaran '${incomingPaymentMethod}' sedang nonaktif.`);
        }
        if (!pmMatched) {
          throw new ApiError(400, "PAYMENT_METHOD_INACTIVE", `Metode pembayaran '${incomingPaymentMethod}' tidak valid atau sedang nonaktif.`);
        }
      }
    }

    let serviceRequirementsSnapshot: ServiceRequirementsSnapshot | undefined = undefined;
    if (masterService) {
      if (typeof (masterService.requirements as any) === "string") {
        try {
          const parsed = JSON.parse(masterService.requirements as any);
          if (!Array.isArray(parsed)) {
            throw new ApiError(500, "MALFORMED_SERVICE_REQUIREMENTS", `Persyaratan dokumen master layanan '${masterService.nama_layanan}' tidak valid.`);
          }
        } catch {
          throw new ApiError(500, "MALFORMED_SERVICE_REQUIREMENTS", `Persyaratan dokumen master layanan '${masterService.nama_layanan}' tidak valid.`);
        }
      }
      serviceRequirementsSnapshot = buildServiceRequirementsSnapshot(masterService, nowStr);
    }

    const newOrder: OperationalOrder = {
      orderNo,
      ...(resolvedKey ? { clientRequestId: resolvedKey } : {}),
      customer: data.customer,
      nomorHP: data.nomorHP,
      layanan: resolvedLayanan,
      serviceId: resolvedServiceId || undefined,
      service_id: resolvedServiceId || undefined,
      tanggalMasukBerkas: resolvedTanggalBerkas,
      tanggal_masuk_berkas: resolvedTanggalBerkas,
      wilayahSamsatAsal: resolvedSamsatAsal,
      samsat_asal: resolvedSamsatAsal,
      wilayahSamsatTujuan: resolvedSamsatTujuan,
      samsat_tujuan: resolvedSamsatTujuan,
      samsatAsalId: resolvedSamsatAsalId || undefined,
      samsat_asal_id: resolvedSamsatAsalId || undefined,
      samsatTujuanId: resolvedSamsatTujuanId,
      samsat_tujuan_id: resolvedSamsatTujuanId,
      metodeLayanan: resolvedMetodeLayanan,
      serviceRequirementsSnapshot,
      currentStep: data.currentStep !== undefined ? data.currentStep : initialStep,
      currentStageName: data.currentStageName || initialStageName,
      pickupCompleted: isDatangLangsung ? true : (data.pickupCompleted ?? false),
      isScheduled: isDatangLangsung ? true : (data.isScheduled ?? false),
      messenger: isDatangLangsung ? "Datang Langsung (Loket)" : (data.messenger || "Belum Ditugaskan"),
      messengerTaskStatus: isDatangLangsung ? "Dokumen Sudah Tersedia" : data.messengerTaskStatus,
      catatanPenjadwalan: isDatangLangsung ? "Klien datang langsung ke loket kantor (Tanpa penjemputan kurir)" : data.catatanPenjadwalan,
      tanggalJemput: isDatangLangsung ? (normalizeToWibCalendarDate(nowStr) || nowStr.split("T")[0]) : data.tanggalJemput,
      catatanOrder: data.catatanOrder || (isDatangLangsung ? "Order Datang Langsung ke Loket (Verifikasi Dokumen Fisik)." : "Order baru dibuat dari API Buat Order."),
      createdAt: normalizeToWibCalendarDate(nowStr) || nowStr.split("T")[0],

      namaPemilik: data.namaPemilik ? String(data.namaPemilik).trim() : "",
      kepemilikanKendaraan: data.statusKepemilikan || data.kepemilikanKendaraan || "Pribadi",
      jenisKendaraan: data.jenisKendaraan || "Mobil",
      tahunKendaraan: data.tahunKendaraan || new Date().getFullYear(),
      nopol: data.nopol,
      pkbBerlakuSd: data.pkbBerlakuSd || "",
      tahunPajak: data.tahunPajak || String(new Date().getFullYear()),
      bulanPajak: data.bulanPajak || "Januari",
      nominalPkbTerakhir: data.nominalPkbTerakhir ?? 0,
      nominalSwdkllj: data.nominalSwdkllj ?? 143000,
      kodePromo: data.kodePromo || "",

      biayaJasa: pricingSanity.resolvedBiayaJasa,
      biayaAntarJemput: Number(data.biayaAntarJemput ?? 0),
      namaPenerimaKeluar: (data.namaPenerimaKeluar || data.namaPemilikRekeningKeluar || "").trim(),
      bankUangKeluar: data.bankUangKeluar || "",
      metodePembayaranKeluar: data.metodePembayaranKeluar || "",
      tanggalPengeluaranSamsat: data.tanggalPengeluaranSamsat || data.tanggalUangKeluar || "",
      tanggalUangMasuk: (data as any).tanggalUangMasuk || "",

      ...(resolvedStatusPengerjaan ? { salesSnapshotStatus: resolvedStatusPengerjaan, statusPengerjaan: resolvedStatusPengerjaan } : {}),
      ...(resolvedNoInvoice !== undefined ? { noInvoice: resolvedNoInvoice } : {}),
      ...(data.tandaTerima !== undefined ? { tandaTerima: data.tandaTerima } : {}),
      ...(data.ttbBPKB !== undefined ? { ttbBPKB: data.ttbBPKB } : {}),
      ...(data.statusBPKB !== undefined ? { statusBPKB: data.statusBPKB } : {}),
      ...(data.bpkb !== undefined ? { bpkb: data.bpkb } : {}),
      ...(data.isArchived !== undefined ? { isArchived: data.isArchived } : {}),

      alamatPenjemputan: data.alamatPenjemputan || {
        kota: data.wilayahSamsatAsal || "Jakarta Timur",
        kecamatan: "",
        kelurahan: "",
        detail: "Alamat penjemputan belum diisi",
        rtRw: "",
        nomor: "",
        landmark: "",
      },
      alamatPengantaran: data.alamatPengantaran || {
        kota: data.wilayahSamsatAsal || "Jakarta Timur",
        kecamatan: "",
        kelurahan: "",
        detail: "Alamat pengantaran belum diisi",
        rtRw: "",
        nomor: "",
        landmark: "",
      },

      clientDocuments: data.clientDocuments || {
        stnkAsli: false,
        bpkbAsli: false,
        ktpAsli: false,
        suratKuasa: false,
        faktur: false,
      },

      samsatProcesses: data.samsatProcesses && data.samsatProcesses.length > 0
        ? data.samsatProcesses
        : (data.costBreakdown || data.costSnapshot?.breakdown || [])
            .filter((item: any) => item.category === "Komponen Samsat" || item.source === "KomponenSamsat")
            .map((item: any, idx: number) => ({
              id: item.itemId || `comp-${idx}`,
              name: item.name,
              category: "Komponen Samsat",
              status: "Belum Diproses",
              basePrice: item.amount || 0,
              actualCost: item.amount || 0,
            })),

      payment: {
        ...(data.payment || {}),
        tipePembayaran: data.payment?.tipePembayaran || data.tipePembayaran || "Bayar di Akhir",
        metodePembayaran: data.payment?.metodePembayaran || data.metodePembayaran || "Transfer Bank",
        totalBiaya: pricingSanity.resolvedTotalBiaya,
        dibayar: data.payment?.dibayar ?? 0,
        kurang: Math.max(0, pricingSanity.resolvedTotalBiaya - Number(data.payment?.dibayar ?? 0)),
        statusPembayaran: data.payment?.statusPembayaran || "Belum Lunas",
        isPaymentVerified: data.payment?.isPaymentVerified ?? false,
        invoiceNo: resolvedNoInvoice !== undefined ? resolvedNoInvoice : `INV-${orderNo}`,
      },

      rekapDocuments: [],
      costSnapshot: data.costSnapshot,
      costBreakdown: data.costBreakdown,
      estimationResult: data.estimationResult,
    };

    // Phase 4B Batch 2B Step B & Final Snapshot: Canonical Payment Identity & Frozen Snapshot for initial downpayment (Path 1)
    const existingRecords = newOrder.payment?.paymentRecords as any[] | undefined;
    const hasExistingRecords = Array.isArray(existingRecords) && existingRecords.length > 0;
    const hasInitialDownpayment =
      (Number(newOrder.payment?.nominalDibayarAwal) > 0 || Number(newOrder.payment?.dibayar) > 0) &&
      (newOrder.payment?.tipePembayaran === "Bayar di Awal");

    if (hasExistingRecords || hasInitialDownpayment) {
      const canonicalPaymentId = generateCanonicalPaymentId();
      const initialNominal = hasExistingRecords
        ? Number(existingRecords[0].nominal || newOrder.payment?.dibayar || 0)
        : Number(newOrder.payment?.nominalDibayarAwal || newOrder.payment?.dibayar);

      // Section 1: Resolve Master Payment Method & Construct Frozen Snapshot AT ORDER CREATION TIME
      const inputPmId =
        (existingRecords?.[0] as any)?.paymentMethodId ||
        (existingRecords?.[0] as any)?.payment_method_id ||
        (existingRecords?.[0] as any)?.metode_pembayaran_id ||
        (newOrder.payment as any)?.paymentMethodId ||
        (newOrder.payment as any)?.payment_method_id ||
        (newOrder.payment as any)?.metode_pembayaran_id ||
        (data.payment as any)?.paymentMethodId ||
        (data as any)?.paymentMethodId ||
        null;

      const rawMethodName =
        (existingRecords?.[0] as any)?.metodePembayaran ||
        newOrder.payment?.metodePembayaran ||
        (data.payment as any)?.metodePembayaran ||
        (data as any)?.metodePembayaran ||
        "Transfer Bank";

      let pmRow: any = null;
      if (inputPmId) {
        pmRow = db.prepare("SELECT * FROM payment_methods WHERE id = ?").get(String(inputPmId).trim());
        if (!pmRow) {
          throw new ApiError(400, "INVALID_PAYMENT_METHOD", `Metode pembayaran dengan ID '${inputPmId}' tidak ditemukan.`);
        }
      } else if (rawMethodName) {
        pmRow = db.prepare("SELECT * FROM payment_methods WHERE LOWER(nama_metode) = LOWER(?)").get(String(rawMethodName).trim());
      }

      if (pmRow) {
        const normStatus = String(pmRow.status || "").trim().toLowerCase();
        if (normStatus !== "aktif") {
          throw new ApiError(400, "INVALID_PAYMENT_METHOD", `Metode pembayaran '${pmRow.nama_metode}' tidak aktif.`);
        }
      } else {
        pmRow = db.prepare("SELECT * FROM payment_methods WHERE status = 'Aktif' LIMIT 1").get();
      }

      let frozenSnapshotJson = null;
      let effectivePmId = null;

      if (pmRow) {
        effectivePmId = pmRow.id;
        const isBank = (pmRow.bank && String(pmRow.bank).trim() !== "") || /transfer|bank|bca|mandiri|bni|bri/i.test(pmRow.nama_metode);
        frozenSnapshotJson = JSON.stringify({
          id: pmRow.id,
          nama_metode: pmRow.nama_metode,
          tipe: isBank ? "BANK" : "CASH",
          bank: pmRow.bank || null,
          nomor_rekening: pmRow.nomor_rekening || null,
          nama_rekening: pmRow.nama_rekening || null,
          frozen_at: nowStr,
        });
      }

      const existingRecord0: Record<string, any> = hasExistingRecords ? existingRecords[0] : {};
      const consolidatedRecord = {
        ...existingRecord0,
        id: canonicalPaymentId,
        payment_id: canonicalPaymentId,
        paymentId: canonicalPaymentId,
        nominal: initialNominal,
        tanggal: existingRecord0.tanggal || nowStr,
        metodePembayaran: pmRow ? pmRow.nama_metode : (existingRecord0.metodePembayaran || rawMethodName),
        namaBank: pmRow ? (pmRow.bank || "") : (existingRecord0.namaBank || (newOrder.payment as any)?.namaBank || ""),
        nomorRekening: pmRow ? (pmRow.nomor_rekening || "") : (existingRecord0.noRekening || (newOrder.payment as any)?.noRekening || ""),
        namaRekening: pmRow ? (pmRow.nama_rekening || "") : (existingRecord0.namaRekening || (newOrder.payment as any)?.namaRekening || ""),
        statusVerifikasi: newOrder.payment?.isPaymentVerified ? "TERVERIFIKASI" : (existingRecord0.statusVerifikasi || "MENUNGGU_VERIFIKASI"),
        uploadedBy: user?.nama || "Admin Super (SVP)",
        payment_method_id: effectivePmId,
        paymentMethodId: effectivePmId,
        metode_pembayaran_id: effectivePmId,
        payment_method_snapshot: frozenSnapshotJson,
        paymentMethodSnapshot: frozenSnapshotJson,
      };

      if (!newOrder.payment) {
        newOrder.payment = {} as any;
      }
      if (hasExistingRecords && existingRecords) {
        existingRecords[0] = consolidatedRecord;
      } else {
        newOrder.payment.paymentRecords = [consolidatedRecord as any];
      }

      (newOrder.payment as any).paymentMethodId = effectivePmId;
      (newOrder.payment as any).paymentMethodSnapshot = frozenSnapshotJson;
    }

    const result = runInTransaction(() => {
      // SSoT & In-Transaction Monotonic Sequence Determination (BEGIN IMMEDIATE lock held)
      const orderPrefix = `ORD-${targetMMYY}-`;
      const invoicePrefix = `INV-${targetMMYY}-`;
      const orderRegex = new RegExp(`^ORD-${targetMMYY}-(\\d+)$`);
      const invoiceRegex = new RegExp(`^INV-${targetMMYY}-(\\d+)$`);

      let maxSeq = 0;
      try {
        const orderRows = db.prepare("SELECT order_no FROM orders WHERE order_no GLOB ?").all(`${orderPrefix}*`) as { order_no: string }[];
        for (const r of orderRows) {
          const m = r.order_no.match(orderRegex);
          if (m) {
            const seq = parseInt(m[1], 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
          } else {
            console.warn(`[SEQUENCE_ANOMALY] Non-standard order number format: ${r.order_no}`);
          }
        }
        const invoiceRows = db.prepare("SELECT invoice_no FROM finance_invoices WHERE invoice_no GLOB ?").all(`${invoicePrefix}*`) as { invoice_no: string }[];
        for (const r of invoiceRows) {
          const m = r.invoice_no.match(invoiceRegex);
          if (m) {
            const seq = parseInt(m[1], 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
          } else {
            console.warn(`[SEQUENCE_ANOMALY] Non-standard invoice number format: ${r.invoice_no}`);
          }
        }
      } catch (scanErr) {
        console.warn(`[SEQUENCE_SCAN_ERROR] Error scanning sequences:`, scanErr);
      }

      let finalOrderNo = (data.orderNo || "").trim();
      let isFinalTaken = false;
      if (finalOrderNo && orderRegex.test(finalOrderNo)) {
        try {
          const existing = db.prepare("SELECT 1 FROM orders WHERE order_no = ?").get(finalOrderNo);
          if (existing) isFinalTaken = true;
        } catch {}
      }
      if (isFinalTaken && (data as any).rejectDuplicateOrder) {
        throw new ApiError(409, "DUPLICATE_RECORD", `Nomor order '${finalOrderNo}' sudah terdaftar.`);
      }

      if (!finalOrderNo || !orderRegex.test(finalOrderNo) || isFinalTaken) {
        const nextSeq = maxSeq + 1;
        finalOrderNo = `${orderPrefix}${String(nextSeq).padStart(3, "0")}`;
      }

      const orderParts = finalOrderNo.split("-");
      const seqSuffix = orderParts.length >= 3 ? orderParts[2] : String(maxSeq + 1).padStart(3, "0");
      const authoritativeInvoiceNo = `${invoicePrefix}${seqSuffix}`;

      // Update newOrder identifiers synchronously under transaction lock
      newOrder.orderNo = finalOrderNo;
      newOrder.noInvoice = authoritativeInvoiceNo;
      if (newOrder.payment) {
        (newOrder.payment as any).invoiceNo = authoritativeInvoiceNo;
      }
      if (newOrder.payment?.paymentRecords?.[0]) {
        (newOrder.payment.paymentRecords[0] as any).orderNo = finalOrderNo;
        (newOrder.payment.paymentRecords[0] as any).invoiceNo = authoritativeInvoiceNo;
      }

      dbOrderRepository.saveOrder(newOrder);
      const persistedOrder = dbOrderRepository.getByOrderNo(finalOrderNo) || newOrder;
      const isPartialEstimateOrder =
        persistedOrder.costCompletenessStatus === "PARTIAL_ESTIMATE" ||
        persistedOrder.isCostVerified === false;

      // Save initial invoice to finance (unverified Bayar di Awal MUST NOT count as paid cash or realized profit)
      const rawInitialPaid = persistedOrder.payment.dibayar || 0;
      const isInitialPaymentVerified = Boolean(persistedOrder.payment.isPaymentVerified);
      const initialVerifiedPaid = isInitialPaymentVerified ? rawInitialPaid : 0;
      const totalTagihan = persistedOrder.payment.totalBiaya;
      const isLunas = initialVerifiedPaid >= totalTagihan && totalTagihan > 0;
      const isExplicitZeroOrder = Boolean(
        (data as any).isExplicitZero ||
        (data as any).costSnapshot?.isExplicitZero ||
        (persistedOrder as any).isExplicitZero
      );
      dbFinanceRepository.saveInvoice({
        invoiceNo: authoritativeInvoiceNo,
        orderNo: finalOrderNo,
        service_id: resolvedServiceId || undefined,
        serviceId: resolvedServiceId || undefined,
        customer: persistedOrder.customer,
        layanan: persistedOrder.layanan,
        nopol: persistedOrder.nopol,
        metodePembayaran: persistedOrder.payment.metodePembayaran,
        bank: (persistedOrder.payment as any).bank || (persistedOrder.payment as any).namaBank || "",
        status: isLunas ? "PAID" : initialVerifiedPaid > 0 ? "PARTIAL" : "UNPAID",
        totalTagihan,
        dibayar: initialVerifiedPaid,
        sisa: Math.max(0, totalTagihan - initialVerifiedPaid),
        biayaSamsat: pricingSanity.resolvedBiayaSamsat,
        pendapatanJasa: Number(pricingSanity.resolvedBiayaJasa || Math.max(0, totalTagihan - pricingSanity.resolvedBiayaSamsat)),
        biayaJasa: pricingSanity.resolvedBiayaJasa,
        biayaAntarJemput: Number(data.biayaAntarJemput ?? 0),
        namaPenerimaKeluar: (data.namaPenerimaKeluar || data.namaPemilikRekeningKeluar || "").trim(),
        jatuhTempo: normalizeToWibCalendarDate(new Date(Date.now() + 7 * 86400000)) || new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0],
        tanggalInvoice: resolvedTanggalBerkas || normalizeToWibCalendarDate(nowStr) || nowStr.split("T")[0],
        overpayment: Math.max(0, initialVerifiedPaid - totalTagihan),
        refundStatus: initialVerifiedPaid > totalTagihan ? "PENDING" : "NONE",
        profit: initialVerifiedPaid > 0
          ? Math.max(0, Math.min(initialVerifiedPaid, totalTagihan) - pricingSanity.resolvedBiayaSamsat - Number((data as any).biayaLainnya || 0))
          : 0,
        isExplicitZero: isExplicitZeroOrder,
        costVerificationStatus: isExplicitZeroOrder
          ? "DEFINITIVE"
          : (isPartialEstimateOrder ? "PENDING_VERIFICATION" : "VERIFIED"),
        isDraftEstimate: isPartialEstimateOrder,
        isCostVerified: Boolean(persistedOrder.isCostVerified),
        costCompletenessStatus: persistedOrder.costCompletenessStatus,
      } as any);

      // Audit Log
      dbAuditRepository.save({
        id: `log-ord-create-${Date.now()}`,
        userId: user?.userId || "usr-system",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: "CREATE",
        module: "Order",
        details: `Membuat order baru ${finalOrderNo} (${newOrder.customer} - ${newOrder.layanan})`,
        metadata: { orderNo: finalOrderNo, customer: newOrder.customer, nopol: newOrder.nopol },
        createdAt: nowStr,
      });

      if (resolvedKey) {
        try {
          const scopedKey = formatScopedIdempotencyKey("CREATE_ORDER", resolvedKey);
          const updateStmt = db.prepare(`
            UPDATE idempotency_keys
            SET resource_id = ?, response_json = ?
            WHERE key = ? AND scope = 'CREATE_ORDER'
          `);
          updateStmt.run(
            newOrder.orderNo,
            JSON.stringify({ orderNo: newOrder.orderNo, noInvoice: newOrder.noInvoice, customer: newOrder.customer }),
            resolvedKey
          );
          if (scopedKey !== resolvedKey) {
            db.prepare(`
              INSERT OR IGNORE INTO idempotency_keys (key, scope, user_id, request_hash, resource_id, response_json, created_at)
              VALUES (?, 'CREATE_ORDER', ?, ?, ?, ?, datetime('now'))
            `).run(
              scopedKey,
              user?.userId || "usr-system",
              requestHash,
              newOrder.orderNo,
              JSON.stringify({ orderNo: newOrder.orderNo, noInvoice: newOrder.noInvoice, customer: newOrder.customer })
            );
          }
        } catch {}
        this.idempotencyCache.set(resolvedKey, { order: persistedOrder, timestamp: Date.now() });
      }

      this.linkOrderDocuments(persistedOrder);

      return { order: persistedOrder, isExisting: false };
    });

    if (!result.isExisting) {
      this.linkOrderDocuments(result.order);
      this.triggerOrderNotification(result.order, "ORDER_CREATE");
    }

    return result;
    } catch (createErr: any) {
      if (resolvedKey) {
        try {
          const deleteReservation = db.prepare(`
            DELETE FROM idempotency_keys
            WHERE key = ? AND scope = 'CREATE_ORDER' AND resource_id = 'IN_PROGRESS'
          `);
          deleteReservation.run(resolvedKey);
        } catch {}
      }
      if (createErr && (createErr.code === "SQLITE_BUSY" || createErr.errcode === 5 || String(createErr.message).includes("database is locked") || String(createErr.message).includes("SQLITE_BUSY"))) {
        throw new ApiError(503, "SERVICE_UNAVAILABLE", "Sistem sedang sibuk memproses transaksi lain. Silakan coba beberapa saat lagi.");
      }
      throw createErr;
    }
  }

  private triggerOrderNotification(order: OperationalOrder, eventType: "ORDER_CREATE" | "ORDER_UPDATE", extraDetail?: string): void {
    try {
      const settings = dbNotificationSettingsRepository.getSettings();
      if (!settings.notifyOrderUpdate) return;

      const smtp = notificationConfigService.getSmtpStatus();
      const recipients = settings.recipientEmails && settings.recipientEmails.length > 0
        ? settings.recipientEmails
        : ["admin@sunbirojasa.com"];

      for (const recipient of recipients) {
        if (!smtp.isConfigured) {
          dbNotificationSettingsRepository.addLog({
            type: eventType,
            recipient,
            title: eventType === "ORDER_CREATE"
              ? `Notifikasi Order Baru: ${order.orderNo} (${order.customer} - ${order.nopol})`
              : `Update Status Order: ${order.orderNo} (${extraDetail || order.currentStageName || 'Diproses'})`,
            referenceNo: order.orderNo,
            status: "GAGAL",
            errorMessage: "Layanan SMTP pengirim belum dikonfigurasi di server backend (.env). Pengiriman notifikasi email order ditangguhkan.",
          });
        } else {
          dbNotificationSettingsRepository.addLog({
            type: eventType,
            recipient,
            title: eventType === "ORDER_CREATE"
              ? `Notifikasi Order Baru: ${order.orderNo} (${order.customer} - ${order.nopol})`
              : `Update Status Order: ${order.orderNo} (${extraDetail || order.currentStageName || 'Diproses'})`,
            referenceNo: order.orderNo,
            status: "BERHASIL",
            errorMessage: null,
          });
        }
      }
    } catch (notifErr) {
      console.warn("[OrderService] Warning triggering order notification:", notifErr);
    }
  }

  public updateOrder(orderNo: string, updates: Partial<OperationalOrder>, user?: TokenPayload | null): OperationalOrder {
    const existing = this.getByOrderNo(orderNo);

    // Protected Snapshot Immutability Guard (Patch D): Never allow overwriting existing snapshot
    delete (updates as any).serviceRequirementsSnapshot;
    delete (updates as any).service_requirements_snapshot;
    delete (updates as any).requirementsSnapshot;
    delete (updates as any).requirements_snapshot;

    // Role field scoping & Canonical Identity Enforcement (Phase 2.1, 3.1 & 4)
    if (user && user.role === "messenger") {
      const allowedMessengerFields = new Set([
        // Task timing & completion
        "startedAt", "completedAt",
        "messengerTaskStatus",

        // Pickup (Stage 2)
        "pickupChecklist", "pickupProof", "pickupCompleted", "pickupCompletedAt",
        "checklistSebelumBerangkat", "tanggalJemput",

        // Samsat (Stage 4)
        "tanggalProsesSamsat",
        "samsatJourneyStartedAt", "samsatArrivedAt", "samsatCompletedAt",
        "samsatStatus", "samsatSubstatus", "samsatProcesses", "currentSamsatProcess",
        "additionalProcesses", "samsatPickupStatus",
        "samsatPickupStartedAt", "samsatPickupCompletedAt", "samsatResultProof",
        "messengerComponentProgress", "customCostItems",

        // Delivery (Stage 7)
        "tanggalPengantaran",
        "deliveryStartedAt", "deliveryStatus", "deliveryHandover",
        "deliveryProof", "receiverName", "tanggalDiterima", "isReceived",

        // Timeline & Multi-Stage Execution (ownership/acceptance MUST go through dedicated task endpoints)
        "messengerTimeline", "samsatStageExecutions",
        "estimasiSelesaiOrder", "tanggalSelesaiAktualOrder"
      ]);

      const adminInstructionFields = new Set([
        "catatanOrder", "catatan_order",
        "catatanPenjadwalan", "catatan_penjadwalan",
        "catatanSamsat", "catatan_samsat",
        "catatanPengantaran", "catatan_pengantaran"
      ]);

      const messengerNoteFields = new Set([
        "messengerTaskNotes", "messenger_task_notes",
        "samsatPickupNotes", "samsat_pickup_notes",
        "catatanKendala", "catatan_kendala",
        "catatanPenyerahan", "catatan_penyerahan",
        "note", "notes", "reason", "catatan"
      ]);

      for (const k of Object.keys(updates)) {
        if (adminInstructionFields.has(k)) {
          throw new ApiError(403, "FORBIDDEN", `Messenger tidak memiliki wewenang untuk mengubah field instruksi Admin '${k}'.`);
        }
        if (messengerNoteFields.has(k)) {
          throw new ApiError(403, "FORBIDDEN", `Messenger tidak diizinkan mengubah catatan operasional bebas '${k}'.`);
        }
        const isMutasiBreakdown = k.startsWith("mutasiKeluar") || k.startsWith("mutasiMasuk");
        if (!allowedMessengerFields.has(k) && !isMutasiBreakdown) {
          throw new ApiError(403, "FORBIDDEN", `Messenger tidak memiliki wewenang untuk mengubah field '${k}'.`);
        }
      }

      // Defense in depth: Check nested objects against free-text notes injection
      if (updates.pickupProof && typeof updates.pickupProof === "object") {
        const pp = updates.pickupProof as any;
        if (
          (pp.notes && typeof pp.notes === "string" && pp.notes.trim()) ||
          (pp.catatanKendala && typeof pp.catatanKendala === "string" && pp.catatanKendala.trim()) ||
          (pp.note && typeof pp.note === "string" && pp.note.trim()) ||
          (pp.catatan && typeof pp.catatan === "string" && pp.catatan.trim())
        ) {
          throw new ApiError(403, "FORBIDDEN", "Messenger tidak diizinkan mengubah catatan operasional bebas pada pickupProof.");
        }
      }
      if (updates.deliveryHandover && typeof updates.deliveryHandover === "object") {
        const dh = updates.deliveryHandover as any;
        if (
          (dh.notes && typeof dh.notes === "string" && dh.notes.trim()) ||
          (dh.note && typeof dh.note === "string" && dh.note.trim()) ||
          (dh.catatan && typeof dh.catatan === "string" && dh.catatan.trim())
        ) {
          throw new ApiError(403, "FORBIDDEN", "Messenger tidak diizinkan mengubah catatan operasional bebas pada deliveryHandover.");
        }
      }
      if (updates.deliveryProof && typeof updates.deliveryProof === "object") {
        const dp = updates.deliveryProof as any;
        if (
          (dp.notes && typeof dp.notes === "string" && dp.notes.trim()) ||
          (dp.note && typeof dp.note === "string" && dp.note.trim()) ||
          (dp.catatan && typeof dp.catatan === "string" && dp.catatan.trim())
        ) {
          throw new ApiError(403, "FORBIDDEN", "Messenger tidak diizinkan mengubah catatan operasional bebas pada deliveryProof.");
        }
      }
      if (updates.messengerComponentProgress && typeof updates.messengerComponentProgress === "object") {
        for (const [compKey, compVal] of Object.entries(updates.messengerComponentProgress)) {
          if (compVal && typeof compVal === "object" && (compVal as any).note && typeof (compVal as any).note === "string" && (compVal as any).note.trim()) {
            throw new ApiError(403, "FORBIDDEN", `Messenger tidak diizinkan mengisi catatan operasional bebas pada komponen Samsat '${compKey}'.`);
          }
        }
      }
      if (Array.isArray(updates.additionalProcesses)) {
        for (const proc of updates.additionalProcesses) {
          if (proc && typeof proc === "object" && proc.note && typeof proc.note === "string" && proc.note.trim()) {
            throw new ApiError(403, "FORBIDDEN", "Messenger tidak diizinkan mengisi catatan operasional bebas pada proses tambahan.");
          }
        }
      }

      // Canonical Messenger Identity Check (DEFECT-P2-02, Phase 3.1)
      const messengerId = (user as any).employeeId;
      if (!messengerId || messengerId === "EMP-MSG" || messengerId === "EMP-SAMSAT" || messengerId === "Belum Ditugaskan" || messengerId === "-") {
        throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak memiliki employeeId kanonikal.");
      }

      // Check if order is cancelled
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }

      // Check Pickup-specific mutation authorization
      const hasPickupFields = Object.keys(updates).some(
        (k) =>
          k === "pickupChecklist" ||
          k === "pickupProof" ||
          k === "pickupCompleted" ||
          k === "pickupCompletedAt" ||
          k === "checklistSebelumBerangkat" ||
          (k === "messengerTaskStatus" && (existing.currentStep === 2 || existing.currentStageName === "Penjadwalan"))
      );

      // Check Samsat-specific mutation authorization
      const hasSamsatFields = Object.keys(updates).some(
        (k) =>
          k === "samsatProcesses" ||
          k === "messengerComponentProgress" ||
          k === "customCostItems" ||
          k === "samsatStatus" ||
          k === "samsatSubstatus" ||
          k === "currentSamsatProcess" ||
          k === "additionalProcesses" ||
          k.startsWith("mutasiKeluar") ||
          k.startsWith("mutasiMasuk")
      );

      // Check Samsat-Pickup (Jemput Hasil) mutation authorization
      const hasSamsatPickupFields = Object.keys(updates).some(
        (k) =>
          k === "samsatPickupStatus" ||
          k === "samsatPickupStartedAt" ||
          k === "samsatPickupCompletedAt" ||
          k === "samsatResultProof"
      );

      // Check Delivery-specific mutation authorization
      const hasDeliveryFields = Object.keys(updates).some(
        (k) =>
          k === "deliveryStatus" ||
          k === "deliveryHandover" ||
          k === "deliveryProof" ||
          k === "receiverName" ||
          k === "tanggalDiterima" ||
          k === "isReceived" ||
          k === "deliveryStartedAt" ||
          (k === "messengerTaskStatus" && (existing.currentStep === 7 || existing.currentStageName === "Pengantaran"))
      );

      if (hasSamsatFields) {
        assertMessengerOwnership(existing, user, "SAMSAT");
        const isSamsatStarted =
          existing.samsatStatus === "Sedang Proses Samsat" ||
          existing.samsatStatus === "Menuju Samsat" ||
          existing.samsatStatus === "Di Lokasi Samsat" ||
          existing.samsatStatus === "Selesai";
        if (!isSamsatStarted && !updates.samsatStatus && (updates.messengerComponentProgress || updates.samsatProcesses || updates.customCostItems)) {
          throw new ApiError(
            400,
            "SAMSAT_NOT_STARTED",
            `Proses Samsat pada order '${orderNo}' belum dimulai. Tekan 'Mulai Proses' sebelum memperbarui komponen atau progres Samsat.`
          );
        }
      }
      if (hasPickupFields) {
        assertMessengerOwnership(existing, user, "PICKUP");
        const isPickupStarted =
          existing.messengerTaskStatus === "Sedang Dijemput" ||
          existing.messengerTaskStatus === "Dokumen Sudah Tersedia" ||
          existing.pickupCompleted;
        if (!isPickupStarted && !updates.messengerTaskStatus && (updates.pickupChecklist || updates.pickupProof || updates.checklistSebelumBerangkat)) {
          throw new ApiError(
            400,
            "PICKUP_NOT_STARTED",
            `Tugas penjemputan berkas pada order '${orderNo}' belum dimulai. Tekan 'Mulai Tugas' terlebih dahulu sebelum memperbarui checklist atau progres berkas.`
          );
        }
      }
      if (hasDeliveryFields) {
        assertMessengerOwnership(existing, user, "DELIVERY");
        const isDeliveryStarted =
          existing.deliveryStatus === "Sedang Diantar" ||
          existing.deliveryStatus === "Dokumen Diserahkan" ||
          existing.isReceived;
        if (!isDeliveryStarted && !updates.deliveryStartedAt && updates.deliveryStatus !== "Sedang Diantar" && (updates.deliveryHandover || updates.deliveryProof || updates.receiverName)) {
          throw new ApiError(
            400,
            "DELIVERY_NOT_STARTED",
            `Tugas pengantaran berkas pada order '${orderNo}' belum dimulai. Tekan 'Mulai Tugas' terlebih dahulu sebelum memperbarui formulir serah terima.`
          );
        }
      }
      if (hasSamsatPickupFields) {
        assertMessengerOwnership(existing, user, "SAMSAT_PICKUP");
      }
      if (!hasSamsatFields && !hasPickupFields && !hasDeliveryFields && !hasSamsatPickupFields) {
        assertMessengerOwnership(existing, user, "ANY");
      }
    }

    // Defense in Depth: Reject server-controlled and approval-gated fields across all alias variants
    assertNoProtectedFieldViolations(updates, user);

    // Canonicalize update payload and resolve alias conflicts
    normalizeOrderPayload(updates);

    const safeUpdates: Partial<OperationalOrder> = { ...updates };

    // Duplicate Invoice Check (Data Penjualan Mutation Integrity)
    const incomingInvNo = (safeUpdates as any).noInvoice ?? (safeUpdates as any).invoiceNo ?? safeUpdates.payment?.invoiceNo;
    if (incomingInvNo && typeof incomingInvNo === "string" && incomingInvNo.trim()) {
      const cleanInv = incomingInvNo.trim();
      const existingInv = dbFinanceRepository.getInvoiceByNo(cleanInv);
      if (existingInv && existingInv.orderNo !== orderNo) {
        throw new ApiError(409, "DUPLICATE_RECORD", `Nomor invoice '${cleanInv}' sudah digunakan.`);
      }
    }

    // Enforcement: For role messenger, preserve historical notes and strip forbidden note fields
    if (user && user.role === "messenger") {
      if (safeUpdates.pickupProof && typeof safeUpdates.pickupProof === "object") {
        safeUpdates.pickupProof = {
          ...safeUpdates.pickupProof,
          notes: existing?.pickupProof?.notes,
          catatanKendala: existing?.pickupProof?.catatanKendala,
        };
      }
      if (safeUpdates.deliveryHandover && typeof safeUpdates.deliveryHandover === "object") {
        safeUpdates.deliveryHandover = {
          ...safeUpdates.deliveryHandover,
          notes: existing?.deliveryHandover?.notes,
        };
      }
      delete (safeUpdates as any).messengerTaskNotes;
      delete (safeUpdates as any).samsatPickupNotes;
      delete (safeUpdates as any).catatanKendala;
      delete (safeUpdates as any).catatanOrder;
      delete (safeUpdates as any).catatanPenjadwalan;
      delete (safeUpdates as any).catatanSamsat;
      delete (safeUpdates as any).catatanPengantaran;
      delete (safeUpdates as any).note;
      delete (safeUpdates as any).notes;
      delete (safeUpdates as any).reason;
    }

    // Resolve service identity if service_id or layanan is updated
    if (safeUpdates.layanan || (safeUpdates as any).service_id || (safeUpdates as any).serviceId) {
      const resolvedSvc = resolveServiceIdentity(
        (safeUpdates as any).service_id || (safeUpdates as any).serviceId,
        safeUpdates.layanan
      );
      if (resolvedSvc.serviceId) {
        (safeUpdates as any).service_id = resolvedSvc.serviceId;
        (safeUpdates as any).serviceId = resolvedSvc.serviceId;
      }
      if (safeUpdates.layanan) {
        safeUpdates.layanan = resolvedSvc.namaLayanan;
      }
    }

    if (safeUpdates.tanggalMasukBerkas) (safeUpdates as any).tanggal_masuk_berkas = safeUpdates.tanggalMasukBerkas;
    if ((safeUpdates as any).tanggal_masuk_berkas) safeUpdates.tanggalMasukBerkas = (safeUpdates as any).tanggal_masuk_berkas;

    if (safeUpdates.wilayahSamsatAsal) (safeUpdates as any).samsat_asal = safeUpdates.wilayahSamsatAsal;
    if ((safeUpdates as any).samsat_asal) safeUpdates.wilayahSamsatAsal = (safeUpdates as any).samsat_asal;

    if (safeUpdates.wilayahSamsatTujuan) (safeUpdates as any).samsat_tujuan = safeUpdates.wilayahSamsatTujuan;
    if ((safeUpdates as any).samsat_tujuan) safeUpdates.wilayahSamsatTujuan = (safeUpdates as any).samsat_tujuan;

    const incomingTotal = Number(
      safeUpdates.payment?.totalBiaya ??
      (safeUpdates as any).total_biaya ??
      (safeUpdates as any).totalBiaya ??
      (safeUpdates as any).totalEstimasi ??
      0
    );
    if (incomingTotal > 0) {
      (safeUpdates as any).total_biaya = incomingTotal;
      if (!safeUpdates.payment) safeUpdates.payment = { ...(existing.payment || {}) } as any;
      if (safeUpdates.payment) safeUpdates.payment.totalBiaya = incomingTotal;
    }

    if ((safeUpdates as any).biayaLainnya !== undefined) {
      (safeUpdates as any).biaya_lainnya = Number((safeUpdates as any).biayaLainnya);
    }

    // Auto-Spawn follow-up pickup task when Samsat is marked completed (Requirement #4)
    if (safeUpdates.samsatStatus === "Selesai") {
      if (!existing.samsatPickupStatus || existing.samsatPickupStatus === "Belum Dijadwal" || existing.samsatPickupStatus === "Belum Dijadwal Jemput Samsat") {
        safeUpdates.samsatPickupStatus = "Belum Dijadwal";
        const updatedAcceptance = {
          ...(existing.taskAcceptance || {}),
          ...(safeUpdates.taskAcceptance || {}),
          ["Jemput Hasil Samsat"]: {
            status: "PENDING" as const,
            isLocked: false,
          },
        };
        safeUpdates.taskAcceptance = updatedAcceptance;
      }
    }

    return runInTransaction(() => {
      // Invalidate existing Supervisor approval if fundamental order data changes after approval
      if (existing.approvedBySpv && (safeUpdates.customer || safeUpdates.nopol || safeUpdates.layanan)) {
        this.invalidateDocumentApproval(
          orderNo,
          `Perubahan data dasar order (${[safeUpdates.customer ? 'customer' : '', safeUpdates.nopol ? 'nopol' : '', safeUpdates.layanan ? 'layanan' : ''].filter(Boolean).join(', ')}) setelah supervisi disetujui`
        );
      }

      const success = dbOrderRepository.updateOrder(orderNo, safeUpdates);
      if (!success) {
        throw new ApiError(500, "UPDATE_FAILED", `Gagal memperbarui order ${orderNo}`);
      }

      const updated = this.getByOrderNo(orderNo);
      this.linkOrderDocuments(updated);

      // Financial and Invoice atomic sync across orders and finance_invoices
      const inv = dbFinanceRepository.getInvoiceByOrderNo(orderNo);
      if (inv) {
        const resolvedSvcId = (safeUpdates as any).service_id || (safeUpdates as any).serviceId || inv.service_id || (inv as any).serviceId;
        const isTerminalCancelled =
          Boolean((existing as any).isCancelled) ||
          existing.currentStageName === "Dibatalkan" ||
          (existing as any).status === "Dibatalkan" ||
          String(inv.status || "").trim().toUpperCase() === "CANCELLED" ||
          String((inv as any).billingStatus || "").trim().toUpperCase() === "CANCELLED";

        if (isTerminalCancelled) {
          // Preserve terminal CANCELLED invoice state, refund liability, and payout metadata unconditionally
          dbFinanceRepository.saveInvoice({
            ...inv,
            customer: safeUpdates.customer || inv.customer,
            layanan: safeUpdates.layanan || inv.layanan,
            service_id: resolvedSvcId || undefined,
            serviceId: resolvedSvcId || undefined,
            nopol: safeUpdates.nopol || inv.nopol,
            status: "CANCELLED" as any,
            billingStatus: "CANCELLED" as any,
            namaPenerimaKeluar: (safeUpdates as any).namaPenerimaKeluar || (safeUpdates as any).namaPemilikRekeningKeluar || (inv as any).namaPenerimaKeluar || undefined,
            tandaTerima: (safeUpdates as any).tandaTerima || (inv as any).tandaTerima || undefined,
            ttbBPKB: (safeUpdates as any).ttbBPKB || (inv as any).ttbBPKB || undefined,
          } as any);
        } else {
          const newTotal = incomingTotal > 0
            ? incomingTotal
            : Number(inv.totalTagihan ?? inv.total_tagihan ?? 0);
          const hasExplicitSamsatUpdate =
            (safeUpdates as any).biayaSamsat !== undefined ||
            (safeUpdates as any).uangKeluar !== undefined;
          const hasItemizedTaxUpdate =
            (safeUpdates as any).pkb !== undefined ||
            (safeUpdates as any).dendaPkb !== undefined ||
            (safeUpdates as any).swdkllj !== undefined ||
            (safeUpdates as any).dendaSwdkllj !== undefined ||
            (safeUpdates as any).costSnapshot !== undefined;
          const rawIncomingSamsat = hasExplicitSamsatUpdate
            ? Number((safeUpdates as any).biayaSamsat ?? (safeUpdates as any).uangKeluar ?? 0)
            : (hasItemizedTaxUpdate ? undefined : Number(inv.biayaSamsat ?? inv.biaya_samsat ?? 0));
          const updatedCogs = resolveCanonicalSamsatCogs({
            biayaSamsat: rawIncomingSamsat,
            biayaJasa: (safeUpdates as any).biayaJasa ?? inv.biayaJasa ?? inv.biaya_jasa,
            biayaAntarJemput: (safeUpdates as any).biayaAntarJemput ?? inv.biayaAntarJemput ?? inv.biaya_antar_jemput,
            totalTagihan: newTotal,
            pkb: (safeUpdates as any).pkb ?? updated?.pkb,
            dendaPkb: (safeUpdates as any).dendaPkb ?? (updated as any)?.dendaPkb,
            swdkllj: (safeUpdates as any).swdkllj ?? updated?.swdkllj,
            dendaSwdkllj: (safeUpdates as any).dendaSwdkllj ?? updated?.dendaSwdkllj,
            costSnapshot: (safeUpdates as any).costSnapshot ?? updated?.costSnapshot,
            isCostVerified: Boolean(updated?.isCostVerified),
            isExplicitZero: Boolean((safeUpdates as any).isExplicitZero ?? (inv as any).isExplicitZero),
          });
          const newSamsat = updatedCogs.biayaSamsat;
          const newJasa = (safeUpdates as any).biayaJasa !== undefined
            ? Number((safeUpdates as any).biayaJasa)
            : ((safeUpdates as any).profit !== undefined
                ? Number((safeUpdates as any).profit)
                : Number(inv.biayaJasa ?? inv.biaya_jasa ?? 0));
          const newAntarJemput = (safeUpdates as any).biayaAntarJemput !== undefined
            ? Number((safeUpdates as any).biayaAntarJemput)
            : Number(inv.biayaAntarJemput ?? inv.biaya_antar_jemput ?? 0);
          const currentDibayar = Number(inv.dibayar ?? 0);
          const newSisa = Math.max(0, newTotal - currentDibayar);
          const newStatus =
            currentDibayar > newTotal && newTotal > 0
              ? "OVERPAID"
              : currentDibayar >= newTotal && newTotal > 0
              ? "PAID"
              : currentDibayar > 0
              ? "PARTIAL"
              : "UNPAID";

          dbFinanceRepository.saveInvoice({
            ...inv,
            customer: safeUpdates.customer || inv.customer,
            layanan: safeUpdates.layanan || inv.layanan,
            service_id: resolvedSvcId || undefined,
            serviceId: resolvedSvcId || undefined,
            nopol: safeUpdates.nopol || inv.nopol,
            totalTagihan: newTotal,
            biayaSamsat: newSamsat,
            pendapatanJasa: newJasa,
            biayaJasa: newJasa,
            biayaAntarJemput: newAntarJemput,
            sisa: newSisa,
            status: newStatus as any,
            namaPenerimaKeluar: (safeUpdates as any).namaPenerimaKeluar || (safeUpdates as any).namaPemilikRekeningKeluar || (inv as any).namaPenerimaKeluar || undefined,
            tandaTerima: (safeUpdates as any).tandaTerima || (inv as any).tandaTerima || undefined,
            ttbBPKB: (safeUpdates as any).ttbBPKB || (inv as any).ttbBPKB || undefined,
          } as any);

          // Direct SQL update to ensure immediate persistence in SQLite table
          db.prepare(`
            UPDATE finance_invoices
            SET total_tagihan = ?, biaya_samsat = ?, pendapatan_jasa = ?, biaya_jasa = ?, biaya_antar_jemput = ?, sisa = ?, status = ?, updated_at = datetime('now')
            WHERE order_no = ?
          `).run(newTotal, newSamsat, newJasa, newJasa, newAntarJemput, newSisa, newStatus, orderNo);
        }
      }

      // Audit Log with verified actor
      dbAuditRepository.save({
        id: `log-ord-update-${Date.now()}`,
        userId: user?.userId || "usr-system",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: "UPDATE",
        module: "Order Tracking",
        details: `Memperbarui data order ${orderNo}`,
        metadata: { orderNo, updates: safeUpdates },
        createdAt: new Date().toISOString(),
      });

      return updated;
    });
  }

  public advanceOrder(orderNo: string, targetStage: StageName, updates: Partial<OperationalOrder> = {}, user?: TokenPayload | null): OperationalOrder {
    if (!orderNo || typeof orderNo !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", "Nomor order wajib diisi.");
    }
    if (!(STAGES as readonly string[]).includes(targetStage)) {
      throw new ApiError(400, "INVALID_STAGE", `Target stage '${targetStage}' tidak valid.`);
    }

    // Resolve canonical actor employee identity from authenticated server context
    const actorEmployeeId = resolveCanonicalActorEmployeeId(user);

    const updated = runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan dan tidak dapat diproses lebih lanjut.`);
      }
      if ((existing as any).isArchived) {
        throw new ApiError(400, "ORDER_ARCHIVED", `Order '${orderNo}' sudah diarsipkan dan tidak dapat diubah tahapan.`);
      }

      const stageList = STAGES as readonly string[];
      const currentStep = existing.currentStep !== undefined && Number(existing.currentStep) >= 1 && Number(existing.currentStep) <= 8
        ? Number(existing.currentStep)
        : (existing.currentStageName ? stageList.indexOf(existing.currentStageName as any) + 1 : 1);
      const targetStep = stageList.indexOf(targetStage) + 1;

      // Terminal step guard: order completed at Step 8 cannot advance
      if (currentStep === 8 || existing.currentStageName === "Dokumen Telah Diterima") {
        if (targetStage !== "Dokumen Telah Diterima") {
          throw new ApiError(
            400,
            "INVALID_STAGE_TRANSITION",
            `Order '${orderNo}' sudah berada pada tahap selesai (Dokumen Telah Diterima) dan tidak dapat dimajukan lagi.`
          );
        }
      }

      // Backward transition guard: advance endpoint cannot move backwards
      if (targetStep < currentStep) {
        throw new ApiError(
          400,
          "INVALID_STAGE_TRANSITION",
          `Transisi mundur dari '${existing.currentStageName}' (Step ${currentStep}) ke '${targetStage}' (Step ${targetStep}) tidak dapat dilakukan melalui endpoint /advance. Gunakan endpoint /rollback.`
        );
      }

      const isDatangLangsung =
        existing.metodeLayanan === "Datang Langsung" ||
        existing.costSnapshot?.metodeLayanan === "Datang Langsung";

      const isStage6Authorized = (caller?: TokenPayload | null): boolean => {
        if (!caller) return false;
        const callerRole = (caller.role || "").toLowerCase();
        return callerRole === "administrator";
      };

      // Forward transition guard: sequential enforcement and Datang Langsung shortcut
      if (targetStep > currentStep) {
        const isNormalNextStep = targetStep === currentStep + 1;
        const isDatangLangsungShortcut = currentStep === 1 && targetStep === 3 && isDatangLangsung;

        if (!isNormalNextStep && !isDatangLangsungShortcut) {
          throw new ApiError(
            400,
            "INVALID_STAGE_TRANSITION",
            `Transisi tahapan tidak valid: Order tidak dapat melompat dari '${existing.currentStageName}' (Step ${currentStep}) ke '${targetStage}' (Step ${targetStep}). Urutan tahapan harus diproses secara sekuensial.`
          );
        }
      }

      // Role authority check: Supervisi Stage 6 is strictly SVP-only
      if (existing.currentStageName === "Supervisi" || currentStep === 6) {
        if (user && !isStage6Authorized(user)) {
          throw new ApiError(403, "FORBIDDEN", "Stage 6 (Supervisi) bersifat eksklusif untuk SVP.");
        }
      }

      // Gating 2 -> 3: Penjadwalan -> Verifikasi Dokumen (Authoritative DB check only)
      if (currentStep === 2 && targetStep === 3) {
        const hasAssignedMessenger = Boolean(
          (existing.assignedMessengerId && existing.assignedMessengerId !== "Belum Ditugaskan" && existing.assignedMessengerId !== "-") ||
          (existing.messenger && existing.messenger !== "Belum Ditugaskan" && existing.messenger !== "-")
        );
        const isPickupDone =
          isDatangLangsung ||
          Boolean(existing.pickupCompleted) ||
          existing.messengerTaskStatus === "Dokumen Sudah Tersedia";
        if (!isPickupDone || (!isDatangLangsung && !hasAssignedMessenger)) {
          throw new ApiError(
            400,
            "PREREQUISITE_NOT_MET",
            "Penjemputan berkas oleh kurir belum selesai. Order belum dapat dimajukan ke Verifikasi Dokumen."
          );
        }
      }

      // Gating 3 -> 4: Verifikasi Dokumen -> Proses Samsat (Physical documents verified required)
      if (currentStep === 3 && targetStep === 4) {
        const isDocsDone =
          updates.documentsVerified ||
          existing.documentsVerified;
        if (!isDocsDone) {
          throw new ApiError(
            400,
            "PREREQUISITE_NOT_MET",
            "Verifikasi kelengkapan berkas fisik wajib disetujui terlebih dahulu sebelum order dapat diproses ke Samsat."
          );
        }
      }

      // Gating 4.5: Stage 4 -> Stage 5 Samsat Components & Samsat Pickup Completion Gating (Authoritative DB state only)
      if (currentStep === 4 && targetStep >= 5) {
        const valResult = validateSamsatCompletion(existing);
        if (!valResult.allowed) {
          throw new ApiError(
            400,
            valResult.code || "SAMSAT_COMPONENTS_INCOMPLETE",
            valResult.error || "Seluruh tahapan komponen loket Samsat wajib berstatus Selesai (COMPLETED) sebelum order dapat dilanjutkan."
          );
        }
        if (existing.samsatPickupStatus !== "Dokumen Samsat Diterima di Kantor") {
          throw new ApiError(
            400,
            "PREREQUISITE_NOT_MET",
            "Dokumen hasil Samsat belum diserahkan dan diterima di kantor melalui endpoint tugas kurir."
          );
        }
      }

      // Persetujuan dokumen Stage 5 gating (Verifikasi Ulang -> Supervisi)
      if (existing.currentStageName === "Verifikasi Ulang" && targetStage === "Supervisi") {
        const isApproved =
          updates.documentApproval?.stage5Verified ||
          existing.documentApproval?.stage5Verified ||
          updates.documentsVerified ||
          existing.documentsVerified;
        if (!isApproved) {
          throw new ApiError(
            400,
            "DOCUMENTS_NOT_VERIFIED",
            "Dokumen berkas Samsat wajib diperiksa dan disetujui terlebih dahulu sebelum order diajukan ke Supervisi."
          );
        }
      }

      // Sanitize advance updates: strip operational workflow status flags so /advance cannot forge completion state,
      // and prevent unauthorized callers from forging Stage 6 approval metadata.
      const canApproveStage6 = isStage6Authorized(user);
      const safeAdvanceUpdates: Partial<OperationalOrder> = { ...updates };
      delete (safeAdvanceUpdates as any).pickupCompleted;
      delete (safeAdvanceUpdates as any).pickup_completed;
      delete (safeAdvanceUpdates as any).messengerTaskStatus;
      delete (safeAdvanceUpdates as any).messenger_task_status;
      delete (safeAdvanceUpdates as any).isScheduled;
      delete (safeAdvanceUpdates as any).is_scheduled;
      delete (safeAdvanceUpdates as any).samsatStatus;
      delete (safeAdvanceUpdates as any).samsat_status;
      delete (safeAdvanceUpdates as any).samsatPickupStatus;
      delete (safeAdvanceUpdates as any).samsat_pickup_status;
      delete (safeAdvanceUpdates as any).deliveryStatus;
      delete (safeAdvanceUpdates as any).delivery_status;
      delete (safeAdvanceUpdates as any).isReceived;
      delete (safeAdvanceUpdates as any).is_received;

      if (!canApproveStage6) {
        delete (safeAdvanceUpdates as any).approvedBySpv;
        delete (safeAdvanceUpdates as any).spvName;
        delete (safeAdvanceUpdates as any).spvApprovedAt;
        delete (safeAdvanceUpdates as any).spvNotes;
        if (safeAdvanceUpdates.documentApproval) {
          delete (safeAdvanceUpdates.documentApproval as any).stage6Approved;
          delete (safeAdvanceUpdates.documentApproval as any).stage6ApprovedBy;
          delete (safeAdvanceUpdates.documentApproval as any).stage6ApprovedAt;
        }
      } else if (safeAdvanceUpdates.approvedBySpv) {
        safeAdvanceUpdates.spvName = user!.nama;
        safeAdvanceUpdates.spvApprovedAt = new Date().toISOString();
      }

      // Persetujuan dokumen Stage 6 gating (Supervisi -> Pengantaran)
      if (existing.currentStageName === "Supervisi" && targetStage === "Pengantaran") {
        const isApproved =
          (canApproveStage6 && (safeAdvanceUpdates.documentApproval?.stage6Approved || safeAdvanceUpdates.approvedBySpv)) ||
          existing.documentApproval?.stage6Approved ||
          existing.approvedBySpv;
        if (!isApproved) {
          throw new ApiError(
            400,
            "DOCUMENTS_NOT_APPROVED",
            "Dokumen hasil Samsat wajib disetujui pada Stage 6 (Supervisi) terlebih dahulu melalui persetujuan dokumen resmi sebelum order dilanjutkan ke Pengantaran."
          );
        }
      }

      // Gating 7 -> 8: Pengantaran -> Dokumen Telah Diterima (Authoritative DB check only)
      if (currentStep === 7 && targetStep === 8) {
        const isDeliveryDone =
          existing.deliveryStatus === "Dokumen Diserahkan" ||
          Boolean(existing.isReceived);
        const hasRecipientOrProof = Boolean(
          (existing.receiverName && String(existing.receiverName).trim()) ||
          ((existing as any).deliveryHandover?.recipientName && String((existing as any).deliveryHandover.recipientName).trim()) ||
          (existing.deliveryProof && String(existing.deliveryProof).trim())
        );
        if (!isDeliveryDone || !hasRecipientOrProof) {
          throw new ApiError(
            400,
            "PREREQUISITE_NOT_MET",
            "Pengantaran / serah terima dokumen kepada penerima belum diselesaikan. Selesaikan pengiriman terlebih dahulu."
          );
        }
      }

      const success = dbOrderRepository.advanceOrder(orderNo, targetStage, safeAdvanceUpdates, actorEmployeeId);
      if (!success) {
        throw new ApiError(500, "ADVANCE_FAILED", `Gagal memajukan order ${orderNo} ke stage ${targetStage}`);
      }

      const currentUpdated = this.getByOrderNo(orderNo);
      this.linkOrderDocuments(currentUpdated);

      // Audit Log with verified actor
      dbAuditRepository.save({
        id: `log-ord-advance-${Date.now()}`,
        userId: actorEmployeeId || user?.userId || "usr-system",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: "ADVANCE_STAGE",
        module: "Order Tracking",
        details: `Transisi order ${orderNo} dari '${existing.currentStageName}' ke '${targetStage}'`,
        metadata: { orderNo, fromStage: existing.currentStageName, toStage: targetStage, actorEmployeeId },
        createdAt: new Date().toISOString(),
      });

      return currentUpdated;
    });

    // Side effect (Notification) executed asynchronously outside the transaction boundary
    this.triggerOrderNotification(updated, "ORDER_UPDATE", targetStage);

    return updated;
  }

  public rollbackOrder(orderNo: string, targetStage: StageName, updates: Partial<OperationalOrder> = {}, user?: TokenPayload | null): OperationalOrder {
    if (!orderNo || typeof orderNo !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", "Nomor order wajib diisi.");
    }
    if (!(STAGES as readonly string[]).includes(targetStage)) {
      throw new ApiError(400, "INVALID_STAGE", `Target stage rollback '${targetStage}' tidak valid.`);
    }

    // Role authority check
    if (user && user.role === "messenger") {
      throw new ApiError(403, "FORBIDDEN", "Messenger tidak memiliki akses untuk rollback tahapan order.");
    }
    if (user && user.role === "finance") {
      throw new ApiError(403, "FORBIDDEN", "Finance tidak berwenang mengubah tahapan operasional order.");
    }

    // Resolve canonical actor employee identity from authenticated server context
    const actorEmployeeId = resolveCanonicalActorEmployeeId(user);

    const updated = runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan dan tidak dapat di-rollback.`);
      }
      if ((existing as any).isArchived) {
        throw new ApiError(400, "ORDER_ARCHIVED", `Order '${orderNo}' sudah diarsipkan dan tidak dapat di-rollback.`);
      }

      const stageList = STAGES as readonly string[];
      const currentStep = existing.currentStep !== undefined && Number(existing.currentStep) >= 1 && Number(existing.currentStep) <= 8
        ? Number(existing.currentStep)
        : (existing.currentStageName ? stageList.indexOf(existing.currentStageName as any) + 1 : 1);
      const targetStep = stageList.indexOf(targetStage) + 1;

      if (targetStep >= currentStep) {
        throw new ApiError(
          400,
          "INVALID_ROLLBACK",
          `Tahapan tujuan rollback '${targetStage}' (Step ${targetStep}) harus mendahului tahapan saat ini '${existing.currentStageName}' (Step ${currentStep}).`
        );
      }
      const revokedApproval = { ...((existing as any).documentApproval || {}) };
      const revokedFields: string[] = [];
      const rollbackUpdates: Partial<OperationalOrder> = { ...updates };

      // 1. Audit & Revoke Stage 6 approval if destination <= Step 6
      if (targetStep <= 6) {
        if (revokedApproval.stage6Approved) {
          revokedApproval.stage6Approved = false;
          delete revokedApproval.stage6ApprovedBy;
          delete revokedApproval.stage6ApprovedAt;
          delete revokedApproval.approvedDocsSnapshot;
          revokedFields.push("stage6Approved (Supervisor)");
        }
        rollbackUpdates.approvedBySpv = false;
        (rollbackUpdates as any).spvApprovedAt = null;
        (rollbackUpdates as any).spvName = null;

        // Reset delivery scheduling if rolled back to or before Stage 6
        rollbackUpdates.isDeliveryScheduled = false;
        (rollbackUpdates as any).deliveryStartedAt = null;
        (rollbackUpdates as any).deliveryStatus = null;
        (rollbackUpdates as any).tanggalPengantaran = null;
      }

      // 2. Audit & Revoke Stage 5 approval if destination <= Step 5
      if (targetStep <= 5) {
        if (revokedApproval.stage5Verified) {
          revokedApproval.stage5Verified = false;
          delete revokedApproval.stage5VerifiedBy;
          delete revokedApproval.stage5VerifiedAt;
          revokedFields.push("stage5Verified (Verifikasi Ulang)");
        }
        rollbackUpdates.documentsVerified = false;
        rollbackUpdates.isVerified = false;
      }

      // 3. Reset Stage 8 reception completion if destination <= Step 7
      if (targetStep <= 7) {
        rollbackUpdates.isReceived = false;
        (rollbackUpdates as any).tanggalDiterima = null;
        (rollbackUpdates as any).receiverName = null;
      }

      // 4. Reset Samsat completion flags if destination <= Step 4 & increment cycle
      if (targetStep <= 4) {
        const nextCycle = ((existing as any).samsatCycle || 1) + 1;
        if (existing.samsatStatus === "Selesai") {
          rollbackUpdates.samsatStatus = "Sedang Proses Samsat";
          rollbackUpdates.samsatCycle = nextCycle;
          revokedFields.push("samsatStatus: Selesai -> Sedang Proses Samsat");
        }
        if (
          existing.samsatPickupStatus === "Dokumen Samsat Diterima di Kantor" ||
          existing.samsatPickupStatus === "Sedang Jemput Dokumen Samsat" ||
          existing.samsatPickupStatus === "Terkendala"
        ) {
          rollbackUpdates.samsatPickupStatus = "Belum Dijadwal";
          delete (rollbackUpdates as any).samsatPickupMessengerId;
          delete (rollbackUpdates as any).samsatPickupMessenger;
          delete (rollbackUpdates as any).samsatPickupMessengerNama;
          delete (rollbackUpdates as any).samsatPickupStartedAt;
          delete (rollbackUpdates as any).samsatPickupCompletedAt;
          revokedFields.push(`samsatPickupStatus: ${existing.samsatPickupStatus} -> Belum Dijadwal (Superseded)`);
        }

        // Mark previous Jemput Hasil Samsat acceptance as SUPERSEDED for cycle isolation
        if (existing.taskAcceptance?.["Jemput Hasil Samsat"]) {
          rollbackUpdates.taskAcceptance = {
            ...(rollbackUpdates.taskAcceptance || existing.taskAcceptance || {}),
            ["Jemput Hasil Samsat"]: {
              ...(existing.taskAcceptance["Jemput Hasil Samsat"] as any),
              status: "SUPERSEDED" as any,
              isLocked: true,
              supersededAt: new Date().toISOString(),
              supersededReason: `Samsat rolled back to Step ${targetStep} (Cycle ${nextCycle})`,
            },
          };
        }
      }

      rollbackUpdates.documentApproval = revokedApproval;
      rollbackUpdates.currentStageName = targetStage;
      rollbackUpdates.currentStep = targetStep;

      const success = dbOrderRepository.updateOrder(orderNo, rollbackUpdates);
      if (!success) {
        throw new ApiError(500, "ROLLBACK_FAILED", `Gagal memproses rollback order ${orderNo} ke stage ${targetStage}`);
      }

      // Atomically record rollback in order_status_history with canonical actor
      dbOrderRepository.recordStatusHistory(
        orderNo,
        currentStep,
        targetStep,
        targetStage,
        (updates as any)?.catatanPenjadwalan || (updates as any)?.catatan || `Rollback order ${orderNo} dari '${existing.currentStageName}' (Step ${currentStep}) ke '${targetStage}' (Step ${targetStep})`,
        actorEmployeeId || null
      );

      const currentUpdated = this.getByOrderNo(orderNo);
      this.linkOrderDocuments(currentUpdated);

      // 5. Audit invoice and financial ledger: NEVER wipe recorded payments
      const inv = dbFinanceRepository.getInvoiceByOrderNo(orderNo);
      if (inv) {
        const recordedPaid = Number(inv.dibayar ?? inv.terbayar ?? 0);
        const hasRecordedPayment = recordedPaid > 0 || inv.status === "PAID" || inv.status === "PARTIAL";
        const wasCompleted = inv.billingStatus === "COMPLETED";

        if (hasRecordedPayment) {
          // Preserve all financial numbers & payment status!
          const invUpdates: Partial<any> = {};
          if (wasCompleted) {
            invUpdates.billingStatus = "ACTIVE";
          }
          invUpdates.keterangan = `Order di-rollback ke '${targetStage}'. Pembayaran riil Rp ${recordedPaid.toLocaleString("id-ID")} (${inv.status}) tetap aman dipertahankan.`;
          dbFinanceRepository.updateInvoice(inv.id, invUpdates);
        } else {
          // No payments recorded yet
          const invUpdates: Partial<any> = {};
          if (wasCompleted) {
            invUpdates.billingStatus = "ACTIVE";
          }
          invUpdates.keterangan = `Order di-rollback dari '${existing.currentStageName}' ke '${targetStage}'.`;
          dbFinanceRepository.updateInvoice(inv.id, invUpdates);
        }
      }

      // 6. Audit Log
      const revocationNote = revokedFields.length > 0 ? ` [Izin/Approval dicabut: ${revokedFields.join(", ")}]` : "";
      dbAuditRepository.save({
        id: `log-ord-rollback-${Date.now()}`,
        userId: user?.userId || "usr-system",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: "ROLLBACK_STAGE",
        module: "Order Tracking",
        details: `Rollback order ${orderNo} dari '${existing.currentStageName}' (Step ${currentStep}) ke '${targetStage}' (Step ${targetStep})${revocationNote}`,
        metadata: {
          orderNo,
          fromStage: existing.currentStageName,
          fromStep: currentStep,
          toStage: targetStage,
          toStep: targetStep,
          revokedFields,
        },
        createdAt: new Date().toISOString(),
      });

      return currentUpdated;
    });

    // Side effect (Notification) executed asynchronously outside the transaction boundary
    this.triggerOrderNotification(updated, "ORDER_UPDATE", `Rollback ke ${targetStage}`);

    return updated;
  }

  public approveOrderDocuments(
    orderNo: string,
    stage: 5 | 6,
    user: TokenPayload,
    snapshotDocs: string[] = []
  ): OperationalOrder {
    const existing = this.getByOrderNo(orderNo);
    if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
      throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan dan persetujuan dokumen tidak dapat diproses.`);
    }

    const nowIso = new Date().toISOString();

    if (stage === 6) {
      const role = (user.role || "").toLowerCase();
      const isSpv = role === "administrator";
      if (!isSpv) {
        throw new ApiError(403, "FORBIDDEN", "Stage 6 (Supervisi) hanya dapat disetujui oleh SVP.");
      }
    }

    if (stage === 5) {
      const canVerifyStage5 = user.role === "administrator" || user.role === "admin";
      if (!canVerifyStage5) {
        throw new ApiError(403, "FORBIDDEN", "Hanya Admin dan Supervisor / SVP yang berwenang memverifikasi dokumen Stage 5.");
      }
    }

    const currentApproval = (existing as any).documentApproval || {
      stage5Verified: false,
      stage6Approved: false,
    };

    const updatedApproval = {
      ...currentApproval,
      ...(stage === 5
        ? {
            stage5Verified: true,
            stage5VerifiedBy: user.nama,
            stage5VerifiedAt: nowIso,
            approvedDocsSnapshot: snapshotDocs,
          }
        : {
            stage6Approved: true,
            stage6ApprovedBy: user.nama,
            stage6ApprovedAt: nowIso,
            approvedDocsSnapshot: snapshotDocs,
          }),
    };

    const updates: Partial<OperationalOrder> = {
      ...({ documentApproval: updatedApproval } as any),
      ...(stage === 5 ? { documentsVerified: true } : {}),
      ...(stage === 6 ? { approvedBySpv: true, spvApprovedAt: nowIso, spvName: user.nama } : {}),
    };

    return runInTransaction(() => {
      dbOrderRepository.updateOrder(orderNo, updates);

      dbAuditRepository.save({
        id: `log-doc-approve-${Date.now()}`,
        userId: user.userId || "usr-system",
        userName: user.nama || "Staff",
        userRole: user.role || "admin",
        action: stage === 5 ? "STAGE5_DOCS_VERIFIED" : "STAGE6_DOCS_APPROVED",
        module: "Order Tracking",
        details: `${stage === 5 ? 'Verifikasi' : 'Persetujuan'} dokumen untuk order ${orderNo} oleh ${user.nama} (${user.role})`,
        metadata: { orderNo, stage, snapshotDocs },
        createdAt: nowIso,
      });

      const updated = this.getByOrderNo(orderNo);
      this.linkOrderDocuments(updated);
      return updated;
    });
  }

  public invalidateDocumentApproval(orderNo: string, reason?: string): void {
    const existing = this.getByOrderNo(orderNo);
    if (!existing) return;

    runInTransaction(() => {
      dbOrderRepository.updateOrder(orderNo, {
        ...({
          documentApproval: {
            stage5Verified: false,
            stage6Approved: false,
            approvedDocsSnapshot: [],
          },
        } as any),
        documentsVerified: false,
        approvedBySpv: false,
      });

      dbAuditRepository.save({
        id: `log-doc-inval-${Date.now()}`,
        userId: "usr-system",
        userName: "System Audit",
        userRole: "system",
        action: "DOCUMENT_APPROVAL_INVALIDATED",
        module: "Order Tracking",
        details: `Persetujuan dokumen dibatalkan untuk order ${orderNo}. Alasan: ${reason || 'Perubahan dokumen'}`,
        metadata: { orderNo, reason },
        createdAt: new Date().toISOString(),
      });
    });
  }

  public archiveOrder(orderNo: string, user?: TokenPayload | null): boolean {
    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(
          400,
          "ORDER_CANCELLED",
          `Order '${orderNo}' sudah dibatalkan dan tidak dapat diarsipkan melalui arsip penyelesaian normal.`
        );
      }

      if ((existing as any).isArchived === 2) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' telah dihapus dari rekap.`);
      }

      if ((existing as any).isArchived === true || Number((existing as any).isArchived) === 1) {
        // Idempotent safe return when order is already archived
        return true;
      }

      const resolvedStep = Number(existing.currentStep);
      const isAtStage8 =
        resolvedStep === 8 &&
        existing.currentStageName === "Dokumen Telah Diterima";

      if (!isAtStage8) {
        throw new ApiError(
          400,
          "INVALID_ARCHIVE_STAGE",
          `Order '${orderNo}' belum mencapai Stage 8 (Dokumen Telah Diterima) dan tidak dapat diarsipkan (saat ini: Stage ${resolvedStep || "-"} - ${existing.currentStageName || "-"}).`
        );
      }

      const success = dbOrderRepository.archiveOrder(orderNo);
      if (success) {
        dbAuditRepository.save({
          id: `log-ord-arch-${Date.now()}`,
          userId: user?.userId || "usr-system",
          userName: user?.nama || "Admin API",
          userRole: user?.role || "admin",
          action: "ARCHIVE",
          module: "Order Tracking",
          details: `Mengarsipkan order ${orderNo} (Stage 8 - Dokumen Telah Diterima)`,
          metadata: {
            orderNo,
            previousStep: resolvedStep,
            previousStageName: existing.currentStageName,
          },
          createdAt: new Date().toISOString(),
        });
      }
      return success;
    });
  }

  public deleteArchivedOrder(orderNo: string, user?: TokenPayload | null): boolean {
    return runInTransaction(() => {
      const success = dbOrderRepository.deleteArchivedOrder(orderNo);
      if (success) {
        dbAuditRepository.save({
          id: `log-ord-del-arch-${Date.now()}`,
          userId: user?.userId || "usr-admin",
          userName: user?.nama || "Admin API",
          userRole: user?.role || "admin",
          action: "DELETE",
          module: "Order History",
          details: `Menghapus rekap order sementara ${orderNo}`,
          metadata: { orderNo },
          createdAt: new Date().toISOString(),
        });
      }
      return success;
    });
  }

  public hardDeleteOrder(orderNo: string, user?: TokenPayload | null): boolean {
    return runInTransaction(() => {
      const success = dbOrderRepository.hardDeleteOrder(orderNo);
      if (success) {
        dbAuditRepository.save({
          id: `log-ord-hard-del-${Date.now()}`,
          userId: user?.userId || "usr-admin",
          userName: user?.nama || "Admin API",
          userRole: user?.role || "admin",
          action: "DELETE",
          module: "Data Penjualan",
          details: `Menghapus data order secara permanen (Hard Delete): ${orderNo}`,
          metadata: { orderNo },
          createdAt: new Date().toISOString(),
        });
      }
      return success;
    });
  }

  public cancelOrder(
    orderNo: string,
    reason: string,
    user?: TokenPayload | null,
    options?: CancelOrderOptions
  ): OperationalOrder {
    if (!reason || !reason.trim()) {
      throw new ApiError(400, "VALIDATION_ERROR", "Alasan pembatalan order wajib diisi.");
    }
    const actorEmployeeId = resolveCanonicalActorEmployeeId(user);
    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan") {
        // Idempotent safe return: order already cancelled, return cleanly without duplicating mutations
        return existing;
      }

      const nowStr = new Date().toISOString();
      const stageBeforeCancel = (existing.currentStageName !== "Dibatalkan" ? existing.currentStageName : (existing as any).stageBeforeCancel) || "Verifikasi";
      const updatedOrder: OperationalOrder = {
        ...existing,
        stageBeforeCancel,
        currentStageName: "Dibatalkan" as any,
        catatanOrder: `${existing.catatanOrder ? existing.catatanOrder + " | " : ""}Dibatalkan: ${reason.trim()} (oleh ${user?.nama || "Admin"})`,
      };
      (updatedOrder as any).isCancelled = true;
      (updatedOrder as any).status = "Dibatalkan";
      (updatedOrder as any).cancelledAt = nowStr;
      (updatedOrder as any).cancelledBy = user?.nama || "Admin";
      (updatedOrder as any).cancellationReason = reason.trim();

      dbOrderRepository.updateOrder(orderNo, updatedOrder);

      // Atomically record cancellation in order_status_history with canonical actor
      dbOrderRepository.recordStatusHistory(
        orderNo,
        existing.currentStep,
        0,
        "Dibatalkan",
        `Dibatalkan: ${reason.trim()}`,
        actorEmployeeId || null
      );

      // Also update matching invoice
      const inv = dbFinanceRepository.getInvoiceByOrderNo(orderNo);
      if (inv) {
        const paidAmount = Number(inv.dibayar ?? inv.terbayar ?? 0);
        const invoiceUpdates: any = {
          status: "CANCELLED" as any,
          billingStatus: "CANCELLED" as any,
          keterangan: `Order dibatalkan: ${reason.trim()}`,
          alasan_pending: reason.trim(),
        };

        // QC-01 Fix: If customer already paid deposit/full amount, route funds to Cashback Terpending (Refund Liability)
        if (paidAmount > 0 && !options?.skipRefundPending) {
          invoiceUpdates.overpayment = paidAmount;
          invoiceUpdates.refundStatus = "PENDING";
          invoiceUpdates.settlementCondition = "OVERPAID";
          invoiceUpdates.keterangan = `Order dibatalkan: ${reason.trim()} (Dana setoran Rp ${paidAmount.toLocaleString("id-ID")} dialihkan ke Refund/Cashback Terpending)`;
        }

        dbFinanceRepository.updateInvoice(inv.id, invoiceUpdates);
      }

      // Save audit log
      dbAuditRepository.save({
        id: `log-ord-cancel-${Date.now()}`,
        userId: actorEmployeeId || user?.userId || "usr-system",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: "CANCEL_ORDER",
        module: "Data Penjualan",
        details: `Membatalkan order ${orderNo}. Alasan: ${reason.trim()}`,
        metadata: { orderNo, reason: reason.trim(), actorEmployeeId },
        createdAt: nowStr,
      });

      return updatedOrder;
    });
  }

  public clearArchivedOrders(user?: TokenPayload | null): number {
    const count = dbOrderRepository.clearArchivedOrders();
    if (count > 0) {
      dbAuditRepository.save({
        id: `log-ord-clear-all-${Date.now()}`,
        userId: user?.userId || "usr-admin",
        userName: user?.nama || "Admin API",
        userRole: user?.role || "admin",
        action: "DELETE",
        module: "Order History",
        details: `Membersihkan seluruh data Rekap Order (${count} berkas)`,
        metadata: { clearedCount: count },
        createdAt: new Date().toISOString(),
      });
    }
    return count;
  }

  /**
   * Phase 4B Batch 2B Step C: Single Write Path Delegation
   * Delegates all verification lifecycle operations to the unified financeService.verifyPayment engine.
   * Handles polymorphic legacy parameters for backward compatibility.
   */
  public verifyPayment(
    orderNo: string,
    verifierNameOrUser?: string | TokenPayload | null,
    userOrAmount?: TokenPayload | number | null,
    confirmedAmountOrNotes?: number | string,
    notesOrProof?: string | any,
    proofPayload?: any,
    paymentId?: string,
    idempotencyKey?: string
  ): OperationalOrder {
    let effectiveVerifier: string = "Admin";
    let effectiveUser: TokenPayload | null | undefined = undefined;
    let effectiveAmount: number | undefined = undefined;
    let effectiveNotes: string | undefined = undefined;
    let effectiveProof: any = undefined;

    if (verifierNameOrUser && typeof verifierNameOrUser === "object") {
      effectiveUser = verifierNameOrUser as TokenPayload;
      effectiveVerifier = effectiveUser.nama || "Admin";
      if (typeof userOrAmount === "number") {
        effectiveAmount = userOrAmount;
        effectiveNotes = typeof confirmedAmountOrNotes === "string" ? confirmedAmountOrNotes : undefined;
        effectiveProof = notesOrProof;
      } else {
        effectiveAmount = typeof confirmedAmountOrNotes === "number" ? confirmedAmountOrNotes : undefined;
        effectiveNotes = typeof notesOrProof === "string" ? notesOrProof : undefined;
        effectiveProof = proofPayload;
      }
    } else {
      if (typeof verifierNameOrUser === "string") {
        effectiveVerifier = verifierNameOrUser;
      }
      if (userOrAmount && typeof userOrAmount === "object") {
        effectiveUser = userOrAmount as TokenPayload;
        effectiveAmount = typeof confirmedAmountOrNotes === "number" ? confirmedAmountOrNotes : undefined;
        effectiveNotes = typeof notesOrProof === "string" ? notesOrProof : undefined;
        effectiveProof = proofPayload;
      } else if (typeof userOrAmount === "number") {
        effectiveAmount = userOrAmount;
        effectiveNotes = typeof confirmedAmountOrNotes === "string" ? confirmedAmountOrNotes : undefined;
        effectiveProof = notesOrProof;
      } else {
        effectiveAmount = typeof confirmedAmountOrNotes === "number" ? confirmedAmountOrNotes : undefined;
        effectiveNotes = typeof notesOrProof === "string" ? notesOrProof : undefined;
        effectiveProof = proofPayload;
      }
    }

    const result = financeService.verifyPayment({
      orderNo,
      verifierName: effectiveVerifier,
      user: effectiveUser,
      confirmedAmount: effectiveAmount,
      notes: effectiveNotes,
      proofPayload: effectiveProof,
      paymentId,
      idempotencyKey,
    });

    return result.order;
  }

  /**
   * Messenger Accepts Task (Tugas Baru -> Tugas Aktif & Terkunci)
   * Enforces race condition protection against double acceptance
   */
  private normalizeCanonicalTaskType(rawTaskType: string): "Jemput Dokumen" | "Proses Samsat" | "Jemput Hasil Samsat" | "Pengantaran Dokumen" {
    const clean = String(rawTaskType || "").trim().toLowerCase();
    if (clean === "jemput dokumen" || clean === "pickup") return "Jemput Dokumen";
    if (clean === "proses samsat" || clean === "samsat") return "Proses Samsat";
    if (clean === "jemput hasil samsat" || clean === "jemput hasil" || clean === "samsat_pickup") return "Jemput Hasil Samsat";
    if (clean === "pengantaran dokumen" || clean === "delivery") return "Pengantaran Dokumen";
    throw new ApiError(400, "INVALID_TASK_TYPE", `Jenis tugas '${rawTaskType}' tidak dikenali.`);
  }

  private getTaskAssignedCourierId(order: OperationalOrder, taskType: string): string | undefined {
    const acc = (order.taskAcceptance || {})[taskType] as any;
    const isReal = (id?: string, name?: string) => {
      if (!id) return false;
      const cid = String(id).trim();
      const clow = cid.toLowerCase();
      if (!cid || clow === "-" || clow === "emp-msg" || clow === "emp-samsat" || clow === "belum ditugaskan" || clow === "datang langsung (loket)") {
        return false;
      }
      if (name) {
        const nlow = String(name).trim().toLowerCase();
        if (nlow === "belum ditugaskan" || nlow === "-" || nlow === "datang langsung (loket)") {
          return false;
        }
      }
      return true;
    };

    const accId = acc?.courierId || acc?.assignedMessengerId;
    if (isReal(accId, acc?.courierName || acc?.assignedMessengerName)) {
      return String(accId).trim();
    }

    if (taskType === "Jemput Dokumen") {
      return isReal(order.assignedMessengerId, order.assignedMessengerName || order.messenger) ? String(order.assignedMessengerId).trim() : undefined;
    }
    if (taskType === "Proses Samsat") {
      return isReal(order.samsatMessengerId, order.samsatMessengerNama || order.samsatMessenger) ? String(order.samsatMessengerId).trim() : undefined;
    }
    if (taskType === "Jemput Hasil Samsat") {
      return isReal(order.samsatPickupMessengerId, order.samsatPickupMessengerNama || order.samsatPickupMessenger) ? String(order.samsatPickupMessengerId).trim() : undefined;
    }
    if (taskType === "Pengantaran Dokumen") {
      return isReal((order as any).deliveryMessengerId, order.messengerPengantar) ? String((order as any).deliveryMessengerId).trim() : undefined;
    }
    return undefined;
  }

  private assertTaskNotCompleted(order: OperationalOrder, taskType: string): void {
    if (taskType === "Jemput Dokumen" && (order.pickupCompleted || order.messengerTaskStatus === "Dokumen Sudah Tersedia" || order.messengerTaskStatus === "Selesai")) {
      throw new ApiError(400, "TASK_ALREADY_COMPLETED", `Tugas Penjemputan pada order '${order.orderNo}' sudah selesai.`);
    }
    if (taskType === "Proses Samsat" && order.samsatStatus === "Selesai") {
      throw new ApiError(400, "TASK_ALREADY_COMPLETED", `Tugas Proses Samsat pada order '${order.orderNo}' sudah selesai.`);
    }
    if (taskType === "Jemput Hasil Samsat" && order.samsatPickupStatus === "Dokumen Samsat Diterima di Kantor") {
      throw new ApiError(400, "TASK_ALREADY_COMPLETED", `Tugas Jemput Hasil Samsat pada order '${order.orderNo}' sudah selesai.`);
    }
    if (taskType === "Pengantaran Dokumen" && (order.deliveryStatus === "Dokumen Diserahkan" || order.isReceived)) {
      throw new ApiError(400, "TASK_ALREADY_COMPLETED", `Tugas Pengantaran Dokumen pada order '${order.orderNo}' sudah selesai.`);
    }
  }

  public acceptMessengerTask(orderNo: string, taskType: string, user: TokenPayload): OperationalOrder {
    const canonicalTaskType = this.normalizeCanonicalTaskType(taskType);
    const courierName = user.nama || (user as any).userName || "Messenger Lapangan";
    const role = (user.role || "").toLowerCase();
    const courierId = role === "messenger" ? (user as any).employeeId : ((user as any).employeeId || user.userId);

    if (role === "messenger") {
      if (!courierId || courierId === "EMP-MSG" || courierId === "EMP-SAMSAT" || courierId === "Belum Ditugaskan" || courierId === "-") {
        throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak memiliki employeeId kanonikal.");
      }
    } else if (!courierId) {
      throw new ApiError(403, "FORBIDDEN", "Identitas pengguna tidak valid.");
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if ((existing as any).isArchived) {
        throw new ApiError(400, "ORDER_ARCHIVED", `Order '${orderNo}' sudah diarsipkan.`);
      }

      const currentAcceptance = (existing.taskAcceptance || {})[canonicalTaskType];

      // 1. Idempotency Check: Same courier retrying acceptance before completion
      if (currentAcceptance?.isLocked && currentAcceptance.courierId && currentAcceptance.courierId === courierId && currentAcceptance.status === "ACCEPTED") {
        // Already accepted and locked by the same courier.
        // Return existing order without creating duplicate timeline events or duplicate audit logs.
        return existing;
      }

      this.assertTaskNotCompleted(existing, canonicalTaskType);

      // 2. Concurrency Conflict: Task is already locked by a different courier
      if (currentAcceptance?.isLocked && currentAcceptance.courierId && currentAcceptance.courierId !== courierId) {
        throw new ApiError(
          409,
          "TASK_ALREADY_ACCEPTED",
          `Tugas ${canonicalTaskType} pada order ${orderNo} sudah diterima dan dikunci oleh kurir lain (${currentAcceptance.courierName || "Petugas lain"}).`
        );
      }

      // 3. Ownership Check: Specifically assigned PENDING task cannot be stolen by another courier
      const assignedOwnerId = this.getTaskAssignedCourierId(existing, canonicalTaskType);
      if (role === "messenger" && assignedOwnerId && assignedOwnerId !== courierId) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          `Tugas ${canonicalTaskType} pada order ${orderNo} sudah ditugaskan secara khusus kepada kurir lain.`
        );
      }

      const nowIso = new Date().toISOString();
      const prevHistory = Array.isArray((currentAcceptance as any)?.history) ? (currentAcceptance as any).history : [];

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        [canonicalTaskType]: {
          status: "ACCEPTED" as const,
          acceptedAt: nowIso,
          courierId,
          courierName,
          isLocked: true,
          reassignedFrom: currentAcceptance?.reassignedFrom,
          reassignReason: currentAcceptance?.reassignReason,
          reassignedAt: currentAcceptance?.reassignedAt,
          history: [
            ...prevHistory,
            { action: "ACCEPTED", courierId, courierName, timestamp: nowIso },
          ],
        },
      };

      const taskUpdates: Partial<OperationalOrder> = {
        taskAcceptance: updatedAcceptance,
      };

      const timelineEvent: any = {
        id: `tl-acc-${Date.now()}`,
        timestamp: nowIso,
        title: `Tugas ${canonicalTaskType} Diterima`,
        note: `Tugas operasional diterima dan dikunci oleh kurir ${courierName}`,
        author: courierName,
        type: "STATUS_CHANGE",
      };
      const existingTimeline = existing.messengerTimeline || [];
      taskUpdates.messengerTimeline = [timelineEvent, ...existingTimeline];

      // Canonical check: Courier must have valid non-generic identity
      if (!courierId || courierId === "EMP-MSG" || courierId === "Belum Ditugaskan" || courierId === "-") {
        throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak terverifikasi.");
      }

      // Align order-level courier assignment fields
      if (canonicalTaskType === "Jemput Dokumen") {
        if (existing.currentStep !== 2 && existing.currentStageName !== "Penjadwalan") {
          throw new ApiError(400, "INVALID_STAGE", `Tugas Jemput Dokumen hanya dapat diterima pada Step 2 (Penjadwalan).`);
        }
        taskUpdates.messenger = courierName;
        taskUpdates.assignedMessengerName = courierName;
        taskUpdates.assignedMessengerId = courierId;
        taskUpdates.isScheduled = true;
        if (!existing.tanggalJemput) taskUpdates.tanggalJemput = normalizeToWibCalendarDate(nowIso) || nowIso.split("T")[0];
      } else if (canonicalTaskType === "Proses Samsat") {
        if (existing.currentStep !== 4 && existing.currentStageName !== "Proses Samsat") {
          throw new ApiError(400, "INVALID_STAGE", `Tugas Proses Samsat hanya dapat diterima pada Step 4 (Proses Samsat).`);
        }
        taskUpdates.samsatMessenger = courierName;
        taskUpdates.samsatMessengerNama = courierName;
        taskUpdates.samsatMessengerId = courierId;
        taskUpdates.isSamsatScheduled = true;
        if (!existing.tanggalProsesSamsat) taskUpdates.tanggalProsesSamsat = normalizeToWibCalendarDate(nowIso) || nowIso.split("T")[0];
      } else if (canonicalTaskType === "Jemput Hasil Samsat") {
        // Validate order stage and Samsat status
        if (existing.currentStep !== 4 && existing.currentStageName !== "Proses Samsat") {
          throw new ApiError(400, "INVALID_STAGE", `Tugas Jemput Hasil Samsat hanya dapat diambil pada Step 4 (Proses Samsat).`);
        }
        if (existing.samsatStatus !== "Selesai") {
          throw new ApiError(400, "SAMSAT_NOT_COMPLETED", `Proses pengurusan Samsat belum berstatus Selesai.`);
        }

        // Cycle & Superseded check
        const currentCycle = (existing as any).samsatCycle || 1;
        const existingPickupAcc = (existing.taskAcceptance || {})["Jemput Hasil Samsat"];
        if (existingPickupAcc?.status === "SUPERSEDED") {
          throw new ApiError(400, "TASK_SUPERSEDED", "Tugas Jemput Hasil Samsat ini sudah tidak berlaku (superseded) karena proses Samsat di-rollback.");
        }
        if (existingPickupAcc?.cycle && existingPickupAcc.cycle !== currentCycle) {
          throw new ApiError(400, "TASK_SUPERSEDED", `Tugas Jemput Hasil Samsat berasal dari cycle lama (Cycle ${existingPickupAcc.cycle}), cycle aktif adalah Cycle ${currentCycle}.`);
        }

        taskUpdates.samsatPickupMessenger = courierName;
        taskUpdates.samsatPickupMessengerNama = courierName;
        taskUpdates.samsatPickupMessengerId = courierId;
        // Task Acceptance begins the lifecycle immediately
        taskUpdates.samsatPickupStatus = "Sedang Jemput Dokumen Samsat";
        taskUpdates.samsatPickupStartedAt = existing.samsatPickupStartedAt || nowIso;

        // Ensure updated acceptance has cycle info
        (updatedAcceptance["Jemput Hasil Samsat"] as any).cycle = currentCycle;
        (updatedAcceptance["Jemput Hasil Samsat"] as any).startedAt = nowIso;
      } else if (canonicalTaskType === "Pengantaran Dokumen") {
        if (existing.currentStep !== 7 && existing.currentStageName !== "Pengantaran") {
          throw new ApiError(400, "INVALID_STAGE", `Tugas Pengantaran Dokumen hanya dapat diterima pada Step 7 (Pengantaran).`);
        }
        taskUpdates.messengerPengantar = courierName;
        (taskUpdates as any).deliveryMessengerId = courierId;
        taskUpdates.isDeliveryScheduled = true;
        if (!existing.tanggalPengantaran) taskUpdates.tanggalPengantaran = normalizeToWibCalendarDate(nowIso) || nowIso.split("T")[0];
      }

      dbOrderRepository.updateOrder(orderNo, taskUpdates);
      const updated = this.getByOrderNo(orderNo);

      dbAuditRepository.save({
        id: `log-task-accept-${Date.now()}`,
        userId: courierId,
        userName: courierName,
        userRole: (user.role as any) || "messenger",
        action: "ACCEPT_TASK",
        module: "Messenger Task",
        details: `Kurir ${courierName} menerima dan mengunci tugas ${canonicalTaskType} pada order ${orderNo}`,
        metadata: { orderNo, taskType: canonicalTaskType, courierId, courierName, acceptedAt: nowIso },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Messenger Declines Task (Tolak Tugas -> Menunggu Penugasan Kembali)
   */
  public declineMessengerTask(orderNo: string, taskType: string, reason: string | undefined, user: TokenPayload): OperationalOrder {
    const canonicalTaskType = this.normalizeCanonicalTaskType(taskType);
    const courierName = user.nama || (user as any).userName || "Messenger Lapangan";
    const role = (user.role || "").toLowerCase();
    const courierId = (user as any).employeeId || user.userId;
    if (!courierId || courierId === "EMP-MSG" || courierId === "Belum Ditugaskan" || courierId === "-") {
      throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak terverifikasi.");
    }

    // Zero free-text operational notes enforcement: Rejection reason must not be free-text for messengers
    if (role === "messenger" && reason && typeof reason === "string" && reason.trim().length > 0) {
      throw new ApiError(400, "MESSENGER_NOTES_NOT_ALLOWED", "Catatan/alasan operasional bebas (free-text reason) tidak diizinkan pada penolakan tugas.");
    }

    const canonicalReason = "Ditolak oleh kurir";

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if ((existing as any).isArchived) {
        throw new ApiError(400, "ORDER_ARCHIVED", `Order '${orderNo}' sudah diarsipkan.`);
      }

      this.assertTaskNotCompleted(existing, canonicalTaskType);

      // Ownership Enforcement: Only the assigned courier (or Admin/Administrator) can decline a task
      const assignedOwnerId = this.getTaskAssignedCourierId(existing, canonicalTaskType);
      if (role === "messenger") {
        if (!assignedOwnerId || assignedOwnerId !== courierId) {
          throw new ApiError(
            403,
            "FORBIDDEN",
            `Anda tidak berwenang menolak tugas ${canonicalTaskType} pada order ${orderNo} karena bukan kurir yang ditugaskan.`
          );
        }
      }

      const nowIso = new Date().toISOString();
      const currentAcceptance = (existing.taskAcceptance || {})[canonicalTaskType];
      const prevHistory = Array.isArray((currentAcceptance as any)?.history) ? (currentAcceptance as any).history : [];

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        [canonicalTaskType]: {
          status: "DECLINED" as const,
          declinedAt: nowIso,
          declineReason: canonicalReason,
          courierId,
          courierName,
          isLocked: false,
          history: [
            ...prevHistory,
            { action: "DECLINED", courierId, courierName, reason: canonicalReason, timestamp: nowIso },
          ],
        },
      };

      const taskUpdates: Partial<OperationalOrder> = {
        taskAcceptance: updatedAcceptance,
      };

      const timelineEvent: any = {
        id: `tl-dec-${Date.now()}`,
        timestamp: nowIso,
        title: `Tugas ${canonicalTaskType} Ditolak`,
        note: `Tugas ${canonicalTaskType} ditolak oleh kurir ${courierName}.`,
        author: courierName,
        type: "STATUS_CHANGE",
      };
      const existingTimeline = existing.messengerTimeline || [];
      taskUpdates.messengerTimeline = [timelineEvent, ...existingTimeline];

      // Reset courier assignment so it returns to unassigned
      if (canonicalTaskType === "Jemput Dokumen") {
        taskUpdates.messenger = "Belum Ditugaskan";
        taskUpdates.assignedMessengerName = "Belum Ditugaskan";
        taskUpdates.assignedMessengerId = undefined;
        taskUpdates.messengerTaskStatus = "Belum Diambil";
      } else if (canonicalTaskType === "Proses Samsat") {
        taskUpdates.samsatMessenger = "Belum Ditugaskan";
        taskUpdates.samsatMessengerNama = "Belum Ditugaskan";
        taskUpdates.samsatMessengerId = undefined;
        taskUpdates.messengerTaskStatus = "Belum Diambil";
      } else if (canonicalTaskType === "Jemput Hasil Samsat") {
        taskUpdates.samsatPickupMessenger = undefined;
        taskUpdates.samsatPickupMessengerNama = undefined;
        taskUpdates.samsatPickupMessengerId = undefined;
        taskUpdates.samsatPickupStatus = "Belum Dijadwal";
      } else if (canonicalTaskType === "Pengantaran Dokumen") {
        taskUpdates.messengerPengantar = "Belum Ditugaskan";
        (taskUpdates as any).deliveryMessengerId = undefined;
        taskUpdates.deliveryStatus = undefined;
        taskUpdates.messengerTaskStatus = "Belum Diambil";
      }

      dbOrderRepository.updateOrder(orderNo, taskUpdates);
      const updated = this.getByOrderNo(orderNo);

      dbAuditRepository.save({
        id: `log-task-decline-${Date.now()}`,
        userId: courierId,
        userName: courierName,
        userRole: (user.role as any) || "messenger",
        action: "DECLINE_TASK",
        module: "Messenger Task",
        details: `Kurir ${courierName} menolak tugas ${canonicalTaskType} pada order ${orderNo}`,
        metadata: { orderNo, taskType: canonicalTaskType, courierId, courierName },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Admin Reassigns Task (Alihkan Tugas Resmi dengan Catatan & Audit Log)
   */
  public reassignMessengerTask(
    orderNo: string,
    taskType: string,
    newCourierName: string,
    newCourierId: string,
    reason: string,
    adminUser: TokenPayload
  ): OperationalOrder {
    const actorRole = (adminUser?.role || "").toLowerCase();
    if (actorRole !== "administrator" && actorRole !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "Hanya Admin atau Administrator yang berwenang mengalihkan tugas.");
    }

    const canonicalTaskType = this.normalizeCanonicalTaskType(taskType);
    const nowIso = new Date().toISOString();
    const adminName = adminUser.nama || (adminUser as any).userName || "Admin Kantor";
    const cleanReason = (reason || "").trim();
    const cleanCourierId = String(newCourierId || "").trim();

    if (!cleanReason) {
      throw new ApiError(400, "REASON_REQUIRED", "Alasan pengalihan tugas wajib diisi.");
    }
    if (!cleanCourierId || ["-", "emp-msg", "emp-samsat", "belum ditugaskan"].includes(cleanCourierId.toLowerCase())) {
      throw new ApiError(400, "INVALID_COURIER", "ID kurir pengganti tidak valid.");
    }

    // Validate replacement courier against authoritative SQLite employees table
    const targetEmp = db
      .prepare("SELECT id, nama_lengkap, jabatan, status_karyawan FROM employees WHERE id = ?")
      .get(cleanCourierId) as { id: string; nama_lengkap: string; jabatan: string; status_karyawan: string } | undefined;

    if (!targetEmp) {
      throw new ApiError(400, "INVALID_COURIER", `Kurir pengganti '${cleanCourierId}' tidak ditemukan di data karyawan.`);
    }
    const normalizedEmpStatus = String(targetEmp.status_karyawan || "").trim().toLowerCase();
    if (!normalizedEmpStatus || ["nonaktif", "non-aktif", "tidak aktif", "resign", "berhenti", "inactive"].includes(normalizedEmpStatus)) {
      throw new ApiError(400, "INVALID_COURIER", `Kurir pengganti '${targetEmp.nama_lengkap}' tidak berstatus Aktif.`);
    }
    if (!String(targetEmp.jabatan || "").toLowerCase().includes("messenger")) {
      throw new ApiError(400, "INVALID_COURIER", `Karyawan '${targetEmp.nama_lengkap}' bukan Messenger.`);
    }

    const resolvedCourierName = (newCourierName && newCourierName.trim()) ? newCourierName.trim() : targetEmp.nama_lengkap;
    if (!resolvedCourierName) {
      throw new ApiError(400, "COURIER_REQUIRED", "Nama kurir pengganti wajib dipilih.");
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if ((existing as any).isArchived) {
        throw new ApiError(400, "ORDER_ARCHIVED", `Order '${orderNo}' sudah diarsipkan.`);
      }

      this.assertTaskNotCompleted(existing, canonicalTaskType);

      const currentAcceptance = (existing.taskAcceptance || {})[canonicalTaskType];
      const oldCourierId = this.getTaskAssignedCourierId(existing, canonicalTaskType);
      const oldCourier =
        currentAcceptance?.courierName ||
        (canonicalTaskType === "Proses Samsat"
          ? existing.samsatMessengerNama || existing.samsatMessenger
          : canonicalTaskType === "Jemput Hasil Samsat"
            ? existing.samsatPickupMessengerNama || existing.samsatPickupMessenger
            : canonicalTaskType === "Pengantaran Dokumen"
              ? existing.messengerPengantar
              : existing.assignedMessengerName || existing.messenger) ||
        "Kurir Sebelumnya";

      const prevHistory = Array.isArray((currentAcceptance as any)?.history) ? (currentAcceptance as any).history : [];
      const historyEntry = {
        action: "REASSIGNED",
        fromCourierId: oldCourierId,
        fromCourierName: oldCourier,
        toCourierId: cleanCourierId,
        toCourierName: resolvedCourierName,
        previousStatus: currentAcceptance?.status || "UNASSIGNED",
        reason: cleanReason,
        actorId: adminUser.userId || "usr-admin",
        actorName: adminName,
        actorRole: adminUser.role,
        timestamp: nowIso,
      };

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        [canonicalTaskType]: {
          status: "PENDING" as const,
          courierId: cleanCourierId,
          courierName: resolvedCourierName,
          isLocked: false,
          reassignedFrom: oldCourier,
          reassignReason: cleanReason,
          reassignedAt: nowIso,
          history: [...prevHistory, historyEntry],
        },
      };

      const taskUpdates: Partial<OperationalOrder> = {
        taskAcceptance: updatedAcceptance,
      };

      const timelineEvent: any = {
        id: `tl-reassign-${Date.now()}`,
        timestamp: nowIso,
        title: `Tugas ${canonicalTaskType} Dialihkan`,
        note: `Tugas dialihkan dari ${oldCourier} ke ${resolvedCourierName} oleh ${adminName}. Alasan: ${cleanReason}`,
        author: adminName,
        type: "ASSIGNMENT",
      };
      const existingTimeline = existing.messengerTimeline || [];
      taskUpdates.messengerTimeline = [timelineEvent, ...existingTimeline];

      if (canonicalTaskType === "Jemput Dokumen") {
        taskUpdates.messenger = resolvedCourierName;
        taskUpdates.assignedMessengerName = resolvedCourierName;
        taskUpdates.assignedMessengerId = cleanCourierId;
        taskUpdates.isScheduled = true;
      } else if (canonicalTaskType === "Proses Samsat") {
        taskUpdates.samsatMessenger = resolvedCourierName;
        taskUpdates.samsatMessengerNama = resolvedCourierName;
        taskUpdates.samsatMessengerId = cleanCourierId;
        taskUpdates.isSamsatScheduled = true;
      } else if (canonicalTaskType === "Jemput Hasil Samsat") {
        taskUpdates.samsatPickupMessenger = resolvedCourierName;
        taskUpdates.samsatPickupMessengerNama = resolvedCourierName;
        taskUpdates.samsatPickupMessengerId = cleanCourierId;
      } else if (canonicalTaskType === "Pengantaran Dokumen") {
        taskUpdates.messengerPengantar = resolvedCourierName;
        (taskUpdates as any).deliveryMessengerId = cleanCourierId;
        taskUpdates.isDeliveryScheduled = true;
      }

      dbOrderRepository.updateOrder(orderNo, taskUpdates);
      const updated = this.getByOrderNo(orderNo);

      dbAuditRepository.save({
        id: `log-task-reassign-${Date.now()}`,
        userId: adminUser.userId || "usr-admin",
        userName: adminName,
        userRole: (adminUser.role as any) || "admin",
        action: "REASSIGN_TASK",
        module: "Messenger Task",
        details: `Admin ${adminName} mengalihkan tugas ${canonicalTaskType} order ${orderNo} dari ${oldCourier} ke ${resolvedCourierName}. Alasan: ${cleanReason}`,
        metadata: {
          orderNo,
          taskType: canonicalTaskType,
          oldCourier,
          oldCourierId,
          newCourier: resolvedCourierName,
          newCourierId: cleanCourierId,
          previousStatus: currentAcceptance?.status || "UNASSIGNED",
          reason: cleanReason,
          actorName: adminName,
          actorRole: adminUser.role,
          timestamp: nowIso,
        },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Automatic Spawn: Jemput Dokumen Hasil Samsat dari Samsat ke Kantor
   * Automatically triggered when courier completes Samsat process
   */
  public autoSpawnSamsatResultPickup(orderNo: string, actorUser?: TokenPayload): OperationalOrder {
    const existing = this.getByOrderNo(orderNo);
    const nowIso = new Date().toISOString();
    const actorName = actorUser?.nama || "Sistem Otomasi";

    const updatedAcceptance = {
      ...(existing.taskAcceptance || {}),
      ["Jemput Hasil Samsat"]: {
        status: "PENDING" as const,
        isLocked: false,
      },
    };

    const timelineEvent: any = {
      id: `tl-autospawn-${Date.now()}`,
      timestamp: nowIso,
      title: "Tugas Otomatis: Jemput Hasil Samsat",
      note: "Sistem otomatis membuat tugas penjemputan berkas hasil Samsat ke kantor (tersedia bagi kurir).",
      author: actorName,
      type: "STATUS_CHANGE",
    };
    const existingTimeline = existing.messengerTimeline || [];

    const updates: Partial<OperationalOrder> = {
      samsatPickupStatus: "Belum Dijadwal",
      taskAcceptance: updatedAcceptance,
      messengerTimeline: [timelineEvent, ...existingTimeline],
    };

    return runInTransaction(() => {
      dbOrderRepository.updateOrder(orderNo, updates);
      return this.getByOrderNo(orderNo);
    });
  }

  /**
   * Messenger Starts Samsat Process (Scope 1)
   * Activates Samsat journey / process atomically with idempotency protection.
   */
  public startSamsatProcess(orderNo: string, user: TokenPayload): OperationalOrder {
    const courierName = user.nama || (user as any).userName || "Messenger Lapangan";
    const role = (user.role || "").toLowerCase();
    const courierId = role === "messenger" ? (user as any).employeeId : ((user as any).employeeId || user.userId);

    if (role === "messenger") {
      if (!courierId || courierId === "EMP-MSG" || courierId === "EMP-SAMSAT" || courierId === "Belum Ditugaskan" || courierId === "-") {
        throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak memiliki employeeId kanonikal.");
      }
    } else if (!courierId) {
      throw new ApiError(403, "FORBIDDEN", "Identitas pengguna tidak valid.");
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      // Check Stage and Cancellation
      assertValidSamsatStageAndStatus(existing);

      // Verify Messenger Assignment Ownership & Task Acceptance
      assertMessengerOwnership(existing, user, "SAMSAT");
      assertMessengerTaskAcceptanceValid(existing, "Proses Samsat", user);

      // 3. Completed Cycle Guard: Prevent restarting a completed cycle without new cycle (DEFECT-P2-01)
      const currentCycle = (existing as any).samsatCycle || 1;
      if (existing.samsatStatus === "Selesai" && (existing as any).samsatCompletedCycle === currentCycle) {
        throw new ApiError(
          400,
          "SAMSAT_ALREADY_COMPLETED",
          `Proses Samsat siklus ${currentCycle} untuk order '${orderNo}' sudah selesai. Gunakan alur rollback jika perlu pembetulan loket.`
        );
      }

      // Idempotency: If process is already started in this cycle, return existing
      if (
        existing.samsatStatus === "Sedang Proses Samsat" ||
        existing.samsatStatus === "Menuju Samsat" ||
        existing.samsatStatus === "Di Lokasi Samsat"
      ) {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const timelineEvent: any = {
        id: `tl-samsat-start-${Date.now()}`,
        timestamp: nowIso,
        title: "Mulai Proses Samsat",
        note: `Proses Samsat untuk ${existing.customer} (${existing.layanan}) dimulai oleh ${courierName}`,
        author: courierName,
        type: "STATUS_CHANGE",
      };

      const updates: Partial<OperationalOrder> = {
        samsatStatus: "Sedang Proses Samsat",
        samsatStartedAt: existing.samsatStartedAt || nowIso,
        samsatJourneyStartedAt: existing.samsatJourneyStartedAt || nowIso,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo);

      dbAuditRepository.save({
        id: `log-samsat-start-${Date.now()}`,
        userId: courierId,
        userName: courierName,
        userRole: (user.role as any) || "messenger",
        action: "START_SAMSAT_PROCESS",
        module: "Proses Samsat",
        details: `Petugas ${courierName} memulai proses Samsat order ${orderNo}`,
        metadata: { orderNo },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Atomic Samsat Process Completion (Scope 2, Scope 4)
   * Enforces component completion validation, idempotent retry, cycle differentiation,
   * and atomic auto-spawn of Jemput Hasil Samsat task.
   */
  public completeSamsatProcess(
    orderNo: string,
    payload: { note?: string } = {},
    user: TokenPayload
  ): OperationalOrder {
    const actorName = user.nama || (user as any).userName || "Petugas Samsat";
    const role = (user.role || "").toLowerCase();
    const actorId = role === "messenger" ? (user as any).employeeId : ((user as any).employeeId || user.userId);

    if (role === "messenger") {
      if (!actorId || actorId === "EMP-MSG" || actorId === "EMP-SAMSAT" || actorId === "Belum Ditugaskan" || actorId === "-") {
        throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak memiliki employeeId kanonikal.");
      }
      if (payload.note && typeof payload.note === "string" && payload.note.trim().length > 0) {
        throw new ApiError(
          400,
          "MESSENGER_NOTES_NOT_ALLOWED",
          "Catatan operasional bebas (free-text notes) tidak diizinkan pada penyelesaian Samsat."
        );
      }
    } else if (!actorId) {
      throw new ApiError(403, "FORBIDDEN", "Identitas pengguna tidak valid.");
    }
    const note = (payload.note || "").trim();

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      // Check Stage and Cancellation
      assertValidSamsatStageAndStatus(existing);

      // Verify Messenger Assignment Ownership & Task Acceptance
      assertMessengerOwnership(existing, user, "SAMSAT");
      assertMessengerTaskAcceptanceValid(existing, "Proses Samsat", user);

      // Track Samsat Cycle
      const currentCycle = (existing as any).samsatCycle || 1;

      // 1. Idempotency Check: Already completed in this cycle
      if (existing.samsatStatus === "Selesai" && (existing as any).samsatCompletedCycle === currentCycle) {
        return existing;
      }

      // 2. Component Completion Validation
      const valResult = validateSamsatCompletion(existing);
      if (!valResult.allowed) {
        throw new ApiError(
          400,
          valResult.code || "SAMSAT_COMPONENTS_INCOMPLETE",
          valResult.error || "Seluruh komponen loket Samsat wajib selesai sebelum menyelesaikan proses Samsat."
        );
      }

      const nowIso = new Date().toISOString();

      // Check if auto-spawn already exists for the CURRENT cycle
      const currentPickupTask = (existing.taskAcceptance || {})["Jemput Hasil Samsat"];
      const isSpawnedForCurrentCycle = Boolean(
        currentPickupTask && (currentPickupTask as any).cycle === currentCycle
      );

      const timelineEventsToPrepend: any[] = [];

      if (!isSpawnedForCurrentCycle) {
        timelineEventsToPrepend.push({
          id: `tl-spawn-pickup-c${currentCycle}-${Date.now()}`,
          timestamp: nowIso,
          title: "Tugas Otomatis: Jemput Hasil Samsat",
          note: "Sistem otomatis membuat tugas penjemputan berkas hasil Samsat ke kantor (tersedia bagi kurir).",
          author: "Sistem Otomasi",
          type: "STATUS_CHANGE",
        });
      }

      timelineEventsToPrepend.push({
        id: `tl-samsat-done-c${currentCycle}-${Date.now()}`,
        timestamp: nowIso,
        title: "Proses Samsat Selesai (Kirim Hasil)",
        note: "Seluruh tahapan komponen pengurusan di loket Samsat telah selesai diproses.",
        author: actorName,
        type: "STATUS_CHANGE",
      });

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Jemput Hasil Samsat"]: {
          status: "PENDING" as const,
          isLocked: false,
          spawnedAt: nowIso,
          cycle: currentCycle,
        },
      };

      const updates: Partial<OperationalOrder> = {
        samsatStatus: "Selesai",
        samsatCompletedAt: nowIso,
        samsatCompletedCycle: currentCycle,
        samsatPickupStatus: existing.samsatPickupStatus && existing.samsatPickupStatus !== "Belum Dijadwal"
          ? existing.samsatPickupStatus
          : "Belum Dijadwal",
        taskAcceptance: updatedAcceptance,
        messengerTaskNotes: existing.messengerTaskNotes,
        messengerTimeline: [...timelineEventsToPrepend, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo);

      dbAuditRepository.save({
        id: `log-samsat-complete-${Date.now()}`,
        userId: actorId,
        userName: actorName,
        userRole: (user.role as any) || "messenger",
        action: "COMPLETE_SAMSAT",
        module: "Proses Samsat",
        details: `Pengurusan Samsat order ${orderNo} diselesaikan oleh ${actorName}`,
        metadata: { orderNo, cycle: currentCycle },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Messenger Starts Pickup Task (Scope A)
   * Activates pickup process atomically with idempotency protection.
   */
  public startPickupTask(orderNo: string, user: TokenPayload): OperationalOrder {
    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      // 1. Stage and Cancellation Guard
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if (existing.currentStep !== 2 && existing.currentStageName !== "Penjadwalan") {
        throw new ApiError(400, "INVALID_STAGE", `Tugas penjemputan berkas hanya dapat dimulai pada Step 2 (Penjadwalan), tahapan saat ini adalah Step ${existing.currentStep} (${existing.currentStageName}).`);
      }

      // 2. Ownership & Role Guard
      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "PICKUP");

      // 3. Idempotency Check
      if (existing.messengerTaskStatus === "Sedang Dijemput" || existing.pickupCompleted) {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const timelineEvent: any = {
        id: `tl-pickup-start-${Date.now()}`,
        timestamp: nowIso,
        title: "Mulai Penjemputan Dokumen",
        note: `Penjemputan berkas dari pelanggan ${existing.customer} (${existing.nomorHP || '-'}) dimulai oleh kurir ${messengerName}`,
        author: messengerName,
        type: "STATUS_CHANGE",
      };

      const updates: Partial<OperationalOrder> = {
        messengerTaskStatus: "Sedang Dijemput",
        startedAt: existing.startedAt || nowIso,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-pickup-start-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "START_TASK",
        module: "Penjemputan Dokumen",
        details: `Kurir ${messengerName} memulai tugas penjemputan berkas order ${orderNo}`,
        metadata: { orderNo, taskType: "Jemput Dokumen" },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Completes Pickup Task (Scope B)
   */
  public completePickupTask(
    orderNo: string,
    payload: { checklist?: Record<string, boolean>; photoUrl?: string; notes?: string; note?: string },
    user: TokenPayload
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    if (role === "messenger") {
      const pNote = (payload.notes || payload.note || "").trim();
      if (pNote.length > 0) {
        throw new ApiError(
          400,
          "MESSENGER_NOTES_NOT_ALLOWED",
          "Catatan operasional bebas (free-text notes) tidak diizinkan pada penyelesaian penjemputan berkas."
        );
      }
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if (existing.currentStep !== 2 && existing.currentStageName !== "Penjadwalan") {
        throw new ApiError(400, "INVALID_STAGE", `Tugas penjemputan berkas hanya dapat diselesaikan pada Step 2 (Penjadwalan).`);
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "PICKUP");

      // Idempotency: If already completed, return existing
      if (existing.pickupCompleted && existing.messengerTaskStatus === "Dokumen Sudah Tersedia") {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const finalChecklist = { ...(existing.pickupChecklist || {}), ...(payload.checklist || {}) };

      const timelineEvent: any = {
        id: `tl-pickup-done-${Date.now()}`,
        timestamp: nowIso,
        title: "Penjemputan Berkas Selesai",
        note: `Berkas fisik dari pelanggan ${existing.customer} telah dijemput dan dibawa oleh kurir ${messengerName}`,
        author: messengerName,
        type: "STATUS_CHANGE",
      };

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Jemput Dokumen"]: {
          status: "COMPLETED" as const,
          completedAt: nowIso,
          courierId: messengerId,
          courierName: messengerName,
          isLocked: true,
        },
      };

      const updates: Partial<OperationalOrder> = {
        pickupCompleted: true,
        pickupCompletedAt: existing.pickupCompletedAt || nowIso,
        messengerTaskStatus: "Dokumen Sudah Tersedia",
        pickupChecklist: finalChecklist,
        pickupProof: payload.photoUrl
          ? (typeof existing.pickupProof === "object" && existing.pickupProof !== null
              ? { ...existing.pickupProof, photoProofUrl: payload.photoUrl, completedAt: nowIso }
              : { photoProofUrl: payload.photoUrl, completedAt: nowIso })
          : existing.pickupProof,
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-pickup-done-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "COMPLETE_TASK",
        module: "Penjemputan Dokumen",
        details: `Kurir ${messengerName} menyelesaikan tugas penjemputan berkas order ${orderNo}`,
        metadata: { orderNo, taskType: "Jemput Dokumen" },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Releases Pickup Task back to Team Pool (Scope C Handover)
   */
  public releasePickupTask(
    orderNo: string,
    user: TokenPayload,
    notes?: string
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    const cleanNotes = (notes || "").trim();
    if (role === "messenger" && cleanNotes.length > 0) {
      throw new ApiError(
        400,
        "MESSENGER_NOTES_NOT_ALLOWED",
        "Catatan operasional bebas (free-text notes) tidak diizinkan pada penyerahan tugas."
      );
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "PICKUP");

      const nowIso = new Date().toISOString();

      const timelineEvent: any = {
        id: `tl-pickup-release-${Date.now()}`,
        timestamp: nowIso,
        title: "Tugas Penjemputan Diserahkan ke Tim",
        note: `Tugas penjemputan dikembalikan ke pool antrean oleh kurir ${messengerName}.`,
        author: messengerName,
        type: "ASSIGNMENT",
      };

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Jemput Dokumen"]: {
          status: "PENDING" as const,
          isLocked: false,
          releasedAt: nowIso,
          releasedBy: messengerName,
        },
      };

      const updates: Partial<OperationalOrder> = {
        messenger: "Belum Ditugaskan",
        assignedMessengerName: "Belum Ditugaskan",
        assignedMessengerId: undefined,
        messengerTaskStatus: "Belum Diambil",
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-pickup-release-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "RELEASE_TASK",
        module: "Penjemputan Dokumen",
        details: `Tugas penjemputan berkas order ${orderNo} diserahkan ke tim oleh ${messengerName}`,
        metadata: { orderNo, taskType: "Jemput Dokumen" },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Messenger Starts Delivery Task (Scope A)
   */
  public startDeliveryTask(orderNo: string, user: TokenPayload): OperationalOrder {
    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if (existing.currentStep !== 7 && existing.currentStageName !== "Pengantaran") {
        throw new ApiError(400, "INVALID_STAGE", `Tugas pengantaran berkas hanya dapat dimulai pada Step 7 (Pengantaran), tahapan saat ini adalah Step ${existing.currentStep} (${existing.currentStageName}).`);
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "DELIVERY");

      // Idempotency
      if (existing.deliveryStatus === "Sedang Diantar" || existing.deliveryStatus === "Dokumen Diserahkan") {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const timelineEvent: any = {
        id: `tl-delivery-start-${Date.now()}`,
        timestamp: nowIso,
        title: "Mulai Pengantaran Dokumen",
        note: `Pengantaran berkas hasil kepada pelanggan ${existing.customer} (${existing.alamatPengantaran || '-'}) dimulai oleh kurir ${messengerName}`,
        author: messengerName,
        type: "STATUS_CHANGE",
      };

      const updates: Partial<OperationalOrder> = {
        deliveryStatus: "Sedang Diantar",
        deliveryStartedAt: existing.deliveryStartedAt || nowIso,
        messengerTaskStatus: "Dalam Proses",
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-delivery-start-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "START_TASK",
        module: "Pengantaran Dokumen",
        details: `Kurir ${messengerName} memulai tugas pengantaran berkas order ${orderNo}`,
        metadata: { orderNo, taskType: "Pengantaran Dokumen" },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Completes Delivery Task (Scope B)
   */
  public completeDeliveryTask(
    orderNo: string,
    payload: { receiverName: string; photoUrl?: string; notes?: string; note?: string },
    user: TokenPayload
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    if (role === "messenger") {
      const pNote = (payload.notes || payload.note || "").trim();
      if (pNote.length > 0) {
        throw new ApiError(
          400,
          "MESSENGER_NOTES_NOT_ALLOWED",
          "Catatan operasional bebas (free-text notes) tidak diizinkan pada penyelesaian pengantaran berkas."
        );
      }
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if (existing.currentStep !== 7 && existing.currentStageName !== "Pengantaran") {
        throw new ApiError(400, "INVALID_STAGE", `Tugas pengantaran berkas hanya dapat diselesaikan pada Step 7 (Pengantaran).`);
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "DELIVERY");

      const cleanReceiver = (payload.receiverName || (payload as any).recipientName || "").trim();
      if (!cleanReceiver) {
        throw new ApiError(400, "RECIPIENT_REQUIRED", "Nama penerima dokumen wajib diisi sebelum menyelesaikan pengantaran.");
      }

      // Idempotency: If already completed, return existing
      if (existing.deliveryStatus === "Dokumen Diserahkan" && existing.isReceived) {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const currentDeliveryAcc = (existing.taskAcceptance || {})["Pengantaran Dokumen"] as any;
      const prevDeliveryHistory = Array.isArray(currentDeliveryAcc?.history) ? currentDeliveryAcc.history : [];
      const timelineEvent: any = {
        id: `tl-delivery-done-${Date.now()}`,
        timestamp: nowIso,
        title: "Pengantaran Berkas Selesai",
        note: `Berkas telah diserahkan dan diterima oleh ${cleanReceiver}. Pengantaran selesai oleh kurir ${messengerName}`,
        author: messengerName,
        type: "STATUS_CHANGE",
      };

      const resolvedPhoto = payload.photoUrl || existing.deliveryProof;
      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Pengantaran Dokumen"]: {
          status: "COMPLETED" as const,
          completedAt: nowIso,
          courierId: messengerId,
          courierName: messengerName,
          isLocked: true,
          history: [
            ...prevDeliveryHistory,
            { action: "COMPLETED", courierId: messengerId, courierName: messengerName, receiverName: cleanReceiver, timestamp: nowIso },
          ],
        },
      };

      const updates: Partial<OperationalOrder> = {
        deliveryStatus: "Dokumen Diserahkan",
        messengerTaskStatus: "Selesai",
        deliveryCompletedAt: existing.deliveryCompletedAt || nowIso,
        receiverName: cleanReceiver,
        tanggalDiterima: existing.tanggalDiterima || normalizeToWibCalendarDate(nowIso) || nowIso.split("T")[0],
        isReceived: true,
        deliveryProof: resolvedPhoto,
        deliveryHandover: {
          ...(existing.deliveryHandover || {}),
          recipientName: cleanReceiver,
          relationship: existing.deliveryHandover?.relationship || (payload as any).relationship || "Pemilik Langsung",
          photoProofUrl: resolvedPhoto,
          completedAt: existing.deliveryCompletedAt || nowIso,
        },
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-delivery-done-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "COMPLETE_TASK",
        module: "Pengantaran Dokumen",
        details: `Kurir ${messengerName} menyelesaikan pengantaran berkas order ${orderNo} kepada ${cleanReceiver}`,
        metadata: { orderNo, taskType: "Pengantaran Dokumen", receiverName: cleanReceiver },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Releases Delivery Task back to Team Pool (Scope C Handover)
   */
  public releaseDeliveryTask(
    orderNo: string,
    user: TokenPayload,
    notes?: string
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    const cleanNotes = (notes || "").trim();
    if (role === "messenger" && cleanNotes.length > 0) {
      throw new ApiError(
        400,
        "MESSENGER_NOTES_NOT_ALLOWED",
        "Catatan operasional bebas (free-text notes) tidak diizinkan pada penyerahan tugas."
      );
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "DELIVERY");

      const nowIso = new Date().toISOString();

      const timelineEvent: any = {
        id: `tl-delivery-release-${Date.now()}`,
        timestamp: nowIso,
        title: "Tugas Pengantaran Diserahkan ke Tim",
        note: `Tugas pengantaran dikembalikan ke pool antrean oleh kurir ${messengerName}.`,
        author: messengerName,
        type: "ASSIGNMENT",
      };

      const currentDelivAcc = (existing.taskAcceptance || {})["Pengantaran Dokumen"] as any;
      const prevDelivReleaseHistory = Array.isArray(currentDelivAcc?.history) ? currentDelivAcc.history : [];
      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Pengantaran Dokumen"]: {
          status: "PENDING" as const,
          isLocked: false,
          releasedAt: nowIso,
          releasedBy: messengerName,
          history: [
            ...prevDelivReleaseHistory,
            { action: "RELEASED", courierId: messengerId, courierName: messengerName, timestamp: nowIso },
          ],
        },
      };

      const updates: Partial<OperationalOrder> = {
        messengerPengantar: undefined,
        deliveryMessengerId: undefined,
        deliveryStatus: undefined,
        messengerTaskStatus: "Belum Diambil",
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-delivery-release-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "RELEASE_TASK",
        module: "Pengantaran Dokumen",
        details: `Tugas pengantaran berkas order ${orderNo} diserahkan ke tim oleh ${messengerName}`,
        metadata: { orderNo, taskType: "Pengantaran Dokumen", releasedById: messengerId, releasedByName: messengerName },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Releases Samsat Task back to Team Pool (Scope C Handover)
   */
  public releaseSamsatTask(
    orderNo: string,
    user: TokenPayload,
    notes?: string
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    const cleanNotes = (notes || "").trim();
    if (role === "messenger" && cleanNotes.length > 0) {
      throw new ApiError(
        400,
        "MESSENGER_NOTES_NOT_ALLOWED",
        "Catatan operasional bebas (free-text notes) tidak diizinkan pada penyerahan tugas."
      );
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if ((existing as any).isArchived) {
        throw new ApiError(400, "ORDER_ARCHIVED", `Order '${orderNo}' sudah diarsipkan.`);
      }
      if (existing.samsatStatus === "Selesai") {
        throw new ApiError(400, "TASK_ALREADY_COMPLETED", `Proses Samsat untuk order '${orderNo}' sudah selesai dan tidak dapat diserahkan.`);
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "SAMSAT");
      const nowIso = new Date().toISOString();

      const timelineEvent: any = {
        id: `tl-samsat-release-${Date.now()}`,
        timestamp: nowIso,
        title: "Tugas Samsat Diserahkan ke Tim",
        note: `Tugas pengurusan Samsat dikembalikan ke pool antrean oleh kurir ${messengerName}. Progres komponen tetap tersimpan.`,
        author: messengerName,
        type: "ASSIGNMENT",
      };

      const currentSamsatAcc = (existing.taskAcceptance || {})["Proses Samsat"] as any;
      const prevSamsatHistory = Array.isArray(currentSamsatAcc?.history) ? currentSamsatAcc.history : [];
      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Proses Samsat"]: {
          status: "PENDING" as const,
          isLocked: false,
          releasedAt: nowIso,
          releasedBy: messengerName,
          history: [
            ...prevSamsatHistory,
            { action: "RELEASED", courierId: messengerId, courierName: messengerName, timestamp: nowIso },
          ],
        },
      };

      const updates: Partial<OperationalOrder> = {
        samsatMessenger: "Belum Ditugaskan",
        samsatMessengerNama: "Belum Ditugaskan",
        samsatMessengerId: undefined,
        samsatStatus: existing.samsatStatus === "Sedang Proses Samsat" || existing.samsatStatus === "Menuju Samsat" || existing.samsatStatus === "Di Lokasi Samsat"
          ? "Terjadwal Samsat"
          : existing.samsatStatus,
        messengerTaskStatus: "Belum Diambil",
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-samsat-release-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "RELEASE_TASK",
        module: "Proses Samsat",
        details: `Tugas Proses Samsat order ${orderNo} diserahkan ke tim oleh ${messengerName}`,
        metadata: { orderNo, taskType: "Proses Samsat", releasedById: messengerId, releasedByName: messengerName },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * PHASE 4: Report Kendala on Jemput Hasil Samsat
   * - Authorized for assigned Messenger or Admin
   * - Sets structured status to "Terkendala"
   * - Strictly NO free-text order.catatanKendala pollution
   * - Idempotent
   */
  public reportSamsatPickupKendala(
    orderNo: string,
    user: TokenPayload,
    payload?: { note?: string; notes?: string; catatanKendala?: string }
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    if (role === "messenger" && payload) {
      const pNote = (payload.notes || payload.note || payload.catatanKendala || "").trim();
      if (pNote.length > 0) {
        throw new ApiError(
          400,
          "MESSENGER_NOTES_NOT_ALLOWED",
          "Catatan operasional bebas (free-text notes) tidak diizinkan pada pelaporan kendala jemput hasil."
        );
      }
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if (existing.currentStep !== 4 && existing.currentStageName !== "Proses Samsat") {
        throw new ApiError(400, "INVALID_STAGE", `Kendala penjemputan hasil Samsat hanya dapat dilaporkan pada Step 4 (Proses Samsat).`);
      }
      if (existing.samsatStatus !== "Selesai") {
        throw new ApiError(400, "SAMSAT_NOT_COMPLETED", `Proses pengurusan Samsat belum selesai.`);
      }

      const currentCycle = (existing as any).samsatCycle || 1;
      const pickupTaskAcc = (existing.taskAcceptance || {})["Jemput Hasil Samsat"];
      if (pickupTaskAcc?.status === "SUPERSEDED") {
        throw new ApiError(400, "TASK_SUPERSEDED", "Tugas Jemput Hasil Samsat ini sudah tidak berlaku (superseded) karena proses Samsat di-rollback.");
      }
      if (pickupTaskAcc?.cycle && pickupTaskAcc.cycle !== currentCycle) {
        throw new ApiError(400, "TASK_SUPERSEDED", `Tugas Jemput Hasil Samsat berasal dari cycle lama (Cycle ${pickupTaskAcc.cycle}), cycle aktif adalah Cycle ${currentCycle}.`);
      }

      if (existing.samsatPickupStatus === "Dokumen Samsat Diterima di Kantor") {
        throw new ApiError(400, "INVALID_STATE", "Tugas penjemputan hasil Samsat sudah selesai diserahkan ke kantor.");
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "SAMSAT_PICKUP");

      // Idempotency: If already Terkendala, return existing without duplicate log
      if (existing.samsatPickupStatus === "Terkendala") {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const timelineEvent: any = {
        id: `tl-kendala-pickup-${Date.now()}`,
        timestamp: nowIso,
        title: "Kendala Jemput Hasil Samsat",
        note: "Kurir melaporkan kendala pada penjemputan berkas hasil Samsat. Menunggu instruksi atau recovery dari Admin/Supervisor.",
        author: messengerName,
        type: "STATUS_CHANGE",
      };

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Jemput Hasil Samsat"]: {
          ...pickupTaskAcc,
          hasKendala: true,
          kendalaAt: nowIso,
          cycle: currentCycle,
        },
      };

      const updates: Partial<OperationalOrder> = {
        samsatPickupStatus: "Terkendala",
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-samsat-pickup-kendala-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "SAMSAT_PICKUP_KENDALA",
        module: "Jemput Hasil Samsat",
        details: `Petugas ${messengerName} melaporkan kendala pada penjemputan berkas hasil Samsat order ${orderNo}`,
        metadata: { orderNo, cycle: currentCycle },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * PHASE 4: Recover Kendala on Jemput Hasil Samsat
   * - STRICTLY authorized for Admin / SVP role
   * - Messenger calling this receives HTTP 403 FORBIDDEN
   * - Restores samsatPickupStatus to "Sedang Jemput Dokumen Samsat"
   * - Preserves messenger assignment
   */
  public recoverSamsatPickupKendala(orderNo: string, user: TokenPayload): OperationalOrder {
    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      const role = (user.role || "").toLowerCase();
      const isAdmin = role === "administrator" || role === "admin";
      if (!isAdmin) {
        throw new ApiError(403, "FORBIDDEN", "Hanya Admin atau Supervisor yang berwenang memulihkan status Kendala Jemput Hasil.");
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if (existing.currentStep !== 4 && existing.currentStageName !== "Proses Samsat") {
        throw new ApiError(400, "INVALID_STAGE", `Pemulihan kendala penjemputan hasil Samsat hanya dapat dilakukan pada Step 4 (Proses Samsat).`);
      }

      const adminName = user.nama || (user as any).userName || "Admin Operasional";
      const adminId = (user as any).employeeId || user.userId || "EMP-ADMIN";

      // Idempotency: If already back to Sedang Jemput, return existing
      if (existing.samsatPickupStatus === "Sedang Jemput Dokumen Samsat") {
        return existing;
      }
      if (existing.samsatPickupStatus !== "Terkendala") {
        throw new ApiError(400, "INVALID_STATE", `Order '${orderNo}' tidak dalam status Terkendala (status saat ini: '${existing.samsatPickupStatus || "Normal"}').`);
      }

      const nowIso = new Date().toISOString();
      const pickupTaskAcc = (existing.taskAcceptance || {})["Jemput Hasil Samsat"];

      const timelineEvent: any = {
        id: `tl-recover-pickup-${Date.now()}`,
        timestamp: nowIso,
        title: "Kendala Jemput Hasil Dipulihkan",
        note: "Status kendala penjemputan berkas hasil Samsat telah diselesaikan dan dipulihkan oleh Admin/Supervisor. Penjemputan dilanjutkan.",
        author: adminName,
        type: "STATUS_CHANGE",
      };

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Jemput Hasil Samsat"]: {
          ...pickupTaskAcc,
          hasKendala: false,
          recoveredAt: nowIso,
          recoveredBy: adminName,
        },
      };

      const updates: Partial<OperationalOrder> = {
        samsatPickupStatus: "Sedang Jemput Dokumen Samsat",
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-samsat-pickup-recover-${Date.now()}`,
        userId: adminId,
        userName: adminName,
        userRole: (user.role as any) || "admin",
        action: "SAMSAT_PICKUP_RECOVERED",
        module: "Jemput Hasil Samsat",
        details: `Admin ${adminName} memulihkan kendala penjemputan berkas hasil Samsat order ${orderNo}`,
        metadata: { orderNo },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * PHASE 4: Complete Jemput Hasil Samsat (Dokumen Diserahkan ke Kantor)
   * - Handover berkas dari Samsat ke Kantor
   * - Validates cycle isolation and blocks if Terkendala
   * - Does NOT automatically advance to Step 5 (Verifikasi Biaya remains under Admin control)
   * - Idempotent
   */
  public completeSamsatPickupTask(
    orderNo: string,
    user: TokenPayload,
    payload?: { note?: string; notes?: string }
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    if (role === "messenger" && payload) {
      const pNote = (payload.notes || payload.note || "").trim();
      if (pNote.length > 0) {
        throw new ApiError(
          400,
          "MESSENGER_NOTES_NOT_ALLOWED",
          "Catatan operasional bebas (free-text notes) tidak diizinkan pada penyerahan hasil Samsat."
        );
      }
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if (existing.currentStep !== 4 && existing.currentStageName !== "Proses Samsat") {
        throw new ApiError(400, "INVALID_STAGE", `Penyerahan hasil Samsat hanya dapat dilakukan pada Step 4 (Proses Samsat).`);
      }
      if (existing.samsatStatus !== "Selesai") {
        throw new ApiError(400, "SAMSAT_NOT_COMPLETED", `Proses pengurusan Samsat belum selesai.`);
      }

      const currentCycle = (existing as any).samsatCycle || 1;
      const pickupTaskAcc = (existing.taskAcceptance || {})["Jemput Hasil Samsat"];
      if (pickupTaskAcc?.status === "SUPERSEDED") {
        throw new ApiError(400, "TASK_SUPERSEDED", "Tugas Jemput Hasil Samsat ini sudah tidak berlaku (superseded) karena proses Samsat di-rollback.");
      }
      if (pickupTaskAcc?.cycle && pickupTaskAcc.cycle !== currentCycle) {
        throw new ApiError(400, "TASK_SUPERSEDED", `Tugas Jemput Hasil Samsat berasal dari cycle lama (Cycle ${pickupTaskAcc.cycle}), cycle aktif adalah Cycle ${currentCycle}.`);
      }

      if (existing.samsatPickupStatus === "Terkendala") {
        throw new ApiError(400, "TASK_TERKENDALA", "Tugas masih dalam kondisi Terkendala. Harap selesaikan kendala melalui Admin sebelum menyerahkan dokumen.");
      }

      const { messengerId, messengerName } = assertMessengerOwnership(existing, user, "SAMSAT_PICKUP");

      // Idempotency: If already completed, return existing
      if (existing.samsatPickupStatus === "Dokumen Samsat Diterima di Kantor") {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const timelineEvent: any = {
        id: `tl-pickup-done-office-${Date.now()}`,
        timestamp: nowIso,
        title: "Dokumen Hasil Samsat Diterima di Kantor",
        note: `Berkas hasil proses Samsat telah diserahkan oleh kurir ${messengerName} dan diterima di kantor.`,
        author: messengerName,
        type: "STATUS_CHANGE",
      };

      const updatedAcceptance = {
        ...(existing.taskAcceptance || {}),
        ["Jemput Hasil Samsat"]: {
          ...pickupTaskAcc,
          status: "COMPLETED" as const,
          completedAt: nowIso,
          completedBy: messengerName,
          completedById: messengerId,
          courierId: messengerId,
          courierName: messengerName,
          isLocked: true,
          cycle: currentCycle,
        },
      };

      const updates: Partial<OperationalOrder> = {
        samsatPickupStatus: "Dokumen Samsat Diterima di Kantor",
        samsatPickupCompletedAt: existing.samsatPickupCompletedAt || nowIso,
        taskAcceptance: updatedAcceptance,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-samsat-pickup-complete-${Date.now()}`,
        userId: messengerId,
        userName: messengerName,
        userRole: (user.role as any) || "messenger",
        action: "COMPLETE_TASK",
        module: "Jemput Hasil Samsat",
        details: `Petugas ${messengerName} menyerahkan berkas hasil proses Samsat order ${orderNo} ke kantor`,
        metadata: { orderNo, cycle: currentCycle },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Dedicated Cost Verification Endpoint (Phase 2 & Phase 3)
   * Strictly authorized for Administrator / Admin / SVP.
   * Client cannot tamper with protected fields (costVerifiedBy, isCostVerified).
   * Validates consistency between component breakdown and final total.
   * Preserves costSnapshot immutability.
   * Updates order cost completeness and marks invoice verified.
   */
  public verifyOrderCost(
    orderNo: string,
    payload: { finalBiayaSamsat: number; finalTotalBiaya?: number; notes?: string; [key: string]: any },
    user?: TokenPayload | any
  ): OperationalOrder {
    if (
      payload.costVerifiedBy !== undefined ||
      payload.isCostVerified !== undefined ||
      (payload as any).costCompletenessStatus !== undefined
    ) {
      throw new ApiError(403, "FORBIDDEN_PROPERTY", "Field costVerifiedBy cannot be modified via client request.");
    }

    const role = (user?.role || "").toLowerCase();
    const isAuthorized = role === "administrator" || role === "admin";
    if (!isAuthorized) {
      throw new ApiError(403, "FORBIDDEN", "Hanya Administrator atau Supervisor yang berwenang memverifikasi biaya order.");
    }

    if (payload.finalBiayaSamsat === undefined || typeof payload.finalBiayaSamsat !== "number" || payload.finalBiayaSamsat < 0) {
      throw new ApiError(400, "INVALID_COST_PAYLOAD", "Biaya Samsat final wajib berupa angka non-negatif.");
    }

    if (payload.notes !== undefined && typeof payload.notes !== "string") {
      throw new ApiError(400, "INVALID_NOTES", "Catatan verifikasi biaya harus berupa teks.");
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      if (
        existing.isCancelled ||
        existing.currentStageName === "Dibatalkan" ||
        (existing as any).status === "Dibatalkan"
      ) {
        throw new ApiError(
          400,
          "ORDER_CANCELLED",
          `Order '${orderNo}' telah dibatalkan dan tidak dapat dilakukan verifikasi biaya.`
        );
      }

      const expectedTotal = (existing.biayaJasa || 0) + (existing.biayaAntarJemput || 0) + payload.finalBiayaSamsat;
      if (payload.finalTotalBiaya !== undefined && payload.finalTotalBiaya !== expectedTotal) {
        throw new ApiError(400, "INCONSISTENT_COST_PAYLOAD", `Total biaya ${payload.finalTotalBiaya} tidak konsisten dengan komponen biaya (${expectedTotal}).`);
      }

      const updatedTotalBiaya = payload.finalTotalBiaya !== undefined ? payload.finalTotalBiaya : expectedTotal;
      const existingPayment = existing.payment || {
        totalBiaya: 0,
        dibayar: 0,
        kurang: 0,
        statusPembayaran: "Belum Lunas" as const,
        tipePembayaran: "Bayar di Akhir" as const,
        metodePembayaran: "Cash",
      };
      const currentDibayar = Number(existingPayment.dibayar || 0);
      const kurang = Math.max(0, updatedTotalBiaya - currentDibayar);
      const statusPembayaran = currentDibayar >= updatedTotalBiaya && updatedTotalBiaya > 0
        ? "Lunas"
        : currentDibayar > 0
        ? "Kurang Bayar"
        : "Belum Lunas";

      const verifierName = user?.nama || (user as any)?.userName || "Admin";
      const nowIso = new Date().toISOString();

      const updates: Partial<OperationalOrder> = {
        isCostVerified: true,
        costCompletenessStatus: "VERIFIED",
        costVerifiedAt: nowIso,
        costVerifiedBy: verifierName,
        biayaSamsat: payload.finalBiayaSamsat,
        finalCost: updatedTotalBiaya,
        totalEstimasi: updatedTotalBiaya,
        payment: {
          ...existingPayment,
          totalBiaya: updatedTotalBiaya,
          kurang,
          statusPembayaran: statusPembayaran as any,
        } as any,
      };

      const isCostAnomaly = updatedTotalBiaya > 0 && payload.finalBiayaSamsat > updatedTotalBiaya;
      if (isCostAnomaly) {
        updates.isFinancialAnomaly = true;
        updates.financialAnomalyReason = "BIAYA_SAMSAT_MELEBIHI_TAGIHAN";
      } else {
        updates.isFinancialAnomaly = false;
        updates.financialAnomalyReason = undefined;
      }

      dbOrderRepository.updateOrder(orderNo, updates);

      const existingInvoice = dbFinanceRepository.getInvoiceByOrderNo(orderNo);
      if (existingInvoice) {
        const invDibayar = Number(existingInvoice.dibayar || 0);
        const invSisa = Math.max(0, updatedTotalBiaya - invDibayar);
        const invStatus = invDibayar >= updatedTotalBiaya && updatedTotalBiaya > 0 ? "PAID" : invDibayar > 0 ? "PARTIAL" : "UNPAID";
        dbFinanceRepository.saveInvoice({
          ...existingInvoice,
          totalTagihan: updatedTotalBiaya,
          biayaSamsat: payload.finalBiayaSamsat,
          sisa: invSisa,
          status: invStatus,
          costVerificationStatus: "VERIFIED",
          isDraftEstimate: false,
          invoiceNo: existingInvoice.invoiceNo,
          orderNo: existingInvoice.orderNo,
        } as any);
      }

      dbAuditRepository.save({
        id: `log-verify-cost-${Date.now()}`,
        userId: user?.userId || "usr-admin",
        userName: verifierName,
        userRole: (user?.role as any) || "administrator",
        action: "VERIFY_ORDER_COST",
        module: "Finance",
        details: `Biaya order ${orderNo} diverifikasi oleh ${verifierName}. Total: ${updatedTotalBiaya}`,
        metadata: { orderNo, finalBiayaSamsat: payload.finalBiayaSamsat, finalTotalBiaya: updatedTotalBiaya, notes: payload.notes },
        createdAt: nowIso,
      });

      return this.getByOrderNo(orderNo)!;
    });
  }

  /**
   * Dedicated Samsat Subprogress & Component Start Endpoint Service (Phase 2 Remediation)
   * Eliminates generic PUT /orders/:orderNo mutation containing protected `samsatStatus`.
   * Enforces Stage 4, active Samsat process, ownership, idempotency, and audit trail.
   */
  public updateSamsatSubprogress(
    orderNo: string,
    payload: {
      subprogress?: string;
      componentId?: string;
      componentUpdate?: {
        name?: string;
        category?: string;
        masterPrice?: number;
        nominal?: number;
        actualOrderPrice?: number;
        isCustom?: boolean;
        status?: string;
        estimatedDurationMinutes?: number;
        isCustomDuration?: boolean;
        customDurationDays?: number;
        startedAt?: string;
        waitingReason?: string;
        note?: string;
      };
      note?: string;
      notes?: string;
    },
    user: TokenPayload
  ): OperationalOrder {
    const role = (user.role || "").toLowerCase();
    const courierName = user.nama || (user as any).userName || "Messenger Lapangan";
    const courierId = role === "messenger" ? (user as any).employeeId : ((user as any).employeeId || user.userId);

    if (role === "messenger") {
      if (!courierId || courierId === "EMP-MSG" || courierId === "EMP-SAMSAT" || courierId === "Belum Ditugaskan" || courierId === "-") {
        throw new ApiError(403, "FORBIDDEN", "Identitas kurir tidak valid atau tidak memiliki employeeId kanonikal.");
      }
      const freeNote = (payload.note || payload.notes || payload.componentUpdate?.note || "").trim();
      if (freeNote.length > 0) {
        throw new ApiError(
          400,
          "MESSENGER_NOTES_NOT_ALLOWED",
          "Catatan operasional bebas (free-text notes) tidak diizinkan pada progres komponen Samsat."
        );
      }
    } else if (!courierId) {
      throw new ApiError(403, "FORBIDDEN", "Identitas pengguna tidak valid.");
    }

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }

      assertValidSamsatStageAndStatus(existing);
      assertMessengerOwnership(existing, user, "SAMSAT");
      assertMessengerTaskAcceptanceValid(existing, "Proses Samsat", user);

      const currentCycle = (existing as any).samsatCycle || 1;
      if (existing.samsatStatus === "Selesai" && (existing as any).samsatCompletedCycle === currentCycle) {
        throw new ApiError(
          400,
          "SAMSAT_ALREADY_COMPLETED",
          `Proses Samsat siklus ${currentCycle} untuk order '${orderNo}' sudah selesai.`
        );
      }

      const isSamsatStarted =
        existing.samsatStatus === "Sedang Proses Samsat" ||
        existing.samsatStatus === "Menuju Samsat" ||
        existing.samsatStatus === "Di Lokasi Samsat";
      if (!isSamsatStarted) {
        throw new ApiError(
          400,
          "SAMSAT_NOT_STARTED",
          `Proses Samsat pada order '${orderNo}' belum dimulai. Tekan 'Mulai Proses Samsat' terlebih dahulu.`
        );
      }

      const rawSubprogress = (payload.subprogress || payload.componentUpdate?.name || "").trim();
      if (!rawSubprogress) {
        throw new ApiError(400, "VALIDATION_ERROR", "Nama subprogress atau komponen Samsat wajib diisi.");
      }
      const formattedSubstatus = rawSubprogress.startsWith("Sedang ")
        ? rawSubprogress
        : `Sedang ${rawSubprogress}`;

      const nowIso = new Date().toISOString();
      const updates: Partial<OperationalOrder> = {
        samsatSubstatus: formattedSubstatus,
        currentSamsatProcess: formattedSubstatus,
      };
      const timelineEvents: any[] = [];

      let componentChanged = false;
      if (payload.componentId && payload.componentUpdate) {
        const compUpd = payload.componentUpdate;
        if (compUpd.status === "WAITING" && (!compUpd.waitingReason || !compUpd.waitingReason.trim())) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Alasan menunggu wajib diisi saat mengubah status komponen ke Menunggu."
          );
        }

        const currentMap: Record<string, any> = { ...((existing as any).messengerComponentProgress || {}) };
        const matchedSamsatProc = (existing.samsatProcesses || []).find((p: any) => p.id === payload.componentId);
        const existingComp = currentMap[payload.componentId] || {
          componentId: payload.componentId,
          name: compUpd.name || matchedSamsatProc?.name || rawSubprogress,
          category: compUpd.category || matchedSamsatProc?.category,
          masterPrice: compUpd.masterPrice ?? matchedSamsatProc?.basePrice,
          nominal: compUpd.nominal ?? matchedSamsatProc?.basePrice ?? 0,
          actualOrderPrice: compUpd.actualOrderPrice ?? matchedSamsatProc?.basePrice ?? 0,
          status: "NOT_STARTED",
        };

        const targetStatus = compUpd.status || existingComp.status || "IN_PROGRESS";
        const resolvedDurationMinutes =
          compUpd.isCustomDuration && compUpd.customDurationDays && compUpd.customDurationDays > 0
            ? compUpd.customDurationDays * 1440
            : (compUpd.estimatedDurationMinutes ?? existingComp.estimatedDurationMinutes);

        const isSameCompState =
          existingComp.status === targetStatus &&
          existingComp.estimatedDurationMinutes === resolvedDurationMinutes &&
          existingComp.waitingReason === compUpd.waitingReason;

        if (!isSameCompState || existing.samsatSubstatus !== formattedSubstatus) {
          const startedAt =
            targetStatus === "IN_PROGRESS"
              ? (existingComp.startedAt || compUpd.startedAt || nowIso)
              : existingComp.startedAt;
          let estimatedCompletedAt = existingComp.estimatedCompletedAt;
          if (resolvedDurationMinutes && Number(resolvedDurationMinutes) > 0) {
            const baseStartMs = new Date(startedAt || nowIso).getTime();
            const resolvedMs = isNaN(baseStartMs) ? Date.now() : baseStartMs;
            estimatedCompletedAt = new Date(resolvedMs + Number(resolvedDurationMinutes) * 60000).toISOString();
          }
          const completedAt =
            targetStatus === "COMPLETED"
              ? (existingComp.completedAt || new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }))
              : existingComp.completedAt;

          currentMap[payload.componentId] = {
            ...existingComp,
            ...(compUpd.name ? { name: compUpd.name } : {}),
            ...(compUpd.category ? { category: compUpd.category } : {}),
            ...(compUpd.isCustom !== undefined ? { isCustom: compUpd.isCustom } : {}),
            ...(compUpd.isCustomDuration !== undefined ? { isCustomDuration: compUpd.isCustomDuration } : {}),
            ...(compUpd.customDurationDays !== undefined ? { customDurationDays: compUpd.customDurationDays } : {}),
            ...(resolvedDurationMinutes !== undefined ? { estimatedDurationMinutes: resolvedDurationMinutes } : {}),
            ...(compUpd.waitingReason ? { waitingReason: compUpd.waitingReason.trim() } : {}),
            status: targetStatus,
            startedAt,
            completedAt,
            estimatedCompletedAt,
          };

          updates.messengerComponentProgress = currentMap;
          componentChanged = true;

          timelineEvents.push({
            id: `tl-comp-${Date.now()}`,
            timestamp: nowIso,
            title: `Update Komponen: ${currentMap[payload.componentId].name}`,
            note: `Status: ${currentMap[payload.componentId].status}.`,
            author: courierName,
            type: "COMPONENT_UPDATE",
          });
        }
      }

      // Idempotency: Already on same subprogress and no component state change
      if (existing.samsatSubstatus === formattedSubstatus && !componentChanged) {
        return existing;
      }

      if (existing.samsatSubstatus !== formattedSubstatus) {
        timelineEvents.unshift({
          id: `tl-subprog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: nowIso,
          title: `Progres Samsat: ${formattedSubstatus}`,
          note: `Tahapan pengurusan diperbarui oleh ${courierName}`,
          author: courierName,
          type: "STATUS_CHANGE",
        });
      }

      updates.messengerTimeline = [...timelineEvents, ...(existing.messengerTimeline || [])];

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-samsat-subprog-${Date.now()}`,
        userId: courierId,
        userName: courierName,
        userRole: (user.role as any) || "messenger",
        action: "UPDATE_SAMSAT_SUBPROGRESS",
        module: "Proses Samsat",
        details: `Petugas ${courierName} memperbarui progres loket Samsat order ${orderNo}: ${formattedSubstatus}`,
        metadata: {
          orderNo,
          previousSubstatus: existing.samsatSubstatus || null,
          newSubstatus: formattedSubstatus,
          componentId: payload.componentId || null,
        },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  /**
   * Dedicated Messenger Task Status Transition Endpoint Service (Phase 3 Remediation)
   * Replaces generic PUT /orders/:orderNo modification of protected `messengerTaskStatus`.
   * Enforces role/ownership, transition lifecycle rules, stage consistency, idempotency & audit log.
   */
  public updateMessengerTaskStatus(
    orderNo: string,
    taskType: string,
    payload: {
      status?: string;
      newStatus?: string;
      waitingReason?: string;
      reason?: string;
      note?: string;
      notes?: string;
      keterangan?: string;
    },
    user: TokenPayload
  ): OperationalOrder {
    const validTaskTypes = new Set([
      "Jemput Dokumen",
      "Proses Samsat",
      "Jemput Hasil Samsat",
      "Pengantaran Dokumen",
    ]);
    const cleanTaskType = (taskType || "").trim();
    if (!validTaskTypes.has(cleanTaskType)) {
      throw new ApiError(400, "INVALID_TASK_TYPE", `Jenis tugas '${taskType}' tidak valid.`);
    }

    const role = (user.role || "").toLowerCase().trim();
    if (!["administrator", "admin", "messenger"].includes(role)) {
      throw new ApiError(403, "FORBIDDEN", "Role Anda tidak berwenang memperbarui status tugas kurir.");
    }

    const rawTarget = (payload.newStatus ?? payload.status ?? "").trim();
    if (!rawTarget) {
      throw new ApiError(400, "VALIDATION_ERROR", "Status tugas target wajib diisi.");
    }

    const normalizedKey = rawTarget.toUpperCase().replace(/\s+/g, "_");
    // Terminal / cancel shortcuts are strictly rejected so completion/cancel workflows cannot be bypassed
    const forbiddenShortcutSet = new Set([
      "SELESAI",
      "COMPLETED",
      "DOKUMEN_SUDAH_TERSEDIA",
      "DOKUMEN_DISERAHKAN",
      "DOKUMEN_SAMSAT_DITERIMA_DI_KANTOR",
      "DIBATALKAN",
      "CANCELLED",
    ]);
    if (forbiddenShortcutSet.has(normalizedKey)) {
      throw new ApiError(
        400,
        "INVALID_STATUS_TRANSITION",
        `Transisi status ke '${rawTarget}' tidak diizinkan melalui endpoint status tugas. Gunakan endpoint penyelesaian atau pembatalan resmi.`
      );
    }

    let mappedDisplayStatus: "Belum Diambil" | "Dalam Proses" | "Pending";
    if (normalizedKey === "BELUM_DIAMBIL" || normalizedKey === "PENDING_PICKUP") {
      mappedDisplayStatus = "Belum Diambil";
    } else if (
      normalizedKey === "DALAM_PROSES" ||
      normalizedKey === "IN_PROGRESS" ||
      normalizedKey === "SEDANG_DIJEMPUT" ||
      normalizedKey === "SEDANG_DIANTAR" ||
      normalizedKey === "SEDANG_PROSES_SAMSAT"
    ) {
      mappedDisplayStatus = "Dalam Proses";
    } else if (normalizedKey === "PENDING" || normalizedKey === "WAITING") {
      mappedDisplayStatus = "Pending";
    } else {
      throw new ApiError(
        400,
        "INVALID_STATUS_TRANSITION",
        `Status tugas '${rawTarget}' tidak dikenali atau tidak valid.`
      );
    }

    if (role === "messenger") {
      const freeNote = (payload.note || payload.notes || payload.keterangan || "").trim();
      if (freeNote.length > 0) {
        throw new ApiError(
          400,
          "MESSENGER_NOTES_NOT_ALLOWED",
          "Catatan operasional bebas (free-text notes) tidak diizinkan bagi Messenger."
        );
      }
      if (mappedDisplayStatus === "Belum Diambil") {
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Messenger tidak dapat mengembalikan status tugas ke 'Belum Diambil' secara langsung. Gunakan endpoint tolak atau serahkan tugas."
        );
      }
    }

    const cleanWaitingReason = (payload.waitingReason || payload.reason || "").trim();
    const cleanAdminNote = role === "messenger" ? "" : (payload.note || payload.notes || payload.keterangan || "").trim();

    if (mappedDisplayStatus === "Pending") {
      if (role === "messenger" && !cleanWaitingReason) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Alasan menunggu (waitingReason) wajib diisi saat memilih status Menunggu (Pending)."
        );
      }
      if (!cleanWaitingReason && !cleanAdminNote) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Alasan menunggu wajib diisi saat memilih status Pending."
        );
      }
    }

    const ownershipContext =
      cleanTaskType === "Jemput Dokumen"
        ? "PICKUP"
        : cleanTaskType === "Proses Samsat"
        ? "SAMSAT"
        : cleanTaskType === "Jemput Hasil Samsat"
        ? "SAMSAT_PICKUP"
        : "DELIVERY";

    return runInTransaction(() => {
      const existing = this.getByOrderNo(orderNo);
      if (!existing) {
        throw new ApiError(404, "ORDER_NOT_FOUND", `Order '${orderNo}' tidak ditemukan.`);
      }
      if ((existing as any).isCancelled || existing.currentStageName === "Dibatalkan" || (existing as any).status === "Dibatalkan") {
        throw new ApiError(400, "ORDER_CANCELLED", `Order '${orderNo}' sudah dibatalkan.`);
      }
      if ((existing as any).isArchived === 1 || (existing as any).isArchived === true || (existing as any).isArchived === 2) {
        throw new ApiError(400, "ORDER_ARCHIVED", `Order '${orderNo}' sudah diarsipkan dan status tugas tidak dapat diubah.`);
      }

      const { messengerId: actorId, messengerName: actorName } = assertMessengerOwnership(existing, user, ownershipContext);
      assertMessengerTaskAcceptanceValid(existing, cleanTaskType, user);

      // Stage & completion transition validation
      const step = Number(existing.currentStep || 0);
      if (cleanTaskType === "Jemput Dokumen") {
        if (step > 2 || existing.pickupCompleted || existing.messengerTaskStatus === "Dokumen Sudah Tersedia") {
          throw new ApiError(
            400,
            "INVALID_STATUS_TRANSITION",
            `Tugas Jemput Dokumen order '${orderNo}' sudah selesai atau melewati tahap Penjadwalan.`
          );
        }
      } else if (cleanTaskType === "Proses Samsat") {
        if (step !== 4 && existing.currentStageName !== "Proses Samsat") {
          throw new ApiError(
            400,
            "INVALID_STATUS_TRANSITION",
            `Order '${orderNo}' saat ini berada di Step ${step}, bukan pada tahap Proses Samsat.`
          );
        }
        const currentCycle = (existing as any).samsatCycle || 1;
        if (existing.samsatStatus === "Selesai" && (existing as any).samsatCompletedCycle === currentCycle) {
          throw new ApiError(
            400,
            "INVALID_STATUS_TRANSITION",
            `Proses Samsat order '${orderNo}' sudah selesai pada siklus saat ini.`
          );
        }
      } else if (cleanTaskType === "Jemput Hasil Samsat") {
        if (
          (step !== 4 && existing.currentStageName !== "Proses Samsat") ||
          existing.samsatStatus !== "Selesai" ||
          existing.samsatPickupStatus === "Dokumen Samsat Diterima di Kantor"
        ) {
          throw new ApiError(
            400,
            "INVALID_STATUS_TRANSITION",
            `Tugas Jemput Hasil Samsat order '${orderNo}' tidak dalam status aktif yang dapat diubah.`
          );
        }
      } else if (cleanTaskType === "Pengantaran Dokumen") {
        if (
          (step !== 7 && existing.currentStageName !== "Pengantaran") ||
          existing.deliveryStatus === "Dokumen Diserahkan" ||
          existing.isReceived
        ) {
          throw new ApiError(
            400,
            "INVALID_STATUS_TRANSITION",
            `Tugas Pengantaran Dokumen order '${orderNo}' sudah selesai atau tidak berada pada Step 7 (Pengantaran).`
          );
        }
      }

      const effectiveReasonOrNote =
        mappedDisplayStatus === "Pending"
          ? (cleanWaitingReason || cleanAdminNote)
          : (cleanAdminNote || existing.messengerTaskNotes || "");

      const isAlreadyAtStatus =
        existing.messengerTaskStatus === mappedDisplayStatus &&
        (mappedDisplayStatus !== "Pending" || existing.messengerTaskNotes === effectiveReasonOrNote);

      if (isAlreadyAtStatus && !cleanAdminNote && !cleanWaitingReason) {
        return existing;
      }

      const nowIso = new Date().toISOString();
      const statusLabel =
        mappedDisplayStatus === "Pending"
          ? "Menunggu"
          : mappedDisplayStatus;
      const timelineNote = cleanWaitingReason
        ? `Alasan: ${cleanWaitingReason}.${cleanAdminNote ? ` Catatan: ${cleanAdminNote}` : ""}`
        : cleanAdminNote || `Status tugas ${cleanTaskType} diperbarui menjadi ${statusLabel}.`;

      const timelineEvent: any = {
        id: `tl-status-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: nowIso,
        title: `Ubah Status: ${statusLabel}`,
        note: timelineNote,
        author: actorName,
        type: "STATUS_CHANGE",
      };

      const updates: Partial<OperationalOrder> = {
        messengerTaskStatus: mappedDisplayStatus,
        messengerTimeline: [timelineEvent, ...(existing.messengerTimeline || [])],
      };

      if (mappedDisplayStatus === "Pending") {
        updates.messengerTaskNotes = effectiveReasonOrNote;
      } else if (cleanAdminNote) {
        updates.messengerTaskNotes = cleanAdminNote;
      }

      if (cleanTaskType === "Proses Samsat" && mappedDisplayStatus === "Dalam Proses" && existing.samsatStatus !== "Sedang Proses Samsat") {
        updates.samsatStatus = "Sedang Proses Samsat";
        updates.samsatStartedAt = existing.samsatStartedAt || nowIso;
        updates.samsatJourneyStartedAt = existing.samsatJourneyStartedAt || nowIso;
      } else if (cleanTaskType === "Pengantaran Dokumen" && mappedDisplayStatus === "Dalam Proses" && existing.deliveryStatus !== "Sedang Diantar") {
        updates.deliveryStatus = "Sedang Diantar";
        updates.deliveryStartedAt = existing.deliveryStartedAt || nowIso;
      }

      dbOrderRepository.updateOrder(orderNo, updates);
      const updated = this.getByOrderNo(orderNo)!;

      dbAuditRepository.save({
        id: `log-task-status-${Date.now()}`,
        userId: actorId,
        userName: actorName,
        userRole: (user.role as any) || "messenger",
        action: "UPDATE_TASK_STATUS",
        module: "Messenger Task",
        details: `Mengubah status tugas ${cleanTaskType} pada order ${orderNo} dari '${existing.messengerTaskStatus || "-"}' menjadi '${mappedDisplayStatus}'`,
        metadata: {
          orderNo,
          taskType: cleanTaskType,
          previousStatus: existing.messengerTaskStatus || null,
          newStatus: mappedDisplayStatus,
          waitingReason: cleanWaitingReason || null,
        },
        createdAt: nowIso,
      });

      return updated;
    });
  }

  public getStatusHistory(orderNo: string) {
    return dbOrderRepository.getStatusHistoryByOrderNo(orderNo);
  }

  private linkOrderDocuments(order: OperationalOrder): void {
    if (!order || !order.orderNo) return;
    try {
      const orderJson = JSON.stringify(order);
      const matches = orderJson.match(/DOC-[A-Za-z0-9_-]+/g);
      if (matches && matches.length > 0) {
        const uniqueDocIds = [...new Set(matches)];
        for (const docId of uniqueDocIds) {
          try {
            dbDocumentRepository.linkOrder(docId, order.orderNo);
          } catch {
            // Ignore single doc linking warning
          }
        }
      }
    } catch (err) {
      console.warn(`[OrderService] Document linking warning for order ${order.orderNo}:`, err);
    }
  }
}

export const orderService = new OrderService();
