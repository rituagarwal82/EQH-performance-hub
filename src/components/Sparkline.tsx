import { renderMetric, type MetricFormat } from "@/components/MetricValue";

/**
 * Fourteen points, direct-labelled at both ends. No axis, no tooltip, no
 * hover-only truth — the two numbers that bound the line are printed.
 * A missing day breaks the line rather than being drawn through.
 */
export function Sparkline({
  points,
  format,
  bandLow,
  bandHigh,
  width = 260,
  height = 40,
}: {
  points: { date: string; value: number | null }[];
  format: MetricFormat;
  bandLow?: number | null;
  bandHigh?: number | null;
  width?: number;
  height?: number;
}) {
  const present = points.filter((p) => p.value !== null) as { date: string; value: number }[];
  if (present.length < 2) {
    return <div className="text-[11px] text-muted-foreground">not enough days to draw</div>;
  }

  const values = present.map((p) => p.value);
  const lows = [Math.min(...values), ...(typeof bandLow === "number" ? [bandLow] : [])];
  const highs = [Math.max(...values), ...(typeof bandHigh === "number" ? [bandHigh] : [])];
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min || 1;

  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / span) * height;

  // Break the path wherever a day is missing.
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    // Path coordinates, not a metric — rounded for a compact `d` attribute.
    const px = Math.round(x(i) * 10) / 10;
    const py = Math.round(y(p.value) * 10) / 10;
    current.push(`${current.length === 0 ? "M" : "L"}${px},${py}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  const first = present[0]!;
  const last = present[present.length - 1]!;
  const bandTop = typeof bandHigh === "number" ? y(bandHigh) : null;
  const bandBottom = typeof bandLow === "number" ? y(bandLow) : null;

  return (
    <div className="flex items-center gap-2">
      <span className="nums shrink-0 text-[10px] text-muted-foreground">
        {renderMetric(first.value, format)}
      </span>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="shrink-0 overflow-visible"
        role="img"
        aria-label={`${points.length} day trend, from ${renderMetric(first.value, format)} to ${renderMetric(last.value, format)}`}
      >
        {bandTop !== null && bandBottom !== null ? (
          <rect
            x={0}
            y={Math.min(bandTop, bandBottom)}
            width={width}
            height={Math.abs(bandBottom - bandTop)}
            className="fill-muted-foreground/12"
          />
        ) : null}
        {segments.map((d) => (
          <path
            key={d.slice(0, 24)}
            d={d}
            fill="none"
            className="stroke-foreground"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ))}
        <circle cx={x(points.length - 1)} cy={y(last.value)} r={2.5} className="fill-foreground" />
      </svg>
      <span className="nums shrink-0 text-[10px] font-semibold">
        {renderMetric(last.value, format)}
      </span>
    </div>
  );
}
