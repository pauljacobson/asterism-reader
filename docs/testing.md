### Testing guide

#### Required local checks

```sh
npm ci
npm run validate
```

`validate` runs `format:check`, `typecheck`, `build`, then `test`. Run the build first when invoking `npm test` separately because static-asset/PWA tests inspect `dist/public`. Formatting uses Prettier; there is no separate ESLint configuration. `npm run format` fixes supported source/test/script/public files. The TypeScript check covers `src/**/*.ts`; test files are executed through `tsx` rather than typechecked by that script.

To work on one behavior:

```sh
node --import tsx --test tests/config.test.ts tests/setup.test.ts
node --import tsx --test tests/security.test.ts
```

The test runner needs local socket access for HTTP fixtures and `tsx` IPC. Tests create synthetic credentials and temporary or in-memory databases; normal runs make no real WordPress calls. They do not load your `.env`. Expected 401/403/502 log entries exercise failure paths, not necessarily failures of the suite.

#### Automated coverage

| Test | What it verifies |
| --- | --- |
| `config.test.ts` | Independent domains, WordPress subdirectories, transport/URL validation, account labels, port/storage limits, and database endpoint binding. |
| `container-entrypoint.test.ts` | Custom volume paths, account/log sidecars, privilege dropping, and rejection before permission changes; privileged commands are stubbed. |
| `setup.test.ts` | Local/production setup, separate random secrets, invitation hashes/expiry, private permissions, no secrets on stdout, refusal to overwrite, and invalid-input behavior. |
| `security.test.ts` | Passkey setup gates, sessions, CSRF, encryption, one-use recovery, OAuth state/exchange/error handling, private routes, WordPress actions, configured labels/endpoints, subdirectory pagination, and caching. |
| `persistence.test.ts` | Account/preferences/recovery/encrypted credentials across database reopening and SQLite online backup. |
| `upgrade.test.ts` | A frozen legacy database through upgrade and restart: existing production cookie, passkey identity, expired enrollment invitation, preferences, recovery codes, lists, encrypted WordPress token, and deployment binding. All data and upstream responses are synthetic. |
| `lists.test.ts` | CSV validation, canonical identities, import/edit preservation, list persistence, paginated follows, failed refresh retention, and sparse filtered feeds. |
| `logging.test.ts` | Redaction, request correlation, authorization, exports, retention, and storage failure fallback. |
| `link-previews.test.ts` | Metadata extraction, private-address rejection, DNS pinning, redirect validation, bounded retrieval, and coalesced caching. |
| `pwa.test.ts` | Manifest/icons, public-asset cache allowlist, private route exclusions, offline fallback, and explicit update consent. |
| `wordpress-live.test.ts` | Optional integration against real EMA on disposable local WordPress; skipped by default. |

The mocked integration suite exercises application behavior without proving that a particular WordPress plugin version or authenticator works. Keep real-device and deployment acceptance separate from automated claims.

#### Browser acceptance fixtures

The repository includes Playwright-compatible acceptance functions in `tests/*-browser-flow.txt`. These are manual acceptance scripts, not part of `npm test`; each starts with the function to pass to a Playwright CLI `run-code` session. Use Chromium and the virtual WebAuthn authenticator created by each flow. The Playwright tooling/browser must be installed separately.

Build, then start a **fresh** fixture process for each flow:

```sh
npm run build
node --import tsx tests/browser-server.ts
```

The default fixture listens at `http://localhost:4321`, uses an in-memory account and fixed synthetic invitation, and injects fake WordPress responses. It never contacts WordPress. Run `tests/browser-flow.txt` for enrollment, backup confirmation, login, recovery, reading, actions, search, and preferences. Logs have a separate `tests/logs-browser-flow.txt` scenario.

For lists:

```sh
ASTERISM_BROWSER_PORT=4326 ASTERISM_LISTS_FIXTURE=1 node --import tsx tests/browser-server.ts
```

Then run `tests/lists-browser-flow.txt`. Other files cover avatars, reader layouts, link previews, boosts, and PWA behavior; read each file's fixture URL before running. Static mocked flows can be served from `dist/public` on their indicated local port. Restarting the fixture resets account state; never point these scripts at a real reader deployment.

For connection controls, start a fresh fixture with `ASTERISM_BROWSER_PORT=4327 node --import tsx tests/browser-server.ts`, then run `tests/connection-browser-flow.txt`. It enrolls a synthetic account, removes its virtual authenticator, and verifies disconnect and reconnect make no passkey-login requests. The WordPress consent redirect is intercepted in the browser; no real site is contacted.

Manually check desktop/mobile layouts, keyboard navigation, the configured WordPress label in Account/connection/follow prompts, and one real desktop and mobile passkey. Browser fixture assertions do not establish real-device support.

#### Optional real WordPress integration

Follow [WordPress compatibility validation](../wordpress/README.md). The Studio CLI, disposable local site, and unmodified EMA plugin are prerequisites:

```sh
ASTERISM_TEST_WORDPRESS_PATH=/absolute/path/to/disposable/site \
ASTERISM_TEST_WORDPRESS_URL=http://localhost:8887 npm test
```

This writes OAuth records to that disposable site. It also deletes its synthetic app registration to verify `invalid_client` recovery, checks that reconnect preserves a valid registration and revokes the temporary validation token, and disconnects outside the recent-passkey window. No production URL is accepted. It does not cover browser consent, a full Friends feed, federation, or real authenticator ceremonies.
