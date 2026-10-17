import { z } from "zod";
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
  if (production && !dbPath.startsWith("/data/"))
    throw new Error("Production database must use /data persistent volume.");
  return {
    origin,
    rpId: url.hostname,
    production,
    key: Buffer.from(key, "hex"),
    bootstrapHash,
    inviteExpires,
    dbPath,
    port: Number(env.PORT || 4320),
    wordpress: "https://wordpress.example.com",
    cookie: production ? "__Host-asterism" : "asterism",
    idle: 24 * 3600_000,
    absolute: 7 * 24 * 3600_000,
  };
}
export type Config = ReturnType<typeof configuration>;
