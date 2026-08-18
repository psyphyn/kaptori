// Brief synopsis for every book — one or two crisp sentences on what the book
// actually is and argues, written for a reader deciding whether to pull it off
// the shelf. Uses whatever metadata we have (subjects, publisher description if
// present) plus the model's own knowledge. Batched, idempotent.
//
//   node scripts/synopses.mjs        # fill any book missing a synopsis
//   node scripts/synopses.mjs --all  # regenerate all
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data", "books_enriched.json");
const MODEL = process.env.MODEL || "claude-opus-5";
const ALL = process.argv.includes("--all");
const anthropic = new Anthropic();
const books = JSON.parse(fs.readFileSync(DATA, "utf8"));

const SCHEMA = {
  type: "object",
  properties: {
    synopsis: { type: "string", description: "1-2 sentences: what the book is and argues/does. Concrete and specific, not blurb-speak. Empty string if genuinely unknown." },
    known: { type: "boolean", description: "true if you actually know this book; false if guessing" },
  },
  required: ["synopsis", "known"],
  additionalProperties: false,
};

// Batch to keep it fast and cheap: one call per ~8 books.
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const targets = books.filter((b) => ALL || !b.synopsis);
if (!targets.length) { console.log("All books already have a synopsis."); process.exit(0); }

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          synopsis: { type: "string" },
          known: { type: "boolean" },
        },
        required: ["i", "synopsis", "known"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

let filled = 0;
const batches = chunk(targets, 10);
for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi];
  const list = batch
    .map((b, i) => `${i}. "${b.title}" by ${b.author || "unknown"}${b.first_publish_year ? ` (${b.first_publish_year})` : ""}${b.subjects?.length ? ` — subjects: ${b.subjects.slice(0, 4).join(", ")}` : ""}`)
    .join("\n");
  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 3000,
      output_config: { format: { type: "json_schema", schema: BATCH_SCHEMA } },
      messages: [{
        role: "user",
        content: `Write a brief synopsis for each book below — one or two crisp, specific sentences on what the book actually is and argues or does, for a reader deciding whether to read it. No blurb-speak, no "a must-read," no hype. If you don't actually know a book (obscure/self-published), set known=false and give the best one-line guess from title and subjects, or an empty synopsis.

Return results keyed by the index number i.

${list}`,
      }],
    });
    const text = r.content.find((b) => b.type === "text")?.text;
    if (!text) continue;
    const { results } = JSON.parse(text);
    for (const res of results) {
      const b = batch[res.i];
      if (b && res.synopsis) { b.synopsis = res.synopsis; b.synopsis_known = res.known; filled++; }
    }
    fs.writeFileSync(DATA, JSON.stringify(books, null, 1));
    process.stdout.write(`\rbatch ${bi + 1}/${batches.length}, ${filled} synopses  `);
  } catch (err) {
    console.error(`\nbatch ${bi + 1} failed: ${err.message}`);
  }
}
console.log(`\nDone. ${filled} synopses written.`);
