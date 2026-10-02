# Grimoire

A local-first Magic: The Gathering deck lab, packaged as a desktop app for **Windows and Linux**. See [PLAN.md](PLAN.md).

## Install

Installers are built by CI (see `.github/workflows/build.yml`) or locally with `npm run desktop:dist`:

- **Windows:** `Grimoire-Setup-<version>.exe` (NSIS installer, per-user, no admin needed).
- **Linux:** `Grimoire-<version>-x86_64.AppImage` (make it executable and run it) or `Grimoire-<version>-amd64.deb`.

On first launch Grimoire downloads the card database from [Scryfall](https://scryfall.com) (~25 MB) once, then works offline.
Your decks and card data live in the app's user-data folder (Help → Open data folder).

*Troubleshooting (Linux):* on distros that restrict unprivileged user namespaces (e.g. Ubuntu 24.04+), the AppImage may need
`--no-sandbox`; the `.deb` sets up the Chromium sandbox properly. Logs are in `<data folder>/logs/grimoire.log`.

## Develop

Requires Node 24+ (Node's built-in `node:sqlite` is used, so there are no native modules to build).

```sh
npm install
npm run ingest        # download Scryfall bulk data into ./data (dev only; the app does this on first run)
npm run dev:server    # API on :3001
npm run dev:web       # UI on :5173
npm run desktop       # build and run the Electron app
npm run desktop:pack  # unpacked app in ./release (fast, for testing)
npm run desktop:dist  # installers for the current OS in ./release
```

Tests:

```sh
npm test              # unit + API tests (Vitest)
npm run e2e           # browser UI tests (Playwright; needs `npm run ingest` first; uses /usr/bin/chromium and throwaway data)
npm run e2e:desktop   # launches the real Electron app (needs a display); GRIMOIRE_EXE=<path> tests a packaged build
```

Search syntax follows Scryfall: `t:creature c:rg cmc<=3 o:"draw a card"`, `f:commander id<=wubg`, `-c:u`, `(a or b)`.
`c:` means "at least these colours", `id:` means "within this colour identity".

## Decks

Paste a plain, Moxfield or Archidekt text list via **Import**; **Copy list** / **Download** export a re-importable list.
Validation covers size, singleton, colour identity, Commander legality and commander/partner eligibility.

## Offline install

Set `GRIMOIRE_BULK_FILE=/path/to/oracle-cards.jsonl[.gz]` (a Scryfall "Oracle Cards" bulk file) to import card data from disk
instead of downloading it.

## Security notes

The desktop app runs a local server on a random loopback port. API calls need a per-launch token that only the app's own page
receives, and requests with a non-loopback `Host` header are rejected, so other programs and websites can't read or change your decks.

Card data and images are from Scryfall (images are hotlinked, never re-hosted). Magic: The Gathering is © Wizards of the Coast;
this is unofficial, non-commercial fan content.
