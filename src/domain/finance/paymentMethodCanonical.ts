/**
 * Canonical Payment Method Resolution & Profit Breakdown Helpers
 * Shared between Backend SQLite Repository and Frontend Profit UI/Stores.
 */

export interface CanonicalPaymentMethodRecord {
  id: string;
  nama_metode: string;
  bank: string;
  nama_rekening?: string | null;
  nomor_rekening?: string | null;
  status: string;
}

export interface ProfitPaymentBreakdownEntry {
  paymentMethodId: string | null;
  paymentMethodLabel: string;
  paymentMethodStatus: string | null;
  metodePencairan: string;
  namaBank: string;
  nomorRekening: string;
  namaPemilikRekening: string;
  nominal: number;
  count: number;
  tanggalBayar?: string;
}

const KNOWN_COMMERCIAL_BANKS = [
  "bca",
  "cimb",
  "muamalat",
  "mandiri",
  "bri",
  "bni",
  "bsi",
  "permata",
  "danamon",
  "ocbc",
  "panin",
  "mega",
  "maybank",
  "jenius",
  "jago",
  "seabank",
];

export function isPaymentSchemeString(raw?: string | null): boolean {
  if (!raw) return false;
  const s = raw.toLowerCase().trim();
  return (
    s.includes("bayar di awal") ||
    s.includes("bayar di akhir") ||
    s.includes("tempo") ||
    s === "-" ||
    s === "—"
  );
}

export function isCashPaymentString(raw?: string | null): boolean {
  if (!raw || isPaymentSchemeString(raw)) return false;
  const s = raw.toLowerCase().trim();
  if (!s) return false;
  if (KNOWN_COMMERCIAL_BANKS.some((b) => s.includes(b))) {
    return false;
  }
  return (
    s === "cash" ||
    s === "tunai" ||
    s.includes("tunai") ||
    s.includes("cash") ||
    s.includes("kas fisik") ||
    s.includes("kas messenger") ||
    s.includes("kas kantor")
  );
}

export function isCashPaymentMethodRow(pm: CanonicalPaymentMethodRecord): boolean {
  const combined = `${pm.nama_metode || ""} ${pm.bank || ""}`.trim();
  return isCashPaymentString(combined) && !isPaymentSchemeString(combined);
}

export function getPaymentMethodBaseLabel(pm: CanonicalPaymentMethodRecord): string {
  const nama = String(pm.nama_metode || "").trim();
  const bank = String(pm.bank || "").trim();

  if (isCashPaymentMethodRow(pm)) {
    if (nama && nama.toLowerCase() !== "cash") return nama;
    return "Tunai";
  }

  const lowerNama = nama.toLowerCase();
  const lowerBank = bank.toLowerCase();

  if (lowerNama === "transfer bank" || lowerNama === "transfer" || !nama) {
    return bank ? `Transfer ${bank}` : nama || "Transfer Bank";
  }

  if (bank && !lowerNama.includes(lowerBank)) {
    return `${nama} - ${bank}`;
  }

  return nama || `Transfer ${bank}` || pm.id;
}

export interface FormattedPaymentMethodLabels {
  displayLabel: string;
  dropdownLabel: string;
  baseLabel: string;
}

/**
 * Builds deterministic canonical labels for all DB payment methods.
 * Disambiguates duplicate bank/account labels using nomor_rekening or nama_rekening,
 * and marks inactive methods with `(Nonaktif)`.
 */
export function buildPaymentMethodLabelMap(
  methods: CanonicalPaymentMethodRecord[]
): Map<string, FormattedPaymentMethodLabels> {
  const baseById = new Map<string, string>();
  const countByBase = new Map<string, number>();

  for (const pm of methods) {
    const base = getPaymentMethodBaseLabel(pm);
    baseById.set(pm.id, base);
    const key = base.toLowerCase();
    countByBase.set(key, (countByBase.get(key) || 0) + 1);
  }

  const result = new Map<string, FormattedPaymentMethodLabels>();
  for (const pm of methods) {
    const baseLabel = baseById.get(pm.id) || pm.id;
    const isDuplicateBase = (countByBase.get(baseLabel.toLowerCase()) || 0) > 1;
    const acct = String(pm.nomor_rekening || "").trim();
    const owner = String(pm.nama_rekening || "").trim();

    let displayLabel = baseLabel;
    if (isDuplicateBase) {
      if (acct) {
        displayLabel = `${baseLabel} (${acct})`;
      } else if (owner) {
        displayLabel = `${baseLabel} (${owner})`;
      } else {
        displayLabel = `${baseLabel} [${pm.id}]`;
      }
    }

    const isInactive = String(pm.status || "").trim().toLowerCase() !== "aktif";
    const dropdownLabel = isInactive ? `${displayLabel} (Nonaktif)` : displayLabel;

    result.set(pm.id, {
      baseLabel,
      displayLabel: dropdownLabel,
      dropdownLabel,
    });
  }

  return result;
}

export function formatSinglePaymentMethodLabel(
  pm: CanonicalPaymentMethodRecord,
  allMethods: CanonicalPaymentMethodRecord[]
): string {
  const map = buildPaymentMethodLabelMap(allMethods);
  return map.get(pm.id)?.displayLabel || getPaymentMethodBaseLabel(pm);
}

function normalizeAccountNumber(raw?: string | null): string {
  return String(raw || "")
    .replace(/[\s\-_.]/g, "")
    .trim()
    .toLowerCase();
}

function parseSnapshotObject(snap: unknown): Record<string, any> | null {
  if (!snap) return null;
  if (typeof snap === "object") return snap as Record<string, any>;
  if (typeof snap === "string" && snap.trim()) {
    try {
      const parsed = JSON.parse(snap);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Deterministically resolves a DB payment_methods record ONLY when unambiguous.
 * Never defaults NULL/empty/unknown strings to Tunai and never collides duplicate "Transfer Bank" names.
 */
export function resolveCanonicalPaymentMethod(
  raw: {
    id?: string | null;
    snapshot?: unknown;
    metode?: string | null;
    namaBank?: string | null;
    nomorRekening?: string | null;
  },
  methods: CanonicalPaymentMethodRecord[]
): CanonicalPaymentMethodRecord | null {
  if (!methods.length) return null;

  const pmById = new Map<string, CanonicalPaymentMethodRecord>();
  for (const pm of methods) {
    if (pm.id) pmById.set(String(pm.id).trim(), pm);
  }

  // 1. Canonical paymentMethodId lookup
  if (raw.id) {
    const exact = pmById.get(String(raw.id).trim());
    if (exact) return exact;
  }

  // 2. Snapshot ID lookup
  const snapObj = parseSnapshotObject(raw.snapshot);
  if (snapObj?.id) {
    const fromSnapId = pmById.get(String(snapObj.id).trim());
    if (fromSnapId) return fromSnapId;
  }

  const rawMetode = String(raw.metode || snapObj?.nama_metode || "").trim();
  const rawBank = String(raw.namaBank || snapObj?.bank || "").trim();
  const rawAcct = String(raw.nomorRekening || snapObj?.nomor_rekening || "").trim();

  const metodeClean = isPaymentSchemeString(rawMetode) ? "" : rawMetode;
  const bankClean = isPaymentSchemeString(rawBank) ? "" : rawBank;

  // 3. Account number match (strict & non-colliding)
  const normAcct = normalizeAccountNumber(rawAcct);
  if (normAcct.length >= 4) {
    const acctMatches = methods.filter(
      (pm) => normalizeAccountNumber(pm.nomor_rekening) === normAcct
    );
    if (acctMatches.length === 1) return acctMatches[0];
    if (acctMatches.length > 1 && bankClean) {
      const narrowed = acctMatches.filter(
        (pm) => String(pm.bank || "").trim().toLowerCase() === bankClean.toLowerCase()
      );
      if (narrowed.length === 1) return narrowed[0];
    }
  }

  // 4. Explicit Cash / Tunai match
  const cashSignal = bankClean || metodeClean;
  if (isCashPaymentString(cashSignal)) {
    const cashRows = methods.filter(isCashPaymentMethodRow);
    if (cashRows.length === 1) return cashRows[0];
    const canonicalCash = cashRows.find((c) => c.id === "pm-cash");
    if (canonicalCash) return canonicalCash;
  }

  // 5. Exact Bank match (must be unique if no account number disambiguates)
  if (bankClean) {
    const lowerBank = bankClean.toLowerCase();
    const bankMatches = methods.filter(
      (pm) => !isCashPaymentMethodRow(pm) && String(pm.bank || "").trim().toLowerCase() === lowerBank
    );
    if (bankMatches.length === 1) return bankMatches[0];
  }

  // 6. Non-generic legacy metode suffix match (e.g., "Transfer Bank BCA" -> "BCA")
  if (metodeClean) {
    const lowerMetode = metodeClean.toLowerCase();
    if (lowerMetode !== "transfer" && lowerMetode !== "transfer bank" && lowerMetode !== "bank") {
      const stripped = lowerMetode.replace(/^(transfer\s+bank|transfer|bank)\s*/i, "").trim();
      const nonCash = methods.filter((pm) => !isCashPaymentMethodRow(pm));

      if (stripped) {
        const suffixMatches = nonCash.filter((pm) => {
          const pmBank = String(pm.bank || "").trim().toLowerCase();
          return pmBank.length >= 2 && (pmBank === stripped || pmBank === lowerMetode);
        });
        if (suffixMatches.length === 1) return suffixMatches[0];
      }

      const tokenMatches = nonCash.filter((pm) => {
        const pmBank = String(pm.bank || "").trim().toLowerCase();
        return pmBank.length >= 2 && lowerMetode.includes(pmBank);
      });
      if (tokenMatches.length === 1) return tokenMatches[0];
    }
  }

  return null;
}

export function formatUnlinkedPaymentMethodLabel(raw?: {
  metode?: string | null;
  namaBank?: string | null;
}): string {
  const bank = raw?.namaBank && !isPaymentSchemeString(raw.namaBank) ? raw.namaBank.trim() : "";
  const metode = raw?.metode && !isPaymentSchemeString(raw.metode) ? raw.metode.trim() : "";

  if (isCashPaymentString(bank || metode)) {
    return "Tunai (Non-Master)";
  }
  if (bank) {
    return bank.toLowerCase().startsWith("transfer") ? bank : `Transfer ${bank}`;
  }
  if (metode) {
    return metode;
  }
  return "Belum Terhubung";
}

export function toWibDateYmd(dateStr?: string | null): string {
  if (!dateStr) return "";
  const s = String(dateStr).trim();
  if (!s || s === "-" || s === "—") return "";

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split("/");
    return `${y}-${m}-${d}`;
  }

  // Full ISO timestamp with timezone/Z -> shift into Asia/Jakarta (+07:00)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      const wibMs = parsed.getTime() + 7 * 60 * 60 * 1000;
      return new Date(wibMs).toISOString().slice(0, 10);
    }
  }

  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

export function matchesWibDateRange(
  dateStr?: string | null,
  startDate?: string,
  endDate?: string
): boolean {
  if (!startDate && !endDate) return true;
  const target = toWibDateYmd(dateStr);
  if (!target) return false;
  if (startDate && target < startDate) return false;
  if (endDate && target > endDate) return false;
  return true;
}

export function normalizeProfitCategoryKey(pengRaw?: string | null): string {
  const raw = String(pengRaw || "").toLowerCase();
  if (raw.includes("5 tahun")) return "perpanjangan-5-tahun";
  if (raw.includes("balik nama") || raw.includes("bbn")) return "balik-nama";
  if (raw.includes("mutasi ld") || raw.includes("mutasi antar")) return "mutasi-antar-daerah";
  if (raw.includes("mutasi as") || raw.includes("mutasi asal")) return "mutasi-asal";
  if (raw.includes("tarik")) return "tarik-berkas";
  if (raw.includes("duplikat")) return "duplikat-stnk";
  if (raw.includes("1 tahun") || raw.includes("tahunan")) return "perpanjangan-1-tahun";
  return "lainnya";
}
