import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { configuration } from "../src/server/config.js";

const run = (script: string, args: string[], cwd: string) =>
  spawnSync(process.execPath, [resolve("scripts", script), ...args], {
    cwd,
    encoding: "utf8",
  });

test("local and production setup create separate valid secrets and private invitations without exposing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "asterism-setup-"));
  const local = run(
    "init-local.mjs",
    ["https://wp.example.net/blog/"],
    directory,
  );
  assert.equal(local.status, 0, local.stderr);
  const production = run(
    "init-production.mjs",
    ["https://reader.example.org", "https://wp.example.net/blog"],
    directory,
  );
  assert.equal(production.status, 0, production.stderr);
  const environments = [];
  for (const [envFile, linkFile, origin] of [
    [".env", "work/local-setup-url.txt", "http://localhost:4320"],
    [
      "work/production.env",
      "work/production-setup-url.txt",
      "https://reader.example.org",
    ],
  ]) {
    const vars = parseEnv(readFileSync(join(directory, envFile), "utf8"));
    const c = configuration(vars);
    environments.push(vars);
    const link = new URL(
      readFileSync(join(directory, linkFile), "utf8").trim(),
    );
    const invite = new URLSearchParams(link.hash.slice(1)).get("setup")!;
    assert.equal(link.origin, origin);
    assert.equal(c.origin, origin);
    assert.equal(c.wordpress, "https://wp.example.net/blog");
    assert.equal(
      c.bootstrapHash,
      createHash("sha256").update(invite).digest("hex"),
    );
    assert.ok(c.inviteExpires > Date.now() + 23 * 3600_000);
    assert.ok(c.inviteExpires <= Date.now() + 24 * 3600_000);
    for (const output of [
      local.stdout,
      local.stderr,
      production.stdout,
      production.stderr,
    ]) {
      assert.ok(!output.includes(invite));
      assert.ok(!output.includes(vars.ENCRYPTION_KEY));
    }
    if (process.platform !== "win32") {
      assert.equal(statSync(join(directory, envFile)).mode & 0o777, 0o600);
      assert.equal(statSync(join(directory, linkFile)).mode & 0o777, 0o600);
    }
  }
  assert.notEqual(
    environments[0].ENCRYPTION_KEY,
    environments[1].ENCRYPTION_KEY,
  );
  assert.notEqual(
    environments[0].OWNER_INVITE_HASH,
    environments[1].OWNER_INVITE_HASH,
  );
  const original = readFileSync(join(directory, ".env"), "utf8");
  assert.notEqual(
    run("init-local.mjs", ["https://other.example.com"], directory).status,
    0,
  );
  assert.equal(readFileSync(join(directory, ".env"), "utf8"), original);
});

test("setup rejects missing arguments, insecure production origins and existing invitations before writing configuration", () => {
  for (const args of [
    [],
    ["http://localhost:4320", "https://wp.example.org"],
    ["https://reader.example.org", "http://wp.example.org"],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "asterism-invalid-setup-"));
    assert.notEqual(run("init-production.mjs", args, directory).status, 0);
    assert.equal(existsSync(join(directory, "work/production.env")), false);
  }
  const directory = mkdtempSync(join(tmpdir(), "asterism-existing-setup-"));
  mkdirSync(join(directory, "work"));
  writeFileSync(
    join(directory, "work/local-setup-url.txt"),
    "existing private link",
  );
  assert.notEqual(
    run("init-local.mjs", ["https://wp.example.org"], directory).status,
    0,
  );
  assert.equal(existsSync(join(directory, ".env")), false);
  assert.equal(
    readFileSync(join(directory, "work/local-setup-url.txt"), "utf8"),
    "existing private link",
  );
});
