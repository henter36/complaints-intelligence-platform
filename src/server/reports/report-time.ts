export const RIYADH_TIME_ZONE = "Asia/Riyadh";

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function formatPartsMap(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    map[part.type] = part.value;
  }
  return map;
}

/** Timezone offset in minutes (local wall-clock time minus UTC) for the zone
 * at the given instant — positive for zones ahead of UTC (e.g. +180 for
 * Asia/Riyadh). Computed live, never hardcoded, so it stays correct for
 * zones that observe DST. */
export function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = formatPartsMap(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60_000;
}

/** Wall-clock date/time parts (and weekday, 0=Sunday..6=Saturday) for an instant in the given IANA timezone. */
export function getZonedDateParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatPartsMap(date, timeZone);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Converts a wall-clock date/time in the given IANA timezone to the correct
 * UTC instant. Takes a single pass: computes the offset at a first guess and
 * applies it once, which is exact for Asia/Riyadh (this module's only
 * consumer — a fixed +03:00 offset with no DST) but can be off by the DST
 * delta for a wall-clock time that falls within a DST transition in a zone
 * that observes it. Re-verify this function before reusing it for another
 * timezone. */
export function zonedWallTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string
): Date {
  const guess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0)
  );
  const offsetMinutes = getTimeZoneOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offsetMinutes * 60_000);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function formatRiyadhDateTime(date: Date): string {
  const formatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", {
    timeZone: RIYADH_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${formatter.format(date)} (بتوقيت الرياض)`;
}
