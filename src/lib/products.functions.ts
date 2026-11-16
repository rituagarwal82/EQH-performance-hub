import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeMessage } from "./safe-error";

export type ProductTier = "L1_SILVER" | "L2" | "L3_DIAMOND" | "OTHER";

export type ProductRow = {
  mango_id: string;
  title: string;
  product_type: string | null;
  price: number | string | null;
  currency: string | null;
  subscriber_count: number | null;
  tier: ProductTier | null;
  counts_as_sale: boolean;
  notes: string | null;
  last_synced_at: string | null;
};

export type ProductsData = {
  configured: boolean;
  products: ProductRow[];
  error: string | null;
};

const SELECT =
  "/products?select=mango_id,title,product_type,price,currency,subscriber_count,tier,counts_as_sale,notes,last_synced_at&order=subscriber_count.desc.nullslast,title.asc";

export const getProducts = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProductsData> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { configured: false, products: [], error: null };
    try {
      const products = await pgSelect<ProductRow[]>(pg, SELECT);
      return { configured: true, products: products ?? [], error: null };
    } catch (e) {
      return { configured: true, products: [], error: safeMessage(e) };
    }
  },
);

const tierSchema = z.enum(["L1_SILVER", "L2", "L3_DIAMOND", "OTHER"]).nullable();

export const saveProductClassification = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        changes: z
          .array(
            z.object({
              mango_id: z.string().min(1),
              tier: tierSchema,
              counts_as_sale: z.boolean(),
            }),
          )
          .min(1),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ saved: number }> => {
    const { getPg, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) throw new Error("Database is not configured.");
    for (const change of data.changes) {
      await pgUpdate(pg, "products", `mango_id=eq.${encodeURIComponent(change.mango_id)}`, {
        tier: change.tier,
        counts_as_sale: change.counts_as_sale,
      });
    }
    return { saved: data.changes.length };
  });
