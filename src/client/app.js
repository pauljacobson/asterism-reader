import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import DOMPurify from "dompurify";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const url = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
};
// Never trust HTML, display names, IDs, or URLs returned by the federation backend.
function content(html) {
  return DOMPurify.sanitize(String(html || ""), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "a",
      "span",
      "strong",
      "em",
      "b",
      "i",
      "blockquote",
      "ul",
      "ol",
      "li",
      "pre",
      "code",
      "h2",
      "h3",
      "h4",
    ],
    ALLOWED_ATTR: ["href", "rel"],
    ALLOW_DATA_ATTR: false,
  });
}
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const safe = url(node.getAttribute("href"));
    if (safe) node.setAttribute("href", safe);
    else node.removeAttribute("href");
    node.setAttribute("rel", "noopener noreferrer");
    node.setAttribute("target", "_blank");
  }
});
const text = (html) => {
  const el = document.createElement("div");
  el.innerHTML = content(html);
  return el.textContent || "";
};
const shapes = {
  home: '<path d="m3 10 9-7 9 7v10H3z"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  people:
    '<circle cx="9" cy="8" r="4"/><path d="M1 21v-2a8 8 0 0 1 16 0v2M17 5a4 4 0 0 1 0 8"/>',
  heart: '<path d="M12 21 3 12C-3 4 7 0 12 7c5-7 15-3 9 5z"/>',
  save: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  reply: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5z"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
};
const ico = (k) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">${shapes[k] || shapes.grid}</svg>`;
const button = (label, action, extra = "", kind = "") =>
  `<button class="button ${kind}" data-do="${action}" ${extra}>${label}</button>`;
let session,
  page = "feed",
  statuses = [],
  following = [],
  cursor = null,
  peopleCursor = null,
  view = "All",
  query = "",
  searchType = "Posts",
  lastFocus = null,
  codes = [],
  searchResults = null,
  loadSeq = 0;
let invite = new URLSearchParams(location.hash.slice(1)).get("setup") || "";
const connectionNotice = new URLSearchParams(location.search).get("connection");
if (location.hash || location.search)
  history.replaceState(null, "", location.pathname);
const drafts = new Map(),
  known = new Map();
let prefs = { theme: "system", font: "sans", size: 18 };
const media = matchMedia("(prefers-color-scheme: dark)");
function theme() {
  document.body.dataset.theme =
    prefs.theme === "system" ? (media.matches ? "dark" : "light") : prefs.theme;
  document.body.style.setProperty(
    "--reading",
    prefs.font === "serif"
      ? 'Georgia,"Times New Roman",serif'
      : "ui-sans-serif,system-ui,sans-serif",
  );
  document.body.style.setProperty("--size", prefs.size + "px");
}
media.addEventListener("change", theme);
theme();
function notify(message) {
  $(".toast").textContent = message;
  $(".toast").hidden = false;
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => ($(".toast").hidden = true), 5000);
}
function error(message) {
  $("#status-message").innerHTML =
    `<div class="error-banner"><button data-do="dismiss" aria-label="Dismiss message">×</button>${esc(message)}</div>`;
}
async function api(path, body, method) {
  const response = await fetch("/api" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: body
      ? {
          "content-type": "application/json",
          "x-csrf-token": session?.csrf || "",
        }
      : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server is unavailable. Try again.");
  }
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}
async function refreshSession() {
  session = await api("/session");
  if (session.preferences) {
    prefs = session.preferences;
    theme();
  }
  return session;
}
function heading(k, t, s, action = "") {
  return `<div class="page-heading"><div><div class="kicker">${esc(k)}</div><h1>${esc(t)}</h1><p class="subtitle">${esc(s)}</p></div>${action}</div>`;
}
function navigation() {
  const full = session.phase === "full";
  $(".top-tools").hidden = !full;
  $(".mobile-nav").hidden = !full;
  const items = [
    ["feed", "home", "Feed"],
    ["search", "search", "Search"],
    ["people", "people", "People"],
  ];
  $(".top nav").innerHTML = full
    ? items
        .map(
          ([id, icon, label]) =>
            `<button class="nav-button" data-page="${id}" ${page === id ? 'aria-current="page"' : ""}>${ico(icon)}${label}</button>`,
        )
        .join("")
    : "";
  $(".mobile-nav").innerHTML = full
    ? [
        ...items,
        ["account", "grid", "Account"],
        ["preferences", "grid", "Preferences"],
      ]
        .map(
          ([id, icon, label]) =>
            `<button data-page="${id}" ${page === id ? 'aria-current="page"' : ""}>${ico(icon)}${label}</button>`,
        )
        .join("")
    : "";
}
function login() {
  return `<section class="login panel"><span class="mark">⁂</span><div class="kicker">Your personal corner of the web</div><h1>A little space for you.</h1><p>Sign in securely to read and connect through your WordPress site.</p>${invite && !session.hasAccount ? button("Create your passkey", "enroll", "", "primary") : button("Sign in with a passkey", "login", "", "primary")}${!session.hasAccount && !invite ? "<p>An owner setup invitation is required to create this account.</p>" : ""}${session.hasAccount ? button("Use a backup code", "recovery") : ""}<p class="muted">Your passkey stays with your device or password manager.</p></section>`;
}
function setupView() {
  return `<section class="login panel"><div class="kicker">${session.phase === "recovery" ? "Account recovery" : "Account setup"}</div><h1>${session.phase === "recovery" && !session.recoveryKey ? "Create a new passkey." : "Save a way back in."}</h1><p>${session.phase === "recovery" ? "Finish recovery to regain access. Your previous sessions have been signed out." : "Save your backup codes and confirm that you have kept them somewhere safe before continuing."}</p>${button(session.phase === "recovery" && !session.recoveryKey ? "Create replacement passkey" : "Generate backup codes", session.phase === "recovery" && !session.recoveryKey ? "replacement-key" : "codes", "", "primary")}${button("Sign out", "logout")}</section>`;
}
function author(a, date) {
  const name = a?.display_name || a?.username || "Unknown account",
    initials = name.slice(0, 2).toUpperCase();
  return `<div class="author"><span class="avatar">${esc(initials)}</span><div class="author-info"><strong>${esc(name)}</strong><span class="handle">${esc(a?.acct)}</span></div>${date ? `<time>${esc(new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</time>` : ""}</div>`;
}
function actions(p) {
  return `<div class="actions"><button data-do="like" data-id="${esc(p.id)}" aria-label="${p.favourited ? "Unlike" : "Like"} post" aria-pressed="${!!p.favourited}">${ico("heart")} ${Number(p.favourites_count) || 0}</button><button data-do="read" data-id="${esc(p.id)}" aria-label="Read conversation and reply">${ico("reply")} ${Number(p.replies_count) || 0}</button><button data-do="save" data-id="${esc(p.id)}" aria-label="${p.bookmarked ? "Unsave" : "Save"} post" aria-pressed="${!!p.bookmarked}">${ico("save")}</button></div>`;
}
function body(p, full = false) {
  const attachments = (p.media_attachments || [])
    .map((m) => {
      const source = url(m.url),
        preview = url(m.preview_url);
      if (!source) return "";
      if (m.type === "image")
        return `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer"><img class="post-media" src="${esc(preview || source)}" alt="${esc(m.description || "Post image")}" loading="lazy" referrerpolicy="no-referrer"></a>`;
      if (["video", "gifv"].includes(m.type))
        return `<video class="post-media" controls preload="none" ${preview ? `poster="${esc(preview)}"` : ""} src="${esc(source)}" aria-label="${esc(m.description || "Post video")}"></video>`;
      if (m.type === "audio")
        return `<audio class="post-media" controls preload="none" src="${esc(source)}"></audio>`;
      return "";
    })
    .join("");
  let html = `<div class="post-copy">${content(p.content)}</div>${attachments}`;
  if (p.spoiler_text || p.sensitive)
    html = `<details><summary>${esc(p.spoiler_text || "Sensitive content")}</summary>${html}</details>`;
  return (
    html +
    `<div class="tags">${(p.tags || []).map((t) => `<button class="tag" data-tag="${esc(t.name)}">#${esc(t.name)}</button>`).join("")}</div>`
  );
}
function remember(items) {
  for (const item of items) {
    known.set(String(item.id), item);
    if (item.reblog) known.set(String(item.reblog.id), item.reblog);
  }
}
function card(item) {
  const p = item.reblog || item;
  return `<article class="post" data-id="${esc(p.id)}">${item.reblog ? `<p class="activity-notice">Boosted by ${esc(item.account?.display_name || item.account?.acct)}</p>` : ""}${author(p.account, p.created_at)}${body(p)}<button class="text-button read-button" data-do="read" data-id="${esc(p.id)}">Read & converse →</button>${actions(p)}</article>`;
}
function emptyConnection() {
  return `<div class="note"><h2>Bring your people here.</h2><p>Connect wordpress.example.com to load your feed, follows, and conversations.</p>${button("Open Account", "account", "", "primary")}</div>`;
}
function feed() {
  const list = statuses.filter(
    (item) =>
      view !== "Photos" ||
      (item.reblog || item).media_attachments?.some((m) => m.type === "image"),
  );
  return (
    heading(
      "Your daily constellation",
      "Follow your curiosity.",
      "The latest from your corner of the Fediverse.",
      button(`${ico("people")} Follow someone`, "follow"),
    ) +
    `<div class="tool-row"><div class="chips">${["All", "Photos", "Saved"].map((x) => `<button class="chip" data-view="${x}" aria-pressed="${view === x}">${x}</button>`).join("")}</div>${button("Refresh", "refresh")}</div>${!session.connection ? emptyConnection() : list.length ? `<div class="board">${list.map(card).join("")}</div>` : '<div class="empty">No posts loaded here. Refresh your feed or try another view.</div>'}${cursor ? `<div class="load-more">${button("Load older posts", "more-feed")}</div>` : ""}`
  );
}
function peopleView() {
  return (
    heading(
      "Your orbit",
      "People you follow.",
      "Follows managed by your WordPress site.",
      button("Follow someone", "follow"),
    ) +
    (!session.connection
      ? emptyConnection()
      : `<div class="panel">${following.length ? following.map((a) => `<div class="person-row">${author(a)}<span class="badge">Following</span></div>`).join("") : "<p>No followed accounts loaded yet.</p>"}</div>${peopleCursor ? button("Load more people", "more-people") : ""}`)
  );
}
function searchView() {
  return (
    heading(
      "Find your way back",
      "Search your world.",
      "Search the content available through your WordPress site.",
    ) +
    `<form id="search-form"><label class="search-field">${ico("search")}<input id="search-input" type="search" aria-label="Search" value="${esc(query)}" placeholder="Words, a followed person, or #hashtag" required maxlength="200"><button class="button" type="submit">Search</button></label></form><div class="chips">${["Posts", "People", "Hashtags"].map((t) => `<button class="chip" data-search-type="${t}" aria-pressed="${searchType === t}">${t}</button>`).join("")}</div><p class="muted spacer">Post and hashtag results depend on your site's stored history. People searches loaded follows; load more in People for wider coverage.</p><div id="search-results" class="result-list">${searchResults || '<div class="note"><h2>What stayed with you?</h2><p>Search for a phrase, a familiar name, or a hashtag.</p></div>'}</div>`
  );
}
function preferences() {
  return (
    heading(
      "Make yourself comfortable",
      "Preferences.",
      "Your reading choices are saved to your account.",
    ) +
    `<div class="settings-layout"><div><section class="panel"><h2>Appearance</h2><div class="control-label">Theme</div><div class="theme-choice">${["light", "dark", "system"].map((t) => `<button data-theme-choice="${t}" aria-pressed="${prefs.theme === t}"><span class="theme-swatch ${t}"></span>${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div></section><section class="panel"><h2>Reading</h2><label class="control-label" for="font-choice">Font family</label><select id="font-choice"><option value="sans" ${prefs.font === "sans" ? "selected" : ""}>Sans serif</option><option value="serif" ${prefs.font === "serif" ? "selected" : ""}>Serif</option></select><label class="control-label" for="text-size">Text size <span id="size-value">${prefs.size} px</span></label><input id="text-size" type="range" min="16" max="26" value="${prefs.size}"></section></div><section class="panel"><div class="kicker">A live reading sample</div><div class="sample-reading"><h3>A little space for wonder.</h3><p>Stories, small discoveries, and thoughtful conversations. At your own pace.</p></div></section></div>`
  );
}
function account() {
  return (
    heading(
      "Your place in the constellation",
      "Account.",
      "Manage how you sign in and connect to your site.",
    ) +
    `<div class="settings-layout"><div><section class="panel"><h2>Passkeys</h2>${session.passkeys.map((p) => `<div class="setting-row"><div><h3>${esc(p.name)}</h3><p>Added ${esc(new Date(p.created).toLocaleDateString())}</p></div>${button("Remove", "remove-key", `data-id="${esc(p.id)}" ${session.passkeys.length < 2 ? "disabled" : ""}`)}</div>`).join("")}${button("Add a passkey", "add-key")}</section><section class="panel"><h2>Backup codes</h2><p>${session.backupRemaining} unused codes. Save them separately from this app.</p>${button("Replace backup codes", "replace-codes")}</section><section class="panel"><h2>Sessions</h2>${session.sessions.map((s) => `<div class="setting-row"><div><h3>${s.current ? "This browser" : "Another session"}</h3><p>Last active ${esc(new Date(s.touched).toLocaleString())}</p></div>${s.current ? '<span class="badge">Current</span>' : button("Sign out", "revoke-session", `data-id="${esc(s.id)}"`)}</div>`).join("")}${button("Sign out of this browser", "logout")}</section></div><div><section class="panel"><h2>WordPress connection</h2><p>wordpress.example.com</p><p class="account-name">${session.connection ? `Connected as ${esc(session.connection.display_name || session.connection.acct)}` : "Not connected"}</p><p>Authorize Asterism to read your feeds, follow people, reply, and react as your site account.</p>${button(session.connection ? "Disconnect WordPress" : "Connect WordPress", session.connection ? "disconnect" : "connect", "", "primary")}<p>Connection checks require PKCE protection on the WordPress side.</p></section><section class="panel"><h2>Lists</h2><p>List management and Mastodon list import are planned for a later release.</p></section></div></div>`
  );
}
function render() {
  navigation();
  $("#main").innerHTML =
    session.phase === "anonymous"
      ? login()
      : session.phase !== "full"
        ? setupView()
        : (
            {
              feed,
              people: peopleView,
              search: searchView,
              preferences,
              account,
            }[page] || feed
          )();
}
async function go(p) {
  page = p;
  render();
  $("#main").focus();
  window.scrollTo(0, 0);
  if (!session.connection) return;
  if (page === "feed" && !statuses.length) await loadFeed();
  if (page === "people" && !following.length) await loadPeople();
}
async function loadFeed(more = false) {
  const seq = ++loadSeq;
  const result = await api(
    "/wordpress/feed?" +
      new URLSearchParams({
        saved: String(view === "Saved"),
        ...(more && cursor ? { cursor } : {}),
      }),
  );
  if (seq !== loadSeq) return;
  statuses = more
    ? [
        ...statuses,
        ...result.posts.filter((p) => !statuses.some((x) => x.id === p.id)),
      ]
    : result.posts;
  remember(statuses);
  cursor = result.next;
  if (page === "feed") render();
}
async function loadPeople(more = false) {
  const result = await api(
    "/wordpress/following" +
      (more && peopleCursor
        ? "?cursor=" + encodeURIComponent(peopleCursor)
        : ""),
  );
  following = more
    ? [
        ...following,
        ...result.accounts.filter((a) => !following.some((x) => x.id === a.id)),
      ]
    : result.accounts;
  peopleCursor = result.next;
  if (page === "people") render();
}
function modal(title, html) {
  if (!$("#modal").open) {
    lastFocus = document.activeElement;
    $("#modal").showModal();
    document.body.style.overflow = "hidden";
  }
  $("#modal-title").textContent = title;
  $(".dialog-body").innerHTML = html;
  $(".dialog-close").focus();
}
function close() {
  if ($("#reply-text"))
    drafts.set($("#reply-text").dataset.id, $("#reply-text").value);
  $("#modal").close();
  $(".dialog-body").replaceChildren();
  codes = [];
  document.body.style.overflow = "";
  if (lastFocus?.isConnected) lastFocus.focus();
}
$(".dialog-close").onclick = close;
$("#modal").addEventListener("cancel", (e) => {
  e.preventDefault();
  close();
});
async function authenticate(reauth = false) {
  const data = await api("/auth/login/options", { reauth });
  const response = await startAuthentication({ optionsJSON: data.options });
  await api("/auth/login/verify", { id: data.id, response });
  await refreshSession();
  if (!reauth) {
    render();
    if (session.phase === "full" && session.connection) await loadFeed();
  }
}
async function register() {
  const data = await api("/auth/register/options", invite ? { invite } : {});
  const response = await startRegistration({ optionsJSON: data.options });
  await api("/auth/register/verify", {
    id: data.id,
    response,
    name: "Passkey " + new Date().toLocaleDateString(),
  });
  invite = "";
  await refreshSession();
  render();
}
async function showCodes() {
  codes = (await api("/auth/backup/generate", {})).codes;
  modal(
    "Save your backup codes",
    `<p>Each code can recover your account once. Keep them somewhere safe, such as your password manager.</p><p class="notice">These are real recovery codes. Anyone with one can recover your account. This set is activated only after you confirm saving it.</p><div class="codes code-output">${codes.map((c) => `<span>${esc(c)}</span>`).join("")}</div><div class="flex-wrap">${button("Copy codes", "copy-codes")}${button("Download codes", "download-codes")}</div><label class="check-label"><input id="codes-saved" type="checkbox"><span>I have saved my backup codes somewhere safe.</span></label>${button("Confirm saved", "confirm-codes", "disabled", "primary")}<p class="muted">Closing this screen discards the displayed codes. You can generate a new set.</p>`,
  );
}
async function openPost(id) {
  const p = await api("/wordpress/post/" + encodeURIComponent(id));
  known.set(String(p.id), p);
  modal(
    "A conversation",
    `${author(p.account, p.created_at)}${body(p, true)}${actions(p)}<div id="conversation"><p class="muted">Loading conversation…</p></div><form id="reply-form" data-id="${esc(p.id)}"><label class="control-label" for="reply-text">Reply as ${esc(session.connection?.acct)}</label><textarea id="reply-text" data-id="${esc(p.id)}" required maxlength="5000">${esc(drafts.get(String(p.id)) || "")}</textarea><p class="muted">Visibility follows the original post: ${esc(p.visibility || "private")}.</p><div class="dialog-footer"><button class="button primary" type="submit">Send reply</button></div></form>`,
  );
  try {
    const context = await api(
      "/wordpress/post/" + encodeURIComponent(id) + "/context",
    );
    if ($("#reply-text")?.dataset.id !== String(id)) return;
    const replies = [
      ...(context.ancestors || []),
      ...(context.descendants || []),
    ];
    remember(replies);
    $("#conversation").innerHTML = replies.length
      ? `<h3 class="spacer">Conversation</h3>${replies.map((x) => `<div class="result">${author(x.account, x.created_at)}${body(x, true)}</div>`).join("")}`
      : '<p class="muted spacer">No other replies returned by your site.</p>';
  } catch {
    if ($("#conversation"))
      $("#conversation").innerHTML =
        '<p class="muted">The conversation could not be loaded. The post is still available.</p>';
  }
}
function followDialog() {
  modal(
    "Follow someone",
    `<p>Enter a handle or profile URL. Your WordPress identity will send the follow.</p><form id="follow-form"><label class="control-label" for="follow-query">Handle or profile URL</label><input id="follow-query" type="text" required maxlength="200" placeholder="@person@server.social"><button class="button primary" type="submit">Find person</button></form><div id="follow-results"></div>`,
  );
}
let preferenceQueue = Promise.resolve();
function savePrefs() {
  const snapshot = { ...prefs };
  preferenceQueue = preferenceQueue
    .then(() => api("/preferences", snapshot, "PUT"))
    .catch((e) => error("Preferences were not saved: " + e.message));
  return preferenceQueue;
}
async function search() {
  if (!query.trim()) return;
  if (searchType === "People") {
    if (!following.length) await loadPeople();
    const q = query.toLowerCase();
    searchResults = following
      .filter((a) => `${a.display_name} ${a.acct}`.toLowerCase().includes(q))
      .map((a) => `<div class="result">${author(a)}</div>`)
      .join("");
  } else if (query.startsWith("#")) {
    const result = await api(
      "/wordpress/tag/" + encodeURIComponent(query.slice(1)),
    );
    remember(result.posts);
    searchResults = result.posts.map(card).join("");
  } else {
    const result = await api(
      "/wordpress/search?" +
        new URLSearchParams({
          q: query,
          type: searchType === "Hashtags" ? "hashtags" : "statuses",
        }),
    );
    remember(result.statuses || []);
    searchResults =
      searchType === "Posts"
        ? (result.statuses || []).map(card).join("")
        : (result.hashtags || [])
            .map(
              (t) =>
                `<div class="result"><button class="tag" data-tag="${esc(t.name)}">#${esc(t.name)}</button></div>`,
            )
            .join("");
  }
  if (!searchResults)
    searchResults =
      '<div class="empty">No matches returned. Your site may not have indexed this content.</div>';
  if (page === "search") render();
}
async function click(b) {
  if (b.dataset.page) {
    await go(b.dataset.page);
    return;
  }
  if (b.dataset.tag) {
    if ($("#modal").open) close();
    query = "#" + b.dataset.tag;
    page = "search";
    searchType = "Posts";
    render();
    await search();
    return;
  }
  if (b.dataset.view) {
    view = b.dataset.view;
    statuses = [];
    cursor = null;
    render();
    if (session.connection) await loadFeed();
    return;
  }
  if (b.dataset.searchType) {
    searchType = b.dataset.searchType;
    searchResults = null;
    render();
    if (query) await search();
    return;
  }
  if (b.dataset.themeChoice) {
    prefs.theme = b.dataset.themeChoice;
    theme();
    $$("[data-theme-choice]").forEach((x) =>
      x.setAttribute(
        "aria-pressed",
        String(x.dataset.themeChoice === prefs.theme),
      ),
    );
    await savePrefs();
    return;
  }
  const a = b.dataset.do,
    id = b.dataset.id;
  if (a === "dismiss") $("#status-message").replaceChildren();
  if (a === "account") await go("account");
  if (a === "login") await authenticate();
  if (a === "enroll" || a === "replacement-key") await register();
  if (a === "logout") {
    await api("/auth/logout", {});
    statuses = [];
    following = [];
    cursor = null;
    peopleCursor = null;
    searchResults = null;
    query = "";
    loadSeq++;
    known.clear();
    drafts.clear();
    await refreshSession();
    render();
  }
  if (a === "codes") await showCodes();
  if (a === "replace-codes") {
    await authenticate(true);
    await showCodes();
  }
  if (a === "confirm-codes") {
    if (!$("#codes-saved").checked) return;
    await api("/auth/backup/confirm", { saved: true });
    close();
    await refreshSession();
    page = "account";
    render();
    notify("Backup codes saved. Your account is ready.");
  }
  if (a === "copy-codes") {
    await navigator.clipboard.writeText(codes.join("\n"));
    notify("Copied. Confirm after saving them safely.");
  }
  if (a === "download-codes") {
    const blob = new Blob(
      [
        "Asterism Reader — " +
          location.origin +
          "\nSingle-use backup codes\n\n" +
          codes.join("\n"),
      ],
      { type: "text/plain" },
    );
    const u = URL.createObjectURL(blob),
      el = document.createElement("a");
    el.href = u;
    el.download = "asterism-backup-codes.txt";
    el.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  if (a === "add-key") {
    await authenticate(true);
    await register();
    notify("Passkey added.");
  }
  if (a === "remove-key") {
    await authenticate(true);
    await api("/auth/credentials/" + encodeURIComponent(id), {}, "DELETE");
    await refreshSession();
    render();
  }
  if (a === "revoke-session") {
    await authenticate(true);
    await api("/auth/sessions/" + encodeURIComponent(id), {}, "DELETE");
    await refreshSession();
    render();
  }
  if (a === "recovery")
    modal(
      "Use a backup code",
      `<p>Recovery signs out your other sessions. You will create a replacement passkey and save new backup codes before returning to your reader.</p><form id="recovery-form"><label class="control-label" for="recovery-code">Backup code</label><input id="recovery-code" type="text" autocomplete="off" required maxlength="100"><button class="button primary" type="submit">Recover account</button></form>`,
    );
  if (a === "connect") {
    await authenticate(true);
    const { url } = await api("/wordpress/connect", {});
    location.assign(url);
  }
  if (a === "disconnect") {
    await authenticate(true);
    await api("/wordpress/disconnect", {});
    statuses = [];
    following = [];
    known.clear();
    searchResults = null;
    await refreshSession();
    render();
  }
  if (a === "refresh") await loadFeed();
  if (a === "more-feed") await loadFeed(true);
  if (a === "more-people") await loadPeople(true);
  if (a === "read") await openPost(id);
  if (a === "like" || a === "save") {
    const p = known.get(id);
    if (!p) return;
    const operation =
      a === "like"
        ? p.favourited
          ? "unfavourite"
          : "favourite"
        : p.bookmarked
          ? "unbookmark"
          : "bookmark";
    const updated = await api(
      "/wordpress/post/" + encodeURIComponent(id) + "/" + operation,
      {},
    );
    Object.assign(p, updated);
    $$(`.actions button`)
      .filter((x) => x.dataset.id === id && x.dataset.do === a)
      .forEach((x) => {
        x.setAttribute(
          "aria-pressed",
          String(a === "like" ? !!p.favourited : !!p.bookmarked),
        );
        x.innerHTML =
          a === "like"
            ? ico("heart") + " " + (Number(p.favourites_count) || 0)
            : ico("save");
      });
    notify("Confirmed by WordPress.");
  }
  if (a === "follow") {
    if (!session.connection)
      throw new Error("Connect WordPress in Account first.");
    followDialog();
  }
  if (a === "follow-person") {
    const result = await api("/wordpress/follow", { id });
    close();
    notify(
      result.requested
        ? "Follow request sent; awaiting approval."
        : result.following
          ? "Following confirmed by WordPress."
          : "Request submitted. Check your follows for confirmation.",
    );
    following = [];
    await go("people");
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (
    !b ||
    (b.type === "submit" && b.closest("form")) ||
    b.classList.contains("dialog-close")
  )
    return;
  const disabled = b.disabled;
  b.disabled = true;
  try {
    await click(b);
  } catch (e) {
    showError(e);
  } finally {
    if (b.isConnected) b.disabled = disabled;
    if ($("#codes-saved"))
      $("[data-do=confirm-codes]").disabled = !$("#codes-saved").checked;
  }
});
function showError(e) {
  const message =
    e.name === "NotAllowedError"
      ? "Passkey operation cancelled or unavailable. Please try again."
      : e.message || "Something went wrong.";
  if ($("#modal").open) {
    let el = $("#modal .auth-error");
    if (!el) {
      el = document.createElement("p");
      el.className = "auth-error";
      el.setAttribute("role", "alert");
      $(".dialog-body").append(el);
    }
    el.textContent = message;
  } else error(message);
}
document.addEventListener("input", (e) => {
  if (e.target.id === "text-size") {
    prefs.size = Number(e.target.value);
    theme();
    $("#size-value").textContent = prefs.size + " px";
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "codes-saved")
    $("[data-do=confirm-codes]").disabled = !e.target.checked;
  if (e.target.id === "font-choice") {
    prefs.font = e.target.value;
    theme();
    await savePrefs();
  }
  if (e.target.id === "text-size") await savePrefs();
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = e.target.querySelector("[type=submit]");
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    if (e.target.id === "recovery-form") {
      await api("/auth/recover", { code: $("#recovery-code").value });
      close();
      await refreshSession();
      render();
    }
    if (e.target.id === "search-form") {
      query = $("#search-input").value;
      await search();
    }
    if (e.target.id === "follow-form") {
      const result = await api(
        "/wordpress/search?" +
          new URLSearchParams({
            q: $("#follow-query").value,
            type: "accounts",
          }),
      );
      $("#follow-results").innerHTML =
        (result.accounts || [])
          .map(
            (a) =>
              `<div class="result follow-card">${author(a)}<p>Follow as ${esc(session.connection.acct)} on wordpress.example.com</p>${button(a.locked ? "Request to follow" : "Follow on WordPress", "follow-person", `data-id="${esc(a.id)}"`, "primary")}</div>`,
          )
          .join("") || "<p>No accounts found. Try the full handle.</p>";
    }
    if (e.target.id === "reply-form") {
      const id = e.target.dataset.id,
        value = $("#reply-text").value;
      drafts.set(id, value);
      await api("/wordpress/reply", { id, text: value });
      $("#reply-text").value = "";
      drafts.delete(id);
      close();
      notify("Reply sent through WordPress.");
      await openPost(id);
    }
  } catch (e) {
    showError(e);
  } finally {
    if (submit.isConnected) submit.disabled = false;
  }
});
try {
  await refreshSession();
  render();
  if (connectionNotice === "pkce-required")
    error(
      "WordPress did not enforce PKCE. Access was not saved. The Enable Mastodon Apps compatibility patch must be installed before connecting.",
    );
  else if (connectionNotice === "declined")
    notify("WordPress authorization was declined.");
  else if (connectionNotice === "success") notify("WordPress connected.");
  if (session.phase === "full" && session.connection) await loadFeed();
} catch (e) {
  error(e.message);
}
