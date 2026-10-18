import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export class Store {
  readonly db: DatabaseSync;
  onAudit?: (event: string) => void;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), uid TEXT UNIQUE NOT NULL, setup INTEGER NOT NULL DEFAULT 0, preferences TEXT NOT NULL DEFAULT '{"theme":"system","font":"sans","size":18,"accent":"violet"}');
   CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES owner(uid), public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid TEXT, phase TEXT NOT NULL, csrf TEXT NOT NULL, recent INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, touched INTEGER NOT NULL, expires INTEGER NOT NULL, recovery_key TEXT);
   CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE, purpose TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS recovery_codes (hash TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES owner(uid));
   CREATE TABLE IF NOT EXISTS pending_codes (session TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE, hashes TEXT NOT NULL, expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, event TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS reader_lists (id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES owner(uid), title TEXT NOT NULL, name_key TEXT NOT NULL, UNIQUE(uid,name_key));
   CREATE TABLE IF NOT EXISTS list_members (list_id TEXT NOT NULL REFERENCES reader_lists(id) ON DELETE CASCADE, account_key TEXT NOT NULL, PRIMARY KEY(list_id,account_key));
   CREATE TABLE IF NOT EXISTS list_sources (uid TEXT NOT NULL REFERENCES owner(uid), name_key TEXT NOT NULL, list_id TEXT REFERENCES reader_lists(id) ON DELETE SET NULL, PRIMARY KEY(uid,name_key));
   CREATE TABLE IF NOT EXISTS list_imported (uid TEXT NOT NULL REFERENCES owner(uid), name_key TEXT NOT NULL, account_key TEXT NOT NULL, PRIMARY KEY(uid,name_key,account_key));
   CREATE TABLE IF NOT EXISTS list_follows (uid TEXT NOT NULL REFERENCES owner(uid), account_key TEXT NOT NULL, account TEXT NOT NULL, seen TEXT NOT NULL, PRIMARY KEY(uid,account_key));
   CREATE TABLE IF NOT EXISTS list_sync (uid TEXT PRIMARY KEY REFERENCES owner(uid), run TEXT NOT NULL, cursor TEXT, visited TEXT NOT NULL DEFAULT '[]', completed INTEGER);
   PRAGMA user_version=2;
  `);
  }
  get<T = Record<string, any>>(
    sql: string,
    ...args: SQLInputValue[]
  ): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T = Record<string, any>>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  audit(event: string) {
    this.run("INSERT INTO audit(event,at) VALUES(?,?)", event, Date.now());
    this.onAudit?.(event);
  }
  cleanup() {
    const now = Date.now();
    this.run("DELETE FROM sessions WHERE expires<?", now);
    this.run(
      "DELETE FROM credentials WHERE enabled=0 AND id NOT IN (SELECT recovery_key FROM sessions WHERE recovery_key IS NOT NULL)",
    );
    this.run("DELETE FROM challenges WHERE expires<?", now);
    this.run("DELETE FROM pending_codes WHERE expires<?", now);
    this.run("DELETE FROM limits WHERE expires<?", now);
    this.run("DELETE FROM audit WHERE at<?", now - 90 * 86400_000);
  }
}
