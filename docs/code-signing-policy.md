# Code signing policy

Brewhall's Windows installer is code-signed so that Windows can verify who built it and that it hasn't been tampered with.

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

Only the Windows installer (`Brewhall-Setup-<version>.exe`) and the Brewhall application executable inside it, built from the
source code in this repository by the [Release workflow](../.github/workflows/release.yml) on GitHub-hosted runners. Nothing
built anywhere else is submitted for signing. Third-party libraries and the Electron runtime that Brewhall bundles keep their own
signatures and licences (see `THIRD_PARTY_NOTICES.txt`).

Linux packages (`.AppImage`, `.deb`) are not signed with this certificate. Their checksums are published in the release's
`latest-linux.yml`, which the auto-updater verifies.

## Team and roles

| Role | Responsibility | Who |
|---|---|---|
| **Author** | Can change the source code | [@itsdommie](https://github.com/itsdommie) |
| **Reviewer** | Reviews every pull request from outside contributors before it is merged | [@itsdommie](https://github.com/itsdommie) |
| **Approver** | Approves each signing request, after checking that it comes from the Release workflow for a tagged version | [@itsdommie](https://github.com/itsdommie) |

All team members use multi-factor authentication for GitHub and for SignPath. New members are added here, and to the repository,
only after they have been reviewed and agreed to these rules.

## How a release is signed

1. A maintainer tags a version (`vX.Y.Z`), which must match the version in `packages/desktop/package.json`.
2. The Release workflow builds the installer on a GitHub-hosted runner, runs the automated tests, and smoke-tests the built app.
3. The unsigned installer is submitted to SignPath from that workflow run. SignPath records which repository, commit and workflow
   run it came from.
4. The approver approves the request only if it matches a tag they created.
5. The signed installer replaces the unsigned one, the auto-update checksum file is regenerated for it, and the release is published.

## Privacy

Brewhall does not collect, store or transmit personal data about its users. It has no accounts, analytics or telemetry. Your decks
and collection stay on your computer. The app contacts only these services, to do what you ask of it:

- **Scryfall** (card data and card images),
- **Wizards of the Coast** (the Comprehensive Rules text),
- **GitHub** (checking for new versions of Brewhall; can be turned off in the Help menu),
- **Hugging Face** (once, and only if you turn on semantic search, to download a language model).

Code signing itself does not involve any user data.

## Reporting a problem

If you believe a Brewhall release is malicious or was signed in error, open an issue at
<https://github.com/itsdommie/grimoire/issues> (or use GitHub's private vulnerability reporting for security problems).
