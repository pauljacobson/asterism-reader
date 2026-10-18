import express from "express";
import { AppLogger, levels, categories, type LogFilter } from "./logging.js";
import helmet from "helmet";
import cookies from "cookie-parser";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { security, HttpError, unseal } from "./security.js";
import { authRouter } from "./auth.js";
import { wordpressRouter } from "./wordpress.js";
import { createPreviewService } from "./link-previews.js";
export function createApp(
  c: Config,
  db = new Store(c.dbPath),
  fetcher: typeof fetch = fetch,
  logger = new AppLogger(c.logPath, c.logLevel),
) {
  const app = express(),
    sec = security(db, c);
  db.onAudit = (event) => logger.audit(event);
  app.disable("x-powered-by");
  app.use(logger.middleware());
  app.use(
    helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "https:", "data:"],
          mediaSrc: ["https:"],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: c.production ? [] : null,
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.get("/healthz", (_req, res) => {
    db.get("SELECT 1");
    res.json({ ok: true });
  });
  app.use(
    "/api",
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
    express.json({ limit: "64kb" }),
    cookies(),
    sec.session,
    sec.csrf,
  );
  app.get("/api/session", (req, res) => {
    sec.limit("session:" + req.session.hash, 120, 60_000);
    const s = req.session,
      owner = s.uid ? db.get("SELECT * FROM owner WHERE uid=?", s.uid) : null;
    let connection = null;
    if (s.phase === "full") {
      const row = db.get("SELECT value FROM secrets WHERE name='connection'");
      if (row) connection = unseal<any>(row.value, c.key).account;
    }
    res.json({
      csrf: s.csrf,
      phase: s.phase,
      hasAccount: !!db.get("SELECT uid FROM owner"),
      recoveryKey: !!s.recovery_key,
      preferences: owner ? JSON.parse(owner.preferences) : null,
      connection,
      site: c.wordpress,
      ...(s.phase === "full"
        ? {
            passkeys: db.all(
              "SELECT id,name,created FROM credentials WHERE uid=? AND enabled=1",
              s.uid!,
            ),
            sessions: db
              .all(
                "SELECT hash AS id,created,touched FROM sessions WHERE uid=? AND phase=? AND expires>?",
                s.uid!,
                "full",
                Date.now(),
              )
              .map((x) => ({ ...x, current: x.id === s.hash })),
            backupRemaining: db.get(
              "SELECT count(*) AS n FROM recovery_codes WHERE uid=?",
              s.uid!,
            )!.n,
          }
        : {}),
    });
  });
  const logFilter = (query: unknown): LogFilter => {
    const q = z
      .object({
        level: z.enum(levels).optional(),
        category: z.enum(categories).optional(),
        search: z.string().trim().max(200).optional(),
        hours: z.coerce.number().int().min(1).max(168).optional(),
        before: z.coerce
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(query);
    return {
      ...q,
      since: q.hours ? Date.now() - q.hours * 3600_000 : undefined,
    };
  };
  const readLogs = (filter: LogFilter) => {
    try {
      return logger.query(filter);
    } catch {
      throw new HttpError(
        503,
        "Persistent logs are unavailable. Check Railway logs.",
      );
    }
  };
  app.get("/api/admin/logs", sec.full, (req, res) => {
    sec.limit("logs:" + req.session.uid, 60, 60_000);
    res.json(readLogs(logFilter(req.query)));
  });
  app.get("/api/admin/logs/export", sec.full, async (req, res) => {
    sec.limit("logs-export:" + req.session.uid, 6, 60_000);
    const filter = logFilter(req.query);
    let result = readLogs({ ...filter, limit: 100 });
    res.attachment(
      `asterism-logs-${new Date().toISOString().slice(0, 10)}.ndjson`,
    );
    res.type("application/x-ndjson");
    // Stream bounded pages and respect backpressure. A cursor excludes newer
    // arrivals so a busy server cannot make an export run indefinitely.
    for (let pages = 0; pages < 100; pages++) {
      for (const entry of result.entries) {
        if (res.destroyed) return;
        if (!res.write(JSON.stringify(entry) + "\n")) {
          await new Promise<void>((resolve) => {
            const ready = () => {
              res.off("drain", ready);
              res.off("close", ready);
              res.off("error", ready);
              resolve();
            };
            res.once("drain", ready);
            res.once("close", ready);
            res.once("error", ready);
          });
          if (res.destroyed) return;
        }
      }
      if (!result.next) break;
      result = readLogs({ ...filter, before: result.next, limit: 100 });
    }
    res.end();
  });
  app.use("/api/auth", authRouter(db, c, sec));
  app.put("/api/preferences", sec.full, (req, res) => {
    const preferences = z
      .object({
        theme: z.enum(["light", "dark", "system"]),
        font: z.enum(["serif", "sans"]),
        size: z.number().int().min(16).max(26),
      })
      .parse(req.body);
    db.run(
      "UPDATE owner SET preferences=? WHERE uid=?",
      JSON.stringify(preferences),
      req.session.uid!,
    );
    res.json(preferences);
  });
  app.use("/api/wordpress", wordpressRouter(db, c, sec, fetcher, logger));
  const previews = createPreviewService({
    onFailure: (reason) => logger.write("previewFailed", "warn", { reason }),
  });
  app.post("/api/link-preview", sec.full, async (req, res) => {
    sec.limit("preview:" + req.session.uid, 120, 60_000);
    const input = z
      .object({ url: z.string().min(1).max(4096) })
      .parse(req.body);
    res.json({ preview: await previews.get(input.url) });
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
  // Mutable entry points must revalidate at the browser and CDN. Fingerprinted
  // assets can be cached indefinitely because a deployment changes their URL.
  app.use((req, res, next) => {
    if (
      [
        "/",
        "/index.html",
        "/sw.js",
        "/manifest.webmanifest",
        "/favicon.ico",
        "/offline.html",
        "/offline.css",
        "/app.js",
        "/style.css",
      ].includes(req.path) ||
      req.path.startsWith("/icons/")
    ) {
      res.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
      res.set("CDN-Cache-Control", "no-store");
      res.set("Cloudflare-CDN-Cache-Control", "no-store");
    }
    if (req.path === "/sw.js") res.set("Service-Worker-Allowed", "/");
    if (/^\/assets\/(app|style)-[a-f0-9]{16}\.(js|css)$/.test(req.path))
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    next();
  });
  app.use(
    express.static(resolve("dist/public"), {
      index: "index.html",
      cacheControl: false,
      dotfiles: "deny",
    }),
  );
  app.use((_req, res) => res.status(404).send("Not found."));
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        err instanceof HttpError
          ? err.status
          : err instanceof ZodError
            ? 400
            : 500;
      res.locals.logReason =
        status === 400
          ? "validation"
          : status === 401 || status === 403
            ? "authorization"
            : "unexpected";
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(status).json({
        requestId: logger.requestId,
        error:
          err instanceof HttpError
            ? err.message
            : status === 400
              ? "Invalid request."
              : "Request failed. Try again.",
      });
    },
  );
  return { app, db, logger };
}
