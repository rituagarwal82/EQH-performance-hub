import { Link, useRouter } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";

import { humanError, useTechnicalDetail } from "@/lib/error-copy";

/**
 * The only way a caught error reaches the screen.
 *
 * One human sentence for the owner; the verbatim driver text goes to the
 * console and to Feed Health, where an engineer will look for it.
 */
export function UiError({
  detail,
  subject = "the figures",
  where = "screen",
  className = "",
}: {
  detail?: string | null;
  subject?: string;
  where?: string;
  className?: string;
}) {
  useTechnicalDetail(where, detail);
  return (
    <p role="alert" className={`text-destructive text-[12px] ${className}`}>
      {humanError(detail, subject)}
    </p>
  );
}

/**
 * The one error screen a route may render (P0-B). Mirrors the root boundary:
 * plain sentence, no raw text, a retry that actually re-runs the loader.
 */
export function RouteError({
  error,
  reset,
  subject = "this page",
  where = "route",
}: {
  error: Error;
  reset?: () => void;
  subject?: string;
  where?: string;
}) {
  useTechnicalDetail(where, error.message);
  const router = useRouter();
  return (
    <AppShell>
      <div role="alert" className="px-4 py-8 md:px-6">
        <h1 className="text-sm font-semibold text-foreground">This page didn't load</h1>
        <p className="mt-1.5 max-w-xl text-[13px] text-muted-foreground">
          {humanError(error.message, subject)}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void router.invalidate();
              reset?.();
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <Link
            to="/health"
            search={{ range: "last7", compare: true } as never}
            className="border-input rounded-md border px-3 py-1.5 text-[12px] text-foreground hover:bg-accent"
          >
            Open Feed Health
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
