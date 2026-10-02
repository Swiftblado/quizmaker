const CACHE = "quizmaker-33fb7751";
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

  // A shared quiz is read fresh every time: it is rewritten whenever its
  // owner changes the quiz, and a link must show what the quiz says now.
  if (new URL(req.url).pathname.indexOf("/s/") >= 0 && req.url.endsWith(".json")) {
    e.respondWith(fetch(req, { cache: "no-store" }).catch(() => caches.match(req)));
    return;
  }

  if (req.mode === "navigate") {
    // Revalidated, never served straight from the HTTP cache -- the host
    // sends max-age=600, and a reload inside that window would otherwise
    // hand back the previous build.
    e.respondWith(fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
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
