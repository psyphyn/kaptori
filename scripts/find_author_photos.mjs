// Backfill portraits for already-profiled authors that lack one, using the
// multi-source waterfall. Safe to re-run; only touches authors with no photo.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolvePortrait } from "./lib_photos.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const AUTHORS = path.join(ROOT, "data", "authors");
const PHOTOS = path.join(ROOT, "public", "authors");
const indexFile = path.join(AUTHORS, "index.json");
const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let found = 0, already = 0, missed = 0;
for (const [name, entry] of Object.entries(index)) {
  const file = path.join(AUTHORS, entry.file);
  if (!fs.existsSync(file)) continue;
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  const slug = entry.file.replace(/\.json$/, "");
  if (profile.photo && fs.existsSync(path.join(PHOTOS, profile.photo))) { already++; continue; }

  const photo = await resolvePortrait({
    name,
    wikiTitle: profile.wikipedia_title,
    photoUrl: profile.photo_url,
    dir: PHOTOS,
    fileSlug: slug,
  });
  if (photo) {
    profile.photo = photo;
    index[name].photo = photo;
    fs.writeFileSync(file, JSON.stringify(profile, null, 1));
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
    found++;
    console.log(`✓ ${name}`);
  } else {
    missed++;
    console.log(`· ${name} (no portrait found — placeholder stays)`);
  }
  await sleep(600);
}
console.log(`\nDone: ${found} new photos, ${already} already had one, ${missed} still without.`);
