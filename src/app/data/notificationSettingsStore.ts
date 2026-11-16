/**
 * Notification Settings & Dispatch Store
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Manages persistent global notification recipients, event types,
 * SMTP sender diagnostics, and delivery history logs.
 */

import { useState, useEffect } from "react";
import { APP_CONFIG } from "../config/appConfig";

export interface NotificationSettings {
  id: string;
  recipientEmails: string[];
  notifyTagihanReminder: boolean;
  notifyTagihanPerubahan: boolean;
  notifyOrderUpdate: boolean;
  notifyProsesGagal: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SmtpConfigStatus {
  isConfigured: boolean;
  status: "ONLINE" | "OFFLINE";
  statusText: string;
  host: string | null;
  port: number | null;
  senderEmail: string | null;
  hasCredentials: boolean;
  lastChecked: string;
}

export interface NotificationLogItem {
  id: string;
  type: string;
  recipient: string;
  title: string;
  referenceNo: string | null;
  status: "BERHASIL" | "GAGAL";
  errorMessage: string | null;
  createdAt: string;
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_SETTINGS: NotificationSettings = {
  id: "global",
  recipientEmails: [],
  notifyTagihanReminder: true,
  notifyTagihanPerubahan: true,
  notifyOrderUpdate: true,
  notifyProsesGagal: true,
  updatedAt: "",
  updatedBy: null,
};

const DEFAULT_SMTP: SmtpConfigStatus = {
  isConfigured: false,
  status: "OFFLINE",
  statusText: "Belum Terkonfigurasi (SMTP Offline)",
  host: null,
  port: null,
  senderEmail: null,
  hasCredentials: false,
  lastChecked: "",
};

class NotificationSettingsStore {
  private settings: NotificationSettings = { ...DEFAULT_SETTINGS };
  private smtpStatus: SmtpConfigStatus = { ...DEFAULT_SMTP };
  private logs: NotificationLogItem[] = [];
  private listeners: Set<() => void> = new Set();
  private isInitialized = false;
  private isLoading = false;
  private isSaving = false;
  private isTesting = false;
  private lastError: string | null = null;
  private isDataStale = false;

  constructor() {
    if (this.getAuthHeader().Authorization) {
      this.fetchFromApi().catch(() => {});
    }
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

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  public getSettings(): NotificationSettings {
    return { ...this.settings, recipientEmails: [...this.settings.recipientEmails] };
  }

  public getSmtpStatus(): SmtpConfigStatus {
    return { ...this.smtpStatus };
  }

  public getLogs(): NotificationLogItem[] {
    return [...this.logs];
  }

  public getIsLoading(): boolean {
    return this.isLoading;
  }

  public getIsSaving(): boolean {
    return this.isSaving;
  }

  public getIsTesting(): boolean {
    return this.isTesting;
  }

  public getError(): string | null {
    return this.lastError;
  }

  public isStale(): boolean {
    return this.isDataStale;
  }

  /**
   * Fetch persistent settings and SMTP status from the backend API
   */
  public async fetchFromApi(): Promise<void> {
    this.isLoading = true;
    this.lastError = null;
    this.notify();

    try {
      const baseUrl = APP_CONFIG.apiBaseUrl.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/notifications/settings`, {
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
      });

      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload?.error?.message || errPayload?.message || `Gagal memuat pengaturan notifikasi (HTTP ${res.status})`);
      }

      const payload = await res.json();
      if (payload.success && payload.data) {
        if (payload.data.settings) {
          this.settings = {
            ...DEFAULT_SETTINGS,
            ...payload.data.settings,
          };
        }
        if (payload.data.smtpStatus) {
          this.smtpStatus = payload.data.smtpStatus;
        }
        this.lastError = null;
        this.isDataStale = false;
      }

      await this.fetchLogs();
    } catch (err: any) {
      this.lastError = err?.message || "Gagal memuat pengaturan notifikasi dari server.";
      this.isDataStale = true;
    } finally {
      this.isLoading = false;
      this.isInitialized = true;
      this.notify();
    }
  }

  /**
   * Fetch delivery history logs from API
   */
  public async fetchLogs(): Promise<NotificationLogItem[]> {
    try {
      const baseUrl = APP_CONFIG.apiBaseUrl.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/notifications/logs?limit=50`, {
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
      });

      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload?.error?.message || errPayload?.message || `Gagal memuat log notifikasi (HTTP ${res.status})`);
      }

      const payload = await res.json();
      if (payload.success && Array.isArray(payload.data)) {
        this.logs = payload.data;
        this.lastError = null;
        this.isDataStale = false;
        this.notify();
        return this.logs;
      }
    } catch (err: any) {
      this.lastError = err?.message || "Gagal memuat riwayat notifikasi dari server.";
      this.isDataStale = true;
      this.notify();
    }
    return this.logs;
  }

  /**
   * Update notification settings in backend and local store
   */
  public async saveSettings(customPayload?: Partial<NotificationSettings>): Promise<{ success: boolean; message: string }> {
    this.isSaving = true;
    this.lastError = null;
    this.notify();

    const payloadToSave = {
      recipientEmails: customPayload?.recipientEmails ?? this.settings.recipientEmails,
      notifyTagihanReminder: customPayload?.notifyTagihanReminder ?? this.settings.notifyTagihanReminder,
      notifyTagihanPerubahan: customPayload?.notifyTagihanPerubahan ?? this.settings.notifyTagihanPerubahan,
      notifyOrderUpdate: customPayload?.notifyOrderUpdate ?? this.settings.notifyOrderUpdate,
      notifyProsesGagal: customPayload?.notifyProsesGagal ?? this.settings.notifyProsesGagal,
    };

    // Validation
    for (const email of payloadToSave.recipientEmails) {
      if (!EMAIL_REGEX.test(email.trim())) {
        this.isSaving = false;
        this.notify();
        return { success: false, message: `Alamat email tidak valid: '${email}'.` };
      }
    }

    try {
      const baseUrl = APP_CONFIG.apiBaseUrl.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/notifications/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify(payloadToSave),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.success) {
        const message = payload?.error?.message || payload?.message || `Gagal menyimpan pengaturan notifikasi (HTTP ${res.status})`;
        this.isSaving = false;
        this.lastError = message;
        this.isDataStale = true;
        this.notify();
        return { success: false, message };
      }

      if (payload.data?.settings) {
        this.settings = payload.data.settings;
      } else {
        this.settings = {
          ...this.settings,
          ...payloadToSave,
          updatedAt: new Date().toISOString(),
        };
      }
      if (payload.data?.smtpStatus) {
        this.smtpStatus = payload.data.smtpStatus;
      }
      this.isSaving = false;
      this.lastError = null;
      this.isDataStale = false;
      this.notify();
      return { success: true, message: "Pengaturan notifikasi berhasil disimpan secara persisten." };
    } catch (err: any) {
      const message = err?.message || "Gagal menyimpan pengaturan notifikasi: server tidak dapat dihubungi.";
      this.isSaving = false;
      this.lastError = message;
      this.isDataStale = true;
      this.notify();
      return { success: false, message };
    }
  }

  /**
   * Add a recipient email with validation and duplicate prevention
   */
  public addRecipientEmail(email: string): { success: boolean; message: string } {
    const trimmed = email.trim();
    if (!trimmed) {
      return { success: false, message: "Alamat email tidak boleh kosong." };
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      return { success: false, message: "Format alamat email tidak valid (contoh: admin@sunbirojasa.com)." };
    }
    if (this.settings.recipientEmails.some((e) => e.toLowerCase() === trimmed.toLowerCase())) {
      return { success: false, message: "Alamat email sudah terdaftar dalam daftar penerima." };
    }

    this.settings.recipientEmails.push(trimmed);
    this.notify();
    return { success: true, message: `Email '${trimmed}' berhasil ditambahkan ke daftar penerima.` };
  }

  /**
   * Remove a recipient email by index
   */
  public removeRecipientEmail(index: number): { success: boolean; message: string } {
    if (index < 0 || index >= this.settings.recipientEmails.length) {
      return { success: false, message: "Indeks email tidak ditemukan." };
    }
    const removed = this.settings.recipientEmails[index];
    this.settings.recipientEmails.splice(index, 1);
    this.notify();
    return { success: true, message: `Email '${removed}' dihapus dari daftar penerima.` };
  }

  /**
   * Toggle a specific notification type
   */
  public toggleNotificationType(
    key: "notifyTagihanReminder" | "notifyTagihanPerubahan" | "notifyOrderUpdate" | "notifyProsesGagal",
    value: boolean
  ) {
    this.settings[key] = value;
    this.notify();
  }

  /**
   * Send a test email and capture real diagnostic result and log
   */
  public async sendTestEmail(targetEmail?: string): Promise<{ success: boolean; message: string; log?: NotificationLogItem }> {
    this.isTesting = true;
    this.lastError = null;
    this.notify();

    const emailToSend = targetEmail?.trim() || this.settings.recipientEmails[0];

    if (!emailToSend || !EMAIL_REGEX.test(emailToSend)) {
      this.isTesting = false;
      this.notify();
      return {
        success: false,
        message: "Silakan tentukan minimal 1 alamat email penerima yang valid sebelum mengirim email percobaan.",
      };
    }

    try {
      const baseUrl = APP_CONFIG.apiBaseUrl.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/notifications/test-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.getAuthHeader() },
        body: JSON.stringify({ email: emailToSend }),
      });

      const payload = await res.json().catch(() => ({}));
      await this.fetchLogs();

      if (!res.ok) {
        const errMessage = payload?.error?.message || payload?.message || `Gagal mengirim email percobaan (HTTP ${res.status})`;
        this.lastError = errMessage;
        this.isDataStale = true;
        this.isTesting = false;
        this.notify();
        return {
          success: false,
          message: errMessage,
          log: payload?.data?.log,
        };
      }

      this.isTesting = false;
      this.lastError = null;
      this.isDataStale = false;
      this.notify();

      return {
        success: Boolean(payload.success),
        message: payload.message || "Email percobaan diproses.",
        log: payload.data?.log,
      };
    } catch (err: any) {
      const errMessage = err?.message || "Pengiriman email percobaan gagal: Server backend tidak dapat dihubungi atau SMTP offline.";
      this.lastError = errMessage;
      this.isDataStale = true;
      this.isTesting = false;
      this.notify();

      return {
        success: false,
        message: errMessage,
      };
    }
  }
}

export const notificationSettingsStore = new NotificationSettingsStore();

/**
 * React hook for consuming and reacting to notification settings store updates
 */
export function useNotificationSettings() {
  const [, setTick] = useState(0);

  useEffect(() => {
    return notificationSettingsStore.subscribe(() => {
      setTick((t) => t + 1);
    });
  }, []);

  return {
    settings: notificationSettingsStore.getSettings(),
    smtpStatus: notificationSettingsStore.getSmtpStatus(),
    logs: notificationSettingsStore.getLogs(),
    isLoading: notificationSettingsStore.getIsLoading(),
    isSaving: notificationSettingsStore.getIsSaving(),
    isTesting: notificationSettingsStore.getIsTesting(),
    error: notificationSettingsStore.getError(),
    isStale: notificationSettingsStore.isStale(),
    saveSettings: (payload?: Partial<NotificationSettings>) => notificationSettingsStore.saveSettings(payload),
    addRecipientEmail: (email: string) => notificationSettingsStore.addRecipientEmail(email),
    removeRecipientEmail: (index: number) => notificationSettingsStore.removeRecipientEmail(index),
    toggleNotificationType: (
      key: "notifyTagihanReminder" | "notifyTagihanPerubahan" | "notifyOrderUpdate" | "notifyProsesGagal",
      value: boolean
    ) => notificationSettingsStore.toggleNotificationType(key, value),
    sendTestEmail: (email?: string) => notificationSettingsStore.sendTestEmail(email),
    fetchLogs: () => notificationSettingsStore.fetchLogs(),
    refresh: () => notificationSettingsStore.fetchFromApi(),
  };
}
