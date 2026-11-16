/**
 * Structural counts — the length of an array we are holding, or the number of
 * rows a sync just wrote. These are not measurements of the business, so they
 * carry no metric state and are allowed outside <MetricValue>.
 *
 * If a number describes spend, leads, sales, attendance or any other thing the
 * database might not know, it is a Metric, not a count. Use `fromNullable()`.
 */
export function count(n: number): string {
  return new Intl.NumberFormat("en-IN").format(Math.round(n));
}

/**
 * Money inside explanatory prose, where the figure has ALREADY passed through a
 * Metric and been found non-null — e.g. "₹4,20,000 of ₹9,10,000 is excluded".
 * Never use it to print a headline figure; that is <MetricValue>'s job.
 */
export function inrText(n: number): string {
  return `\u20b9${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;
}
