/**
 * Estimation Domain Service
 * Admin SUN89 — Biro Jasa Management System
 */

import { dbEstimationRepository } from "../repositories/dbEstimationRepository";
import { dbAuditRepository } from "../repositories/dbAuditRepository";
import { EstimationTemplateConfig } from "../../../src/domain/estimation/types";
import {
  DEFAULT_R4_ANNUAL_TEMPLATE,
  DEFAULT_R2_ANNUAL_TEMPLATE,
  DEFAULT_R4_5YEAR_TEMPLATE,
  DEFAULT_R2_5YEAR_TEMPLATE,
  DEFAULT_R4_BBN_TEMPLATE,
  DEFAULT_R2_BBN_TEMPLATE,
  DEFAULT_R4_MUTASI_AS_TEMPLATE,
  DEFAULT_R2_MUTASI_AS_TEMPLATE,
  DEFAULT_R4_MUTASI_LD_TEMPLATE,
  DEFAULT_R2_MUTASI_LD_TEMPLATE,
} from "../../../src/domain/estimation/defaultTemplates";
import { sanitizeEstimationTemplate } from "../../../src/domain/estimation/templateSanitizer";
import { validateEstimationTemplateUpdate } from "../validators/estimationValidator";
import { ApiError } from "../middleware/errorHandler";
import { TokenPayload } from "../utils/crypto";

export const CANONICAL_DEFAULT_TEMPLATES: EstimationTemplateConfig[] = [
  DEFAULT_R4_ANNUAL_TEMPLATE,
  DEFAULT_R2_ANNUAL_TEMPLATE,
  DEFAULT_R4_5YEAR_TEMPLATE,
  DEFAULT_R2_5YEAR_TEMPLATE,
  DEFAULT_R4_BBN_TEMPLATE,
  DEFAULT_R2_BBN_TEMPLATE,
  DEFAULT_R4_MUTASI_AS_TEMPLATE,
  DEFAULT_R2_MUTASI_AS_TEMPLATE,
  DEFAULT_R4_MUTASI_LD_TEMPLATE,
  DEFAULT_R2_MUTASI_LD_TEMPLATE,
].map(sanitizeEstimationTemplate);

function cloneTemplate(tpl: EstimationTemplateConfig): EstimationTemplateConfig {
  return {
    ...tpl,
    components: Array.isArray(tpl.components) ? tpl.components.map((c) => ({ ...c })) : [],
    accIdRates: tpl.accIdRates ? { ...tpl.accIdRates } : {},
  };
}

export class EstimationService {
  /**
   * Read-only list of all estimation templates.
   * Performs zero database writes during GET operations.
   */
  public getAllTemplates(): EstimationTemplateConfig[] {
    const templates = dbEstimationRepository.getAllTemplates();
    if (templates.length === 0) {
      return CANONICAL_DEFAULT_TEMPLATES.map((tpl) => sanitizeEstimationTemplate(cloneTemplate(tpl)));
    }
    return templates.map(sanitizeEstimationTemplate);
  }

  /**
   * Read-only lookup for a single estimation template by ID.
   * Performs zero database writes during GET operations.
   */
  public getTemplateById(id: string): EstimationTemplateConfig {
    const template = dbEstimationRepository.getTemplateById(id);
    if (!template) {
      const def = CANONICAL_DEFAULT_TEMPLATES.find((t) => t.id === id);
      if (def && dbEstimationRepository.getAllTemplates().length === 0) {
        return sanitizeEstimationTemplate(cloneTemplate(def));
      }
      throw new ApiError(404, "TEMPLATE_NOT_FOUND", `Template estimasi '${id}' tidak ditemukan.`);
    }
    return sanitizeEstimationTemplate(template);
  }

  public updateTemplate(
    id: string,
    updates: Partial<EstimationTemplateConfig>,
    user?: TokenPayload | null
  ): EstimationTemplateConfig {
    const existing = this.getTemplateById(id);
    const validatedUpdates = validateEstimationTemplateUpdate(id, updates, existing);

    // Merge validated template safely without overriding existing customized fees unless supplied
    const merged: EstimationTemplateConfig = {
      ...existing,
      ...validatedUpdates,
      id: existing.id, // Immutable ID
      serviceType: existing.serviceType, // Immutable service type
      vehicleType: existing.vehicleType, // Immutable vehicle type
      components: validatedUpdates.components
        ? validatedUpdates.components.map((c) => ({ ...c }))
        : existing.components.map((c) => ({ ...c })),
      accIdRates: validatedUpdates.accIdRates
        ? { ...existing.accIdRates, ...validatedUpdates.accIdRates }
        : { ...existing.accIdRates },
      updatedAt: new Date().toISOString(),
      updatedBy: user?.nama || "Admin API",
    };

    const updated = sanitizeEstimationTemplate(merged);

    const success = dbEstimationRepository.saveTemplate(updated);
    if (!success) {
      throw new ApiError(500, "UPDATE_FAILED", `Gagal memperbarui template estimasi ${id}`);
    }

    dbAuditRepository.save({
      id: `log-est-upd-${Date.now()}`,
      userId: user?.userId || "usr-system",
      userName: user?.nama || "Admin API",
      userRole: user?.role || "admin",
      action: "UPDATE_ESTIMATION_TEMPLATE",
      module: "Master Data Biaya Layanan",
      details: `Memperbarui konfigurasi template ${updated.name}`,
      metadata: { templateId: id, updates: validatedUpdates },
      createdAt: new Date().toISOString(),
    });

    return updated;
  }

  public resetTemplate(id: string, user?: TokenPayload | null): EstimationTemplateConfig {
    const def = CANONICAL_DEFAULT_TEMPLATES.find((t) => t.id === id);
    if (!def) {
      throw new ApiError(404, "TEMPLATE_NOT_FOUND", `Acuan resmi default untuk template '${id}' tidak ditemukan.`);
    }

    const resetTemplate: EstimationTemplateConfig = {
      ...def,
      components: def.components.map((c) => ({ ...c })),
      accIdRates: { ...def.accIdRates },
      updatedAt: new Date().toISOString(),
      updatedBy: `${user?.nama || "Admin API"} (Reset Default)`,
    };

    dbEstimationRepository.resetTemplate(resetTemplate);

    dbAuditRepository.save({
      id: `log-est-reset-${Date.now()}`,
      userId: user?.userId || "usr-system",
      userName: user?.nama || "Admin API",
      userRole: user?.role || "admin",
      action: "RESET_ESTIMATION_TEMPLATE",
      module: "Master Data Biaya Layanan",
      details: `Mereset template ${resetTemplate.name} ke Standar Resmi Default Workbook`,
      metadata: { templateId: id },
      createdAt: new Date().toISOString(),
    });

    return resetTemplate;
  }

  public resetAllTemplates(user?: TokenPayload | null): EstimationTemplateConfig[] {
    const templates = CANONICAL_DEFAULT_TEMPLATES.map((tpl) => ({
      ...tpl,
      components: tpl.components.map((c) => ({ ...c })),
      accIdRates: { ...tpl.accIdRates },
      updatedAt: new Date().toISOString(),
      updatedBy: `${user?.nama || "Admin API"} (Reset All Default)`,
    }));

    dbEstimationRepository.resetAll(templates);

    dbAuditRepository.save({
      id: `log-est-reset-all-${Date.now()}`,
      userId: user?.userId || "usr-system",
      userName: user?.nama || "Admin API",
      userRole: user?.role || "admin",
      action: "RESET_ALL_ESTIMATION_TEMPLATES",
      module: "Master Data Biaya Layanan",
      details: "Mereset semua 10 template estimasi ke Standar Resmi Default Workbook",
      metadata: { count: templates.length },
      createdAt: new Date().toISOString(),
    });

    return templates;
  }
}

export const estimationService = new EstimationService();
