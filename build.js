// Builds the public website into docs/ from index.html.
//
// index.html stays the source of truth: it is the artifact fragment, with no
// <!doctype> or <head> of its own, because that is what the artifact host
// wants. This script wraps it, generates the icons and social card, and
// writes the handful of files a real site needs. Run: npm run build

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  encodePNG, canvas, rect, roundRect, circle, downsample, hex, text, textWidth,
} from "./scripts/png.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "docs");

// The public address of the site. Leave DOMAIN null to stay on the github.io
// subdomain; set it to a custom domain and rebuild, which repoints every
// absolute URL (canonical, og:, sitemap) and writes the CNAME file that
// GitHub Pages reads to claim the domain. Nothing else needs touching.
const DOMAIN = null; // e.g. "quizmaker.is-a.dev"
const SITE = DOMAIN ? `https://${DOMAIN}` : "https://swiftblado.github.io/quizmaker";

const NAME = "QuizMaker";
const BLURB =
  "Put in a list of vocabulary and drill it. Type the translation from " +
  "memory, or pick it from the tiles. Free, and it runs entirely in your " +
  "browser, with no account and nothing uploaded.";

const C = {
  accent: hex("#2B4ACB"),
  accentLift: hex("#8AA0F2"),
  ink: hex("#141A2B"),
  white: hex("#FFFFFF"),
  muted: hex("#98A2B8"),
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* --------------------------------------------------------------- the page */

const src = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
const MOUNT = "<div class=\"wrap\">";
const split = src.indexOf(MOUNT);
if (split === -1) throw new Error("index.html: could not find " + MOUNT);

const headFrag = src.slice(0, split).trim();  // <title>, fonts, <style>
const bodyFrag = src.slice(split).trim();     // markup + <script>
const version = crypto.createHash("sha1").update(src).digest("hex").slice(0, 8);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#EDF0F5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0F131C" media="(prefers-color-scheme: dark)">
<meta name="description" content="${BLURB}">
<link rel="canonical" href="${SITE}/">

<meta property="og:type" content="website">
<meta property="og:site_name" content="${NAME}">
<meta property="og:title" content="${NAME} — drill any vocabulary list">
<meta property="og:description" content="${BLURB}">
<meta property="og:url" content="${SITE}/">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${NAME}">
<meta name="twitter:card" content="summary_large_image">

<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="icon" href="icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="manifest" href="manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="${NAME}">
<meta name="apple-mobile-web-app-capable" content="yes">

${headFrag}
</head>
<body>
<noscript>
  <p style="font:16px/1.5 system-ui,sans-serif;max-width:46ch;margin:40px auto;padding:0 20px">
    ${NAME} is a quiz that runs in your browser, so it needs JavaScript switched
    on. Nothing is sent anywhere — that is exactly why the work happens here.
  </p>
</noscript>
${bodyFrag}
<script>
  // Offline support, so a drill survives a bad train connection. The secure
  // context test takes in localhost as well as https, which keeps the worker
  // exercised by the local preview rather than first run in production.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(OUT, "index.html"), page);

/* ------------------------------------------------------------------ icons */
// A deck of two cards: one behind, one in front holding a word and its answer.

function mark(size) {
  const S = 4, s = size * S, u = s / 512; // drawn at 4x, in 512-space units
  const c = canvas(s, s, C.accent);
  roundRect(c, 90 * u, 142 * u, 300 * u, 200 * u, 24 * u, C.accentLift);
  roundRect(c, 116 * u, 170 * u, 300 * u, 200 * u, 24 * u, C.white);
  roundRect(c, 144 * u, 236 * u, 200 * u, 22 * u, 11 * u, C.ink);
  roundRect(c, 144 * u, 280 * u, 128 * u, 22 * u, 11 * u, C.accent);
  return downsample(c, S);
}

for (const [file, size] of [
  ["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180],
]) {
  fs.writeFileSync(path.join(OUT, file), encodePNG(mark(size)));
}

fs.writeFileSync(path.join(OUT, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="114" fill="#2B4ACB"/>
  <rect x="90" y="142" width="300" height="200" rx="24" fill="#8AA0F2"/>
  <rect x="116" y="170" width="300" height="200" rx="24" fill="#FFFFFF"/>
  <rect x="144" y="236" width="200" height="22" rx="11" fill="#141A2B"/>
  <rect x="144" y="280" width="128" height="22" rx="11" fill="#2B4ACB"/>
</svg>
`);

/* ------------------------------------------------------------- social card */

{
  const S = 2, W = 1200, PAD = 90;
  const c = canvas(W * S, 630 * S, C.ink);

  // Nothing here is laid out by a browser, so an overlong line would just run
  // off the card. Measure first and refuse to ship one that does not fit.
  const line = (s, y, px, col, gap) => {
    const w = textWidth(s, px, gap);
    if (PAD + w > W - PAD) throw new Error(`og.png: "${s}" overflows by ${PAD + w - (W - PAD)}px`);
    text(c, s, PAD * S, y * S, px * S, col, gap * S);
  };

  rect(c, 0, 0, W * S, 8 * S, C.accent);
  circle(c, 100 * S, 192 * S, 11 * S, C.accent);
  line("QUIZMAKER", 238, 14, C.white, 7);
  line("TYPE THE TRANSLATION FROM MEMORY", 398, 5, C.muted, 3);
  line("FREE - NO ACCOUNT - NOTHING UPLOADED", 476, 5, C.accentLift, 3);
  fs.writeFileSync(path.join(OUT, "og.png"), encodePNG(downsample(c, S)));
}

/* -------------------------------------------------------- the small files */

fs.writeFileSync(path.join(OUT, "manifest.webmanifest"), JSON.stringify({
  name: NAME,
  short_name: NAME,
  description: BLURB,
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: "#EDF0F5",
  theme_color: "#2B4ACB",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
}, null, 2) + "\n");

// Navigations go to the network first, so a new build lands on the next
// visit; everything else is served from cache and refreshed behind its back.
fs.writeFileSync(path.join(OUT, "sw.js"), `const CACHE = "quizmaker-${version}";
const SHELL = ["./", "./index.html", "./icon.svg", "./icon-192.png", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("./index.html", copy));
        return res;
      })
      .catch(() => caches.match("./index.html")));
    return;
  }

  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    const copy = res.clone();
    if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
    return res;
  })));
});
`);

fs.writeFileSync(path.join(OUT, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

fs.writeFileSync(path.join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>
</urlset>
`);

fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

if (DOMAIN) fs.writeFileSync(path.join(OUT, "CNAME"), DOMAIN + "\n");

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`built docs/ from index.html (version ${version})`);
for (const f of fs.readdirSync(OUT).sort())
  console.log("  " + f.padEnd(24) + kb(fs.statSync(path.join(OUT, f)).size));
