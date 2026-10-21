-- Frozen schema from before configurable WordPress endpoints and deployment binding.
-- Keep this fixture independent of Store so upgrades exercise real existing files.
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
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
