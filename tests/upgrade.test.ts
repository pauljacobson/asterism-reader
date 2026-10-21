import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { configuration } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { hash, seal, unseal } from "../src/server/security.js";

test("an existing production database upgrades without reenrollment or losing its connection", async () => {
  const folder = await mkdtemp(join(tmpdir(), "asterism-upgrade-"));
  const path = join(folder, "asterism.sqlite");
  const env = {
    NODE_ENV: "production",
    APP_ORIGIN: "https://reader.example.test",
    WORDPRESS_URL: "https://social.example.test",
    DATABASE_PATH: path,
    ENCRYPTION_KEY: "a".repeat(64),
    OWNER_INVITE_HASH: hash("expired-invitation"),
    OWNER_INVITE_EXPIRES_AT: "2000-01-01T00:00:00Z",
    LOG_LEVEL: "error",
  };
  const config = configuration(env);
  const uid = "existing-owner";
  const sessionToken = "existing-session-token";
  const csrf = "existing-csrf-token";
  const credentialId = Buffer.from("existing-credential").toString("base64url");
  const now = Date.now();
  const preferences = {
    theme: "dark",
    font: "serif",
    size: 22,
    accent: "teal",
  };
  const connection = {
    access_token: "synthetic-existing-token",
    account: { id: "42", display_name: "Example Reader", acct: "reader" },
  };
  const encryptedConnection = seal(connection, config.key);

  // Start from the old schema, not today's Store constructor. This catches
  // migrations that accidentally work only for newly created databases.
  const old = new DatabaseSync(path);
  try {
    old.exec(
      await readFile(
        new URL("./fixtures/legacy-v2.sql", import.meta.url),
        "utf8",
      ),
    );
    old
      .prepare(
        "INSERT INTO owner(singleton,uid,setup,preferences) VALUES(1,?,1,?)",
      )
      .run(uid, JSON.stringify(preferences));
    old
      .prepare("INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?)")
      .run(
        credentialId,
        uid,
        "synthetic-public-key",
        7,
        '["internal"]',
        "Existing passkey",
        now,
        1,
      );
    old
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        hash(sessionToken),
        uid,
        "full",
        csrf,
        now,
        now,
        now,
        now + 3600_000,
        null,
      );
    old
      .prepare("INSERT INTO recovery_codes VALUES(?,?)")
      .run(hash("existing-recovery"), uid);
    old
      .prepare("INSERT INTO secrets VALUES(?,?)")
      .run("connection", encryptedConnection);
    old
      .prepare("INSERT INTO reader_lists VALUES(?,?,?,?)")
      .run("existing-list", uid, "Reading", "reading");
    old
      .prepare("INSERT INTO list_members VALUES(?,?)")
      .run("existing-list", "author@social.example.test");
  } finally {
    old.close();
  }

  let upstreamCalls = 0;
  const upstream: typeof fetch = async (input, init) => {
    // An upgrade must use the existing token only at the operator's original site.
    assert.equal(
      String(input),
      "https://social.example.test/api/v1/timelines/home?limit=30",
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer " + connection.access_token,
    );
    upstreamCalls++;
    return Response.json([]);
  };

  // Exercise both the initial legacy upgrade and a later restart with a new
  // display label. Neither may change credential identity or encrypted tokens.
  let binding: string | undefined;
  for (const ownerName of ["Reader", "New display label"]) {
    const current = configuration({ ...env, OWNER_NAME: ownerName });
    const { app, db, logger } = createApp(current, undefined, upstream);
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      // Keep the pre-upgrade cookie name literal so renaming it breaks this test.
      const headers = { cookie: "__Host-asterism=" + sessionToken };
      const health = await fetch(base + "/healthz");
      assert.equal(health.status, 200);
      const session = await fetch(base + "/api/session", { headers });
      assert.equal(session.status, 200);
      const data = await session.json();
      assert.equal(data.phase, "full");
      assert.equal(data.hasAccount, true);
      assert.deepEqual(data.preferences, preferences);
      assert.deepEqual(data.connection, connection.account);
      assert.equal(data.passkeys[0].id, credentialId);
      assert.equal(data.passkeys[0].name, "Existing passkey");
      const login = await fetch(base + "/api/auth/login/options", {
        method: "POST",
        headers: {
          ...headers,
          origin: current.origin,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ reauth: true }),
      });
      assert.equal(login.status, 200);
      const challenge = await login.json();
      assert.equal(challenge.options.rpId, "reader.example.test");
      assert.equal(challenge.options.allowCredentials[0].id, credentialId);
      assert.equal(
        (await fetch(base + "/api/wordpress/feed", { headers })).status,
        200,
      );

      assert.equal(db.get("SELECT uid FROM owner")!.uid, uid);
      assert.equal(db.get("SELECT counter FROM credentials")!.counter, 7);
      assert.equal(db.get("SELECT count(*) AS n FROM recovery_codes")!.n, 1);
      assert.equal(db.get("SELECT title FROM reader_lists")!.title, "Reading");
      assert.equal(
        db.get("SELECT account_key FROM list_members")!.account_key,
        "author@social.example.test",
      );
      assert.equal(
        db.get("SELECT value FROM secrets WHERE name='connection'")!.value,
        encryptedConnection,
      );
      const saved = db.get(
        "SELECT value FROM secrets WHERE name='deployment'",
      )!.value;
      assert.deepEqual(unseal(saved, current.key), {
        origin: current.origin,
        wordpress: current.wordpress,
      });
      if (binding) assert.equal(saved, binding);
      binding = saved;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.db.close();
      logger.close();
    }
  }
  assert.equal(upstreamCalls, 2);
});
