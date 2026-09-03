/**
 * Calendar-day helpers for history and playback.
 *
 * <h3>Why this exists</h3>
 * A history range is chosen as a CALENDAR DAY in the operator's own timezone,
 * but the API takes instants. Converting one to the other by appending a `Z` —
 * `${date}T00:00:00.000Z` — is the bug this module exists to prevent: it reads a
 * local date as if it were UTC, so in IST (+5:30) "today" becomes 05:30 today
 * through 05:29 tomorrow. Everything the vehicle did between midnight and dawn
 * lands in the previous day's window and the screen reports no history for a day
 * that plainly has some.
 *
 * The offset is zero in UTC, which is why this survives testing in one timezone
 * and fails in the field in another.
 *
 * <h3>And why it is shared</h3>
 * Playback and the History tab both resolve "Today", "Yesterday" and "7 Days".
 * When each screen had its own copy of this arithmetic they could disagree about
 * which instants a day covers, so the same vehicle and the same preset returned
 * different trips depending on which screen asked.
 */

/** Today as `YYYY-MM-DD` in local time. */
export function todayStr(): string {
  return toDateStr(new Date());
}

/** `YYYY-MM-DD` for a Date, in local time. */
export function toDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * `YYYY-MM-DD` to a local Date at midnight.
 *
 * Built from the parts rather than parsed from the string: `new Date('2026-09-01')`
 * is defined to be UTC midnight, which is the same off-by-a-timezone error in a
 * different disguise.
 */
export function parseDateStr(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map((part) => parseInt(part, 10));
  return new Date(year, (month || 1) - 1, day || 1);
}

/** Shift a `YYYY-MM-DD` string by whole days, staying on local calendar days. */
export function shiftDate(dateStr: string, delta: number): string {
  const date = parseDateStr(dateStr);
  date.setDate(date.getDate() + delta);
  return toDateStr(date);
}

/** Whole days from `fromStr` to `toStr`, never negative. */
export function daysBetween(fromStr: string, toStr: string): number {
  const from = parseDateStr(fromStr).getTime();
  const to = parseDateStr(toStr).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** The instant a local calendar day begins, as an ISO string. */
export function startOfLocalDayIso(dateStr: string): string {
  const date = parseDateStr(dateStr);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

/** The instant a local calendar day ends, as an ISO string. */
export function endOfLocalDayIso(dateStr: string): string {
  const date = parseDateStr(dateStr);
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

/**
 * The inclusive instant range covering `from`..`to` as local calendar days.
 *
 * The single call every history request should make, so a screen cannot get the
 * start right and the end wrong.
 */
export function localDayRangeIso(fromStr: string, toStr: string): { from: string; to: string } {
  // Tolerates a reversed range rather than asking the API for a window that
  // ends before it starts, which the backend rejects outright.
  const ordered = fromStr <= toStr ? [fromStr, toStr] : [toStr, fromStr];
  return { from: startOfLocalDayIso(ordered[0]), to: endOfLocalDayIso(ordered[1]) };
}
