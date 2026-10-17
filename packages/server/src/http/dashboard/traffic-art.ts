import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { shortDay } from "./chart.js";
import { COUNTRY_AT, LAND, WORLD_COLS, WORLD_ROWS } from "./world.js";

/**
 * Pixel art for the console's Traffic page (traffic-views.ts), drawn on the server as inline SVG
 * with crisp edges: a night skyline with one building per day (its lit windows are that day's
 * visitors), a dot-matrix world map with a glowing marker per visiting country, and small sprites.
 * Every animation is a CSS class (app-css.ts), so the CSP needs no inline styles, and each one
 * stops under reduced motion. Randomness (stars, roofs, which windows are lit) is seeded by the
 * date, so a page looks the same on every load.
 */

type H = HtmlEscapedString;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (v: number) => v.toLocaleString("en-US");

/** A small seeded random generator (mulberry32 over an FNV-1a hash of the seed). */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rectangles as one path ("M x y h w v h h -w z" each): one element for many pixels. */
const rects = (list: [number, number, number, number][]) =>
  list.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w}z`).join("");
const path = (cls: string, list: [number, number, number, number][]) =>
  list.length ? `<path class="${cls}" d="${rects(list)}"/>` : "";

// ---------------------------------------------------------------------------
// Skyline: one building per day

export interface SkyDay {
  day: string;
  visitors: number;
  pageviews: number;
}

const SKY_H = 112;
const GROUND = 100;
const MAX_BUILDING = 76;

/** Window grid per slot width: window size, step, margins. */
function windowGrid(slot: number) {
  if (slot >= 40) return { gap: 8, ww: 3, wh: 3, sx: 5, sy: 5, mx: 4, my: 5 };
  if (slot >= 20) return { gap: 4, ww: 2, wh: 2, sx: 4, sy: 4, mx: 3, my: 4 };
  return { gap: 2, ww: 1, wh: 2, sx: 2, sy: 3, mx: 1, my: 3 };
}

export function skyline(days: SkyDay[], unit: (v: number) => string): H {
  const count = Math.max(1, days.length);
  const slot = count <= 7 ? 44 : count <= 14 ? 22 : 10;
  const W = count * slot;
  const g = windowGrid(slot);
  const rnd = seeded(`sky:${days[0]?.day ?? ""}:${count}`);
  const peak = Math.max(0, ...days.map((d) => d.visitors));
  const peakAt = peak > 0 ? days.findIndex((d) => d.visitors === peak) : -1;
  const out: string[] = [];

  // Sky: dithered glow over the horizon, stars, a moon.
  out.push(
    `<defs><pattern id="sk-d1" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="1" height="1" class="sk-glow"/><rect x="2" y="2" width="1" height="1" class="sk-glow"/></pattern>` +
      `<pattern id="sk-d2" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1" class="sk-glow"/><rect x="1" y="1" width="1" height="1" class="sk-glow"/></pattern></defs>`,
    `<rect class="sk-sky" width="${W}" height="${SKY_H}"/>`,
    `<rect fill="url(#sk-d1)" y="52" width="${W}" height="22"/><rect fill="url(#sk-d2)" y="74" width="${W}" height="${GROUND - 74}"/>`,
  );
  const stars: [number, number, number, number][] = [];
  const twinkles: string[] = [];
  for (let i = 0; i < W / 7; i++) {
    const x = Math.floor(rnd() * W);
    const y = 2 + Math.floor(rnd() * 46);
    if (rnd() < 0.22)
      twinkles.push(`<rect class="sk-star tw tw${i % 3}" x="${x}" y="${y}" width="1" height="1"/>`);
    else stars.push([x, y, 1, 1]);
  }
  out.push(path("sk-star", stars), ...twinkles);
  const moon: [number, number, number, number][] = [];
  const mx = W - 30;
  for (let y = -5; y <= 5; y++)
    for (let x = -5; x <= 5; x++)
      if (x * x + y * y <= 26 && (x - 3) * (x - 3) + (y + 1) * (y + 1) > 18)
        moon.push([mx + x, 13 + y, 1, 1]);
  out.push(path("sk-moon", moon));

  // A blimp drifting across.
  out.push(
    `<g class="blimp" aria-hidden="true">${path("sk-blimp", [
      [-26, 20, 14, 1],
      [-28, 21, 18, 4],
      [-26, 25, 14, 1],
      [-10, 20, 2, 6],
    ])}${path("sk-stripe", [[-27, 23, 16, 1]])}${path("sk-gondola", [[-22, 26, 5, 2]])}<rect class="sk-tail blink" x="-9" y="22" width="1" height="1"/></g>`,
  );

  // Far skyline: dim filler behind the days.
  const far: [number, number, number, number][] = [];
  const farLit: [number, number, number, number][] = [];
  for (let x = -2; x < W; ) {
    const w = 5 + Math.floor(rnd() * 10);
    const h = 8 + Math.floor(rnd() * 20);
    far.push([x, GROUND - h, w, h]);
    for (let k = 0; k < w * h * 0.02; k++)
      farLit.push([
        x + 1 + Math.floor(rnd() * (w - 2)),
        GROUND - h + 2 + Math.floor(rnd() * (h - 3)),
        1,
        1,
      ]);
    x += w + Math.floor(rnd() * 3);
  }
  out.push(path("sk-far", far), path("sk-farlit", farLit));

  // Searchlights from the latest day's roof.
  const last = days.length - 1;

  days.forEach((d, i) => {
    const x0 = i * slot + g.gap / 2;
    const bw = slot - g.gap;
    const title = `<title>${esc(`${shortDay(d.day)}: ${unit(d.visitors)}, ${n(d.pageviews)} page view${d.pageviews === 1 ? "" : "s"}`)}</title>`;
    const parts: string[] = [];
    const r = seeded(`b:${d.day}`);
    if (d.visitors <= 0) {
      // An empty lot behind a fence.
      const fence: [number, number, number, number][] = [[x0, GROUND - 3, bw, 1]];
      for (let x = x0; x < x0 + bw; x += 2) fence.push([x, GROUND - 4, 1, 4]);
      parts.push(path("sk-fence", fence));
    } else {
      // Square-root heights: a launch-day spike should not flatten every other day.
      const rel = Math.sqrt(d.visitors / peak);
      const tall = 12 + Math.round(rel * (MAX_BUILDING - 12));
      const h = tall - ((tall - g.my) % g.sy);
      const top = GROUND - h;
      const tone = i % 3;
      parts.push(
        `<rect class="sk-body t${tone}" x="${x0}" y="${top}" width="${bw}" height="${h}"/>`,
        `<rect class="sk-edge" x="${x0}" y="${top}" width="1" height="${h}"/>`,
      );
      const cols = Math.max(1, Math.floor((bw - 2 * g.mx + (g.sx - g.ww)) / g.sx));
      const rows = Math.max(1, Math.floor((h - g.my - 2) / g.sy));
      const left = x0 + Math.floor((bw - (cols * g.sx - (g.sx - g.ww))) / 2);
      const spots: [number, number][] = [];
      for (let ry = 0; ry < rows; ry++)
        for (let cx = 0; cx < cols; cx++) spots.push([left + cx * g.sx, top + g.my + ry * g.sy]);
      const lit = Math.min(
        spots.length,
        Math.max(1, Math.round(spots.length * (0.12 + 0.8 * rel))),
      );
      for (let k = spots.length - 1; k > 0; k--) {
        const j = Math.floor(r() * (k + 1));
        [spots[k], spots[j]] = [spots[j]!, spots[k]!];
      }
      const dark: [number, number, number, number][] = [];
      const warm: [number, number, number, number][] = [];
      const gold: [number, number, number, number][] = [];
      const tv: [number, number, number, number][] = [];
      const blinks: string[] = [];
      for (const [k, [x, y]] of spots.entries()) {
        const cell: [number, number, number, number] = [x, y, g.ww, g.wh];
        if (k >= lit) {
          dark.push(cell);
          continue;
        }
        const roll = r();
        if (roll < 0.08)
          blinks.push(
            `<rect class="sk-win w1 tw tw${k % 3}" x="${x}" y="${y}" width="${g.ww}" height="${g.wh}"/>`,
          );
        else if (roll < 0.2) tv.push(cell);
        else if (roll < 0.45) gold.push(cell);
        else warm.push(cell);
      }
      parts.push(
        path("sk-win w0", dark),
        path("sk-win w1", warm),
        path("sk-win w2", gold),
        path("sk-win w3", tv),
        ...blinks,
      );
      // Roof: an antenna, a water tank or a step.
      const cx = x0 + Math.floor(bw / 2);
      const kind = i === last ? 0 : Math.floor(r() * 3);
      if (kind === 0) {
        const ah = 4 + Math.floor(r() * 5);
        parts.push(
          path("sk-body t0", [[cx, top - ah, 1, ah]]),
          `<rect class="sk-beacon${i === last ? " beacon" : " blink"}" x="${cx}" y="${top - ah - 1}" width="1" height="1"/>`,
        );
        if (i === last && slot >= 20)
          parts.push(
            `<polygon class="sk-beam bm0" points="${cx},${top - ah} ${cx - 9},${top - ah - 60} ${cx + 10},${top - ah - 60}"/>`,
            `<polygon class="sk-beam bm1" points="${cx},${top - ah} ${cx - 9},${top - ah - 60} ${cx + 10},${top - ah - 60}"/>`,
          );
      } else if (kind === 1 && bw >= 8) {
        const tx = x0 + 2 + Math.floor(r() * Math.max(1, bw - 8));
        parts.push(
          path("sk-body t1", [
            [tx, top - 5, 5, 3],
            [tx + 1, top - 2, 1, 2],
            [tx + 3, top - 2, 1, 2],
          ]),
        );
      } else if (bw >= 8) {
        const sw = Math.max(3, Math.floor(bw * 0.55));
        const sh = 3 + Math.floor(r() * 5);
        parts.push(
          path(`sk-body t${(tone + 1) % 3}`, [[x0 + Math.floor((bw - sw) / 2), top - sh, sw, sh]]),
        );
      }
      if (i === peakAt)
        parts.push(
          `<g class="sk-crown bob">${path("sk-gold", [
            [cx - 3, top - 18, 1, 3],
            [cx - 1, top - 19, 1, 4],
            [cx + 1, top - 18, 1, 3],
            [cx - 3, top - 15, 5, 2],
          ])}</g>`,
        );
    }
    parts.push(`<rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${SKY_H}"/>`);
    out.push(`<g class="bld${i === last ? " today" : ""}">${title}${parts.join("")}</g>`);
  });

  // The street: kerb, lane marks, lamps and two cars.
  const lanes: [number, number, number, number][] = [];
  for (let x = 2; x < W; x += 10) lanes.push([x, GROUND + 6, 4, 1]);
  const lamps: [number, number, number, number][] = [];
  const lampLights: [number, number, number, number][] = [];
  for (let x = 18; x < W; x += 64) {
    lamps.push([x, GROUND - 9, 1, 9], [x, GROUND - 9, 3, 1]);
    lampLights.push([x + 2, GROUND - 8, 2, 1]);
  }
  out.push(
    `<rect class="sk-street" y="${GROUND}" width="${W}" height="${SKY_H - GROUND}"/>`,
    path("sk-kerb", [[0, GROUND, W, 1]]),
    path("sk-lane", lanes),
    path("sk-lamp", lamps),
    path("sk-lamplight", lampLights),
    `<g class="car c0">${path("sk-car", [
      [0, GROUND + 2, 8, 2],
      [2, GROUND + 1, 4, 1],
    ])}${path("sk-head", [[8, GROUND + 2, 1, 1]])}</g>`,
    `<g class="car c1">${path("sk-car2", [
      [0, GROUND + 8, 8, 2],
      [2, GROUND + 7, 4, 1],
    ])}${path("sk-head", [[8, GROUND + 9, 1, 1]])}</g>`,
  );

  const total = days.reduce((s, d) => s + d.visitors, 0);
  const label = `Visitors per day as a skyline, one building per day from ${shortDay(days[0]?.day ?? "")} to ${shortDay(days.at(-1)?.day ?? "")}: ${n(total)} in total${peak ? `, most on ${shortDay(days[peakAt]!.day)} (${n(peak)})` : ""}.`;
  return raw(
    `<svg class="skyline n${count}" viewBox="0 0 ${W} ${SKY_H}" preserveAspectRatio="xMidYMax meet" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}">${out.join("")}</svg>`,
  ) as H;
}

// ---------------------------------------------------------------------------
// World map

/** Land as one path of horizontal runs, filled with a dot pattern. */
const LAND_PATH = (() => {
  const runs: [number, number, number, number][] = [];
  LAND.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let end = x;
      while (row[end] === "#") end++;
      runs.push([x, y, end - x, 1]);
      x = end;
    }
  });
  return rects(runs);
})();

let regionNames: Intl.DisplayNames | null = null;
/** A country's English name from its ISO code ("DE" -> "Germany"), else the code. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Marker tier 1..4 for a count against the busiest country (by orders of magnitude). */
const tier = (v: number, max: number) =>
  Math.max(1, Math.min(4, 1 + Math.round((3 * Math.log1p(v)) / Math.log1p(Math.max(1, max)))));

export function worldMap(countries: { name: string; count: number }[]): H {
  const max = Math.max(0, ...countries.map((c) => c.count));
  const known = countries.filter((c) => c.count > 0 && COUNTRY_AT[c.name]);
  // Smallest last, so the busiest markers sit on top.
  const markers = known
    .slice()
    .sort((a, b) => a.count - b.count)
    .map((c, i) => {
      const [cx, cy] = COUNTRY_AT[c.name]!;
      const t = tier(c.count, max);
      const x = Math.floor(cx);
      const y = Math.floor(cy);
      const title = `<title>${esc(`${countryName(c.name)}: ${n(c.count)} visitor${c.count === 1 ? "" : "s"}`)}</title>`;
      const ring =
        t >= 3
          ? `<rect class="ping p${i % 3}" x="${x - 1}" y="${y - 1}" width="3" height="3"/>`
          : "";
      const size = t >= 4 ? 2 : 1;
      const off = size === 2 ? 0.5 : 0;
      return `<g class="mk m${t}">${title}${ring}<rect class="mk-dot" x="${x - off}" y="${y - off}" width="${size}" height="${size}"/><rect class="hit" x="${x - 1.5}" y="${y - 1.5}" width="4" height="4"/></g>`;
    });
  const label = known.length
    ? `World map of visitors: ${known
        .slice(0, 5)
        .map((c) => `${countryName(c.name)} ${n(c.count)}`)
        .join(", ")}${known.length > 5 ? `, and ${known.length - 5} more countries` : ""}.`
    : "World map: no visitors located yet.";
  return raw(
    `<svg class="worldmap" viewBox="0 0 ${WORLD_COLS} ${WORLD_ROWS}" role="img" aria-label="${esc(label)}">` +
      `<defs><pattern id="wm-dot" width="1" height="1" patternUnits="userSpaceOnUse"><rect class="wm-land" x=".18" y=".18" width=".64" height=".64"/></pattern></defs>` +
      `<path d="${LAND_PATH}" fill="url(#wm-dot)"/>` +
      `<g class="sweep"><rect x="-6" y="0" width="6" height="${WORLD_ROWS}" fill="url(#wm-sweep)"/><rect class="sweep-line" x="-.4" y="0" width=".4" height="${WORLD_ROWS}"/></g>` +
      markers.join("") +
      `</svg>`,
  ) as H;
}

/**
 * The globe view of the same map: a canvas that app.js draws as a spinning pixel sphere from the
 * land cells (one string, row by row from the north) and the visiting countries ([name, visitors,
 * longitude, latitude, marker tier], busiest first). Without JavaScript it stays hidden.
 */
export function globeFrame(countries: { name: string; count: number }[]): H {
  const max = Math.max(0, ...countries.map((c) => c.count));
  const points = countries
    .filter((c) => c.count > 0 && COUNTRY_AT[c.name])
    .sort((a, b) => b.count - a.count)
    .map((c) => {
      const [x, y] = COUNTRY_AT[c.name]!;
      return [
        countryName(c.name),
        c.count,
        +(x * 3 - 180).toFixed(1),
        +(84 - y * 3).toFixed(1),
        tier(c.count, max),
      ];
    });
  const label = points.length
    ? `Globe of visitors: ${points
        .slice(0, 5)
        .map((p) => `${p[0]} ${n(p[1] as number)}`)
        .join(", ")}. Drag or use the arrow keys to turn it.`
    : "Globe: no visitors located yet. Drag or use the arrow keys to turn it.";
  return raw(
    `<div class="globe-frame" data-view-pane="globe" hidden>` +
      `<canvas class="globe" width="240" height="240" tabindex="0" role="img" aria-label="${esc(label)}" data-cols="${WORLD_COLS}" data-land="${LAND.join("")}" data-points="${esc(JSON.stringify(points))}"></canvas>` +
      `<span class="globe-tip" hidden></span><p class="globe-hint">Drag to spin. Arrow keys work too.</p></div>`,
  ) as H;
}

// ---------------------------------------------------------------------------
// Sprites: 16-pixel icons drawn as path runs, coloured by CSS

/** A sprite from rows of characters: each letter is a class (a..d), "." is empty. */
function sprite(rows: string[], cls: string, label?: string): H {
  const byKey = new Map<string, [number, number, number, number][]>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const k = row[x]!;
      if (k === ".") {
        x++;
        continue;
      }
      let end = x;
      while (row[end] === k) end++;
      const list = byKey.get(k) ?? [];
      list.push([x, y, end - x, 1]);
      byKey.set(k, list);
      x = end;
    }
  });
  const w = Math.max(...rows.map((r) => r.length));
  const body = [...byKey].map(([k, list]) => path(`px-${k}`, list)).join("");
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true"`;
  return raw(
    `<svg class="sprite ${cls}" viewBox="0 0 ${w} ${rows.length}" shape-rendering="crispEdges" ${a11y}>${body}</svg>`,
  ) as H;
}

const SPRITES: Record<string, string[]> = {
  desktop: [
    "................",
    ".aaaaaaaaaaaaaa.",
    ".abbbbbbbbbbbba.",
    ".abccbbbbbbbbba.",
    ".abcbbbbbbbbbba.",
    ".abbbbbbbbbbbba.",
    ".abbbbbbbbbbbba.",
    ".abbbbbbbbbbbba.",
    ".abbbbbbbbbbbba.",
    ".aaaaaaaaaaaaaa.",
    "......aaaa......",
    "......aaaa......",
    "....aaaaaaaa....",
    "................",
  ],
  laptop: [
    "................",
    "................",
    "..aaaaaaaaaaaa..",
    "..abbbbbbbbbba..",
    "..abccbbbbbbba..",
    "..abcbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..aaaaaaaaaaaa..",
    ".aaaaaaaaaaaaaa.",
    "aaaaaaadaaaaaaaa",
    "................",
    "................",
    "................",
  ],
  mobile: [
    ".....aaaaaa.....",
    ".....abbbba.....",
    ".....abccba.....",
    ".....abcbba.....",
    ".....abbbba.....",
    ".....abbbba.....",
    ".....abbbba.....",
    ".....abbbba.....",
    ".....abbbba.....",
    ".....abbbba.....",
    ".....aaddaa.....",
    ".....aaaaaa.....",
    "................",
    "................",
  ],
  tablet: [
    "................",
    "..aaaaaaaaaaaa..",
    "..abbbbbbbbbba..",
    "..abccbbbbbbba..",
    "..abcbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..aaaaaddaaaaa..",
    "..aaaaaaaaaaaa..",
    "................",
    "................",
  ],
  trophy: [
    "...aaaaaaaa...",
    ".aaabbbbbbaaa.",
    "a..abbbbbba..a",
    "a..abbbbbba..a",
    ".a.abbbbbba.a.",
    "..aabbbbbbaa..",
    "....abbbba....",
    ".....abba.....",
    "......aa......",
    "......aa......",
    "....aaaaaa....",
    "...aaaaaaaa...",
  ],
  lock: [
    "..............",
    ".....aaaa.....",
    "....a....a....",
    "...a......a...",
    "...a......a...",
    "..bbbbbbbbbb..",
    "..bbbbbbbbbb..",
    "..bbbbccbbbb..",
    "..bbbbccbbbb..",
    "..bbbbbbbbbb..",
    "..bbbbbbbbbb..",
    "..............",
  ],
  coin: [
    "...aaaa...",
    ".aabbbbaa.",
    ".abbccbba.",
    "abbcbbbbba",
    "abbcbbbbba",
    "abbcbbbbba",
    "abbcbbbbba",
    ".abbccbba.",
    ".aabbbbaa.",
    "...aaaa...",
  ],
  coinEdge: [
    "....aa....",
    "...abba...",
    "...abba...",
    "...abba...",
    "...abba...",
    "...abba...",
    "...abba...",
    "...abba...",
    "...abba...",
    "....aa....",
  ],
  miner: [
    "....aaaa......",
    "...aaaaaa.....",
    "...abbbba.....",
    "...bcbcbb.....",
    "...bbbbbb..d..",
    "....bbbb..d.d.",
    "..eeeeeeeed...",
    ".eeeeeeeeee...",
    ".beeeeeeeeb...",
    "...eeeeeee....",
    "...ff..ff.....",
    "..fff..fff....",
  ],
  pipe: ["aaaaaa", "abbbba", "abbbba", "abbbba"],
};

const DEVICE_KEYS = new Set(["desktop", "laptop", "mobile", "tablet"]);

/** A device sprite (desktop, laptop, mobile, tablet); others use the desktop. */
export const deviceSprite = (device: string): H =>
  sprite(SPRITES[DEVICE_KEYS.has(device) ? device : "desktop"]!, `dev dev-${device}`);
export const trophySprite = (): H => sprite(SPRITES.trophy!, "trophy");
export const lockSprite = (): H => sprite(SPRITES.lock!, "lock");
export const minerSprite = (): H => sprite(SPRITES.miner!, "miner");
/** A coin that spins: two frames swapped by CSS. */
export const coinSprite = (): H =>
  raw(
    `<span class="coin" aria-hidden="true">${sprite(SPRITES.coin!, "cf0")}${sprite(SPRITES.coinEdge!, "cf1")}</span>`,
  ) as H;

/** 8-pixel channel icons: door, bubble, lens, link, robot, envelope, play, coin, megaphone. */
const CHANNEL_ICONS: Record<string, string[]> = {
  direct: [
    "aaaaaaa.",
    "abbbbba.",
    "abbbbba.",
    "abbbbca.",
    "abbbbba.",
    "abbbbba.",
    "abbbbba.",
    "aaaaaaa.",
  ],
  social: [
    ".aaaaaa.",
    "abbbbbba",
    "abcbcbba",
    "abbbbbba",
    ".aaaaaa.",
    "..aa....",
    ".a......",
    "........",
  ],
  search: [
    ".aaaa...",
    "a....a..",
    "a....a..",
    "a....a..",
    ".aaaaa..",
    ".....aa.",
    "......aa",
    ".......a",
  ],
  referral: [
    "........",
    ".aa..aa.",
    "a..aa..a",
    "a..aa..a",
    ".aa..aa.",
    "........",
    "........",
    "........",
  ],
  llm: [
    "...aa...",
    ".aaaaaa.",
    "abbbbbba",
    "abcbbcba",
    "abbbbbba",
    "abbccbba",
    ".aaaaaa.",
    ".a....a.",
  ],
  email: [
    "aaaaaaaa",
    "aa....aa",
    "a.a..a.a",
    "a..aa..a",
    "a......a",
    "a......a",
    "aaaaaaaa",
    "........",
  ],
  video: [
    "aaaaaaaa",
    "a......a",
    "a.bb...a",
    "a.bbbb.a",
    "a.bb...a",
    "a......a",
    "aaaaaaaa",
    "........",
  ],
  paid: [
    "..aaaa..",
    ".abbbba.",
    "abbccbba",
    "abcbbbba",
    "abbccbba",
    ".abbbba.",
    "..aaaa..",
    "........",
  ],
  other: [
    "..aaaa..",
    ".a....a.",
    ".....a..",
    "....a...",
    "....a...",
    "........",
    "....a...",
    "........",
  ],
};

export function channelKind(channel: string): string {
  const c = channel.toLowerCase();
  if (c === "direct") return "direct";
  if (c.includes("social")) return "social";
  if (c.includes("search")) return "search";
  if (c === "referral" || c === "affiliate") return "referral";
  if (c === "llm") return "llm";
  if (c === "email" || c === "sms") return "email";
  if (c.includes("video")) return "video";
  if (c.includes("paid") || c.includes("shopping")) return "paid";
  return "other";
}

export const channelSprite = (channel: string): H => {
  const kind = channelKind(channel);
  return sprite(CHANNEL_ICONS[kind]!, `chan chan-${kind}`);
};
