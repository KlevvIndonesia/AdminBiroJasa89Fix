/**
 * Canonical Asia/Jakarta (WIB, UTC+7) Date Parsing & Period Filtering Utility
 * Admin SUN89 — Financial Systems Date Integrity (Batch 4)
 *
 * Design Invariants:
 * 1. Anchored deterministically to Asia/Jakarta (UTC+07:00, no DST) — never relies on host OS timezone.
 * 2. Supports:
 *    - ISO 8601 timestamps (with 'Z' or explicit '+HH:MM'/'-HH:MM' offset)
 *    - SQLite datetimes ('YYYY-MM-DD HH:mm:ss[.sss]', treated as UTC per schema default datetime('now'))
 *    - Pure calendar dates ('YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY')
 *    - Indonesian text dates ('21 Oktober 2026', '21 Okt 2026', optional weekday prefix)
 *    - Native JS Date objects
 * 3. Validates strict calendar integrity (rejects Feb 29 on non-leap years, Feb 30/31, Month 13, etc.).
 * 4. Fails closed (returns null) for null, empty, '-', '—', 'N/A', or malformed values.
 * 5. Half-open period intervals [startMs, endMs) prevent boundary overlap and midnight UTC/WIB drift.
 */

export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const INDONESIAN_MONTH_MAP: Record<string, number> = {
  januari: 1,
  jan: 1,
  februari: 2,
  feb: 2,
  pebruari: 2,
  maret: 3,
  mar: 3,
  april: 4,
  apr: 4,
  mei: 5,
  may: 5,
  juni: 6,
  jun: 6,
  juli: 7,
  jul: 7,
  agustus: 8,
  agu: 8,
  agust: 8,
  agt: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  oktober: 10,
  okt: 10,
  oct: 10,
  november: 11,
  nov: 11,
  nopember: 11,
  nop: 11,
  desember: 12,
  des: 12,
  dec: 12,
};

export interface WibDateParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  ymd: string; // YYYY-MM-DD
  dayOfWeek: number; // 0 (Sunday) .. 6 (Saturday) in WIB
  epochMs: number;
  date: Date;
}

export interface PeriodBoundsWib {
  normalizedPeriod: "all" | "daily" | "weekly" | "monthly" | "yearly" | "custom" | "invalid";
  isUnbounded: boolean;
  isValid: boolean;
  startMs: number | null;
  endMs: number | null; // Exclusive upper bound
  startYmd: string | null;
  endYmd: string | null; // Inclusive WIB end calendar date
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function buildWibDayEpochMs(year: number, month: number, day: number, hour = 0, min = 0, sec = 0, ms = 0): number {
  return Date.UTC(year, month - 1, day, hour, min, sec, ms) - WIB_OFFSET_MS;
}

export function getWibPartsFromEpochMs(epochMs: number): WibDateParts | null {
  if (!Number.isFinite(epochMs)) return null;
  const shifted = new Date(epochMs + WIB_OFFSET_MS);
  if (isNaN(shifted.getTime())) return null;
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const ymd = `${year}-${pad2(month)}-${pad2(day)}`;
  return {
    year,
    month,
    day,
    ymd,
    dayOfWeek: shifted.getUTCDay(),
    epochMs,
    date: new Date(epochMs),
  };
}

/**
 * Parses supported date/timestamp formats strictly into deterministic Asia/Jakarta date parts.
 */
export function parseWibDateInfo(val: unknown): WibDateParts | null {
  if (val === null || val === undefined) return null;

  if (val instanceof Date) {
    const ms = val.getTime();
    if (isNaN(ms)) return null;
    return getWibPartsFromEpochMs(ms);
  }

  if (typeof val !== "string") return null;

  const trimmed = val.trim();
  if (!trimmed || trimmed === "-" || trimmed === "—" || /^(null|undefined|nan|invalid date|n\/a|0000-00-00)$/i.test(trimmed)) {
    return null;
  }

  // 1. ISO 8601 timestamp with time (e.g. 2026-11-15T18:00:00Z, 2026-11-15T23:30:00+07:00, 2026-11-15T10:00:00)
  const isoTsMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i
  );
  if (isoTsMatch) {
    const year = parseInt(isoTsMatch[1], 10);
    const month = parseInt(isoTsMatch[2], 10);
    const day = parseInt(isoTsMatch[3], 10);
    const hour = parseInt(isoTsMatch[4], 10);
    const min = parseInt(isoTsMatch[5], 10);
    const sec = isoTsMatch[6] ? parseInt(isoTsMatch[6], 10) : 0;
    const ms = isoTsMatch[7] ? parseInt(isoTsMatch[7].padEnd(3, "0").slice(0, 3), 10) : 0;
    const tz = isoTsMatch[8];

    if (!isValidCalendarDate(year, month, day)) return null;
    if (hour > 23 || min > 59 || sec > 59) return null;

    if (tz) {
      const normalizedIso = `${isoTsMatch[1]}-${isoTsMatch[2]}-${isoTsMatch[3]}T${pad2(hour)}:${pad2(min)}:${pad2(sec)}.${String(ms).padStart(3, "0")}${tz}`;
      const parsedMs = Date.parse(normalizedIso);
      if (isNaN(parsedMs)) return null;
      return getWibPartsFromEpochMs(parsedMs);
    }

    // Naive ISO datetime without zone suffix -> treat in WIB business timezone
    return getWibPartsFromEpochMs(buildWibDayEpochMs(year, month, day, hour, min, sec, ms));
  }

  // 2. SQLite timestamp: YYYY-MM-DD HH:MM:SS[.mmm] (treated strictly as UTC per datetime('now'))
  const sqliteMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (sqliteMatch) {
    const year = parseInt(sqliteMatch[1], 10);
    const month = parseInt(sqliteMatch[2], 10);
    const day = parseInt(sqliteMatch[3], 10);
    const hour = parseInt(sqliteMatch[4], 10);
    const min = parseInt(sqliteMatch[5], 10);
    const sec = sqliteMatch[6] ? parseInt(sqliteMatch[6], 10) : 0;
    const ms = sqliteMatch[7] ? parseInt(sqliteMatch[7].padEnd(3, "0").slice(0, 3), 10) : 0;

    if (!isValidCalendarDate(year, month, day)) return null;
    if (hour > 23 || min > 59 || sec > 59) return null;

    const utcMs = Date.UTC(year, month - 1, day, hour, min, sec, ms);
    return getWibPartsFromEpochMs(utcMs);
  }

  // 3. Pure calendar date YYYY-MM-DD
  const ymdMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);
    if (!isValidCalendarDate(year, month, day)) return null;
    return getWibPartsFromEpochMs(buildWibDayEpochMs(year, month, day));
  }

  // 4. Indonesian numeric calendar date: DD/MM/YYYY or DD-MM-YYYY (optional HH:mm[:ss])
  const dmyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    const year = parseInt(dmyMatch[3], 10);
    const hour = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 0;
    const min = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
    const sec = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;
    if (!isValidCalendarDate(year, month, day)) return null;
    if (hour > 23 || min > 59 || sec > 59) return null;
    return getWibPartsFromEpochMs(buildWibDayEpochMs(year, month, day, hour, min, sec));
  }

  // 5. Indonesian text date: "21 Oktober 2026", "21 Okt 2026", or "Senin, 21 Oktober 2026"
  const indoTextMatch = trimmed.match(/^(?:[a-zA-Z]+,\s*)?(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (indoTextMatch) {
    const day = parseInt(indoTextMatch[1], 10);
    const monthName = indoTextMatch[2].toLowerCase();
    const year = parseInt(indoTextMatch[3], 10);
    const month = INDONESIAN_MONTH_MAP[monthName];
    if (!month || !isValidCalendarDate(year, month, day)) return null;
    const hour = indoTextMatch[4] ? parseInt(indoTextMatch[4], 10) : 0;
    const min = indoTextMatch[5] ? parseInt(indoTextMatch[5], 10) : 0;
    const sec = indoTextMatch[6] ? parseInt(indoTextMatch[6], 10) : 0;
    if (hour > 23 || min > 59 || sec > 59) return null;
    return getWibPartsFromEpochMs(buildWibDayEpochMs(year, month, day, hour, min, sec));
  }

  return null;
}

/**
 * Canonical Date parser anchored in Asia/Jakarta (WIB).
 * Returns a Date representing the exact instant (or 00:00:00 WIB for calendar-only strings),
 * or null if invalid/empty.
 */
export function parseDateFlexibleWib(val?: string | Date | null): Date | null {
  const info = parseWibDateInfo(val);
  return info ? info.date : null;
}

export function formatWibYmd(val?: string | Date | null): string | null {
  const info = parseWibDateInfo(val);
  return info ? info.ymd : null;
}

/**
 * Computes half-open [startMs, endMs) boundaries in Asia/Jakarta for any supported period filter.
 */
export function getPeriodBoundsWib(
  period: string,
  referenceDate: Date = new Date(),
  customStart?: string,
  customEnd?: string
): PeriodBoundsWib {
  const rawPeriod = String(period || "").trim().toLowerCase();

  if (!rawPeriod || rawPeriod === "all" || rawPeriod === "semua" || rawPeriod === "semua data") {
    return {
      normalizedPeriod: "all",
      isUnbounded: true,
      isValid: true,
      startMs: null,
      endMs: null,
      startYmd: null,
      endYmd: null,
    };
  }

  const refInfo = parseWibDateInfo(referenceDate) || parseWibDateInfo(new Date())!;
  const { year, month, day, dayOfWeek } = refInfo;

  if (rawPeriod === "daily" || rawPeriod === "harian") {
    const startMs = buildWibDayEpochMs(year, month, day);
    const endMs = startMs + DAY_MS;
    return {
      normalizedPeriod: "daily",
      isUnbounded: false,
      isValid: true,
      startMs,
      endMs,
      startYmd: refInfo.ymd,
      endYmd: refInfo.ymd,
    };
  }

  if (rawPeriod === "weekly" || rawPeriod === "mingguan") {
    // ISO Week (Monday 00:00 WIB .. next Monday 00:00 WIB)
    const diffFromMonday = (dayOfWeek + 6) % 7;
    const todayStartMs = buildWibDayEpochMs(year, month, day);
    const startMs = todayStartMs - diffFromMonday * DAY_MS;
    const endMs = startMs + 7 * DAY_MS;
    const startParts = getWibPartsFromEpochMs(startMs)!;
    const endParts = getWibPartsFromEpochMs(endMs - 1)!;
    return {
      normalizedPeriod: "weekly",
      isUnbounded: false,
      isValid: true,
      startMs,
      endMs,
      startYmd: startParts.ymd,
      endYmd: endParts.ymd,
    };
  }

  if (rawPeriod === "monthly" || rawPeriod === "bulanan") {
    const startMs = buildWibDayEpochMs(year, month, 1);
    const nextMonthYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const endMs = buildWibDayEpochMs(nextMonthYear, nextMonth, 1);
    const startParts = getWibPartsFromEpochMs(startMs)!;
    const endParts = getWibPartsFromEpochMs(endMs - 1)!;
    return {
      normalizedPeriod: "monthly",
      isUnbounded: false,
      isValid: true,
      startMs,
      endMs,
      startYmd: startParts.ymd,
      endYmd: endParts.ymd,
    };
  }

  if (rawPeriod === "yearly" || rawPeriod === "tahunan") {
    const startMs = buildWibDayEpochMs(year, 1, 1);
    const endMs = buildWibDayEpochMs(year + 1, 1, 1);
    return {
      normalizedPeriod: "yearly",
      isUnbounded: false,
      isValid: true,
      startMs,
      endMs,
      startYmd: `${year}-01-01`,
      endYmd: `${year}-12-31`,
    };
  }

  if (rawPeriod === "custom" || rawPeriod === "kustom") {
    const hasStart = Boolean(customStart && String(customStart).trim() !== "");
    const hasEnd = Boolean(customEnd && String(customEnd).trim() !== "");
    const startInfo = hasStart ? parseWibDateInfo(customStart) : null;
    const endInfo = hasEnd ? parseWibDateInfo(customEnd) : null;

    if ((hasStart && !startInfo) || (hasEnd && !endInfo)) {
      return {
        normalizedPeriod: "custom",
        isUnbounded: false,
        isValid: false,
        startMs: null,
        endMs: null,
        startYmd: null,
        endYmd: null,
      };
    }

    const startMs = startInfo ? buildWibDayEpochMs(startInfo.year, startInfo.month, startInfo.day) : null;
    const endMs = endInfo ? buildWibDayEpochMs(endInfo.year, endInfo.month, endInfo.day) + DAY_MS : null;

    if (startMs !== null && endMs !== null && startMs >= endMs) {
      return {
        normalizedPeriod: "custom",
        isUnbounded: false,
        isValid: false,
        startMs,
        endMs,
        startYmd: startInfo?.ymd || null,
        endYmd: endInfo?.ymd || null,
      };
    }

    return {
      normalizedPeriod: "custom",
      isUnbounded: false,
      isValid: true,
      startMs,
      endMs,
      startYmd: startInfo?.ymd || null,
      endYmd: endInfo?.ymd || null,
    };
  }

  // Fail closed on unrecognized period string
  return {
    normalizedPeriod: "invalid",
    isUnbounded: false,
    isValid: false,
    startMs: null,
    endMs: null,
    startYmd: null,
    endYmd: null,
  };
}

/**
 * Evaluates whether a parsed Date falls strictly inside the Asia/Jakarta period bounds.
 * Null/invalid dates are STRICTLY rejected from any bounded period.
 */
export function matchesPeriodWib(
  d: Date | null,
  period: string,
  referenceDate: Date = new Date(),
  customStart?: string,
  customEnd?: string
): boolean {
  const bounds = getPeriodBoundsWib(period, referenceDate, customStart, customEnd);
  if (!bounds.isValid) return false;
  if (bounds.isUnbounded) return true;
  if (!d || isNaN(d.getTime())) return false;

  const ms = d.getTime();
  if (bounds.startMs !== null && ms < bounds.startMs) return false;
  if (bounds.endMs !== null && ms >= bounds.endMs) return false;
  return true;
}

/**
 * Evaluates whether a parsed Date occurs strictly BEFORE the active period start (for opening balances).
 */
export function isBeforePeriodStartWib(
  d: Date | null,
  period: string,
  referenceDate: Date = new Date(),
  customStart?: string,
  customEnd?: string
): boolean {
  const bounds = getPeriodBoundsWib(period, referenceDate, customStart, customEnd);
  if (!bounds.isValid || bounds.isUnbounded || bounds.startMs === null) return false;
  if (!d || isNaN(d.getTime())) return false;
  return d.getTime() < bounds.startMs;
}
