/**
 * Canonical Samsat COGS (Biaya Pokok Samsat) Resolver
 * Single Source of Truth shared between Frontend calculators/forms and Backend services.
 *
 * Financial Contract:
 * - biayaSamsat = PKB (pokok/tertunggak/denda PKB) + SWDKLLJ/OPSEN + Denda SWDKLLJ
 *   + Official Samsat Admin & PNBP / Mutasi / Proses components.
 * - biayaJasa and biayaAntarJemput are Biro operational/service charges and MUST NEVER be
 *   folded into biayaSamsat, nor deducted from Profit twice.
 * - Explicit Rp 0 (isExplicitZero / ZERO_EXPLICIT) is preserved as Rp 0 with costClassification = "EXPLICIT_ZERO".
 * - Missing / unconfigured tariffs are marked UNCONFIGURED or PARTIAL_ESTIMATE without inventing synthetic fallbacks.
 */

export type SamsatCostClassification =
  | "DEFINITIVE"
  | "EXPLICIT_ZERO"
  | "PARTIAL_ESTIMATE"
  | "UNCONFIGURED";

export interface SamsatCogsResolutionInput {
  biayaSamsat?: number | null;
  biayaJasa?: number | null;
  biayaAntarJemput?: number | null;
  biayaLainnya?: number | null;
  totalTagihan?: number | null;
  pkb?: number | null;
  dendaPkb?: number | null;
  swdkllj?: number | null;
  dendaSwdkllj?: number | null;
  mutasiKeluar?: number | null;
  mutasiMasuk?: number | null;
  pnbpSamsat?: number | null;
  costSnapshot?: any;
  isCostVerified?: boolean;
  isExplicitZero?: boolean;
  costCompletenessStatus?: string | null;
  costVerificationStatus?: string | null;
  isDraftEstimate?: boolean;
}

export interface SamsatCogsResolution {
  biayaSamsat: number;
  taxComponentTotal: number;
  samsatAdminTotal: number;
  biayaJasa: number;
  biayaAntarJemput: number;
  costClassification: SamsatCostClassification;
  isCostPending: boolean;
  isExplicitZero: boolean;
}

function toNonNegInt(val: unknown): number {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num);
}

function parseSnapshot(rawSnapshot: unknown): Record<string, any> | null {
  if (!rawSnapshot) return null;
  if (typeof rawSnapshot === "object") return rawSnapshot as Record<string, any>;
  if (typeof rawSnapshot === "string") {
    try {
      const parsed = JSON.parse(rawSnapshot);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isNonSamsatFeeItem(id: string, name: string, cat: string): boolean {
  if (
    cat === "jasa" ||
    cat === "antar jemput" ||
    cat === "operasional biro" ||
    cat === "fee biro" ||
    cat === "margin" ||
    cat === "cashback" ||
    cat === "komisi" ||
    cat === "diskon"
  ) {
    return true;
  }
  if (id === "biaya-jasa" || id === "biaya-antar-jemput" || id === "kurir") {
    return true;
  }
  if ((name.includes("biaya jasa") || name === "jasa") && !name.includes("samsat")) {
    return true;
  }
  if (name.includes("antar jemput") || name.includes("antar-jemput") || name.includes("biaya kurir")) {
    return true;
  }
  return false;
}

function isTaxComponentItem(id: string, name: string, cat: string): boolean {
  if (cat === "pajak") return true;
  return /\b(pkb|swdkllj|opsen|denda)\b/i.test(`${id} ${name}`);
}

export function resolveCanonicalSamsatCogs(input: SamsatCogsResolutionInput): SamsatCogsResolution {
  const snap = parseSnapshot(input.costSnapshot);
  const breakdown: any[] = Array.isArray(snap?.breakdown) ? snap!.breakdown : [];

  let breakdownTaxSum = 0;
  let breakdownAdminSum = 0;
  let breakdownJasa = 0;
  let breakdownCourier = 0;
  let hasExplicitZeroTariffInBreakdown = false;
  let hasUnconfiguredInBreakdown = false;

  for (const item of breakdown) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.itemId || item.id || "").toLowerCase().trim();
    const name = String(item.name || item.label || "").toLowerCase().trim();
    const cat = String(item.category || "").toLowerCase().trim();
    const status = String(item.status || "").toUpperCase().trim();

    if (status === "ZERO_EXPLICIT") {
      hasExplicitZeroTariffInBreakdown = true;
    }
    if (
      status === "UNCONFIGURED" ||
      item.isUnconfigured === true ||
      item.isConfigured === false
    ) {
      hasUnconfiguredInBreakdown = true;
    }

    const amount = toNonNegInt(item.nominal ?? item.amount ?? item.effectivePrice ?? item.price);

    if (isNonSamsatFeeItem(id, name, cat)) {
      if (id === "biaya-antar-jemput" || cat === "antar jemput" || name.includes("antar")) {
        breakdownCourier += amount;
      } else if (id === "biaya-jasa" || cat === "jasa" || name.includes("jasa")) {
        breakdownJasa += amount;
      }
      continue;
    }

    if (isTaxComponentItem(id, name, cat)) {
      breakdownTaxSum += amount;
    } else {
      breakdownAdminSum += amount;
    }
  }

  const pkbVal = Math.max(toNonNegInt(input.pkb), toNonNegInt(snap?.pkb));
  const dendaPkbVal = Math.max(toNonNegInt(input.dendaPkb), toNonNegInt(snap?.dendaPkb));
  const swdklljVal = Math.max(toNonNegInt(input.swdkllj), toNonNegInt(snap?.swdkllj));
  const dendaSwdklljVal = Math.max(toNonNegInt(input.dendaSwdkllj), toNonNegInt(snap?.dendaSwdkllj));
  const explicitTaxSum = pkbVal + dendaPkbVal + swdklljVal + dendaSwdklljVal;

  const extraSamsatVal =
    toNonNegInt(input.mutasiKeluar) +
    toNonNegInt(input.mutasiMasuk) +
    toNonNegInt(input.pnbpSamsat);

  const rawTaxTotal = Math.max(breakdownTaxSum, explicitTaxSum);
  const isLegacyStuffedAdminInDenda =
    breakdownTaxSum > 0 &&
    breakdownAdminSum > 0 &&
    explicitTaxSum === breakdownTaxSum + breakdownAdminSum;
  const taxComponentTotal = isLegacyStuffedAdminInDenda ? breakdownTaxSum : rawTaxTotal;
  const samsatAdminTotal = breakdownAdminSum > 0 ? breakdownAdminSum : extraSamsatVal;
  const itemizedSamsatTotal = taxComponentTotal + samsatAdminTotal;

  const biayaJasa = toNonNegInt(input.biayaJasa ?? snap?.biayaJasa ?? breakdownJasa);
  const biayaAntarJemput = toNonNegInt(
    input.biayaAntarJemput ?? snap?.biayaAntarJemput ?? breakdownCourier
  );

  const inputBiayaSamsat =
    input.biayaSamsat !== undefined && input.biayaSamsat !== null
      ? toNonNegInt(input.biayaSamsat)
      : null;
  const snapBiayaSamsat =
    snap?.biayaSamsat !== undefined && snap?.biayaSamsat !== null
      ? toNonNegInt(snap.biayaSamsat)
      : null;

  const rawCompleteness = String(
    input.costCompletenessStatus || snap?.completenessStatus || ""
  ).toUpperCase().trim();
  const rawVerification = String(
    input.costVerificationStatus || snap?.costVerificationStatus || ""
  ).toUpperCase().trim();

  const isPartialOrUnconfigured =
    Boolean(input.isDraftEstimate) ||
    Boolean(snap?.hasUnconfiguredTariff) ||
    hasUnconfiguredInBreakdown ||
    rawCompleteness === "PARTIAL_ESTIMATE" ||
    rawCompleteness === "PARTIAL" ||
    rawCompleteness === "UNCONFIGURED" ||
    rawVerification === "UNCONFIGURED";

  const isVerifiedFinalCost = Boolean(
    input.isCostVerified || rawVerification === "VERIFIED" || rawVerification === "DEFINITIVE"
  );

  let resolvedBiayaSamsat = 0;
  if (isVerifiedFinalCost && inputBiayaSamsat !== null) {
    // Stage 5 / explicit cost verification explicitly sets final actual Samsat outlay.
    resolvedBiayaSamsat = itemizedSamsatTotal > inputBiayaSamsat && taxComponentTotal > 0 && explicitTaxSum === 0
      ? inputBiayaSamsat
      : Math.max(inputBiayaSamsat, taxComponentTotal > 0 && inputBiayaSamsat === 0 ? itemizedSamsatTotal : inputBiayaSamsat);
  } else if (itemizedSamsatTotal > 0) {
    resolvedBiayaSamsat = Math.max(inputBiayaSamsat ?? 0, snapBiayaSamsat ?? 0, itemizedSamsatTotal);
  } else {
    resolvedBiayaSamsat = Math.max(inputBiayaSamsat ?? 0, snapBiayaSamsat ?? 0);
  }

  const totalTagihan = toNonNegInt(input.totalTagihan ?? snap?.totalBiaya ?? snap?.grandTotal);

  const explicitZeroFlag = Boolean(
    input.isExplicitZero ||
      snap?.isExplicitZero ||
      snap?.costClassification === "EXPLICIT_ZERO" ||
      rawVerification === "EXPLICIT_ZERO" ||
      (hasExplicitZeroTariffInBreakdown && !isPartialOrUnconfigured && resolvedBiayaSamsat === 0)
  );

  let costClassification: SamsatCostClassification = "DEFINITIVE";
  if (isPartialOrUnconfigured) {
    costClassification =
      rawVerification === "UNCONFIGURED" || rawCompleteness === "UNCONFIGURED"
        ? "UNCONFIGURED"
        : "PARTIAL_ESTIMATE";
  } else if (resolvedBiayaSamsat === 0) {
    if (explicitZeroFlag || isVerifiedFinalCost || (totalTagihan === 0 && rawVerification !== "UNCONFIGURED")) {
      costClassification = "EXPLICIT_ZERO";
    } else if (rawVerification === "PENDING_VERIFICATION" || !isVerifiedFinalCost) {
      costClassification = "UNCONFIGURED";
    } else {
      costClassification = "EXPLICIT_ZERO";
    }
  } else {
    costClassification = "DEFINITIVE";
  }

  const isCostPending =
    costClassification === "UNCONFIGURED" || costClassification === "PARTIAL_ESTIMATE";

  return {
    biayaSamsat: resolvedBiayaSamsat,
    taxComponentTotal,
    samsatAdminTotal,
    biayaJasa,
    biayaAntarJemput,
    costClassification,
    isCostPending,
    isExplicitZero: costClassification === "EXPLICIT_ZERO",
  };
}
