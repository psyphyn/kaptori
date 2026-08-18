# Kaptori

*A reading companion that knows your shelves.* Demo build for the Tuesday sitting with Dennis.

It ingests Dennis's book purchase list (2019–present, 259 titles, extracted from the spreadsheet in this folder), holds a Socratic conversation about what he's chasing intellectually, searches the live web for the critical conversation around a book when useful, and steers toward seminal, off-the-bestseller-list recommendations — the Spengler standard.

## Run it

1. Copy `.env.example` to `.env` and paste in an Anthropic API key.
2. Then either:

```bash
# Directly (Node 20+)
npm install
npm start
```

```bash
# Or with Docker
docker compose up --build
```

3. Open **http://localhost:3459**

## What's inside

| Piece | What it does |
|---|---|
| `data/books.json` | Clean extraction of the xlsx purchase list (general + golf shelves, purchase periods, notes) |
| `data/books_enriched.json` | Same list enriched via the Open Library catalog — subjects, first-publication year, ISBN (`npm run enrich`; safe to interrupt and resume) |
| `public/covers/` | All book covers cached locally (`node scripts/cache_covers.mjs`) — the demo never depends on the network for images |
| `data/mined/` | The research miner's output: YouTube reviews/lectures/discussions found per book, with full transcripts (`node scripts/miner.mjs [N]`). Uses YouTube auto-captions by default; add `ELEVENLABS_API_KEY` to `.env` for ElevenLabs Scribe transcription of the audio itself |
| `data/authors/` + `public/authors/` | Author OSINT — deep profiles (photo, era, school, stance, lineage, **politics**, interview-derived views, personal, how contested) gathered via Claude + web search (`node scripts/profile_authors.mjs [N]`). Portraits cached locally. Clicking an author opens a full "About" view; the companion argues *from* these, never citing them |
| `scripts/verify_mined.mjs` | **Skeptic agent** — reviews every mined video and drops keyword false-matches (e.g. a casino video wrongly tagged to *The Song Machine*) before they reach the companion. The miner now runs this check inline too |
| `scripts/synopses.mjs` | Brief 1–2 sentence synopsis for every book, shown in the detail panel |
| `scripts/fill_metadata.mjs` | Backfills missing year / ISBN / pages / subjects / publisher for every book from Google Books + Open Library. Idempotent — re-run anytime |
| `scripts/find_covers.mjs` | Multi-source cover hunter (Google Books → Open Library → Apple Books) — fills cover gaps and caches locally |
| `server.js` | Express server. Streams chat from the Claude API (`claude-opus-5`) with the full library **and mined discussion transcripts** in a cached system prompt, web-search tool enabled, Socratic persona baked in (no reader named) |
| `public/` | The interface: welcome/sign-in over the cover wall, clickable library grid with filters (All / General / Golf / Researched), book detail panel with metadata + mined discussions + "Discuss this book", streaming chat, roadmap panel |

## Demo flow suggestion

1. Point at the shelf: "it's absorbed your whole purchase list."
2. Let Dennis answer the opening question ("what's piquing your interest right now?") — e.g. the decline thread.
3. Watch it probe rather than argue, reference his own books, optionally search the web, and land on a seminal recommendation.
4. Open **"Where this is going"** for the future-builds conversation (voice, the full recommendation engine, live research, durable reader profile, living library, journey map).

## Notes

- Conversation state is held in server memory (single-user demo). "Begin again" resets it.
- The recommendation quality leans on the model plus the enriched catalog data; the full ISBN/Dewey classification + similar-author-graph engine is roadmap item II.
