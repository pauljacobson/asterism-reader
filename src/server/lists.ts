import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { HttpError, security } from "./security.js";
import { accountHandle, accountIdentity } from "../shared/identity.js";

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v));
const nameKey = (v: string) => v.normalize("NFKC").toLowerCase();
type Membership = { title: string; name: string; key: string };

// A bounded RFC 4180 reader accepts Mastodon's headerless, two-column CSV.
// Reject the entire file on malformed input rather than partially importing it.
export function parseListCsv(csv: string): Membership[] {
  if (!csv.trim() || Buffer.byteLength(csv) > 256_000)
    throw new HttpError(
      400,
      "Choose a non-empty lists.csv file smaller than 256 KB.",
    );
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const finish = () => {
    row.push(field);
    if (row.some((v) => v.trim())) rows.push(row);
    row = [];
    field = "";
    closed = false;
  };
  const source = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === "," || c === "\n" || c === "\r") {
      if (c === ",") {
        row.push(field);
        field = "";
        closed = false;
      } else {
        finish();
        if (c === "\r" && source[i + 1] === "\n") i++;
      }
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"')
      throw new HttpError(
        400,
        "Malformed CSV quoting near row " + (rows.length + 1) + ".",
      );
    else field += c;
    if (rows.length > 10_000 || row.length > 2)
      throw new HttpError(
        400,
        "The list export is too large or has extra columns.",
      );
  }
  if (quoted) throw new HttpError(400, "The CSV ends inside a quoted field.");
  finish();
  if (rows.length > 10_000)
    throw new HttpError(400, "The list export has too many rows.");
  if (
    rows[0]?.[0].toLowerCase() === "list" &&
    rows[0]?.[1]?.toLowerCase() === "account address"
  )
    rows.shift();
  const unique = new Map<string, Membership>();
  rows.forEach((r, i) => {
    const title = titleSchema.safeParse(r[0]),
      key = accountHandle(r[1]);
    if (r.length !== 2 || !title.success || !key)
      throw new HttpError(
        400,
        `Invalid list name or account address on row ${i + 1}. No lists were changed.`,
      );
    const name = nameKey(title.data);
    unique.set(JSON.stringify([name, key]), { title: title.data, name, key });
  });
  if (!unique.size)
    throw new HttpError(400, "No list memberships found in this file.");
  if (new Set([...unique.values()].map((r) => r.name)).size > 200)
    throw new HttpError(400, "A maximum of 200 lists can be imported.");
  return [...unique.values()];
}

export class ReaderLists {
  constructor(readonly db: Store) {}
  list(uid: string, id: string) {
    const row = this.db.get(
      "SELECT * FROM reader_lists WHERE uid=? AND id=?",
      uid,
      id,
    );
    if (!row) throw new HttpError(404, "List not found.");
    return row;
  }
  all(uid: string) {
    return this.db
      .all(
        `SELECT l.id,l.title,COUNT(m.account_key) AS total,COUNT(f.account_key) AS matched
      FROM reader_lists l LEFT JOIN list_members m ON m.list_id=l.id
      LEFT JOIN list_follows f ON f.uid=l.uid AND f.account_key=m.account_key
      WHERE l.uid=? GROUP BY l.id ORDER BY l.title COLLATE NOCASE`,
        uid,
      )
      .map((l) => ({ ...l, pending: l.total - l.matched }));
  }
  create(uid: string, title: string) {
    const name = nameKey(title);
    if (
      this.db.get(
        "SELECT id FROM reader_lists WHERE uid=? AND name_key=?",
        uid,
        name,
      )
    )
      throw new HttpError(409, "A list with this name already exists.");
    if (this.all(uid).length >= 200)
      throw new HttpError(400, "You can have up to 200 lists.");
    const id = randomUUID();
    this.db.run(
      "INSERT INTO reader_lists VALUES(?,?,?,?)",
      id,
      uid,
      title,
      name,
    );
    return id;
  }
  directory(uid: string) {
    return this.db
      .all(
        "SELECT account_key AS key,account FROM list_follows WHERE uid=? ORDER BY account_key",
        uid,
      )
      .map((r) => ({ key: r.key, account: JSON.parse(r.account) }));
  }
  detail(uid: string, id: string) {
    const list = this.list(uid, id);
    const members = this.db
      .all(
        `SELECT m.account_key AS key,f.account FROM list_members m LEFT JOIN list_follows f ON f.uid=? AND f.account_key=m.account_key WHERE m.list_id=? ORDER BY m.account_key`,
        uid,
        id,
      )
      .map((m) => ({
        key: m.key,
        account: m.account ? JSON.parse(m.account) : null,
      }));
    return { id, title: list.title, members };
  }
  preview(uid: string, rows: Membership[]) {
    const current = new Set(this.directory(uid).map((a) => a.key));
    const pending = new Map<string, string[]>();
    let matched = 0;
    for (const r of rows) {
      if (current.has(r.key)) matched++;
      else pending.set(r.key, [...(pending.get(r.key) || []), r.title]);
    }
    return {
      lists: new Set(rows.map((r) => r.name)).size,
      memberships: rows.length,
      accounts: new Set(rows.map((r) => r.key)).size,
      matched,
      unmatched: [...pending].map(([key, lists]) => ({ key, lists })),
    };
  }
  import(uid: string, rows: Membership[]) {
    return this.db.atomic(() => {
      let added = 0,
        created = 0,
        skipped = 0;
      const ids = new Map<string, string | null>();
      for (const row of rows) {
        if (!ids.has(row.name)) {
          const alias = this.db.get(
            "SELECT list_id FROM list_sources WHERE uid=? AND name_key=?",
            uid,
            row.name,
          );
          let id: string | null;
          if (alias) id = alias.list_id;
          else {
            id =
              this.db.get(
                "SELECT id FROM reader_lists WHERE uid=? AND name_key=?",
                uid,
                row.name,
              )?.id || null;
            if (!id) {
              id = this.create(uid, row.title);
              created++;
            }
            this.db.run(
              "INSERT INTO list_sources VALUES(?,?,?)",
              uid,
              row.name,
              id,
            );
          }
          ids.set(row.name, id);
        }
        const first = this.db.run(
          "INSERT OR IGNORE INTO list_imported VALUES(?,?,?)",
          uid,
          row.name,
          row.key,
        ).changes;
        const id = ids.get(row.name);
        // History and source aliases survive removal, rename, and deletion.
        // Re-imports cannot resurrect an intentionally removed membership/list.
        if (first && id)
          added += Number(
            this.db.run(
              "INSERT OR IGNORE INTO list_members VALUES(?,?)",
              id,
              row.key,
            ).changes,
          );
        else skipped++;
      }
      return { ...this.preview(uid, rows), added, created, skipped };
    });
  }
  matches(uid: string, id: string, origin: string) {
    this.list(uid, id);
    const keys = new Set(this.detail(uid, id).members.map((m) => m.key));
    const ids = new Set(
      this.directory(uid)
        .filter((a) => keys.has(a.key))
        .map((a) => String(a.account.id)),
    );
    // A boost belongs to the followed person who shared it (the outer account).
    return (post: any) =>
      keys.has(accountIdentity(post?.account, origin) || "") ||
      ids.has(String(post?.account?.id));
  }
}

type FollowPage = (
  cursor: string | null,
) => Promise<{ accounts: any[]; next: string | null }>;
export function listsRouter(
  db: Store,
  sec: ReturnType<typeof security>,
  origin: string,
  following: FollowPage,
) {
  const r = Router(),
    store = new ReaderLists(db);
  r.use(sec.full);
  r.get("/", (req, res) =>
    res.json({
      lists: store.all(req.session.uid!),
      synced:
        db.get("SELECT completed FROM list_sync WHERE uid=?", req.session.uid!)
          ?.completed || null,
    }),
  );
  r.get("/directory", (req, res) =>
    res.json({ accounts: store.directory(req.session.uid!) }),
  );
  r.get("/memberships", (req, res) => {
    const key = z.string().min(1).max(4096).parse(req.query.key);
    res.json({
      ids: db
        .all(
          "SELECT l.id FROM reader_lists l JOIN list_members m ON m.list_id=l.id WHERE l.uid=? AND m.account_key=?",
          req.session.uid!,
          key,
        )
        .map((r) => r.id),
    });
  });
  r.post("/sync", async (req, res) => {
    const uid = req.session.uid!;
    sec.limit("lists-sync:" + uid, 240, 60_000);
    const input = z.object({ run: z.uuid().optional() }).parse(req.body);
    let state = db.get("SELECT * FROM list_sync WHERE uid=?", uid);
    if (!input.run) {
      const run = randomUUID();
      db.run(
        "INSERT INTO list_sync(uid,run,cursor,visited,completed) VALUES(?,?,NULL,'[]',NULL) ON CONFLICT(uid) DO UPDATE SET run=excluded.run,cursor=NULL,visited='[]'",
        uid,
        run,
      );
      state = db.get("SELECT * FROM list_sync WHERE uid=?", uid)!;
    } else if (
      !state ||
      state.run !== input.run ||
      (!state.cursor && JSON.parse(state.visited).length)
    )
      throw new HttpError(
        409,
        "This follow refresh has ended. Start a new refresh.",
      );
    const run = state!.run,
      visited: string[] = JSON.parse(state!.visited);
    if (visited.length >= 200)
      throw new HttpError(
        502,
        "WordPress returned too many follow pages. Previous matches have been retained.",
      );
    const page = await following(state!.cursor);
    sec.alive(req.session);
    const latest = db.get("SELECT * FROM list_sync WHERE uid=?", uid);
    if (
      !latest ||
      latest.run !== run ||
      latest.cursor !== state!.cursor ||
      latest.visited !== state!.visited
    )
      throw new HttpError(
        409,
        "A newer follow refresh has started or this page was already processed.",
      );
    if (
      !Array.isArray(page.accounts) ||
      (page.next &&
        (visited.includes(page.next) || page.next === state!.cursor))
    )
      throw new HttpError(
        502,
        "WordPress returned an invalid follow page. Try Refresh follows again.",
      );
    db.atomic(() => {
      for (const a of page.accounts) {
        const key = accountIdentity(a, origin);
        if (!key || !a?.id) continue;
        const account = Object.fromEntries(
          [
            "id",
            "acct",
            "display_name",
            "username",
            "url",
            "avatar",
            "avatar_static",
          ].map((k) => [k, String(a[k] || "").slice(0, 2048)]),
        );
        db.run(
          "INSERT INTO list_follows VALUES(?,?,?,?) ON CONFLICT(uid,account_key) DO UPDATE SET account=excluded.account,seen=excluded.seen",
          uid,
          key,
          JSON.stringify(account),
          run,
        );
      }
      visited.push(state!.cursor || "first");
      // A failed/partial refresh must never drop matches from previous pages.
      if (!page.next)
        db.run("DELETE FROM list_follows WHERE uid=? AND seen<>?", uid, run);
      db.run(
        "UPDATE list_sync SET cursor=?,visited=?,completed=CASE WHEN ? IS NULL THEN ? ELSE completed END WHERE uid=? AND run=?",
        page.next,
        JSON.stringify(visited),
        page.next,
        Date.now(),
        uid,
        run,
      );
    });
    res.json({
      run,
      complete: !page.next,
      count: db.get(
        "SELECT COUNT(*) AS n FROM list_follows WHERE uid=? AND seen=?",
        uid,
        run,
      )!.n,
    });
  });
  for (const preview of [true, false])
    r.post(preview ? "/import/preview" : "/import", (req, res) => {
      sec.limit("lists-import:" + req.session.uid, 20, 60_000);
      const csv = z
        .object({ csv: z.string().max(256_000) })
        .parse(req.body).csv;
      const rows = parseListCsv(csv);
      res.json(
        preview
          ? store.preview(req.session.uid!, rows)
          : store.import(req.session.uid!, rows),
      );
    });
  r.post("/", (req, res) => {
    const title = titleSchema.parse(req.body.title);
    res.json({ id: store.create(req.session.uid!, title) });
  });
  r.get("/:id", (req, res) =>
    res.json(store.detail(req.session.uid!, z.uuid().parse(req.params.id))),
  );
  r.put("/:id", (req, res) => {
    const uid = req.session.uid!,
      id = z.uuid().parse(req.params.id),
      title = titleSchema.parse(req.body.title);
    store.list(uid, id);
    if (
      db.get(
        "SELECT id FROM reader_lists WHERE uid=? AND name_key=? AND id<>?",
        uid,
        nameKey(title),
        id,
      )
    )
      throw new HttpError(409, "A list with this name already exists.");
    db.run(
      "UPDATE reader_lists SET title=?,name_key=? WHERE uid=? AND id=?",
      title,
      nameKey(title),
      uid,
      id,
    );
    res.json({ ok: true });
  });
  r.delete("/:id", (req, res) => {
    const id = z.uuid().parse(req.params.id);
    store.list(req.session.uid!, id);
    db.run(
      "DELETE FROM reader_lists WHERE uid=? AND id=?",
      req.session.uid!,
      id,
    );
    res.json({ ok: true });
  });
  r.put("/:id/members", (req, res) => {
    const id = z.uuid().parse(req.params.id),
      uid = req.session.uid!;
    store.list(uid, id);
    const { key, present } = z
      .object({ key: z.string().min(1).max(4096), present: z.boolean() })
      .parse(req.body);
    if (present) {
      if (
        !db.get(
          "SELECT 1 FROM list_follows WHERE uid=? AND account_key=?",
          uid,
          key,
        )
      )
        throw new HttpError(
          400,
          "Refresh follows and choose a followed account first.",
        );
      db.run("INSERT OR IGNORE INTO list_members VALUES(?,?)", id, key);
    } else
      db.run(
        "DELETE FROM list_members WHERE list_id=? AND account_key=?",
        id,
        key,
      );
    res.json({ ok: true });
  });
  r.post("/:id/resolve", (req, res) => {
    const uid = req.session.uid!,
      id = z.uuid().parse(req.params.id);
    store.list(uid, id);
    const input = z
      .object({ from: z.string().max(4096), to: z.string().max(4096) })
      .parse(req.body);
    if (
      !db.get(
        "SELECT 1 FROM list_members WHERE list_id=? AND account_key=?",
        id,
        input.from,
      ) ||
      !db.get(
        "SELECT 1 FROM list_follows WHERE uid=? AND account_key=?",
        uid,
        input.to,
      )
    )
      throw new HttpError(
        400,
        "Choose an existing membership and a followed account.",
      );
    db.atomic(() => {
      db.run(
        "DELETE FROM list_members WHERE list_id=? AND account_key=?",
        id,
        input.from,
      );
      db.run("INSERT OR IGNORE INTO list_members VALUES(?,?)", id, input.to);
    });
    res.json({ ok: true });
  });
  return r;
}
