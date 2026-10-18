import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RequestHandler } from "express";

export const levels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof levels)[number];
export const categories = [
  "system",
  "request",
  "wordpress",
  "auth",
  "preview",
] as const;
const events = {
  started: ["system", "Application started"],
  stopping: ["system", "Application stopping"],
  maintenance: ["system", "Maintenance failed"],
  request: ["request", "Request completed"],
  requestFailed: ["request", "Request failed"],
  requestRejected: ["request", "Request rejected"],
  authRejected: ["auth", "Authentication request rejected"],
  upstream: ["wordpress", "WordPress request completed"],
  upstreamFailed: ["wordpress", "WordPress request failed"],
  previewFailed: ["preview", "Link preview unavailable"],
  "passkey-added": ["auth", "Passkey added"],
  "signed-in": ["auth", "Signed in"],
  "backup-codes-confirmed": ["auth", "Backup codes confirmed"],
  "recovery-started": ["auth", "Account recovery started"],
  "passkey-removed": ["auth", "Passkey removed"],
  "wordpress-connected": ["wordpress", "WordPress connected"],
  "wordpress-disconnected": ["wordpress", "WordPress disconnected"],
} as const;
export type LogEvent = keyof typeof events;
type Context = { requestId: string };
export type LogEntry = {
  id?: number;
  timestamp: string;
  level: LogLevel;
  category: string;
  event: LogEvent;
  message: string;
  requestId?: string;
  data: Record<string, string | number>;
};
export type LogFilter = {
  level?: LogLevel;
  category?: (typeof categories)[number];
  search?: string;
  since?: number;
  before?: number;
  limit?: number;
};
const RETENTION = 7 * 86400_000;
const MAX_ENTRIES = 10_000;

// Only fields with an explicitly safe vocabulary reach either sink. In
// particular, do not serialize Error objects, request bodies, headers or URLs.
function safeData(input: Record<string, unknown>) {
  const result: LogEntry["data"] = {};
  for (const key of ["status", "durationMs", "count", "port"]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value))
      result[key] = Math.max(0, Math.min(Math.round(value), 1e9));
  }
  if (
    ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"].includes(
      String(input.method),
    )
  )
    result.method = String(input.method);
  if (typeof input.operation === "string" && operations.has(input.operation))
    result.operation = input.operation;
  if (
    [
      "timeout",
      "network",
      "upstream",
      "validation",
      "authorization",
      "unexpected",
      "aborted",
    ].includes(String(input.reason))
  )
    result.reason = String(input.reason);
  // Route templates come from Express, never req.url/path or a user identifier.
  if (
    typeof input.route === "string" &&
    input.route.length <= 150 &&
    /^\/(?:api|healthz)(?:\/[a-zA-Z:_-]+)*$/.test(input.route)
  )
    result.route = input.route;
  return result;
}
const operations = new Set([
  "register-app",
  "authorize",
  "exchange-token",
  "revoke-token",
  "verify-account",
  "feed",
  "saved",
  "following",
  "account",
  "author-posts",
  "search",
  "hashtag",
  "post",
  "conversation",
  "favourite",
  "unfavourite",
  "bookmark",
  "unbookmark",
  "follow",
  "reply",
  "other",
]);
export function wordpressOperation(path: string) {
  const p = path.split("?")[0];
  if (p === "/api/v1/apps") return "register-app";
  if (p === "/oauth/token") return "exchange-token";
  if (p === "/oauth/revoke") return "revoke-token";
  if (p === "/api/v1/accounts/verify_credentials") return "verify-account";
  if (p === "/api/v1/timelines/home") return "feed";
  if (p === "/api/v1/bookmarks") return "saved";
  if (p === "/api/v2/search") return "search";
  if (p.startsWith("/api/v1/timelines/tag/")) return "hashtag";
  if (p === "/api/v1/statuses") return "reply";
  const tail = p.split("/").at(-1)!;
  if (
    [
      "following",
      "favourite",
      "unfavourite",
      "bookmark",
      "unbookmark",
      "follow",
    ].includes(tail)
  )
    return tail;
  if (/^\/api\/v1\/accounts\/[^/]+\/statuses$/.test(p)) return "author-posts";
  if (/^\/api\/v1\/accounts\/[^/]+$/.test(p)) return "account";
  if (/^\/api\/v1\/statuses\/[^/]+\/context$/.test(p)) return "conversation";
  if (/^\/api\/v1\/statuses\/[^/]+$/.test(p)) return "post";
  return "other";
}
export function failureReason(error: unknown) {
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return "timeout";
  return error instanceof TypeError ? "network" : "unexpected";
}

export class LogStore {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    private now = Date.now,
    private maxEntries = MAX_ENTRIES,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 50 });
    // Bound the database independently of auth storage. A rollback journal
    // avoids an accumulating WAL, and deleted pages are reused automatically.
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA max_page_count=16384;
      CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, category TEXT NOT NULL, entry TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_at ON logs(at);
      CREATE INDEX IF NOT EXISTS logs_level ON logs(level,id);
      CREATE INDEX IF NOT EXISTS logs_category ON logs(category,id);`);
    this.cleanup();
  }
  cleanup() {
    this.db.prepare("DELETE FROM logs WHERE at<?").run(this.now() - RETENTION);
    this.db
      .prepare(
        "DELETE FROM logs WHERE id <= COALESCE((SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?),0)",
      )
      .run(this.maxEntries);
  }
  append(entry: LogEntry) {
    const json = JSON.stringify(entry);
    if (Buffer.byteLength(json) > 4096) throw new Error("Log entry too large");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO logs(at,level,category,entry) VALUES(?,?,?,?)")
        .run(this.now(), entry.level, entry.category, json);
      this.cleanup();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  query(filter: LogFilter = {}) {
    this.cleanup();
    const clauses = ["1=1"],
      args: SQLInputValue[] = [];
    for (const key of ["level", "category"] as const)
      if (filter[key]) {
        clauses.push(`${key}=?`);
        args.push(filter[key]!);
      }
    if (filter.search) {
      clauses.push("instr(lower(entry),lower(?))>0");
      args.push(filter.search);
    }
    if (filter.since) {
      clauses.push("at>=?");
      args.push(filter.since);
    }
    const where = clauses.join(" AND ");
    const counts = this.db
      .prepare(
        `SELECT level,count(*) AS n FROM logs WHERE ${where} GROUP BY level`,
      )
      .all(...args);
    const stats = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const row of counts) stats[row.level as LogLevel] = Number(row.n);
    const total = Object.values(stats).reduce((sum, n) => sum + n, 0);
    if (filter.before) {
      clauses.push("id<?");
      args.push(filter.before);
    }
    const limit = Math.min(100, Math.max(1, filter.limit || 50));
    const rows = this.db
      .prepare(
        `SELECT id,entry FROM logs WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit + 1);
    const entries = rows.slice(0, limit).map(
      (row) =>
        ({
          ...JSON.parse(String(row.entry)),
          id: Number(row.id),
        }) as LogEntry,
    );
    const stored = this.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(length(CAST(entry AS BLOB))),0) AS bytes FROM logs",
      )
      .get()!;
    return {
      entries,
      total,
      stats,
      next: rows.length > limit ? entries.at(-1)!.id! : null,
      retained: Number(stored.n),
      storedBytes: Number(stored.bytes),
      retentionDays: 7,
      maxEntries: this.maxEntries,
    };
  }
  close() {
    this.db.close();
  }
}

export class AppLogger {
  private context = new AsyncLocalStorage<Context>();
  private store?: LogStore;
  private sinkFailed = false;
  constructor(
    path: string,
    private minimum: LogLevel = "info",
    private output: (line: string) => void = (line) =>
      process.stdout.write(line + "\n"),
  ) {
    try {
      this.store = new LogStore(path);
    } catch {
      this.reportFailure();
    }
  }
  private reportFailure() {
    if (!this.sinkFailed) {
      this.sinkFailed = true;
      // Never include the underlying filesystem error: it may contain secrets.
      try {
        this.output(
          JSON.stringify({
            level: "error",
            category: "system",
            message: "Persistent logs unavailable; console logging continues",
          }),
        );
      } catch {
        /* Logging must not break the app. */
      }
    }
  }
  run<T>(callback: () => T) {
    return this.context.run({ requestId: randomUUID() }, callback);
  }
  get requestId() {
    return this.context.getStore()?.requestId;
  }
  write(
    event: LogEvent,
    level: LogLevel = "info",
    data: Record<string, unknown> = {},
  ) {
    if (
      !Object.hasOwn(events, event) ||
      levels.indexOf(level) < levels.indexOf(this.minimum)
    )
      return;
    const [category, message] = events[event];
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      event,
      message,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      data: safeData(data),
    };
    try {
      this.output(JSON.stringify(entry));
    } catch {
      /* A closed stdout must not fail a request. */
    }
    if (this.store)
      try {
        this.store.append(entry);
      } catch {
        this.reportFailure();
      }
  }
  audit(event: string) {
    if (Object.hasOwn(events, event)) this.write(event as LogEvent);
  }
  query(filter: LogFilter) {
    if (!this.store) throw new Error("Logs unavailable");
    return {
      ...this.store.query(filter),
      persistenceDegraded: this.sinkFailed,
    };
  }
  cleanup() {
    this.store?.cleanup();
  }
  close() {
    this.store?.close();
  }
  middleware(): RequestHandler {
    return (req, res, next) =>
      this.run(() => {
        const requestId = this.requestId!,
          started = performance.now();
        res.set("X-Request-Id", requestId);
        let recorded = false;
        const finish = () => {
          if (recorded) return;
          recorded = true;
          // Health checks and the log viewer itself must not generate noise.
          const status = res.writableFinished ? res.statusCode : 499;
          if (
            status < 400 &&
            (req.path === "/healthz" || req.path.startsWith("/api/admin/logs"))
          )
            return;
          const route =
            typeof req.route?.path === "string"
              ? req.baseUrl + req.route.path
              : "";
          const level =
            status >= 500
              ? "error"
              : status >= 400
                ? "warn"
                : req.method !== "GET" && route !== "/api/link-preview"
                  ? "info"
                  : "debug";
          this.context.run({ requestId }, () =>
            this.write(
              status >= 400 && req.originalUrl.startsWith("/api/auth/")
                ? "authRejected"
                : status >= 500
                  ? "requestFailed"
                  : status >= 400
                    ? "requestRejected"
                    : "request",
              level,
              {
                method: req.method,
                route,
                status,
                durationMs: performance.now() - started,
                ...(res.locals.logReason
                  ? { reason: res.locals.logReason }
                  : {}),
                ...(!res.writableFinished ? { reason: "aborted" } : {}),
              },
            ),
          );
        };
        res.once("finish", finish);
        res.once("close", finish);
        next();
      });
  }
}
