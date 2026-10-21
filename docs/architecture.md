### Architecture and development guide

Asterism is a single-owner web client with a server-side WordPress adapter. WordPress stores the feed and performs federation; Asterism owns authentication, preferences, lists, and the reader UI.

#### Request flow

```text
Browser -> same-origin Express API -> configured WordPress Mastodon API
                  |                         |
            account SQLite            Friends / ActivityPub
                  |
            separate log SQLite
```

The browser never receives an OAuth client secret or access token. `GET /api/session` supplies session state, CSRF token, account metadata, and the configured WordPress URL for UI labels. HTML from posts is sanitized before rendering. WordPress requests are constructed from the configured base URL, refuse redirects, and extract only pagination cursors from validated same-site links.

#### Source map

| Path | Responsibility |
| --- | --- |
| `src/server/config.ts` | Validates origins, storage, keys, port, and owner label at startup. No personal deployment defaults. |
| `src/server/deployment.ts` | Pins the account database to the reader and WordPress URLs. |
| `src/server/index.ts` | Private file permissions, process startup, periodic cleanup, graceful shutdown. |
| `src/server/app.ts` | Middleware ordering, session/settings/log routes, static assets, and safe error responses. Tests inject an isolated upstream. |
| `src/server/auth.ts` | Passkey enrollment/login, session-bound one-use challenges, backup confirmation, recovery, credential/session management. |
| `src/server/security.ts` | Session authorization, CSRF, encryption, hashing, freshness, and persistent rate limits. |
| `src/server/wordpress.ts` | OAuth registration/authorization, encrypted credentials, bounded API proxy, author history, feed/actions. |
| `src/server/store.ts` | SQLite schema and atomic transactions. `PRAGMA user_version` identifies the schema version. |
| `src/server/lists.ts` | Owner-scoped lists, CSV imports, follow-directory refresh, and matching. |
| `src/server/link-previews.ts` | Bounded public-web metadata retrieval with address validation and DNS pinning. |
| `src/server/logging.ts` | Redacted structured diagnostics, bounded persistence, and exports. |
| `src/shared/` | Pure rules shared by browser and server: identity, preferences, boosts, and image URLs. |
| `src/client/` | UI state, sanitized rendering, lists, and PWA lifecycle. |
| `public/` | Static shell, styles, icons, manifest, and service-worker template. |
| `scripts/` | Setup, bundling, online backup, and container startup. |
| `designs/` | Standalone historical prototypes with fictional sample accounts; excluded from runtime. |

#### Authentication state machine

- **Anonymous:** can request an enrollment challenge only with a valid expiring invitation, or attempt passkey login/recovery.
- **Setup:** enrolled passkey exists, but private reader routes remain blocked until newly generated backup codes are acknowledged.
- **Full:** can read and act through WordPress. Credential changes, disconnection, and backup replacement require recent verification.
- **Recovery:** a one-use code revokes previous sessions; a replacement passkey and confirmed new backup codes are required. The pending replacement key cannot sign in until confirmation; old credentials are then removed.

The owner has a random persistent ID. `OWNER_NAME` is presentation only. Registration and login enforce the configured RP hostname, exact origin, and user verification. Challenges are stored in SQLite, bound to a session and purpose, and consumed atomically. Sessions have 24-hour idle and seven-day absolute limits. Production uses Secure/HttpOnly/SameSite=Lax `__Host-` cookies.

#### Persistence and upstream boundaries

`Store.atomic()` groups transitions that must succeed together, including one-use recovery. Encrypted values use AES-256-GCM and a key outside the database. The deployment binding is encrypted in the same store and checked before routes are exposed. SQLite supports one application instance; horizontal scaling is not implemented.

The WordPress adapter checks a full session before every route. Mutations additionally require same-origin JSON and the CSRF token. OAuth state is single-use and session-bound; token exchange happens once. See the [EMA compatibility limit](../wordpress/README.md) for servers that do not enforce PKCE.

Link-preview retrieval uses a separate fetch path that never receives WordPress credentials. Authenticated users can request previews only for validated public addresses; redirects are revalidated, response size and runtime are bounded, and raw HTML is never returned for embedding.

#### Extending the application

Add pure cross-layer rules in `src/shared/`, server actions under the relevant authenticated router, and regression tests alongside related behavior. Keep credentials out of client code, responses, logs, and fixtures. Use the injected fetcher for WordPress tests; fail unexpected requests rather than falling through to a real network call.

Preserve the gate ordering in `createApp`: logger/security headers, private API caching policy, body parsing, cookies, session, CSRF, then route-specific authorization. New private endpoints must use the appropriate authorization middleware. Add behavior tests for failure paths as well as success.

The build fingerprints browser JS/CSS and versions the service worker from public assets. The worker caches only an explicit public allowlist and offers updates for user confirmation. Private APIs, OAuth callbacks, drafts, feeds, and tokens must never be added to its cache.
