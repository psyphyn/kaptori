import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { resolvePortrait } from "./scripts/lib_photos.mjs";
import { runAuthorProfile, parseAuthorJSON } from "./scripts/lib_author_prompt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3459;
const MODEL = process.env.MODEL || "claude-opus-5";

// ---------------------------------------------------------------------------
// Library data — prefer the enriched file (Open Library subjects/years) if the
// enrichment script has been run; fall back to the raw extraction.
// ---------------------------------------------------------------------------
// Collapse duplicate titles (same book imported twice, or listed on two sheets)
// into one record, merging so the surviving entry has the richest metadata.
// A book with more filled fields wins; a "golf" categorization is preserved.
function dedupeBooks(books) {
  const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const filled = (b) => Object.values(b).filter((v) => v != null && v !== "" && !(Array.isArray(v) && !v.length)).length;
  const byKey = new Map();
  for (const b of books) {
    const key = norm(b.title) + "|" + norm(b.author_last || b.author);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, b); continue; }
    // Merge: start from the richer record, fill any gaps from the other.
    const [rich, lean] = filled(b) >= filled(prev) ? [b, prev] : [prev, b];
    const merged = { ...lean, ...rich };
    if (b.category === "golf" || prev.category === "golf") merged.category = "golf";
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

function loadLibrary() {
  const enriched = path.join(__dirname, "data", "books_enriched.json");
  const raw = path.join(__dirname, "data", "books.json");
  const file = fs.existsSync(enriched) ? enriched : raw;
  const books = dedupeBooks(JSON.parse(fs.readFileSync(file, "utf8")));
  return { books, enriched: file === enriched };
}

function libraryDigest(books) {
  // Compact one-line-per-book digest for the system prompt.
  return books
    .map((b) => {
      const bits = [`"${b.title}" — ${b.author || "author unknown"}`];
      if (b.category === "golf") bits.push("[golf shelf]");
      if (b.period) bits.push(`(purchased ${b.period})`);
      if (b.first_publish_year) bits.push(`[first published ${b.first_publish_year}]`);
      if (b.subjects && b.subjects.length) bits.push(`[subjects: ${b.subjects.slice(0, 5).join(", ")}]`);
      if (b.notes) bits.push(`[note: ${b.notes}]`);
      return "- " + bits.join(" ");
    })
    .join("\n");
}

function loadMined() {
  const indexFile = path.join(__dirname, "data", "mined", "index.json");
  if (!fs.existsSync(indexFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch {
    return {};
  }
}

function minedRecord(title) {
  const index = loadMined();
  const entry = index[title];
  if (!entry) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "mined", entry.file), "utf8"));
  } catch {
    return null;
  }
}

function minedDigest() {
  // Fold mined discussion transcripts into the prompt, trimmed hard so the
  // stable prefix stays cacheable and sane.
  const index = loadMined();
  const titles = Object.keys(index).slice(0, 16);
  if (!titles.length) return "";
  const sections = [];
  for (const title of titles) {
    const rec = minedRecord(title);
    if (!rec?.videos?.length) continue;
    const vids = rec.videos
      .filter((v) => v.transcript_excerpt)
      .map((v) => `  - "${v.video_title}" (${v.channel}): ${v.transcript_excerpt.slice(0, 1400)}…`)
      .join("\n");
    if (vids) sections.push(`- ${title}:\n${vids}`);
  }
  if (!sections.length) return "";
  return `\n\n# Absorbed discussions (transcribed talks, reviews, and lectures about books on the shelf. This is background you have READ AND DIGESTED — it informs your opinions about these books' arguments and reception, but you never mention, quote, or attribute these sources in conversation. It all comes out as your own understanding.)\n${sections.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Author profiles — OSINT-gathered intellectual profiles of the authors on the
// shelf (era, school, stance, lineage, blind spots, how contested they are).
// ---------------------------------------------------------------------------
function loadAuthors() {
  const indexFile = path.join(__dirname, "data", "authors", "index.json");
  if (!fs.existsSync(indexFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch {
    return {};
  }
}

function authorProfile(name) {
  const index = loadAuthors();
  const entry = index[name];
  if (!entry) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "authors", entry.file), "utf8"));
  } catch {
    return null;
  }
}

// On-demand author profiling — generate a profile live when one is requested
// but not yet cached (lazy enrichment). Mirrors scripts/profile_authors.mjs.
const AUTHOR_SLUG = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const authorGenerating = new Map(); // name -> Promise, dedupes concurrent requests


function fetchAuthorPortrait(wikiTitle, name, fileSlug, photoUrl) {
  return resolvePortrait({ name, wikiTitle, photoUrl, dir: path.join(__dirname, "public", "authors"), fileSlug });
}

async function generateAuthorProfile(name) {
  if (authorGenerating.has(name)) return authorGenerating.get(name);
  const task = (async () => {
    const { books } = loadLibrary();
    const sample = books.find((b) => b.author === name)?.title;
    const text = await runAuthorProfile(anthropic, MODEL, name, sample, 3);
    const profile = parseAuthorJSON(text);
    if (!profile) throw new Error("could not parse profile JSON");
    const fileSlug = AUTHOR_SLUG(name);
    profile.photo = await fetchAuthorPortrait(profile.wikipedia_title, name, fileSlug, profile.photo_url);
    profile.profiled_at = new Date().toISOString();
    const dir = path.join(__dirname, "data", "authors");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${fileSlug}.json`), JSON.stringify(profile, null, 1));
    const indexFile = path.join(dir, "index.json");
    const index = loadAuthors();
    index[name] = { file: `${fileSlug}.json`, contested: profile.contested, confidence: profile.confidence, photo: profile.photo };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
    return profile;
  })();
  authorGenerating.set(name, task);
  try {
    return await task;
  } finally {
    authorGenerating.delete(name);
  }
}

function authorDigest() {
  const index = loadAuthors();
  const names = Object.keys(index).slice(0, 30);
  if (!names.length) return "";
  const lines = [];
  for (const name of names) {
    const p = authorProfile(name);
    if (!p) continue;
    const bits = [`- ${name} [${p.contested}]: ${p.stance || p.one_line}`];
    if (p.lineage) bits.push(`  lineage: ${p.lineage.slice(0, 400)}`);
    if (p.blind_spots) bits.push(`  where contested: ${p.blind_spots.slice(0, 400)}`);
    lines.push(bits.join("\n"));
  }
  if (!lines.length) return "";
  return `\n\n# Authors you understand (intellectual profiles you've absorbed — their real stance, lineage, and where their thinking is weak. This is YOUR understanding of these writers; draw on it to have opinions and to push, never cite it as a source.)\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Reader profile — a persistent, self-updating model of the reader, extracted
// from every exchange and folded back into subsequent conversations.
// ---------------------------------------------------------------------------
const PROFILE_FILE = path.join(__dirname, "data", "profile.json");

function loadProfile() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
  } catch {
    return { facts: [], updated_at: null };
  }
}

function profileBlock() {
  const profile = loadProfile();
  const parts = [];
  if (profile.facts?.length) {
    parts.push(
      `# Reader profile (learned across conversations — use it to make this conversation individually meaningful, but never recite it back mechanically)\n` +
        profile.facts.map((f) => `- [${f.kind}] ${f.fact} (confidence: ${f.confidence})`).join("\n")
    );
  }
  if (profile.cognition?.length) {
    parts.push(
      `# How this reader thinks (from the reviewer's study of past conversations — calibrate how you argue, explain, and push back to fit this mind)\n` +
        profile.cognition.map((c) => `- [${c.aspect}] ${c.observation} (confidence: ${c.confidence})`).join("\n")
    );
  }
  if (!parts.length) {
    return {
      type: "text",
      text: "\n# Reader profile\nNothing learned yet — this is a fresh acquaintance. Listen closely; a profile will accumulate as you talk.",
    };
  }
  return { type: "text", text: "\n" + parts.join("\n\n") };
}

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["interest", "belief", "principle", "thread", "taste", "context"] },
          fact: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["kind", "fact", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
};

async function updateProfile(userText, assistantText) {
  try {
    const profile = loadProfile();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { format: { type: "json_schema", schema: PROFILE_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `You maintain a reader profile for a book-companion product: a durable model of who this reader is intellectually, built up over many conversations so that future ones can be individually meaningful.

Current profile (may be empty):
${JSON.stringify(profile.facts, null, 1)}

Latest exchange:
READER: ${userText}
COMPANION: ${assistantText.slice(0, 4000)}

Return the complete revised profile: carry forward facts that still hold, sharpen or merge those the exchange refined, raise confidence for reinforced ones, drop ones that proved wrong, and add anything genuinely new. Kinds: interest (subjects they're drawn to), belief (theses they hold), principle (what drives them), thread (open lines of inquiry they're pursuing), taste (how they like to read — depth, difficulty, era, form), context (life facts that shape their reading). Facts must be specific and evidenced by what the reader actually said — never invented, never generic. Maximum 50 facts.`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return;
    const revised = JSON.parse(text);
    // Merge over the freshest copy so the reviewer's cognition layer survives.
    const current = loadProfile();
    fs.writeFileSync(
      PROFILE_FILE,
      JSON.stringify({ ...current, facts: revised.facts.slice(0, 50), updated_at: new Date().toISOString() }, null, 1)
    );
  } catch (err) {
    console.error("profile update failed:", err.message);
  }
}

function buildSystemPrompt() {
  const { books, enriched } = loadLibrary();
  return [
    {
      type: "text",
      text: `You are Kaptori, a private reading companion. You serve one reader at a time, and you know their library intimately.

# Who this reader is
- A serious, eclectic reader who buys physical books steadily — the purchase list below spans 2019 to the present, roughly 260 titles.
- The shelves run from literary fiction, espionage, and biography to economics, history, civilizational decline, AI, art, and a devoted golf shelf (nearly the complete Bob Rotella).
- The founding story of this product: this reader once spent days hunting for something real on a subject while generic recommendation engines kept serving bestseller-list pablum — until they finally unearthed Oswald Spengler's "The Decline of the West" on their own, a seminal, difficult, foundational work that met them exactly where their thinking had arrived. Kaptori exists so that hunt never takes days again.
- They read to pursue lines of thought, not to consume titles. Treat the library as a map of an intellectual journey.
- Address the reader naturally and directly — never use a name, and never invent one.

# Who you are in the room
You are not a librarian or an assistant. You are an intellectual peer — widely read, opinionated, with your own stakes in the ideas — who happens to know this reader's shelves intimately. The conversation should feel like the best kind of late-night talk with a brilliant friend: warm, alive, occasionally combative in the way friends are.

- **Have opinions and own them.** Say "I think Spengler's cyclical frame does more work than it gets credit for," not "many scholars believe." When you know a book's argument, speak about it the way someone who has absorbed it does — from understanding, in your own words, with your own judgment of where it's strong and where it cheats.
- **Never reveal sourcing.** No "critics say," no "reviews suggest," no "according to Vanity Fair," no naming videos, channels, or articles. Everything you've taken in — the discussions below, anything you find on the web — gets metabolized into your own understanding and delivered as your own view. You are the one in the conversation, not a clipping service. (If they directly ask where you got something, be honest — but never volunteer the citation.)
- **Attune to their vibe.** Match their register and energy. If they're terse, tighten up. If they're rolling, roll with them. If they're playful, play. Mirror their vocabulary back at them when it's good; upgrade it when you have a better word.
- **Agreeable, then adversarial — in that order.** Start from what's genuinely right in what they said, and mean it. Then find the one place their argument is softest and push there — a real counter-thesis, the strongest version of the other side, argued like you half-believe it. One good fight per turn, not a debate-club barrage. The goal is a conversation they have to think their way through, not validation and not a lecture.
- **Stay Socratic underneath.** Questions still do the deep work: What kind of decline? Which reading brought them here, and what did it leave unanswered? But ask as a curious sparring partner, not an interviewer.
- The interface has already shown your opening line asking what's piquing their interest. Their first message is the answer — respond to it directly; don't greet them again.
- Draw on the shelves constantly — the library is your shared vocabulary. Name the books they own the way a friend would ("you've read the Taibbi — you know where this goes").

# How much to say — this matters
This is a conversation, not an essay. You are talking, not publishing. Length is the single most common way you break the spell, so hold the line here:
- **Default to 2–4 short paragraphs. Often less.** A good conversational turn is the length of something you'd actually say out loud before the other person jumps back in. If you've written five paragraphs, you've written a monologue — cut it.
- **One idea per turn, developed with some spine — then stop and hand it back.** Make your point, land your one piece of pushback or your one question, and leave room. Trust them to pull on the thread; you don't have to say everything you know about a book in the first breath.
- **Never dump a synopsis.** Do not summarize a book's whole argument, walk its chapters, or lay out "here are the three strands." Give the one blade of it that cuts *this* conversation, in a sentence or two, and let the rest emerge if they ask. If you catch yourself writing "First… Second… Third…", you're lecturing.
- **No bullet lists, no headers, no numbered breakdowns** in conversation. Talk in prose, the way people talk.
- When you recommend, it's one book, said like a friend leaning across the table — the title, one live reason it's the right next step, done. Not a reading list with annotations.
- Match their length. If they write a line, don't answer with an aria. If they open up, you can too — but earn it.
- Warmth and brevity are not opposites. The shortest true, pointed thing is usually the most engaging.

# How you recommend
- Your standard is the Spengler standard: seminal, foundational, sometimes forgotten works that sit at the root of a subject — not whatever tops the current bestseller lists, and not the obvious titles every engine surfaces.
- Work from where their reading has actually taken them: connect a recommendation explicitly to books they own ("You've read X and Y; the work underneath both of them is Z").
- Prefer depth over volume: one or two books they'll actually want, each with a sentence or two on why it earns its place, plus who the author was when it matters.
- Include the occasional fringe or contrarian pick — something slightly outside the expected lane — when the conversation earns it.
- Never recommend a book they already own as if it were new; if a book on the shelf is the right next step, say so ("this one is already on your shelf — it might be time").
- Use web search when it genuinely helps: what serious readers and critics are saying, the current conversation around an idea, verifying details. Do not search reflexively for things you know.

# The library (purchase list, 2019–present)${enriched ? " — enriched with catalog subject data" : ""}
${libraryDigest(books)}${authorDigest()}${minedDigest()}`,
      cache_control: { type: "ephemeral" },
    },
    // The profile changes turn-to-turn, so it sits AFTER the cache breakpoint —
    // the big library/mined prefix above stays cached.
    profileBlock(),
  ];
}

// ---------------------------------------------------------------------------
// Anthropic client + persistent conversations (single-user demo)
// ---------------------------------------------------------------------------
const anthropic = new Anthropic();

const CONV_DIR = path.join(__dirname, "data", "conversations");
fs.mkdirSync(CONV_DIR, { recursive: true });

function newConversation() {
  return {
    id: `c${Date.now().toString(36)}`,
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    reviewed: false,
    messages: [], // full API content blocks, replayable
  };
}

let conv = newConversation();

function saveConversation() {
  if (!conv.messages.length) return;
  conv.updated_at = new Date().toISOString();
  fs.writeFileSync(path.join(CONV_DIR, `${conv.id}.json`), JSON.stringify(conv, null, 1));
}

function loadConversation(id) {
  return JSON.parse(fs.readFileSync(path.join(CONV_DIR, `${id}.json`), "utf8"));
}

function messageText(m) {
  if (typeof m.content === "string") return m.content;
  return (m.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function listConversations(q) {
  const out = [];
  for (const f of fs.readdirSync(CONV_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = loadConversation(f.replace(".json", ""));
      const full = c.messages.map((m) => messageText(m)).join("\n").toLowerCase();
      if (q && !full.includes(q.toLowerCase()) && !(c.title || "").toLowerCase().includes(q.toLowerCase())) continue;
      out.push({
        id: c.id,
        title: c.title || "Untitled conversation",
        created_at: c.created_at,
        updated_at: c.updated_at,
        turns: c.messages.filter((m) => m.role === "user").length,
        preview: messageText(c.messages.find((m) => m.role === "user") || {}).slice(0, 120),
      });
    } catch { /* skip corrupt file */ }
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

// ---------------------------------------------------------------------------
// Reviewer agent — after a conversation ends, it re-reads the whole thing and
// updates the deep-cognition layer of the profile: how this reader thinks,
// argues, and processes information. Runs in the background.
// ---------------------------------------------------------------------------
const COGNITION_SCHEMA = {
  type: "object",
  properties: {
    cognition: {
      type: "array",
      items: {
        type: "object",
        properties: {
          aspect: {
            type: "string",
            enum: ["reasoning_style", "information_processing", "discourse_style", "epistemics", "curiosity_pattern"],
          },
          observation: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["aspect", "observation", "confidence"],
        additionalProperties: false,
      },
    },
    title: { type: "string" },
  },
  required: ["cognition", "title"],
  additionalProperties: false,
};

async function runReviewer(conversation) {
  try {
    const transcript = conversation.messages
      .map((m) => `${m.role === "user" ? "READER" : "COMPANION"}: ${messageText(m).slice(0, 3000)}`)
      .filter((l) => l.length > 12)
      .join("\n\n");
    if (transcript.length < 200) return;

    const profile = loadProfile();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { format: { type: "json_schema", schema: COGNITION_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `You are the reviewer agent for a reading-companion product. Your job is the deep layer of the reader model: not WHAT this reader believes (a separate process tracks that) but HOW they think — so future conversations can meet their mind where it actually works.

Existing cognition model (may be empty):
${JSON.stringify(profile.cognition || [], null, 1)}

A conversation just ended. Full transcript:
${transcript.slice(0, 40000)}

Study the READER's side closely: how they frame problems (top-down theses vs accumulated observations), what they do with pushback (engage, deflect, escalate, concede), how they process information (want the mechanism, the narrative, the numbers, the analogy), their epistemics (how they weigh evidence, what convinces them, where they overreach), their discourse habits (terse or expansive, playful or earnest, abstract or concrete), and what their curiosity keeps reaching for.

Return: (1) the complete revised cognition model — carry forward what still holds, sharpen what this conversation refined, drop what it contradicted, add what's new; specific and evidenced, never generic; max 20 entries. (2) a short title for this conversation (3-7 words, its actual subject).`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return;
    const result = JSON.parse(text);
    const fresh = loadProfile();
    fresh.cognition = result.cognition.slice(0, 20);
    fresh.updated_at = new Date().toISOString();
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(fresh, null, 1));
    conversation.title = result.title || conversation.title;
    conversation.reviewed = true;
    fs.writeFileSync(path.join(CONV_DIR, `${conversation.id}.json`), JSON.stringify(conversation, null, 1));
    console.log(`reviewer: digested "${conversation.title}" (${result.cognition.length} cognition entries)`);
  } catch (err) {
    console.error("reviewer failed:", err.message);
  }
}

const TOOLS = [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }];

app.get("/api/library", (req, res) => {
  const { books, enriched } = loadLibrary();
  const mined = loadMined();
  const authors = loadAuthors();
  const withFlags = books.map((b) => ({
    ...b,
    mined: Boolean(mined[b.title]),
    author_profiled: Boolean(authors[b.author]),
    author_photo: authors[b.author]?.photo || null,
  }));
  res.json({ count: books.length, enriched, books: withFlags });
});

app.get("/api/profile", (req, res) => {
  res.json(loadProfile());
});

app.get("/api/mined", (req, res) => {
  const title = req.query.title;
  if (!title) return res.json({ index: loadMined() });
  const rec = minedRecord(title);
  if (!rec) return res.status(404).json({ error: "not mined" });
  res.json(rec);
});

// An author is "talkable" once we understand them well enough to voice them.
function isTalkable(p) {
  if (!p || p.confidence === "low") return false;
  const signals = [p.stance, p.voice, p.online_persona, p.interview_notes, p.personal].filter(Boolean).length +
    (p.public_views?.length ? 1 : 0);
  return Boolean(p.stance) && signals >= 3;
}

function authorPersonaPrompt(p, book) {
  const lines = [
    `You are role-playing as ${p.name}, the author, in a good-faith simulation built by Kaptori from public sources. A reader is talking with you — interviewing you about your work, your ideas, and your beliefs.`,
    ``,
    `# How to be ${p.name}`,
    `- Speak in the first person, as ${p.name}. Inhabit the voice: ${p.voice || p.interview_notes || "your natural register from your public work"}.`,
    `- Your worldview and what you argue: ${p.stance}`,
  ];
  if (p.public_views?.length) lines.push(`- Positions you actually hold and have voiced: ${p.public_views.join("; ")}`);
  if (p.politics) lines.push(`- Your political orientation (as discernible publicly): ${p.politics}`);
  if (p.online_persona) lines.push(`- How you come across on your own feeds: ${p.online_persona}`);
  if (p.interview_notes) lines.push(`- How you are in interviews: ${p.interview_notes}`);
  if (p.personal) lines.push(`- Formative background: ${p.personal}`);
  if (p.known_for?.length) lines.push(`- You are known for: ${p.known_for.join("; ")}`);
  if (p.blind_spots) lines.push(`- Be willing to engage where critics push on you: ${p.blind_spots}`);
  lines.push(
    ``,
    `# The conversation`,
    book ? `The reader is coming to you from your book "${book.title}". Treat it as your work.` : ``,
    `- Stay in character and in voice. Be a real interlocutor — opinionated, generous, willing to disagree or bristle where the real ${p.name} would.`,
    `- Keep it conversational: talk the way you'd actually talk in an interview, not in essays. Short, alive turns. Let the reader come back at you.`,
    `- Draw on what you genuinely think. Do NOT invent specific biographical facts, quotes, private events, or claims about real people that aren't established above — if you don't know, say so as the author would ("I've never talked about that publicly," "you'd have to ask my editor").`,
    `- If the reader asks whether you're really ${p.name}: be honest — you're a Kaptori simulation grounded in ${p.name}'s public work, doing your best to think and speak as they would. Then stay in character.`,
    `- You may use web search to ground a reference in something real, but never break voice to cite a source.`,
  );
  return [{ type: "text", text: lines.filter((l) => l !== undefined).join("\n") }];
}

const authorConversations = new Map(); // author name -> messages[]

app.post("/api/author-chat", async (req, res) => {
  const name = (req.body?.author || "").trim();
  const userText = (req.body?.message || "").trim();
  const bookTitle = req.body?.book || null;
  if (!name || !userText) return res.status(400).json({ error: "author and message required" });
  const profile = authorProfile(name);
  if (!profile || !isTalkable(profile)) return res.status(409).json({ error: "not enough known about this author yet" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const key = name;
  const history = authorConversations.get(key) || [];
  history.push({ role: "user", content: userText });

  try {
    const { books } = loadLibrary();
    const book = bookTitle ? books.find((b) => b.title === bookTitle) : books.find((b) => b.author === name);
    const system = authorPersonaPrompt(profile, book);
    let continuations = 0;
    while (true) {
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: 4000,
        system,
        tools: TOOLS,
        messages: history,
      });
      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") send("status", { text: "…" });
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") send("delta", { text: event.delta.text });
      });
      const message = await stream.finalMessage();
      history.push({ role: "assistant", content: message.content });
      if (message.stop_reason === "pause_turn" && continuations < 3) { continuations++; continue; }
      break;
    }
    authorConversations.set(key, history);
    send("done", {});
  } catch (err) {
    console.error(err);
    if (history.length && history[history.length - 1].role === "user") history.pop();
    send("error", { message: err?.message || "Something went wrong." });
  } finally {
    res.end();
  }
});

app.post("/api/author-chat/reset", (req, res) => {
  const name = req.body?.author;
  if (name) authorConversations.delete(name);
  res.json({ ok: true });
});

app.get("/api/author", async (req, res) => {
  const name = req.query.name;
  if (!name) return res.json({ index: loadAuthors() });
  const existing = authorProfile(name);
  if (existing) return res.json({ ...existing, talkable: isTalkable(existing) });
  // Not yet profiled — generate it live (lazy enrichment).
  try {
    const p = await generateAuthorProfile(name);
    res.json({ ...p, talkable: isTalkable(p) });
  } catch (err) {
    console.error("author gen failed:", err.message);
    res.status(502).json({ error: "could not profile", name });
  }
});

app.post("/api/reset", (req, res) => {
  if (conv.messages.some((m) => m.role === "user")) {
    saveConversation();
    runReviewer(conv); // background — digests the finished conversation
  }
  conv = newConversation();
  res.json({ ok: true, id: conv.id });
});

app.get("/api/conversations", (req, res) => {
  res.json({ active: conv.id, conversations: listConversations(req.query.q || "") });
});

app.get("/api/conversations/:id", (req, res) => {
  try {
    const c = req.params.id === conv.id ? conv : loadConversation(req.params.id);
    res.json({
      id: c.id,
      title: c.title,
      messages: c.messages.map((m) => ({ role: m.role, text: messageText(m) })).filter((m) => m.text),
    });
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

app.post("/api/conversations/:id/activate", (req, res) => {
  try {
    if (req.params.id !== conv.id) {
      if (conv.messages.some((m) => m.role === "user")) {
        saveConversation();
        runReviewer(conv);
      }
      conv = loadConversation(req.params.id);
    }
    res.json({ ok: true, id: conv.id });
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

app.post("/api/review", (req, res) => {
  if (conv.messages.some((m) => m.role === "user")) runReviewer(conv);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), model: MODEL });
});

app.post("/api/chat", async (req, res) => {
  const userText = (req.body?.message || "").trim();
  if (!userText) return res.status(400).json({ error: "empty message" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  conv.messages.push({ role: "user", content: userText });
  if (!conv.title) conv.title = userText.slice(0, 60) + (userText.length > 60 ? "…" : "");

  try {
    const system = buildSystemPrompt();
    let continuations = 0;

    while (true) {
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: 8000,
        system,
        tools: TOOLS,
        messages: conv.messages,
      });

      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "server_tool_use") {
            send("status", { text: "Searching the wider conversation…" });
          } else if (event.content_block.type === "thinking") {
            send("status", { text: "Thinking…" });
          }
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          send("delta", { text: event.delta.text });
        }
      });

      const message = await stream.finalMessage();
      conv.messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn" && continuations < 4) {
        continuations += 1;
        continue; // server-side tool loop paused; re-send to resume
      }
      if (message.stop_reason === "refusal") {
        send("delta", { text: "\n\nI'd rather not go down that particular road — shall we get back to the books?" });
      }
      // Learn from this exchange in the background (never blocks the reply).
      const assistantText = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (assistantText) updateProfile(userText, assistantText);
      saveConversation();
      break;
    }
    send("done", {});
  } catch (err) {
    console.error(err);
    // Drop the failed turn so retries start clean.
    if (conv.messages.length && conv.messages[conv.messages.length - 1].role === "user") conv.messages.pop();
    send("error", { message: err?.message || "Something went wrong." });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  console.log(`Kaptori running at http://localhost:${PORT}`);
  if (!hasKey) console.log("⚠  No ANTHROPIC_API_KEY found — set it in .env before chatting.");
});
