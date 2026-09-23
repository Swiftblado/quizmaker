// Builds geo.json, the world the Geography tab searches and draws, from
// Natural Earth (public domain, naturalearthdata.com).
//
// The raw GeoJSON runs to about 20 MB and carries far more detail and far
// more properties than a map the width of a phone can use, so this keeps a
// name, a kind and a simplified outline for each feature and writes one
// file. It is run by hand, not by build.js -- the output is committed, so a
// build never needs the network:
//
//   node scripts/geo-data.js <folder holding the ne_*.geojson files>
//
// The files it reads are the ne_*.geojson names passed to read() below;
// fetch them from
// https://github.com/nvkelso/natural-earth-vector/tree/master/geojson

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2];
if (!SRC) { console.error("usage: node scripts/geo-data.js <ne folder>"); process.exit(1); }

const read = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f + ".geojson"), "utf8")).features;

// Coordinates are stored as whole hundredths of a degree -- about 1 km, far
// finer than a pixel on any map this draws -- and each ring as a start point
// followed by deltas, which keeps most numbers to one or two digits.
const Q = 100;

/* ------------------------------------------------------ simplification */

function sqSegDist(p, a, b) {
  let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]], sq = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0, at = -1;
    for (let i = s + 1; i < e; i++) {
      const d = sqSegDist(pts[i], pts[s], pts[e]);
      if (d > max) { max = d; at = i; }
    }
    if (max > sq) { keep[at] = 1; stack.push([s, at], [at, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

// Rounded to the grid and with any point that lands on top of the last one
// dropped. A third value rides along on each point: 1 where the outline is
// shared with another territory, 0 where it is coast. Quantising and
// encoding are split so that the flags stay lined up with the points that
// actually survive.
function quantise(pts) {
  const out = [];
  let px = null, py = null;
  for (const p of pts) {
    const x = Math.round(p[0] * Q), y = Math.round(p[1] * Q);
    if (px !== null && x === px && y === py) continue;
    out.push([x, y, p[2] || 0]);
    px = x; py = y;
  }
  return out;
}

function encodeQ(q) {
  const out = [];
  let px = 0, py = 0;
  for (const p of q) { out.push(p[0] - px, p[1] - py); px = p[0]; py = p[1]; }
  return out;
}

function encode(pts) { return encodeQ(quantise(pts)); }

// The flags as run lengths, starting with a run of shared points -- which
// is 0 long when the ring starts on a coast.
function runsOf(q) {
  const runs = [];
  let want = 1, n = 0;
  for (const p of q) {
    if ((p[2] ? 1 : 0) === want) { n++; continue; }
    runs.push(n);
    want = 1 - want;
    n = 1;
  }
  runs.push(n);
  return runs;
}

// Outer rings only: a hole in a desert or a sea is not something anyone is
// asked to click, and filling it keeps the shape one path.
function ringsOf(geom, tol, minArea) {
  const list = geom.type === "Polygon" ? [geom.coordinates]
    : geom.type === "MultiPolygon" ? geom.coordinates : [];
  let rings = list.map((p) => douglasPeucker(p[0], tol)).filter((r) => r.length >= 4);
  rings.sort((a, b) => ringArea(b) - ringArea(a));
  // Specks are dropped, but never the last ring: a small island nation is
  // still a country.
  rings = rings.filter((r, i) => i === 0 || ringArea(r) >= minArea);
  return rings.map(quantise).filter((q) => q.length >= 3);
}

function polys(geom, tol, minArea) {
  return ringsOf(geom, tol, minArea).map(encodeQ);
}

// The same, with the shared/coast runs beside each ring.
function polysFlagged(geom, tol, minArea) {
  const rings = ringsOf(geom, tol, minArea);
  return { g: rings.map(encodeQ), b: rings.map(runsOf) };
}

function lines(geom, tol) {
  const list = geom.type === "LineString" ? [geom.coordinates]
    : geom.type === "MultiLineString" ? geom.coordinates : [];
  return list.map((l) => encode(douglasPeucker(l, tol))).filter((l) => l.length >= 4);
}

/* ------------------------------------------------------------ features */

const out = [];
const tidy = (s) => String(s || "").replace(/\s+/g, " ").trim();
// Natural Earth names some features in capitals ("SAHARA") for labelling.
const title = (s) => /[a-z]/.test(s) ? s
  : s.toLowerCase().replace(/(^|[\s\-(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

function add(name, kind, shape, g, extra) {
  name = title(tidy(name));
  if (!name || !g || (Array.isArray(g) && !g.length)) return;
  out.push(Object.assign({ n: name, k: kind, s: shape, g }, extra || {}));
}

function alts(...names) {
  const seen = new Set();
  return names.map(tidy).filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

/* Which stretches of an outline are a border with another territory, and
   which are coast. Natural Earth cuts neighbours from the same geometry, so
   a point that belongs to two countries is a border and a point that
   belongs to one is a coast. Provinces are counted in a band of their own,
   or every coastal point would be shared -- once by the province and once
   by the country it is part of. */
const owners = new Map();
const ownerKey = (lon, lat) => lon.toFixed(5) + "," + lat.toFixed(5);

function claim(geom, who, band) {
  const list = geom.type === "Polygon" ? [geom.coordinates]
    : geom.type === "MultiPolygon" ? geom.coordinates : [];
  list.forEach((poly) => poly.forEach((ring) => ring.forEach((p) => {
    const k = ownerKey(p[0], p[1]);
    let e = owners.get(k);
    if (!e) { e = { c: new Set(), p: new Set() }; owners.set(k, e); }
    e[band].add(who);
  })));
}

function sharedAt(lon, lat, asProvince) {
  const e = owners.get(ownerKey(lon, lat));
  if (!e) return false;
  return e.c.size >= 2 || (asProvince && e.p.size >= 2);
}

// The same geometry with each point carrying its flag.
function flagged(geom, asProvince) {
  const conv = (ring) => ring.map((p) => [p[0], p[1], sharedAt(p[0], p[1], asProvince) ? 1 : 0]);
  if (geom.type === "Polygon") return { type: "Polygon", coordinates: geom.coordinates.map(conv) };
  if (geom.type === "MultiPolygon") {
    return { type: "MultiPolygon", coordinates: geom.coordinates.map((poly) => poly.map(conv)) };
  }
  return geom;
}

// Countries: the base map as well as something to search for. Their
// continent is kept so a continent can be drawn as its countries.
const countries = read("ne_50m_admin_0_countries");
const provinces = read("ne_50m_admin_1_states_provinces").filter((p) => p.properties.admin === "Russia");
countries.forEach((f) => claim(f.geometry, f.properties.ADM0_A3 || f.properties.NAME, "c"));
provinces.forEach((f) => claim(f.geometry, f.properties.adm1_code || f.properties.name, "p"));

countries.forEach((f) => {
  const p = f.properties;
  if (p.TYPE === "Indeterminate" && !p.NAME_EN) return;
  const { g, b } = polysFlagged(flagged(f.geometry, false), 0.03, 0.02);
  const name = p.NAME_EN || p.NAME;
  const a = alts(p.NAME_LONG, p.FORMAL_EN, p.ADMIN, p.NAME).filter((n) => n.toLowerCase() !== name.toLowerCase());
  add(name, "Country", "p", g, { b, c: p.CONTINENT, ...(a.length ? { a } : {}) });
});

// Continents, drawn from the countries that make them up rather than from
// Natural Earth's label regions, so they line up exactly with the base map.
// No second copy of those borders is stored: `from` lists the country ids
// and the page stitches them together.
//
// Natural Earth files all of Russia under Europe, which would leave Asia
// without Siberia. Russia is therefore split by its own federal subjects
// (ne_50m_admin_1_states_provinces) rather than cut along a meridian: a
// straight line down 60°E read as a mistake, because the real division
// follows the Urals and the administrative borders drawn around them.
// Those two halves are the only outlines a continent carries of its own.
//
// Everything east of the Urals crest, by the usual reckoning. Anything not
// named here is European Russia -- including the subjects that straddle the
// ridge and are counted west of it (Perm, Bashkortostan, Orenburg, Komi).
/* A piece of one country that belongs to another continent. French Guiana
   is a department of France and sits on the shoulder of South America; on
   a continents map it has to be South American land, not a speck of Europe
   across the Atlantic. */
const CONTINENT_PIECES = [
  { country: "France", box: [-55.5, 1.5, -50.0, 6.5], to: "South America" },
];

// The corners of a stored ring, back in degrees.
function ringBox(ring) {
  let x = 0, y = 0, b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i]; y += ring[i + 1];
    b[0] = Math.min(b[0], x / Q); b[1] = Math.min(b[1], y / Q);
    b[2] = Math.max(b[2], x / Q); b[3] = Math.max(b[3], y / Q);
  }
  return b;
}

const RUS_ASIA = ["Tomsk", "Chukotka", "Chelyabinsk", "Kurgan", "Yamalo-Nenets", "Sverdlovsk",
  "Khanty-Mansi", "Omsk", "Tyumen", "Altai", "Kemerovo", "Khakassia", "Novosibirsk", "Irkutsk",
  "Krasnoyarsk", "Tuva", "Buryatia", "Amur", "Zabaykalsky", "Primorsky", "Sakha", "Jewish",
  "Khabarovsk", "Magadan", "Sakhalin", "Kamchatka"];
{
  const from = {}, own = {};
  const keep = (cont, g, b) => {
    const o = own[cont] = own[cont] || { g: [], b: [] };
    o.g.push(...g);
    o.b.push(...b);
  };

  out.filter((f) => f.k === "Country").forEach((f) => {
    const c = f.c;
    if (!c || c === "Seven seas (open ocean)") return;
    if (f.n === "Russia") return;                       // split by its provinces below
    const rules = CONTINENT_PIECES.filter((r) => r.country === f.n);
    if (!rules.length) return (from[c] = from[c] || []).push(f);
    // This country has a piece filed under another continent, so it cannot
    // be taken whole: its rings are dealt out one at a time.
    f.g.forEach((ring, i) => {
      const box = ringBox(ring);
      const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      const rule = rules.find((r) => cx >= r.box[0] && cx <= r.box[2] && cy >= r.box[1] && cy <= r.box[3]);
      keep(rule ? rule.to : c, [ring], [f.b[i]]);
    });
  });

  provinces.forEach((p) => {
    const name = p.properties.name_en || p.properties.name || "";
    const asia = RUS_ASIA.some((k) => name.indexOf(k) >= 0);
    const { g, b } = polysFlagged(flagged(p.geometry, true), 0.03, 0.02);
    keep(asia ? "Asia" : "Europe", g, b);
  });
  const extra = { "North America": ["N. America"], "South America": ["S. America"],
    Oceania: ["Australia (continent)", "Australasia"] };
  Object.keys(from).forEach((c) => {
    out.push({ n: c, k: "Continent", s: "p", g: (own[c] || { g: [] }).g,
      b: (own[c] || { b: [] }).b, from: from[c].map((f) => f),
      ...(extra[c] ? { a: extra[c] } : {}) });
  });
}

const MARINE = {
  ocean: "Ocean", sea: "Sea", bay: "Bay", gulf: "Gulf", strait: "Strait",
  channel: "Channel", sound: "Sound", fjord: "Fjord", lagoon: "Lagoon",
  reef: "Reef", inlet: "Inlet", generic: "Sea area",
};
read("ne_10m_geography_marine_polys").forEach((f) => {
  const p = f.properties;
  const kind = MARINE[p.featurecla];
  if (!kind || !p.name) return;
  const a = alts(p.namealt, p.name_en).filter((n) => n.toLowerCase() !== tidy(p.name).toLowerCase());
  add(p.name, kind, "p", polys(f.geometry, 0.06, 0.05), a.length ? { a } : {});
});

// Natural Earth halves the two big oceans at the equator, which is right
// for labels and wrong for a quiz: "Pacific Ocean" should be one thing to
// click. The halves stay searchable as well.
["Pacific", "Atlantic"].forEach((o) => {
  const parts = out.filter((f) => f.k === "Ocean" && new RegExp("^(North|South) " + o).test(f.n));
  if (parts.length) add(o + " Ocean", "Ocean", "p", [].concat(...parts.map((f) => f.g)));
});

const REGION = {
  "Range/mtn": "Mountain range", Desert: "Desert", Plateau: "Plateau", Plain: "Plain",
  Basin: "Basin", "Pen/cape": "Peninsula", Peninsula: "Peninsula", "Island group": "Islands",
  Island: "Island", Tundra: "Tundra", Isthmus: "Isthmus", Geoarea: "Region",
  Valley: "Valley", Foothills: "Foothills", Delta: "Delta", Wetlands: "Wetlands",
  Lowland: "Lowland", Coast: "Coast", Gorge: "Gorge",
};
read("ne_50m_geography_regions_polys").forEach((f) => {
  const p = f.properties;
  const kind = REGION[p.FEATURECLA];
  if (!kind || !p.NAME) return;
  const a = alts(p.NAMEALT, p.NAME_EN).filter((n) => n.toLowerCase() !== tidy(p.NAME).toLowerCase());
  add(p.NAME, kind, "p", polys(f.geometry, 0.05, 0.02), { ...(a.length ? { a } : {}), ...(p.REGION ? { r: p.REGION } : {}) });
});

read("ne_50m_lakes").forEach((f) => {
  const p = f.properties;
  if (!p.name) return;
  add(p.name, p.featurecla === "Reservoir" ? "Reservoir" : "Lake", "p", polys(f.geometry, 0.03, 0.005));
});

// Rivers arrive in pieces, one per stretch between confluences, so pieces
// sharing a name are gathered into one feature. Some stretches carry the
// local name and others the English one (Rhein and Rhine), so the English
// name wins and the local one is kept to search by.
{
  const EN = { Amazonas: "Amazon", Huang: "Yellow River", "Huang He": "Yellow River",
    "Chang Jiang": "Yangtze", Ganga: "Ganges", Rhein: "Rhine", Rhin: "Rhine", Donau: "Danube" };
  const byName = new Map(), local = new Map();
  read("ne_50m_rivers_lake_centerlines").forEach((f) => {
    const p = f.properties;
    if (!p.name || p.featurecla === "Lake Centerline") return;
    const raw = tidy(p.name), key = EN[raw] || raw;
    if (!byName.has(key)) byName.set(key, []);
    if (raw !== key) local.set(key, raw);
    byName.get(key).push(...lines(f.geometry, 0.03));
  });
  byName.forEach((g, name) => add(name, "River", "l", g, local.has(name) ? { a: [local.get(name)] } : {}));
}

read("ne_10m_geography_regions_elevation_points").forEach((f) => {
  const p = f.properties;
  if (!p.name || (p.featurecla !== "mountain" && p.featurecla !== "depression" && p.featurecla !== "spot elevation")) return;
  const [x, y] = f.geometry.coordinates;
  add(p.name, p.featurecla === "depression" ? "Depression" : "Mountain", "d",
    [Math.round(x * Q), Math.round(y * Q)], p.elevation ? { e: Math.round(p.elevation) } : {});
});

read("ne_50m_populated_places_simple").forEach((f) => {
  const p = f.properties;
  if (!p.name) return;
  const [x, y] = f.geometry.coordinates;
  const cap = p.adm0cap === 1 || /Admin-0 capital/.test(p.featurecla || "");
  add(p.name, cap ? "Capital" : "City", "d", [Math.round(x * Q), Math.round(y * Q)],
    { ...(p.adm0name ? { r: p.adm0name } : {}), ...(p.pop_max ? { pop: p.pop_max } : {}) });
});

// Features that share a name (there are several Georgias and many Lake
// Victorias) get an id that tells them apart and stays put between runs.
const seen = {};
out.forEach((f) => {
  const base = (f.k + ":" + f.n).toLowerCase();
  seen[base] = (seen[base] || 0) + 1;
  f.id = seen[base] === 1 ? base : base + ":" + seen[base];
});
// Continents named their countries by reference until the ids existed.
out.forEach((f) => { if (f.from) f.from = f.from.map((c) => c.id); });

const file = path.join(HERE, "..", "geo.json");
fs.writeFileSync(file, JSON.stringify({ q: Q, f: out }));
const kinds = {};
out.forEach((f) => { kinds[f.k] = (kinds[f.k] || 0) + 1; });
console.log(`wrote geo.json: ${out.length} features, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
console.log(kinds);
