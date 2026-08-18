// Shared author-portrait resolver — multi-source waterfall used by both the
// profiler and the standalone backfill. Returns a saved filename or null.
//   Wikipedia page image → Open Library author photo → Goodreads author photo
import fs from "fs";
import path from "path";

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" };

async function grab(url, referer) {
  const r = await fetch(url, { headers: referer ? { ...UA, Referer: referer } : UA });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length > 1500 ? buf : null; // reject 1x1 placeholders
}

async function fromWikipedia(name, wikiTitle) {
  for (const t of [wikiTitle, name].filter(Boolean)) {
    try {
      const u = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(t)}&prop=pageimages&piprop=thumbnail&pithumbsize=500&format=json&redirects=1`;
      const r = await fetch(u, { headers: UA });
      if (!r.ok) continue;
      const d = await r.json();
      const thumb = Object.values(d?.query?.pages || {}).find((p) => p.thumbnail)?.thumbnail?.source;
      if (thumb) { const b = await grab(thumb); if (b) return b; }
    } catch { /* next */ }
  }
  return null;
}

async function fromOpenLibrary(name) {
  try {
    const r = await fetch(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}`, { headers: UA });
    if (!r.ok) return null;
    const d = await r.json();
    const key = d.docs?.[0]?.key;
    if (!key) return null;
    return await grab(`https://covers.openlibrary.org/a/olid/${key}-M.jpg`);
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fromGoodreads(name) {
  try {
    let s, html = "";
    // Goodreads soft-blocks bursts with 202/empty; back off and retry a couple times.
    for (let attempt = 0; attempt < 3; attempt++) {
      s = await fetch(`https://www.goodreads.com/search?q=${encodeURIComponent(name)}`, { headers: UA });
      html = s.ok ? await s.text() : "";
      if (html.length > 500) break;
      await sleep(1500 * (attempt + 1));
    }
    if (html.length < 500) return null;
    const m = html.match(/\/author\/show\/(\d+\.[A-Za-z0-9_.]+)/);
    if (!m) return null;
    const authorUrl = `https://www.goodreads.com/author/show/${m[1]}`;
    let page = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const ap = await fetch(authorUrl, { headers: UA });
      page = ap.ok ? await ap.text() : "";
      if (page.length > 500) break;
      await sleep(1500 * (attempt + 1));
    }
    if (page.length < 500) return null;
    // author portrait lives at images.gr-assets.com/authors/{id}.jpg (skip nophoto)
    const photo = page.match(/https:\/\/images[^"'\s]*\/authors\/[^"'\s]+\.(?:jpg|png|jpeg)/i);
    if (!photo || /nophoto/i.test(photo[0])) return null;
    return await grab(photo[0], authorUrl);
  } catch { return null; }
}

// Resolve and save a portrait. `dir` is the public/authors directory.
export async function resolvePortrait({ name, wikiTitle, photoUrl, dir, fileSlug }) {
  fs.mkdirSync(dir, { recursive: true });
  const sources = [
    () => (photoUrl ? grab(photoUrl) : null), // model-provided direct URL, tried first if given
    () => fromWikipedia(name, wikiTitle),
    () => fromGoodreads(name),
    () => fromOpenLibrary(name),
  ];
  for (const src of sources) {
    try {
      const buf = await src();
      if (buf) {
        fs.writeFileSync(path.join(dir, `${fileSlug}.jpg`), buf);
        return `${fileSlug}.jpg`;
      }
    } catch { /* next source */ }
  }
  return null;
}
