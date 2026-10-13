import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/**
 * Daily column charts as inline SVG, rendered on the server (no JavaScript).
 *
 * The SVG has no viewBox: x positions and widths are percentages of its width
 * and y positions are pixels, so the chart stretches to any column width while
 * the text keeps its size (it reads the same at 390px and at 1100px). Bars are
 * square, drawn with crispEdges and cut by a 4px "LED" slit pattern, in the
 * style of the public site. One series per chart; two measures get two charts,
 * never two axes. Every day has a full-height hover target carrying a native
 * tooltip.
 */

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface ChartSpec {
  /** Chart title, e.g. "Messages". */
  title: string;
  /** UTC days, oldest first (YYYY-MM-DD). */
  days: string[];
  values: number[];
  /** Tooltip unit: [singular, plural]. */
  unit: [string, string];
  /** Colour token of the bars. */
  tone: "amber" | "sky" | "mint";
  /** Formats axis ticks, totals and tooltips (default: thousands separators). */
  format?: (n: number) => string;
  /** Short note under the title. */
  note?: string;
  /** What the headline total is called (default "last 30 days"). */
  totalLabel?: string;
}

const HEIGHT = 180;
const TOP = 20;
const BOTTOM = 28;
/** A multiple of 4, so the slit pattern lines up with the baseline. */
const PLOT = HEIGHT - TOP - BOTTOM;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const shortDay = (d: string) =>
  `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** A round ceiling for the axis: 1, 2, 2.5 or 5 times a power of ten. */
export function niceCeil(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}

const pct = (v: number) => `${v.toFixed(3)}%`;
/** An id for the slit pattern, unique per chart on a page (charts have different titles). */
const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function dayChart(spec: ChartSpec): H {
  const fmt = spec.format ?? ((n: number) => n.toLocaleString("en-US"));
  const n = spec.days.length;
  const total = spec.values.reduce((a, b) => a + b, 0);
  const top = niceCeil(Math.max(...spec.values, 0));
  const slot = 100 / Math.max(1, n);
  const barW = slot * 0.58;
  const y = (v: number) => TOP + PLOT - (v / top) * PLOT;
  const base = TOP + PLOT;
  /** 1px lines sit on a pixel row: whole number plus half. */
  const line = (v: number) => Math.round(y(v)) + 0.5;
  const labelAt = new Set([0, Math.round((n - 1) / 2), n - 1]);
  const peak = Math.max(...spec.values, 0);
  const label = `${spec.title} per day, ${shortDay(spec.days[0] ?? "")} to ${shortDay(spec.days[n - 1] ?? "")}: ${fmt(total)} in total`;
  const slits = `slits-${slug(spec.title)}`;
  return html`<figure class="chart tone-${spec.tone}">
  <figcaption>
    <span class="chart-title">${spec.title}</span>
    <span class="chart-total">${fmt(total)}</span>
    <span class="chart-note">${spec.totalLabel ?? "last 30 days"}${spec.note ? html` · ${spec.note}` : ""}</span>
  </figcaption>
  <svg width="100%" height="${HEIGHT}" role="img" aria-label="${label}" class="chart-svg" shape-rendering="crispEdges">
    <defs><pattern id="${slits}" width="4" height="4" patternUnits="userSpaceOnUse"><rect class="slit" width="4" height="1" /></pattern></defs>
    ${
      total > 0
        ? html`<line class="grid" x1="0" x2="100%" y1="${line(top)}" y2="${line(top)}" /><line class="grid" x1="0" x2="100%" y1="${line(top / 2)}" y2="${line(top / 2)}" />`
        : ""
    }
    <line class="axis" x1="0" x2="100%" y1="${base + 1}" y2="${base + 1}" />
    ${spec.values.map((v, i) => {
      const h = v > 0 ? Math.max(2, Math.round((v / top) * PLOT)) : 0;
      const x = i * slot + (slot - barW) / 2;
      const tip = `${shortDay(spec.days[i]!)} · ${fmt(v)} ${v === 1 ? spec.unit[0] : spec.unit[1]}`;
      return html`<g class="day${v === peak && v > 0 ? " peak" : ""}${i === n - 1 ? " today" : ""}"><title>${tip}</title><rect class="hit" x="${pct(i * slot)}" y="${TOP - 8}" width="${pct(slot)}" height="${PLOT + 8}" />${
        h > 0
          ? html`<rect class="bar" x="${pct(x)}" y="${base - h}" width="${pct(barW)}" height="${h}" />`
          : ""
      }</g>`;
    })}
    <rect class="slits" x="0" y="${TOP}" width="100%" height="${PLOT}" fill="url(#${slits})" pointer-events="none" />
    ${
      total === 0
        ? html`<text class="empty-note" x="50%" y="${TOP + PLOT / 2}" text-anchor="middle">No ${spec.unit[1]} in this period</text>`
        : html`<text class="tick" x="0" y="${Math.round(y(top)) - 6}">${fmt(top)}</text>${
            spec.format || Number.isInteger(top / 2)
              ? html`<text class="tick" x="0" y="${Math.round(y(top / 2)) - 6}">${fmt(top / 2)}</text>`
              : ""
          }`
    }
    ${[...labelAt].map((i) => {
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      const x = i === 0 ? 0 : i === n - 1 ? 100 : (i + 0.5) * slot;
      return html`<text class="tick day-label" x="${pct(x)}" y="${HEIGHT - 8}" text-anchor="${anchor}">${i === n - 1 ? "Today" : shortDay(spec.days[i]!)}</text>`;
    })}
  </svg>
</figure>`;
}
