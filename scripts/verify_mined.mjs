// Skeptic agent — reviews every mined video and decides whether it is
// genuinely about the book it was attributed to. Keyword search produces false
// matches ("The Song Machine" the pop-music book vs. a casino slot-machine
// video); this pass catches and drops them before they poison the companion's
// understanding.
//
//   node scripts/verify_mined.mjs         # re-verify everything, drop bad matches
//   node scripts/verify_mined.mjs --dry   # report only, change nothing
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MINED = path.join(ROOT, "data", "mined");
const indexFile = path.join(MINED, "index.json");
const MODEL = process.env.MODEL || "claude-opus-5";
const DRY = process.argv.includes("--dry");
const anthropic = new Anthropic();

const books = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "books_enriched.json"), "utf8"));
const bookByTitle = new Map(books.map((b) => [b.title, b]));
const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean", description: "true only if this video is genuinely, substantively about THIS book (or its author discussing this book/its ideas)" },
    reason: { type: "string", description: "one sentence: why it is or isn't about the book" },
    kind: { type: "string", enum: ["author_talk", "review", "discussion", "summary", "tangential", "wrong_subject", "unclear"] },
  },
  required: ["relevant", "reason", "kind"],
  additionalProperties: false,
};

async function verify(book, video) {
  const excerpt = (video.transcript_excerpt || "").slice(0, 3500);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `A research miner attributed this YouTube video to a book by keyword search. Be skeptical: keyword overlap produces false matches (a video titled "The Song Machine" about a casino slot machine is NOT about the book "The Song Machine" about the pop-music industry).

BOOK: "${book.title}" by ${book.author || "unknown"}
${book.subjects?.length ? `Book is about: ${book.subjects.slice(0, 6).join(", ")}` : ""}

VIDEO TITLE: ${video.video_title}
CHANNEL: ${video.channel || "unknown"}
TRANSCRIPT EXCERPT:
${excerpt || "(no transcript captured)"}

Is this video genuinely and substantively about THIS book — a talk by its author, a review, or a real discussion of its actual arguments? Or is it a false match (different subject that shares words with the title, an unrelated topic, or too tangential to be useful)? Judge from the transcript content, not the title alone.`,
      },
    ],
  });
  const text = response.content.find((b) => b.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

let checked = 0, dropped = 0, kept = 0;
for (const [title, entry] of Object.entries(index)) {
  const book = bookByTitle.get(title);
  const file = path.join(MINED, entry.file);
  if (!book || !fs.existsSync(file)) continue;
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const keep = [];
  for (const v of rec.videos || []) {
    checked++;
    let verdict;
    try {
      verdict = await verify(book, v);
    } catch (err) {
      console.error(`  ! ${title} / ${v.video_title}: ${err.message}`);
      keep.push(v); // on error, keep rather than lose data
      continue;
    }
    if (verdict?.relevant) {
      v.verified = { kind: verdict.kind, reason: verdict.reason };
      keep.push(v);
      kept++;
    } else {
      dropped++;
      console.log(`✗ DROP "${title}" ← "${v.video_title}" (${verdict?.kind}: ${verdict?.reason})`);
    }
  }
  rec.videos = keep;
  rec.verified_at = new Date().toISOString();
  if (!DRY) {
    if (keep.length) {
      fs.writeFileSync(file, JSON.stringify(rec, null, 1));
      index[title].videos = keep.map((m) => ({ video_title: m.video_title, channel: m.channel, transcription: m.transcription }));
    } else {
      // no relevant videos left — remove the book from the mined set entirely
      fs.rmSync(file, { force: true });
      delete index[title];
      console.log(`  (removed "${title}" — no relevant videos survived)`);
    }
  }
}
if (!DRY) fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
console.log(`\n${DRY ? "[dry run] " : ""}Checked ${checked} videos: kept ${kept}, dropped ${dropped}.`);
