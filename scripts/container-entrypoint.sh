#!/bin/sh
set -eu
# Container hosts may mount persistent storage as root. Prepare only the
# configured database directory/files, then drop privileges before serving HTTP.
if [ "$(id -u)" = 0 ]; then
  # Validate all startup configuration and normalize traversal before chown.
  database="$(node --input-type=module -e 'import { configuration } from "./dist/server/config.js"; import { resolve } from "node:path"; process.stdout.write(resolve(configuration().dbPath));')"
  directory="$(dirname "$database")"
  # Never chown a root/system directory after a typo in DATABASE_PATH.
  case "$directory" in
    /|/app|/etc|/usr|/var|/home|/tmp|.|..)
      echo "Use a dedicated persistent database directory." >&2
      exit 1 ;;
  esac
  mkdir -p "$directory"
  chown node:node "$directory"
  chmod 700 "$directory"
  for path in "$database" "$database-wal" "$database-shm" "$directory/logs.sqlite" "$directory/logs.sqlite-wal" "$directory/logs.sqlite-shm"; do
    if [ -f "$path" ]; then
      chown node:node "$path"
      chmod 600 "$path"
    fi
  done
  exec gosu node "$@"
fi
exec "$@"
