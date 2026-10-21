### Third-party licenses

Asterism Reader's own code is GPL-3.0-or-later. Dependencies retain their original copyright and license notices; the project license does not replace them.

The browser bundle includes:

| Package | License |
| --- | --- |
| `@simplewebauthn/browser` | MIT |
| `dompurify` | Apache-2.0 (selected from its Apache-2.0 OR MPL-2.0 dual license) |

The build publishes these packages' supplied license texts at `/third-party-licenses.txt` and the Asterism GPL text at `/license.txt`. Preserve those files and embedded notices when redistributing the browser build. The source for the matching app version must also accompany a GPL distribution as required by the license; these notices are not a substitute for source availability.

Server dependencies and their transitive dependencies carry MIT, BSD, ISC, Apache-2.0, and other permissive notices in their installed package directories. Keep those notices when distributing a container or dependency bundle. The lockfile records package versions and license metadata; consult each package's license file for the actual terms. Recheck the browser list when adding bundled dependencies.

WordPress, Friends, ActivityPub, and Enable Mastodon Apps are separately installed upstream services/plugins, not bundled in this repository. Their licenses and configuration are managed independently.
