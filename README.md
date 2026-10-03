# Grimoire

A local-first Magic: The Gathering deck lab, packaged as a desktop app for **Windows and Linux**. See [PLAN.md](PLAN.md).

## Install

Download the latest version from the **[website](https://itsdommie.github.io/grimoire/)** or the
**[releases page](https://github.com/itsdommie/grimoire/releases/latest)**:

- **Windows:** `Grimoire-Setup-<version>.exe` (installs just for you, no administrator rights). Windows may say "Windows protected
  your PC" because the app isn't signed with a paid certificate: choose *More info*, then *Run anyway*.
- **Linux:** `Grimoire-<version>-x86_64.AppImage` (make it executable and run it) or `Grimoire-<version>-amd64.deb`.

On first launch Grimoire downloads the card database from [Scryfall](https://scryfall.com) (~25 MB) once, then works offline.
Windows and the AppImage update themselves (Help → Check for updates; it can be switched off). Your decks and card data live in
the app's user-data folder (Help → Open data folder).

*Troubleshooting (Linux):* on distros that restrict unprivileged user namespaces (e.g. Ubuntu 24.04+), the AppImage may need
`--no-sandbox`; the `.deb` sets up the Chromium sandbox properly. Logs are in `<data folder>/logs/grimoire.log`.

## Privacy

No account, no analytics, no tracking. Grimoire contacts only: Scryfall (card data and images), GitHub (update checks, can be
turned off) and, once and only if you enable semantic search, Hugging Face (a 34 MB model). What you create stays on your computer.

## Code signing

The Windows installer is being set up for free code signing through the SignPath Foundation; the policy is in
[docs/code-signing-policy.md](docs/code-signing-policy.md) (also on the [website](https://itsdommie.github.io/grimoire/code-signing.html)).

## Releasing (maintainers)

Bump `version` in `packages/desktop/package.json`, commit, then `git tag vX.Y.Z && git push --tags`. The *Release* workflow builds
Windows and Linux installers, smoke-tests them, and publishes the release (including the files the auto-updater reads) only if
both succeed. The website in `site/` is deployed to GitHub Pages by the *Website* workflow.

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

## Card details and function search

Click any card (in results or in a deck) for its details: image (with a flip for double-faced cards), text, legality, price,
official rulings and community function tags, all offline once the data is downloaded. Search understands Scryfall's function
tags too: `otag:ramp c:g cmc<=3`, `otag:sweeper f:commander`. Rulings and tags are downloaded alongside the card data and refresh
with "Check for card updates".

## Play

The **Play** tab is a life and commander-damage tracker for 2-6 players: life, poison/energy/experience, commander damage per
opponent, monarch, turn order, undo, dice and coin. The game is kept across restarts.

## Your data

Decks and your collection live in the app's data folder (Help → Open data folder). **Back up to a file** in the footer saves them
to one JSON file; **Restore from a file…** brings them back (adding to what you have, or replacing it). Grimoire also keeps a small
copy of your decks and collection in a `backups` folder before it upgrades its database.

## Search by meaning (optional)

Turn on **Semantic search** in the footer to search by what a card does, not just by keywords: `about:"punish opponents for
drawing extra cards"`, `about:"protect my commander" c:w`. Setup downloads a small language model once (about 34 MB, checked
against a pinned checksum) and indexes your cards on this computer in a few minutes; nothing you type leaves it. It works best
on concrete rules-text descriptions. Uses [BGE-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT) via
[onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT). Developers: `npm run semantic` builds the index for the dev database.

## Analysis and simulation

The **Analysis** tab shows the mana curve, colour pips, a suggested land count, how many sources of each colour you need,
and a "you're short on X" report built from heuristic role tagging (ramp, draw, removal, wipes, ...). The **Simulate** tab
plays your deck alone thousands of times in a background worker and reports land-drop consistency, mulligans, colour
trouble and when your commander can first be cast. Both tabs explain their assumptions in the app; in particular the
colour-source numbers are a calibrated hypergeometric estimate, not Frank Karsten's published table.

## Android

**Install.** Download `Grimoire-<version>-android.apk` from the release called "Grimoire for Android" (Android releases are tagged
`android-v<version>`; they are never marked "latest", which the desktop updater reads) and open it on your phone. Android asks you to
allow installs from your browser or file manager once, because the app isn't on a store. Every release is signed with the same key;
its certificate SHA-256 is in `packages/mobile/signing-sha256.txt` and each release lists the file's checksum. The app shows a banner
when a newer version is out (or follow the repository with [Obtainium](https://github.com/ImranR98/Obtainium)); your decks and
collection are kept when you update. Releases are built and signed by `android-release.yml` when an `android-v<version>` tag is pushed
(the version is `packages/mobile/package.json`).

`packages/mobile` wraps the same web UI in an Android app (Capacitor). There is no server on the phone: the shared API routes
(`packages/server/src/routes.ts`) run in a web worker over SQLite compiled to WASM, in the app's private storage, with the card
database bundled in the APK. Decks, collection, search, rules, imports and the spare-copies option all work as on the desktop; on a
phone the card browser and the deck are separate panes behind a bar at the bottom. Search by meaning works too: turn it on in the
footer and the app downloads the language model (about 34 MB, checked against a fixed checksum) and the ready-made card index
(about 10 MB), which takes under a minute on Wi-Fi; after that it works offline and a search takes about a quarter of a second.

**Card scanner.** The **Scan** button opens the camera with a card-shaped outline. Hold a card in the outline and its name is read
on the phone (Google ML Kit, offline) and matched against the card database; once the same card is seen in two frames, one copy is
added to your collection or to the open deck, with a buzz and a green tick. It also reads the set code and collector number from
the bottom of the card, so the collection records the **exact printing** (and the Foil switch records foil copies). Older cards print
only a copyright year, or nothing: the scanner narrows by year and, if it still can't tell, shows the printings it could be for you to
pick (or add the card without one). Take the card away and show the next. Each scanned card has − and + to correct a mistake, and
**Done** keeps everything. It reads only the title bar and the bottom edge, so rules text that happens to be a card's name can't be
picked up, and Universes Beyond names work too.

**Card data updates.** The card database ships inside the app and then keeps itself current: once a week (a few seconds after the app
starts) it looks for a newer one, and **Check for card updates** at the bottom of the page does the same on demand. A weekly job
publishes the current card data (cards, legality, rulings, function tags, the rules, alternate names and every printing) as one
compact file. The app downloads it, unpacks it next to the live database and swaps it in the next time it starts, which it does for
you; your decks, collection and recorded printings are never part of it and come through untouched. On mobile data or with a data
saver on, the weekly look only says an update is waiting (with its size) and downloads it when you tap Download.

Building needs JDK 21 and the Android SDK (platform 36, build-tools 36). Then:

```
npm run ingest                        # once: the card database the APK bundles
npm run apk -w @grimoire/mobile       # build the web content, sync, and assemble a debug APK
npm run e2e:mobile                    # the UI on the on-device database, in a desktop and a phone-sized browser
ANDROID_APP=io.github.itsdommie.grimoire npx playwright test -c playwright.mobile.config.ts --project=phone   # the same flow in the real WebView on an emulator or phone
```

The debug APK (`npm run apk`) is signed with Android's throwaway debug key, so it is only for trying things; it can't be updated by a release build (a different signature), so move to the release app by backing up (the Backup button), uninstalling and reinstalling. Release builds read their key from `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; keep the key file and its password safe and never commit them: Android refuses to update an app that is signed with a different key.

## Collection

The **Collection** view tracks the cards you own: import a CSV from ManaBox, Moxfield, Archidekt or Deckbox (or paste a list), and
adjust counts with the +/- buttons or by hovering cards in **Cards**. `owned>=1` works in search, decks show how much of them
you own and what the rest would cost, and "What can I build?" ranks the commanders you own by how many of your cards fit them.
Prices are Scryfall's for its featured printing of each card, so they're a rough guide rather than the cheapest copy.

**Printings.** The collection counts copies of a card, and can also record which printing (and finish) each copy is. The card detail
lists every printing with a + / − for each finish; "+" says "one of the copies I already have is this one", so a collection imported
without printings can be filled in by hand. A ManaBox, Moxfield, Archidekt or Deckbox file that names the set, collector number and
foil (ManaBox's Scryfall ID is the most exact) is matched to printings on import, and the card then shows the art of the printing you
own. Decks stay card-level. Printing data (about 4 MB) is downloaded with the card data.

**Building a new deck without breaking up the others.** A collection export usually leaves out the cards sitting in built decks, so
a deck has an **Add to collection** button (and an import option) that adds its cards to your owned counts as a separate step. Then
tick **Skip copies already in my decks** and Grimoire counts *spare copies*: copies you own minus copies in decks. With 5 Sol Rings
in the collection and 4 decks each running one, there is still one spare, so Sol Ring can still be suggested. The choice applies to
"Only cards I own" in search (`spare>=1` works in queries too), the deck's missing-cards report and "What can I build?". The deck you
are building doesn't count against itself, and a Commander deck's maybeboard holds no copies.

## Decks

Paste a plain, Moxfield or Archidekt text list via **Import**; **Copy list** / **Download** export a re-importable list.
Validation covers size, singleton, colour identity, Commander legality and commander/partner eligibility.

Cards printed under another name import and search under either one: "Avengers Monitoring Station" is Herald's Horn, so a list or
collection export that uses the Universes Beyond name still finds the card (Arena's "A-" rebalanced names work too). The names ship
with the app and are refreshed weekly, so new sets are picked up.

## Offline install

Set `GRIMOIRE_BULK_FILE=/path/to/oracle-cards.jsonl[.gz]` (a Scryfall "Oracle Cards" bulk file) to import card data from disk
instead of downloading it; `GRIMOIRE_RULINGS_FILE` and `GRIMOIRE_TAGS_FILE` do the same for rulings and Oracle Tags.

## Security notes

The desktop app runs a local server on a random loopback port. API calls need a per-launch token that only the app's own page
receives, and requests with a non-loopback `Host` header are rejected, so other programs and websites can't read or change your decks.

## Legal

Grimoire is MIT licensed (see [LICENSE](LICENSE)); notices for its dependencies ship with the app (`THIRD_PARTY_NOTICES.txt`).
Card data, rulings, tags and images are from [Scryfall](https://scryfall.com) (images are hotlinked, never re-hosted).

Grimoire is unofficial Fan Content permitted under the Fan Content Policy. Not approved or endorsed by Wizards. Portions of the
materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC. Magic: The Gathering is a trademark of Wizards of
the Coast LLC.
