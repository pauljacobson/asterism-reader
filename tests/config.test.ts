import { test } from "node:test";
import assert from "node:assert/strict";
import { configuration } from "../src/server/config.js";
import { bindDeployment } from "../src/server/deployment.js";
import { Store } from "../src/server/store.js";

const env = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://reader.example.net",
  WORDPRESS_URL: "https://social.example.org/blog/",
  ENCRYPTION_KEY: "a".repeat(64),
  OWNER_INVITE_HASH: "b".repeat(64),
  OWNER_INVITE_EXPIRES_AT: "2099-01-01T00:00:00Z",
  DATABASE_PATH: "/var/lib/asterism/account.sqlite",
};

test("independent deployments configure site, RP identity, account label, port and storage", () => {
  const c = configuration({ ...env, OWNER_NAME: "Alex Reader", PORT: "8080" });
  assert.equal(c.wordpress, "https://social.example.org/blog");
  assert.equal(c.rpId, "reader.example.net");
  assert.equal(c.ownerName, "Alex Reader");
  assert.equal(c.port, 8080);
  assert.equal(c.dbPath, env.DATABASE_PATH);
  assert.equal(c.logPath, "/var/lib/asterism/logs.sqlite");
  assert.equal(c.cookie, "__Host-asterism");
  assert.equal(configuration(env).ownerName, "Reader");
});

test("WordPress configuration requires an explicit secure URL and rejects credential-bearing or ambiguous URLs", () => {
  for (const wordpress of [
    undefined,
    "",
    "not a url",
    "http://social.example.org",
    "http://localhost:8887",
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://example.com/?token=secret",
    "https://example.com/#part",
  ]) {
    assert.throws(
      () => configuration({ ...env, WORDPRESS_URL: wordpress }),
      /WORDPRESS_URL/,
    );
  }
});

test("development permits only loopback HTTP WordPress endpoints and preserves subdirectories", () => {
  for (const wordpress of [
    "http://localhost:8887/blog/",
    "http://127.0.0.1:8887/",
    "http://[::1]:8887/",
  ]) {
    assert.equal(
      configuration({
        ...env,
        NODE_ENV: "development",
        WORDPRESS_URL: wordpress,
      }).wordpress,
      wordpress.slice(0, -1),
    );
  }
  assert.throws(
    () =>
      configuration({
        ...env,
        NODE_ENV: "development",
        WORDPRESS_URL: "http://private.example.com",
      }),
    /WORDPRESS_URL/,
  );
});

test("invalid ports, empty labels, and nonpersistent production paths fail at startup", () => {
  for (const port of ["0", "65536", "NaN", "", "80.5"]) {
    assert.throws(() => configuration({ ...env, PORT: port }));
  }
  for (const name of ["", "   ", "x".repeat(65)]) {
    assert.throws(() => configuration({ ...env, OWNER_NAME: name }));
  }
  for (const path of [":memory:", "./data/account.sqlite"]) {
    assert.throws(
      () => configuration({ ...env, DATABASE_PATH: path }),
      /absolute path/,
    );
  }
  assert.throws(
    () => configuration({ ...env, DATABASE_PATH: "/data/logs.sqlite" }),
    /separate database/,
  );
});

test("deployment binding survives repeated startup and rejects changed endpoints or encryption keys without replacing the record", () => {
  const db = new Store(":memory:");
  try {
    const config = configuration(env);
    bindDeployment(db, config);
    const saved = db.get(
      "SELECT value FROM secrets WHERE name='deployment'",
    )!.value;
    assert.ok(!saved.includes(config.wordpress));
    bindDeployment(db, { ...config, ownerName: "New label" });
    for (const changed of [
      { ...config, wordpress: "https://other.example.com" },
      { ...config, wordpress: "https://social.example.org/other-blog" },
      { ...config, origin: "https://other-reader.example.com" },
      { ...config, key: Buffer.alloc(32, 9) },
    ])
      assert.throws(() => bindDeployment(db, changed));
    assert.equal(
      db.get("SELECT value FROM secrets WHERE name='deployment'")!.value,
      saved,
    );
    bindDeployment(db, config);
  } finally {
    db.db.close();
  }
});
