/**
 * Estimation Template Store & Persistence
 * Admin SUN89 — Biro Jasa Management System
 *
 * Provides reactive state management, persistent SQLite/Express API synchronization,
 * awaited HTTP persistence with rollback on failure, and atomic per-template updates.
 */

import { useState, useEffect } from "react";
import {
  EstimationTemplateConfig,
  EstimationComponentRule,
  EstimationInput,
  EstimationResult,
} from "../../domain/estimation/types";
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
} from "../../domain/estimation/defaultTemplates";
import { calculateEstimation, defaultRuleRegistry } from "../../domain/estimation/estimationEngine";
import {
  resolveTemplateIdByService,
  sanitizeComponentDescription,
  sanitizeEstimationTemplate,
} from "../../domain/estimation/templateSanitizer";
import { auditLog } from "../utils/auditLog";
import { APP_CONFIG } from "../config/appConfig";
import { permissionStore } from "./permissionStore";

export {
  resolveTemplateIdByService,
  sanitizeComponentDescription,
  sanitizeEstimationTemplate,
};

export interface EstimationSaveResult {
  success: boolean;
  template?: EstimationTemplateConfig;
  templates?: EstimationTemplateConfig[];
  error?: string;
  statusCode?: number;
}

export const ALL_DEFAULT_TEMPLATES: EstimationTemplateConfig[] = [
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

class EstimationStore {
  private templates: Map<string, EstimationTemplateConfig> = new Map();
  private listeners: Set<() => void> = new Set();
  private isLoadingState = false;
  private isSavingState = false;
  private lastError: string | null = null;
  private isDataStale = false;
  private baseUrl: string;
  private hasSyncedBackend = false;
  private lastFetchedAuthKey: string | null = null;
  private activeFetchPromise: Promise<void> | null = null;
  private writeQueues: Map<string, Promise<void>> = new Map();
  private pendingWriteCount = 0;
  private writeSeq: Map<string, number> = new Map();
  private permissionUnsubscribe: (() => void) | null = null;

  constructor(baseUrl = APP_CONFIG.apiBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.seedDefaultsInMemory();

    this.permissionUnsubscribe = permissionStore.subscribe(() => {
      const authStatus = permissionStore.getSessionAuthStatus();
      if (authStatus === "unauthenticated" || authStatus === "forbidden") {
        this.hasSyncedBackend = false;
        this.lastFetchedAuthKey = null;
        return;
      }
      if (authStatus === "authenticated" && typeof window !== "undefined" && this.canFetchFromApi()) {
        const key = `${this.getAuthHeader().Authorization || ""}::${permissionStore.getSessionRole() || ""}`;
        if (!this.hasSyncedBackend || this.lastFetchedAuthKey !== key) {
          void this.initFromBackend();
        }
      }
    });
    if (typeof window !== "undefined" && this.canFetchFromApi()) {
      void this.initFromBackend();
    }
  }

  private seedDefaultsInMemory(): void {
    this.templates.clear();
    for (const tpl of ALL_DEFAULT_TEMPLATES) {
      const sanitized = sanitizeEstimationTemplate(cloneTemplate(tpl));
      this.templates.set(sanitized.id, sanitized);
    }
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = (url || APP_CONFIG.apiBaseUrl).replace(/\/$/, "");
  }

  public resetLocalToCanonicalDefaultsForTest(): void {
    this.seedDefaultsInMemory();
    this.hasSyncedBackend = false;
    this.lastFetchedAuthKey = null;
    this.lastError = null;
    this.isDataStale = false;
    this.notify();
  }

  private getAuthHeader(): Record<string, string> {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const token = window.localStorage.getItem("auth_token");
        if (token) {
          return { Authorization: `Bearer ${token}` };
        }
      }
      if (typeof process !== "undefined" && process.env?.AUTH_TOKEN) {
        return { Authorization: `Bearer ${process.env.AUTH_TOKEN}` };
      }
    } catch {
      // ignore
    }
    return {};
  }

  private hasAuthToken(): boolean {
    return Boolean(this.getAuthHeader().Authorization);
  }

  private canPersistRemote(): boolean {
    return typeof fetch !== "undefined" && (typeof window !== "undefined" || this.hasAuthToken());
  }

  public isLoading(): boolean {
    return this.isLoadingState;
  }

  public isSaving(): boolean {
    return this.isSavingState;
  }

  public getError(): string | null {
    return this.lastError;
  }

  public isStale(): boolean {
    return this.isDataStale;
  }

  public clearError(): void {
    this.lastError = null;
    this.notify();
  }

  private canFetchFromApi(): boolean {
    if (!this.hasAuthToken()) return false;
    return permissionStore.getSessionAuthStatus() === "authenticated";
  }

  public async initFromBackend(options?: { force?: boolean }): Promise<void> {
    if (typeof fetch === "undefined") return;
    if (!options?.force && !this.canFetchFromApi()) return;
    if (options?.force && !this.hasAuthToken() && typeof window === "undefined") return;
    if (this.activeFetchPromise) return this.activeFetchPromise;

    const capturedKey = `${this.getAuthHeader().Authorization || ""}::${permissionStore.getSessionRole() || ""}`;
    this.isLoadingState = true;
    this.lastError = null;
    this.notify();

    this.activeFetchPromise = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/estimation/templates`, {
          headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        });
        if (!options?.force && !this.canFetchFromApi()) return;
        if (!res.ok) {
          const errPayload = await res.json().catch(() => ({}));
          throw new Error(
            errPayload?.error?.message ||
              errPayload?.message ||
              `Gagal memuat template estimasi (HTTP ${res.status})`
          );
        }
        const payload = await res.json();
        if (!options?.force && !this.canFetchFromApi()) return;
        if (payload?.success && Array.isArray(payload.data) && payload.data.length > 0) {
          for (const item of payload.data) {
            if (item && item.id) {
              const sanitized = sanitizeEstimationTemplate(cloneTemplate(item));
              this.templates.set(sanitized.id, sanitized);
            }
          }
          this.hasSyncedBackend = true;
          this.lastFetchedAuthKey = capturedKey;
          this.isDataStale = false;
          this.lastError = null;
        }
      } catch (err: any) {
        this.lastError = err?.message || "Gagal memuat template estimasi dari server.";
        this.isDataStale = true;
      } finally {
        this.isLoadingState = false;
        this.activeFetchPromise = null;
        this.notify();
      }
    })();

    return this.activeFetchPromise;
  }

  private nextWriteSequence(templateId: string): number {
    const next = (this.writeSeq.get(templateId) || 0) + 1;
    this.writeSeq.set(templateId, next);
    return next;
  }

  private recordAuditSuccess(details: string, metadata: Record<string, any>): void {
    try {
      auditLog.log({
        userId: "usr-admin",
        userName: "Admin Estimasi",
        userRole: "admin",
        action: "UPDATE",
        module: "Estimasi",
        details,
        metadata,
      });
    } catch {
      // safe fallback
    }
  }

  private enqueueTemplateWrite<T>(
    templateId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const prevTail = this.writeQueues.get(templateId) || Promise.resolve();
    this.pendingWriteCount++;
    this.isSavingState = true;
    this.notify();

    let tailGuard: Promise<void>;
    const runPromise = prevTail
      .catch(() => undefined)
      .then(() => task())
      .finally(() => {
        this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
        this.isSavingState = this.pendingWriteCount > 0;
        if (this.writeQueues.get(templateId) === tailGuard) {
          this.writeQueues.delete(templateId);
        }
        this.notify();
      });

    tailGuard = runPromise.then(
      () => undefined,
      () => undefined
    );
    this.writeQueues.set(templateId, tailGuard);
    return runPromise;
  }

  private async performTemplatePut(
    template: EstimationTemplateConfig,
    opts?: {
      rollbackSnapshot?: EstimationTemplateConfig | null;
      expectedSeq?: number;
      auditDetails?: string;
    }
  ): Promise<EstimationSaveResult> {
    const cleanTemplate = sanitizeEstimationTemplate(cloneTemplate(template));
    const templateId = cleanTemplate.id;

    if (!this.canPersistRemote()) {
      this.templates.set(templateId, cleanTemplate);
      this.lastError = null;
      this.isDataStale = false;
      this.notify();
      this.recordAuditSuccess(
        opts?.auditDetails || `Template ${cleanTemplate.name} diperbarui`,
        { templateId }
      );
      return { success: true, template: cloneTemplate(cleanTemplate) };
    }

    try {
      const res = await fetch(
        `${this.baseUrl}/estimation/templates/${encodeURIComponent(templateId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
          body: JSON.stringify(cleanTemplate),
        }
      );

      const bodyPayload = await res.json().catch(() => ({}));
      if (!res.ok || bodyPayload?.success === false) {
        const message =
          bodyPayload?.error?.message ||
          bodyPayload?.message ||
          `Gagal menyinkronkan template estimasi ke server (HTTP ${res.status})`;
        const err = new Error(message) as Error & { statusCode?: number };
        err.statusCode = res.status;
        throw err;
      }

      const serverTemplate = bodyPayload?.data
        ? sanitizeEstimationTemplate(cloneTemplate(bodyPayload.data))
        : cleanTemplate;

      this.templates.set(templateId, serverTemplate);
      this.lastError = null;
      this.isDataStale = false;
      this.notify();

      this.recordAuditSuccess(
        opts?.auditDetails || `Template ${serverTemplate.name} diperbarui`,
        { templateId }
      );
      return {
        success: true,
        template: cloneTemplate(serverTemplate),
        statusCode: res.status,
      };
    } catch (err: any) {
      const errMessage =
        err?.message || "Gagal menyinkronkan template estimasi ke server.";
      const shouldRollback =
        opts?.rollbackSnapshot !== undefined &&
        (opts.expectedSeq === undefined || this.writeSeq.get(templateId) === opts.expectedSeq);
      if (shouldRollback && opts?.rollbackSnapshot) {
        this.templates.set(templateId, cloneTemplate(opts.rollbackSnapshot));
      }
      this.lastError = errMessage;
      this.isDataStale = true;
      this.notify();
      console.warn("[EstimationStore] Backend sync failed:", err);
      return {
        success: false,
        error: errMessage,
        statusCode: err?.statusCode,
      };
    }
  }

  /**
   * Awaited HTTP PUT synchronization with strict per-template queue serialization,
   * response.ok verification, and non-clobbering rollback on failure.
   */
  public async syncToBackend(
    template: EstimationTemplateConfig,
    previousTemplate?: EstimationTemplateConfig | null,
    auditDetails?: string
  ): Promise<EstimationSaveResult> {
    if (!template || !template.id) {
      return { success: false, error: "Template tidak valid (ID wajib diisi)." };
    }
    const cleanTemplate = sanitizeEstimationTemplate(cloneTemplate(template));
    const seq = this.nextWriteSequence(cleanTemplate.id);
    return this.enqueueTemplateWrite(cleanTemplate.id, () =>
      this.performTemplatePut(cleanTemplate, {
        rollbackSnapshot: previousTemplate,
        expectedSeq: seq,
        auditDetails,
      })
    );
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error("Error in EstimationStore listener:", err);
      }
    });
  }

  public getTemplate(id = "template-pajak-tahunan-r4"): EstimationTemplateConfig {
    const tpl = this.templates.get(id);
    if (!tpl) {
      const def = ALL_DEFAULT_TEMPLATES.find((t) => t.id === id);
      if (def) return sanitizeEstimationTemplate(cloneTemplate(def));
      return sanitizeEstimationTemplate(cloneTemplate(DEFAULT_R4_ANNUAL_TEMPLATE));
    }
    return sanitizeEstimationTemplate(cloneTemplate(tpl));
  }

  public getAllTemplates(): EstimationTemplateConfig[] {
    return Array.from(this.templates.values()).map((tpl) =>
      sanitizeEstimationTemplate(cloneTemplate(tpl))
    );
  }

  private async executeComponentRuleUpdate(
    templateId: string,
    componentId: string,
    buildUpdates: (comp: EstimationComponentRule) => Partial<EstimationComponentRule>
  ): Promise<EstimationSaveResult> {
    const tpl = this.templates.get(templateId);
    if (!tpl) {
      return { success: false, error: `Template '${templateId}' tidak ditemukan.` };
    }

    const cloned = cloneTemplate(tpl);
    const idx = cloned.components.findIndex((c) => c.id === componentId);
    if (idx === -1) {
      return { success: false, error: `Komponen '${componentId}' tidak ditemukan.` };
    }

    const oldComp = cloned.components[idx];
    const updates = buildUpdates(oldComp);
    cloned.components[idx] = {
      ...oldComp,
      ...updates,
      description:
        updates.description !== undefined
          ? sanitizeComponentDescription(updates.description)
          : oldComp.description,
      formulaCondition:
        updates.formulaCondition !== undefined
          ? sanitizeComponentDescription(updates.formulaCondition)
          : oldComp.formulaCondition,
      humanFormula:
        updates.humanFormula !== undefined
          ? sanitizeComponentDescription(updates.humanFormula)
          : oldComp.humanFormula,
    };
    cloned.updatedAt = new Date().toISOString();

    const seq = this.nextWriteSequence(templateId);
    return this.performTemplatePut(cloned, {
      expectedSeq: seq,
      auditDetails: `Komponen ${oldComp.name} pada ${tpl.name} diperbarui`,
    });
  }

  // ─── Awaited Async Write API (Recommended for UI & API Tests) ──────────────

  public async updateTemplateAsync(
    updatedTemplate: EstimationTemplateConfig
  ): Promise<EstimationSaveResult> {
    if (!updatedTemplate || !updatedTemplate.id) {
      return { success: false, error: "Template tidak valid (ID wajib diisi)." };
    }
    const cleanTemplate = sanitizeEstimationTemplate(cloneTemplate(updatedTemplate));
    return this.enqueueTemplateWrite(cleanTemplate.id, () => {
      const seq = this.nextWriteSequence(cleanTemplate.id);
      return this.performTemplatePut(cleanTemplate, {
        expectedSeq: seq,
        auditDetails: `Template ${cleanTemplate.name} diperbarui`,
      });
    });
  }

  public async updateTemplateParamsAsync(
    id: string,
    updates: Partial<Omit<EstimationTemplateConfig, "id" | "components">>
  ): Promise<EstimationSaveResult> {
    return this.enqueueTemplateWrite(id, () => {
      const tpl = this.templates.get(id);
      if (!tpl) {
        return Promise.resolve({
          success: false,
          error: `Template '${id}' tidak ditemukan.`,
        });
      }

      const updated: EstimationTemplateConfig = {
        ...cloneTemplate(tpl),
        ...updates,
        id: tpl.id,
        serviceType: tpl.serviceType,
        vehicleType: tpl.vehicleType,
        accIdRates: updates.accIdRates
          ? { ...tpl.accIdRates, ...updates.accIdRates }
          : { ...tpl.accIdRates },
        updatedAt: new Date().toISOString(),
      };

      const seq = this.nextWriteSequence(id);
      return this.performTemplatePut(updated, {
        expectedSeq: seq,
        auditDetails: `Template parameter untuk ${tpl.name} diperbarui`,
      });
    });
  }

  public async updateComponentRuleAsync(
    templateId: string,
    componentId: string,
    updates: Partial<EstimationComponentRule>
  ): Promise<EstimationSaveResult> {
    return this.enqueueTemplateWrite(templateId, () =>
      this.executeComponentRuleUpdate(templateId, componentId, () => updates)
    );
  }

  public async toggleComponentAsync(
    templateId: string,
    componentId: string
  ): Promise<EstimationSaveResult> {
    return this.enqueueTemplateWrite(templateId, () =>
      this.executeComponentRuleUpdate(templateId, componentId, (comp) => ({
        isActive: !comp.isActive,
      }))
    );
  }

  public async toggleIncludeInTotalAsync(
    templateId: string,
    componentId: string
  ): Promise<EstimationSaveResult> {
    return this.enqueueTemplateWrite(templateId, () =>
      this.executeComponentRuleUpdate(templateId, componentId, (comp) => ({
        includesInTotal: !comp.includesInTotal,
      }))
    );
  }

  public async addManualComponentAsync(
    templateId: string,
    compData: Omit<EstimationComponentRule, "id" | "displayOrder"> & { id?: string }
  ): Promise<EstimationSaveResult & { component?: EstimationComponentRule }> {
    return this.enqueueTemplateWrite(templateId, async () => {
      const tpl = this.templates.get(templateId);
      if (!tpl) {
        return { success: false, error: `Template '${templateId}' tidak ditemukan.` };
      }

      const cloned = cloneTemplate(tpl);
      const id =
        compData.id || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const maxOrder = cloned.components.reduce(
        (max, c) => Math.max(max, c.displayOrder),
        0
      );

      const newComp: EstimationComponentRule = {
        ...compData,
        id,
        displayOrder: maxOrder + 1,
        isEditable: true,
        valueType: "manual",
        calculationMethod: compData.calculationMethod || "manual_amount",
        applicableVehicles: compData.applicableVehicles || (cloned.vehicleType as any),
        applicableService: compData.applicableService || cloned.serviceType,
      };

      cloned.components.push(newComp);
      cloned.updatedAt = new Date().toISOString();

      const seq = this.nextWriteSequence(templateId);
      const saveRes = await this.performTemplatePut(cloned, { expectedSeq: seq });
      return {
        ...saveRes,
        component: saveRes.success ? newComp : undefined,
      };
    });
  }

  public async removeManualComponentAsync(
    templateId: string,
    componentId: string
  ): Promise<EstimationSaveResult> {
    return this.enqueueTemplateWrite(templateId, async () => {
      const tpl = this.templates.get(templateId);
      if (!tpl) {
        return { success: false, error: `Template '${templateId}' tidak ditemukan.` };
      }

      const comp = tpl.components.find((c) => c.id === componentId);
      if (!comp || comp.valueType === "formula" || comp.ruleId) {
        return {
          success: false,
          error: "Komponen formula inti tidak dapat dihapus.",
        };
      }

      const cloned = cloneTemplate(tpl);
      cloned.components = cloned.components.filter((c) => c.id !== componentId);
      cloned.updatedAt = new Date().toISOString();

      const seq = this.nextWriteSequence(templateId);
      return this.performTemplatePut(cloned, { expectedSeq: seq });
    });
  }

  private async performSingleResetPost(
    templateId: string,
    fallbackResetTpl: EstimationTemplateConfig
  ): Promise<EstimationSaveResult> {
    if (!this.canPersistRemote()) {
      this.templates.set(templateId, fallbackResetTpl);
      this.lastError = null;
      this.isDataStale = false;
      this.notify();
      return { success: true, template: cloneTemplate(fallbackResetTpl) };
    }

    try {
      const res = await fetch(
        `${this.baseUrl}/estimation/templates/${encodeURIComponent(templateId)}/reset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        }
      );
      const bodyPayload = await res.json().catch(() => ({}));
      if (!res.ok || bodyPayload?.success === false) {
        const message =
          bodyPayload?.error?.message ||
          bodyPayload?.message ||
          `Gagal mereset template estimasi (HTTP ${res.status})`;
        const err = new Error(message) as Error & { statusCode?: number };
        err.statusCode = res.status;
        throw err;
      }
      const serverTpl = bodyPayload?.data
        ? sanitizeEstimationTemplate(cloneTemplate(bodyPayload.data))
        : fallbackResetTpl;
      this.templates.set(templateId, serverTpl);
      this.lastError = null;
      this.isDataStale = false;
      this.notify();
      return {
        success: true,
        template: cloneTemplate(serverTpl),
        statusCode: res.status,
      };
    } catch (err: any) {
      const msg = err?.message || "Gagal mereset template estimasi di server.";
      this.lastError = msg;
      this.isDataStale = true;
      this.notify();
      return { success: false, error: msg, statusCode: err?.statusCode };
    }
  }

  public async resetToDefaultAsync(
    templateId?: string
  ): Promise<EstimationSaveResult> {
    if (templateId) {
      const def = ALL_DEFAULT_TEMPLATES.find((t) => t.id === templateId);
      if (!def) {
        return {
          success: false,
          error: `Default resmi untuk template '${templateId}' tidak ditemukan.`,
        };
      }

      return this.enqueueTemplateWrite(def.id, async () => {
        this.nextWriteSequence(def.id);
        const resetTpl = sanitizeEstimationTemplate({
          ...cloneTemplate(def),
          updatedAt: new Date().toISOString(),
        });
        return this.performSingleResetPost(def.id, resetTpl);
      });
    }

    // Global reset: wait for active per-template writes to drain first
    if (this.writeQueues.size > 0) {
      await Promise.allSettled(Array.from(this.writeQueues.values()));
    }

    if (!this.canPersistRemote()) {
      for (const def of ALL_DEFAULT_TEMPLATES) {
        this.templates.set(
          def.id,
          sanitizeEstimationTemplate({
            ...cloneTemplate(def),
            updatedAt: new Date().toISOString(),
          })
        );
      }
      this.lastError = null;
      this.isDataStale = false;
      this.notify();
      return { success: true, templates: this.getAllTemplates() };
    }

    const previousAll = Array.from(this.templates.entries()).map(
      ([k, v]) => [k, cloneTemplate(v)] as const
    );

    this.pendingWriteCount++;
    this.isSavingState = true;
    this.notify();
    try {
      const res = await fetch(`${this.baseUrl}/estimation/reset-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
      });
      const bodyPayload = await res.json().catch(() => ({}));
      if (!res.ok || bodyPayload?.success === false) {
        const message =
          bodyPayload?.error?.message ||
          bodyPayload?.message ||
          `Gagal mereset seluruh template estimasi (HTTP ${res.status})`;
        const err = new Error(message) as Error & { statusCode?: number };
        err.statusCode = res.status;
        throw err;
      }
      const returnedList = Array.isArray(bodyPayload?.data)
        ? bodyPayload.data
        : ALL_DEFAULT_TEMPLATES;
      for (const item of returnedList) {
        if (item && item.id) {
          this.templates.set(
            item.id,
            sanitizeEstimationTemplate(cloneTemplate(item))
          );
        }
      }
      this.lastError = null;
      this.isDataStale = false;
      return {
        success: true,
        templates: this.getAllTemplates(),
        statusCode: res.status,
      };
    } catch (err: any) {
      this.templates = new Map(previousAll);
      const msg = err?.message || "Gagal mereset seluruh template estimasi di server.";
      this.lastError = msg;
      this.isDataStale = true;
      return { success: false, error: msg, statusCode: err?.statusCode };
    } finally {
      this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
      this.isSavingState = this.pendingWriteCount > 0;
      this.notify();
    }
  }

  // ─── Synchronous Backward-Compatible Wrappers (Roll back cleanly if async HTTP fails) ──

  public updateTemplate(updatedTemplate: EstimationTemplateConfig): boolean {
    if (!updatedTemplate || !updatedTemplate.id) return false;
    const existing = this.templates.get(updatedTemplate.id);
    const previousSnapshot = existing ? cloneTemplate(existing) : null;
    const cleanTemplate = sanitizeEstimationTemplate(cloneTemplate(updatedTemplate));
    const seq = this.nextWriteSequence(cleanTemplate.id);
    this.templates.set(cleanTemplate.id, cleanTemplate);
    this.notify();
    void this.enqueueTemplateWrite(cleanTemplate.id, () =>
      this.performTemplatePut(cleanTemplate, {
        rollbackSnapshot: previousSnapshot,
        expectedSeq: seq,
        auditDetails: `Template ${cleanTemplate.name} diperbarui`,
      })
    );
    return true;
  }

  public updateTemplateParams(
    id: string,
    updates: Partial<Omit<EstimationTemplateConfig, "id" | "components">>
  ): boolean {
    const tpl = this.templates.get(id);
    if (!tpl) return false;
    const previousSnapshot = cloneTemplate(tpl);
    const seq = this.nextWriteSequence(id);
    const optimistic: EstimationTemplateConfig = {
      ...cloneTemplate(tpl),
      ...updates,
      id: tpl.id,
      serviceType: tpl.serviceType,
      vehicleType: tpl.vehicleType,
      accIdRates: updates.accIdRates
        ? { ...tpl.accIdRates, ...updates.accIdRates }
        : { ...tpl.accIdRates },
      updatedAt: new Date().toISOString(),
    };
    this.templates.set(id, optimistic);
    this.notify();
    void this.enqueueTemplateWrite(id, () => {
      const latestTpl = this.templates.get(id) || optimistic;
      const merged: EstimationTemplateConfig = {
        ...cloneTemplate(latestTpl),
        ...updates,
        id: latestTpl.id,
        serviceType: latestTpl.serviceType,
        vehicleType: latestTpl.vehicleType,
        accIdRates: updates.accIdRates
          ? { ...latestTpl.accIdRates, ...updates.accIdRates }
          : { ...latestTpl.accIdRates },
        updatedAt: new Date().toISOString(),
      };
      return this.performTemplatePut(merged, {
        rollbackSnapshot: previousSnapshot,
        expectedSeq: seq,
        auditDetails: `Template parameter untuk ${tpl.name} diperbarui`,
      });
    });
    return true;
  }

  public updateComponentRule(
    templateId: string,
    componentId: string,
    updates: Partial<EstimationComponentRule>
  ): boolean {
    const tpl = this.templates.get(templateId);
    if (!tpl) return false;
    const previousSnapshot = cloneTemplate(tpl);
    const cloned = cloneTemplate(tpl);
    const idx = cloned.components.findIndex((c) => c.id === componentId);
    if (idx === -1) return false;

    const oldComp = cloned.components[idx];
    cloned.components[idx] = {
      ...oldComp,
      ...updates,
      description:
        updates.description !== undefined
          ? sanitizeComponentDescription(updates.description)
          : oldComp.description,
      formulaCondition:
        updates.formulaCondition !== undefined
          ? sanitizeComponentDescription(updates.formulaCondition)
          : oldComp.formulaCondition,
      humanFormula:
        updates.humanFormula !== undefined
          ? sanitizeComponentDescription(updates.humanFormula)
          : oldComp.humanFormula,
    };
    cloned.updatedAt = new Date().toISOString();

    const sanitized = sanitizeEstimationTemplate(cloned);
    const seq = this.nextWriteSequence(templateId);
    this.templates.set(templateId, sanitized);
    this.notify();
    void this.enqueueTemplateWrite(templateId, () =>
      this.performTemplatePut(sanitized, {
        rollbackSnapshot: previousSnapshot,
        expectedSeq: seq,
        auditDetails: `Komponen ${oldComp.name} pada ${tpl.name} diperbarui`,
      })
    );
    return true;
  }

  public toggleComponent(templateId: string, componentId: string): boolean {
    const tpl = this.templates.get(templateId);
    if (!tpl) return false;
    const comp = tpl.components.find((c) => c.id === componentId);
    if (!comp) return false;
    return this.updateComponentRule(templateId, componentId, {
      isActive: !comp.isActive,
    });
  }

  public toggleIncludeInTotal(templateId: string, componentId: string): boolean {
    const tpl = this.templates.get(templateId);
    if (!tpl) return false;
    const comp = tpl.components.find((c) => c.id === componentId);
    if (!comp) return false;
    return this.updateComponentRule(templateId, componentId, {
      includesInTotal: !comp.includesInTotal,
    });
  }

  public addManualComponent(
    templateId: string,
    compData: Omit<EstimationComponentRule, "id" | "displayOrder"> & { id?: string }
  ): EstimationComponentRule | null {
    const tpl = this.templates.get(templateId);
    if (!tpl) return null;
    const previousSnapshot = cloneTemplate(tpl);
    const cloned = cloneTemplate(tpl);

    const id =
      compData.id || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const maxOrder = cloned.components.reduce(
      (max, c) => Math.max(max, c.displayOrder),
      0
    );

    const newComp: EstimationComponentRule = {
      ...compData,
      id,
      displayOrder: maxOrder + 1,
      isEditable: true,
      valueType: "manual",
      calculationMethod: compData.calculationMethod || "manual_amount",
      applicableVehicles: compData.applicableVehicles || (cloned.vehicleType as any),
      applicableService: compData.applicableService || cloned.serviceType,
    };

    cloned.components.push(newComp);
    cloned.updatedAt = new Date().toISOString();
    const seq = this.nextWriteSequence(templateId);
    this.templates.set(templateId, cloned);
    this.notify();
    void this.enqueueTemplateWrite(templateId, () =>
      this.performTemplatePut(cloned, {
        rollbackSnapshot: previousSnapshot,
        expectedSeq: seq,
      })
    );
    return newComp;
  }

  public removeManualComponent(templateId: string, componentId: string): boolean {
    const tpl = this.templates.get(templateId);
    if (!tpl) return false;
    const comp = tpl.components.find((c) => c.id === componentId);
    if (!comp || comp.valueType === "formula" || comp.ruleId) {
      return false;
    }

    const previousSnapshot = cloneTemplate(tpl);
    const cloned = cloneTemplate(tpl);
    cloned.components = cloned.components.filter((c) => c.id !== componentId);
    cloned.updatedAt = new Date().toISOString();
    const seq = this.nextWriteSequence(templateId);
    this.templates.set(templateId, cloned);
    this.notify();
    void this.enqueueTemplateWrite(templateId, () =>
      this.performTemplatePut(cloned, {
        rollbackSnapshot: previousSnapshot,
        expectedSeq: seq,
      })
    );
    return true;
  }

  public resetToDefault(templateId?: string): void {
    if (templateId) {
      const def = ALL_DEFAULT_TEMPLATES.find((t) => t.id === templateId);
      if (!def) return;
      const existing = this.templates.get(def.id);
      const previousSnapshot = existing ? cloneTemplate(existing) : null;
      const resetTpl = sanitizeEstimationTemplate({
        ...cloneTemplate(def),
        updatedAt: new Date().toISOString(),
      });
      const seq = this.nextWriteSequence(def.id);
      this.templates.set(def.id, resetTpl);
      this.lastError = null;
      this.isDataStale = false;
      this.notify();

      if (this.canPersistRemote()) {
        void this.enqueueTemplateWrite(def.id, async () => {
          const res = await this.performSingleResetPost(def.id, resetTpl);
          if (!res.success && this.writeSeq.get(def.id) === seq && previousSnapshot) {
            this.templates.set(def.id, cloneTemplate(previousSnapshot));
            this.notify();
          }
          return res;
        });
      }
      return;
    }

    for (const def of ALL_DEFAULT_TEMPLATES) {
      this.nextWriteSequence(def.id);
      this.templates.set(
        def.id,
        sanitizeEstimationTemplate({
          ...cloneTemplate(def),
          updatedAt: new Date().toISOString(),
        })
      );
    }
    this.lastError = null;
    this.isDataStale = false;
    this.notify();

    if (this.canPersistRemote()) {
      void this.resetToDefaultAsync();
    }
  }

  public calculate(
    input: EstimationInput,
    templateId = "template-pajak-tahunan-r4"
  ): EstimationResult {
    const template = this.getTemplate(templateId);
    return calculateEstimation(input, template, defaultRuleRegistry);
  }
}

export const estimationStore = new EstimationStore();

export function useEstimationStore() {
  const [, setTick] = useState(0);

  useEffect(() => {
    return estimationStore.subscribe(() => {
      setTick((t) => t + 1);
    });
  }, []);

  return estimationStore;
}
