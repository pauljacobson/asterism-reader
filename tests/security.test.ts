import { test } from "node:test";
import assert from "node:assert/strict";
import { configuration } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { hash, seal, unseal, token } from "../src/server/security.js";
const env = {
  APP_ORIGIN: "http://localhost:4321",
  ENCRYPTION_KEY: "a".repeat(64),
  OWNER_INVITE_HASH: hash("test-invite"),
  OWNER_INVITE_EXPIRES_AT: "2099-01-01T00:00:00Z",
  DATABASE_PATH: ":memory:",
};
async function harness(fetcher?: typeof fetch) {
  const c = configuration(env),
    db = new Store(":memory:"),
    { app } = createApp(c, db, fetcher);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  const address = server.address() as { port: number };
  let cookie = "",
    csrf = "";
  const request = async (
    path: string,
    body?: unknown,
    options: Record<string, any> = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api${path}`,
      {
        method: options.method || (body ? "POST" : "GET"),
        headers: {
          cookie,
          ...(body
            ? {
                "content-type": "application/json",
                origin: c.origin,
                "x-csrf-token": csrf,
              }
            : {}),
          ...options.headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      },
    );
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let data;
    try {
      data = await response.clone().json();
    } catch {
      data = null;
    }
    return { response, data };
  };
  const refresh = async () => {
    const result = await request("/session");
    csrf = result.data.csrf;
    return result.data;
  };
  await refresh();
  const seed = (phase = "full") => {
    const uid = "owner-test";
    db.run(
      "INSERT OR IGNORE INTO owner(singleton,uid,setup) VALUES(1,?,1)",
      uid,
    );
    db.run(
      "UPDATE sessions SET uid=?,phase=?,recent=?",
      uid,
      phase,
      Date.now(),
    );
    return uid;
  };
  const finish = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.db.close();
  };
  return { db, c, request, refresh, seed, finish };
}
test("configuration rejects production HTTP, missing secrets, and auth bypass", () => {
  assert.throws(() => configuration({ ...env, NODE_ENV: "production" }));
  assert.throws(() => configuration({ ...env, AUTH_MODE: "development" }));
  assert.throws(() => configuration({ ...env, ENCRYPTION_KEY: "" }));
  assert.throws(() =>
    configuration({ ...env, APP_ORIGIN: "https://reader.example/path" }),
  );
});
test("encrypted tokens reject tampering and a different key", () => {
  const key = Buffer.alloc(32, 1),
    sealed = seal({ token: "secret" }, key);
  assert.deepEqual(unseal(sealed, key), { token: "secret" });
  assert.throws(() => unseal(sealed, Buffer.alloc(32, 2)));
  const bytes = Buffer.from(sealed, "base64url");
  bytes[35] ^= 1;
  assert.throws(() => unseal(bytes.toString("base64url"), key));
});
test("private APIs deny anonymous, setup and recovery sessions; CSRF is enforced", async () => {
  const h = await harness();
  try {
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
    h.seed("setup");
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
    h.seed("recovery");
    assert.equal(
      (
        await h.request(
          "/preferences",
          { theme: "dark", font: "serif", size: 20 },
          { method: "PUT" },
        )
      ).response.status,
      401,
    );
    h.seed();
    assert.equal(
      (
        await h.request(
          "/preferences",
          { theme: "dark", font: "serif", size: 20 },
          { method: "PUT", headers: { origin: "https://attacker.example" } },
        )
      ).response.status,
      403,
    );
    assert.equal(
      (
        await h.request(
          "/auth/logout",
          {},
          { headers: { "x-csrf-token": "wrong" } },
        )
      ).response.status,
      403,
    );
  } finally {
    await h.finish();
  }
});
test("owner invitation is required and is unusable after account creation", async () => {
  const h = await harness();
  try {
    assert.equal(
      (await h.request("/auth/register/options", { invite: "wrong" })).response
        .status,
      403,
    );
    const data = await h.request("/auth/register/options", {
      invite: "test-invite",
    });
    assert.equal(data.response.status, 200);
    assert.equal(
      data.data.options.authenticatorSelection.userVerification,
      "required",
    );
    assert.equal(
      data.data.options.authenticatorSelection.residentKey,
      "required",
    );
    h.seed();
    assert.equal(
      (await h.request("/auth/register/options", { invite: "test-invite" }))
        .response.status,
      200,
    );
    assert.equal(
      JSON.parse(h.db.get("SELECT data FROM challenges")!.data).purpose,
      "add",
    );
  } finally {
    await h.finish();
  }
});
test("backup confirmation is mandatory; replacing codes is atomic and previous codes stay until confirmed", async () => {
  const h = await harness();
  try {
    h.seed("setup");
    h.db.run("UPDATE owner SET setup=0");
    const data = await h.request("/auth/backup/generate", {});
    assert.equal(data.data.codes.length, 8);
    assert.equal(h.db.get("SELECT count(*) AS n FROM recovery_codes")!.n, 0);
    assert.equal(
      (await h.request("/auth/backup/confirm", { saved: false })).response
        .status,
      400,
    );
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
    assert.equal(
      (await h.request("/auth/backup/confirm", { saved: true })).response
        .status,
      200,
    );
    assert.equal((await h.refresh()).phase, "full");
    const old = h.db.all("SELECT hash FROM recovery_codes").map((x) => x.hash);
    await h.request("/auth/backup/generate", {});
    assert.deepEqual(
      h.db.all("SELECT hash FROM recovery_codes").map((x) => x.hash),
      old,
    );
    await h.request("/auth/backup/confirm", { saved: true });
    await h.refresh();
    assert.equal(
      h.db
        .all("SELECT hash FROM recovery_codes")
        .some((x) => old.includes(x.hash)),
      false,
    );
    assert.equal(
      (await h.request("/auth/backup/confirm", { saved: true })).response
        .status,
      400,
    );
  } finally {
    await h.finish();
  }
});
test("recovery consumes codes once and cannot grant feed access or complete without a replacement passkey", async () => {
  const h = await harness();
  try {
    const uid = h.seed();
    h.db.run("INSERT INTO recovery_codes VALUES(?,?)", hash("ABCD"), uid);
    await h.request("/auth/recover", { code: "AB-CD" });
    assert.equal((await h.refresh()).phase, "recovery");
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
    assert.equal(
      (await h.request("/auth/backup/generate", {})).response.status,
      403,
    );
    assert.equal(
      (await h.request("/auth/recover", { code: "ABCD" })).response.status,
      400,
    );
  } finally {
    await h.finish();
  }
});
test("stale verification blocks sensitive changes and revoked sessions stop working", async () => {
  const h = await harness();
  try {
    h.seed();
    h.db.run("UPDATE sessions SET recent=0");
    assert.equal(
      (await h.request("/auth/backup/generate", {})).response.status,
      403,
    );
    h.db.run("DELETE FROM sessions");
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
  } finally {
    await h.finish();
  }
});
test("PKCE-ignoring upstream is revoked and never stored", async () => {
  const calls: string[] = [];
  const fake = async (input: any) => {
    const u = String(input);
    calls.push(u);
    return new Response(
      JSON.stringify(
        u.endsWith("/oauth/token") ? { access_token: "rejected-token" } : {},
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const h = await harness(fake as typeof fetch);
  try {
    h.seed();
    h.db.run(
      "INSERT INTO secrets VALUES(?,?)",
      "client",
      seal({ client_id: "client", client_secret: "secret" }, h.c.key),
    );
    const { data } = await h.request("/wordpress/connect", {});
    const state = new URL(data.url).searchParams.get("state");
    const result = await h.request(
      "/wordpress/callback?code=code&state=" + state,
    );
    assert.equal(
      result.response.headers.get("location"),
      "/?connection=pkce-required",
    );
    assert.ok(calls.some((x) => x.endsWith("/oauth/revoke")));
    assert.equal(
      h.db.get("SELECT value FROM secrets WHERE name='connection'"),
      undefined,
    );
    assert.equal(
      (await h.request("/wordpress/callback?code=code&state=" + state)).response
        .status,
      400,
    );
  } finally {
    await h.finish();
  }
});
test("PKCE-aware upstream connects with the right verifier and keeps token server-side", async () => {
  let attempts = 0;
  const fake = async (input: any, options: any) => {
    const u = String(input);
    if (u.endsWith("/oauth/token")) {
      attempts++;
      return new Response(
        JSON.stringify(
          attempts === 1
            ? { error: "code_verifier_mismatch" }
            : { access_token: "protected-token" },
        ),
        { status: attempts === 1 ? 400 : 200 },
      );
    }
    if (u.includes("verify_credentials"))
      return new Response(
        JSON.stringify({ id: "10", display_name: "Reader", acct: "reader" }),
      );
    return new Response("[]");
  };
  const h = await harness(fake as typeof fetch);
  try {
    h.seed();
    h.db.run(
      "INSERT INTO secrets VALUES(?,?)",
      "client",
      seal({ client_id: "client", client_secret: "secret" }, h.c.key),
    );
    const { data } = await h.request("/wordpress/connect", {});
    const state = new URL(data.url).searchParams.get("state");
    const result = await h.request(
      "/wordpress/callback?code=code&state=" + state,
    );
    assert.equal(
      result.response.headers.get("location"),
      "/?connection=success",
    );
    const session = await h.refresh();
    assert.equal(session.connection.id, "10");
    assert.ok(!JSON.stringify(session).includes("protected-token"));
    assert.ok(
      !h.db
        .get("SELECT value FROM secrets WHERE name='connection'")!
        .value.includes("protected-token"),
    );
    assert.equal(
      (await h.request("/wordpress/callback?code=code&state=wrong")).response
        .status,
      400,
    );
  } finally {
    await h.finish();
  }
});
test("pending recovery passkeys cannot sign in before new backup codes are confirmed", async () => {
  const h = await harness();
  try {
    const uid = h.seed("recovery");
    h.db.run(
      "INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?)",
      "pending-key",
      uid,
      "invalid-public-key",
      0,
      "[]",
      "Recovery key",
      Date.now(),
      0,
    );
    h.db.run("UPDATE sessions SET recovery_key=?", "pending-key");
    const challenge = await h.request("/auth/login/options", {});
    const result = await h.request("/auth/login/verify", {
      id: challenge.data.id,
      response: { id: "pending-key" },
    });
    assert.equal(result.response.status, 400);
    assert.equal((await h.refresh()).phase, "recovery");
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
    await h.request("/auth/backup/generate", {});
    await h.request("/auth/backup/confirm", { saved: true });
    assert.equal(
      h.db.get("SELECT enabled FROM credentials WHERE id=?", "pending-key")!
        .enabled,
      1,
    );
    assert.equal((await h.refresh()).phase, "full");
  } finally {
    await h.finish();
  }
});
test("WordPress proxy preserves reply visibility, attaches token only upstream, and reports write failures", async () => {
  const calls: { url: string; options: any }[] = [];
  const fake = async (input: any, options: any) => {
    const url = String(input);
    calls.push({ url, options });
    if (url.endsWith("/favourite")) return new Response("{}", { status: 503 });
    if (url.endsWith("/statuses/42"))
      return new Response(
        JSON.stringify({
          id: "42",
          visibility: "direct",
          spoiler_text: "Private subject",
        }),
      );
    return new Response(JSON.stringify({ id: "43" }));
  };
  const h = await harness(fake as typeof fetch);
  try {
    h.seed();
    h.db.run(
      "INSERT INTO secrets VALUES(?,?)",
      "connection",
      seal({ access_token: "test-token", account: { id: "10" } }, h.c.key),
    );
    const result = await h.request("/wordpress/reply", {
      id: "42",
      text: "Hello",
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      status: "Hello",
      in_reply_to_id: "42",
      visibility: "direct",
      spoiler_text: "Private subject",
    });
    assert.ok(calls.every((x) => new URL(x.url).origin === h.c.wordpress));
    assert.equal(calls[1].options.redirect, "error");
    assert.equal(calls[1].options.headers.Authorization, "Bearer test-token");
    assert.equal(
      (await h.request("/wordpress/post/42/favourite", {})).response.status,
      502,
    );
    assert.equal(
      (await h.request("/wordpress/post/https%3A%2F%2Fevil.example")).response
        .status,
      400,
    );
  } finally {
    await h.finish();
  }
});
