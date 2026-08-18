// Metadata backfill — completes missing fields (year, ISBN, pages, subjects,
// publisher, description) for every book, using Google Books then Open Library.
// Idempotent: only fills gaps, never overwrites existing values. Run anytime.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data", "books_enriched.json");
const books = JSON.parse(fs.readFileSync(DATA, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Kaptori-demo/0.1 (metadata)" };

const cleanTitle = (t) => t.replace(/\s*[\(/].*$/, "").replace(/[:—–-].*$/, "").replace(/\s+/g, " ").trim();
const cleanLast = (a) => (a || "").replace(/,.*$/, "").replace(/\b(ph\.?d|jr|sr|iii?|md)\.?\b/gi, "").trim();
const tok = (s) => new Set((s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
function similar(a, b) {
  const ta = tok(a), tb = tok(b);
  if (!ta.size || !tb.size) return 0;
  let h = 0; for (const w of ta) if (tb.has(w)) h++;
  return h / Math.min(ta.size, tb.size);
}
const needs = (b) => !b.first_publish_year || !b.isbn || !b.pages || !b.subjects?.length || !b.publisher || !b.description;

async function googleMeta(b) {
  const queries = [];
  if (b.isbn) queries.push(`isbn:${b.isbn}`);
  queries.push(`intitle:"${cleanTitle(b.title)}"${cleanLast(b.author_last) ? ` inauthor:${cleanLast(b.author_last)}` : ""}`);
  queries.push(`${b.title} ${cleanLast(b.author_last)}`.trim());
  for (const q of queries) {
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books`, { headers: UA });
      if (!r.ok) continue;
      const d = await r.json();
      for (const item of d.items || []) {
        const v = item.volumeInfo || {};
        if (!(q.startsWith("isbn:") || similar(b.title, v.title) >= 0.5)) continue;
        // Search results often omit `description` — fetch the volume detail for it.
        let description = v.description || null;
        if (!description && item.id) {
          try {
            const vr = await fetch(`https://www.googleapis.com/books/v1/volumes/${item.id}`, { headers: UA });
            if (vr.ok) description = (await vr.json())?.volumeInfo?.description || null;
          } catch { /* skip */ }
          await sleep(300);
        }
        return {
          first_publish_year: v.publishedDate ? parseInt(v.publishedDate) || null : null,
          isbn: (v.industryIdentifiers || []).find((x) => x.type === "ISBN_13")?.identifier || (v.industryIdentifiers || []).find((x) => x.type === "ISBN_10")?.identifier || null,
          pages: v.pageCount || null,
          subjects: v.categories || null,
          publisher: v.publisher || null,
          description,
        };
      }
    } catch { /* next */ }
    await sleep(500);
  }
  return null;
}

async function olMeta(b) {
  try {
    const p = new URLSearchParams({ title: cleanTitle(b.title), limit: "3", fields: "title,author_name,first_publish_year,isbn,number_of_pages_median,subject,publisher" });
    if (cleanLast(b.author_last)) p.set("author", cleanLast(b.author_last));
    const r = await fetch(`https://openlibrary.org/search.json?${p}`, { headers: UA });
    if (!r.ok) return null;
    const d = await r.json();
    for (const doc of d.docs || []) {
      if (similar(b.title, doc.title) < 0.5) continue;
      return {
        first_publish_year: doc.first_publish_year || null,
        isbn: doc.isbn?.[0] || null,
        pages: doc.number_of_pages_median || null,
        subjects: doc.subject?.slice(0, 8) || null,
        publisher: doc.publisher?.[0] || null,
      };
    }
  } catch { /* fall through */ }
  return null;
}

let filled = 0, done = 0;
for (const b of books) {
  if (!needs(b)) continue;
  done++;
  const g = (await googleMeta(b)) || {};
  const o = needs({ ...b, ...g }) ? (await olMeta(b)) || {} : {};
  let touched = false;
  for (const key of ["first_publish_year", "isbn", "pages", "publisher", "description"]) {
    const val = g[key] ?? o[key];
    if (!b[key] && val) { b[key] = val; touched = true; }
  }
  if ((!b.subjects || !b.subjects.length)) {
    const subs = g.subjects || o.subjects;
    if (subs?.length) { b.subjects = subs.slice(0, 8); touched = true; }
  }
  if (touched) filled++;
  process.stdout.write(`\r${done} looked up, ${filled} improved  `);
  fs.writeFileSync(DATA, JSON.stringify(books, null, 1));
  await sleep(400);
}
console.log(`\nDone. ${filled} books improved.`);

const miss = (k) => books.filter((b) => !b[k]).length;
console.log(`Remaining gaps — year: ${miss("first_publish_year")}, isbn: ${miss("isbn")}, pages: ${miss("pages")}, subjects: ${books.filter((b) => !b.subjects?.length).length}, publisher: ${miss("publisher")}, description: ${miss("description")}`);
