import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const generateConceptDrafts = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({ force: z.boolean().optional(), onlyItemId: z.string().optional() })
      .parse(data ?? {}),
  )
  .handler(async ({ data }) => {
    const { generateDrafts } = await import("./draft-script.server");
    try {
    return await generateDrafts({
      ...(data.force === undefined ? {} : { force: data.force }),
      ...(data.onlyItemId === undefined ? {} : { onlyItemId: data.onlyItemId }),
    });
    } catch (e) {
      const { safeMessage } = await import("./safe-error");
      return { written: 0, skipped: 0, failed: 0, notes: [safeMessage(e)] };
    }
  });

export const saveConceptDraft = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        reviewItemId: z.string(),
        hook: z.string(),
        body: z.string(),
        close: z.string(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { saveDraftEdit } = await import("./draft-script.server");
    try {
      return await saveDraftEdit(data);
    } catch {
      return { ok: false };
    }
  });
