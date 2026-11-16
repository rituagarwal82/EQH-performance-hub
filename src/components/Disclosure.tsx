import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Depth on demand.
 *
 * Nothing correct is ever deleted from a screen — it moves behind one of these.
 * A closed disclosure still states what is inside it and, where the summary is
 * a figure, still states the figure. Opening it costs one tap.
 */
export function Disclosure({
  title,
  teaser,
  defaultOpen = false,
  openReason,
  children,
  className = "",
}: {
  title: string;
  /** One line shown while closed — the answer, not a label. */
  teaser?: ReactNode;
  defaultOpen?: boolean;
  /** Why this opened itself, when it did. */
  openReason?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // A section that auto-opens must do so on the client too, after its inputs
  // resolve — but never re-close a section the reader opened by hand.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <section className={`border-border bg-card rounded-md border ${className}`}>
      <button
        type="button"
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/40"
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {teaser ? (
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
            {teaser}
          </span>
        ) : null}
        {openReason && open ? (
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-warning">
            {openReason}
          </span>
        ) : null}
      </button>
      {open ? <div className="border-border border-t px-4 py-3">{children}</div> : null}
    </section>
  );
}

/** The same idea inline, for a single paragraph of depth. */
export function InlineDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="text-[11px] text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {label} {open ? "▾" : "▸"}
      </button>
      {open ? <span className="ml-2">{children}</span> : null}
    </span>
  );
}
