import { randomBytes, createHash } from "node:crypto";
import { mkdir, open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/server/config.ts";

/** Create a new deployment, never rotate secrets in an existing installation. */
export async function createSetup({
  directory = ".",
  origin,
  wordpress,
  production = false,
}) {
  process.umask(0o077);
  const invite = randomBytes(32).toString("base64url");
  const env = {
    NODE_ENV: production ? "production" : "development",
    APP_ORIGIN: origin,
    WORDPRESS_URL: wordpress,
    OWNER_NAME: "Reader",
    PORT: production ? "8080" : "4320",
    DATABASE_PATH: production
      ? "/data/asterism.sqlite"
      : "./data/asterism.sqlite",
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    OWNER_INVITE_HASH: createHash("sha256").update(invite).digest("hex"),
    OWNER_INVITE_EXPIRES_AT: new Date(Date.now() + 24 * 3600_000).toISOString(),
    LOG_LEVEL: "info",
  };
  // Reuse startup validation; invalid arguments must not leave credential files.
  const config = configuration(env);
  env.WORDPRESS_URL = config.wordpress;
  const envPath = join(directory, production ? "work/production.env" : ".env");
  const linkPath = join(
    directory,
    production ? "work/production-setup-url.txt" : "work/local-setup-url.txt",
  );
  for (const path of [envPath, linkPath]) {
    try {
      await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "Setup files already exist. Preserve the existing configuration; use a new directory for a new deployment.",
    );
  }
  await mkdir(join(directory, "work"), { recursive: true, mode: 0o700 });
  // Exclusive creation also prevents a concurrent setup from replacing secrets.
  // On an I/O failure, preserve any partial files for the operator to inspect.
  const file = await open(envPath, "wx", 0o600);
  try {
    await file.writeFile(
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  } finally {
    await file.close();
  }
  const link = await open(linkPath, "wx", 0o600);
  try {
    await link.writeFile(`${config.origin}/#setup=${invite}\n`);
  } finally {
    await link.close();
  }
  return { envPath, linkPath };
}
