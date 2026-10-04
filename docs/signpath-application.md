# SignPath Foundation application: draft answers

Apply at <https://signpath.org> ("Apply for free code signing"). Everything below is ready to paste; check the items marked
**YOU** first, because only you can do or confirm them.

## Before you apply (YOU)

- [ ] Turn on **two-factor authentication** for your GitHub account (SignPath requires MFA for all team members).
- [ ] Decide the contact name and email you want on the application (it is not stored anywhere in this repository).
- [ ] Read SignPath's [terms](https://signpath.org/terms) once; the answers below follow them.
- [ ] The repository must stay public and the project active; v0.1.x releases already exist.

## Project

- **Project name:** Brewhall
- **Project URL / download page:** <https://itsdommie.github.io/grimoire/>
- **Source repository:** <https://github.com/itsdommie/grimoire>
- **Latest release:** <https://github.com/itsdommie/grimoire/releases/latest>
- **Licence:** MIT (OSI-approved, no dual licensing, no commercial offering). See `LICENSE`.
- **Code signing policy page:** <https://itsdommie.github.io/grimoire/code-signing.html> (source: `docs/code-signing-policy.md`)
- **Privacy statement:** same page, "Privacy" section.

## Description

Brewhall is a free, open-source desktop application for Magic: The Gathering players on Windows and Linux. It searches the whole
card pool offline, builds and validates decks (Commander and the 60-card constructed formats), analyses mana bases, simulates
draws, tracks a card collection, shows the Comprehensive Rules, and provides a life/commander-damage tracker. It stores everything
locally, has no accounts or telemetry, and downloads card data from Scryfall and rules text from Wizards of the Coast.

It is built with Electron, React and Node.js (TypeScript). It contains no proprietary components. It is unofficial fan content
under Wizards of the Coast's Fan Content Policy and is not commercial.

## What we would sign

The Windows NSIS installer (`Brewhall-Setup-<version>.exe`), and the `Brewhall.exe` application executable inside it. Both are
built from this repository only.

## Build and release process (trusted build system)

- Builds run on **GitHub-hosted runners** from the tagged commit via `.github/workflows/release.yml`; no local builds are signed.
- The workflow type-checks, runs 370+ automated tests, builds the installers, and then installs the Windows installer on a clean
  runner and runs the end-to-end smoke tests against the installed app before anything is published.
- A release is published only when both the Windows and Linux builds pass.

## Team

| Role | Person |
|---|---|
| Author, Reviewer, Approver | itsdommie (<https://github.com/itsdommie>), sole maintainer |

Single-maintainer project: the same person holds all three roles. External pull requests are reviewed by the maintainer before
merging. MFA is enabled (see the checklist above).

## Reputation / why it matters

New, free, open-source apps trigger Windows SmartScreen's "Windows protected your PC" warning, which discourages installs. Signing
with a recognised publisher certificate lets users verify the publisher and lets SmartScreen reputation build up.

## After approval (maintainer steps)

See `docs/signing-setup.md`.
