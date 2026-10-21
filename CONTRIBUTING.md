### Contributing

Use Node.js 24 or later and install the lockfile with `npm ci`. Read [architecture](docs/architecture.md) before changing authentication, persistence, or upstream requests. Use synthetic accounts and disposable databases for development.

Run targeted tests while working, then `npm run validate` before submitting a change. It checks formatting, types, the production build, and automated behavior locally. Describe what changed, why, which local checks passed, and any skipped integration or real-device validation. See [testing](docs/testing.md) for commands and coverage.

Do not commit credentials, real feeds, account exports, local configuration, database files, or deployment identifiers. Use reserved example domains in fixtures. Keep documentation examples independent of any particular host or account. Changes to configuration must update `.env.example`, the deployment guide, and tests together.

Follow applicable `AGENTS.md` instructions. The current checkout has a temporary GitHub Actions restriction through October 31, 2026; local validation is required and workflows must not be initiated during that period.

Contributions are provided under GPL-3.0-or-later, the project's license. Retain third-party license notices when adding or distributing dependencies.
