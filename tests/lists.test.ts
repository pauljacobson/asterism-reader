import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/server/store.js";
import { ReaderLists, parseListCsv } from "../src/server/lists.js";
import { accountHandle, accountIdentity } from "../src/shared/identity.js";
import { createApp } from "../src/server/app.js";
import { configuration } from "../src/server/config.js";
import { hash, seal, token } from "../src/server/security.js";

test("Mastodon CSV supports quoted names, BOM/CRLF, multiple lists and canonical identities; malformed files fail as a whole", () => {
  const rows = parseListCsv(
    '\uFEFF"Science, space",@Alice@EXAMPLE.org\r\n"People ""I read""",alice@example.org\r\n"Science, space",alice@example.org\r\n',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Science, space");
  assert.equal(rows[1].title, 'People "I read"');
  assert.ok(rows.every((r) => r.key === "alice@example.org"));
  assert.equal(
    accountHandle("local", "https://site.example"),
    "local@site.example",
  );
  assert.equal(accountHandle("https://evil.example"), null);
  assert.equal(
    accountIdentity(
      { id: "4", url: "https://rss.example/feed" },
      "https://site.example",
    ),
    "profile:https://rss.example/feed",
  );
  for (const csv of [
    "",
    "A,a@example.org\nB,not a handle",
    '"bad,a@example.org',
    "A,a@example.org,extra",
    '"A"oops,a@example.org',
    "A\u0000,a@example.org",
  ])
    assert.throws(
      () => parseListCsv(csv),
      (error: any) => error.status === 400,
    );
});

test("import merges multiple memberships, survives restart, and never resurrects later edits, renamed or deleted lists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asterism-lists-")),
    path = join(dir, "test.sqlite");
  let db = new Store(path);
  db.run("INSERT INTO owner(singleton,uid,setup) VALUES(1,'owner',1)");
  let lists = new ReaderLists(db);
  const rows = parseListCsv(
    "People,a@example.org\nScience,a@example.org\nPeople,b@example.org",
  );
  assert.equal(lists.import("owner", rows).added, 3);
  let all = lists.all("owner");
  const people = all.find((l) => l.title === "People")!.id,
    science = all.find((l) => l.title === "Science")!.id;
  db.run(
    "DELETE FROM list_members WHERE list_id=? AND account_key=?",
    people,
    "a@example.org",
  );
  db.run(
    "UPDATE reader_lists SET title='Scientists',name_key='scientists' WHERE id=?",
    science,
  );
  db.db.close();
  db = new Store(path);
  lists = new ReaderLists(db);
  assert.equal(lists.import("owner", rows).added, 0);
  assert.equal(lists.detail("owner", people).members.length, 1);
  assert.equal(lists.detail("owner", science).title, "Scientists");
  db.run("DELETE FROM reader_lists WHERE id=?", people);
  assert.equal(lists.import("owner", rows).created, 0);
  assert.equal(lists.all("owner").length, 1);
  assert.equal(lists.detail("owner", science).members[0].key, "a@example.org");
  assert.throws(() => lists.detail("different-owner", science));
  db.db.close();
});

async function harness(fetcher: typeof fetch) {
  const db = new Store(":memory:"),
    c = configuration({
      WORDPRESS_URL: "https://wordpress.example.com",
      APP_ORIGIN: "http://localhost:4321",
      ENCRYPTION_KEY: "a".repeat(64),
      OWNER_INVITE_HASH: hash("invite"),
      OWNER_INVITE_EXPIRES_AT: "2099-01-01",
      DATABASE_PATH: ":memory:",
    });
  const { app } = createApp(c, db, fetcher),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/wordpress`,
    raw = token(),
    csrf = token();
  db.run("INSERT INTO owner(singleton,uid,setup) VALUES(1,'owner',1)");
  db.run(
    "INSERT INTO sessions(hash,uid,phase,csrf,created,touched,expires) VALUES(?,'owner','full',?,?,?,?)",
    hash(raw),
    csrf,
    Date.now(),
    Date.now(),
    Date.now() + 100_000,
  );
  db.run(
    "INSERT INTO secrets VALUES('connection',?)",
    seal({ access_token: "fixture", account: { id: "1" } }, c.key),
  );
  const request = async (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    cookie = `asterism=${raw}`,
    extra = {},
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        cookie,
        origin: c.origin,
        "x-csrf-token": csrf,
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return {
    db,
    request,
    finish: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      db.db.close();
    },
  };
}
const json = (data: unknown, next?: string) =>
  new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      ...(next
        ? {
            link: `<https://wordpress.example.com/api/v1/accounts/1/following?max_id=${next}>; rel="next"`,
          }
        : {}),
    },
  });

test("list API enforces authentication/CSRF, refreshes paginated follows, retains unmatched accounts and resolves migrations explicitly", async () => {
  const calls: string[] = [];
  const h = await harness(async (input) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    return u.searchParams.has("max_id")
      ? json([{ id: "b", acct: "b@example.org" }])
      : json([{ id: "a", acct: "a@example.org" }], "second");
  });
  try {
    assert.equal((await h.request("/lists", undefined, "GET", "")).status, 401);
    for (const phase of ["setup", "recovery"]) {
      h.db.run("UPDATE sessions SET phase=? WHERE uid='owner'", phase);
      assert.equal(
        (await h.request("/lists/import", { csv: "A,a@example.org" })).status,
        401,
      );
    }
    h.db.run("UPDATE sessions SET phase='full' WHERE uid='owner'");
    assert.equal(
      (
        await h.request("/lists", { title: "Denied" }, "POST", undefined, {
          "x-csrf-token": "wrong",
        })
      ).status,
      403,
    );
    const csv =
      "People,a@example.org\nScience,a@example.org\nPeople,old@example.org";
    assert.equal(
      (await h.request("/lists/import/preview", { csv })).data.unmatched.length,
      2,
    );
    assert.equal((await h.request("/lists/import", { csv })).data.added, 3);
    const first = (await h.request("/lists/sync", {})).data;
    assert.equal(first.complete, false);
    assert.equal(
      (await h.request("/lists/sync", { run: first.run })).data.complete,
      true,
    );
    assert.equal(
      (await h.request("/lists/sync", { run: first.run })).status,
      409,
    );
    const lists = (await h.request("/lists")).data.lists,
      people = lists.find((l: any) => l.title === "People");
    assert.equal(people.matched, 1);
    assert.equal(people.pending, 1);
    assert.equal(
      (await h.request("/following?list=" + people.id)).data.accounts.length,
      1,
    );
    assert.equal(
      (
        await h.request(
          `/lists/${people.id}/members`,
          { key: "not-followed@example.org", present: true },
          "PUT",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(`/lists/${people.id}/resolve`, {
          from: "old@example.org",
          to: "b@example.org",
        })
      ).status,
      200,
    );
    await h.request("/lists/import", { csv });
    const members = (await h.request("/lists/" + people.id)).data.members;
    assert.deepEqual(
      members.map((m: any) => m.key),
      ["a@example.org", "b@example.org"],
    );
    assert.equal(
      (await h.request("/lists/memberships?key=a%40example.org")).data.ids
        .length,
      2,
    );
    assert.ok(
      calls.every((p) => p.endsWith("/following")),
      "No follow or other upstream mutation is sent",
    );
  } finally {
    await h.finish();
  }
});

test("sparse list timelines continue through older pages, include shares by members and reject another list ID", async () => {
  let calls = 0;
  const h = await harness(async (input) => {
    calls++;
    const page = Number(new URL(String(input)).searchParams.get("max_id") || 0);
    const account =
      page === 3
        ? { id: "a", acct: "a@example.org" }
        : { id: "other", acct: "other@example.org" };
    const data = [
      {
        id: String(100 - page),
        account,
        reblog: { id: "original", account: { acct: "outside@example.org" } },
      },
    ];
    return new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json",
        link: `<https://wordpress.example.com/api/v1/timelines/home?max_id=${page + 1}>; rel="next"`,
      },
    });
  });
  try {
    const lists = new ReaderLists(h.db);
    lists.import("owner", parseListCsv("People,a@example.org"));
    const id = lists.all("owner")[0].id;
    const first = await h.request("/feed?list=" + id);
    assert.deepEqual(first.data.posts, []);
    assert.equal(first.data.next, "3");
    assert.equal(calls, 3);
    const second = await h.request("/feed?list=" + id + "&cursor=3");
    assert.equal(second.data.posts.length, 1);
    assert.equal(calls, 4);
    assert.equal(
      (await h.request("/feed?list=00000000-0000-4000-8000-000000000000"))
        .status,
      404,
    );
  } finally {
    await h.finish();
  }
});

test("a failed partial follow refresh never erases previous matches", async () => {
  const h = await harness(async (input) =>
    new URL(String(input)).searchParams.has("max_id")
      ? new Response("{}", { status: 503 })
      : json([{ id: "a", acct: "a@example.org" }], "second"),
  );
  try {
    h.db.run(
      "INSERT INTO list_follows VALUES('owner','older@example.org','{\"id\":\"older\",\"acct\":\"older@example.org\"}','old-run')",
    );
    const first = (await h.request("/lists/sync", {})).data;
    assert.equal(
      (await h.request("/lists/sync", { run: first.run })).status,
      502,
    );
    assert.equal((await h.request("/lists/directory")).data.accounts.length, 2);
  } finally {
    await h.finish();
  }
});
