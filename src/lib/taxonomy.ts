/**
 * The closed creative vocabulary.
 *
 * Codes are fixed — every tag row, concept and brief refers to a code, so a
 * label can be reworded in app_settings without invalidating history. A tag
 * outside these codes is rejected, never coerced.
 */

export type Vocab = Record<string, string>;

export const PERSONAS: Vocab = {
  P0: "Broad (no single persona)",
  P1: "Homemaker",
  P2: "Working woman considering resigning",
  P3: "Between jobs",
  P4: "Mother returning after a break",
  P5: "Financially dependent wife seeking own income",
  P6: "Caregiver",
  P7: "Empty-nester 45–55",
  P8: "Midlife health & energy seeker",
  P9: "Young professional in burnout",
  P10: "Practicing spiritual seeker",
};

export const PAINS: Vocab = {
  PA1: "Lost identity",
  PA2: "Financial dependence",
  PA3: "Exhaustion",
  PA4: "Guilt over self-care",
  PA5: "Anxiety / overthinking",
  PA6: "Feeling unseen",
  PA7: "Career stuckness",
  PA8: "Relationship strain",
  PA9: "Low energy / health",
  PA10: "Purposelessness",
};

export const HOOKS: Vocab = {
  H1: "Curiosity",
  H2: "Fear / consequence",
  H3: "Identity call-out",
  H4: "Social proof",
  H5: "Contrarian",
  H6: "Self-diagnosis question",
  H7: "Story cold-open",
  H8: "Authority / scripture",
};

export const PROMISES: Vocab = {
  T1: "Transformation",
  T2: "Relief",
  T3: "Hidden knowledge",
  T4: "Belonging",
  T5: "Method / quick win",
  T6: "Permission / validation",
};

export const REGISTERS: Vocab = {
  E1: "Warm",
  E2: "Urgent",
  E3: "Aspirational",
  E4: "Calm",
  E5: "Playful",
};

export const SPIRITUAL: Vocab = {
  S1: "Pure spiritual",
  S2: "Spiritual-led",
  S3: "Practical-led",
  S4: "Pure practical",
};

export const CTAS: Vocab = {
  C1: "Direct",
  C2: "Curiosity",
  C3: "Time-urgency",
  C4: "Soft invite",
  C5: "Challenge",
};

export const STRUCTURES: Vocab = {
  ST1: "PAS",
  ST2: "Story",
  ST3: "Teach-first",
  ST4: "Testimonial",
  ST5: "Listicle",
  ST6: "Direct offer",
};

export const TAXONOMY = {
  persona: PERSONAS,
  pain: PAINS,
  hook_mechanism: HOOKS,
  promise: PROMISES,
  emotional_register: REGISTERS,
  spiritual_scale: SPIRITUAL,
  cta_style: CTAS,
  structure: STRUCTURES,
} as const;

export type TagField = keyof typeof TAXONOMY;

/** Human label for a code, falling back to the code itself. */
export function label(field: TagField, code: string | null | undefined): string {
  if (!code) return "—";
  return TAXONOMY[field][code] ?? code;
}

/** `P1 Homemaker` — used wherever a tag is displayed. */
export function codeLabel(field: TagField, code: string | null | undefined): string {
  if (!code) return "—";
  const l = TAXONOMY[field][code];
  return l ? `${code} ${l}` : code;
}

/* ---------------------------------------------------------------------------
 * Plain words for the owner.
 *
 * Codes are the builder's shorthand. Everywhere a decision is put to the
 * owner — the review queue, the decisions list, the daily email, the Creative
 * screen — the persona, pain, promise and script are spelled out in his words.
 * A decision he cannot read is a decision he will not make.
 * ------------------------------------------------------------------------ */

const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export const plainPersona = (code?: string | null) =>
  (code && PERSONAS[code]) || "a broad audience";
export const plainPain = (code?: string | null) => (code && PAINS[code]) || "an unnamed struggle";
export const plainPromise = (code?: string | null) =>
  (code && PROMISES[code]) || "an unnamed promise";
export const plainHook = (code?: string | null) => (code && HOOKS[code]) || "an unnamed hook";

/** `Homemakers held back by guilt over self-care, offered hidden knowledge` */
export function plainConcept(
  persona?: string | null,
  pain?: string | null,
  promise?: string | null,
): string {
  return `${plainPersona(persona)} held back by ${lower(plainPain(pain))}, offered ${lower(
    plainPromise(promise),
  )}`;
}

/** The script by its title, never its code, with the code only as a fallback. */
export function plainScript(
  script: { script_code?: string | null; title?: string | null } | null | undefined,
): string {
  if (!script) return "an untitled script";
  const t = (script.title ?? "").trim();
  return t || script.script_code || "an untitled script";
}

/** `"Gita's first order", "Why self-care feels like guilt" and one more` */
export function plainScriptList(
  scripts: { script_code?: string | null; title?: string | null }[],
): string {
  const names = scripts.map(plainScript).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return `"${names[0]}"`;
  if (names.length === 2) return `"${names[0]}" and "${names[1]}"`;
  return `${names.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${names[names.length - 1]}"`;
}
