import { createServerFn } from "@tanstack/react-start";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type BriefView = {
  configured: boolean;
  for_date: string | null;
  brief: string | null;
  evidence: Json | null;
  model: string | null;
  created_at: string | null;
  /** Set when today's generation ran and failed — never a stale brief. */
  failure: { at: string | null; error: string | null } | null;
  /**
   * A counting rule changed after this brief was written, so some figures in it
   * were worked out the old way. V6: never let a brief read as current when the
   * definitions underneath it have moved.
   */
  superseded: { at: string; what: string } | null;
  error: string | null;
};


const EMPTY: BriefView = {
  configured: false,
  for_date: null,
  brief: null,
  evidence: null,
  model: null,
  created_at: null,
  failure: null,
  superseded: null,
  error: null,
};

/** Reads the stored brief. No model is called on page view, ever. */
export const getBrief = createServerFn({ method: "GET" }).handler(async (): Promise<BriefView> => {
  const { getPg, pgSelect } = await import("./pg.server");
  const pg = getPg();
  if (!pg) return EMPTY;
  try {
    const [rows, runs, rules] = await Promise.all([
      pgSelect<
        {
          for_date: string;
          brief_md: string;
          evidence: Json;
          model: string | null;
          created_at: string;
        }[]
      >(
        pg,
        "/analyst_briefs?select=for_date,brief_md,evidence,model,created_at&order=for_date.desc&limit=1",
      ),
      pgSelect<{ finished_at: string | null; status: string | null; error: string | null }[]>(
        pg,
        "/sync_runs?select=finished_at,status,error&source=eq.analyst-brief&order=started_at.desc&limit=1",
      ),
      pgSelect<{ created_at: string; what_changed: string }[]>(
        pg,
        "/rule_changes?select=created_at,what_changed&order=created_at.desc&limit=1",
      ),
    ]);
    const row = rows?.[0] ?? null;
    const last = runs?.[0] ?? null;
    const failed = last && last.status === "error";
    // A counting rule changed after the brief was written: its figures were
    // worked out under the old rule, so the reader must be told.
    const rule = rules?.[0] ?? null;
    const superseded =
      row && rule && Date.parse(rule.created_at) > Date.parse(row.created_at)
        ? { at: rule.created_at, what: rule.what_changed }
        : null;
    return {
      configured: true,
      for_date: row?.for_date ?? null,
      brief: row?.brief_md ?? null,
      evidence: row?.evidence ?? null,
      model: row?.model ?? null,
      created_at: row?.created_at ?? null,
      failure: failed ? { at: last.finished_at, error: last.error } : null,
      superseded,
      error: null,
    };

  } catch (error) {
    return {
      ...EMPTY,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

/** Manual re-run from the page. Same pipeline the cron uses. */
export const generateBrief = createServerFn({ method: "POST" }).handler(async () => {
  const { runAnalystBrief } = await import("./analyst.server");
  const result = await runAnalystBrief({ force: true });
  return {
    status: result.status,
    for_date: result.for_date,
    attempts: result.attempts,
    error: result.error,
  };
});
