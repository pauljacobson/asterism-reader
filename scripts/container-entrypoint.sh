#!/bin/sh
set -eu
# Railway mounts volumes as root. Give this app's database files to the runtime
# account, then drop privileges before accepting any HTTP requests.
if [ "$(id -u)" = 0 ]; then
  chown node:node /data
  chmod 700 /data
  for path in /data/asterism.sqlite /data/asterism.sqlite-wal /data/asterism.sqlite-shm; do
    if [ -f "$path" ]; then
      chown node:node "$path"
      chmod 600 "$path"
    fi
  done
  exec gosu node "$@"
fi
exec "$@"
