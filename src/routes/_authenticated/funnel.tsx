import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old public path — kept working permanently after the Tier 3 restructure. */
export const Route = createFileRoute("/_authenticated/funnel")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/show-up", search: search as never, replace: true });
  },
});
