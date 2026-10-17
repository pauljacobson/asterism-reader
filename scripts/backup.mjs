import { DatabaseSync, backup } from "node:sqlite";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
// SQLite's online backup API includes committed WAL data. Copying only the main
// database file while the app is running can produce an incomplete backup.
process.umask(0o077);
const source = process.env.DATABASE_PATH;
const destination = process.argv[2];
if (!source || !destination || resolve(source) === resolve(destination)) {
  throw new Error(
    "Set DATABASE_PATH and supply a different, new backup file path.",
  );
}
const reserved = await open(destination, "wx", 0o600);
await reserved.close();
const database = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
try {
  await backup(database, destination);
  console.log(
    "Database backup completed. Preserve ENCRYPTION_KEY separately to restore the WordPress connection.",
  );
} finally {
  database.close();
}
