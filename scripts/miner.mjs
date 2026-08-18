// Kaptori data miner — finds YouTube reviews/discussions for books in the
// library, captures transcripts, and stores them for the companion to draw on.
//
//   node scripts/miner.mjs            # mine the default queue (12 books)
//   node scripts/miner.mjs 30         # mine 30 books
//   node scripts/miner.mjs --title "The Decline of the West"
//
// Transcription strategy:
//   1. If ELEVENLABS_API_KEY is set: download audio (yt-dlp) and transcribe
//      with ElevenLabs Scribe (higher quality, speaker labels).
//   2. Otherwise: pull YouTube's own auto-captions via yt-dlp (free, instant).
//
// Output: data/mined/<n>.json per book + data/mined/index.json
import "dotenv/config";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "mined");
fs.mkdirSync(OUT, { recursive: true });

const books = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "books_enriched.json"), "utf8"));
const indexFile = path.join(OUT, "index.json");
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : {};

import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic();
const MODEL = process.env.MODEL || "claude-opus-5";

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const MAX_VIDEOS_PER_BOOK = 2;
const EXCERPT_CHARS = 9000;

// Skeptic check: is this video genuinely about the book, or a keyword false match?
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    reason: { type: "string" },
    kind: { type: "string", enum: ["author_talk", "review", "discussion", "summary", "tangential", "wrong_subject", "unclear"] },
  },
  required: ["relevant", "reason", "kind"],
  additionalProperties: false,
};

async function verifyRelevance(book, videoTitle, channel, transcript) {
  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      messages: [{
        role: "user",
        content: `Be skeptical: keyword search produces false matches (a "The Song Machine" casino video is NOT the book "The Song Machine" about pop music).

BOOK: "${book.title}" by ${book.author || "unknown"}${book.subjects?.length ? `\nAbout: ${book.subjects.slice(0, 6).join(", ")}` : ""}
VIDEO: ${videoTitle} (${channel || "?"})
TRANSCRIPT: ${(transcript || "").slice(0, 3000) || "(none)"}

Is this genuinely and substantively about THIS book? Judge from transcript content, not title.`,
      }],
    });
    const t = r.content.find((b) => b.type === "text")?.text;
    return t ? JSON.parse(t) : null;
  } catch {
    return null; // on error, don't block (keep)
  }
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function ytdlp(args) {
  return execFileSync("yt-dlp", ["--no-warnings", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
}

function searchVideos(book) {
  const q = `${book.title} ${book.author_last || ""} book review discussion`.trim();
  const raw = ytdlp([`ytsearch5:${q}`, "--dump-json", "--flat-playlist", "--skip-download"]);
  const results = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return results
    .filter((v) => v.duration && v.duration > 240 && v.duration < 7200) // 4min–2h
    .filter((v) => !/audiobook|full book|asmr/i.test(v.title || ""))
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
    .slice(0, MAX_VIDEOS_PER_BOOK);
}

function vttToText(vtt) {
  const seen = new Set();
  const lines = [];
  for (let line of vtt.split("\n")) {
    line = line.replace(/<[^>]+>/g, "").trim();
    if (!line || line === "WEBVTT" || /^\d+$/.test(line)) continue;
    if (/-->|^Kind:|^Language:|^NOTE/.test(line)) continue;
    if (seen.has(line)) continue; // auto-captions repeat rolling lines
    seen.add(line);
    lines.push(line);
  }
  return lines.join(" ");
}

function transcriptViaCaptions(videoId, tmp) {
  ytdlp([
    `https://www.youtube.com/watch?v=${videoId}`,
    "--skip-download", "--write-auto-subs", "--write-subs",
    "--sub-langs", "en.*", "--sub-format", "vtt",
    "-o", path.join(tmp, "cap"),
  ]);
  const vtt = fs.readdirSync(tmp).find((f) => f.endsWith(".vtt"));
  if (!vtt) return null;
  const text = vttToText(fs.readFileSync(path.join(tmp, vtt), "utf8"));
  fs.rmSync(path.join(tmp, vtt));
  return text || null;
}

async function transcriptViaElevenLabs(videoId, tmp) {
  const audio = path.join(tmp, `${videoId}.mp3`);
  ytdlp([`https://www.youtube.com/watch?v=${videoId}`, "-x", "--audio-format", "mp3", "--audio-quality", "9", "-o", audio]);
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(audio)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model_id", "scribe_v1");
  const resp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY },
    body: form,
  });
  fs.rmSync(audio, { force: true });
  if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return data.text || null;
}

async function mineBook(book) {
  const slug = slugify(book.title);
  if (index[book.title]?.videos?.length) {
    console.log(`= ${book.title} (already mined)`);
    return;
  }
  console.log(`⛏  ${book.title} — ${book.author}`);
  let videos;
  try {
    videos = searchVideos(book);
  } catch (err) {
    console.error(`  search failed: ${err.message}`);
    return;
  }
  const mined = [];
  for (const v of videos) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaptori-mine-"));
    let transcript = null, method = "none";
    try {
      if (ELEVEN_KEY) {
        transcript = await transcriptViaElevenLabs(v.id, tmp);
        method = "elevenlabs_scribe";
      }
    } catch (err) {
      console.error(`  elevenlabs failed (${err.message}); falling back to captions`);
    }
    if (!transcript) {
      try {
        transcript = transcriptViaCaptions(v.id, tmp);
        method = transcript ? "youtube_captions" : "none";
      } catch (err) {
        console.error(`  captions failed: ${err.message}`);
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    // Skeptic pass: reject false keyword matches before storing.
    const verdict = await verifyRelevance(book, v.title, v.channel || v.uploader, transcript);
    if (verdict && !verdict.relevant) {
      console.log(`  ✗ SKIP ${v.title} (${verdict.kind}: ${verdict.reason})`);
      continue;
    }
    mined.push({
      video_id: v.id,
      video_title: v.title,
      channel: v.channel || v.uploader,
      duration_s: v.duration,
      views: v.view_count || null,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      transcription: method,
      transcript_excerpt: transcript ? transcript.slice(0, EXCERPT_CHARS) : null,
      verified: verdict ? { kind: verdict.kind, reason: verdict.reason } : null,
    });
    console.log(`  ▸ ${v.title} [${method}${transcript ? `, ${transcript.length} chars` : ""}${verdict ? `, ${verdict.kind}` : ""}]`);
  }
  const record = { title: book.title, author: book.author, mined_at: new Date().toISOString(), videos: mined };
  fs.writeFileSync(path.join(OUT, `${slug}.json`), JSON.stringify(record, null, 1));
  index[book.title] = { file: `${slug}.json`, videos: mined.map((m) => ({ video_title: m.video_title, channel: m.channel, transcription: m.transcription })) };
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
}

// ————— queue selection —————
const argv = process.argv.slice(2);
let queue;
if (argv[0] === "--title") {
  const t = argv[1]?.toLowerCase();
  queue = books.filter((b) => b.title.toLowerCase().includes(t));
} else {
  const n = parseInt(argv[0], 10) || 12;
  // Prioritize serious nonfiction with enriched data — the discussion-worthy shelf.
  queue = books
    .filter((b) => b._enriched && b.category !== "golf")
    .sort((a, b) => (b.subjects?.length || 0) - (a.subjects?.length || 0))
    .slice(0, n);
}

console.log(`Mining ${queue.length} book(s). Transcription: ${ELEVEN_KEY ? "ElevenLabs Scribe" : "YouTube captions (set ELEVENLABS_API_KEY for Scribe)"}\n`);
for (const book of queue) await mineBook(book);
console.log("\nMining complete.");
