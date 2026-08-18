// Enrich the extracted book list via the Open Library search API.
// This is the "classic library strategy": title/author -> catalog record ->
// subjects, first publication year, ISBN, cover. Run with: npm run enrich
// Progress is saved incrementally, so it's safe to interrupt and re-run.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(__dirname, "..", "data", "books.json");
const OUT = path.join(__dirname, "..", "data", "books_enriched.json");

const books = JSON.parse(fs.readFileSync(RAW, "utf8"));
const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
const doneByTitle = new Map(existing.filter((b) => b._enriched !== undefined).map((b) => [b.title, b]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookup(book) {
  const params = new URLSearchParams({
    title: book.title.replace(/[:—-].*$/, "").trim() || book.title,
    limit: "1",
    fields: "key,title,author_name,first_publish_year,subject,isbn,cover_i,number_of_pages_median",
  });
  if (book.author_last) params.set("author", book.author_last);
  const url = `https://openlibrary.org/search.json?${params}`;
  const resp = await fetch(url, { headers: { "User-Agent": "Marginalia-demo/0.1 (book enrichment)" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.docs?.[0] || null;
}

const out = [];
let hits = 0;
for (let i = 0; i < books.length; i++) {
  const book = { ...books[i] };
  const cached = doneByTitle.get(book.title);
  if (cached) {
    out.push(cached);
    if (cached._enriched) hits++;
    continue;
  }
  try {
    const doc = await lookup(book);
    if (doc) {
      book.first_publish_year = doc.first_publish_year || null;
      book.subjects = (doc.subject || []).slice(0, 8);
      book.isbn = doc.isbn?.[0] || null;
      book.cover_id = doc.cover_i || null;
      book.pages = doc.number_of_pages_median || null;
      book._enriched = true;
      hits++;
    } else {
      book._enriched = false;
    }
  } catch (err) {
    console.error(`  ! ${book.title}: ${err.message}`);
    book._enriched = false;
  }
  out.push(book);
  process.stdout.write(`\r[${i + 1}/${books.length}] enriched ${hits}  `);
  // Save progress every 10 books
  if (i % 10 === 0) fs.writeFileSync(OUT, JSON.stringify([...out, ...books.slice(i + 1)], null, 1));
  await sleep(1100); // be polite to Open Library
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nDone: ${hits}/${books.length} matched. Wrote ${OUT}`);
