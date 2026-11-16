/**
 * Calendar Date Normalization & Stage 4 Scheduling Validation
 * Admin SUN89 — Order Tracking
 *
 * Semantics aligned with server/src/utils/dateNormalizer.ts:
 * 1. Pure calendar date strings (YYYY-MM-DD / YYYY/MM/DD) and local day strings
 *    (DD/MM/YYYY / DD-MM-YYYY / Indonesian & English month names) preserve the exact
 *    calendar day without timezone shifting.
 * 2. ISO 8601 instants (with Z or explicit UTC offset) and SQLite UTC timestamps
 *    (YYYY-MM-DD HH:MM:SS[.mmm]) are formatted strictly in Asia/Jakarta (WIB, UTC+7).
 * 3. Rejects non-existent calendar dates (e.g., 2026-02-30, 2026-13-01) and
 *    placeholder strings ("-", "--", "N/A") by failing closed (returning null).
 */

const WIB_TIMEZONE = "Asia/Jakarta";

const WIB_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: WIB_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1,
  januari: 1,
  january: 1,
  feb: 2,
  februari: 2,
  february: 2,
  mar: 3,
  maret: 3,
  march: 3,
  apr: 4,
  april: 4,
  mei: 5,
  may: 5,
  jun: 6,
  juni: 6,
  june: 6,
  jul: 7,
  juli: 7,
  july: 7,
  agu: 8,
  agt: 8,
  agustus: 8,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  des: 12,
  desember: 12,
  dec: 12,
  december: 12,
};

/**
 * Checks whether (year, month, day) is a real calendar date (month 1-12).
 */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function formatCalendarParts(year: number, month: number, day: number): string | null {
  if (!isValidCalendarDate(year, month, day)) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Returns today's calendar date in Asia/Jakarta (YYYY-MM-DD).
 */
export function getWibTodayString(now: Date = new Date()): string {
  return WIB_DATE_FORMATTER.format(now);
}

/**
 * Normalizes supported date inputs into a canonical YYYY-MM-DD calendar date.
 * Returns null if input is empty, invalid, or cannot be parsed unambiguously.
 */
export function normalizeOrderCalendarDate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return WIB_DATE_FORMATTER.format(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "--" || trimmed.toLowerCase() === "n/a") {
    return null;
  }

  // 1. Pure YYYY-MM-DD or YYYY/MM/DD
  const ymdMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    return formatCalendarParts(
      parseInt(ymdMatch[1], 10),
      parseInt(ymdMatch[2], 10),
      parseInt(ymdMatch[3], 10)
    );
  }

  // 2. Local DD/MM/YYYY or DD-MM-YYYY (with optional HH:mm[:ss])
  const dmyMatch = trimmed.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    const year = parseInt(dmyMatch[3], 10);
    return formatCalendarParts(year, month, day);
  }

  // 3. SQLite UTC timestamp: YYYY-MM-DD HH:MM:SS[.mmm]
  const sqliteMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/
  );
  if (sqliteMatch) {
    const year = parseInt(sqliteMatch[1], 10);
    const month = parseInt(sqliteMatch[2], 10);
    const day = parseInt(sqliteMatch[3], 10);
    if (!isValidCalendarDate(year, month, day)) {
      return null;
    }
    const ms = sqliteMatch[7] ? sqliteMatch[7].padEnd(3, "0").slice(0, 3) : "000";
    const parsed = new Date(`${sqliteMatch[1]}-${sqliteMatch[2]}-${sqliteMatch[3]}T${sqliteMatch[4]}:${sqliteMatch[5]}:${sqliteMatch[6]}.${ms}Z`);
    return isNaN(parsed.getTime()) ? null : WIB_DATE_FORMATTER.format(parsed);
  }

  // 4. ISO 8601 with timezone (Z or +/-HH:MM) vs local naive ISO without offset
  const isoMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i
  );
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (!isValidCalendarDate(year, month, day)) {
      return null;
    }
    if (!isoMatch[7]) {
      return formatCalendarParts(year, month, day);
    }
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : WIB_DATE_FORMATTER.format(parsed);
  }

  // 5. Named month formats: "13 Nov 2026" / "13 November 2026" or "Nov 13, 2026"
  const dMonthY = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dMonthY) {
    const monthNum = MONTH_NAME_MAP[dMonthY[2].toLowerCase()];
    if (monthNum) {
      return formatCalendarParts(parseInt(dMonthY[3], 10), monthNum, parseInt(dMonthY[1], 10));
    }
  }

  const monthDY = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthDY) {
    const monthNum = MONTH_NAME_MAP[monthDY[1].toLowerCase()];
    if (monthNum) {
      return formatCalendarParts(parseInt(monthDY[3], 10), monthNum, parseInt(monthDY[2], 10));
    }
  }

  return null;
}

export type SamsatScheduleValidationResult =
  | {
      valid: true;
      normalizedProsesDate: string;
      normalizedMasukDate: string | null;
    }
  | {
      valid: false;
      message: string;
      field?: "tanggalProsesSamsat";
    };

/**
 * Validates Stage 4 "Tanggal Mulai Proses Samsat" against today (WIB) and optional "tanggalMasukBerkas".
 * Does not fabricate missing dates; fails explicitly with descriptive reason if a non-empty source date is malformed.
 */
export function validateSamsatScheduleDates(input: {
  tanggalProsesSamsat?: string | null;
  tanggalMasukBerkas?: string | null;
  today?: string;
}): SamsatScheduleValidationResult {
  const rawProses = typeof input.tanggalProsesSamsat === "string" ? input.tanggalProsesSamsat.trim() : "";
  if (!rawProses) {
    return {
      valid: false,
      message: "Harap tentukan tanggal mulai proses Samsat!",
      field: "tanggalProsesSamsat",
    };
  }

  const normalizedProsesDate = normalizeOrderCalendarDate(rawProses);
  if (!normalizedProsesDate) {
    return {
      valid: false,
      message: `Format tanggal mulai proses Samsat tidak valid ("${rawProses}"). Gunakan format tanggal yang benar.`,
      field: "tanggalProsesSamsat",
    };
  }

  const todayStr = normalizeOrderCalendarDate(input.today) || getWibTodayString();
  if (normalizedProsesDate < todayStr) {
    return {
      valid: false,
      message: "Tanggal mulai proses Samsat tidak boleh sebelum hari ini.",
      field: "tanggalProsesSamsat",
    };
  }

  const rawMasuk =
    typeof input.tanggalMasukBerkas === "string"
      ? input.tanggalMasukBerkas.trim()
      : input.tanggalMasukBerkas !== null && input.tanggalMasukBerkas !== undefined
        ? String(input.tanggalMasukBerkas).trim()
        : "";

  if (!rawMasuk) {
    return {
      valid: true,
      normalizedProsesDate,
      normalizedMasukDate: null,
    };
  }

  const normalizedMasukDate = normalizeOrderCalendarDate(rawMasuk);
  if (!normalizedMasukDate) {
    return {
      valid: false,
      message: `Format tanggal berkas diterima tidak valid pada order ini ("${rawMasuk}"). Mohon perbaiki data tanggal masuk berkas terlebih dahulu.`,
    };
  }

  if (normalizedProsesDate < normalizedMasukDate) {
    return {
      valid: false,
      message: `Tanggal mulai proses Samsat tidak boleh sebelum tanggal berkas diterima (${normalizedMasukDate}).`,
      field: "tanggalProsesSamsat",
    };
  }

  return {
    valid: true,
    normalizedProsesDate,
    normalizedMasukDate,
  };
}
