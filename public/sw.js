// The build injects a content-derived version and an explicit public asset list.
const CACHE_NAME = "asterism-static-__VERSION__";
const ASSETS = __ASSETS__;
const assetPaths = new Set(ASSETS);
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(
          ASSETS.map(
            (path) =>
              new Request(path, { credentials: "omit", cache: "reload" }),
          ),
        );
      } catch (error) {
        await caches.delete(CACHE_NAME);
        throw error;
      }
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(
        (await caches.keys())
          .filter(
            (name) =>
              name.startsWith("asterism-static-") && name !== CACHE_NAME,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});
// Wait for explicit consent from an app window; never interrupt an open draft.
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE")
    event.waitUntil(self.skipWaiting());
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  // Never intercept credentials, API results, mutations, feeds, logs, media,
  // arbitrary URLs or external sites. Cache-Control alone does not enforce this.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.search
  )
    return;
  if (
    request.mode === "navigate" &&
    ["/", "/index.html"].includes(url.pathname)
  ) {
    event.respondWith(
      fetch(request).catch(async () =>
        (await caches.open(CACHE_NAME)).match("/offline.html"),
      ),
    );
  } else if (assetPaths.has(url.pathname)) {
    event.respondWith(
      (async () =>
        (await (await caches.open(CACHE_NAME)).match(url.pathname)) ||
        fetch(request))(),
    );
  }
});
