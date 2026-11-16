/**
 * One representation for every number on every screen.
 *
 * The whole point is that "we measured zero" and "we have no measurement" are
 * different facts and must stay different all the way to the pixel. A bare
 * `number` cannot carry that distinction, so no screen is allowed to format a
 * raw number — everything goes through `Metric` and <MetricValue />.
 *
 * Five states, weakest to strongest:
 *   unmeasured — no value exists. Renders as an em dash, never a zero.
 *   suspect    — a value exists and the source disagrees with itself.
 *   modelled   — computed from assumptions, not observed. STICKY: no amount of
 *                measured downstream input can restore `measured`.
 *   partial    — real, but known to be short of the full window.
 *   measured   — observed, complete.
 */
export type MetricState = "unmeasured" | "suspect" | "modelled" | "partial" | "measured";

export type Metric = {
  value: number | null;
  state: MetricState;
  /** Human explanation of why the state is not "measured". */
  note?: string;
};

/** Weakest-wins lattice. `modelled` sits BELOW `partial` deliberately: an
 * invented input is a worse provenance than an incomplete one, and putting it
 * lower is what makes it sticky through every combination. */
const RANK: Record<MetricState, number> = {
  unmeasured: 0,
  suspect: 1,
  modelled: 2,
  partial: 3,
  measured: 4,
};

export function weakest(states: MetricState[]): MetricState {
  let out: MetricState = "measured";
  for (const s of states) if (RANK[s] < RANK[out]) out = s;
  return out;
}

export const UNMEASURED: Metric = { value: null, state: "unmeasured" };

function make(value: number, state: MetricState, note?: string): Metric {
  return note === undefined ? { value, state } : { value, state, note };
}

export function measured(value: number): Metric {
  return { value, state: "measured" };
}

export function partial(value: number, note?: string): Metric {
  return make(value, "partial", note);
}

/** Derived from assumptions. Once this enters a computation it never leaves. */
export function modelled(value: number, note?: string): Metric {
  return make(value, "modelled", note);
}

/** A value exists but contradicts itself — a rate above 100%, a negative count. */
export function suspect(value: number, note?: string): Metric {
  return make(value, "suspect", note);
}

export function unmeasured(note?: string): Metric {
  return note === undefined ? UNMEASURED : { value: null, state: "unmeasured", note };
}

export function toNum(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A raw database column that is nullable by design: NULL means the source
 * never reported the action, which is not the same as reporting zero.
 */
export function fromNullable(
  value: number | string | null | undefined,
  note?: string,
): Metric {
  const n = toNum(value);
  return n === null ? unmeasured(note) : measured(n);
}

/**
 * A column that is genuinely always populated (spend), so a zero is a real
 * observed zero.
 */
export function fromObserved(value: number | string | null | undefined): Metric {
  const n = toNum(value);
  return n === null ? UNMEASURED : measured(n);
}

/** Force a metric down to a weaker state, keeping its value and adding a note. */
export function degrade(m: Metric, state: MetricState, note?: string): Metric {
  if (m.value === null) return unmeasured(note ?? m.note);
  const s = weakest([m.state, state]);
  return make(m.value, s, note ?? m.note);
}

/**
 * Aggregates inherit the weakest input state. A sum of four measured values
 * and one unmeasured value is PARTIAL — never measured, never silently short.
 * Centralised here so no screen can forget it.
 */
export function sumMetrics(items: Metric[], note?: string): Metric {
  if (items.length === 0) return unmeasured(note);
  let total = 0;
  let contributing = 0;
  let missing = 0;
  const states: MetricState[] = [];
  for (const m of items) {
    if (m.state === "unmeasured" || m.value === null) {
      missing += 1;
      continue;
    }
    total += m.value;
    contributing += 1;
    states.push(m.state);
    if (m.state === "partial") missing += 0.5; // a partial input taints the sum
  }
  if (contributing === 0) return unmeasured(note ?? "no input was measured");
  let state = weakest(states);
  if (missing > 0) state = weakest([state, "partial"]);
  if (state === "measured") return measured(total);
  return make(
    total,
    state,
    note ??
      (missing > 0
        ? `${Math.ceil(missing)} of ${items.length} inputs are unmeasured — this total is a floor, not a fact`
        : undefined),
  );
}

/** a / b, inheriting the weaker of the two states. Division by zero is unmeasured. */
export function divideMetrics(a: Metric, b: Metric, note?: string): Metric {
  if (a.value === null || b.value === null) return unmeasured(note ?? a.note ?? b.note);
  if (b.value === 0) return unmeasured(note ?? "denominator is zero");
  const value = a.value / b.value;
  const state = weakest([a.state, b.state]);
  if (state === "unmeasured") return unmeasured(note ?? a.note ?? b.note);
  if (state === "measured") return measured(value);
  return make(value, state, note ?? a.note ?? b.note);
}

export function shareOf(part: Metric, whole: Metric): Metric {
  const r = divideMetrics(part, whole);
  return r.value === null ? r : { ...r, value: r.value * 100 };
}

/**
 * THE rate constructor. Every percentage in the product goes through it.
 *
 * - denominator below `min` → unmeasured. A show-up rate on one registrant is
 *   not a rate, it is a coin toss with a decimal point.
 * - part greater than whole → suspect. The source disagrees with itself and
 *   the figure must never enter a total, a ranking or a verdict.
 *
 * Returns a percentage (0–100), not a fraction.
 */
export function rate(
  part: number | string | null | undefined | Metric,
  whole: number | string | null | undefined | Metric,
  opts: { min?: number; note?: string } = {},
): Metric {
  const min = opts.min ?? 30;
  const pm = isMetric(part) ? part : fromNullable(part);
  const wm = isMetric(whole) ? whole : fromNullable(whole);
  if (pm.value === null || wm.value === null)
    return unmeasured(opts.note ?? pm.note ?? wm.note ?? "one side of this rate was never measured");
  if (wm.value <= 0) return unmeasured("denominator is zero");
  if (wm.value < min)
    return unmeasured(
      `denominator is ${wm.value} — below the ${min} needed for a rate to mean anything`,
    );
  const value = (pm.value / wm.value) * 100;
  if (value > 100)
    return suspect(
      value,
      `${pm.value} of ${wm.value} is more than all of them — the source disagrees with itself`,
    );
  const state = weakest([pm.state, wm.state]);
  return state === "measured" ? measured(value) : make(value, state, opts.note ?? pm.note ?? wm.note);
}

function isMetric(v: unknown): v is Metric {
  return typeof v === "object" && v !== null && "state" in (v as Record<string, unknown>);
}

/**
 * Sort comparator that never lets an unmeasured value pretend to be zero.
 * Unmeasured rows are pushed into a terminal group by `rankable()`; this only
 * orders the rows that can be ranked.
 */
export function rankable(m: Metric | undefined | null): boolean {
  return Boolean(m && m.value !== null && m.state !== "unmeasured" && m.state !== "suspect");
}

export function compareMetric(a: Metric, b: Metric, dir: "asc" | "desc"): number {
  const av = a.value ?? 0;
  const bv = b.value ?? 0;
  return dir === "asc" ? av - bv : bv - av;
}
