import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the real shell entrypoint without Docker or privileged mutations.
// Stub only identity/permission switching; config validation and files are real.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "asterism-container-"));
  const bin = join(directory, "bin");
  const operations = join(directory, "operations");
  mkdirSync(bin);
  for (const [name, body] of Object.entries({
    id: 'echo "${TEST_UID:-0}"',
    chown: 'printf "chown %s\\n" "$*" >> "$TEST_OPERATIONS"',
    chmod: 'printf "chmod %s\\n" "$*" >> "$TEST_OPERATIONS"',
    gosu: 'printf "gosu %s\\n" "$*" >> "$TEST_OPERATIONS"',
  }))
    writeFileSync(join(bin, name), "#!/bin/sh\n" + body + "\n", {
      mode: 0o700,
    });
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    TEST_OPERATIONS: operations,
    NODE_ENV: "production",
    APP_ORIGIN: "https://reader.example.com",
    WORDPRESS_URL: "https://wordpress.example.com",
    ENCRYPTION_KEY: "a".repeat(64),
    OWNER_INVITE_HASH: "b".repeat(64),
    OWNER_INVITE_EXPIRES_AT: "2099-01-01T00:00:00Z",
    DATABASE_PATH: join(directory, "private volume", "custom.sqlite"),
  };
  return {
    directory,
    env,
    operations,
    run: (overrides = {}) =>
      spawnSync(
        "/bin/sh",
        [
          resolve("scripts/container-entrypoint.sh"),
          "node",
          "dist/server/index.js",
        ],
        { env: { ...env, ...overrides }, encoding: "utf8" },
      ),
  };
}

test(
  "container startup prepares custom database and log files, then drops privileges",
  { skip: process.platform === "win32" },
  () => {
    const f = fixture();
    const volume = join(f.directory, "private volume");
    mkdirSync(volume);
    for (const name of ["custom.sqlite", "logs.sqlite"]) {
      for (const suffix of ["", "-wal", "-shm"])
        writeFileSync(join(volume, name + suffix), "fixture");
    }
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const operations = readFileSync(f.operations, "utf8");
    assert.ok(operations.includes("chmod 700 " + volume));
    for (const name of ["custom.sqlite", "logs.sqlite"]) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const path = join(volume, name + suffix);
        assert.ok(operations.includes("chown node:node " + path));
        assert.ok(operations.includes("chmod 600 " + path));
        assert.equal(readFileSync(path, "utf8"), "fixture");
      }
    }
    assert.ok(operations.endsWith("gosu node node dist/server/index.js\n"));
  },
);

test(
  "invalid configuration and normalized system-directory paths stop before permission changes",
  { skip: process.platform === "win32" },
  () => {
    for (const overrides of [
      { WORDPRESS_URL: "" },
      { DATABASE_PATH: "./relative.sqlite" },
      { DATABASE_PATH: "/data/../account.sqlite" },
    ]) {
      const f = fixture();
      assert.notEqual(f.run(overrides).status, 0);
      assert.equal(existsSync(f.operations), false);
    }
  },
);
