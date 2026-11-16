/**
 * The owner's one trust screen.
 *
 * Everything here is READ from checks that already run — nothing new is
 * calculated, and nothing is hidden: the technical screens keep every item.
 * This layer only decides which of those items change a money number or need
 * the owner to answer something.
 */

import { createServerFn } from "@tanstack/react-start";

export type OwnerAttention = {
  key: string;
  text: string;
  level: "amber" | "red";
};

/** A ready-to-shoot draft ad script shown beside the decision it belongs to. */
export type OwnerDraft = {
  hook: string;
  body: string;
  close: string;
  drewOn: string;
  editedByOwner: boolean;
  best: { adName: string; costPerSale: number } | null;
  worst: { adName: string; costPerSale: number } | null;
};

export type OwnerDecision = {
  /** review_items id when the answer is recorded there, else null. */
  id: string | null;
  key: string;
  title: string;
  /** One sentence: what is being asked and what is at stake. */
  sentence: string;
  /** Answer style: a Yes/No on a proposal, or a page to open. */
  control: "yes_no" | "open";
  href?: string;
  /** Present only on new-idea proposals. */
  draft?: OwnerDraft;
};

export type OwnerUpcoming = {
  key: string;
  text: string;
  days: number | null;
};

export type OwnerTrust = {
  configured: boolean;
  checkedAt: string | null;
  checksRun: number;
  status: "green" | "amber" | "red";
  statusLine: string;
  attention: OwnerAttention[];
  decisions: OwnerDecision[];
  upcoming: OwnerUpcoming[];
  error: string | null;
};

export const getOwnerTrust = createServerFn({ method: "GET" }).handler(
  async (): Promise<OwnerTrust> => {
    const { computeOwnerTrust } = await import("./owner-trust.server");
    return computeOwnerTrust();
  },
);
