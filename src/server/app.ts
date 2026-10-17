import express from "express";
import helmet from "helmet";
import cookies from "cookie-parser";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { security, HttpError, unseal } from "./security.js";
import { authRouter } from "./auth.js";
import { wordpressRouter } from "./wordpress.js";
export function createApp(
  c: Config,
  db = new Store(c.dbPath),
  fetcher: typeof fetch = fetch,
) {
  const app = express(),
    sec = security(db, c);
  app.disable("x-powered-by");
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
  app.use("/api/wordpress", wordpressRouter(db, c, sec, fetcher));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
  app.use(
    express.static(resolve("dist/public"), {
      index: "index.html",
      maxAge: 0,
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
      if (status === 500)
        console.error(
          "Request failed:",
          err instanceof Error ? err.name : "UnknownError",
        );
      res.status(status).json({
        error:
          err instanceof HttpError
            ? err.message
            : status === 400
              ? "Invalid request."
              : "Request failed. Try again.",
      });
    },
  );
  return { app, db };
}
