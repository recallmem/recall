#!/usr/bin/env node
// Builds src/http/dashboard/world.ts: the console Traffic page's pixel world map. Land is a
// 120 x 48 grid of 3-degree cells (equirectangular, 84N to 60S, so no Antarctica), a cell being
// land when at least 3 of 16 sample points in it are; each country is placed at the area centroid
// of its largest polygon, in grid units. Sources (downloaded, not committed): Natural Earth land
// and countries (public domain) as packaged by world-atlas 2.0.2 (ISC), and the ISO 3166 numeric
// to alpha-2 table of i18n-iso-countries 7.14.0 (MIT).
//
//   node scripts/site/world.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../src/http/dashboard/world.ts");
const CDN = "https://cdn.jsdelivr.net/npm";
const COLS = 120;
const ROWS = 48;
const LAT0 = 84;
const DEG = 3;
const SAMPLES = 4;

const load = async (path) => {
  const res = await fetch(`${CDN}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const [land, countries, codes] = await Promise.all([
  load("world-atlas@2.0.2/land-110m.json"),
  load("world-atlas@2.0.2/countries-50m.json"),
  load("i18n-iso-countries@7.14.0/codes.json"),
]);

/** TopoJSON geometry to polygons (lists of rings of [lon, lat]). */
function decoder(topo) {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  const ring = (ids) => {
    const pts = [];
    for (const i of ids) {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      pts.push(...(pts.length ? a.slice(1) : a));
    }
    return unwrap(pts);
  };
  return (g) =>
    g.type === "Polygon"
      ? [g.arcs.map(ring)]
      : g.type === "MultiPolygon"
        ? g.arcs.map((p) => p.map(ring))
        : [];
}

/** A ring crossing the antimeridian jumps ~360 degrees between points: walk it into one piece. */
function unwrap(r) {
  let off = 0;
  return r.map(([x, y], i) => {
    if (i) {
      const d = x + off - (r[i - 1][0] + prevOff);
      if (d > 180) off -= 360;
      else if (d < -180) off += 360;
    }
    prevOff = off;
    return [x + off, y];
  });
}
let prevOff = 0;

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (x, y, p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h));
const bounds = (r) =>
  r.reduce(
    (a, [x, y]) => [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );

// ---- land
const polys = land.objects.land.geometries.flatMap(decoder(land));
const boxes = polys.map((p) => bounds(p[0]));
const isLand = (lon, lat) =>
  [lon - 360, lon, lon + 360].some((x) =>
    polys.some(
      (p, k) =>
        x >= boxes[k][0] &&
        x <= boxes[k][2] &&
        lat >= boxes[k][1] &&
        lat <= boxes[k][3] &&
        inPolygon(x, lat, p),
    ),
  );
const rows = [];
for (let r = 0; r < ROWS; r++) {
  let line = "";
  for (let c = 0; c < COLS; c++) {
    let hits = 0;
    for (let i = 0; i < SAMPLES; i++)
      for (let j = 0; j < SAMPLES; j++)
        if (isLand(-180 + (c + (i + 0.5) / SAMPLES) * DEG, LAT0 - (r + (j + 0.5) / SAMPLES) * DEG))
          hits++;
    line += hits >= 3 ? "#" : ".";
  }
  rows.push(line);
}

// ---- country centroids
const area = (r) => {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return s / 2;
};
const centroid = (r) => {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f;
    cx += (r[j][0] + r[i][0]) * f;
    cy += (r[j][1] + r[i][1]) * f;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : r[0];
};
const alpha2 = new Map(codes.map(([a2, , num]) => [num, a2]));
const decodeCountry = decoder(countries);
const placed = new Map();
for (const g of countries.objects.countries.geometries) {
  const code = alpha2.get(String(g.id).padStart(3, "0"));
  if (!code) continue;
  const outer = decodeCountry(g).map((p) => p[0]);
  if (!outer.length) continue;
  // Several Natural Earth shapes can share a code (Australia and its Ashmore Reef): the largest wins.
  const big = outer.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))[0];
  if ((placed.get(code)?.area ?? 0) > Math.abs(area(big))) continue;
  let [lon, lat] = centroid(big);
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  placed.set(code, {
    area: Math.abs(area(big)),
    at: [+((lon + 180) / DEG).toFixed(1), +((LAT0 - lat) / DEG).toFixed(1)],
  });
}
// Kosovo has no ISO numeric code in Natural Earth; Umami reports it as XK.
placed.set("XK", {
  area: 0,
  at: [+((21 + 180) / DEG).toFixed(1), +((LAT0 - 42.6) / DEG).toFixed(1)],
});

const entries = [...placed]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, { at }]) => `${code}:[${at[0]},${at[1]}]`);
const lines = [];
for (let i = 0; i < entries.length; i += 8) lines.push(`  ${entries.slice(i, i + 8).join(",")},`);

writeFileSync(
  OUT,
  `// Generated by scripts/site/world.mjs from Natural Earth (public domain); do not edit.

/** Map size in cells: 3 degrees each, 180W to 180E and 84N to 60S. */
export const WORLD_COLS = ${COLS};
export const WORLD_ROWS = ${ROWS};

/** Land cells, one string per row from the north: "#" land, "." sea. */
export const LAND: readonly string[] = [
${rows.map((r) => `  "${r}",`).join("\n")}
];

/** Where each country sits on the map ([column, row], in cells), by ISO 3166 alpha-2 code. */
export const COUNTRY_AT: Readonly<Record<string, readonly [number, number]>> = {
${lines.join("\n")}
};
`,
);
console.log(`wrote ${OUT}: ${rows.length} rows, ${placed.size} countries`);
