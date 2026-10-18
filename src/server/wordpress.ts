import { Router } from "express";
import { canBoost } from "../shared/boost.js";
import { AppLogger, wordpressOperation, failureReason } from "./logging.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import type { Config } from "./config.js";
import { security, token, hash, seal, unseal, HttpError } from "./security.js";
const scopes =
  "read write:follows write:favourites write:bookmarks write:statuses";
type Client = { client_id: string; client_secret: string };
type Connection = {
  access_token: string;
  account: { id: string; display_name: string; acct: string };
};
// Only the configured WordPress origin is fetched. Redirects cannot leak bearer credentials.
export async function wordpressRequest(
  c: Config,
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
) {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Invalid upstream path");
  const response = await fetcher(c.wordpress + path, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5_000_000) {
        await reader.cancel();
        throw new HttpError(502, "The site returned too much data.");
      }
      chunks.push(value);
    }
  }
  let data: any;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(502, "The site returned an unexpected response.");
  }
  return { response, data };
}
export function wordpressRouter(
  db: Store,
  c: Config,
  sec: ReturnType<typeof security>,
  fetcher: typeof fetch = fetch,
  logger?: AppLogger,
) {
  const r = Router();
  r.use(sec.full);
  const getSecret = <T>(name: string) => {
    const row = db.get("SELECT value FROM secrets WHERE name=?", name);
    return row ? unseal<T>(row.value, c.key) : null;
  };
  const putSecret = (name: string, value: unknown) =>
    db.run(
      "INSERT INTO secrets VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      name,
      seal(value, c.key),
    );
  const call = async (path: string, init: RequestInit = {}) => {
    const started = performance.now(),
      operation = wordpressOperation(path);
    try {
      const result = await wordpressRequest(c, path, init, fetcher);
      const count = Array.isArray(result.data) ? result.data.length : undefined;
      logger?.write("upstream", result.response.ok ? "info" : "warn", {
        operation,
        method: init.method || "GET",
        status: result.response.status,
        durationMs: performance.now() - started,
        count,
        ...(!result.response.ok ? { reason: "upstream" } : {}),
      });
      return result;
    } catch (error) {
      logger?.write("upstreamFailed", "error", {
        operation,
        method: init.method || "GET",
        durationMs: performance.now() - started,
        reason: failureReason(error),
      });
      throw error;
    }
  };
  const post = (path: string, body: Record<string, string>) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  async function api(path: string, method = "GET", body?: unknown) {
    const conn = getSecret<Connection>("connection");
    if (!conn)
      throw new HttpError(409, "Connect your WordPress site in Account first.");
    const { response, data } = await call(path, {
      method,
      headers: {
        Authorization: "Bearer " + conn.access_token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      db.run("DELETE FROM secrets WHERE name='connection'");
      throw new HttpError(
        401,
        "WordPress authorization expired. Reconnect in Account.",
      );
    }
    if (!response.ok)
      throw new HttpError(
        502,
        method === "GET"
          ? "WordPress could not load this content. Try again."
          : "WordPress could not confirm this action. Refresh its state before retrying.",
      );
    return { data, link: response.headers.get("link") };
  }
  r.post("/connect", async (req, res) => {
    // The full owner session and CSRF checks already authorize initiation;
    // WordPress handles its own authorization without another Asterism prompt.
    sec.limit("oauth-connect", 10);
    let client = getSecret<Client>("client");
    if (!client) {
      const { response, data } = await post("/api/v1/apps", {
        client_name: "Asterism Reader",
        redirect_uris: c.origin + "/api/wordpress/callback",
        scopes,
        website: c.origin,
      });
      if (!response.ok || !data.client_id || !data.client_secret)
        throw new HttpError(502, "WordPress could not register Asterism.");
      client = {
        client_id: String(data.client_id),
        client_secret: String(data.client_secret),
      };
      sec.alive(req.session);
      putSecret("client", client);
    }
    const state = token(),
      verifier = token(),
      pkce = createHash("sha256").update(verifier).digest("base64url");
    db.run(
      "DELETE FROM challenges WHERE session=? AND purpose=?",
      req.session.hash,
      "oauth",
    );
    db.run(
      "INSERT INTO challenges VALUES(?,?,?,?,?)",
      hash(state),
      req.session.hash,
      "oauth",
      seal({ verifier }, c.key),
      Date.now() + 600_000,
    );
    const url = new URL(c.wordpress + "/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: c.origin + "/api/wordpress/callback",
      response_type: "code",
      scope: scopes,
      state,
      code_challenge: pkce,
      code_challenge_method: "S256",
    }).toString();
    res.json({ url: url.toString() });
  });
  r.get("/callback", async (req, res) => {
    const state = z.string().max(200).parse(req.query.state);
    const row = db.get(
      "DELETE FROM challenges WHERE id=? AND session=? AND purpose=? RETURNING data,expires",
      hash(state),
      req.session.hash,
      "oauth",
    );
    if (!row || row.expires < Date.now())
      throw new HttpError(
        400,
        "WordPress connection expired. Start again from Account.",
      );
    if (req.query.error) {
      res.redirect("/?connection=declined");
      return;
    }
    const code = z.string().max(2000).parse(req.query.code),
      { verifier } = unseal<{ verifier: string }>(row.data, c.key),
      client = getSecret<Client>("client")!;
    const body = {
      ...client,
      code,
      grant_type: "authorization_code",
      redirect_uri: c.origin + "/api/wordpress/callback",
    };
    // This is a confidential server client: authenticate with its stored secret
    // and validate one-use, session-bound state above. Send the genuine PKCE
    // verifier once; official EMA currently ignores it, while newer servers may
    // enforce it. Never probe with a bad verifier or retry without PKCE.
    const exchange = await post("/oauth/token", {
      ...body,
      code_verifier: verifier,
    });
    if (!exchange.response.ok || !exchange.data.access_token)
      throw new HttpError(502, "WordPress could not authorize the connection.");
    const accessToken = String(exchange.data.access_token);
    try {
      const account = await call("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: "Bearer " + accessToken },
      });
      if (!account.response.ok || !account.data.id)
        throw new HttpError(
          502,
          "Could not verify the connected WordPress identity.",
        );
      sec.alive(req.session);
      putSecret("connection", {
        access_token: accessToken,
        account: {
          id: String(account.data.id),
          display_name: String(account.data.display_name || ""),
          acct: String(account.data.acct || ""),
        },
      });
      db.audit("wordpress-connected");
      res.redirect("/?connection=success");
    } catch (e) {
      await post("/oauth/revoke", { ...client, token: accessToken }).catch(
        () => undefined,
      );
      throw e;
    }
  });
  r.post("/disconnect", async (req, res) => {
    sec.fresh(req.session);
    const conn = getSecret<Connection>("connection"),
      client = getSecret<Client>("client");
    if (conn && client) {
      const result = await post("/oauth/revoke", {
        ...client,
        token: conn.access_token,
      });
      if (!result.response.ok)
        throw new HttpError(
          502,
          "WordPress could not revoke access. Try again.",
        );
    }
    db.run("DELETE FROM secrets WHERE name='connection'");
    db.audit("wordpress-disconnected");
    res.json({ ok: true });
  });
  const id = (value: unknown) =>
    z
      .string()
      .regex(/^[A-Za-z0-9_:.@-]{1,250}$/)
      .parse(value);
  function cursor(link: string | null) {
    if (!link) return null;
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) return null;
    try {
      const url = new URL(match[1]);
      if (url.origin !== c.wordpress) return null;
      return url.searchParams.get("max_id") || null;
    } catch {
      return null;
    }
  }
  r.get("/feed", async (req, res) => {
    const query = new URLSearchParams({ limit: "30" });
    if (req.query.cursor) query.set("max_id", id(req.query.cursor));
    const path =
      req.query.saved === "true"
        ? "/api/v1/bookmarks"
        : "/api/v1/timelines/home";
    const result = await api(path + "?" + query);
    res.json({
      posts: Array.isArray(result.data) ? result.data : [],
      next: cursor(result.link),
    });
  });
  r.get("/following", async (req, res) => {
    const conn = getSecret<Connection>("connection");
    if (!conn) throw new HttpError(409, "Connect WordPress first.");
    const result = await api(
      "/api/v1/accounts/" +
        encodeURIComponent(conn.account.id) +
        "/following?limit=80" +
        (req.query.cursor
          ? "&max_id=" + encodeURIComponent(id(req.query.cursor))
          : ""),
    );
    res.json({ accounts: result.data, next: cursor(result.link) });
  });
  r.get("/author/:id", async (req, res) => {
    const selected = id(req.params.id);
    const accountId = encodeURIComponent(selected);
    const continuation = req.query.cursor ? id(req.query.cursor) : null;
    const fromHome = continuation?.startsWith("home:");
    const query = new URLSearchParams({ limit: "30" });
    if (continuation && !fromHome) query.set("max_id", continuation);
    const account = await api("/api/v1/accounts/" + accountId);
    if (!account.data?.id)
      throw new HttpError(502, "WordPress could not load this author's posts.");
    if (!fromHome) {
      const posts = await api(
        "/api/v1/accounts/" + accountId + "/statuses?" + query,
      );
      if (!Array.isArray(posts.data))
        throw new HttpError(
          502,
          "WordPress could not load this author's posts.",
        );
      if (posts.data.length || continuation) {
        res.json({
          account: account.data,
          posts: posts.data,
          next: cursor(posts.link),
        });
        return;
      }
    }
    // EMA can omit cached Friends posts from remote account timelines. Filter
    // its authenticated home timeline instead, scanning a bounded batch per click.
    // The cursor records which timeline to continue; it never contains a URL.
    let next: string | null = fromHome ? id(continuation!.slice(5)) : null;
    const posts = new Map<string, any>();
    const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const homeQuery = new URLSearchParams({ limit: "30" });
      if (next) {
        seen.add(next);
        homeQuery.set("max_id", next);
      }
      const result = await api("/api/v1/timelines/home?" + homeQuery);
      if (!Array.isArray(result.data))
        throw new HttpError(
          502,
          "WordPress could not load this author's posts.",
        );
      for (const item of result.data) {
        const original = item.reblog || item;
        if (String(original.account?.id) === selected)
          posts.set(String(original.id), original);
      }
      next = result.data.length ? cursor(result.link) : null;
      if (next && seen.has(next)) next = null;
      if (!next || posts.size) break;
    }
    res.json({
      account: account.data,
      posts: [...posts.values()],
      next: next ? "home:" + next : null,
    });
  });
  r.get("/search", async (req, res) => {
    const q = z.string().trim().min(1).max(200).parse(req.query.q),
      type = z
        .enum(["accounts", "statuses", "hashtags"])
        .parse(req.query.type || "statuses");
    const result = await api(
      "/api/v2/search?" +
        new URLSearchParams({
          q,
          type,
          limit: "40",
          resolve: type === "accounts" ? "true" : "false",
        }),
    );
    res.json(result.data);
  });
  r.get("/tag/:tag", async (req, res) => {
    const tag = z
      .string()
      .max(100)
      .regex(/^[\p{L}\p{N}_]+$/u)
      .parse(req.params.tag);
    const result = await api(
      "/api/v1/timelines/tag/" + encodeURIComponent(tag) + "?limit=40",
    );
    res.json({ posts: result.data });
  });
  r.get("/post/:id", async (req, res) => {
    const result = await api(
      "/api/v1/statuses/" + encodeURIComponent(id(req.params.id)),
    );
    res.json(result.data);
  });
  r.get("/post/:id/context", async (req, res) => {
    const result = await api(
      "/api/v1/statuses/" + encodeURIComponent(id(req.params.id)) + "/context",
    );
    res.json(result.data);
  });
  r.post("/post/:id/:action", async (req, res) => {
    sec.limit("write:" + req.session.uid, 60, 60_000);
    const action = z
      .enum([
        "favourite",
        "unfavourite",
        "bookmark",
        "unbookmark",
        "reblog",
        "unreblog",
      ])
      .parse(req.params.action);
    const selected = id(req.params.id);
    const path = "/api/v1/statuses/" + encodeURIComponent(selected);
    if (action === "reblog") {
      const original = (await api(path)).data;
      const post = original.reblog || original;
      const owner = getSecret<Connection>("connection")?.account.id;
      if (!canBoost(post, owner))
        throw new HttpError(422, "Only public Fediverse posts can be boosted.");
    }
    const updated = (
      await api(
        path + "/" + action,
        "POST",
        action === "reblog" ? { visibility: "public" } : {},
      )
    ).data;
    if (action === "reblog" || action === "unreblog") {
      const original = updated?.reblog || updated;
      const state =
        typeof updated?.reblogged === "boolean"
          ? updated.reblogged
          : original?.reblogged;
      if (state !== (action === "reblog"))
        throw new HttpError(
          502,
          "WordPress could not confirm the boost state. Refresh the post before retrying.",
        );
      res.json({ ...original, id: selected, reblogged: state });
    } else res.json(updated);
  });
  r.post("/follow", async (req, res) => {
    sec.limit("follow:" + req.session.uid, 20, 60_000);
    const accountId = id(req.body.id);
    res.json(
      (
        await api(
          "/api/v1/accounts/" + encodeURIComponent(accountId) + "/follow",
          "POST",
          {},
        )
      ).data,
    );
  });
  r.post("/reply", async (req, res) => {
    sec.limit("reply:" + req.session.uid, 10, 60_000);
    const b = z
      .object({ id: z.string(), text: z.string().trim().min(1).max(5000) })
      .parse(req.body);
    const original = (
      await api("/api/v1/statuses/" + encodeURIComponent(id(b.id)))
    ).data;
    const visibility = ["public", "unlisted", "private", "direct"].includes(
      original.visibility,
    )
      ? original.visibility
      : "private";
    res.json(
      (
        await api("/api/v1/statuses", "POST", {
          status: b.text,
          in_reply_to_id: b.id,
          visibility,
          spoiler_text: original.spoiler_text || "",
        })
      ).data,
    );
  });
  return r;
}
