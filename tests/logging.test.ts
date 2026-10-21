import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { AppLogger, LogStore, type LogEntry } from "../src/server/logging.js";
import { configuration } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { hash, seal } from "../src/server/security.js";

const entry = (message: string): LogEntry => ({
  timestamp: new Date().toISOString(),
  level: "info",
  category: "system",
  event: "started",
  message,
  data: {},
});
test("log storage persists, filters literally, paginates without duplicates, and expires old entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterism-logs-"));
  let now = Date.now();
  const path = join(directory, "logs.sqlite");
  let store = new LogStore(path, () => now, 3);
  try {
    store.append(entry("old"));
    now += 8 * 86400_000;
    store.append(entry("literal %_ search"));
    store.append({ ...entry("warning"), level: "warn", category: "wordpress" });
    store.append(entry("newest"));
    const page = store.query({ limit: 2 });
    assert.deepEqual(
      page.entries.map((e) => e.message),
      ["newest", "warning"],
    );
    assert.equal(page.total, 3);
    assert.equal(
      store.query({ before: page.next!, limit: 2 }).entries[0].message,
      "literal %_ search",
    );
    assert.equal(store.query({ search: "%_" }).total, 1);
    assert.equal(
      store.query({ category: "wordpress", level: "warn" }).total,
      1,
    );
    store.close();
    store = new LogStore(path, () => now, 3);
    assert.equal(store.query().total, 3);
    store.append(entry("fourth"));
    assert.equal(store.query().total, 3);
    assert.equal(store.query({ search: "literal" }).total, 0);
    now += 8 * 86400_000;
    assert.equal(store.query().total, 0);
  } finally {
    store.close();
  }
});

test("both sinks exclude secrets and concurrent requests keep distinct correlation IDs", async () => {
  const output: string[] = [],
    logger = new AppLogger(":memory:", "debug", (line) => output.push(line));
  const secret = "SECRET-token-cookie-pkce-backup-reply";
  try {
    const ids = await Promise.all(
      [1, 2].map(async (count) =>
        logger.run(async () => {
          const id = logger.requestId;
          await new Promise((resolve) => setTimeout(resolve, count));
          logger.write("upstream", "info", {
            count,
            operation: "feed",
            durationMs: 2,
            status: 200,
            token: secret,
            headers: { authorization: secret },
            body: secret,
            error: new Error(secret),
            route: "https://example.com/?code=" + secret,
          });
          return id;
        }),
      ),
    );
    assert.notEqual(ids[0], ids[1]);
    const stored = logger.query({}).entries;
    assert.deepEqual(new Set(stored.map((e) => e.requestId)), new Set(ids));
    assert.equal(JSON.stringify(stored).includes(secret), false);
    assert.equal(output.join("\n").includes(secret), false);
    logger.write("upstream", "debug", {
      operation: secret,
      reason: secret,
      method: secret,
    });
    assert.deepEqual(logger.query({}).entries[0].data, {});
  } finally {
    logger.close();
  }
});

test("persistent sink and stdout failures do not break application operations", () => {
  const output: string[] = [];
  const logger = new AppLogger("/dev/null/unwritable.sqlite", "info", (line) =>
    output.push(line),
  );
  assert.doesNotThrow(() => logger.write("started"));
  assert.throws(() => logger.query({}));
  assert.equal(
    output.filter((line) => line.includes("Persistent logs unavailable"))
      .length,
    1,
  );
  const brokenOutput = new AppLogger(":memory:", "info", () => {
    throw Error("closed stdout");
  });
  assert.doesNotThrow(() => brokenOutput.write("started"));
  assert.equal(brokenOutput.query({}).total, 1);
  brokenOutput.close();
  logger.close();
});

async function harness() {
  const c = configuration({
    WORDPRESS_URL: "https://wordpress.example.com",
    APP_ORIGIN: "http://localhost:4321",
    ENCRYPTION_KEY: "a".repeat(64),
    OWNER_INVITE_HASH: hash("invite"),
    OWNER_INVITE_EXPIRES_AT: "2099-01-01",
    DATABASE_PATH: ":memory:",
  });
  const db = new Store(":memory:"),
    lines: string[] = [],
    logger = new AppLogger(":memory:", "debug", (line) => lines.push(line));
  const privateText = "NEVER-LOG-PRIVATE-CONTENT";
  const fakeFetch: typeof fetch = async (input) => {
    const p = new URL(String(input)).pathname;
    if (p.endsWith("/home"))
      return Response.json([
        { id: "42", content: privateText, account: { id: "20" } },
      ]);
    if (p.endsWith("/context")) throw new Error(privateText + " token=secret");
    return Response.json({ error: privateText }, { status: 401 });
  };
  const { app } = createApp(c, db, fakeFetch, logger);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  const request = async (path: string) => {
    const res = await fetch(origin + path, { headers: { cookie } });
    if (res.headers.get("set-cookie"))
      cookie = res.headers.get("set-cookie")!.split(";")[0];
    return res;
  };
  await request("/api/session");
  const seed = (phase: string) => {
    db.run(
      "INSERT OR IGNORE INTO owner(singleton,uid,setup) VALUES(1,'owner',1)",
    );
    db.run("UPDATE sessions SET uid='owner',phase=?,recent=0", phase);
    db.run(
      "INSERT OR REPLACE INTO secrets VALUES('connection',?)",
      seal({ access_token: privateText, account: { id: "10" } }, c.key),
    );
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.close();
    db.db.close();
  };
  return { request, seed, close, logger, lines, db, privateText };
}

test("logs and filtered exports require a full owner session without fresh passkey verification", async () => {
  const h = await harness();
  try {
    for (const phase of ["anonymous", "setup", "recovery"]) {
      if (phase !== "anonymous") h.seed(phase);
      for (const path of ["/api/admin/logs", "/api/admin/logs/export"]) {
        const res = await h.request(path);
        assert.equal(res.status, 401);
        assert.equal(res.headers.get("cache-control"), "no-store");
      }
    }
    h.seed("full");
    h.db.audit("signed-in");
    await h.request("/api/wordpress/feed?token=secret-query");
    const res = await h.request(
      "/api/admin/logs?category=wordpress&search=feed&limit=1",
    );
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.entries[0].data.count, 1);
    assert.equal(result.entries[0].data.operation, "feed");
    const exported = await h.request(
      "/api/admin/logs/export?category=wordpress&search=feed",
    );
    assert.equal(exported.status, 200);
    assert.match(
      exported.headers.get("content-type")!,
      /application\/x-ndjson/,
    );
    assert.match(exported.headers.get("content-disposition")!, /attachment/);
    const data = await exported.text();
    assert.equal(
      data
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)).length,
      1,
    );
    assert.equal(data.includes(h.privateText), false);
    assert.equal(h.lines.join("").includes("secret-query"), false);
    assert.equal(
      (await h.request("/api/admin/logs?level=invalid")).status,
      400,
    );
    assert.equal((await h.request("/api/admin/logs?before=-1")).status, 400);
    assert.equal((await h.request("/api/admin/logs?limit=10001")).status, 400);
    assert.equal(
      (await h.request("/api/admin/logs?search=" + "x".repeat(201))).status,
      400,
    );
    assert.equal(
      h.logger.query({ category: "auth" }).entries[0].event,
      "signed-in",
    );
  } finally {
    await h.close();
  }
});

test("upstream failures have safe diagnostics, request IDs, and no private data in either sink", async () => {
  const h = await harness();
  try {
    h.seed("full");
    const res = await h.request(
      "/api/wordpress/post/private-id/context?code=private-code",
    );
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.requestId, res.headers.get("x-request-id"));
    const entries = h.logger.query({}).entries;
    assert.ok(
      entries.some(
        (e) =>
          e.event === "upstreamFailed" &&
          e.requestId === body.requestId &&
          e.data.operation === "conversation",
      ),
    );
    assert.ok(
      entries.some(
        (e) => e.event === "requestFailed" && e.requestId === body.requestId,
      ),
    );
    const combined = JSON.stringify(entries) + h.lines.join("");
    for (const privateValue of [h.privateText, "private-id", "private-code"])
      assert.equal(combined.includes(privateValue), false);
  } finally {
    await h.close();
  }
});

test("successful health and log polling stay quiet and writes obey bounded retention", async () => {
  const h = await harness();
  try {
    h.seed("full");
    const before = h.logger.query({}).total;
    await h.request("/healthz");
    await h.request("/api/admin/logs");
    await h.request("/api/admin/logs/export");
    assert.equal(h.logger.query({}).total, before);
    const started = performance.now();
    for (let count = 0; count < 10_010; count++)
      h.logger.write("upstream", "info", { operation: "feed", count });
    assert.equal(h.logger.query({}).retained, 10_000);
    assert.equal(h.logger.query({ search: '"count":0}' }).total, 0);
    console.log(
      `Bounded logging: 10010 in-memory writes in ${Math.round(performance.now() - started)}ms`,
    );
  } finally {
    await h.close();
  }
});

test("runtime storage write failures fall back to sanitized console logs and report degraded persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterism-log-failure-"));
  const path = join(directory, "logs.sqlite"),
    lines: string[] = [];
  const logger = new AppLogger(path, "info", (line) => lines.push(line));
  const blocker = new DatabaseSync(path);
  try {
    blocker.exec(
      "CREATE TRIGGER simulate_disk_failure BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'SECRET filesystem detail'); END",
    );
    assert.doesNotThrow(() => logger.write("started"));
    assert.equal(logger.query({}).persistenceDegraded, true);
    assert.equal(logger.query({}).total, 0);
    assert.ok(lines.some((line) => line.includes("Application started")));
    assert.equal(lines.join("").includes("SECRET"), false);
    blocker.exec("DROP TRIGGER simulate_disk_failure");
    logger.write("started");
    assert.equal(logger.query({}).total, 1);
  } finally {
    blocker.close();
    logger.close();
  }
});
