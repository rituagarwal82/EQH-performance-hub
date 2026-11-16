/**
 * TagMango payments sync.
 *
 * TagMango's external API has no order/transaction list endpoint. The money
 * rows live inside each subscription's `orders[]` array, so the ledger is
 * assembled as: L1 mango ids -> subscribers of those mangos -> that person's
 * subscriptions -> the orders attached to L1 mangos.
 *
 * Because there can be thousands of subscribers, the sync is cursor based:
 * each invocation processes a slice of the subscriber list and reports
 * `hasMore`. Nothing is ever invented — if the API key is missing the tables
 * stay empty.
 */

import { getPg, pgRpc, pgSelect, pgUpsert, type PgClient } from "./pg.server";
import { analyzeAfterWrite } from "./load-guard.server";
import { lastRawError } from "./safe-error";

const TAGMANGO_BASE = "https://api-prod-new.tagmango.com";
const TAGMANGO_HOST = "learn.energyqueenshub.com";
const CREATOR_ID = "64b9244648917c2a1802e84e";
const CURSOR_KEY = "tagmango_payments_cursor";
const STATUS_KEY = "tagmango_payments_status";
const CONCURRENCY = 8;
// Subscribers are id-ordered, so the newest buyers are the last rows; this many
// are re-read on every run regardless of where the rolling cursor stands.
const FRESH_TAIL = 400;

export type PaymentSyncResult = {
  configured: boolean;
  status: "success" | "warning" | "partial" | "error";
  usersTotal: number;
  usersProcessed: number;
  freshChecked: number;
  offset: number;
  hasMore: boolean;
  paymentsWritten: number;
  enrolmentsWritten: number;
  salesRebuilt: number | null;
  latestPaidAt: string | null;
  warnings: string[];
  errors: string[];
  coverage?: {
    productsSeen: number;
    productsSynced: number;
    productsSkipped: { mango_id: string; title: string; reason: string }[];
    enrolmentsAdded: number;
    paymentsAdded: number;
    subscribersPerProduct?: Record<string, number>;
  };
};

type TagMangoUser = {
  _id: string;
  email?: string | null;
  phone?: number | string | null;
};

type TagMangoOrder = {
  _id: string;
  amount?: number | null;
  status?: string | null;
  isRefunded?: boolean;
  subscriberCurrency?: string | null;
  coupon?: string | null;
  inr?: { discount?: number | null; mangoPrice?: number | null } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type TagMangoSubscription = {
  _id?: string;
  mango?: { _id?: string } | null;
  fan?: TagMangoUser | null;
  orders?: TagMangoOrder[] | null;
  status?: string | null;
  subscribedAt?: string | null;
  createdAt?: string | null;
};

async function tagMangoGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${TAGMANGO_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "x-whitelabel-host": TAGMANGO_HOST },
  });
  const text = await response.text();
  let body: { result?: T; success?: boolean } | null = null;
  try {
    body = JSON.parse(text) as { result?: T; success?: boolean };
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.result === undefined) {
    throw new Error(`TagMango ${response.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return body.result;
}

/**
 * EVERY PRODUCT, NOT A FIXED LIST (owner-approved 29 Sep 2026).
 *
 * The product list is read from TagMango itself on every run, so a product
 * added tomorrow is covered without a code change. Enrolments and payments
 * are stored for all of them. Whether an enrolment is a SALE is still decided
 * downstream by products.tier / counts_as_sale (rebuild_tm_sales), so widening
 * the sync does not change the sale count.
 *
 * A product is only ever skipped by a named entry here, with its reason.
 */
const EXCLUDED_PRODUCTS: Record<string, string> = {
  // (none yet) — "mango_id": "reason",
};

type ProductScope = {
  seen: number;
  synced: string[];
  skipped: { mango_id: string; title: string; reason: string }[];
  sale: string[];
};

async function getMangoScopes(pg: PgClient, token: string): Promise<ProductScope> {
  const catalogue: { _id: string; title?: string }[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = await tagMangoGet<{ _id: string; title?: string }[]>(
      `/api/v1/external/mangos?limit=100&page=${page}`,
      token,
    );
    catalogue.push(...batch);
    if (batch.length < 100) break;
  }
  const known = new Set(
    (await pgSelect<{ mango_id: string }[]>(pg, "/products?select=mango_id")).map((r) => r.mango_id),
  );
  const fresh = catalogue.filter((p) => p?._id && !known.has(p._id));
  for (const p of fresh) {
    await pgUpsert(pg, "products", { mango_id: p._id, title: p.title ?? p._id });
  }
  const skipped: ProductScope["skipped"] = [];
  const synced: string[] = [];
  for (const p of catalogue) {
    if (!p?._id) continue;
    const reason = EXCLUDED_PRODUCTS[p._id];
    if (reason) skipped.push({ mango_id: p._id, title: p.title ?? "", reason });
    else synced.push(p._id);
  }
  const sale = await pgSelect<{ mango_id: string }[]>(
    pg,
    "/products?select=mango_id&tier=eq.L1_SILVER&counts_as_sale=is.true",
  );
  return { seen: catalogue.length, synced, skipped, sale: sale.map((r) => r.mango_id) };
}

/**
 * Every product widens the list to ~234k people, most of them on free
 * products. The lap order therefore puts people on SMALL products first
 * (Diamond, AMP, gift, balance payments), so the paid and rare products are
 * covered in the first passes and the free giants last. The fresh tail is
 * still taken from the id order, so today's buyers are always re-read.
 */
async function listSubscribers(mangoIds: string[], token: string) {
  const byId = new Map<string, TagMangoUser>();
  const rank = new Map<string, number>();
  const perProduct: Record<string, number> = {};
  for (const mangoId of mangoIds) {
    const users = await tagMangoGet<TagMangoUser[]>(
      `/api/v1/external/subscriptions/subscribers-by-creator/${CREATOR_ID}?mangoes=${encodeURIComponent(mangoId)}`,
      token,
    );
    perProduct[mangoId] = users.length;
    for (const user of users) {
      if (!user?._id) continue;
      byId.set(user._id, user);
      rank.set(user._id, Math.min(rank.get(user._id) ?? Infinity, users.length));
    }
  }
  const all = [...byId.values()];
  const byIdOrder = [...all].sort((a, b) => a._id.localeCompare(b._id));
  const lapOrder = all.sort(
    (a, b) => (rank.get(a._id) ?? 0) - (rank.get(b._id) ?? 0) || a._id.localeCompare(b._id),
  );
  return { lapOrder, byIdOrder, perProduct };
}

/**
 * A sale is an ENROLMENT, not a payment. Offline buyers (UPI, bank transfer,
 * cash, cheque) are enrolled with a 100% coupon, so TagMango holds a real
 * subscription with a ₹0 order. Payments are still recorded, but only as the
 * money side of the story.
 */
function toRows(
  user: TagMangoUser,
  subs: TagMangoSubscription[],
  money: Set<string>,
  sale: Set<string>,
) {
  const payments: Record<string, unknown>[] = [];
  const enrolments: Record<string, unknown>[] = [];
  for (const sub of subs) {
    const mangoId = sub?.mango?._id;
    if (!mangoId || !money.has(mangoId)) continue;
    const email = sub.fan?.email ?? user.email ?? null;
    const phone = sub.fan?.phone ?? user.phone ?? null;
    const normalisedEmail = email ? String(email).trim().toLowerCase() : null;

    const subAny = sub as Record<string, unknown>;
    let charged = 0;
    let couponCode: string | null =
      typeof subAny["coupon"] === "string" && subAny["coupon"] ? subAny["coupon"] : null;
    let affiliateUser: string | null = null;
    let discounted = false;
    for (const order of sub.orders ?? []) {
      if (!order?._id) continue;
      const amount = typeof order.amount === "number" ? order.amount : 0;
      charged += amount;
      const orderAny = order as Record<string, unknown>;
      const code = order.coupon ?? (order.inr as Record<string, unknown> | null)?.["code"];
      if (code) couponCode = couponCode ?? String(code);
      const aff = orderAny["affiliateUser"] as string | { _id?: string } | null | undefined;
      const affId = typeof aff === "string" ? aff : (aff?._id ?? null);
      if (affId) affiliateUser = affiliateUser ?? affId;
      if ((order.inr?.discount ?? 0) > 0) discounted = true;
      payments.push({
        payment_id: order._id,
        mango_id: mangoId,
        buyer_email: normalisedEmail,
        buyer_phone: phone ? String(phone) : null,
        amount_gross: amount,
        currency: order.subscriberCurrency ?? "INR",
        status: order.isRefunded ? "refunded" : (order.status ?? null),
        paid_at: order.createdAt ?? order.updatedAt ?? null,
        raw: order,
      });
    }

    // Every product's enrolment is stored; which ones are SALES is decided
    // downstream by products.tier / counts_as_sale, never here.
    void sale;
    if (sub._id && normalisedEmail) {
      const { orders: _orders, fan: _fan, ...subRest } = subAny;
      enrolments.push({
        subscription_id: sub._id,
        mango_id: mangoId,
        buyer_email: normalisedEmail,
        buyer_phone: phone ? String(phone) : null,
        enrolled_at: sub.subscribedAt ?? sub.createdAt ?? null,
        status: sub.status ?? null,
        amount_via_tagmango: charged,
        coupon_code: couponCode,
        is_coupon: Boolean(couponCode) || discounted,
        affiliate_user: affiliateUser,
        raw: { ...subRest, mango: mangoId, orderCount: (sub.orders ?? []).length },
      });
    }
  }
  return { payments, enrolments };
}

async function readCursor(pg: PgClient): Promise<number> {
  const rows = await pgSelect<{ value: string | null }[]>(
    pg,
    `/app_settings?select=value&key=eq.${CURSOR_KEY}`,
  );
  const value = Number(rows[0]?.value ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function writeSetting(pg: PgClient, key: string, value: string, description: string) {
  await pgUpsert(pg, "app_settings", {
    key,
    value,
    description,
    updated_at: new Date().toISOString(),
  });
}

/** The IST business day (06:00–05:59) that a moment falls in. */
function businessDate(at: Date): string {
  return new Date(at.getTime() + 5.5 * 3600_000 - 6 * 3600_000).toISOString().slice(0, 10);
}

/**
 * The two sources disagree in BOTH directions, so both are reported.
 *
 * Until 22 Sep 2026 this only noticed days where the ledger had sales and
 * TagMango had none. On 21 Sep the ledger held a buyer TagMango did not, and
 * TagMango held two the ledger did not — and the run said nothing. Every
 * mismatch in the last three business days is now named, for the accounts team.
 */
async function sellingDayAssertion(pg: PgClient, _mangoIds: string[]): Promise<string[]> {
  const warnings: string[] = [];
  const today = new Date();
  for (let back = 1; back <= 3; back += 1) {
    const day = businessDate(new Date(today.getTime() - back * 86_400_000));
    let rows: ReconRow[] = [];
    try {
      rows = (await pgRpc<ReconRow[]>(pg, "sales_day_reconciliation", { p_date: day })) ?? [];
    } catch {
      warnings.push(`${day}: the two sources could not be compared — the check did not run.`);
      continue;
    }
    const ledgerOnly = rows.filter((r) => r.side === "ledger_only");
    const tmOnly = rows.filter((r) => r.side === "tagmango_only");
    if (ledgerOnly.length > 0) {
      warnings.push(
        `${day}: ${ledgerOnly.length} buyer(s) in the accounts ledger that TagMango does not have — ${ledgerOnly
          .map((r) => r.person_name ?? r.email_key)
          .join(", ")}.`,
      );
    }
    if (tmOnly.length > 0) {
      warnings.push(
        `${day}: ${tmOnly.length} buyer(s) in TagMango that the accounts ledger does not have — ${tmOnly
          .map((r) => r.email_key)
          .join(", ")}.`,
      );
    }
  }
  return warnings;
}

type ReconRow = {
  side: "ledger_only" | "tagmango_only" | "both";
  email_key: string;
  person_name: string | null;
};

export async function runTagMangoPaymentSync(
  options: {
    batchSize?: number;
    restart?: boolean;
    /** Read only the newest buyers — the on-demand "what happened today" pull. */
    tailOnly?: boolean;
  } = {},
): Promise<PaymentSyncResult> {
  const token = process.env["TAGMANGO_API_KEY"];
  const pg = getPg();
  const base: PaymentSyncResult = {
    configured: Boolean(token),
    status: "success",
    usersTotal: 0,
    usersProcessed: 0,
    freshChecked: 0,
    offset: 0,
    hasMore: false,
    paymentsWritten: 0,
    enrolmentsWritten: 0,
    salesRebuilt: null,
    latestPaidAt: null,
    warnings: [],
    errors: [],
  };
  if (!token || !pg) {
    return {
      ...base,
      configured: false,
      status: "error",
      errors: [
        !token
          ? "TagMango not connected — add TAGMANGO_API_KEY"
          : "Database is not configured.",
      ],
    };
  }

  const batchSize = Math.max(25, Math.min(options.batchSize ?? 300, 1000));
  const errors: string[] = [];
  const started = new Date().toISOString();

  const scopes = await getMangoScopes(pg, token);
  const mangoIds = scopes.sale;
  const money = new Set(scopes.synced);
  const sale = new Set(scopes.sale);
  const listed = await listSubscribers(scopes.synced, token);
  const subscribers = listed.lapOrder;
  const countsBefore = await pgRpc<{ payments: number; enrolments: number }>(pg, "tm_row_counts", {});

  const startOffset = options.restart ? 0 : await readCursor(pg);
  const cursorSlice = options.tailOnly
    ? []
    : subscribers.slice(startOffset, startOffset + batchSize);

  // The subscriber list is ordered by TagMango id, which is time ordered, so
  // today's buyers always sit at the end of it. A cursor part-way through the
  // list therefore reaches them only when it finishes its lap — which is how
  // the daily sales counter fell three days behind while reporting success.
  // Every run now re-reads the newest tail as well as its cursor slice.
  const freshTail = listed.byIdOrder.slice(Math.max(0, listed.byIdOrder.length - FRESH_TAIL));
  const seen = new Set(cursorSlice.map((u) => u._id));
  const slice = [...cursorSlice, ...freshTail.filter((u) => !seen.has(u._id))];


  const pendingPayments: Record<string, unknown>[] = [];
  const pendingEnrolments: Record<string, unknown>[] = [];
  for (let index = 0; index < slice.length; index += CONCURRENCY) {
    const chunk = slice.slice(index, index + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (user) => {
        try {
          const subs = await tagMangoGet<TagMangoSubscription[]>(
            `/api/v1/external/subscriptions/${user._id}?limit=100`,
            token,
          );
          return toRows(user, subs ?? [], money, sale);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          return { payments: [], enrolments: [] };
        }
      }),
    );
    for (const rows of results) {
      pendingPayments.push(...rows.payments);
      pendingEnrolments.push(...rows.enrolments);
    }
  }

  // The same order or subscription can surface under more than one product
  // listing; keep one row per id so an upsert batch never touches a row twice.
  const dedupe = (rows: Record<string, unknown>[], key: string) => [
    ...new Map(rows.map((r) => [String(r[key]), r])).values(),
  ];
  pendingPayments.splice(0, pendingPayments.length, ...dedupe(pendingPayments, "payment_id"));
  pendingEnrolments.splice(0, pendingEnrolments.length, ...dedupe(pendingEnrolments, "subscription_id"));

  let written = 0;
  for (let index = 0; index < pendingPayments.length; index += 200) {
    const batch = pendingPayments.slice(index, index + 200);
    written += await pgRpc<number>(pg, "upsert_tm_payments", { p_rows: batch });
  }

  let enrolmentsWritten = 0;
  for (let index = 0; index < pendingEnrolments.length; index += 200) {
    const batch = pendingEnrolments.slice(index, index + 200);
    enrolmentsWritten += await pgRpc<number>(pg, "upsert_tm_enrolments", { p_rows: batch });
  }

  const nextOffset = startOffset + cursorSlice.length;
  const hasMore = nextOffset < subscribers.length;
  await writeSetting(
    pg,
    CURSOR_KEY,
    String(hasMore ? nextOffset : 0),
    "Cursor into the TagMango L1 subscriber list for the payments sync.",
  );

  const salesRebuilt = await pgRpc<number>(pg, "rebuild_tm_sales", {});

  const warnings = await sellingDayAssertion(pg, mangoIds);
  const latest = await pgSelect<{ paid_at: string | null }[]>(
    pg,
    "/tm_payments?select=paid_at&order=paid_at.desc&limit=1",
  );

  const result: PaymentSyncResult = {
    configured: true,
    status: errors.length > 0 ? "partial" : warnings.length > 0 ? "warning" : "success",
    usersTotal: subscribers.length,
    usersProcessed: slice.length,
    freshChecked: freshTail.length,
    offset: hasMore ? nextOffset : subscribers.length,
    hasMore,
    paymentsWritten: written,
    enrolmentsWritten,
    salesRebuilt,
    latestPaidAt: latest?.[0]?.paid_at ?? null,
    warnings,
    errors: errors.slice(0, 5),
  };

  // Count check, printed after every run.
  const countsAfter = await pgRpc<{ payments: number; enrolments: number }>(pg, "tm_row_counts", {});
  const coverage = {
    productsSeen: scopes.seen,
    productsSynced: scopes.synced.length,
    productsSkipped: scopes.skipped,
    enrolmentsAdded: countsAfter.enrolments - countsBefore.enrolments,
    paymentsAdded: countsAfter.payments - countsBefore.payments,
    subscribersPerProduct: listed.perProduct,
  };
  console.log("[tagmango-payments] coverage", JSON.stringify(coverage));
  result.coverage = coverage;

  let previousSynced: number | null = null;
  try {
    const prev = await pgSelect<{ value: string | null }[]>(
      pg,
      `/app_settings?select=value&key=eq.${STATUS_KEY}`,
    );
    const parsed = prev[0]?.value ? JSON.parse(prev[0].value) : null;
    previousSynced = parsed?.coverage?.productsSynced ?? null;
  } catch {
    previousSynced = null;
  }
  if (previousSynced !== null && coverage.productsSynced < previousSynced) {
    const { raiseReviewItem } = await import("./review.server");
    await raiseReviewItem(pg, {
      kind: "job_failure",
      refId: "tagmango-product-coverage",
      title: `TagMango sync covered fewer products than last run (${coverage.productsSynced} vs ${previousSynced})`,
      detail: `Products seen ${coverage.productsSeen}, synced ${coverage.productsSynced}, skipped ${coverage.productsSkipped.length}.`,
      evidence: coverage,
    });
    result.warnings.push(
      `Covered ${coverage.productsSynced} products, fewer than the previous run's ${previousSynced}.`,
    );
  }

  await writeSetting(
    pg,
    STATUS_KEY,
    JSON.stringify({ ...result, checkedAt: new Date().toISOString() }),
    "Last TagMango payments sync result.",
  );

  if (written > 0) await analyzeAfterWrite(pg, ["tm_payments", "tm_sales"]);

  await pgUpsert(pg, "sync_runs", {
    started_at: started,
    finished_at: new Date().toISOString(),
    source: "tagmango-payments",
    rows_written: written,
    status: result.status,
    error: errors[0] ?? warnings[0] ?? null,
    error_detail: errors.length ? (lastRawError() ?? errors.join("; ")) : null,
  });

  return result;
}
