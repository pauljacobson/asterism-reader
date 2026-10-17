import { randomBytes, createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
// This creates a local-only owner invitation. It never prints the invitation or
// encryption key, and refuses to overwrite an existing configuration.
process.umask(0o077);
const invite = randomBytes(32).toString("base64url");
const key = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(invite).digest("hex");
const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
await mkdir("work", { recursive: true });
await writeFile(
  ".env",
  `NODE_ENV=development\nAPP_ORIGIN=http://localhost:4320\nPORT=4320\nDATABASE_PATH=./data/asterism.sqlite\nENCRYPTION_KEY=${key}\nOWNER_INVITE_HASH=${hash}\nOWNER_INVITE_EXPIRES_AT=${expires}\n`,
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  "work/local-setup-url.txt",
  `http://localhost:4320/#setup=${invite}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Local configuration created. The private, 24-hour setup link is in work/local-setup-url.txt. Use the permanent production domain for your production passkey.",
);
