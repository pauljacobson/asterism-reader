import {
  createHash,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function seal(value: unknown, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
export function unseal<T>(value: string, key: Buffer): T {
  const data = Buffer.from(value, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([d.update(data.subarray(28)), d.final()]).toString(),
  );
}
export type Session = {
  hash: string;
  uid: string | null;
  phase: "anonymous" | "setup" | "full" | "recovery";
  csrf: string;
  recent: number;
  created: number;
  touched: number;
  expires: number;
  recovery_key: string | null;
};
declare global {
  namespace Express {
    interface Request {
      session: Session;
    }
  }
}
export function security(db: Store, c: Config) {
  function issue(
    res: Response,
    phase: Session["phase"],
    uid: string | null,
    old?: string,
    recoveryKey: string | null = null,
  ) {
    const raw = token(),
      now = Date.now(),
      duration =
        phase === "full" ? c.absolute : phase === "setup" ? 3600_000 : 600_000;
    if (old) db.run("DELETE FROM sessions WHERE hash=?", old);
    const s: Session = {
      hash: hash(raw),
      uid,
      phase,
      csrf: token(),
      recent: uid ? now : 0,
      created: now,
      touched: now,
      expires: now + duration,
      recovery_key: recoveryKey,
    };
    db.run(
      "INSERT INTO sessions(hash,uid,phase,csrf,recent,created,touched,expires,recovery_key) VALUES(?,?,?,?,?,?,?,?,?)",
      s.hash,
      uid,
      phase,
      s.csrf,
      s.recent,
      now,
      now,
      s.expires,
      recoveryKey,
    );
    res.cookie(c.cookie, raw, {
      httpOnly: true,
      secure: c.production || c.origin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: duration,
    });
    return s;
  }
  function session(req: Request, res: Response, next: NextFunction) {
    const raw = req.cookies[c.cookie];
    const s =
      typeof raw === "string"
        ? db.get<Session>("SELECT * FROM sessions WHERE hash=?", hash(raw))
        : undefined;
    const now = Date.now();
    if (s && s.expires > now && s.touched > now - c.idle) {
      req.session = s;
      db.run("UPDATE sessions SET touched=? WHERE hash=?", now, s.hash);
    } else req.session = issue(res, "anonymous", null, s?.hash);
    next();
  }
  function csrf(req: Request, _res: Response, next: NextFunction) {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.get("origin") !== c.origin ||
        !req.is("application/json") ||
        !same(req.get("x-csrf-token") || "", req.session.csrf)
      )
        throw new HttpError(
          403,
          "Request could not be verified. Reload and try again.",
        );
    }
    next();
  }
  function full(req: Request, _res: Response, next: NextFunction) {
    if (
      req.session.phase !== "full" ||
      !req.session.uid ||
      !db.get("SELECT uid FROM owner WHERE uid=? AND setup=1", req.session.uid)
    )
      throw new HttpError(401, "Sign in and finish account setup first.");
    next();
  }
  function account(req: Request, _res: Response, next: NextFunction) {
    if (!req.session.uid) throw new HttpError(401, "Sign in first.");
    next();
  }
  function fresh(s: Session) {
    if (s.recent < Date.now() - 300_000)
      throw new HttpError(403, "Verify your passkey again before this change.");
  }
  function alive(s: Session) {
    if (
      !db.get(
        "SELECT hash FROM sessions WHERE hash=? AND expires>?",
        s.hash,
        Date.now(),
      )
    )
      throw new HttpError(401, "Session expired. Sign in again.");
  }
  function limit(key: string, max = 20, window = 600_000) {
    const now = Date.now();
    const row = db.get(
      "INSERT INTO limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count",
      key,
      now + window,
      now,
      now,
    )!;
    if (row.count > max)
      throw new HttpError(
        429,
        "Too many attempts. Please wait before trying again.",
      );
  }
  return { issue, session, csrf, full, account, fresh, alive, limit };
}
