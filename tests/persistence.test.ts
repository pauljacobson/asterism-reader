import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Store } from "../src/server/store.js";
import { hash, seal, unseal } from "../src/server/security.js";
test("account, recovery codes and encrypted connection survive a restart and an online backup", async () => {
  const folder = await mkdtemp(join(tmpdir(), "asterism-store-")),
    path = join(folder, "test.sqlite"),
    copy = join(folder, "backup.sqlite"),
    key = Buffer.alloc(32, 7);
  const db = new Store(path);
  db.run("INSERT INTO owner(singleton,uid,setup) VALUES(1,?,1)", "test-owner");
  db.run("INSERT INTO recovery_codes VALUES(?,?)", hash("code"), "test-owner");
  db.run(
    "INSERT INTO secrets VALUES(?,?)",
    "connection",
    seal({ access_token: "private-token" }, key),
  );
  await backup(db.db, copy);
  db.db.close();
  const reopened = new Store(path),
    restored = new DatabaseSync(copy);
  try {
    assert.equal(reopened.get("SELECT setup FROM owner")!.setup, 1);
    assert.equal(
      reopened.get("SELECT count(*) AS n FROM recovery_codes")!.n,
      1,
    );
    const secret = restored.prepare("SELECT value FROM secrets").get()!
      .value as string;
    assert.deepEqual(unseal(secret, key), { access_token: "private-token" });
    assert.equal(secret.includes("private-token"), false);
  } finally {
    reopened.db.close();
    restored.close();
  }
});
