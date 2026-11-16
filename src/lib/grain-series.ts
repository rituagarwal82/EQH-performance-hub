import type { Grain } from "./view-prefs";

/**
 * One bucketing function for every grain on every surface.
 *
 * Day, Week and Month all aggregate the SAME daily fact rows — there is no
 * second query and therefore no second answer. A bucket that is short of the
 * days it expects keeps that fact (`daysCovered` / `daysExpected`) so the
 * renderer can hatch it and label it "4 of 7 days" instead of drawing it solid
 * or, worse, dropping it.
 */

export type DailyFact = { date: string; [key: string]: number | string | null };

export type Bucket<T> = {
  key: string;
  label: string;
  start: string;
  end: string;
  daysCovered: number;
  daysExpected: number;
  complete: boolean;
  rows: T[];
};

const MS = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function startOfWeek(d: Date) {
  const day = d.getUTCDay(); // 0 = Sunday
  const back = (day + 6) % 7; // weeks start Monday
  return new Date(d.getTime() - back * MS);
}

function bucketOf(dateStr: string, grain: Grain) {
  const d = parse(dateStr);
  if (grain === "day") return { start: d, end: d };
  if (grain === "week") {
    const s = startOfWeek(d);
    return { start: s, end: new Date(s.getTime() + 6 * MS) };
  }
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start: s, end: e };
}

function labelOf(start: Date, grain: Grain) {
  if (grain === "month") return `${MONTH_SHORT[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  if (grain === "week") return `w/c ${start.getUTCDate()} ${MONTH_SHORT[start.getUTCMonth()]}`;
  return `${start.getUTCDate()} ${MONTH_SHORT[start.getUTCMonth()]}`;
}

/**
 * @param window the range actually being reported. A bucket is only "complete"
 *   when every day it spans that also falls inside this window was collected.
 */
export function bucketise<T extends { date: string }>(
  rows: T[],
  grain: Grain,
  window: { since: string; until: string },
): Bucket<T>[] {
  const map = new Map<string, Bucket<T>>();
  const winStart = parse(window.since).getTime();
  const winEnd = parse(window.until).getTime();

  for (const row of rows) {
    if (!row.date) continue;
    const { start, end } = bucketOf(row.date, grain);
    const key = iso(start);
    let b = map.get(key);
    if (!b) {
      // Days the bucket is entitled to, clipped to the reported window.
      const from = Math.max(start.getTime(), winStart);
      const to = Math.min(end.getTime(), winEnd);
      const expected = Math.max(1, Math.round((to - from) / MS) + 1);
      b = {
        key,
        label: labelOf(start, grain),
        start: iso(start),
        end: iso(end),
        daysCovered: 0,
        daysExpected: expected,
        complete: true,
        rows: [],
      };
      map.set(key, b);
    }
    b.rows.push(row);
    b.daysCovered += 1;
  }

  const out = Array.from(map.values()).sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const b of out) b.complete = b.daysCovered >= b.daysExpected;
  return out;
}

/** "4 of 7 days" — the direct label an incomplete bucket carries. */
export function coverageLabel(b: Bucket<unknown>): string | null {
  return b.complete ? null : `${b.daysCovered} of ${b.daysExpected} days`;
}
