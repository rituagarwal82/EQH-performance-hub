/**
 * Minimal server-only PostgREST client for the Lovable Cloud database.
 * Returns `null` from `getPg()` when the backend is not configured yet, so the
 * dashboard can render an honest empty state instead of fabricating numbers.
 */

export type PgClient = {
  url: string;
  key: string;
};

export function getPg(): PgClient | null {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

/**
 * P0-B, owner-set 7 Sep: the raw driver body must never travel to the browser.
 * A failed read throws a DbError whose `message` is a SAFE KIND TOKEN — the UI
 * turns that into one plain sentence — while the verbatim body stays on `raw`,
 * which is logged server-side and never serialised into a route payload.
 */
export type DbErrorKind = "timeout" | "unavailable" | "other";

export class DbError extends Error {
  readonly kind: DbErrorKind;
  readonly status: number | null;
  readonly raw: string;

  constructor(kind: DbErrorKind, status: number | null, raw: string) {
    // The message IS the kind: anything that leaks it onto a screen leaks a
    // single harmless word, not a driver payload.
    super(kind);
    this.name = "DbError";
    this.kind = kind;
    this.status = status;
    this.raw = raw;
  }
}

function classify(status: number | null, raw: string): DbErrorKind {
  const t = raw.toLowerCase();
  if (t.includes("57014") || t.includes("statement timeout") || t.includes("canceling statement")) {
    return "timeout";
  }
  if (status !== null && (status === 503 || status === 504 || status >= 520)) return "unavailable";
  if (t.includes("timeout") || t.includes("timed out") || t.includes("fetch failed")) {
    return "timeout";
  }
  return "other";
}

/** Normalises anything thrown below into { kind, raw } for logging + UI copy. */
export function errorForUi(e: unknown): { kind: DbErrorKind; raw: string } {
  if (e instanceof DbError) return { kind: e.kind, raw: e.raw };
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return { kind: classify(null, raw), raw };
}

async function request(pg: PgClient, path: string, init?: RequestInit) {
  // EVERY database round trip is timed here, not query by query: a guard that
  // depends on each author remembering to wrap their call is a guard that
  // protects whatever was written before people got busy.
  const t0 = Date.now();
  const done = () => {
    const ms = Date.now() - t0;
    if (ms > 10_000) {
      void import("./query-timing.server")
        .then((m) => m.reportIfSlow(path, ms))
        .catch(() => undefined);
    }
  };
  let res: Response;
  try {
    res = await fetch(`${pg.url}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: pg.key,
        Authorization: `Bearer ${pg.key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    done();
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[EQH] db request failed ${path}:`, raw);
    throw new DbError(classify(null, raw), null, raw);
  }
  const text = await res.text();
  done();
  if (!res.ok) {
    const raw = `${res.status} ${path} ${text.slice(0, 800)}`;
    console.error(`[EQH] db error:`, raw);
    throw new DbError(classify(res.status, raw), res.status, raw);
  }
  return text ? JSON.parse(text) : null;
}



export function pgSelect<T>(pg: PgClient, path: string): Promise<T> {
  return request(pg, path) as Promise<T>;
}

export function pgRpc<T>(pg: PgClient, fn: string, args: unknown): Promise<T> {
  return request(pg, `/rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify(args),
  }) as Promise<T>;
}

export async function pgInsert<T>(pg: PgClient, table: string, row: unknown): Promise<T> {
  return (await request(pg, `/${table}`, {
    method: "POST",
    body: JSON.stringify(row),
    headers: { Prefer: "return=representation" },
  })) as T;
}

export async function pgUpdate(pg: PgClient, table: string, filter: string, patch: unknown) {
  await request(pg, `/${table}?${filter}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function pgDelete(pg: PgClient, table: string, filter: string) {
  await request(pg, `/${table}?${filter}`, { method: "DELETE" });
}

/** INSERT ... ON CONFLICT DO UPDATE (PostgREST merge-duplicates). */
export async function pgUpsert<T>(
  pg: PgClient,
  table: string,
  row: unknown,
  onConflict?: string,
): Promise<T> {
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  return (await request(pg, `/${table}${qs}`, {
    method: "POST",
    body: JSON.stringify(row),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  })) as T;
}
