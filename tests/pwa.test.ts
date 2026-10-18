import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import vm from "node:vm";

// Exercise the actual built worker in a controlled browser-like environment.
// No authenticated response is ever written to the mock Cache Storage.
async function workerHarness() {
  const handlers = new Map<string, (event: any) => void>(),
    stored = new Map<string, Response>();
  let online = true,
    skipped = false;
  const names = new Set<string>(["another-app-cache", "asterism-static-old"]);
  const network: string[] = [];
  const worker = {
    location: { origin: "https://reader.example" },
    clients: { claim: async () => {} },
    skipWaiting: async () => {
      skipped = true;
    },
    addEventListener: (name: string, callback: any) =>
      handlers.set(name, callback),
  };
  const cache = {
    addAll: async (requests: Request[]) => {
      for (const request of requests)
        stored.set(
          new URL(request.url).pathname,
          new Response("static: " + request.url),
        );
    },
    match: async (path: string) =>
      stored.get(new URL(path, "https://reader.example").pathname)?.clone(),
  };
  class WorkerRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, "https://reader.example"), init);
    }
  }
  vm.runInNewContext(await readFile("dist/public/sw.js", "utf8"), {
    self: worker,
    Request: WorkerRequest,
    URL,
    Set,
    caches: {
      open: async (name: string) => {
        names.add(name);
        return cache;
      },
      keys: async () => [...names],
      delete: async (name: string) => names.delete(name),
    },
    fetch: async (request: Request) => {
      network.push(request.url);
      if (!online) throw Error("offline");
      return new Response("network");
    },
  });
  const lifecycle = async (name: string, data: any = {}) => {
    let pending: Promise<unknown> | undefined;
    handlers.get(name)!({
      ...data,
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    await pending;
  };
  const request = async (path: string, mode = "cors", method = "GET") => {
    let result: Promise<Response> | undefined;
    handlers.get("fetch")!({
      request: {
        url: new URL(path, "https://reader.example").href,
        method,
        mode,
      },
      respondWith: (p: Promise<Response>) => {
        result = p;
      },
    });
    return result ? await result : null;
  };
  await lifecycle("install");
  return {
    stored,
    names,
    network,
    lifecycle,
    request,
    setOffline: () => {
      online = false;
    },
    get skipped() {
      return skipped;
    },
  };
}
test("PWA manifest and built assets have stable identity, standalone launch and valid installation icons", async () => {
  const manifest = JSON.parse(
    await readFile("dist/public/manifest.webmanifest", "utf8"),
  );
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(
      (i: any) => i.sizes === `${size}x${size}` && i.purpose === "any",
    );
    const png = await readFile("dist/public" + icon.src);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert.ok(manifest.icons.some((i: any) => i.purpose === "maskable"));
  const html = await readFile("dist/public/index.html", "utf8");
  const assets = html.match(
    /\/assets\/(?:app|style)-[a-f0-9]{16}\.(?:js|css)/g,
  )!;
  assert.equal(assets.length, 2);
  for (const path of assets) await access("dist/public" + path);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /apple-touch-icon/);
  assert.doesNotMatch(
    await readFile("dist/public/sw.js", "utf8"),
    /__VERSION__|__ASSETS__/,
  );
});
test("worker caches only explicit public files; never API, OAuth, log exports, mutations or third-party resources", async () => {
  const h = await workerHarness();
  for (const path of [
    "/api/session",
    "/api/auth/backup/generate",
    "/api/admin/logs/export",
    "/api/wordpress/callback?code=private",
    "/api/wordpress/feed",
    "/uploads/private.jpg",
    "https://other.example/private",
  ])
    assert.equal(await h.request(path), null);
  assert.equal(await h.request("/offline.html", "cors", "POST"), null);
  assert.equal(await h.request("/offline.html?token=secret"), null);
  assert.equal(await h.request("/?setup=secret", "navigate"), null);
  assert.ok(
    [...h.stored.keys()].every(
      (path) =>
        path.startsWith("/assets/") ||
        path.startsWith("/icons/") ||
        ["/offline.html", "/offline.css", "/favicon.ico"].includes(path),
    ),
  );
  assert.ok(
    [...h.stored.values()].every(
      (response) => !response.headers.has("set-cookie"),
    ),
  );
});
test("offline launch uses a public fallback and updates wait for explicit consent while retaining other apps' caches", async () => {
  const h = await workerHarness();
  assert.equal(await (await h.request("/", "navigate"))!.text(), "network");
  h.setOffline();
  assert.match(
    await (await h.request("/", "navigate"))!.text(),
    /offline.html/,
  );
  assert.equal(h.skipped, false);
  await h.lifecycle("message", { data: { type: "OTHER" } });
  assert.equal(h.skipped, false);
  await h.lifecycle("message", { data: { type: "ACTIVATE_UPDATE" } });
  assert.equal(h.skipped, true);
  await h.lifecycle("activate");
  assert.equal(h.names.has("asterism-static-old"), false);
  assert.equal(h.names.has("another-app-cache"), true);
});
