import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { analyzeAfterWrite } from "./load-guard.server";
import { lastRawError } from "./safe-error";

const TAGMANGO_BASE = "https://api-prod-new.tagmango.com";
const TAGMANGO_HOST = "learn.energyqueenshub.com";

type TagMangoProduct = {
  _id: string;
  title: string;
  price?: number;
  currency?: string;
  recurringType?: string;
};

type TagMangoEnvelope<T> = {
  code?: number;
  message?: string;
  statusMessage?: string;
  success?: boolean;
  result?: T;
};

type SubscriptionCount = { mangoId: string; count: number };

async function tagMangoGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${TAGMANGO_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-whitelabel-host": TAGMANGO_HOST,
    },
  });
  const text = await response.text();
  let body: TagMangoEnvelope<T> | null = null;
  try {
    body = JSON.parse(text) as TagMangoEnvelope<T>;
  } catch {
    body = null;
  }
  if (!response.ok || body?.success === false || !body || body.result === undefined) {
    throw new Error(text || `TagMango API error ${response.status}`);
  }
  return body.result;
}

async function fetchProducts(token: string) {
  const products: TagMangoProduct[] = [];
  const limit = 100;
  for (let page = 1; page <= 100; page += 1) {
    const batch = await tagMangoGet<TagMangoProduct[]>(
      `/api/v1/external/mangos?limit=${limit}&page=${page}`,
      token,
    );
    products.push(...batch);
    if (batch.length < limit) return products;
  }
  throw new Error("TagMango pagination exceeded 100 pages.");
}

async function fetchSubscriberCounts(ids: string[], token: string) {
  const counts = new Map<string, number>();
  for (let index = 0; index < ids.length; index += 50) {
    const mangoes = ids.slice(index, index + 50).join(",");
    const result = await tagMangoGet<{ subscriptions?: SubscriptionCount[] }>(
      `/api/v1/external/mangos/subscriptions/count?mangoes=${encodeURIComponent(mangoes)}`,
      token,
    );
    for (const row of result.subscriptions ?? []) counts.set(row.mangoId, row.count);
  }
  return counts;
}

/**
 * The catalogue changes rarely, but a feed that never records a run reads as
 * BROKEN on /health. Every run is logged in sync_runs under `tagmango-products`
 * so the weekly schedule is visible and judged like every other feed.
 */
export async function runTagMangoProductSync() {
  const { getPg, pgInsert, pgUpdate } = await import("./pg.server");
  const pg = getPg();
  let runId: string | undefined;
  if (pg) {
    const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", {
      source: "tagmango-products",
      status: "running",
    });
    runId = run?.[0]?.id;
  }
  const finish = async (status: "success" | "error", rowsWritten: number, error: string | null) => {
    // Planner statistics: a job never reports success on data the planner
    // still thinks is not there (7 Sep outage rule).
    if (rowsWritten > 0) await analyzeAfterWrite(pg, ["products", "tm_enrolments"]);
    if (pg && runId) {
      await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
        finished_at: new Date().toISOString(),
        rows_written: rowsWritten,
        status,
        error,
        error_detail: error ? (lastRawError() ?? error) : null,
      });
    }
  };

  try {
    const token = process.env["TAGMANGO_API_KEY"];
    if (!token) {
      throw new Error("TAGMANGO_API_KEY is not set in Cloud secrets.");
    }

    const products = await fetchProducts(token);
    const counts = await fetchSubscriberCounts(
      products.map((product) => product._id),
      token,
    );
    const syncedAt = new Date().toISOString();
    const rows = products.map((product) => ({
      mango_id: product._id,
      title: product.title,
      product_type: product.recurringType ?? null,
      price: product.price ?? null,
      currency: product.currency ?? null,
      subscriber_count: counts.get(product._id) ?? null,
      last_synced_at: syncedAt,
    }));

    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from("products").upsert(rows, {
        onConflict: "mango_id",
      });
      if (error) throw new Error(error.message);
    }

    await finish("success", rows.length, null);
    return { status: "success" as const, rowsWritten: rows.length, syncedAt };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finish("error", 0, message);
    throw e;
  }
}