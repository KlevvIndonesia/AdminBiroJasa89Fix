/**
 * Pure Domain Estimation Template Sanitizer & ID Resolver
 * Admin SUN89 — Biro Jasa Management System
 *
 * Strictly pure TypeScript module with zero React, browser/DOM, store,
 * database, or hardcoded business pricing override dependencies.
 * Safe to import from both Node/Express backend and React frontend.
 */

import { EstimationComponentRule, EstimationTemplateConfig } from "./types";

/**
 * Resolves the canonical estimation template ID for a given service name & vehicle type.
 */
export function resolveTemplateIdByService(service: string, vehicle: "Mobil" | "Motor"): string {
  const isMobil = vehicle === "Mobil";
  const normalized = (service || "").toLowerCase();

  if (normalized.includes("1 tahun") || normalized === "tahunan") {
    return isMobil ? "template-pajak-tahunan-r4" : "template-pajak-tahunan-r2";
  }
  if (normalized.includes("5 tahun")) {
    return isMobil ? "template-pajak-5-tahun-r4" : "template-pajak-5-tahun-r2";
  }
  if (normalized.includes("balik") || normalized.includes("bbn")) {
    return isMobil ? "template-bbn-r4" : "template-bbn-r2";
  }
  if (normalized.includes("antar samsat") || normalized.includes("mutasi as")) {
    return isMobil ? "template-mutasi-as-r4" : "template-mutasi-as-r2";
  }
  if (normalized.includes("luar daerah") || normalized.includes("mutasi ld")) {
    return isMobil ? "template-mutasi-ld-r4" : "template-mutasi-ld-r2";
  }
  return isMobil ? "template-pajak-tahunan-r4" : "template-pajak-tahunan-r2";
}

/**
 * Clean sanitization for formula & component descriptions.
 * Eliminates all Excel cell references (e.g. Cell C15, (Cell F15)), Sheet names,
 * and converts raw ROUNDUP expressions into clean, professional Indonesian descriptions.
 */
export function sanitizeComponentDescription(desc: string | undefined): string {
  if (!desc || typeof desc !== "string") return "";
  let s = desc;

  // 1. Remove Excel cell references and sheet references
  s = s.replace(/\s*\((?:Cell|Sheet)\s*[^)]+\)/gi, "");
  s = s.replace(/\b(?:Cell|Sheet)\s+[A-Z0-9/]+/gi, "");
  s = s.replace(/\s*\(\s*\)/g, "");

  // 2. Transform raw ROUNDUP formulas into friendly Indonesian text
  s = s.replace(/ROUNDUP\s*\(([^,;]+)[,;]\s*-?3?\s*\)/gi, "$1, dibulatkan ke kelipatan Rp 1.000");

  // 3. Fix division symbol / with ÷ for consistent formatting
  s = s.replace(/\s*\/\s*12\s*[\*×]/g, " ÷ 12 × ");

  // 4. Transform specific technical formula descriptions into standard friendly text
  const trimmed = s.trim();

  if (/PKB Tertunggak\s*[×x*]\s*Koefisien Denda/i.test(trimmed)) {
    return "PKB Tertunggak × Koefisien Denda, dibulatkan ke kelipatan Rp 1.000";
  }
  if (/PKB Dasar\s*[×x*]\s*Koefisien Denda.*Bulan Tunggakan/i.test(trimmed)) {
    return "PKB Dasar × Koefisien Denda ÷ 12 × Bulan Tunggakan, dibulatkan ke kelipatan Rp 1.000";
  }
  if (/^PKB Dasar$/i.test(trimmed) || /^PKB Dasar\s*\(1 Tahun Berjalan\)$/i.test(trimmed)) {
    return "PKB Dasar";
  }
  if (/^PKB Dasar\s*[×x*]\s*Tahun Tunggakan$/i.test(trimmed)) {
    return "PKB Dasar × Tahun Tunggakan";
  }
  if (/^SWDKLLJ Pokok Tahunan.*$/i.test(trimmed)) {
    return "SWDKLLJ Pokok Tahunan";
  }
  if (/^SWDKLLJ Pokok.*[×x*]\s*Tahun Tunggakan/i.test(trimmed)) {
    return "SWDKLLJ Pokok × Tahun Tunggakan";
  }
  if (/^(?:Rp\s*[\d.]+\s*[×x*]\s*Tahun Tunggakan|Denda SWDKLLJ.*Tahun Tunggakan)/i.test(trimmed)) {
    return "Denda SWDKLLJ berdasarkan Tahun Tunggakan";
  }
  if (/^(?:Rp\s*[\d.]+\s*jika Bulan Tunggakan|Denda SWDKLLJ.*Bulan Tunggakan)/i.test(trimmed)) {
    return "Denda SWDKLLJ berdasarkan Bulan Tunggakan";
  }
  if (/^Rp\s*[\d.]+\s*jika terdapat keterlambatan/i.test(trimmed) || /^Biaya cetak SKP jika terdapat keterlambatan/i.test(trimmed)) {
    return "Biaya cetak SKP jika terdapat keterlambatan";
  }

  return trimmed;
}

function sanitizeComponentRule(comp: EstimationComponentRule): EstimationComponentRule {
  return {
    ...comp,
    description: comp.description !== undefined ? sanitizeComponentDescription(comp.description) : comp.description,
    formulaCondition: comp.formulaCondition ? sanitizeComponentDescription(comp.formulaCondition) : undefined,
    humanFormula: comp.humanFormula ? sanitizeComponentDescription(comp.humanFormula) : undefined,
  };
}

/**
 * Pure structural and text sanitizer for EstimationTemplateConfig.
 * Strips legacy Excel cell references without overriding persisted business pricing values.
 */
export function sanitizeEstimationTemplate(tpl: EstimationTemplateConfig): EstimationTemplateConfig {
  if (!tpl) return tpl;

  return {
    ...tpl,
    description: tpl.description !== undefined ? sanitizeComponentDescription(tpl.description) : tpl.description,
    components: Array.isArray(tpl.components) ? tpl.components.map(sanitizeComponentRule) : [],
    accIdRates: tpl.accIdRates && typeof tpl.accIdRates === "object" ? { ...tpl.accIdRates } : {},
  };
}
