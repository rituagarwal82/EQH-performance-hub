import { createServerFn } from "@tanstack/react-start";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type AskStep = { label: string; detail: string };

export type AskAnswer = {
  question: string;
  understood: string | null;
  answer: string | null;
  sql: string | null;
  rows: number;
  sample: Json[];
  checkSql: string | null;
  checkRows: number;
  checkSample: Json[];
  steps: AskStep[];
  durationMs: number;
  error: string | null;
};

export const SUGGESTED_QUESTIONS = [
  "Review all L1 sales today and tell me the exact date each lead entered the system",
  "Which campaign brought the most registrations this week?",
  "Compare afternoon vs evening attendance this month",
  "Why did sales drop in September?",
];

export const askQuestion = createServerFn({ method: "POST" })
  .inputValidator((data: { question: string }) => ({
    question: String(data?.question ?? "").slice(0, 500),
  }))
  .handler(async ({ data }): Promise<AskAnswer> => {
    const { runAsk } = await import("./ask.server");
    const result = await runAsk(data.question);
    return {
      question: result.question,
      understood: result.understood,
      answer: result.answer,
      sql: result.sql,
      rows: result.rows,
      sample: result.sample as Json[],
      checkSql: result.checkSql,
      checkRows: result.checkRows,
      checkSample: result.checkSample as Json[],
      steps: result.steps,
      durationMs: result.durationMs,
      error: result.error,
    };
  });

export type AskLogRow = {
  id: string;
  question: string;
  rows: number | null;
  error: string | null;
  created_at: string;
};

export const getAskLog = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ configured: boolean; recent: AskLogRow[]; error: string | null }> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { configured: false, recent: [], error: null };
    try {
      const recent = await pgSelect<AskLogRow[]>(
        pg,
        "/ask_log?select=id,question,rows,error,created_at&order=created_at.desc&limit=15",
      );
      return { configured: true, recent: recent ?? [], error: null };
    } catch (error) {
      return {
        configured: true,
        recent: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);
