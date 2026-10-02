# Grimoire: a local-first MTG deck lab

**End goal: an easy-to-install, one-stop desktop application for all things Magic: The Gathering, for Windows and Linux** (no macOS). Double-click installer, no Node/Python/Docker for the user, works offline after the first card-data download, no account, no paywall. It treats the whole card pool as a database you can query and simulate against, and uses a GPU when present but never requires one. **Commander first.**

Until the packaged app exists we develop it as a web app (React + local server); the desktop shell wraps the same code.

## Features (build order)

1. **Local card database.** Ingest Scryfall bulk data (Oracle Cards, ~160 MB) into SQLite. Support a Scryfall-style search syntax (`t:creature c:rg cmc<=3 o:"draw a card"`). Millisecond queries, works offline.
2. **Commander deck builder.** Legality, colour identity and singleton checks. Import/export Moxfield, Archidekt and plain-text lists. Standard and Modern later.
3. **Deck analysis.** Mana curve and colour pip distribution. Land-count and colour-source recommendations (Karsten's published mana math). Automatic role tagging (ramp, draw, removal, wipes, win conditions) with a "you're short on X" report.
4. **Goldfish simulator.** 10,000+ Monte Carlo games in a Web Worker: opening hands, mulligans, on-curve rate, colour-screw rate, typical turn the game plan comes online.
5. **Semantic card search.** Local embeddings of rules text on the GPU (default `bge-small` via `sentence-transformers`, Python venv). No API key needed.
6. **Collection tracker.** Import ManaBox/Moxfield CSVs, Scryfall prices, "what can I build from what I own?", "cheapest way to finish this deck".
7. **Claude advisor (OPTIONAL).** Chat panel whose tool calls hit the local database, so every suggestion is a real, legal card. Requires `ANTHROPIC_API_KEY`. Without it the panel reads "not configured" and the rest of the app is unaffected. The key is never written to the repo.

## Tech

TypeScript throughout. React + Vite frontend, small Fastify server, SQLite (`better-sqlite3`), Vitest. npm (not pnpm). Rules logic and the simulator get real tests, including checks against hypergeometric probabilities. Playwright end-to-end tests for the UI.

**Desktop packaging (decision pending confirmation): Electron + electron-builder.** It runs the existing Fastify/better-sqlite3 code unchanged in the main process (or a utility process), and produces an NSIS `.exe` installer for Windows and AppImage + `.deb` for Linux. Tauri is the lighter alternative but would mean shipping the Node server as a sidecar or rewriting the backend in Rust, so it's not worth it here.

Consequences for the design:
- **Data location:** the DB and downloaded Scryfall data live in the per-user app-data directory (`app.getPath('userData')`), not the repo. First run downloads the bulk data with a progress screen; a "check for updates" action re-ingests.
- **Semantic search (Phase 3):** no Python venv in the shipped app. Run `bge-small` as ONNX through `onnxruntime-node` (CPU by default, CUDA/DirectML optional), with embeddings precomputed or built on first run.
- **Claude advisor key:** stored via the OS keychain (Electron `safeStorage`), never on disk in plain text or in the repo.
- **Simulator:** Web Worker in the renderer, so it needs nothing native.
- **Native modules:** `better-sqlite3` must be rebuilt per platform/Electron version. Windows installers are built on Windows (CI) or via cross-build; Linux on Linux.
- **Docker/Proxmox** is demoted to an optional self-hosted mode, not the main delivery path.

## Phases

| Phase | Result |
|---|---|
| 0 | Repo scaffold, Scryfall ingest, search |
| 1 | Deck builder + import/export |
| 2 | Analysis + simulator |
| 2.5 | **Desktop shell + installers** (Electron, userData storage, first-run ingest, Windows + Linux builds). Done early to de-risk packaging before more features pile up |
| 3 | Semantic search (ONNX, optional GPU) |
| 4 | Collection + prices |
| 5 | Claude advisor, polish, auto-update, optional Docker mode |

"One stop for everything MTG" beyond the deck lab is a backlog to prioritise later (e.g. rules/comprehensive-rules lookup, life/commander-damage tracker, set and format browser, price watch). Not scheduled yet.

Each phase ends with something usable.

## Ground rules

- **Scryfall:** use bulk data rather than hammering the API, send a proper `User-Agent` and `Accept` header, respect rate limits, hotlink card images (never re-host, crop or alter them), attribute Scryfall.
- **Wizards:** non-commercial, per the Fan Content Policy.
- **GitHub:** repo is **private** unless Dommie says otherwise. Never push without being asked.
- **Secrets:** never commit API keys or tokens.
- **Environment:** Node 26, SQLite 3.53, Git, `gh` logged in as `itsdommie`. Dev machine is Linux, so Windows installers need CI or a cross-build; testing them locally isn't possible here. Docker needs sudo/daemon fixes if the optional self-hosted mode is built.
- **Distribution:** Windows and Linux only. Never require end users to install Node, Python or Docker. Don't push to GitHub (needed for CI builds) until asked.

## Status

Plan approved. Commander first, Claude advisor included as optional.

- **Phase 0: done.** npm workspaces (`shared`, `server`, `web`). `npm run ingest` pulls the Scryfall Oracle Cards bulk file (~35k cards, ~7s) into `data/grimoire.db`. Scryfall-style search (colours incl. guilds, `id:`/`commander:`, numeric ops, rarity, formats, keywords, `is:`, `or`/`-`/parentheses, quoted phrases) compiles to parameterised SQL; queries take ~10-20ms. Fastify API (`/api/cards/search`, `/api/cards/by-name/:name`, `/api/health`), React search UI with hotlinked images and Scryfall/Wizards attribution. 21 Vitest tests + 3 Playwright e2e tests (system Chromium).
- **Phase 1: done.** Commander deck builder. Decks live in the same SQLite file (`decks`, `deck_cards`; cards referenced by oracle id with no FK so re-ingest is safe). Shared, unit-tested rules in `packages/shared/src/deck.ts`: 100-card size, singleton (basics, "any number" and "up to N" cards handled), colour identity (union across two commanders), Commander legality (banned vs not legal reported separately), commander eligibility and valid pairs (Partner, Partner with, Partner variants, Friends forever, Background, Doctor's companion). Sideboard is ignored by validation. Import accepts plain text, Moxfield and Archidekt text exports (set/collector/foil/tag decorations stripped, section headers and `SB:` honoured, front-face names resolve split/DFC cards) and reports unrecognised lines; export is sectioned or plain. UI: deck selector, grouped list with live validation, +/−/★/move/remove, hover-to-add on search results, search auto-narrowed to the commander's colours. API: `/api/decks` CRUD, `PUT /api/decks/:id/cards`, `POST /api/decks/import`, `GET /api/decks/:id/export`. 55 Vitest tests, 7 Playwright tests (run against a throwaway DB copy on ports 3101/5273).
  - Not done / deliberately out of scope: importing by Moxfield/Archidekt *URL* (needs scraping their sites; paste the text export instead), Standard/Modern rules (later, as planned), companion/maybeboard distinction (all sideboard).
- **Next:** Phase 2 (deck analysis: curve, pips, land/colour-source maths, role tagging; then the goldfish simulator).
