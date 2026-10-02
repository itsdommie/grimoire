# Grimoire

A local-first MTG deck lab. See [PLAN.md](PLAN.md).

```sh
npm install
npm run ingest      # download Scryfall bulk data into data/grimoire.db
npm run dev:server  # API on :3001
npm run dev:web     # UI on :5173
npm test            # unit tests
npm run e2e         # Playwright (needs ingest first; uses /usr/bin/chromium)
```

Search syntax follows Scryfall: `t:creature c:rg cmc<=3 o:"draw a card"`, `f:commander id<=wubg`, `-c:u`, `(a or b)`.
`c:` means "at least these colours", `id:` means "within this colour identity".

Card data and images are from [Scryfall](https://scryfall.com) (images are hotlinked, never re-hosted). Magic: The Gathering is
© Wizards of the Coast; this is unofficial, non-commercial fan content.
