import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import type { Store } from "./store.js";
import type { Config } from "./config.js";
import { security, token, hash, same, HttpError } from "./security.js";
/** Enrollment -> backup confirmation -> full access; recovery repeats the gates. */
export function authRouter(
  db: Store,
  c: Config,
  sec: ReturnType<typeof security>,
) {
  const r = Router();
  const consume = (id: string, session: string, purpose: string) => {
    const row = db.get(
      "DELETE FROM challenges WHERE id=? AND session=? AND purpose=? RETURNING data,expires",
      id,
      session,
      purpose,
    );
    if (!row || row.expires < Date.now())
      throw new HttpError(400, "This request has expired. Start again.");
    return JSON.parse(row.data);
  };
  const challenge = (session: string, purpose: string, data: unknown) => {
    const id = token();
    db.run(
      "DELETE FROM challenges WHERE session=? AND purpose=?",
      session,
      purpose,
    );
    db.run(
      "INSERT INTO challenges VALUES(?,?,?,?,?)",
      id,
      session,
      purpose,
      JSON.stringify(data),
      Date.now() + 300_000,
    );
    return id;
  };
  r.use((req, _res, next) => {
    sec.limit("auth-global", 300);
    sec.limit("auth-ip:" + hash(req.ip || "unknown"), 50);
    next();
  });
  r.post("/register/options", async (req, res) => {
    const b = z
      .object({ invite: z.string().max(200).optional() })
      .parse(req.body);
    const owner = db.get("SELECT * FROM owner");
    let purpose = "add",
      uid = req.session.uid;
    if (!owner) {
      if (
        !b.invite ||
        c.inviteExpires < Date.now() ||
        !same(hash(b.invite), c.bootstrapHash)
      )
        throw new HttpError(403, "The setup invitation is invalid or expired.");
      purpose = "enroll";
      uid = token();
    } else {
      if (!uid || !["full", "recovery"].includes(req.session.phase))
        throw new HttpError(403, "Sign in to add a passkey.");
      if (req.session.phase === "full") sec.fresh(req.session);
      purpose = req.session.phase === "recovery" ? "recover-key" : "add";
    }
    const credentials = db.all(
      "SELECT id,transports FROM credentials WHERE uid=?",
      uid!,
    );
    const options = await generateRegistrationOptions({
      rpName: "Asterism Reader",
      rpID: c.rpId,
      userID: new TextEncoder().encode(uid!),
      // This is a passkey-manager label. The random userID binds the credential.
      userName: c.ownerName,
      userDisplayName: c.ownerName,
      attestationType: "none",
      // Widely deployed passkey algorithms supported by the stable runtime.
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: credentials.map((x) => ({
        id: x.id,
        transports: JSON.parse(x.transports),
      })),
    });
    sec.alive(req.session);
    res.json({
      options,
      id: challenge(req.session.hash, "register", {
        purpose,
        uid,
        challenge: options.challenge,
      }),
    });
  });
  r.post("/register/verify", async (req, res) => {
    const b = z
      .object({
        id: z.string(),
        response: z.any(),
        name: z.string().trim().min(1).max(60),
      })
      .parse(req.body);
    const data = consume(b.id, req.session.hash, "register");
    const result = await verifyRegistrationResponse({
      response: b.response,
      expectedChallenge: data.challenge,
      expectedOrigin: c.origin,
      expectedRPID: c.rpId,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo)
      throw new HttpError(400, "Passkey verification failed.");
    const credential = result.registrationInfo.credential;
    db.atomic(() => {
      sec.alive(req.session);
      if (data.purpose === "enroll") {
        if (c.inviteExpires < Date.now() || db.get("SELECT uid FROM owner"))
          throw new HttpError(403, "Account setup is no longer available.");
        db.run("INSERT INTO owner(singleton,uid) VALUES(1,?)", data.uid);
      } else {
        if (req.session.uid !== data.uid)
          throw new HttpError(403, "Account mismatch.");
        if (data.purpose === "add") {
          if (req.session.phase !== "full")
            throw new HttpError(403, "Sign in first.");
          sec.fresh(req.session);
        } else if (req.session.phase !== "recovery")
          throw new HttpError(403, "Recovery expired.");
      }
      if (data.purpose === "recover-key" && req.session.recovery_key)
        db.run(
          "DELETE FROM credentials WHERE id=? AND uid=?",
          req.session.recovery_key,
          data.uid,
        );
      db.run(
        "INSERT INTO credentials(id,uid,public_key,counter,transports,name,created,enabled) VALUES(?,?,?,?,?,?,?,?)",
        credential.id,
        data.uid,
        Buffer.from(credential.publicKey).toString("base64url"),
        credential.counter,
        JSON.stringify(credential.transports || []),
        b.name,
        Date.now(),
        data.purpose === "recover-key" ? 0 : 1,
      );
      if (data.purpose === "enroll")
        sec.issue(res, "setup", data.uid, req.session.hash);
      if (data.purpose === "recover-key")
        db.run(
          "UPDATE sessions SET recovery_key=? WHERE hash=?",
          credential.id,
          req.session.hash,
        );
      db.audit("passkey-added");
    });
    res.json({ ok: true });
  });
  r.post("/login/options", async (req, res) => {
    const { reauth } = z
      .object({ reauth: z.boolean().default(false) })
      .parse(req.body);
    if (reauth && !req.session.uid) throw new HttpError(401, "Sign in first.");
    const credentials = reauth
      ? db.all(
          "SELECT id,transports FROM credentials WHERE uid=?",
          req.session.uid!,
        )
      : [];
    const options = await generateAuthenticationOptions({
      rpID: c.rpId,
      userVerification: "required",
      allowCredentials: reauth
        ? credentials.map((x) => ({
            id: x.id,
            transports: JSON.parse(x.transports),
          }))
        : undefined,
    });
    sec.alive(req.session);
    res.json({
      options,
      id: challenge(req.session.hash, "login", {
        challenge: options.challenge,
        reauth,
        uid: reauth ? req.session.uid : null,
      }),
    });
  });
  r.post("/login/verify", async (req, res) => {
    const b = z.object({ id: z.string(), response: z.any() }).parse(req.body);
    const data = consume(b.id, req.session.hash, "login");
    const row = db.get(
      "SELECT * FROM credentials WHERE id=? AND enabled=1",
      String(b.response?.id || ""),
    );
    if (!row || (data.reauth && data.uid !== row.uid))
      throw new HttpError(400, "Passkey verification failed.");
    if (
      b.response?.response?.userHandle &&
      b.response.response.userHandle !==
        Buffer.from(row.uid).toString("base64url")
    )
      throw new HttpError(400, "Passkey verification failed.");
    const verification = await verifyAuthenticationResponse({
      response: b.response,
      expectedChallenge: data.challenge,
      expectedOrigin: c.origin,
      expectedRPID: c.rpId,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
        counter: row.counter,
        transports: JSON.parse(row.transports) as AuthenticatorTransport[],
      },
      requireUserVerification: true,
    });
    if (!verification.verified)
      throw new HttpError(400, "Passkey verification failed.");
    db.atomic(() => {
      sec.alive(req.session);
      if (
        !db.get("SELECT id FROM credentials WHERE id=? AND enabled=1", row.id)
      )
        throw new HttpError(401, "This passkey was revoked.");
      db.run(
        "UPDATE credentials SET counter=? WHERE id=?",
        verification.authenticationInfo.newCounter,
        row.id,
      );
      if (data.reauth) {
        if (req.session.phase !== "full")
          throw new HttpError(403, "Finish setup first.");
        sec.issue(res, "full", row.uid, req.session.hash);
      } else {
        const owner = db.get("SELECT setup FROM owner WHERE uid=?", row.uid)!;
        sec.issue(
          res,
          owner.setup ? "full" : "setup",
          row.uid,
          req.session.hash,
        );
      }
      db.audit("signed-in");
    });
    res.json({ ok: true });
  });
  r.post("/backup/generate", sec.account, (req, res) => {
    if (req.session.phase === "recovery" && !req.session.recovery_key)
      throw new HttpError(403, "Create a replacement passkey first.");
    if (req.session.phase === "full") sec.fresh(req.session);
    const codes = Array.from({ length: 8 }, () =>
      randomBytes(16).toString("hex").toUpperCase().match(/.{4}/g)!.join("-"),
    );
    db.run(
      "INSERT INTO pending_codes VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET hashes=excluded.hashes,expires=excluded.expires",
      req.session.hash,
      JSON.stringify(codes.map((x) => hash(x.replaceAll("-", "")))),
      Date.now() + 900_000,
    );
    res.json({ codes });
  });
  r.post("/backup/confirm", sec.account, (req, res) => {
    z.object({ saved: z.literal(true) }).parse(req.body);
    db.atomic(() => {
      sec.alive(req.session);
      const pending = db.get(
        "SELECT * FROM pending_codes WHERE session=?",
        req.session.hash,
      );
      if (!pending || pending.expires < Date.now())
        throw new HttpError(400, "Generate a new set of backup codes.");
      if (req.session.phase === "full") sec.fresh(req.session);
      if (req.session.phase === "recovery" && !req.session.recovery_key)
        throw new HttpError(403, "Create a replacement passkey first.");
      db.run("DELETE FROM recovery_codes WHERE uid=?", req.session.uid!);
      for (const h of JSON.parse(pending.hashes))
        db.run("INSERT INTO recovery_codes VALUES(?,?)", h, req.session.uid!);
      db.run("UPDATE owner SET setup=1 WHERE uid=?", req.session.uid!);
      if (req.session.phase === "recovery") {
        db.run(
          "UPDATE credentials SET enabled=1 WHERE id=? AND uid=?",
          req.session.recovery_key!,
          req.session.uid!,
        );
        db.run(
          "DELETE FROM credentials WHERE uid=? AND id<>?",
          req.session.uid!,
          req.session.recovery_key!,
        );
        db.run(
          "DELETE FROM sessions WHERE uid=? AND hash<>?",
          req.session.uid!,
          req.session.hash,
        );
      }
      sec.issue(res, "full", req.session.uid, req.session.hash);
      db.audit("backup-codes-confirmed");
    });
    res.json({ ok: true });
  });
  r.post("/recover", (req, res) => {
    sec.limit("recovery", 10, 3600_000);
    const { code } = z.object({ code: z.string().max(100) }).parse(req.body);
    const normalized = code.replace(/[\s-]/g, "").toUpperCase();
    db.atomic(() => {
      const row = db.get(
        "DELETE FROM recovery_codes WHERE hash=? RETURNING uid",
        hash(normalized),
      );
      if (!row) throw new HttpError(400, "Recovery could not be verified.");
      db.run("DELETE FROM sessions WHERE uid=?", row.uid);
      sec.issue(res, "recovery", row.uid, req.session.hash);
      db.audit("recovery-started");
    });
    res.json({ ok: true });
  });
  r.post("/logout", (req, res) => {
    db.run("DELETE FROM sessions WHERE hash=?", req.session.hash);
    res.clearCookie(c.cookie, {
      path: "/",
      httpOnly: true,
      secure: c.production || c.origin.startsWith("https:"),
      sameSite: "lax",
    });
    res.json({ ok: true });
  });
  r.delete("/credentials/:id", sec.full, (req, res) => {
    sec.fresh(req.session);
    db.atomic(() => {
      if (
        db.all(
          "SELECT id FROM credentials WHERE uid=? AND enabled=1",
          req.session.uid!,
        ).length < 2
      )
        throw new HttpError(400, "Keep at least one passkey.");
      db.run(
        "DELETE FROM credentials WHERE id=? AND uid=?",
        String(req.params.id),
        req.session.uid!,
      );
      db.audit("passkey-removed");
    });
    res.json({ ok: true });
  });
  r.delete("/sessions/:id", sec.full, (req, res) => {
    sec.fresh(req.session);
    db.run(
      "DELETE FROM sessions WHERE hash=? AND uid=?",
      String(req.params.id),
      req.session.uid!,
    );
    res.json({ ok: true });
  });
  return r;
}
