// SkyCommunity Radar — service worker of the installable app.
// Deliberately minimal: the radar is live data, so nothing is served from cache except a small offline page
// shown when the phone has no connection. API calls (/api/…) are never cached.
const CACHE = "skyradar-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, "/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // everything else goes straight to the network
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
