import { BarChart3, Table2 } from "lucide-react";
import type { ReactNode } from "react";

import { useFigureMode, type FigureMode } from "@/lib/view-prefs";

/**
 * The fixed frame every data section on /ads, /show-up and /sales wears.
 *
 * The toggle switches the RENDERER over one shared dataset — the chart and the
 * table are handed the same array, so they are structurally unable to disagree.
 * The footer always states n, the window, and what is excluded and why; a
 * figure that cannot say what it left out is not allowed on screen.
 */
export function Figure({
  id,
  title,
  note,
  n,
  window,
  excluded,
  chart,
  table,
  defaultMode = "chart",
  right,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  n: string;
  window: string;
  excluded: string;
  chart?: ReactNode;
  table: ReactNode;
  defaultMode?: FigureMode;
  right?: ReactNode;
}) {
  const [mode, setMode] = useFigureMode(id, chart ? defaultMode : "table");
  const effective: FigureMode = chart ? mode : "table";

  return (
    <section className="border-border bg-card rounded-md border">
      <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {note ? <span className="text-[11px] text-muted-foreground">{note}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          {right}
          {chart ? (
            <div className="border-border flex items-center rounded border p-0.5">
              <ModeButton
                active={effective === "chart"}
                onClick={() => setMode("chart")}
                label="Chart"
                icon={<BarChart3 className="size-3" />}
              />
              <ModeButton
                active={effective === "table"}
                onClick={() => setMode("table")}
                label="Table"
                icon={<Table2 className="size-3" />}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div>{effective === "chart" && chart ? chart : table}</div>

      <div className="border-border border-t px-4 py-2 text-[11px] leading-snug text-muted-foreground">
        {n} · {window} · {excluded}
      </div>
    </section>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
