// Cover hunter — fills cover gaps using a source waterfall:
//   1. Google Books by ISBN (when we have one)
//   2. Google Books fuzzy text search (survives spreadsheet typos)
//   3. Open Library retry with a cleaned title
//   4. Apple Books (iTunes) search
// Downloads M and L sizes into public/covers/ and records the cover reference
// (numeric Open Library cover_id, or a synthetic cover_key) in
// data/books_enriched.json. Safe to re-run; only touches books without a
// usable local cover.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data", "books_enriched.json");
const COVERS = path.join(ROOT, "public", "covers");
fs.mkdirSync(COVERS, { recursive: true });

const books = JSON.parse(fs.readFileSync(DATA, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Kaptori-demo/0.1 (cover hunt)" };

const cleanTitle = (t) => t.replace(/\s*[\(/].*$/, "").replace(/[:—–-].*$/, "").replace(/\s+/g, " ").trim();
// "Rotalla, Ph.D." → "Rotalla"; also tolerate common OCR'd misspellings by
// matching on the first 4 letters of the surname.
const cleanLast = (a) => (a || "").replace(/,.*$/, "").replace(/\b(ph\.?d|jr|sr|iii?|md)\.?\b/gi, "").trim();
const lastMatches = (last, candidate) => {
  const l = cleanLast(last).toLowerCase();
  if (!l) return true;
  const c = (candidate || "").toLowerCase();
  return c.includes(l) || (l.length >= 4 && c.includes(l.slice(0, 4)));
};
const tokens = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));

function similar(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

function hasLocal(ref) {
  if (!ref) return false;
  const f = path.join(COVERS, `${ref}-M.jpg`);
  return fs.existsSync(f) && fs.statSync(f).size > 1000;
}

async function fetchImage(url) {
  const resp = await fetch(url, { headers: UA });
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.length > 1500 ? buf : null; // reject placeholders
}

async function saveCover(ref, urlM, urlL) {
  const m = await fetchImage(urlM);
  if (!m) return false;
  fs.writeFileSync(path.join(COVERS, `${ref}-M.jpg`), m);
  const l = urlL && urlL !== urlM ? await fetchImage(urlL) : null;
  fs.writeFileSync(path.join(COVERS, `${ref}-L.jpg`), l || m);
  return true;
}

// ————— sources —————
async function googleBooks(book) {
  const tryQueries = [];
  if (book.isbn) tryQueries.push(`isbn:${book.isbn}`);
  tryQueries.push(`intitle:"${cleanTitle(book.title)}"${cleanLast(book.author_last) ? ` inauthor:${cleanLast(book.author_last)}` : ""}`);
  tryQueries.push(`intitle:"${cleanTitle(book.title)}"`); // title-only, for polluted author fields
  tryQueries.push(`${book.title} ${cleanLast(book.author_last)}`.trim()); // full fuzzy — survives typos
  for (const q of tryQueries) {
    try {
      const resp = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books`, { headers: UA });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const item of data.items || []) {
        const info = item.volumeInfo || {};
        const thumb = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail;
        if (!thumb) continue;
        const sim = similar(book.title, info.title || "");
        const authorOk = (info.authors || []).some((a) => lastMatches(book.author_last, a));
        if (!(q.startsWith("isbn:") || (authorOk && sim >= 0.45) || sim >= 0.85)) continue;
        const base = thumb.replace(/^http:/, "https:").replace(/&edge=curl/, "");
        return {
          source: "google",
          urlM: base.replace(/zoom=\d/, "zoom=1"),
          urlL: base.replace(/zoom=\d/, "zoom=2"),
          matched_title: info.title,
          isbn: (info.industryIdentifiers || []).find((x) => x.type === "ISBN_13")?.identifier || null,
          year: info.publishedDate ? parseInt(info.publishedDate) || null : null,
          subjects: info.categories || null,
        };
      }
    } catch { /* next query */ }
    await sleep(600);
  }
  return null;
}

async function openLibraryRetry(book) {
  try {
    const params = new URLSearchParams({ title: cleanTitle(book.title), limit: "3", fields: "title,author_name,cover_i,isbn,first_publish_year,subject" });
    const resp = await fetch(`https://openlibrary.org/search.json?${params}`, { headers: UA });
    if (!resp.ok) return null;
    const data = await resp.json();
    for (const doc of data.docs || []) {
      if (!doc.cover_i) continue;
      const sim = similar(book.title, doc.title || "");
      const authorOk = (doc.author_name || []).some((a) => lastMatches(book.author_last, a));
      if (!((authorOk && sim >= 0.45) || sim >= 0.85)) continue;
      return {
        source: "openlibrary", cover_id: doc.cover_i,
        urlM: `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`,
        urlL: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
        matched_title: doc.title,
        isbn: doc.isbn?.[0] || null,
        year: doc.first_publish_year || null,
        subjects: doc.subject?.slice(0, 8) || null,
      };
    }
  } catch { /* fall through */ }
  return null;
}

async function appleBooks(book) {
  try {
    const term = `${cleanTitle(book.title)} ${cleanLast(book.author_last)}`.trim();
    const resp = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=ebook&limit=5`, { headers: UA });
    if (!resp.ok) return null;
    const data = await resp.json();
    for (const item of data.results || []) {
      const sim = similar(book.title, item.trackName || "");
      const authorOk = lastMatches(book.author_last, item.artistName);
      if (!((authorOk && sim >= 0.45) || sim >= 0.85)) continue;
      const art = item.artworkUrl100;
      if (!art) continue;
      return {
        source: "apple",
        urlM: art.replace("100x100bb", "300x300bb"),
        urlL: art.replace("100x100bb", "600x600bb"),
        matched_title: item.trackName,
      };
    }
  } catch { /* fall through */ }
  return null;
}

// ————— hunt —————
let found = 0, already = 0, failed = 0, synth = 0;
for (let i = 0; i < books.length; i++) {
  const book = books[i];
  const ref = book.cover_id || book.cover_key;
  if (hasLocal(ref)) { already++; continue; }

  // Existing OL cover_id but file missing → direct fetch.
  if (book.cover_id && await saveCover(book.cover_id, `https://covers.openlibrary.org/b/id/${book.cover_id}-M.jpg`, `https://covers.openlibrary.org/b/id/${book.cover_id}-L.jpg`)) {
    found++; console.log(`✓ (ol-direct) ${book.title}`);
    continue;
  }

  const hit = (await googleBooks(book)) || (await openLibraryRetry(book)) || (await appleBooks(book));
  if (!hit) {
    failed++; console.log(`✗ ${book.title}`);
    await sleep(400);
    continue;
  }

  const key = hit.cover_id || `x${i}`;
  if (await saveCover(key, hit.urlM, hit.urlL)) {
    if (hit.cover_id) book.cover_id = hit.cover_id;
    else { book.cover_key = key; synth++; }
    if (!book.isbn && hit.isbn) book.isbn = hit.isbn;
    if (!book.first_publish_year && hit.year) book.first_publish_year = hit.year;
    if ((!book.subjects || !book.subjects.length) && hit.subjects) book.subjects = hit.subjects;
    found++;
    console.log(`✓ (${hit.source}) ${book.title}  →  ${hit.matched_title}`);
  } else {
    failed++; console.log(`✗ (download failed) ${book.title}`);
  }
  fs.writeFileSync(DATA, JSON.stringify(books, null, 1));
  await sleep(500);
}

fs.writeFileSync(DATA, JSON.stringify(books, null, 1));
console.log(`\nDone: ${found} new covers (${synth} non-OL), ${already} already local, ${failed} still missing.`);
