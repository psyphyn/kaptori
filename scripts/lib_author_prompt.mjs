// Shared author-profile prompt + JSON parser. Prompt-based JSON (not
// structured-output grammar) so there's no schema-complexity or grammar-
// compilation limit — used by both the batch profiler and the server.

export function AUTHOR_PROMPT(name, sampleTitle) {
  return `Build a deep profile of the author "${name}"${sampleTitle ? ` (author of "${sampleTitle}")` : ""} for a serious reading companion — an "about this person" dossier a well-read friend would give you.

Search the web for: who they are and what shaped them; what they actually argue; their intellectual tradition and lineage; how they come across in interviews and what they say for themselves; their OFFICIAL social media (Twitter/X, Bluesky, Substack, personal site) and what their public feeds reveal about their views and psychology; their political orientation IF genuinely discernible from the public record (honest and hedged — if unclear or apolitical, say so, never guess from vibes); how the serious world regards them and where their thinking is contested; their distinctive writing/speaking voice; and their exact Wikipedia article title.

Be honest about blind spots and divisiveness. If obscure or self-published with little serious coverage, say so and set confidence "low" rather than inventing.

Return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
{
  "name": string,
  "lived": string,              // "1880–1936" or "contemporary"; "" if unknown
  "one_line": string,           // who they are in one vivid sentence
  "bio": string,                // 3-4 sentences: background, era, formation, arc
  "known_for": string[],        // the ideas/works they're actually known for
  "school": string,             // intellectual tradition, if any
  "lineage": string,            // who they built on and who built on them
  "stance": string,             // their core argument/worldview, plainly
  "blind_spots": string,        // fair criticisms / where they're contested
  "contested": string,          // one of: canonical | respected | divisive | fringe | unknown
  "politics": string,           // orientation from the public record, hedged; "" or "apolitical/unclear" if so
  "public_views": string[],     // positions they've voiced in interviews/essays/posts
  "interview_notes": string,    // how they present in interviews; recurring themes; temperament
  "personal": string,           // formative background detail
  "social": string[],           // official accounts as "Platform: URL" strings
  "voice": string,              // their writing/speaking voice — enough to imitate it
  "wikipedia_title": string,    // exact Wikipedia article title, "" if none
  "confidence": string          // one of: low | medium | high
}`;
}

// Run the profiling request, resuming through web-search pause_turns, and
// return the final assistant text (all text blocks joined).
export async function runAuthorProfile(anthropic, model, name, sampleTitle, maxUses = 4) {
  const messages = [{ role: "user", content: AUTHOR_PROMPT(name, sampleTitle) }];
  let finalText = "";
  for (let i = 0; i < 6; i++) {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 6000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses }],
      messages,
    });
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) finalText = text;
    if (resp.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: resp.content });
      continue; // resume the server-tool turn
    }
    break;
  }
  return finalText;
}

export function parseAuthorJSON(text) {
  if (!text) return null;
  // Strip code fences and grab the outermost JSON object.
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    // last-ditch: remove trailing commas
    try {
      return JSON.parse(t.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}
