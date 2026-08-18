/* Kaptori — demo frontend */
const pages = document.getElementById("pages");
const statusLine = document.getElementById("statusLine");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");

const GREETING =
  "Welcome back. Your library is loaded — every spine on the shelf to my left, plus what I've been reading *about* your books between visits.\n\nSo: what's piquing your interest right now? What are you out to learn, understand, or wrestle with?";

const CREST = '<svg width="20" height="20"><use href="#kappa-crest"/></svg>';

// Local-first cover URLs with a network fallback chain.
// A book's cover reference is either a numeric Open Library cover_id
// (remote fallback possible) or a synthetic cover_key (local only).
function coverRef(b) {
  return b.cover_id || b.cover_key || null;
}
function coverUrl(ref, size) {
  return `/covers/${ref}-${size}.jpg`;
}
function coverFallback(img, ref, size) {
  if (!img.dataset.retried && /^\d+$/.test(String(ref))) {
    img.dataset.retried = "1";
    img.src = `https://covers.openlibrary.org/b/id/${ref}-${size}.jpg`;
  } else {
    const blank = document.createElement("div");
    blank.className = "blank tone0";
    img.replaceWith(blank);
  }
}
window.coverFallback = coverFallback;

// Designed placeholder for books no catalog has a jacket for:
// a typeset mini-cover in one of four muted tones, keyed off the title.
function typesetCover(b) {
  let h = 0;
  for (const ch of b.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<div class="blank tone${h % 4}">
    <span class="bk-t">${escapeHtml(b.title.length > 60 ? b.title.slice(0, 57) + "…" : b.title)}</span>
    <span class="bk-a">${escapeHtml(b.author || "")}</span>
  </div>`;
}

// ————— minimal markdown renderer —————
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderMarkdown(text) {
  let t = escapeHtml(text);
  t = t.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  t = t.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/(^|\n)((?:[-•] .*(?:\n|$))+)/g, (m, pre, block) => {
    const items = block.trim().split(/\n/).map((l) => `<li>${l.replace(/^[-•] /, "")}</li>`).join("");
    return `${pre}<ul>${items}</ul>`;
  });
  t = t.replace(/(^|\n)((?:\d+\. .*(?:\n|$))+)/g, (m, pre, block) => {
    const items = block.trim().split(/\n/).map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
    return `${pre}<ol>${items}</ol>`;
  });
  return t
    .split(/\n{2,}/)
    .map((p) => (p.match(/^<(h3|ul|ol)/) ? p : `<p>${p.replace(/\n/g, "<br/>")}</p>`))
    .join("");
}

function addMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.innerHTML = role === "user" ? "R" : CREST;
  const content = document.createElement("div");
  content.className = "msg-content";
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "You" : "Kaptori";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMarkdown(text);
  content.append(label, body);
  wrap.append(avatar, content);
  pages.appendChild(wrap);
  pages.scrollTop = pages.scrollHeight;
  return body;
}

function setStatus(text) {
  statusLine.textContent = text || "";
  statusLine.classList.toggle("pulsing", Boolean(text));
}

let busy = false;

const THINK_PHRASES = [
  "Thinking…",
  "Reading the spines…",
  "Following the thread…",
  "Weighing the argument…",
  "Turning pages…",
];

function thinkHTML(label) {
  return `<div class="think">
    <div class="ripple"><span></span><span></span><span></span></div>
    <span class="think-label">${escapeHtml(label)}</span>
  </div>`;
}

async function sendMessage(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;
  addMessage("user", text);
  input.value = "";
  input.style.height = "auto";

  const body = addMessage("assistant", "");
  const msgEl = body.closest(".msg");
  msgEl.classList.add("pending");
  body.innerHTML = thinkHTML(THINK_PHRASES[0]);
  let phrase = 0;
  const cycle = setInterval(() => {
    const label = body.querySelector(".think-label");
    const think = body.querySelector(".think");
    if (!label || think?.classList.contains("searching")) return; // hold server-set statuses
    phrase = (phrase + 1) % THINK_PHRASES.length;
    label.textContent = THINK_PHRASES[phrase];
  }, 2600);
  const settle = () => {
    clearInterval(cycle);
    msgEl.classList.remove("pending");
  };
  let acc = "";

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!resp.ok || !resp.body) throw new Error(`Server error (${resp.status})`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const raw of events) {
        const lines = raw.split("\n");
        const evLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (!evLine || !dataLine) continue;
        const ev = evLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));
        if (ev === "delta") {
          settle();
          acc += data.text;
          body.innerHTML = renderMarkdown(acc);
          pages.scrollTop = pages.scrollHeight;
        } else if (ev === "status") {
          const label = body.querySelector(".think-label");
          if (label) {
            label.textContent = data.text;
            body.querySelector(".think")?.classList.toggle("searching", /search/i.test(data.text));
          } else {
            // Mid-reply status (e.g. web search after some text streamed):
            // append a ripple row below the streamed text; the next delta
            // re-render clears it automatically.
            body.innerHTML = renderMarkdown(acc) + thinkHTML(data.text);
            body.querySelector(".think")?.classList.toggle("searching", /search/i.test(data.text));
            pages.scrollTop = pages.scrollHeight;
          }
        } else if (ev === "error") {
          settle();
          acc += (acc ? "\n\n" : "") + `*${data.message}*`;
          body.innerHTML = renderMarkdown(acc);
        }
      }
    }
  } catch (err) {
    settle();
    body.innerHTML = renderMarkdown(`*Connection trouble: ${err.message}. Try again in a moment.*`);
  } finally {
    settle();
    busy = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
});

// ————— reset —————
document.getElementById("resetBtn").addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  pages.querySelectorAll(".msg").forEach((m) => m.remove());
  addMessage("assistant", GREETING);
});

// ————— panels —————
const veil = document.getElementById("veil");
const roadmap = document.getElementById("roadmap");
const bookPanel = document.getElementById("bookPanel");

function closePanels() {
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("open"));
  veil.classList.remove("open");
}
function openPanel(panel) {
  closePanels();
  panel.classList.add("open");
  veil.classList.add("open");
}
const profilePanel = document.getElementById("profilePanel");

veil.addEventListener("click", closePanels);
document.getElementById("roadmapBtn").addEventListener("click", () => openPanel(roadmap));
document.getElementById("roadmapClose").addEventListener("click", closePanels);
document.getElementById("bookClose").addEventListener("click", closePanels);
document.getElementById("profileBtn").addEventListener("click", () => { openPanel(profilePanel); renderProfile(); });
document.getElementById("profileClose").addEventListener("click", closePanels);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanels(); });

// ————— conversation history —————
const historyPanel = document.getElementById("historyPanel");
document.getElementById("historyBtn").addEventListener("click", () => { openPanel(historyPanel); renderHistory(); });
document.getElementById("historyClose").addEventListener("click", closePanels);
document.getElementById("historySearch").addEventListener("input", (e) => renderHistory(e.target.value));

async function renderHistory(q = "") {
  const list = document.getElementById("historyList");
  let data;
  try {
    data = await (await fetch(`/api/conversations?q=${encodeURIComponent(q)}`)).json();
  } catch {
    list.innerHTML = '<p class="pf-empty">History unavailable.</p>';
    return;
  }
  if (!data.conversations.length) {
    list.innerHTML = `<p class="pf-empty">${q ? "Nothing matches that search." : "No past conversations yet — they'll collect here as you talk."}</p>`;
    return;
  }
  list.innerHTML = data.conversations
    .map(
      (c) => `<button class="hist-item${c.id === data.active ? " active" : ""}" data-id="${c.id}">
        <div class="hi-title">${escapeHtml(c.title)}</div>
        <div class="hi-preview">${escapeHtml(c.preview)}</div>
        <div class="hi-sub">${new Date(c.updated_at).toLocaleString()} · ${c.turns} turn${c.turns === 1 ? "" : "s"}${c.id === data.active ? " · current" : ""}</div>
      </button>`
    )
    .join("");
}

document.getElementById("historyList").addEventListener("click", async (e) => {
  const item = e.target.closest(".hist-item");
  if (!item) return;
  const id = item.dataset.id;
  try {
    await fetch(`/api/conversations/${id}/activate`, { method: "POST" });
    const c = await (await fetch(`/api/conversations/${id}`)).json();
    pages.querySelectorAll(".msg").forEach((m) => m.remove());
    addMessage("assistant", GREETING);
    for (const m of c.messages) addMessage(m.role === "user" ? "user" : "assistant", m.text);
    closePanels();
    input.focus();
  } catch { /* leave as is */ }
});

// ————— reader profile —————
const KIND_LABELS = {
  interest: "Interests",
  belief: "Beliefs & theses",
  thread: "Open threads",
  principle: "What drives you",
  taste: "How you read",
  context: "Context",
};

async function renderProfile() {
  const body = document.getElementById("profileBody");
  let profile;
  try {
    profile = await (await fetch("/api/profile")).json();
  } catch {
    body.innerHTML = '<p class="pf-empty">Profile unavailable.</p>';
    return;
  }
  if (!profile.facts?.length) {
    body.innerHTML =
      '<p class="pf-empty">Nothing yet — the profile builds itself as you talk. Say something worth remembering.</p>';
    return;
  }
  const groups = {};
  for (const f of profile.facts) (groups[f.kind] ||= []).push(f);
  const ASPECT_LABELS = {
    reasoning_style: "Reasoning",
    information_processing: "Processing",
    discourse_style: "Discourse",
    epistemics: "Epistemics",
    curiosity_pattern: "Curiosity",
  };
  const cognitionHTML = profile.cognition?.length
    ? `<div class="pf-group pf-cognition"><h3>How you think · reviewer's study</h3>${profile.cognition
        .map(
          (c) => `<div class="pf-fact"><span class="pf-dot ${c.confidence}"></span><span><b>${ASPECT_LABELS[c.aspect] || c.aspect}</b> — ${escapeHtml(c.observation)}</span></div>`
        )
        .join("")}</div>`
    : "";
  body.innerHTML =
    cognitionHTML +
    Object.entries(KIND_LABELS)
      .filter(([kind]) => groups[kind]?.length)
      .map(
        ([kind, label]) => `<div class="pf-group"><h3>${label}</h3>${groups[kind]
          .map((f) => `<div class="pf-fact"><span class="pf-dot ${f.confidence}"></span><span>${escapeHtml(f.fact)}</span></div>`)
          .join("")}</div>`
      )
      .join("") +
    (profile.updated_at ? `<p class="pf-updated">Last updated ${new Date(profile.updated_at).toLocaleString()}</p>` : "");
}

// ————— book detail —————
let currentBook = null;

async function openBook(book) {
  currentBook = book;
  const cover = document.getElementById("bpCover");
  cover.removeAttribute("data-retried");
  delete cover.dataset.retried;
  const ref = coverRef(book);
  if (ref) {
    cover.style.display = "";
    cover.src = coverUrl(ref, "L");
    cover.onerror = () => coverFallback(cover, ref, "L");
  } else {
    cover.style.display = "none";
  }
  document.getElementById("bpTitle").textContent = book.title;
  const authorEl2 = document.getElementById("bpAuthor");
  authorEl2.innerHTML = book.author
    ? `<button class="author-link" data-author="${escapeHtml(book.author)}">${escapeHtml(book.author)} →</button>`
    : "";

  const meta = [];
  if (book.first_publish_year) meta.push(`<div><b>First published</b> ${book.first_publish_year}</div>`);
  if (book.pages) meta.push(`<div><b>Pages</b> ${book.pages}</div>`);
  if (book.isbn) meta.push(`<div><b>ISBN</b> ${book.isbn}</div>`);
  if (book.period) meta.push(`<div><b>Acquired</b> ${escapeHtml(book.period)}</div>`);
  if (book.notes) meta.push(`<div><b>Note</b> ${escapeHtml(book.notes)}</div>`);
  document.getElementById("bpMeta").innerHTML = meta.join("");

  document.getElementById("bpSubjects").innerHTML =
    (book.synopsis ? `<p class="bp-synopsis">${escapeHtml(book.synopsis)}</p>` : "") +
    (book.subjects || [])
      .slice(0, 8)
      .map((s) => `<span class="subject">${escapeHtml(s)}</span>`)
      .join("");

  const authorEl = document.getElementById("bpAuthorProfile");
  authorEl.innerHTML = "";
  const minedEl = document.getElementById("bpMined");
  minedEl.innerHTML = "";
  openPanel(bookPanel);

  if (book.author) {
    const thumb = book.author_photo
      ? `<img class="au-thumb" src="/authors/${book.author_photo}" alt="" onerror="this.outerHTML='<span class=\\'au-thumb au-thumb-ph\\'><svg width=22 height=22><use href=%23kappa-crest/></svg></span>'"/>`
      : `<span class="au-thumb au-thumb-ph"><svg width="22" height="22"><use href="#kappa-crest"/></svg></span>`;
    authorEl.innerHTML = `<button class="au-teaser author-link" data-author="${escapeHtml(book.author)}">
      ${thumb}
      <span class="au-teaser-text">
        <span class="au-teaser-label">About the author</span>
        <span class="au-teaser-name">${escapeHtml(book.author)} →</span>
      </span>
    </button>`;
  }

  if (book.mined) {
    minedEl.innerHTML = `<h3>Found in the wider conversation</h3><p class="hint">Loading…</p>`;
    try {
      const rec = await (await fetch(`/api/mined?title=${encodeURIComponent(book.title)}`)).json();
      minedEl.innerHTML =
        `<h3>Found in the wider conversation</h3>
         <p class="hint">Talks and reviews the research miner discovered and transcribed for this book.</p>` +
        (rec.videos || [])
          .map(
            (v) => `<a class="mined-item" href="${v.url}" target="_blank" rel="noopener">
              <div class="mi-title">${escapeHtml(v.video_title)}</div>
              <div class="mi-sub">${escapeHtml(v.channel || "")}${v.duration_s ? ` · ${Math.round(v.duration_s / 60)} min` : ""}${v.views ? ` · ${Number(v.views).toLocaleString()} views` : ""}</div>
              ${v.transcript_excerpt ? '<span class="mi-tag">transcribed</span>' : ""}
            </a>`
          )
          .join("");
    } catch {
      minedEl.innerHTML = "";
    }
  }
}

// ————— author "About" full view —————
const authorPanel = document.getElementById("authorPanel");
document.getElementById("authorClose").addEventListener("click", closePanels);

const CONTESTED_LABEL = {
  canonical: "Canonical", respected: "Respected", divisive: "Divisive", fringe: "Fringe", unknown: "Little-known",
};

async function openAuthor(name) {
  const body = document.getElementById("authorBody");
  body.innerHTML = `<div class="ap-loading">
    <div class="ripple"><span></span><span></span><span></span></div>
    <p class="ap-loading-name">${escapeHtml(name)}</p>
    <p class="think-label">Reading up on them…</p>
  </div>`;
  openPanel(authorPanel);
  let p;
  try {
    const resp = await fetch(`/api/author?name=${encodeURIComponent(name)}`);
    if (!resp.ok) throw new Error("unavailable");
    p = await resp.json();
  } catch {
    body.innerHTML = `<div class="ap-hero"><span class="ap-photo ap-photo-ph"><svg width="52" height="52"><use href="#kappa-crest"/></svg></span>
      <div class="ap-hero-text"><h2>${escapeHtml(name)}</h2></div></div>
      <p class="pf-empty">We couldn't gather a profile for this author right now. Try again in a moment.</p>`;
    return;
  }
  const section = (label, val) =>
    val ? `<div class="ap-section"><h3>${label}</h3><p>${escapeHtml(val)}</p></div>` : "";
  const listSection = (label, arr) =>
    arr?.length ? `<div class="ap-section"><h3>${label}</h3><ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";

  body.innerHTML = `
    <div class="ap-hero">
      ${p.photo
        ? `<img class="ap-photo" src="/authors/${p.photo}" alt="${escapeHtml(p.name)}" onerror="this.outerHTML='<span class=\\'ap-photo ap-photo-ph\\'><svg width=52 height=52><use href=%23kappa-crest/></svg></span>'"/>`
        : `<span class="ap-photo ap-photo-ph"><svg width="52" height="52"><use href="#kappa-crest"/></svg></span>`}
      <div class="ap-hero-text">
        ${p.contested && p.contested !== "unknown" ? `<span class="au-tag ${p.contested}">${CONTESTED_LABEL[p.contested]}</span>` : ""}
        <h2>${escapeHtml(p.name)}</h2>
        ${p.lived ? `<p class="ap-lived">${escapeHtml(p.lived)}</p>` : ""}
      </div>
    </div>
    <p class="ap-oneline">${escapeHtml(p.one_line)}</p>
    <div class="ap-actions">
      ${p.talkable ? `<button class="btn talk-btn" id="apTalk">🗣  Talk to ${escapeHtml(p.name.split(" ")[0])}</button>` : ""}
      <button class="btn primary" id="apDiscuss" data-author="${escapeHtml(p.name)}">Discuss with Kaptori</button>
    </div>
    ${section("Who they are", p.bio)}
    ${section("What they argue", p.stance)}
    ${listSection("In their own words", p.public_views)}
    ${p.social?.length ? `<div class="ap-section"><h3>Where to find them</h3><div class="ap-social">${p.social.map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.platform)}${s.handle ? ` · ${escapeHtml(s.handle)}` : ""}</a>`).join("")}</div></div>` : ""}
    ${section("On their own feeds", p.online_persona)}
    ${section("Politics", p.politics)}
    ${section("In interviews", p.interview_notes)}
    ${section("Intellectual lineage", p.lineage)}
    ${section("School", p.school)}
    ${listSection("Known for", p.known_for)}
    ${section("Where they're contested", p.blind_spots)}
    ${section("Personal", p.personal)}
    ${p.key_topics?.length ? `<div class="ap-section"><h3>Topics</h3><div class="bp-subjects">${p.key_topics.map((t) => `<span class="subject">${escapeHtml(t)}</span>`).join("")}</div></div>` : ""}
    ${p.confidence === "low" ? '<p class="ap-note">Limited public information — this profile is partial.</p>' : ""}
  `;
  document.getElementById("apDiscuss")?.addEventListener("click", () => {
    closePanels();
    input.value = `Tell me what you actually make of ${p.name}. Where are they right, and where do they overreach?`;
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
  document.getElementById("apTalk")?.addEventListener("click", () => openAuthorChat(p));
}

// ————— Talk to the author (in-character persona chat) —————
const authorChat = document.getElementById("authorChat");
const acPages = document.getElementById("acPages");
const acInput = document.getElementById("acInput");
const acStatus = document.getElementById("acStatus");
const acComposer = document.getElementById("acComposer");
const acSend = document.getElementById("acSend");
let acAuthor = null, acBusy = false;

function acAddMessage(role, text, photo) {
  const wrap = document.createElement("div");
  wrap.className = `ac-msg ${role}`;
  const av = document.createElement("div");
  av.className = "ac-av";
  if (role === "author") {
    av.innerHTML = photo ? `<img src="/authors/${photo}" alt=""/>` : `<svg width="20" height="20"><use href="#kappa-crest"/></svg>`;
  } else {
    av.textContent = "You";
    av.classList.add("ac-av-you");
  }
  const body = document.createElement("div");
  body.className = "ac-body";
  body.innerHTML = renderMarkdown(text);
  wrap.append(av, body);
  acPages.appendChild(wrap);
  acPages.scrollTop = acPages.scrollHeight;
  return body;
}

async function openAuthorChat(p) {
  acAuthor = p;
  closePanels();
  acPages.innerHTML = "";
  document.getElementById("acName").textContent = p.name;
  const acPhoto = document.getElementById("acPhoto");
  if (p.photo) { acPhoto.src = `/authors/${p.photo}`; acPhoto.style.display = ""; acPhoto.onerror = () => { acPhoto.style.display = "none"; }; }
  else acPhoto.style.display = "none";
  await fetch("/api/author-chat/reset", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: p.name }),
  }).catch(() => {});
  const first = p.name.split(" ")[0];
  acAddMessage("author", `I'm ${p.name}${p.one_line ? "" : ""}. Ask me anything — about the book, the ideas, what I actually think. I'll tell you straight.`, p.photo);
  authorChat.classList.add("open");
  acInput.focus();
}

function acClose() { authorChat.classList.remove("open"); }
document.getElementById("acClose").addEventListener("click", acClose);

async function acSendMessage(text) {
  if (acBusy || !text.trim() || !acAuthor) return;
  acBusy = true; acSend.disabled = true;
  acAddMessage("you", text);
  acInput.value = ""; acInput.style.height = "auto";
  const body = acAddMessage("author", "", acAuthor.photo);
  body.innerHTML = `<div class="think"><div class="ripple"><span></span><span></span><span></span></div></div>`;
  let acc = "";
  try {
    const resp = await fetch("/api/author-chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: acAuthor.name, message: text }),
    });
    if (!resp.ok || !resp.body) throw new Error(`Server error (${resp.status})`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const raw of events) {
        const ev = raw.match(/^event: (.+)$/m)?.[1];
        const data = raw.match(/^data: (.+)$/m)?.[1];
        if (!ev || !data) continue;
        const d = JSON.parse(data);
        if (ev === "delta") { acc += d.text; body.innerHTML = renderMarkdown(acc); acPages.scrollTop = acPages.scrollHeight; }
        else if (ev === "error") { acc += (acc ? "\n\n" : "") + `*${d.message}*`; body.innerHTML = renderMarkdown(acc); }
      }
    }
  } catch (err) {
    body.innerHTML = renderMarkdown(`*Lost the thread there — try again.*`);
  } finally {
    acBusy = false; acSend.disabled = false; acInput.focus();
  }
}

acComposer.addEventListener("submit", (e) => { e.preventDefault(); acSendMessage(acInput.value); });
acInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); acComposer.requestSubmit(); } });
acInput.addEventListener("input", () => { acInput.style.height = "auto"; acInput.style.height = Math.min(acInput.scrollHeight, 150) + "px"; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && authorChat.classList.contains("open")) acClose(); });

// Delegate clicks on any author-link (book panel teaser or inline)
document.addEventListener("click", (e) => {
  const link = e.target.closest(".author-link");
  if (link) openAuthor(link.dataset.author);
});

document.getElementById("bpDiscuss").addEventListener("click", () => {
  if (!currentBook) return;
  closePanels();
  input.value = `Let's dig into "${currentBook.title}"${currentBook.author ? ` by ${currentBook.author}` : ""} — what should I be taking from it, and where does it lead next?`;
  input.dispatchEvent(new Event("input"));
  input.focus();
});

// ————— library grid —————
let allBooks = [];
let activeFilter = "all";
let query = "";

function matchesFilter(b) {
  if (activeFilter === "golf") return b.category === "golf";
  if (activeFilter === "general") return b.category !== "golf";
  if (activeFilter === "mined") return b.mined;
  return true;
}

function renderBooks() {
  const grid = document.getElementById("bookGrid");
  const q = query.toLowerCase();
  const rows = allBooks.filter(
    (b) => matchesFilter(b) && (!q || b.title.toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q))
  );
  grid.innerHTML = rows
    .map((b, i) => {
      const idx = allBooks.indexOf(b);
      const ref = coverRef(b);
      const img = ref
        ? `<img loading="lazy" src="${coverUrl(ref, "M")}" alt="" onerror="coverFallback(this, '${ref}', 'M')"/>`
        : typesetCover(b);
      const badge = b.mined
        ? '<span class="badge mined">researched</span>'
        : b.category === "golf"
          ? '<span class="badge golf">golf</span>'
          : "";
      return `<button class="card" data-idx="${idx}">
        <div class="jacket">${img}${badge}</div>
        <div class="c-title">${escapeHtml(b.title)}</div>
        <div class="c-author">${escapeHtml(b.author || "")}</div>
      </button>`;
    })
    .join("");
  document.getElementById("bookCount").textContent = `${rows.length} of ${allBooks.length}`;
}

document.getElementById("bookGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openBook(allBooks[Number(card.dataset.idx)]);
});
document.getElementById("bookSearch").addEventListener("input", (e) => {
  query = e.target.value;
  renderBooks();
});
document.getElementById("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
  activeFilter = chip.dataset.filter;
  renderBooks();
});

// ————— welcome screen —————
function buildMosaic() {
  const mosaic = document.getElementById("mosaic");
  const refs = allBooks.map(coverRef).filter(Boolean);
  const need = Math.ceil((window.innerWidth * window.innerHeight * 1.3) / (100 * 150));
  const wall = [];
  while (wall.length < need && refs.length) wall.push(...refs);
  mosaic.innerHTML = wall
    .slice(0, need)
    .map((ref) => `<img loading="lazy" src="${coverUrl(ref, "M")}" alt="" onerror="coverFallback(this, '${ref}', 'M')"/>`)
    .join("");
}

function dismissWelcome() {
  document.getElementById("welcome").classList.add("gone");
  input.focus();
}

function wireWelcome() {
  document.querySelectorAll(".signin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Signing in…";
      setTimeout(dismissWelcome, 900);
    });
  });
  document.getElementById("enterDemo").addEventListener("click", dismissWelcome);
}

async function init() {
  wireWelcome();
  if (location.hash.startsWith("#study") || location.hash === "#profile" || location.hash === "#think" || location.hash.startsWith("#book=") || location.hash.startsWith("#author=") || location.hash.startsWith("#talk=")) dismissWelcome();
  if (location.hash === "#profile") { openPanel(profilePanel); renderProfile(); }
  if (location.hash === "#think") {
    // visual QA: render the thinking + searching states without an API call
    setTimeout(() => {
      addMessage("user", "I keep seeing decline everywhere — institutions, culture, competence.");
      const b1 = addMessage("assistant", "");
      b1.closest(".msg").classList.add("pending");
      b1.innerHTML = thinkHTML("Reading the spines…");
      const b2 = addMessage("assistant", "");
      b2.closest(".msg").classList.add("pending");
      b2.innerHTML = thinkHTML("Searching the wider conversation…");
      b2.querySelector(".think").classList.add("searching");
    }, 100);
  }
  try {
    const lib = await (await fetch("/api/library")).json();
    allBooks = lib.books;
    const wc = document.getElementById("welcomeCount");
    if (wc) wc.textContent = allBooks.length;
    renderBooks();
    buildMosaic();
    const bookMatch = location.hash.match(/^#book=(\d+)/);
    if (bookMatch && allBooks[+bookMatch[1]]) openBook(allBooks[+bookMatch[1]]);
    const authorMatch = location.hash.match(/^#author=(.+)/);
    if (authorMatch) openAuthor(decodeURIComponent(authorMatch[1]));
    const talkMatch = location.hash.match(/^#talk=(.+)/);
    if (talkMatch) {
      const name = decodeURIComponent(talkMatch[1]);
      const p = await (await fetch(`/api/author?name=${encodeURIComponent(name)}`)).json();
      if (p.talkable) openAuthorChat(p);
    }
  } catch { /* library stays empty */ }

  const health = await (await fetch("/api/health")).json().catch(() => ({}));
  addMessage("assistant", GREETING);
  if (health && health.hasKey === false) {
    addMessage(
      "assistant",
      "*One housekeeping note: no API key is configured yet. Add `ANTHROPIC_API_KEY` to the `.env` file and restart before we talk.*"
    );
  }
}
init();
