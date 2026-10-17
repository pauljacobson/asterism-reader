import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { hash, unseal } from "../src/server/security.js";

// Optional integration test. Start a disposable Studio site with the official
// Enable Mastodon Apps plugin active. Never run against a user's actual site.
// ASTERISM_TEST_WORDPRESS_PATH=/absolute/local/site npm test
const sitePath = process.env.ASTERISM_TEST_WORDPRESS_PATH;
test(
  "connect and disconnect with real unmodified WordPress EMA",
  { skip: !sitePath },
  async () => {
    const wordpress =
      process.env.ASTERISM_TEST_WORDPRESS_URL || "http://localhost:8887";
    const target = new URL(wordpress);
    assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
    assert.equal(target.protocol, "http:");
    assert.equal(target.origin, wordpress);
    const c = {
      ...configuration({
        APP_ORIGIN: "http://localhost:4321",
        ENCRYPTION_KEY: "a".repeat(64),
        OWNER_INVITE_HASH: hash("test-invite"),
        OWNER_INVITE_EXPIRES_AT: "2099-01-01T00:00:00Z",
        DATABASE_PATH: ":memory:",
      }),
      wordpress,
    };
    const db = new Store(":memory:");
    const calls: string[] = [];
    // Observe request paths without replacing any real HTTP responses or logging secrets.
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(new URL(String(input)).pathname);
      return fetch(input, init);
    };
    const { app } = createApp(c, db, fetcher);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const port = (server.address() as { port: number }).port;
    let cookie = "",
      csrf = "";
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          ...(body
            ? {
                "content-type": "application/json",
                origin: c.origin,
                "x-csrf-token": csrf,
              }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      const set = response.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return response;
    };
    const scratch = mkdtempSync(join(tmpdir(), "asterism-wordpress-test-"));
    let sequence = 0;
    // WP-CLI seeds authorization codes using the actual bundled OAuth issuer and
    // real WordPress database. Browser consent/passkey ceremonies are out of scope.
    const php = (body: string) => {
      const file = join(scratch, `fixture-${++sequence}.php`);
      writeFileSync(
        file,
        `<?php\nif (!in_array(parse_url(home_url(), PHP_URL_HOST), ['localhost','127.0.0.1'], true)) { throw new Exception('Disposable local sites only'); }\n${body}`,
        { mode: 0o600 },
      );
      return execFileSync(
        "studio",
        ["wp", "eval-file", file, "--path", sitePath!],
        { encoding: "utf8", timeout: 60_000 },
      ).trim();
    };
    const phpJson = (value: unknown) =>
      `json_decode(base64_decode('${Buffer.from(JSON.stringify(value)).toString("base64")}'), true)`;
    const issue = (clientId: string, redirect: string, challenge: string) =>
      php(`
    $i=${phpJson({ clientId, redirect, challenge })};
    $s=new \\Enable_Mastodon_Apps\\OAuth2\\Authorization_Code_Storage();
    $issuer=new \\OAuth2\\ResponseType\\AuthorizationCode($s);
    echo $issuer->createAuthorizationCode($i['clientId'],1,$i['redirect'],'read',$i['challenge'],'S256');
  `);
    try {
      const initial = await (await request("/session")).json();
      csrf = initial.csrf;
      db.run(
        "INSERT INTO owner(singleton,uid,setup) VALUES(1,?,1)",
        "local-test-owner",
      );
      db.run(
        "UPDATE sessions SET uid=?,phase='full',recent=?",
        "local-test-owner",
        Date.now(),
      );
      const connect = await request("/wordpress/connect", {});
      assert.equal(connect.status, 200);
      const authorize = new URL((await connect.json()).url);
      assert.equal(authorize.origin, wordpress);
      const client = unseal<{ client_id: string; client_secret: string }>(
        db.get("SELECT value FROM secrets WHERE name='client'")!.value,
        c.key,
      );
      const redirect = authorize.searchParams.get("redirect_uri")!;
      const challenge = authorize.searchParams.get("code_challenge")!;
      assert.ok(challenge);
      assert.ok(
        !db
          .get("SELECT value FROM secrets WHERE name='client'")!
          .value.includes(client.client_secret),
      );

      // Real upstream confidential-client and redirect checks, with separate codes.
      for (const invalid of [
        "wrong-secret",
        "missing-secret",
        "wrong-redirect",
      ]) {
        const code = issue(client.client_id, redirect, challenge);
        const body = new URLSearchParams({
          client_id: client.client_id,
          grant_type: "authorization_code",
          code,
          redirect_uri:
            invalid === "wrong-redirect" ? c.origin + "/incorrect" : redirect,
        });
        if (invalid !== "missing-secret")
          body.set(
            "client_secret",
            invalid === "wrong-secret"
              ? "invalid-secret"
              : client.client_secret,
          );
        const response = await fetch(wordpress + "/oauth/token", {
          method: "POST",
          body,
          redirect: "error",
        });
        assert.ok(
          !response.ok,
          `${invalid} must be rejected by the real plugin`,
        );
        const result = await response.json();
        assert.ok(
          !result.access_token,
          `${invalid} must not issue an access token`,
        );
      }

      const code = issue(client.client_id, redirect, challenge);
      const callback =
        "/wordpress/callback?" +
        new URLSearchParams({
          state: authorize.searchParams.get("state")!,
          code,
        });
      const result = await request(callback);
      assert.equal(result.status, 302);
      assert.equal(result.headers.get("location"), "/?connection=success");
      assert.equal(
        calls.filter((p) => p === "/oauth/token").length,
        1,
        "one correct exchange, no destructive PKCE probe",
      );
      assert.ok(calls.includes("/api/v1/apps"));
      assert.ok(calls.includes("/api/v1/accounts/verify_credentials"));
      const encrypted = db.get(
        "SELECT value FROM secrets WHERE name='connection'",
      )!.value;
      const connection = unseal<{
        access_token: string;
        account: { id: string };
      }>(encrypted, c.key);
      assert.ok(connection.account.id);
      assert.ok(!encrypted.includes(connection.access_token));
      const session = await (await request("/session")).text();
      assert.ok(!session.includes(connection.access_token));
      assert.ok(!session.includes(client.client_secret));
      assert.equal(
        (await request(callback)).status,
        400,
        "callback state is consumed once",
      );
      const replay = await fetch(wordpress + "/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          ...client,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirect,
        }),
        redirect: "error",
      });
      assert.ok(!replay.ok, "upstream authorization code is consumed once");
      const feed = await request("/wordpress/feed");
      assert.equal(feed.status, 200);
      assert.ok(Array.isArray((await feed.json()).posts));
      const disconnect = await request("/wordpress/disconnect", {});
      assert.equal(disconnect.status, 200);
      assert.equal(
        db.get("SELECT value FROM secrets WHERE name='connection'"),
        undefined,
      );
      assert.ok(calls.includes("/oauth/revoke"));
      assert.equal(
        php(
          `$i=${phpJson({ token: connection.access_token })}; $s=new \\Enable_Mastodon_Apps\\OAuth2\\Access_Token_Storage(); echo $s->getAccessToken($i['token']) === null ? 'revoked' : 'still-present';`,
        ),
        "revoked",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.db.close();
    }
  },
);
