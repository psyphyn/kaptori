// Author OSINT — builds an intellectual profile of each author from public
// sources, so the companion understands who wrote what it's discussing:
// their era, school of thought, what they actually argue, their intellectual
// lineage, blind spots, and how contested they are.
//
// Uses Claude with the web_search server tool (same mechanism the companion
// uses) to gather and synthesize — search → read → structured profile — the
// PatternForgeDF pattern, trimmed to literary/benign fields.
//
//   node scripts/profile_authors.mjs         # profile authors for enriched non-golf books (default 12)
//   node scripts/profile_authors.mjs 40
//   node scripts/profile_authors.mjs --name "Oswald Spengler"
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { resolvePortrait } from "./lib_photos.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "authors");
fs.mkdirSync(OUT, { recursive: true });

const MODEL = process.env.MODEL || "claude-opus-5";
const anthropic = new Anthropic();
const books = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "books_enriched.json"), "utf8"));
const indexFile = path.join(OUT, "index.json");
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : {};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const PHOTOS = path.join(ROOT, "public", "authors");
fs.mkdirSync(PHOTOS, { recursive: true });

// Portrait via the shared multi-source resolver (Wikipedia → Goodreads → Open Library).
function fetchPortrait(wikiTitle, name, fileSlug, photoUrl) {
  return resolvePortrait({ name, wikiTitle, photoUrl, dir: PHOTOS, fileSlug });
}

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    lived: { type: "string" },
    one_line: { type: "string" },
    bio: { type: "string" },
    known_for: { type: "array", items: { type: "string" } },
    school: { type: "string" },
    lineage: { type: "string" },
    stance: { type: "string" },
    blind_spots: { type: "string" },
    contested: { type: "string", enum: ["canonical", "respected", "divisive", "fringe", "unknown"] },
    politics: { type: "string" },
    public_views: { type: "array", items: { type: "string" } },
    interview_notes: { type: "string" },
    personal: { type: "string" },
    social: { type: "array", items: { type: "string" } },
    voice: { type: "string" },
    wikipedia_title: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["name", "one_line", "bio", "known_for", "stance", "contested", "confidence"],
  additionalProperties: false,
};

import { runAuthorProfile, parseAuthorJSON } from "./lib_author_prompt.mjs";

async function profileAuthor(name, sampleTitle) {
  // Prompt-based JSON with pause_turn-aware web search (no grammar compiler).
  const text = await runAuthorProfile(anthropic, MODEL, name, sampleTitle, 4);
  return parseAuthorJSON(text);
}

// ————— queue —————
const argv = process.argv.slice(2);
let authors;
if (argv[0] === "--name") {
  authors = [{ name: argv[1], sample: null }];
} else {
  const all = argv[0] === "--all";
  const n = all ? Infinity : parseInt(argv[0], 10) || 12;
  // Unique authors, richest shelves first. --all includes golf authors too.
  const byAuthor = new Map();
  for (const b of books) {
    if (!b.author) continue;
    if (!all && b.category === "golf") continue;
    const cur = byAuthor.get(b.author) || { name: b.author, count: 0, sample: b.title };
    cur.count++;
    byAuthor.set(b.author, cur);
  }
  authors = [...byAuthor.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 5;
console.log(`Profiling ${authors.length} author(s) with ${MODEL} + web search, ${CONCURRENCY} at a time.\n`);

// Serialize index.json writes so concurrent workers don't corrupt it.
let writeChain = Promise.resolve();
function persist(name, profile, file) {
  writeChain = writeChain.then(() => {
    index[name] = { file, contested: profile.contested, confidence: profile.confidence, photo: profile.photo };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
  });
  return writeChain;
}

let done = 0;
async function work(a) {
  if (index[a.name]) return;
  try {
    const profile = await profileAuthor(a.name, a.sample);
    if (!profile) { console.log(`no result: ${a.name}`); return; }
    const fileSlug = slug(a.name);
    profile.photo = await fetchPortrait(profile.wikipedia_title, a.name, fileSlug, profile.photo_url);
    profile.profiled_at = new Date().toISOString();
    const file = `${fileSlug}.json`;
    fs.writeFileSync(path.join(OUT, file), JSON.stringify(profile, null, 1));
    await persist(a.name, profile, file);
    console.log(`✓ [${++done}/${authors.length}] ${a.name} — ${profile.contested}, ${profile.confidence}`);
  } catch (err) {
    console.log(`! ${a.name}: ${err.message}`);
  }
}

// Simple concurrency pool over the queue.
const queue = authors.filter((a) => !index[a.name]);
console.log(`${authors.length - queue.length} already done, ${queue.length} to go.\n`);
let cursor = 0;
async function runner() {
  while (cursor < queue.length) {
    const a = queue[cursor++];
    await work(a);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, runner));
console.log("\nDone.");
