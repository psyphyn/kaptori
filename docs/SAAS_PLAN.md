# Kaptori SaaS — Architecture & Feature Plan

*From single-user demo to multi-user product. 2026-08-17.*

This plan is grounded in a survey of the nine most relevant repos in `~/Documents/GitHub`. The headline finding: **you and Marc already own working, production-shaped code for almost every hard piece of this product** — the two genuinely greenfield areas are **billing (Stripe)** and the **book catalog service**. Social login exists in one repo (SlopSpotter) and ports cleanly.

---

## 1. Product definition

**Kaptori** — a reading companion that knows your shelves. Each user imports their library, converses with a Socratic companion that treats the library as a map of their intellectual journey, and receives seminal, off-the-bestseller-list recommendations ("the Spengler standard").

### Feature set by tier

| | Free | Reader ($8–12/mo) | Patron ($20–25/mo) |
|---|---|---|---|
| Library size | 100 books | Unlimited | Unlimited |
| Companion messages | 10/day | 200/day | Unlimited* |
| Library import (CSV/xlsx/Goodreads) | ✓ | ✓ | ✓ |
| Catalog enrichment (ISBN, subjects, covers) | ✓ | ✓ | ✓ |
| Recommendations | Basic | Full engine + fringe picks | Full |
| Live web research in chat | — | ✓ | ✓ |
| Reader profile memory | — | ✓ | ✓ |
| Voice conversation | — | — | ✓ |
| Journey map visualization | — | — | ✓ |

*"Unlimited" backed by a fair-use token budget; per-user cost metering (§8) makes this safe to offer.

### Core user journeys
1. **Onboard**: social sign-in → import library (upload xlsx/CSV, paste a Goodreads export, scan ISBNs, or search-and-add) → 3–4 light profile questions ("what are you chasing lately?") → first conversation.
2. **Converse**: the Dennis experience, per-user — Socratic chat grounded in *their* shelves, streaming, with optional web research.
3. **Discover**: recommendation feed + in-chat recommendations, each traceable to books they own ("you've read X and Y; the work underneath both is Z").
4. **Curate**: shelves, reading status, notes; the library stays the living substrate of the product.

---

## 2. Stack decision

**Recommendation: fork the Ocelot skeleton** (`marks_project` / `ocelot_perspective-main`) rather than starting fresh or going all-TypeScript.

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 16 + React 19 + TS, Tailwind v4, shadcn/Radix, TanStack Query, Zustand | Exactly Ocelot's frontend; the team ships this daily |
| API | FastAPI + async SQLAlchemy 2.0 + asyncpg, pydantic v2, structlog | Ocelot's API layer; auth/RBAC/chat models already written |
| Jobs | Celery 5.4 + Redis | Ocelot pattern; enrichment, imports, profile summarization are all background jobs |
| DB | PostgreSQL 16 + **pgvector**, Alembic migrations | Already the Ocelot image (`pgvector/pgvector:pg16`); vectors power recommendations |
| Embeddings | Voyage AI (`voyage-3`, 1024-dim) | Already integrated in Ocelot (`voyage_client.py`) |
| LLM | Claude API (`claude-opus-5` for conversation; `claude-haiku-4-5` for classification jobs), prompt caching, web-search tool | Ocelot's `anthropic_client.py` has the Bedrock fallback, tenacity retry, and **per-run cost metering** we need for billing |
| Deploy | Docker Compose on a VPS, GitHub Actions self-hosted deploy | Matches every repo you operate; SlopSpotter's `deploy.yml` is the template |

**Alternative considered and rejected (for now):** full-TypeScript with Better Auth. Better Auth is the current best-in-class free auth for TS apps (it absorbed Auth.js in late 2025), and Clerk is the fastest managed option (free to 50k MAU). But your entire backend competence and reusable code is FastAPI/Python, and SlopSpotter already contains a proven Python social-auth service. Rewriting the AI layer in TS to use a TS auth library is backwards. Revisit only if the team decides to consolidate on TypeScript.

---

## 3. Auth: multi-user + social login

**Port SlopSpotter's auth service.** It is the strongest implementation in your portfolio and is already FastAPI:

- `POST /auth/{provider}` supporting **Apple, Google, Facebook, LinkedIn** (`slopspotter-api/app/routes/auth.py`, `services/auth_service.py`) — start with **Google + Apple** (Apple is mandatory if an iOS app ever ships alongside social login).
- **Refresh-token families with rotation and theft detection** (`services/refresh_token_store.py`) — meaningfully better than Ocelot's simpler JWT pair.
- Keep Ocelot's email+password (`python-jose` + bcrypt) as the fallback path, and its `require_role` RBAC factory for admin surfaces.
- **Magic-link guest invites** from ODS (`dashboard-api/routers/magic_link.py`: single-use SHA-256 tokens, expiry, redemption rate-limit) — this is how you hand Dennis, or any prospect, a working session without a signup wall. Perfect demo weapon.
- Web session storage: move from Ocelot's `localStorage` tokens to **HttpOnly SameSite cookies** (ODS pattern) for the browser app; keep bearer tokens for a future mobile client.

Tenancy: consumer-first — every row carries `user_id` (the odysseus "owner-scoping discipline"; adopt its rule that *every* repository query takes a request context that cannot be omitted). Keep Ocelot's `Organization` model dormant in the schema for a future book-club/family tier; it costs nothing now.

---

## 4. Book catalog service ("book data, ISBNs, the works")

This is the biggest new build. The demo hits Open Library live per-request; a SaaS needs a **canonical internal catalog** so every user's "Meditations" is the same work, enrichment is done once, and recommendations can traverse a real graph.

### 4.1 Data model

```
works          id, canonical_title, ol_work_id, description, first_publish_year,
               seminality_score, embedding vector(1024)
editions       id, work_id → works, isbn13, isbn10, publisher, pub_year, pages,
               cover_url, format, source (openlibrary|google|isbndb|manual)
authors        id, name, ol_author_id, birth_year, death_year, bio
work_authors   work_id, author_id, role
subjects       id, name, kind (topic|place|person|time)
work_subjects  work_id, subject_id, weight

user_books     id, user_id, work_id, edition_id?, status (owned|read|reading|want),
               acquired_at, source (import|scan|manual|chat), notes, rating
shelves        id, user_id, name;  shelf_books (shelf_id, user_book_id)
```

The `works`/`editions` split matters: users import ISBNs (editions) but recommendations, dedupe, and embeddings operate on works. Open Library's work/edition IDs give the mapping for free.

### 4.2 Enrichment waterfall (Celery jobs, cached forever)

1. **Open Library** — free, unlimited-ish, has the work/edition graph, subjects, covers. Primary source. (Consider its monthly bulk dumps later to pre-seed the catalog and drop runtime dependence.)
2. **Google Books API** — free (default ~1k req/day quota, raisable); best-in-class descriptions, categories, covers. Fills OL's description gaps.
3. **ISBNdb** — paid ($14.99–$299.99/mo tiers; 108M titles, 19 fields). Add when the free pair misses too much of the long tail; Premium tier ($99.99, 3 req/s) is the likely fit at scale.
4. **Hardcover GraphQL API** — free, Goodreads-alternative community data: series, moods, genres, ratings. Good flavor signal for recommendations.

Every lookup writes through to the catalog; a book is enriched once globally, not once per user. Failed matches queue for fuzzy retry (title normalization, author-last-name match — the demo enrichment script's ~75% first-pass hit rate says ~25% need the fallback chain).

### 4.3 Import paths
- **File upload**: xlsx/CSV (the Dennis path — parser already written), Goodreads/StoryGraph export CSVs (documented formats).
- **ISBN scan**: mobile-web barcode scanning (`BarcodeDetector` API / zxing-js fallback) → `editions.isbn13` lookup. Cheap to build, high wow-factor.
- **Search-and-add**: typeahead against the internal catalog, falling through to Open Library search.

Imports run as Celery jobs with progress streamed to the UI (job status endpoint), including a review step for ambiguous matches.

---

## 5. Recommendation engine

Layered, shipping value from day one:

1. **v0 (exists)**: the model reasons over the full library in a cached system prompt. Works surprisingly well; keep as the conversational layer.
2. **v1 — retrieval**: embed every work (title + subjects + description via Voyage) into pgvector. At chat time, retrieve nearest works to the conversation's active themes and inject *candidates* into the prompt instead of asking the model to free-recall. Kills hallucinated titles and enables "books like the three he just mentioned."
3. **v2 — the seminal-works index**: precompute a `seminality_score` per work: age (pre-1980 bonus), edition count and translation count (OL), subject centrality (how many later works in the subject cite/cluster near it), plus a batched LLM classification pass ("is this a foundational primary work, a synthesis, or commentary?") run on Haiku via the Batches API (50% cost). The engine's dial between "seminal core" and "fringe/contrarian" is the transcript's "loose weight."
4. **v3 — the author/subject graph**: similar-author expansion (OL author links + co-subject frequency), rendered as the "journey map" visualization (Ocelot already ships `react-force-graph-3d` — direct reuse).

Guardrails: never recommend an owned work as new (join against `user_books`); every recommendation stores its provenance (candidate source, retrieval scores, prompt) for tuning.

---

## 6. Conversation service

Port the demo's brain into FastAPI, upgrading with patterns from odysseus/ODS:

- **SSE streaming** end-to-end: FastAPI `StreamingResponse` with typed events (`delta`, `status`, `sources`, `recommendation`, `done`) + heartbeat comments — the odysseus `chat_routes.py` contract, which the demo's frontend already speaks.
- **Persistence**: Ocelot's `ChatSession`/`ChatMessage` tables (migration exists) with `user_id` scoping; multiple named conversations per user.
- **Per-user system prompt**: assembled from (a) a compact library digest, (b) retrieved candidate works (v1 engine), (c) the reader profile. Prompt-cache the stable prefix per user; volatile content last.
- **Reader profile engine — the deep-profiling layer.** This is the product's moat: a durable, self-updating model of who each reader is intellectually, so conversations get *more* individually meaningful the longer someone uses the product, and recommendations flow from the person rather than the last message. Architecture:
  - **Typed fact store**: `profile_facts (user_id, kind, fact, confidence, evidence_msg_id, embedding, reinforced_count, last_reinforced_at, created_at)` with kinds: *interest, belief, principle, thread* (open lines of inquiry), *taste* (depth/difficulty/era/form preferences), *context*. The demo already runs a v0 of this loop (extract → merge → re-inject) with a structured-output extraction pass after every exchange.
  - **Reinforcement dynamics** — the "neural net" behavior: each new exchange runs an extraction pass that *strengthens* facts it re-evidences (confidence up, `reinforced_count++`), *revises* facts the reader has moved past, and *decays* stale ones (time-based confidence decay; pruned below threshold). The profile is a living weight structure, not an append-only log.
  - **Embedded and connected**: every fact gets a Voyage embedding in pgvector, so the profile and the book catalog live in the same vector space — "which works sit nearest this reader's active threads" becomes a single similarity query joining `profile_facts` against `works`. Facts also link to the evidence messages and to the works they concern, forming a per-reader graph (reader ↔ threads ↔ works ↔ authors ↔ subjects) that the journey-map visualization renders directly.
  - **Fed back at three points**: (1) injected into every chat's system prompt after the cache breakpoint (stable library prefix stays cached); (2) as the query side of recommendation retrieval; (3) as onboarding priors — the initial profile is seeded from the imported library itself before the first word is exchanged.
  - **Transparent and editable**: a profile UI (in the demo today as the "Reader profile" panel) shows what the system believes, and in the SaaS the reader can correct or delete facts — both a trust feature and a correction signal that feeds the weights. Sensitive columns use the `EncryptedText` pattern from odysseus.
  - Long conversations use compaction; hermes-life-os's compression policy (proactive prune threshold, protect last N turns) is the local template for what survives context trimming.
- **Web research**: keep the server-side `web_search` tool; stream "searching…" status events (already built). YouTube/lecture transcription is a later Celery pipeline, not a chat-time feature.
- **Data-mining pipeline with a skeptic gate.** The research miner (find discussions → transcribe → attribute to a book) and the author-OSINT profiler are Celery jobs, but neither result is trusted until a **skeptic/verifier agent** reviews it: for a mined video, is it *substantively about this book* or a keyword false-match (the "Song Machine casino video" class of error, which the naive keyword search produced at a high rate)? For an author claim — especially politics — is it *supported by the public record* or an inference from vibes? Nothing reaches the companion's context or the reader-facing UI until it passes. This verify-before-trust step is the difference between a demo that sounds smart and a product that isn't confidently wrong; it belongs on every scraped/generated fact, with the verdict stored (`verified: {kind, reason}`) for auditing.
- **Voice (Patron tier)**: start with browser speech-to-text (Web Speech API) + TTS streaming; evaluate a realtime voice API when it matters. SlopSpotter's separate TTS service (Kokoro ONNX) is a self-hosted option.

---

## 7. Billing (greenfield)

Nothing in the portfolio to reuse — build it thin:

- **Stripe Checkout + Customer Portal + webhooks** (no custom card UI). Tables: `customers (user_id, stripe_customer_id)`, `subscriptions (status, plan, period_end)`; webhook consumer updates entitlements.
- **Entitlements**: adopt odysseus's per-user privileges dict shape (`max_messages_per_day`, `allowed_models`, feature flags) as a `plans` table + `user.plan_id`, enforced in the chat helper exactly where odysseus enforces quotas.
- **Metering is the safety net**: Ocelot's `calculate_cost()` writes cost-per-run today; generalize to `usage_events (user_id, kind, input_tokens, output_tokens, cost_usd, at)` — the ODS token-spy schema. Powers fair-use limits, margin dashboards, and future usage-based pricing.

Cost model sanity check: a heavy user at 50 messages/day on claude-opus-5 with a well-cached library prefix runs roughly $3–8/mo in tokens (cache reads at ~0.1×; the library digest is the bulk of input and caches). Free tier at 10 msgs/day is pennies. Margins work at $10–25 price points; web-search calls ($10/1k) are the item to meter closest.

## 8. Rate limiting, security, safety

- **Redis sliding-window middleware** from SlopSpotter (`app/middleware.py`): global + auth + per-endpoint buckets; its trusted-proxy real-IP extraction comes along.
- **Owner-scoping**: odysseus's discipline — every query scoped by user, `area_security` test marker covering auth/owner-scope/XSS; CARDINATOR's rule that request context "cannot be omitted from repository queries" is the design target.
- Secrets in env only; nh3-sanitize any model HTML; encrypt sensitive columns with odysseus's `EncryptedText` TypeDecorator (profile facts qualify).
- Security headers middleware (odysseus), gitleaks/secret-scan CI (ODS/SlopSpotter workflows).

## 9. Deployment & ops

- **Compose stack**: `db (pgvector/pg16)` + `redis` + `api` + `worker` + `beat` + `web` + `caddy/nginx` — Ocelot's compose, plus TLS proxy. One mid-size VPS (Hetzner CPX31-class) carries this to thousands of users; Postgres moves to managed (Neon/RDS) when backups/failover matter.
- **CI/CD**: GitHub Actions — lint/test on PR, build + push images, deploy over SSH (SlopSpotter's `deploy.yml` + `docker-compose.prod.yml` `!override` pattern). Add ODS-style secret scanning.
- **Observability**: structlog (already standard), Sentry, and the usage_events table as the product-metrics spine.

---

## 10. Build phases

**Phase 1 — SaaS skeleton (~2–3 weeks)**
Fork Ocelot's repo layout. Users + Google/Apple login (SlopSpotter port) + cookie sessions. Library import (xlsx/CSV) into `user_books` against a minimal catalog. Port demo chat to FastAPI SSE with per-user prompts and persistence. Deployed behind TLS with CI. *Outcome: Dennis logs in with Google and has his exact demo experience, multi-user.*

**Phase 2 — Catalog + engine (~3 weeks)**
Works/editions/authors/subjects schema; enrichment waterfall (OL → Google Books; evaluate ISBNdb); Goodreads import + ISBN scanning; embeddings + retrieval-grounded recommendations (v1); reader-profile memory; magic-link guest invites.

**Phase 3 — Business layer (~2–3 weeks)**
Stripe subscriptions + entitlements + quotas; usage metering dashboard; rate limiting; onboarding polish; seminal-works index (v2 engine).

**Phase 4 — Differentiators (ongoing)**
Voice conversations; journey-map visualization (force-graph reuse); author-graph expansion (v3); YouTube/lecture research pipeline; purchase auto-sync; book-club/org tier (the dormant Organization model wakes up).

---

## Appendix: what gets lifted from where

| Concern | Source |
|---|---|
| Repo skeleton, chat models, RBAC, Alembic, compose | `marks_project` / `ocelot_perspective-main` |
| Social login (Apple/Google/FB/LinkedIn), refresh rotation + theft detection | `slop_spotter_app/slopspotter-api` |
| Redis rate limiting, real-IP handling, threat model doc | `slop_spotter_app` |
| SSE streaming contract, provider abstraction, per-user entitlements, owner-scoping, EncryptedText | `odysseus` |
| Token/cost metering proxy schema, magic-link invites, SSE frame helpers | `ODS` |
| Anthropic client (retry, Bedrock fallback, cost calc), Voyage embeddings, force-graph UI | Ocelot |
| Long-chat compression policy | `hermes-life-os` |
| Tenancy/identity/AI-governance blueprint prose | `CARDINATOR/docs/wiki` |
| Library extraction + OL enrichment + demo UI/persona | this repo |
