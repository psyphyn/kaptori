// Download all Open Library covers locally so the demo never depends on the
// network for images. Writes public/covers/{cover_id}-{S|M|L}.jpg
// Safe to re-run; skips files that already exist.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data", "books_enriched.json");
const OUT = path.join(__dirname, "..", "public", "covers");
fs.mkdirSync(OUT, { recursive: true });

const books = JSON.parse(fs.readFileSync(DATA, "utf8"));
const ids = [...new Set(books.filter((b) => b.cover_id).map((b) => b.cover_id))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let done = 0, skipped = 0, failed = 0;
for (const id of ids) {
  for (const size of ["M", "L"]) {
    const file = path.join(OUT, `${id}-${size}.jpg`);
    if (fs.existsSync(file) && fs.statSync(file).size > 500) { skipped++; continue; }
    try {
      const resp = await fetch(`https://covers.openlibrary.org/b/id/${id}-${size}.jpg`, {
        headers: { "User-Agent": "Kaptori-demo/0.1 (cover cache)" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 500) throw new Error("placeholder image");
      fs.writeFileSync(file, buf);
      done++;
      await sleep(350);
    } catch (err) {
      failed++;
      console.error(`  ! cover ${id}-${size}: ${err.message}`);
    }
  }
  process.stdout.write(`\r${done} downloaded, ${skipped} cached, ${failed} failed (${ids.length} books)  `);
}
console.log("\nDone.");
