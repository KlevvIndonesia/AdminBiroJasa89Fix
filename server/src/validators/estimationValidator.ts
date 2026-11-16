/**
 * Estimation Template Configuration Validator
 * Admin SUN89 — Biro Jasa Management System
 *
 * Enforces strict schema, bounds, finite number checking, and structural integrity
 * before any estimation template configuration is written to SQLite.
 */

import {
  EstimationTemplateConfig,
  EstimationComponentRule,
  ComponentCategory,
  ComponentValueType,
  CalculationMethod,
} from "../../../src/domain/estimation/types";
import { BUILTIN_RULE_HANDLERS } from "../../../src/domain/estimation/estimationEngine";
import { ApiError } from "../middleware/errorHandler";

export const VALID_COMPONENT_CATEGORIES: readonly ComponentCategory[] = [
  "PKB",
  "DENDA_PKB",
  "SWDKLLJ",
  "DENDA_SWDKLLJ",
  "ADMIN",
  "JASA",
  "INSIDENTAL",
  "ACC_ID",
  "PROSES",
  "BBN",
] as const;

export const VALID_VALUE_TYPES: readonly ComponentValueType[] = [
  "formula",
  "conditional",
  "manual",
] as const;

export const VALID_CALCULATION_METHODS: readonly CalculationMethod[] = [
  "fixed_amount",
  "manual_amount",
  "percentage_of_base",
  "pkb_penalty_by_month",
  "annual_rate_by_arrears",
  "regional_allocation",
  "formula_rule",
] as const;

export const VALID_RULE_IDS = new Set<string>(Object.keys(BUILTIN_RULE_HANDLERS));

export const ESTIMATION_NUMERIC_BOUNDS = {
  koefisienDenda: { min: 0, max: 5, integer: false, label: "Koefisien denda" },
  pembagiBulan: { min: 1, max: 60, integer: true, label: "Pembagi bulan" },
  kelipatanPembulatan: { min: 1, max: 10_000_000, integer: true, label: "Kelipatan pembulatan" },
  biayaJasa: { min: 0, max: 100_000_000, integer: false, label: "Biaya jasa" },
  swdklljPokok: { min: 0, max: 50_000_000, integer: false, label: "SWDKLLJ pokok" },
  dendaSwdklljPokok: { min: 0, max: 50_000_000, integer: false, label: "Denda SWDKLLJ pokok" },
  biayaCetakSkp: { min: 0, max: 50_000_000, integer: false, label: "Biaya cetak SKP" },
  adminStnk: { min: 0, max: 50_000_000, integer: false, label: "Admin STNK" },
  adminTnkb: { min: 0, max: 50_000_000, integer: false, label: "Admin TNKB" },
} as const;

export type NumericParamKey = keyof typeof ESTIMATION_NUMERIC_BOUNDS;

function assertFiniteNumberField(
  val: unknown,
  fieldLabel: string,
  min: number,
  max: number,
  requireInteger = false
): number {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new ApiError(
      400,
      "INVALID_PARAMETER",
      `${fieldLabel} harus berupa angka finite yang valid (bukan null/NaN/Infinity/string).`
    );
  }
  if (val < min || val > max) {
    throw new ApiError(
      400,
      "INVALID_PARAMETER",
      `${fieldLabel} harus berada dalam rentang ${min.toLocaleString("id-ID")} hingga ${max.toLocaleString("id-ID")}.`
    );
  }
  if (requireInteger && !Number.isInteger(val)) {
    throw new ApiError(
      400,
      "INVALID_PARAMETER",
      `${fieldLabel} harus berupa bilangan bulat.`
    );
  }
  return val;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function validateComponentRule(raw: unknown, index: number, seenIds: Set<string>): void {
  if (!isPlainObject(raw)) {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `Komponen pada indeks ${index} harus berupa objek konfigurasi valid.`
    );
  }

  const comp = raw as Partial<EstimationComponentRule>;
  const id = typeof comp.id === "string" ? comp.id.trim() : "";
  if (!id || id.length > 100) {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `Komponen pada indeks ${index} wajib memiliki 'id' string non-kosong (maksimal 100 karakter).`
    );
  }
  if (seenIds.has(id)) {
    throw new ApiError(
      400,
      "DUPLICATE_COMPONENT_ID",
      `ID komponen '${id}' duplikat; setiap komponen wajib memiliki ID unik.`
    );
  }
  seenIds.add(id);

  const code = typeof comp.code === "string" ? comp.code.trim() : "";
  if (!code || code.length > 50) {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `Komponen '${id}' wajib memiliki 'code' string non-kosong (maksimal 50 karakter).`
    );
  }

  const name = typeof comp.name === "string" ? comp.name.trim() : "";
  if (!name || name.length > 150) {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `Komponen '${id}' wajib memiliki 'name' string non-kosong (maksimal 150 karakter).`
    );
  }

  if (
    typeof comp.category !== "string" ||
    !(VALID_COMPONENT_CATEGORIES as readonly string[]).includes(comp.category)
  ) {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `Kategori komponen '${id}' tidak valid ('${String(comp.category)}').`
    );
  }

  if (
    typeof comp.valueType !== "string" ||
    !(VALID_VALUE_TYPES as readonly string[]).includes(comp.valueType)
  ) {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `valueType komponen '${id}' tidak valid ('${String(comp.valueType)}').`
    );
  }

  assertFiniteNumberField(comp.defaultValue, `defaultValue komponen '${id}'`, 0, 1_000_000_000);

  if (typeof comp.isActive !== "boolean") {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `Field 'isActive' pada komponen '${id}' wajib berupa boolean.`
    );
  }

  if (typeof comp.includesInTotal !== "boolean") {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `Field 'includesInTotal' pada komponen '${id}' wajib berupa boolean.`
    );
  }

  if (comp.displayOrder !== undefined) {
    assertFiniteNumberField(comp.displayOrder, `displayOrder komponen '${id}'`, 0, 10_000, true);
  }

  if (comp.minAmount !== undefined) {
    assertFiniteNumberField(comp.minAmount, `minAmount komponen '${id}'`, 0, 1_000_000_000);
  }
  if (comp.maxAmount !== undefined) {
    assertFiniteNumberField(comp.maxAmount, `maxAmount komponen '${id}'`, 0, 1_000_000_000);
  }
  if (
    typeof comp.minAmount === "number" &&
    typeof comp.maxAmount === "number" &&
    comp.minAmount > comp.maxAmount
  ) {
    throw new ApiError(
      400,
      "INVALID_COMPONENT",
      `minAmount komponen '${id}' tidak boleh lebih besar dari maxAmount.`
    );
  }
  if (comp.ratePercentage !== undefined) {
    assertFiniteNumberField(comp.ratePercentage, `ratePercentage komponen '${id}'`, 0, 1_000);
  }

  if (comp.calculationMethod !== undefined) {
    if (
      typeof comp.calculationMethod !== "string" ||
      !(VALID_CALCULATION_METHODS as readonly string[]).includes(comp.calculationMethod)
    ) {
      throw new ApiError(
        400,
        "INVALID_COMPONENT",
        `calculationMethod komponen '${id}' tidak valid ('${String(comp.calculationMethod)}').`
      );
    }
  }

  if (comp.applicableVehicles !== undefined) {
    if (comp.applicableVehicles !== "Mobil" && comp.applicableVehicles !== "Motor" && comp.applicableVehicles !== "Semua") {
      throw new ApiError(
        400,
        "INVALID_COMPONENT",
        `applicableVehicles komponen '${id}' harus 'Mobil', 'Motor', atau 'Semua'.`
      );
    }
  }

  if (comp.ruleId !== undefined) {
    if (typeof comp.ruleId !== "string" || !comp.ruleId.trim()) {
      throw new ApiError(
        400,
        "INVALID_COMPONENT",
        `ruleId komponen '${id}' tidak boleh string kosong jika disertakan.`
      );
    }
    if (!VALID_RULE_IDS.has(comp.ruleId)) {
      throw new ApiError(
        400,
        "INVALID_RULE_REFERENCE",
        `ruleId '${comp.ruleId}' pada komponen '${id}' tidak terdaftar dalam Estimation Rule Registry.`
      );
    }
  } else if (comp.valueType === "formula") {
    throw new ApiError(
      400,
      "INVALID_RULE_REFERENCE",
      `Komponen formula '${id}' wajib memiliki 'ruleId' yang valid.`
    );
  }
}

function validateAccIdRates(rawRates: unknown): void {
  if (!isPlainObject(rawRates)) {
    throw new ApiError(
      400,
      "INVALID_ACC_ID_RATES",
      "accIdRates harus berupa objek mapping wilayah -> nominal non-negatif."
    );
  }

  const entries = Object.entries(rawRates);
  if (entries.length === 0) {
    throw new ApiError(
      400,
      "INVALID_ACC_ID_RATES",
      "accIdRates tidak boleh berupa objek kosong."
    );
  }

  for (const [regionKey, rateValue] of entries) {
    if (!regionKey || !regionKey.trim()) {
      throw new ApiError(
        400,
        "INVALID_ACC_ID_RATES",
        "Nama wilayah pada accIdRates tidak boleh kosong."
      );
    }
    assertFiniteNumberField(rateValue, `Tarif ACC ID '${regionKey}'`, 0, 50_000_000);
  }
}

/**
 * Validates incoming partial/full estimation template update payload against existing template state.
 * Throws ApiError(400) immediately on the first violation without mutating DB state.
 */
export function validateEstimationTemplateUpdate(
  targetId: string,
  payload: unknown,
  existing: EstimationTemplateConfig
): Partial<EstimationTemplateConfig> {
  if (!isPlainObject(payload)) {
    throw new ApiError(400, "INVALID_PAYLOAD", "Payload pembaruan template harus berupa objek JSON yang valid.");
  }

  const updates = payload as Partial<EstimationTemplateConfig>;

  if (Object.keys(updates).length === 0) {
    throw new ApiError(400, "EMPTY_PAYLOAD", "Payload pembaruan template tidak boleh kosong.");
  }

  if (updates.id !== undefined) {
    if (typeof updates.id !== "string" || updates.id.trim() !== targetId) {
      throw new ApiError(
        400,
        "TEMPLATE_ID_MISMATCH",
        `ID template pada body ('${String(updates.id)}') harus cocok dengan parameter URL ('${targetId}').`
      );
    }
  }

  if (updates.name !== undefined) {
    if (typeof updates.name !== "string" || !updates.name.trim() || updates.name.trim().length > 200) {
      throw new ApiError(400, "INVALID_PARAMETER", "Nama template wajib berupa string non-kosong (maksimal 200 karakter).");
    }
  }

  if (updates.serviceType !== undefined && updates.serviceType !== existing.serviceType) {
    throw new ApiError(
      400,
      "IMMUTABLE_FIELD",
      `serviceType template ('${existing.serviceType}') bersifat immutable dan tidak dapat diubah ke '${String(updates.serviceType)}'.`
    );
  }

  if (updates.vehicleType !== undefined && updates.vehicleType !== existing.vehicleType) {
    throw new ApiError(
      400,
      "IMMUTABLE_FIELD",
      `vehicleType template ('${existing.vehicleType}') bersifat immutable dan tidak dapat diubah ke '${String(updates.vehicleType)}'.`
    );
  }

  for (const key of Object.keys(ESTIMATION_NUMERIC_BOUNDS) as NumericParamKey[]) {
    const val = updates[key];
    if (val !== undefined) {
      const bounds = ESTIMATION_NUMERIC_BOUNDS[key];
      assertFiniteNumberField(val, bounds.label, bounds.min, bounds.max, bounds.integer);
    }
  }

  if (updates.components !== undefined) {
    if (!Array.isArray(updates.components)) {
      throw new ApiError(400, "INVALID_COMPONENT", "Field 'components' harus berupa array komponen.");
    }
    if (updates.components.length === 0) {
      throw new ApiError(
        400,
        "INVALID_COMPONENT",
        "Daftar 'components' tidak boleh kosong."
      );
    }
    const seenIds = new Set<string>();
    updates.components.forEach((comp, idx) => validateComponentRule(comp, idx, seenIds));
  }

  if (updates.accIdRates !== undefined) {
    validateAccIdRates(updates.accIdRates);
  }

  if (updates.description !== undefined && typeof updates.description !== "string") {
    throw new ApiError(400, "INVALID_PARAMETER", "Deskripsi template harus berupa string.");
  }

  return updates;
}
