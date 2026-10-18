import { test } from "node:test";
import { createHash } from "node:crypto";
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
test("link previews require a full owner session and CSRF; private URLs return no metadata", async () => {
  const h = await harness();
  try {
    for (const phase of ["anonymous", "setup", "recovery"]) {
      if (phase !== "anonymous") h.seed(phase);
      assert.equal(
        (await h.request("/link-preview", { url: "https://example.com" }))
          .response.status,
        401,
      );
    }
    h.seed();
    assert.equal(
      (
        await h.request(
          "/link-preview",
          { url: "https://example.com" },
          { headers: { "x-csrf-token": "wrong" } },
        )
      ).response.status,
      403,
    );
    const result = await h.request("/link-preview", {
      url: "http://127.0.0.1/",
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data, { preview: null });
  } finally {
    await h.finish();
  }
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
    assert.equal(
      (await h.request("/wordpress/connect", {})).response.status,
      401,
    );
    h.seed("setup");
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
    assert.equal(
      (await h.request("/wordpress/connect", {})).response.status,
      401,
    );
    h.seed("recovery");
    assert.equal(
      (await h.request("/wordpress/connect", {})).response.status,
      401,
    );
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
          "/wordpress/connect",
          {},
          { headers: { "x-csrf-token": "wrong" } },
        )
      ).response.status,
      403,
    );
    assert.equal(
      (
        await h.request(
          "/wordpress/connect",
          {},
          { headers: { origin: "https://attacker.example" } },
        )
      ).response.status,
      403,
    );
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
    await h.refresh();
    assert.equal(
      (await h.request("/wordpress/connect", {})).response.status,
      401,
    );
    assert.equal((await h.request("/wordpress/feed")).response.status, 401);
  } finally {
    await h.finish();
  }
});
// Both official EMA (which ignores PKCE) and enforcing servers must receive
// exactly one genuine exchange. Never spend a user's code on a negative probe.
for (const enforcesPkce of [false, true]) {
  test(`OAuth connects with a ${enforcesPkce ? "PKCE-enforcing" : "legacy EMA"} server and keeps credentials private`, async () => {
    let challenge = "";
    let attempts = 0;
    const calls: string[] = [];
    const fake = async (input: any, options: any) => {
      const u = String(input);
      calls.push(u);
      assert.equal(options.redirect, "error");
      if (u.endsWith("/api/v1/apps")) {
        const body = new URLSearchParams(options.body);
        assert.equal(
          body.get("redirect_uris"),
          env.APP_ORIGIN + "/api/wordpress/callback",
        );
        return Response.json({
          client_id: "client",
          client_secret: "private-secret",
        });
      }
      if (u.endsWith("/oauth/token")) {
        attempts++;
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("client_secret"), "private-secret");
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(
          body.get("redirect_uri"),
          env.APP_ORIGIN + "/api/wordpress/callback",
        );
        const actual = createHash("sha256")
          .update(body.get("code_verifier") || "")
          .digest("base64url");
        if (enforcesPkce && actual !== challenge)
          return Response.json(
            { error: "code_verifier_mismatch" },
            { status: 400 },
          );
        return Response.json({ access_token: "private-token" });
      }
      if (u.endsWith("/api/v1/accounts/verify_credentials")) {
        assert.equal(options.headers.Authorization, "Bearer private-token");
        return Response.json({ id: "10", display_name: "Reader", acct: "reader" });
      }
      throw new Error("Unexpected upstream request " + u);
    };
    const h = await harness(fake as typeof fetch);
    try {
      h.seed();
      // An established owner session is sufficient, even outside the five-minute
      // verification window used for credential-management operations.
      h.db.run("UPDATE sessions SET recent=0");
      const { data, response } = await h.request("/wordpress/connect", {});
      assert.equal(response.status, 200);
      const auth = new URL(data.url);
      const state = auth.searchParams.get("state");
      challenge = auth.searchParams.get("code_challenge")!;
      assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
      assert.ok(!data.url.includes("private-secret"));
      const result = await h.request(
        "/wordpress/callback?code=code&state=" + state,
      );
      assert.equal(
        result.response.headers.get("location"),
        "/?connection=success",
      );
      assert.equal(attempts, 1);
      assert.equal(
        calls.filter((url) => url.endsWith("/oauth/revoke")).length,
        0,
      );
      const session = await h.refresh();
      assert.equal(session.connection.id, "10");
      assert.ok(!JSON.stringify(session).includes("private-token"));
      assert.ok(!JSON.stringify(session).includes("private-secret"));
      const stored = h.db.get(
        "SELECT value FROM secrets WHERE name='connection'",
      )!.value;
      assert.ok(!stored.includes("private-token"));
      assert.equal(unseal<any>(stored, h.c.key).access_token, "private-token");
      assert.equal(
        (await h.request("/wordpress/callback?code=code&state=" + state))
          .response.status,
        400,
      );
      assert.equal(attempts, 1);
    } finally {
      await h.finish();
    }
  });
}
test("OAuth rejects missing, wrong-session, superseded, expired and declined state before token exchange", async () => {
  let calls = 0;
  const h = await harness((async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch);
  try {
    h.seed();
    h.db.run(
      "INSERT INTO secrets VALUES(?,?)",
      "client",
      seal({ client_id: "client", client_secret: "secret" }, h.c.key),
    );
    const begin = async () =>
      new URL(
        (await h.request("/wordpress/connect", {})).data.url,
      ).searchParams.get("state")!;
    const callback = (state: string) =>
      h.request("/wordpress/callback?code=code&state=" + state);
    assert.equal(
      (await h.request("/wordpress/callback?code=code")).response.status,
      400,
    );
    assert.equal((await callback("wrong")).response.status, 400);
    const other = await begin();
    h.db.run(
      "INSERT INTO sessions SELECT 'another-browser',uid,phase,csrf,recent,created,touched,expires,recovery_key FROM sessions LIMIT 1",
    );
    h.db.run(
      "UPDATE challenges SET session='another-browser' WHERE id=?",
      hash(other),
    );
    assert.equal((await callback(other)).response.status, 400);
    const old = await begin();
    const current = await begin();
    assert.equal((await callback(old)).response.status, 400);
    h.db.run("UPDATE challenges SET expires=0 WHERE id=?", hash(current));
    assert.equal((await callback(current)).response.status, 400);
    const declined = await begin();
    assert.equal(
      (
        await h.request(
          "/wordpress/callback?error=access_denied&state=" + declined,
        )
      ).response.headers.get("location"),
      "/?connection=declined",
    );
    assert.equal((await callback(declined)).response.status, 400);
    assert.equal(calls, 0);
    assert.equal(
      h.db.get("SELECT value FROM secrets WHERE name='connection'"),
      undefined,
    );
  } finally {
    await h.finish();
  }
});
test("OAuth token errors are never retried without PKCE and identity failures revoke the new token", async () => {
  for (const identityFailure of [false, true]) {
    const calls: string[] = [];
    const h = await harness((async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/oauth/token"))
        return identityFailure
          ? Response.json({ access_token: "unverified-token" })
          : Response.json({ error: "code_verifier_mismatch" }, { status: 400 });
      if (url.endsWith("/api/v1/accounts/verify_credentials"))
        return Response.json({}, { status: 401 });
      if (url.endsWith("/oauth/revoke")) return Response.json({});
      throw new Error("Unexpected upstream request " + url);
    }) as typeof fetch);
    try {
      h.seed();
      h.db.run(
        "INSERT INTO secrets VALUES(?,?)",
        "client",
        seal({ client_id: "client", client_secret: "secret" }, h.c.key),
      );
      const auth = new URL(
        (await h.request("/wordpress/connect", {})).data.url,
      );
      const state = auth.searchParams.get("state");
      assert.equal(
        (await h.request("/wordpress/callback?code=code&state=" + state))
          .response.status,
        502,
      );
      assert.equal(
        calls.filter((url) => url.endsWith("/oauth/token")).length,
        1,
      );
      assert.equal(
        calls.filter((url) => url.endsWith("/oauth/revoke")).length,
        identityFailure ? 1 : 0,
      );
      assert.equal(
        h.db.get("SELECT value FROM secrets WHERE name='connection'"),
        undefined,
      );
    } finally {
      await h.finish();
    }
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
test("author view loads account posts with validated pagination and private access", async () => {
  const calls: { url: string; options: any }[] = [];
  const h = await harness((async (input: any, options: any) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, options });
    if (url.pathname.endsWith("/statuses"))
      return Response.json([{ id: "42", account: { id: "20" } }], {
        headers: {
          link: '<https://wordpress.example.com/api/v1/accounts/20/statuses?max_id=41>; rel="next"',
        },
      });
    return Response.json({ id: "20", display_name: "Sample author" });
  }) as typeof fetch);
  try {
    assert.equal(
      (await h.request("/wordpress/author/20")).response.status,
      401,
    );
    h.seed();
    assert.equal(
      (await h.request("/wordpress/author/20")).response.status,
      409,
    );
    h.db.run(
      "INSERT INTO secrets VALUES(?,?)",
      "connection",
      seal({ access_token: "test-token", account: { id: "10" } }, h.c.key),
    );
    const result = await h.request("/wordpress/author/20?cursor=50");
    assert.equal(result.response.status, 200);
    assert.equal(result.data.account.id, "20");
    assert.equal(result.data.posts[0].id, "42");
    assert.equal(result.data.next, "41");
    assert.ok(calls.some((c) => c.url.endsWith("/accounts/20")));
    const statuses = calls.find((c) => c.url.includes("/statuses?"))!;
    assert.equal(new URL(statuses.url).searchParams.get("max_id"), "50");
    assert.equal(new URL(statuses.url).searchParams.get("limit"), "30");
    assert.ok(
      calls.every(
        (c) => c.options.headers.Authorization === "Bearer test-token",
      ),
    );
    const count = calls.length;
    assert.equal(
      (await h.request("/wordpress/author/https%3A%2F%2Fevil.test")).response
        .status,
      400,
    );
    assert.equal(
      (await h.request("/wordpress/author/20?cursor=bad%2Fcursor")).response
        .status,
      400,
    );
    assert.equal(calls.length, count);
  } finally {
    await h.finish();
  }
});
test("author history falls back to bounded Friends timeline filtering when account statuses omit cached posts", async () => {
  const calls: string[] = [];
  const h = await harness((async (input: any) => {
    const u = new URL(String(input));
    calls.push(u.href);
    if (u.pathname.endsWith("/accounts/20")) return Response.json({ id: "20" });
    if (u.pathname.endsWith("/statuses")) return Response.json([]);
    const max = u.searchParams.get("max_id");
    const own = { id: max ? "35" : "55", account: { id: "20" } };
    const posts =
      max === "40"
        ? [own]
        : max === "30"
          ? []
          : [
              { id: "60", account: { id: "21" } },
              own,
              { id: "boost", account: { id: "21" }, reblog: own },
            ];
    const next = max === "40" ? "30" : max === "30" ? null : "40";
    return Response.json(posts, {
      headers: next
        ? {
            link: `<https://wordpress.example.com/api/v1/timelines/home?max_id=${next}>; rel="next"`,
          }
        : {},
    });
  }) as typeof fetch);
  try {
    h.seed();
    h.db.run(
      "INSERT INTO secrets VALUES(?,?)",
      "connection",
      seal({ access_token: "test-token", account: { id: "10" } }, h.c.key),
    );
    const first = await h.request("/wordpress/author/20");
    assert.equal(first.response.status, 200);
    assert.deepEqual(
      first.data.posts.map((p: any) => p.id),
      ["55"],
    );
    assert.equal(first.data.next, "home:40");
    assert.equal(calls.filter((u) => u.includes("/timelines/home?")).length, 1);
    assert.equal(
      new URL(
        calls.find((u) => u.includes("/timelines/home?"))!,
      ).searchParams.get("limit"),
      "30",
    );
    calls.length = 0;
    const next = await h.request("/wordpress/author/20?cursor=home:40");
    assert.equal(next.response.status, 200);
    assert.deepEqual(
      next.data.posts.map((p: any) => p.id),
      ["35"],
    );
    assert.ok(!calls.some((u) => u.includes("/statuses")));
    assert.equal(
      new URL(
        calls.find((u) => u.includes("/timelines/home?"))!,
      ).searchParams.get("max_id"),
      "40",
    );
  } finally {
    await h.finish();
  }
});
test("sparse author history returns a continuation after three pages instead of scanning without a bound", async () => {
  let pages = 0;
  const h = await harness((async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/accounts/20")) return Response.json({ id: "20" });
    if (u.pathname.endsWith("/statuses")) return Response.json([]);
    pages++;
    const next = Number(u.searchParams.get("max_id") || 0) + 1;
    return Response.json([{ id: String(next), account: { id: "21" } }], {
      headers: {
        link: `<https://wordpress.example.com/api/v1/timelines/home?max_id=${next}>; rel="next"`,
      },
    });
  }) as typeof fetch);
  try {
    h.seed();
    h.db.run(
      "INSERT INTO secrets VALUES(?,?)",
      "connection",
      seal({ access_token: "test-token", account: { id: "10" } }, h.c.key),
    );
    const first = await h.request("/wordpress/author/20");
    assert.deepEqual(first.data.posts, []);
    assert.equal(first.data.next, "home:3");
    assert.equal(pages, 3);
    const next = await h.request(
      "/wordpress/author/20?cursor=" + first.data.next,
    );
    assert.deepEqual(next.data.posts, []);
    assert.equal(next.data.next, "home:6");
    assert.equal(pages, 6);
  } finally {
    await h.finish();
  }
});
