# Grimoire: a local-first MTG deck lab

A fast, offline-capable web app that treats the whole Magic card pool as a database you can query and simulate against. No account, no paywall. Uses the local RTX 3090 for the heavy parts. **Commander first.**

## Features (build order)

1. **Local card database.** Ingest Scryfall bulk data (Oracle Cards, ~160 MB) into SQLite. Support a Scryfall-style search syntax (`t:creature c:rg cmc<=3 o:"draw a card"`). Millisecond queries, works offline.
2. **Commander deck builder.** Legality, colour identity and singleton checks. Import/export Moxfield, Archidekt and plain-text lists. Standard and Modern later.
3. **Deck analysis.** Mana curve and colour pip distribution. Land-count and colour-source recommendations (Karsten's published mana math). Automatic role tagging (ramp, draw, removal, wipes, win conditions) with a "you're short on X" report.
4. **Goldfish simulator.** 10,000+ Monte Carlo games in a Web Worker: opening hands, mulligans, on-curve rate, colour-screw rate, typical turn the game plan comes online.
5. **Semantic card search.** Local embeddings of rules text on the GPU (default `bge-small` via `sentence-transformers`, Python venv). No API key needed.
6. **Collection tracker.** Import ManaBox/Moxfield CSVs, Scryfall prices, "what can I build from what I own?", "cheapest way to finish this deck".
7. **Claude advisor (OPTIONAL).** Chat panel whose tool calls hit the local database, so every suggestion is a real, legal card. Requires `ANTHROPIC_API_KEY`. Without it the panel reads "not configured" and the rest of the app is unaffected. The key is never written to the repo.

## Tech

TypeScript throughout. React + Vite frontend, small Fastify server, SQLite (`better-sqlite3`), Vitest. Python only for the embedding job. Docker for deployment (later: Proxmox homelab behind `home.dommie.uk`). Rules logic and the simulator get real tests, including checks against hypergeometric probabilities. Playwright end-to-end tests for the UI. npm (not pnpm), Python venv (no uv/pip installed).

## Phases

| Phase | Result |
|---|---|
| 0 | Repo scaffold, Scryfall ingest, search |
| 1 | Deck builder + import/export |
| 2 | Analysis + simulator |
| 3 | Semantic search (GPU) |
| 4 | Collection + prices |
| 5 | Claude advisor, polish, Docker |

Each phase ends with something usable.

## Ground rules

- **Scryfall:** use bulk data rather than hammering the API, send a proper `User-Agent` and `Accept` header, respect rate limits, hotlink card images (never re-host, crop or alter them), attribute Scryfall.
- **Wizards:** non-commercial, per the Fan Content Policy.
- **GitHub:** repo is **private** unless Dommie says otherwise. Never push without being asked.
- **Secrets:** never commit API keys or tokens.
- **Environment:** Node 26, Python 3.14 (venv, no pip/uv), SQLite 3.53, Git, `gh` logged in as `itsdommie`. Docker needs sudo/daemon fixes before Phase 5.

## Status

Plan approved. Commander first, Claude advisor included as optional.

- **Phase 0: done.** npm workspaces (`shared`, `server`, `web`). `npm run ingest` pulls the Scryfall Oracle Cards bulk file (~35k cards, ~7s) into `data/grimoire.db`. Scryfall-style search (colours incl. guilds, `id:`/`commander:`, numeric ops, rarity, formats, keywords, `is:`, `or`/`-`/parentheses, quoted phrases) compiles to parameterised SQL; queries take ~10-20ms. Fastify API (`/api/cards/search`, `/api/cards/by-name/:name`, `/api/health`), React search UI with hotlinked images and Scryfall/Wizards attribution. 21 Vitest tests + 3 Playwright e2e tests (system Chromium).
- **Next:** Phase 1 (deck builder + import/export).
