### Deployment and operations

Asterism uses one Node.js process and local SQLite files. Deploy one replica with persistent storage and put an HTTPS reverse proxy in front of it. Run a separate instance and database for each owner. Do not use ephemeral container storage, multiple writers sharing a volume, or an HTTP-only public endpoint.

#### Configuration reference

The app reads environment variables; `npm start` also reads `.env` when present. The Docker entrypoint uses the container environment. `.env.example` documents names without secrets.

| Variable | Meaning |
| --- | --- |
| `NODE_ENV` | Set `production` on a deployed instance. Enables production transport and cookie requirements. |
| `APP_ORIGIN` | Required exact reader origin, such as `https://reader.example.com`, with no path or trailing slash. Its hostname is the passkey RP ID. |
| `WORDPRESS_URL` | Required public WordPress base URL, such as `https://wordpress.example.com` or `https://example.com/blog`. A trailing slash is normalized. Credentials, query strings, and fragments are rejected. HTTP is allowed only on loopback in development. |
| `OWNER_NAME` | Optional passkey-manager account label, default `Reader`; 1–64 characters. Changing it affects new passkeys, not the underlying owner ID. |
| `PORT` | Listening port, default `4320`; Docker and production setup use `8080`. Must be 1–65535. |
| `DATABASE_PATH` | Default `./data/asterism.sqlite` in development. Production requires an absolute file path on persistent storage. Docker defaults to `/data/asterism.sqlite`. Use a dedicated directory. |
| `ENCRYPTION_KEY` | Required 32 random bytes encoded as 64 hexadecimal characters. Encrypts OAuth credentials and deployment metadata; retain securely for restores. |
| `OWNER_INVITE_HASH` | Required SHA-256 hash of the random initial owner invitation. Setup generates this; never expose the plaintext invitation publicly. |
| `OWNER_INVITE_EXPIRES_AT` | Required ISO timestamp. Setup gives the invitation 24 hours; expired invitations cannot enroll a new owner. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error`; default `info`. Logs are stored in a separate `logs.sqlite` beside the account database and emitted to the console. |

The reader must be hosted at the root of its origin. WordPress may use a subdirectory. No arbitrary forwarded IP headers are trusted: users behind a reverse proxy may share an authentication-rate-limit bucket. Validate your actual proxy chain before changing Express proxy trust.

#### Generate configuration

Run in a fresh clone with dependencies installed:

```sh
npm run setup:production -- https://reader.example.com https://wordpress.example.com
```

Copy `work/production.env` into your host's secret/environment configuration. Keep `work/production-setup-url.txt` private until the service is ready. Both files are created with owner-only permissions and are ignored by Git and Docker. Setup refuses to replace either existing file. It is a fresh-install tool, not a secret-rotation tool. On a partial disk-write failure, inspect and preserve any generated files before retrying in a fresh directory.

If an unused invitation expires, generate a new setup in a separate scratch clone and transfer only its invitation hash, expiry, and corresponding private link. Preserve the existing encryption key and database. Once the owner is enrolled, invitation expiry does not affect sign-in; keep the required variables configured.

#### Docker

```sh
docker build -t asterism-reader .
docker volume create asterism-data
docker run -d --name asterism-reader --restart unless-stopped \
  --env-file work/production.env \
  --mount source=asterism-data,target=/data \
  -p 127.0.0.1:8080:8080 \
  asterism-reader
```

Configure your reverse proxy to terminate TLS for `APP_ORIGIN` and forward to `127.0.0.1:8080`. A managed container host can supply the same environment, Dockerfile, persistent mount, and HTTPS routing. Configure its health check to `/healthz` and keep the replica count at one. The example binds the application port to loopback; the reverse proxy exposes HTTPS.

The entrypoint prepares the dedicated database directory and existing account/log database files, then drops to the `node` user. If you supply your own unprivileged container user, provision writable permissions yourself. Custom database paths must be backed by an appropriate mount. Never point `DATABASE_PATH` at a shared system directory.

#### Node.js without Docker

```sh
npm ci
npm run build
```

Install the production environment securely using your service manager, or copy it to an owner-readable `.env` in the app directory. Set `DATABASE_PATH` to a persistent directory writable by the dedicated service user, such as `/var/lib/asterism/asterism.sqlite`. Run `npm start` under that user, configure process restart, and route HTTPS to the configured port. The process binds all interfaces; firewall the application port so access goes through your reverse proxy.

#### First-run acceptance

1. Check `GET /healthz` returns `{"ok":true}` over HTTPS, and confirm the service owns its persistent files.
2. Open the private invitation at your permanent hostname. Create a passkey, save the eight recovery codes, and confirm saving them. Add a second passkey and test sign-out/sign-in.
3. In Account, select Connect WordPress and approve the requested access yourself. Configure Friend Posts and post formats in the WordPress app registration as described in [WordPress setup](../wordpress/README.md).
4. Check identity, feed, author history, and follow pagination. Use a test account for reply/follow/reaction acceptance, because those actions affect WordPress.
5. Verify a controlled restart retains the account, settings, and connection. Exercise recovery and restore in a disposable instance before relying on them.

#### Upgrades and existing installations

Back up the database and retain the encryption key before upgrading. Existing installations must now set `WORDPRESS_URL` explicitly to the **same site used previously**; there is no personal-site fallback. `OWNER_NAME` is optional. Preserve `APP_ORIGIN`, `ENCRYPTION_KEY`, and `DATABASE_PATH`.

Before pushing to a branch that your host deploys automatically, validate its existing environment against the new configuration requirements. Add newly required variables on the host before the update. Disabling GitHub Actions does not disable a host's independent GitHub autodeploy integration. Run `npm run validate` locally before pushing, then verify the host deployed the intended commit and `/healthz` succeeds. Keep one replica and the existing persistent mount. A passing health check confirms startup and database access; also check sign-in and the connected feed after upgrading.

On the first startup of an older database, the app records the configured reader and WordPress URLs. Older data contains no endpoint binding, so the operator must verify those values before that first upgrade. On later starts, mismatches fail before serving requests. This prevents accidentally sending stored credentials to a different configured site. A different reader origin or WordPress site requires a fresh database and new authorization; data migration between sites is not implemented.

Changing a passkey label does not re-enroll existing credentials. Do not run setup over an existing installation or rotate the encryption key without a migration: old encrypted data would become unreadable.

#### Backups and restore

```sh
npm run backup -- /secure/backups/new-backup.sqlite
```

In a container, run the same command through `docker exec` with a writable destination, then copy the backup off the service volume. The command uses SQLite's [online backup API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourceDb-path-options), includes committed WAL data, and refuses an existing destination. A failed backup may leave an incomplete file: verify it before use. The account database includes passkeys, recovery hashes, lists, preferences, and encrypted credentials. Diagnostics are separate and not included. Schedule backups and retention with your host; the app has no scheduler.

Preserve the original encryption key separately. To restore, stop the app, retain the current database and its sidecars, restore a verified backup into a clean dedicated directory, and use the original reader/WordPress URLs and encryption key. Remove restored sessions, challenges, and pending codes before reopening access. Validate SQLite integrity and account recovery before discarding the previous database. Never copy only the main file of a running WAL database.

#### Public release preparation

Publish source and synthetic fixtures only. Keep `.env*` (except `.env.example`), `work/`, `data/`, exports, databases, browser output, and backups private. Check `git status` and staged file contents before publishing. `.gitignore` does not remove previously tracked data.

Working-tree cleanup does not scrub Git history, commit messages, author metadata, forks, or remote deployment configuration. Review history separately before changing repository visibility. If old personal records must remain private, choose an explicitly reviewed history rewrite or publish a fresh source snapshot. Do not run automated destructive history cleanup as part of normal setup.
