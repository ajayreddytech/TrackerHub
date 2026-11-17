// Caches only this site's app files so the app opens offline-ish and loads fast.
// Your links live in Firestore and are never cached here.
const CACHE = "tracker-hub-v2";
const APP_FILES = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/firebase-config.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GETs. Firebase and Google traffic goes straight to the network.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network first (always fresh when online), cached copy when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
