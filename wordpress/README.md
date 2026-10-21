### Official WordPress plugin compatibility

Asterism connects to your configured `WORDPRESS_URL` using the official Enable Mastodon Apps (EMA) plugin. No custom plugin patch is required.

#### Prepare WordPress

1. Install and activate [Friends](https://wordpress.org/plugins/friends/), [ActivityPub](https://wordpress.org/plugins/activitypub/), and [Enable Mastodon Apps](https://wordpress.org/plugins/enable-mastodon-apps/) on a site you control. Configure your WordPress account and its incoming follows/feed.
2. Set Asterism's `WORDPRESS_URL` to the site's public base URL. Subdirectory installs are supported, for example `https://example.com/blog`; do not use the admin URL or `/wp-json`.
3. Complete Asterism's passkey and backup-code setup, then open Account → Connect WordPress. The app registers itself and redirects you to WordPress for consent. Confirm the WordPress account before approving.
4. In WordPress's settings for the registered Asterism app, enable **Friend Posts** and the post formats you want exposed. Recheck these settings if an authorized connection returns an unexpectedly empty feed.
5. Confirm your identity and feed in Asterism. Test replies, follows, reactions, media, and pagination against your own plugin combination before relying on them.

The callback is exactly `APP_ORIGIN` plus `/api/wordpress/callback`. Keep HTTPS available for both services. The WordPress backend must expose the Mastodon-compatible `/api/v1/*`, `/api/v2/*`, and `/oauth/*` routes beneath the configured base URL.

#### Connection flow

1. Register Asterism through `/api/v1/apps`, retaining the client ID and secret encrypted on the server. Registration creates the application entry in WordPress before any user access token exists. Reuse this registration on later attempts.
2. Initiate the authorization-code flow with the exact callback URI, a random single-use state bound to the signed-in Asterism session (ten-minute expiry), and an S256 challenge. Starting a replacement attempt invalidates the previous state for that session.
3. Validate and consume state before making an upstream token request. Exchange the code exactly once using the stored client secret, the same callback URI, and the genuine PKCE verifier. Do not probe with an incorrect verifier, rely on a vendor-specific error string, or retry after an error without PKCE.
4. Verify the WordPress identity, confirm the Asterism session is still valid, then store the access token encrypted on the server. Browser responses contain only account metadata. Identity failures attempt revocation; disconnect confirms upstream revocation before deleting the saved connection.

Production requests use HTTPS to the configured WordPress base URL and refuse redirects. Only the authenticated owner with completed passkey/backup setup can connect. Initiation uses the existing valid session and CSRF protection, without an additional passkey prompt or a five-minute verification requirement. WordPress handles its own authorization. Credential changes and disconnect retain their separate verification requirements.

#### Compatibility decision and security limit

The reviewed EMA 1.7.0 release's official authorization-code storage adapter does not persist PKCE metadata, so its bundled OAuth library does not enforce PKCE for those codes. Asterism still sends S256 parameters for forward compatibility, but does **not** claim that EMA 1.7.0 provides PKCE protection. Client authentication and session-bound state remain required; they are not equivalent to PKCE's additional transaction binding. This is a deliberate compatibility decision for this private, single-owner reader, not a general-purpose public OAuth client mode.

[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1) recommends PKCE for confidential clients and requires authorization-server support. Its [CSRF guidance](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1) requires session-bound one-use state when a client cannot rely on PKCE. [Mastodon's OAuth documentation](https://docs.joinmastodon.org/spec/oauth/) describes client-secret authorization and PKCE support in newer implementations. Revisit this decision when an official EMA release implements PKCE, without introducing a negative probe into real user authorizations.

#### Author histories and Friends content

Friend Posts and post-format visibility belong to the WordPress app registration; Asterism cannot override them through ordinary Mastodon query parameters.

Post dates link to the original status URL. Avatar, display-name, and handle links open Asterism's `#author=…` view, which reads the account's history with pagination. Some EMA/Friends combinations return an empty array from the standard account-status endpoint for remote authors even when their posts are present in the home timeline. EMA's account-status path excludes feed-cache post types. Asterism therefore falls back, when that first account page is empty, to filtering the authenticated home timeline by the original post author's account ID. Each request scans at most three pages of 30 items, stops as soon as it finds matching posts, removes repeated originals/boosts, and returns a continuation for more history. Sparse batches can be empty while still offering **Load older posts**. This covers available WordPress history, not the remote account's complete archive. No plugin files are modified.

#### Automated validation

The application regression suite covers both PKCE-enforcing and legacy servers, exactly one exchange, registration, encrypted server-only credentials, state replay/expiry/session binding, declined authorization, token failures without downgrade retries, and identity-failure revocation.

The optional `tests/wordpress-live.test.ts` exercises HTTP app registration, token exchange, identity verification, encrypted storage, an empty feed, disconnect, and token removal against a disposable local WordPress installation. It also checks wrong/missing client secrets, mismatched redirect URIs, reused authorization codes, and callback replay.

It requires the WordPress Studio CLI, a started disposable Studio site, and the official EMA plugin active. It seeds owner user ID 1 and real authorization codes through WP-CLI; it changes that disposable site's OAuth records. It does not automate browser consent, passkeys, Friends content, or federation. It refuses non-loopback targets and is skipped by default. Never use a valuable local or production site for this test.

```sh
ASTERISM_TEST_WORDPRESS_PATH=/absolute/path/to/disposable/site ASTERISM_TEST_WORDPRESS_URL=http://localhost:8887 npm test
```
