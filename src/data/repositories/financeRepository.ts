/**
 * Finance Repository Interface and Implementation
 * Admin SUN89 — Biro Jasa Management System
 * 
 * Provides the data access layer between state management / stores
 * and underlying data providers (Mock provider vs API provider).
 */

import {
  InvoiceBillingRecord,
  ProfitItem,
  KasKantorItem,
  KasMessengerItem,
  PengeluaranItem,
  IFinanceDataProvider,
} from "../../domain/finance/types";
import { ApiFinanceProvider } from "../api/apiFinanceProvider";

export interface IFinanceRepository {
  getInvoices(): InvoiceBillingRecord[];
  getTagihanList(): InvoiceBillingRecord[];
  getCompletedTagihanList(): InvoiceBillingRecord[];
  getInvoiceById(id: number): InvoiceBillingRecord | undefined;
  getInvoiceByOrderNo(orderNo: string): InvoiceBillingRecord | undefined;
  getProfitList(): ProfitItem[];
  fetchFilteredProfitList?(
    filters?: {
      paymentMethodId?: string;
      startDate?: string;
      endDate?: string;
      category?: string;
    },
    options?: { signal?: AbortSignal }
  ): Promise<ProfitItem[] | null>;
  getKasKantorList(): KasKantorItem[];
  getKasMessengerList(): KasMessengerItem[];
  getPengeluaranList(): PengeluaranItem[];
  subscribe(listener: () => void): () => void;
  recordPayment(idOrInvoice: number | string, paymentAmount: number, details?: any): boolean | Promise<boolean>;
  resolveInvoice(id: number, details?: any): boolean;
  completeInvoice(id: number, completedBy?: string): boolean | Promise<boolean>;
  payoutCashback?(id: number, payoutData: any): Promise<boolean> | boolean;
  completeCashback?(id: number, payload?: { catatan?: string; idempotencyKey?: string; expectedVersion?: number }): Promise<InvoiceBillingRecord | boolean>;
  voidInvoicePayment?(id: number, paymentId: number, reason: string): Promise<boolean> | boolean;
  voidCashbackPayout?(id: number, reason: string): Promise<boolean> | boolean;
  getVoidAuditHistory?(): Promise<{ payments: any[]; cashbacks: any[] }>;
  addKasKantor?(item: Omit<KasKantorItem, "id">): KasKantorItem | null;
  addKasKantorAsync?(item: Omit<KasKantorItem, "id">): Promise<KasKantorItem>;
  updateKasKantor?(id: number, updates: Partial<KasKantorItem> & { reason?: string }): Promise<KasKantorItem>;
  deleteKasKantor?(id: number, reason: string, idempotencyKey?: string): Promise<boolean> | boolean;
  addKasMessenger?(item: Omit<KasMessengerItem, "id" | "total"> & { total?: number }): KasMessengerItem | null;
  addKasMessengerAsync?(item: Omit<KasMessengerItem, "id" | "total"> & { total?: number }): Promise<KasMessengerItem>;
  updateKasMessenger?(id: number, updates: Partial<KasMessengerItem> & { reason?: string }): Promise<KasMessengerItem>;
  deleteKasMessenger?(id: number, reason: string, idempotencyKey?: string): Promise<boolean> | boolean;
  refreshKasKantor?(): Promise<void>;
  refreshKasMessenger?(): Promise<void>;
  addPengeluaran?(item: Omit<PengeluaranItem, "id">): PengeluaranItem | null;
  deletePengeluaran?(id: number, reason: string, idempotencyKey?: string): Promise<boolean> | boolean;
  saveInvoice?(invoice: InvoiceBillingRecord): void;
  setProvider?(provider: IFinanceDataProvider): void;
  getProvider?(): IFinanceDataProvider;
  isLoading?(): boolean;
  getError?(): Error | null;
  getProfitError?(): Error | null;
  initFromApi?(): Promise<void>;
}

export class FinanceRepository implements IFinanceRepository {
  private provider: IFinanceDataProvider;

  constructor(provider?: IFinanceDataProvider) {
    this.provider = provider || new ApiFinanceProvider();
  }

  public setProvider(provider: IFinanceDataProvider): void {
    this.provider = provider;
  }

  public getProvider(): IFinanceDataProvider {
    return this.provider;
  }

  public getInvoices(): InvoiceBillingRecord[] {
    return this.provider.getInvoices();
  }

  public getTagihanList(): InvoiceBillingRecord[] {
    return this.provider.getTagihanList();
  }

  public getCompletedTagihanList(): InvoiceBillingRecord[] {
    return this.provider.getCompletedTagihanList();
  }

  public getInvoiceById(id: number): InvoiceBillingRecord | undefined {
    return this.provider.getInvoiceById(id);
  }

  public getInvoiceByOrderNo(orderNo: string): InvoiceBillingRecord | undefined {
    return this.provider.getInvoiceByOrderNo(orderNo);
  }

  public getProfitList(): ProfitItem[] {
    return this.provider.getProfitList();
  }

  public async fetchFilteredProfitList(
    filters?: {
      paymentMethodId?: string;
      startDate?: string;
      endDate?: string;
      category?: string;
    },
    options?: { signal?: AbortSignal }
  ): Promise<ProfitItem[] | null> {
    const providerAny: any = this.provider;
    if (typeof providerAny?.fetchFilteredProfitList === "function") {
      return providerAny.fetchFilteredProfitList(filters, options);
    }
    return null;
  }

  public getKasKantorList(): KasKantorItem[] {
    return this.provider.getKasKantorList();
  }

  public getKasMessengerList(): KasMessengerItem[] {
    return this.provider.getKasMessengerList();
  }

  public getPengeluaranList(): PengeluaranItem[] {
    return this.provider.getPengeluaranList();
  }

  public subscribe(listener: () => void): () => void {
    return this.provider.subscribe(listener);
  }

  public recordPayment(idOrInvoice: number | string, paymentAmount: number, details?: any): boolean | Promise<boolean> {
    return this.provider.recordPayment(idOrInvoice, paymentAmount, details);
  }

  public resolveInvoice(id: number, details?: any): boolean {
    return this.provider.resolveInvoice(id, details);
  }

  public completeInvoice(id: number, completedBy?: string): boolean | Promise<boolean> {
    return this.provider.completeInvoice(id, completedBy);
  }

  public async completeCashback(
    id: number,
    payload?: { catatan?: string; idempotencyKey?: string; expectedVersion?: number }
  ): Promise<InvoiceBillingRecord | boolean> {
    if (this.provider.completeCashback) {
      return await this.provider.completeCashback(id, payload);
    }
    throw new Error("Provider keuangan aktif tidak mendukung penyelesaian cashback.");
  }

  public async payoutCashback(id: number, payoutData: any): Promise<boolean> {
    if (this.provider.payoutCashback) {
      return await this.provider.payoutCashback(id, payoutData);
    }
    return false;
  }

  public async voidInvoicePayment(id: number, paymentId: number, reason: string): Promise<boolean> {
    if (this.provider.voidInvoicePayment) {
      return await this.provider.voidInvoicePayment(id, paymentId, reason);
    }
    return false;
  }

  public async voidCashbackPayout(id: number, reason: string): Promise<boolean> {
    if (this.provider.voidCashbackPayout) {
      return await this.provider.voidCashbackPayout(id, reason);
    }
    return false;
  }

  public async getVoidAuditHistory(): Promise<{ payments: any[]; cashbacks: any[] }> {
    if (this.provider.getVoidAuditHistory) {
      return await this.provider.getVoidAuditHistory();
    }
    return { payments: [], cashbacks: [] };
  }

  public addKasKantor(item: Omit<KasKantorItem, "id">): KasKantorItem | null {
    return this.provider.addKasKantor ? this.provider.addKasKantor(item) : null;
  }

  public async addKasKantorAsync(item: Omit<KasKantorItem, "id">): Promise<KasKantorItem> {
    if (this.provider.addKasKantorAsync) {
      return await this.provider.addKasKantorAsync(item);
    }
    const created = this.addKasKantor(item);
    if (!created) throw new Error("Gagal menambahkan data Kas Kantor.");
    return created;
  }

  public async updateKasKantor(id: number, updates: Partial<KasKantorItem> & { reason?: string }): Promise<KasKantorItem> {
    if (this.provider.updateKasKantor) {
      return await this.provider.updateKasKantor(id, updates);
    }
    throw new Error("Provider keuangan aktif tidak mendukung pengeditan Kas Kantor.");
  }

  public async deleteKasKantor(id: number, reason: string, idempotencyKey?: string): Promise<boolean> {
    if (this.provider.deleteKasKantor) {
      return await this.provider.deleteKasKantor(id, reason, idempotencyKey);
    }
    return false;
  }

  public addKasMessenger(item: Omit<KasMessengerItem, "id" | "total"> & { total?: number }): KasMessengerItem | null {
    return this.provider.addKasMessenger ? this.provider.addKasMessenger(item) : null;
  }

  public async addKasMessengerAsync(item: Omit<KasMessengerItem, "id" | "total"> & { total?: number }): Promise<KasMessengerItem> {
    if (this.provider.addKasMessengerAsync) {
      return await this.provider.addKasMessengerAsync(item);
    }
    const created = this.addKasMessenger(item);
    if (!created) throw new Error("Gagal menambahkan data Kas Messenger.");
    return created;
  }

  public async updateKasMessenger(id: number, updates: Partial<KasMessengerItem> & { reason?: string }): Promise<KasMessengerItem> {
    if (this.provider.updateKasMessenger) {
      return await this.provider.updateKasMessenger(id, updates);
    }
    throw new Error("Provider keuangan aktif tidak mendukung pengeditan Kas Messenger.");
  }

  public async refreshKasKantor(): Promise<void> {
    if (this.provider.refreshKasKantor) {
      await this.provider.refreshKasKantor();
    }
  }

  public async refreshKasMessenger(): Promise<void> {
    if (this.provider.refreshKasMessenger) {
      await this.provider.refreshKasMessenger();
    }
  }

  public async deleteKasMessenger(id: number, reason: string, idempotencyKey?: string): Promise<boolean> {
    if (this.provider.deleteKasMessenger) {
      return await this.provider.deleteKasMessenger(id, reason, idempotencyKey);
    }
    return false;
  }

  public addPengeluaran(item: Omit<PengeluaranItem, "id">): PengeluaranItem | null {
    return this.provider.addPengeluaran ? this.provider.addPengeluaran(item) : null;
  }

  public async deletePengeluaran(id: number, reason: string, idempotencyKey?: string): Promise<boolean> {
    if (this.provider.deletePengeluaran) {
      return await this.provider.deletePengeluaran(id, reason, idempotencyKey);
    }
    return false;
  }

  public saveInvoice(invoice: InvoiceBillingRecord): void {
    if (this.provider.saveInvoice) {
      this.provider.saveInvoice(invoice);
    }
  }

  public isLoading(): boolean {
    return this.provider.isLoading ? this.provider.isLoading() : false;
  }

  public getError(): Error | null {
    return this.provider.getError ? this.provider.getError() : null;
  }

  public getProfitError(): Error | null {
    const providerAny: any = this.provider;
    if (typeof providerAny?.getProfitError === "function") {
      return providerAny.getProfitError();
    }
    return this.getError();
  }

  public async initFromApi(): Promise<void> {
    if (this.provider && typeof (this.provider as any).initFromApi === "function") {
      await (this.provider as any).initFromApi();
    }
  }
}

// Backward compatibility alias
export const InMemoryFinanceRepository = FinanceRepository;
export const financeRepository = new FinanceRepository();
