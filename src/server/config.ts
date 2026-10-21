import { z } from "zod";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Validate operator-controlled endpoints before any credentials can be sent. */
function siteUrl(value: string | undefined, production: boolean) {
  const message =
    "WORDPRESS_URL must be an HTTPS site URL without credentials, query, or fragment (HTTP loopback only in development).";
  let url: URL;
  try {
    url = new URL(value || "");
  } catch {
    throw new Error(message);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !production
      ))
  )
    throw new Error(message);
  // Keep subdirectory installations, but avoid a double slash before API paths.
  return url.href.replace(/\/+$/, "");
}

/** One owner and one WordPress site per deployment; no host-specific defaults. */
export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const origin = z.url().parse(env.APP_ORIGIN);
  const url = new URL(origin);
  const production = env.NODE_ENV === "production";
  if (
    url.origin !== origin ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname) &&
        !production
      ))
  )
    throw new Error(
      "APP_ORIGIN must be an exact HTTPS origin (HTTP localhost only in development).",
    );
  if (env.AUTH_MODE && env.AUTH_MODE !== "passkey")
    throw new Error("Only passkey authentication is supported.");
  const key = z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .parse(env.ENCRYPTION_KEY);
  const bootstrapHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .parse(env.OWNER_INVITE_HASH);
  const inviteExpires = Date.parse(
    z.string().parse(env.OWNER_INVITE_EXPIRES_AT),
  );
  if (!Number.isFinite(inviteExpires))
    throw new Error("Invalid invitation expiry.");
  const dbPath = env.DATABASE_PATH || "./data/asterism.sqlite";
  if (production && !isAbsolute(dbPath))
    throw new Error(
      "Production DATABASE_PATH must be an absolute path on persistent storage.",
    );
  const logPath =
    dbPath === ":memory:" ? ":memory:" : join(dirname(dbPath), "logs.sqlite");
  if (dbPath !== ":memory:" && resolve(logPath) === resolve(dbPath))
    throw new Error("Logging must use a separate database file.");
  return {
    origin,
    rpId: url.hostname,
    production,
    key: Buffer.from(key, "hex"),
    bootstrapHash,
    inviteExpires,
    dbPath,
    logPath,
    logLevel: z
      .enum(["debug", "info", "warn", "error"])
      .parse(env.LOG_LEVEL || "info"),
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.PORT ?? 4320),
    wordpress: siteUrl(env.WORDPRESS_URL, production),
    ownerName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .parse(env.OWNER_NAME ?? "Reader"),
    cookie: production ? "__Host-asterism" : "asterism",
    idle: 24 * 3600_000,
    absolute: 7 * 24 * 3600_000,
  };
}
export type Config = ReturnType<typeof configuration>;
