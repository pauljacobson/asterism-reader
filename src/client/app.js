import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import DOMPurify from "dompurify";
import { canBoost } from "../shared/boost.js";
import { installCard, startPwa, installApp, updateApp } from "./pwa.js";
import { previewImageUrl } from "../shared/preview-image.js";
import { accentChoices, defaultPreferences } from "../shared/preferences.js";
import { accountIdentity } from "../shared/identity.js";
import { createListsUI } from "./lists.js";
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
const url = (v, allowHttp = false) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || (allowHttp && u.protocol === "http:")
      ? u.href
      : "";
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
    const safe = url(node.getAttribute("href"), true);
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
  boost: '<path d="m5 7 3-3 3 3M8 4v12H3m16 1-3 3-3-3m3 3V8h5"/>',
  heart: '<path d="M12 21 3 12C-3 4 7 0 12 7c5-7 15-3 9 5z"/>',
  save: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  reply: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5z"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  settings:
    '<path d="M3 6h18M3 18h18"/><circle cx="9" cy="6" r="3"/><circle cx="16" cy="18" r="3"/>',
  admin: '<path d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5"/>',
  account:
    '<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
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
  peopleSeq = 0,
  view = "All",
  query = "",
  searchType = "Posts",
  lastFocus = null,
  codes = [],
  searchResults = null,
  loadSeq = 0,
  authorId = null,
  authorAccount = null,
  authorPosts = [],
  authorCursor = null,
  authorLoading = false,
  authorError = "",
  authorSeq = 0,
  modalSeq = 0,
  modalScroll = 0,
  modalOverflow = "";
let invite = new URLSearchParams(location.hash.slice(1)).get("setup") || "";
const connectionNotice = new URLSearchParams(location.search).get("connection");
if (invite || location.search)
  history.replaceState(
    null,
    "",
    location.pathname + (invite ? "" : location.hash),
  );
const drafts = new Map(),
  known = new Map();
let prefs = { ...defaultPreferences };
const media = matchMedia("(prefers-color-scheme: dark)");
function theme() {
  document.body.dataset.accent = prefs.accent;
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
const listsUI = createListsUI({
  api,
  esc,
  author,
  button,
  modal,
  close,
  notify,
  paint: render,
  navigate: go,
  changed: async () => {
    statuses = [];
    following = [];
    cursor = null;
    peopleCursor = null;
    loadSeq++;
    peopleSeq++;
    if (page === "feed" && session.connection) await loadFeed();
    if (page === "people" && session.connection) await loadPeople();
  },
});
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
  if (!navigator.onLine)
    throw new Error("You are offline. Reconnect and try again.");
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
  if (!response.ok) {
    const reference = /^[0-9a-f-]{36}$/.test(data.requestId || "")
      ? ` (Request ID: ${data.requestId})`
      : "";
    throw new Error((data.error || "The request failed.") + reference);
  }
  return data;
}
async function refreshSession() {
  session = await api("/session");
  if (session.preferences) {
    prefs = session.preferences;
    theme();
  }
  if (session.phase === "full") await listsUI.overview();
  return session;
}
function heading(k, t, s, action = "") {
  return `<div class="page-heading"><div><div class="kicker">${esc(k)}</div><h1>${esc(t)}</h1><p class="subtitle">${esc(s)}</p></div>${action}</div>`;
}
function navigation() {
  const full = session.phase === "full";
  document.body.dataset.auth = full ? "full" : "limited";
  $(".app-toolbar").hidden = !full;
  $(".sidebar-bottom").hidden = !full;
  $(".top-tools").hidden = !full;
  $(".mobile-nav").hidden = !full;
  const items = [
    ["feed", "home", "Feed"],
    ["search", "search", "Search"],
    ["people", "people", "People"],
    ["lists", "grid", "Lists"],
  ];
  $(".top nav").innerHTML = full
    ? items
        .map(
          ([id, icon, label]) =>
            `<button class="nav-button" data-page="${id}" aria-label="${label}" ${(page === id || (page === "author" && id === "feed")) && !(id === "feed" && page === "feed" && view === "Saved") ? 'aria-current="page"' : ""}>${ico(icon)}<span class="nav-label">${label}</span></button>`,
        )
        .join("")
    : "";
  if (full) {
    $(".top nav").insertAdjacentHTML(
      "beforeend",
      `<button class="nav-button" data-do="saved-feed" aria-label="Saved" ${page === "feed" && view === "Saved" ? 'aria-current="page"' : ""}>${ico("save")}<span class="nav-label">Saved</span></button>`,
    );
    const name =
      session.connection?.display_name ||
      session.connection?.acct ||
      "Your account";
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
    $("#account-shortcut").textContent = initials;
    $(".sidebar-bottom").innerHTML =
      `<button class="nav-button" data-page="preferences" aria-label="Preferences" ${page === "preferences" ? 'aria-current="page"' : ""}>${ico("settings")}<span class="nav-label">Preferences</span></button><button class="nav-button" data-page="account" aria-label="Account" ${page === "account" ? 'aria-current="page"' : ""}>${ico("account")}<span class="nav-label">Account</span></button><button class="nav-button" data-page="admin" aria-label="Admin" ${["admin", "logs"].includes(page) ? 'aria-current="page"' : ""}>${ico("admin")}<span class="nav-label">Admin</span></button><div class="account-summary"><span class="avatar">${esc(initials)}</span><div><strong>${esc(name)}</strong><small>${session.connection ? "WordPress connected" : "WordPress not connected"}</small></div></div>`;
  } else $(".sidebar-bottom").replaceChildren();
  $(".mobile-nav").innerHTML = full
    ? [
        ...items.filter(([id]) => id !== "lists"),
        ["preferences", "settings", "Preferences"],
        ["account", "account", "Account"],
        ["admin", "admin", "Admin"],
      ]
        .map(
          ([id, icon, label]) =>
            `<button data-page="${id}" ${page === id || (page === "author" && id === "feed") || (page === "logs" && id === "admin") ? 'aria-current="page"' : ""}>${ico(icon)}${label}</button>`,
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
function author(a, date, source) {
  const name = a?.display_name || a?.username || "Unknown account",
    initials = name.slice(0, 2).toUpperCase();
  const href = a?.id ? "#author=" + encodeURIComponent(a.id) : "";
  // Prefer the still image so animated profile pictures do not distract from
  // reading. Keep initials underneath as the missing/broken image fallback.
  const picture =
      previewImageUrl(a?.avatar_static) || previewImageUrl(a?.avatar),
    fallback = previewImageUrl(a?.avatar);
  const portrait = `${picture ? `<img class="avatar-image" src="${esc(picture)}" ${fallback && fallback !== picture ? `data-fallback-src="${esc(fallback)}"` : ""} width="40" height="40" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}<span class="avatar-initials" aria-hidden="true">${esc(initials)}</span>`;
  const avatar = href
    ? `<a class="avatar author-link" href="${esc(href)}" aria-label="Posts by ${esc(name)}">${portrait}</a>`
    : `<span class="avatar" role="img" aria-label="${esc(name)}">${portrait}</span>`;
  const identity = `<strong>${esc(name)}</strong><span class="handle">${esc(a?.acct)}</span>`;
  const profile = href
    ? `<a class="author-info author-link" href="${esc(href)}" aria-label="Posts by ${esc(name)} (${esc(a?.acct)})">${identity}</a>`
    : `<div class="author-info">${identity}</div>`;
  const timestamp = date
    ? `<time datetime="${esc(date)}" title="${esc(new Date(date).toLocaleString())}">${esc(new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</time>`
    : "";
  const permalink = url(source, true);
  return `<div class="author">${avatar}${profile}${timestamp ? (permalink ? `<a class="post-date" href="${esc(permalink)}" target="_blank" rel="noopener noreferrer" aria-label="Open original post">${timestamp}</a>` : `<span class="post-date">${timestamp}</span>`) : ""}</div>`;
}
function actions(p) {
  return `<div class="actions"><button data-do="like" data-id="${esc(p.id)}" aria-label="${p.favourited ? "Unlike" : "Like"} post" aria-pressed="${!!p.favourited}">${ico("heart")} ${Number(p.favourites_count) || 0}</button><button data-do="read" data-id="${esc(p.id)}" aria-label="Read conversation and reply">${ico("reply")} ${Number(p.replies_count) || 0}</button><button data-do="boost" data-id="${esc(p.id)}" aria-label="${p.reblogged ? "Undo boost" : "Boost"} post" aria-pressed="${!!p.reblogged}" ${!p.reblogged && !canBoost(p, session.connection?.id) ? 'disabled title="Only public Fediverse posts can be boosted"' : 'title="Share with your Fediverse followers"'}>${ico("boost")} ${Number(p.reblogs_count) || 0}</button><button data-do="save" data-id="${esc(p.id)}" aria-label="${p.bookmarked ? "Unsave" : "Save"} post" aria-pressed="${!!p.bookmarked}">${ico("save")}</button></div>`;
}
function previewText(link, metadata) {
  const domain = new URL(link).hostname.replace(/^www\./, "");
  const image = previewImageUrl(metadata?.image);
  return `${image ? `<img class="link-preview-thumbnail" src="${esc(image)}" width="64" height="64" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}<span class="link-preview-text"><span class="link-preview-domain">${esc(domain)}</span><strong>${esc(String(metadata?.title || "Open link").slice(0, 200))}</strong>${metadata?.description ? `<span class="link-preview-description">${esc(String(metadata.description).slice(0, 320))}</span>` : ""}</span><span class="link-preview-arrow" aria-hidden="true">↗</span>`;
}
// Image errors do not bubble. Capture failures for dynamically inserted images.
// Avatars try the original when a separate static URL fails, then show initials;
// link previews release the thumbnail space and keep their text link usable.
document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (image.classList.contains("avatar-image") && image.dataset.fallbackSrc) {
      const fallback = image.dataset.fallbackSrc;
      delete image.dataset.fallbackSrc;
      image.src = fallback;
    } else if (image.matches(".link-preview-thumbnail, .avatar-image"))
      image.remove();
  },
  true,
);
function linkPreview(html, metadata) {
  const root = document.createElement("div");
  root.innerHTML = html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const visited = new Set();
  let node,
    link = "",
    standalone = null;
  while ((node = walker.nextNode())) {
    const anchor = node.parentElement?.closest("a");
    if (anchor) {
      if (visited.has(anchor)) continue;
      visited.add(anchor);
      const label = anchor.textContent.trim();
      const href = url(anchor.getAttribute("href"), true);
      if (!href || /^[@#]/.test(label)) continue;
      const visible = label
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/(?:…|\.\.\.)$/, "")
        .toLowerCase();
      const destination = href
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .toLowerCase();
      if (
        !/^https?:\/\//i.test(label) &&
        !/^www\./i.test(label) &&
        (!visible.includes(".") ||
          /\s/.test(visible) ||
          !destination.startsWith(visible))
      )
        continue;
      link = href;
      const paragraph = anchor.closest("p");
      if (paragraph?.textContent.trim() === label) standalone = paragraph;
      else if (anchor.parentElement === paragraph) {
        const neighbor = (direction) => {
          let sibling = anchor[direction];
          while (
            sibling?.nodeType === Node.TEXT_NODE &&
            !sibling.textContent.trim()
          )
            sibling = sibling[direction];
          return sibling;
        };
        const before = neighbor("previousSibling"),
          after = neighbor("nextSibling");
        if (
          (!before || before.nodeName === "BR") &&
          (!after || after.nodeName === "BR")
        )
          standalone = anchor;
      } else if (
        anchor.parentElement === root &&
        root.textContent.trim() === label
      )
        standalone = anchor;
    } else {
      const match = node.textContent.match(/https?:\/\/[^\s<>"']+/i);
      if (!match) continue;
      let value = match[0].replace(/[.,;!?]+$/, "");
      while (
        value.endsWith(")") &&
        (value.match(/\(/g)?.length || 0) < (value.match(/\)/g)?.length || 0)
      )
        value = value.slice(0, -1);
      link = url(value, true);
      const paragraph = node.parentElement?.closest("p");
      if (paragraph?.textContent.trim() === value) standalone = paragraph;
      else if (node.parentElement === root && node.textContent.trim() === value)
        standalone = node;
    }
    if (link) break;
  }
  if (!link) return { html, preview: "", after: "" };
  // Keep inline links in their sentence; replace a URL-only paragraph with a card.
  let after = "";
  if (standalone && root.contains(standalone)) {
    const range = document.createRange();
    range.setStartAfter(standalone);
    range.setEnd(root, root.childNodes.length);
    const remainder = document.createElement("div");
    remainder.append(range.extractContents());
    const firstParagraph = remainder.firstElementChild;
    if (firstParagraph?.tagName === "P") {
      while (firstParagraph.firstChild?.nodeName === "BR")
        firstParagraph.firstChild.remove();
    }
    after = remainder.innerHTML;
  }
  standalone?.remove();
  const lastParagraph = root.lastElementChild;
  if (standalone && lastParagraph?.tagName === "P") {
    while (lastParagraph.lastChild?.nodeName === "BR")
      lastParagraph.lastChild.remove();
    if (!lastParagraph.textContent.trim()) lastParagraph.remove();
  }
  const supplied =
    url(metadata?.url, true) === link && metadata?.title ? metadata : null;
  return {
    html: root.innerHTML,
    after,
    preview: `<a class="link-preview" href="${esc(link)}" target="_blank" rel="noopener noreferrer" data-preview-url="${esc(link)}" ${supplied ? 'data-preview-ready="true"' : ""}>${previewText(link, supplied)}</a>`,
  };
}
const previewCache = new Map(),
  previewObserved = new Set(),
  previewJobs = [];
let previewActive = 0;
function pumpPreviews() {
  while (previewActive < 2 && previewJobs.length) {
    const { link, resolve } = previewJobs.shift();
    previewActive++;
    api("/link-preview", { url: link })
      .then((result) => resolve(result.preview))
      .catch(() => resolve(null))
      .finally(() => {
        previewActive--;
        pumpPreviews();
      });
  }
}
function fetchPreview(link) {
  if (!previewCache.has(link)) {
    previewCache.set(
      link,
      new Promise((resolve) => {
        previewJobs.push({ link, resolve });
        pumpPreviews();
      }),
    );
    if (previewCache.size > 256)
      previewCache.delete(previewCache.keys().next().value);
  }
  return previewCache.get(link);
}
const previewObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target,
        link = element.dataset.previewUrl;
      previewObserver.unobserve(element);
      previewObserved.delete(element);
      fetchPreview(link).then((metadata) => {
        if (
          metadata &&
          element.isConnected &&
          element.dataset.previewUrl === link
        )
          element.innerHTML = previewText(link, metadata);
      });
    }
  },
  { rootMargin: "200px" },
);
function observePreviews(root) {
  for (const element of previewObserved) {
    if (!element.isConnected) {
      previewObserver.unobserve(element);
      previewObserved.delete(element);
    }
  }
  for (const element of root.querySelectorAll(
    ".link-preview:not([data-preview-ready])",
  )) {
    element.dataset.previewReady = "true";
    previewObserved.add(element);
    previewObserver.observe(element);
  }
}
function body(p, full = false) {
  const media = p.media_attachments || [];
  // Feed cards show a compact gallery; the reading view retains every attachment.
  const visibleMedia = full ? media : media.slice(0, 4);
  const attachments = visibleMedia
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
  const gallery = attachments
    ? `<div class="post-attachments${visibleMedia.length > 1 ? " multiple" : ""}">${attachments}</div>`
    : "";
  const more =
    !full && media.length > visibleMedia.length
      ? `<button class="text-button more-attachments" data-do="read" data-id="${esc(p.id)}">View all ${media.length} attachments →</button>`
      : "";
  const linked = linkPreview(content(p.content), p.card);
  let html = `<div class="post-copy">${linked.html}</div>${linked.preview}${linked.after ? `<div class="post-copy">${linked.after}</div>` : ""}${gallery}${more}`;
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
  return `<article class="post" data-id="${esc(p.id)}">${item.reblog ? `<p class="activity-notice">Boosted by ${esc(item.account?.display_name || item.account?.acct)}</p>` : ""}${author(p.account, p.created_at, p.url || p.uri)}${body(p)}<button class="text-button read-button" data-do="read" data-id="${esc(p.id)}">Read & converse →</button>${actions(p)}</article>`;
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
    ) +
    `<div class="tool-row"><div class="feed-filters">${listsUI.filter("feed-list")}<div class="chips">${["All", "Photos", "Saved"].map((x) => `<button class="chip" data-view="${x}" aria-pressed="${view === x}">${x}</button>`).join("")}</div></div><div class="list-actions">${button("Manage lists", "manage-lists")}${button("Refresh", "refresh")}</div></div>${!session.connection ? emptyConnection() : list.length ? `<div class="board">${list.map(card).join("")}</div>` : `<div class="empty">${cursor && listsUI.selected ? "No matches in this part of your history. Load older posts to keep looking." : "No posts loaded here. Refresh your feed or try another view."}</div>`}${cursor ? `<div class="load-more">${button("Load older posts", "more-feed")}</div>` : ""}`
  );
}
function peopleView() {
  return (
    heading(
      "Your orbit",
      "People you follow.",
      "Follows managed by your WordPress site.",
      button("Manage lists", "manage-lists"),
    ) +
    (!session.connection
      ? emptyConnection()
      : `<div class="tool-row">${listsUI.filter("people-list")}</div><div class="panel">${following.length ? following.map((a) => `<div class="person-row">${author(a)}<div class="list-actions"><span class="badge">Following</span>${button("Lists", "person-lists", `data-key="${esc(accountIdentity(a, session.site))}"`)}</div></div>`).join("") : "<p>No followed accounts loaded yet.</p>"}</div>${peopleCursor ? button("Load more people", "more-people") : ""}`)
  );
}
function authorView() {
  const name =
    authorAccount?.display_name || authorAccount?.acct || "this author";
  return (
    heading(
      "An author's constellation",
      `Posts by ${name}`,
      "Posts available through your WordPress site, newest first.",
      button("Back to feed", "back-feed"),
    ) +
    `${authorAccount ? author(authorAccount) : ""}<div class="tool-row">${button("Refresh", "refresh-author", authorLoading ? "disabled" : "")}</div>${!session.connection ? emptyConnection() : authorLoading && !authorPosts.length ? '<p role="status">Loading posts…</p>' : authorError && !authorPosts.length ? '<div class="empty">Posts could not be loaded. Try Refresh.</div>' : authorPosts.length ? `<div class="board">${authorPosts.map(card).join("")}</div>` : authorCursor ? '<div class="empty">No matches in this part of your history. Load older posts to keep looking.</div>' : '<div class="empty">No posts by this author are available through your site.</div>'}${authorCursor ? `<div class="load-more">${button(authorLoading ? "Loading…" : "Load older posts", "more-author", authorLoading ? "disabled" : "")}</div>` : ""}`
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
    `<div class="settings-layout"><div><section class="panel"><h2>Appearance</h2><div class="control-label">Theme</div><div class="theme-choice">${["light", "dark", "system"].map((t) => `<button data-theme-choice="${t}" aria-pressed="${prefs.theme === t}"><span class="theme-swatch ${t}"></span>${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div><fieldset class="accent-picker"><legend class="control-label">Accent color</legend><p class="muted" id="accent-help">Choose a color for links, buttons, and highlights. Saved to your account across devices.</p><div class="accent-choices">${accentChoices.map(({ id, label }) => `<label class="accent-choice"><input type="radio" name="accent-color" value="${id}" ${prefs.accent === id ? "checked" : ""} aria-describedby="accent-help"><span class="accent-swatch" data-accent="${id}" aria-hidden="true"></span><span>${label}</span></label>`).join("")}</div></fieldset></section><section class="panel"><h2>Reading</h2><label class="control-label" for="font-choice">Font family</label><select id="font-choice"><option value="sans" ${prefs.font === "sans" ? "selected" : ""}>Sans serif</option><option value="serif" ${prefs.font === "serif" ? "selected" : ""}>Serif</option></select><label class="control-label" for="text-size">Text size <span id="size-value">${prefs.size} px</span></label><input id="text-size" type="range" min="16" max="26" value="${prefs.size}"></section></div><section class="panel"><div class="kicker">A live reading sample</div><div class="sample-reading"><h3>A little space for wonder.</h3><p>Stories, small discoveries, and thoughtful conversations. At your own pace.</p><p class="sample-accent">A color that feels like you.</p></div><span class="badge">Your reading space</span></section></div>`
  );
}
function account() {
  return (
    heading(
      "Your place in the constellation",
      "Account.",
      "Manage how you sign in and connect to your site.",
    ) +
    `<div class="settings-layout"><div><section class="panel"><h2>Passkeys</h2>${session.passkeys.map((p) => `<div class="setting-row"><div><h3>${esc(p.name)}</h3><p>Added ${esc(new Date(p.created).toLocaleDateString())}</p></div>${button("Remove", "remove-key", `data-id="${esc(p.id)}" ${session.passkeys.length < 2 ? "disabled" : ""}`)}</div>`).join("")}${button("Add a passkey", "add-key")}</section><section class="panel"><h2>Backup codes</h2><p>${session.backupRemaining} unused codes. Save them separately from this app.</p>${button("Replace backup codes", "replace-codes")}</section><section class="panel"><h2>Sessions</h2>${session.sessions.map((s) => `<div class="setting-row"><div><h3>${s.current ? "This browser" : "Another session"}</h3><p>Last active ${esc(new Date(s.touched).toLocaleString())}</p></div>${s.current ? '<span class="badge">Current</span>' : button("Sign out", "revoke-session", `data-id="${esc(s.id)}"`)}</div>`).join("")}${button("Sign out of this browser", "logout")}</section></div><div>${installCard()}<section class="panel"><h2>WordPress connection</h2><p>wordpress.example.com</p><p class="account-name">${session.connection ? `Connected as ${esc(session.connection.display_name || session.connection.acct)}` : "Not connected"}</p><p>Authorize Asterism to read your feeds, follow people, reply, and react as your site account.</p>${button(session.connection ? "Disconnect WordPress" : "Connect WordPress", session.connection ? "disconnect" : "connect", "", "primary")}<p>Your WordPress access token is encrypted and kept on the Asterism server.</p></section><section class="panel"><h2>Lists</h2><p>Organize your follows, import your Mastodon lists, and filter your feed.</p>${button("Manage lists", "manage-lists")}</section></div></div>`
  );
}
// Keep the controls stable during refreshes so searching and reading details
// are not interrupted by the optional polling timer.
let logFilters = { level: "", category: "", hours: "24", search: "" },
  logResult = null,
  logLoading = false,
  logError = "",
  logSeq = 0,
  logAutoRefresh = false,
  logTimer = null;
function logQuery() {
  return new URLSearchParams(
    Object.entries(logFilters).filter(([, value]) => value),
  );
}
function admin() {
  return (
    heading(
      "Administration",
      "Admin.",
      "Tools for looking after your reader.",
    ) +
    `<section class="panel"><h2>Application logs</h2><p>Review recent activity, diagnose WordPress connection problems, and download diagnostic logs.</p>${button("View logs", "view-logs", "", "primary")}</section>`
  );
}
function logs() {
  const options = (values, selected) =>
    values
      .map(
        ([value, label]) =>
          `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`,
      )
      .join("");
  return (
    heading(
      "Admin / Logs",
      "Application logs.",
      "Recent activity and diagnostics for your reader.",
      button("Back to Admin", "back-admin"),
    ) +
    `<section class="panel logs-panel"><form id="log-filter-form" class="log-controls">
      <label>Level<select id="log-level">${options(
        [
          ["", "All levels"],
          ["error", "Errors"],
          ["warn", "Warnings"],
          ["info", "Information"],
          ["debug", "Debug"],
        ],
        logFilters.level,
      )}</select></label>
      <label>Category<select id="log-category">${options(
        [
          ["", "All categories"],
          ["wordpress", "WordPress"],
          ["auth", "Authentication"],
          ["preview", "Link previews"],
          ["request", "Requests"],
          ["system", "System"],
        ],
        logFilters.category,
      )}</select></label>
      <label>Period<select id="log-hours">${options(
        [
          ["1", "Last hour"],
          ["24", "Last 24 hours"],
          ["168", "Last 7 days"],
          ["", "All retained logs"],
        ],
        logFilters.hours,
      )}</select></label>
      <label class="log-search">Search<input type="search" id="log-search" maxlength="200" value="${esc(logFilters.search)}" placeholder="Message, operation, or request ID"></label>
      <button class="button primary" type="submit">Apply filters</button></form>
      <div class="log-toolbar"><label class="check-label"><input id="log-auto-refresh" type="checkbox" ${logAutoRefresh ? "checked" : ""}> Refresh every 15 seconds</label><div class="flex-wrap">${button("Refresh", "refresh-logs")}<a class="button" id="log-export" href="/api/admin/logs/export?${esc(logQuery())}" download>Download NDJSON</a></div></div>
      <p class="muted">Logs retain up to 7 days or 10,000 entries. Credentials and post contents are excluded.</p>
      <div id="log-results" aria-busy="${logLoading}">${logResults()}</div></section>`
  );
}
function logResults() {
  const entries = logResult?.entries || [];
  return `${logResult?.persistenceDegraded ? '<p class="error-banner" role="alert">Some recent entries could not be saved. Check Railway console logs.</p>' : ""}${logError ? `<p class="error-banner" role="alert">${esc(logError)}</p>` : ""}
    <div class="log-summary" aria-label="Matching log summary">${["error", "warn", "info", "debug"].map((level) => `<div><strong>${logResult?.stats[level] || 0}</strong><span>${esc(level)}</span></div>`).join("")}</div>
    <p class="muted" role="status">${logLoading ? "Loading logs…" : logResult ? `Showing ${entries.length} of ${logResult.total} matching entries · ${Math.ceil(logResult.storedBytes / 1024)} KB retained` : "No logs loaded."}</p>
    <div class="log-list">${entries.map((entry) => `<article class="log-entry log-${esc(entry.level)}"><div class="log-entry-heading"><span class="log-badge">${esc(entry.level)}</span><strong>${esc(entry.message)}</strong><time datetime="${esc(entry.timestamp)}">${esc(new Date(entry.timestamp).toLocaleString())}</time></div><p class="log-context">${esc(entry.category)}${entry.data.operation ? " · " + esc(entry.data.operation) : ""}${entry.data.status !== undefined ? " · HTTP " + esc(entry.data.status) : ""}${entry.data.durationMs !== undefined ? " · " + esc(entry.data.durationMs) + " ms" : ""}</p><details data-log-id="${entry.id}"><summary>Details${entry.requestId ? " · request " + esc(entry.requestId.slice(0, 8)) : ""}</summary>${entry.requestId ? button("Copy request ID", "copy-log-id", `data-request-id="${esc(entry.requestId)}"`) : ""}<pre>${esc(JSON.stringify({ requestId: entry.requestId, event: entry.event, ...entry.data }, null, 2))}</pre></details></article>`).join("") || (!logLoading && !logError ? '<div class="empty"><h2>No matching logs</h2><p>Try another filter or period.</p></div>' : "")}</div>
    ${logResult?.next ? button("Load older entries", "older-logs", logLoading ? "disabled" : "") : ""}`;
}
function paintLogs() {
  if (page !== "logs" || !$("#log-results")) return;
  const expanded = new Set(
    $$("[data-log-id][open]").map((el) => el.dataset.logId),
  );
  $("#log-results").innerHTML = logResults();
  $("#log-results").setAttribute("aria-busy", String(logLoading));
  $$("[data-log-id]").forEach((el) => {
    el.open = expanded.has(el.dataset.logId);
  });
  $("[data-do=refresh-logs]").disabled = logLoading;
  $("#log-export").href = "/api/admin/logs/export?" + logQuery();
}
async function loadLogs(older = false) {
  if (page !== "logs" || session.phase !== "full") return;
  const seq = ++logSeq,
    params = logQuery();
  if (older && logResult?.next) params.set("before", logResult.next);
  logLoading = true;
  logError = "";
  paintLogs();
  try {
    const result = await api("/admin/logs?" + params);
    if (seq !== logSeq || page !== "logs") return;
    logResult = older
      ? { ...result, entries: [...logResult.entries, ...result.entries] }
      : result;
  } catch (e) {
    if (seq === logSeq && page === "logs") logError = e.message;
  } finally {
    if (seq === logSeq) {
      logLoading = false;
      paintLogs();
    }
  }
}
function logPolling() {
  clearInterval(logTimer);
  logTimer = null;
  if (page === "logs" && session.phase === "full" && logAutoRefresh)
    logTimer = setInterval(() => {
      if (!document.hidden && !logLoading) void loadLogs();
    }, 15_000);
}
function render() {
  navigation();
  logPolling();
  $("#main").innerHTML =
    session.phase === "anonymous"
      ? login()
      : session.phase !== "full"
        ? setupView()
        : (
            {
              feed,
              author: authorView,
              people: peopleView,
              search: searchView,
              preferences,
              account,
              admin,
              logs,
              lists: listsUI.page,
            }[page] || feed
          )();
  observePreviews($("#main"));
  if ($("#modal").open) observePreviews($(".dialog-body"));
}
async function go(p) {
  authorSeq++;
  if (location.hash.startsWith("#author="))
    history.pushState(null, "", location.pathname);
  page = p;
  logSeq++;
  logLoading = false;
  // Render Lists once its data is ready, so a late load cannot clear a CSV
  // the user has just selected or overwrite a list-edit form.
  if (p === "lists") {
    await listsUI.load();
    if (page !== p) return;
  }
  render();
  $("#main").focus();
  window.scrollTo(0, 0);
  if (page === "logs") await loadLogs();
  if (!session.connection) return;
  if (page === "feed" && !statuses.length) await loadFeed();
  if (page === "people" && !following.length) await loadPeople();
}
async function routeAuthor() {
  if (session?.phase !== "full") return;
  const id = new URLSearchParams(location.hash.slice(1)).get("author");
  if (!id) {
    if (page === "author") await go("feed");
    return;
  }
  if ($("#modal").open) close();
  authorId = id;
  authorAccount = null;
  authorPosts = [];
  authorCursor = null;
  authorError = "";
  page = "author";
  render();
  $("#main").focus();
  window.scrollTo(0, 0);
  if (session.connection) await loadAuthor();
}
async function loadAuthor(more = false) {
  const seq = ++authorSeq;
  authorLoading = true;
  authorError = "";
  render();
  try {
    const result = await api(
      "/wordpress/author/" +
        encodeURIComponent(authorId) +
        "?" +
        new URLSearchParams(
          more && authorCursor ? { cursor: authorCursor } : {},
        ),
    );
    // A late response must not replace another author or a different page.
    if (seq !== authorSeq || page !== "author") return;
    authorAccount = result.account;
    authorPosts = more
      ? [
          ...authorPosts,
          ...result.posts.filter(
            (p) => !authorPosts.some((x) => x.id === p.id),
          ),
        ]
      : result.posts;
    authorPosts.sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    authorCursor = result.next;
    remember(authorPosts);
  } catch (e) {
    if (seq !== authorSeq || page !== "author") return;
    authorError = e.message;
    showError(e);
  } finally {
    if (seq === authorSeq && page === "author") {
      authorLoading = false;
      render();
    }
  }
}
window.addEventListener("hashchange", () => routeAuthor().catch(showError));
document.addEventListener("click", (event) => {
  const link = event.target.closest("a.author-link");
  // Same-author links do not trigger hashchange, but must still close a post.
  if (
    link?.hash === location.hash &&
    $("#modal").open &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  )
    close();
});
async function loadFeed(more = false) {
  const seq = ++loadSeq;
  const result = await api(
    "/wordpress/feed?" +
      new URLSearchParams({
        saved: String(view === "Saved"),
        ...(listsUI.selected ? { list: listsUI.selected } : {}),
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
  const seq = ++peopleSeq;
  const result = await api(
    "/wordpress/following?" +
      new URLSearchParams({
        ...(listsUI.selected ? { list: listsUI.selected } : {}),
        ...(more && peopleCursor ? { cursor: peopleCursor } : {}),
      }),
  );
  if (seq !== peopleSeq) return;
  following = more
    ? [
        ...following,
        ...result.accounts.filter((a) => !following.some((x) => x.id === a.id)),
      ]
    : result.accounts;
  peopleCursor = result.next;
  if (page === "people") render();
}
function fillModal(title, html) {
  $("#modal-title").textContent = title;
  $(".dialog-body").innerHTML = html;
  observePreviews($(".dialog-body"));
}
function syncReadingControls() {
  for (const id of ["font-choice", "reader-font"])
    if ($("#" + id)) $("#" + id).value = prefs.font;
  for (const id of ["text-size", "reader-size"])
    if ($("#" + id)) $("#" + id).value = prefs.size;
  for (const id of ["size-value", "reader-size-value"])
    if ($("#" + id)) $("#" + id).textContent = prefs.size + " px";
  $("#reader-theme").value = prefs.theme;
}
function modal(title, html, reader = false) {
  const dialog = $("#modal");
  const seq = ++modalSeq;
  if (!$("#modal").open) {
    lastFocus = document.activeElement;
    modalScroll = window.scrollY;
    modalOverflow = document.body.style.overflow;
  }
  dialog.classList.toggle("reader", reader);
  $(".reader-back").hidden = !reader;
  $(".reader-preferences").hidden = !reader;
  $("#reader-settings").hidden = true;
  $(".reader-preferences").setAttribute("aria-expanded", "false");
  fillModal(title, html);
  syncReadingControls();
  if (!dialog.open) {
    dialog.showModal();
    document.body.style.overflow = "hidden";
  }
  if (reader) $("#modal-title").focus({ preventScroll: true });
  else $(".dialog-close").focus({ preventScroll: true });
  return seq;
}
function close() {
  if (!$("#modal").open) return;
  // Invalidate in-flight post/context requests before restoring the feed.
  modalSeq++;
  if ($("#reply-text"))
    drafts.set($("#reply-text").dataset.id, $("#reply-text").value);
  $("#modal").close();
  $(".dialog-body").replaceChildren();
  codes = [];
  document.body.style.overflow = modalOverflow;
  window.scrollTo(0, modalScroll);
  if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
}
$(".dialog-close").onclick = close;
$("#modal").addEventListener("cancel", (e) => {
  e.preventDefault();
  close();
});
let backdropPointer = false;
function outsideDialog(event) {
  const r = $("#modal").getBoundingClientRect();
  return (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  );
}
$("#modal").addEventListener("pointerdown", (event) => {
  // Only dismiss the reader, and only for a click that started outside it.
  // Dragging a text selection out of the dialog must not dismiss a draft.
  backdropPointer =
    $("#modal").classList.contains("reader") &&
    event.target === $("#modal") &&
    outsideDialog(event);
});
$("#modal").addEventListener("click", (event) => {
  if (backdropPointer && event.target === $("#modal") && outsideDialog(event))
    close();
  backdropPointer = false;
});
async function authenticate(reauth = false) {
  const data = await api("/auth/login/options", { reauth });
  const response = await startAuthentication({ optionsJSON: data.options });
  await api("/auth/login/verify", { id: data.id, response });
  await refreshSession();
  if (!reauth) {
    render();
    if (session.phase === "full" && session.connection) {
      if (new URLSearchParams(location.hash.slice(1)).has("author"))
        await routeAuthor();
      else await loadFeed();
    }
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
  // The reply shortcut inside an open post should keep its draft and simply
  // bring the composer into focus, rather than fetch and replace the reader.
  if ($("#modal").open && $("#reply-text")?.dataset.id === String(id)) {
    $("#reply-text").focus();
    return;
  }
  // Open immediately so dismissal also cancels the effect of a slow response.
  // Each modal has a generation: a late request cannot reopen a dismissed post
  // or replace a different post's conversation or reply draft.
  const seq = modal(
    "Reading view",
    '<div class="reader-scroll"><p class="muted" role="status">Loading post…</p></div>',
    true,
  );
  let p;
  try {
    p = await api("/wordpress/post/" + encodeURIComponent(id));
  } catch (e) {
    if (seq === modalSeq && $("#modal").open) {
      $(".reader-scroll").replaceChildren();
      throw e;
    }
    return;
  }
  if (seq !== modalSeq || !$("#modal").open) return;
  known.set(String(p.id), p);
  fillModal(
    `Post by ${p.account?.display_name || p.account?.acct || "this author"}`,
    `<div class="reader-scroll" tabindex="-1">${author(p.account, p.created_at, p.url || p.uri)}${body(p, true)}${actions(p)}<div id="conversation"><p class="muted" role="status">Loading conversation…</p></div></div><form id="reply-form" data-id="${esc(p.id)}"><label class="sr-only" for="reply-text">Reply as ${esc(session.connection?.acct)}</label><textarea id="reply-text" data-id="${esc(p.id)}" required maxlength="5000" rows="2" placeholder="Add to the conversation…">${esc(drafts.get(String(p.id)) || "")}</textarea><div class="compose-footer"><p class="muted">As ${esc(session.connection?.acct)} · ${esc(p.visibility || "private")}</p><button class="button primary" type="submit" aria-label="Send reply">Send reply →</button></div></form>`,
  );
  $(".reader-scroll").focus({ preventScroll: true });
  try {
    const context = await api(
      "/wordpress/post/" + encodeURIComponent(id) + "/context",
    );
    if (seq !== modalSeq || $("#reply-text")?.dataset.id !== String(id)) return;
    const replies = [
      ...(context.ancestors || []),
      ...(context.descendants || []),
    ];
    remember(replies);
    $("#conversation").innerHTML = replies.length
      ? `<h3 class="spacer">Conversation</h3>${replies.map((x) => `<div class="result">${author(x.account, x.created_at, x.url || x.uri)}${body(x, true)}</div>`).join("")}`
      : '<p class="muted spacer">No other replies returned by your site.</p>';
    observePreviews($("#conversation"));
  } catch {
    if (seq === modalSeq && $("#conversation"))
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
const pendingReactions = new Set();
async function click(b) {
  if (await listsUI.click(b)) return;
  if (b.dataset.page) {
    if (b.dataset.page === "feed" && view === "Saved") {
      view = "All";
      statuses = [];
      cursor = null;
    }
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
  if (a === "close-reader") {
    close();
    return;
  }
  if (a === "reader-settings") {
    const settings = $("#reader-settings");
    settings.hidden = !settings.hidden;
    b.setAttribute("aria-expanded", String(!settings.hidden));
    if (!settings.hidden) $("#reader-font").focus({ preventScroll: true });
    return;
  }
  if (a === "saved-feed") {
    view = "Saved";
    statuses = [];
    cursor = null;
    await go("feed");
    return;
  }
  if (a === "install-app") await installApp();
  if (a === "update-app") await updateApp();
  if (a === "view-logs") await go("logs");
  if (a === "back-admin") await go("admin");
  if (a === "refresh-logs") await loadLogs();
  if (a === "older-logs") await loadLogs(true);
  if (a === "copy-log-id") {
    await navigator.clipboard.writeText(b.dataset.requestId);
    notify("Request ID copied.");
  }
  if (a === "dismiss") $("#status-message").replaceChildren();
  if (a === "account") await go("account");
  if (a === "login") await authenticate();
  if (a === "enroll" || a === "replacement-key") await register();
  if (a === "logout") {
    await api("/auth/logout", {});
    logResult = null;
    logError = "";
    logSeq++;
    statuses = [];
    following = [];
    authorPosts = [];
    authorAccount = null;
    authorCursor = null;
    authorSeq++;
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
    const { url } = await api("/wordpress/connect", {});
    location.assign(url);
  }
  if (a === "disconnect") {
    await authenticate(true);
    await api("/wordpress/disconnect", {});
    statuses = [];
    following = [];
    authorPosts = [];
    authorAccount = null;
    authorCursor = null;
    authorSeq++;
    known.clear();
    searchResults = null;
    await refreshSession();
    render();
  }
  if (a === "refresh") await loadFeed();
  if (a === "back-feed") await go("feed");
  if (a === "refresh-author") await loadAuthor();
  if (a === "more-author") await loadAuthor(true);
  if (a === "more-feed") await loadFeed(true);
  if (a === "more-people") await loadPeople(true);
  if (a === "read") await openPost(id);
  if (a === "like" || a === "save" || a === "boost") {
    const p = known.get(id);
    if (!p) return;
    const lock = `${id}:${a}`;
    if (pendingReactions.has(lock)) return;
    pendingReactions.add(lock);
    const controls = $$(".actions button")
      .filter((x) => x.dataset.id === id && x.dataset.do === a)
      .map((control) => [control, control.disabled]);
    controls.forEach(([control]) => {
      control.disabled = true;
    });
    try {
      const operation =
        a === "boost"
          ? p.reblogged
            ? "unreblog"
            : "reblog"
          : a === "like"
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
      // Patch every copy of the original, including boosts and open conversations,
      // so moving between views cannot restore stale reaction state.
      const patch = (item) => {
        if (String(item.id) === id) Object.assign(item, updated);
        if (item.reblog && String(item.reblog.id) === id)
          Object.assign(item.reblog, updated);
      };
      for (const item of [...known.values(), ...statuses, ...authorPosts])
        patch(item);
      Object.assign(p, updated);
      $$(`.actions button`)
        .filter((x) => x.dataset.id === id && x.dataset.do === a)
        .forEach((x) => {
          x.setAttribute(
            "aria-pressed",
            String(
              a === "boost"
                ? !!p.reblogged
                : a === "like"
                  ? !!p.favourited
                  : !!p.bookmarked,
            ),
          );
          if (a === "boost")
            x.setAttribute(
              "aria-label",
              p.reblogged ? "Undo boost post" : "Boost post",
            );
          x.innerHTML =
            a === "boost"
              ? ico("boost") + " " + (Number(p.reblogs_count) || 0)
              : a === "like"
                ? ico("heart") + " " + (Number(p.favourites_count) || 0)
                : ico("save");
        });
      notify(
        a === "boost"
          ? p.reblogged
            ? "Boost queued by WordPress for your followers."
            : "Boost removed by WordPress."
          : "Confirmed by WordPress.",
      );
    } finally {
      pendingReactions.delete(lock);
      for (const [control, wasDisabled] of controls)
        if (control.isConnected) control.disabled = wasDisabled;
    }
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
    authorPosts = [];
    authorAccount = null;
    authorCursor = null;
    authorSeq++;
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
  // A read click opens a modal synchronously; its inert backdrop prevents
  // duplicates while keeping the opener available for focus restoration.
  if (b.dataset.do !== "read") b.disabled = true;
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
      ($(".reader-scroll") || $(".dialog-body")).append(el);
    }
    el.textContent = message;
  } else error(message);
}
document.addEventListener("input", (e) => {
  if (["text-size", "reader-size"].includes(e.target.id)) {
    prefs.size = Number(e.target.value);
    theme();
    syncReadingControls();
  }
});
document.addEventListener("change", async (e) => {
  if (["feed-list", "people-list"].includes(e.target.id)) {
    listsUI.select(e.target.value);
    statuses = [];
    following = [];
    cursor = null;
    peopleCursor = null;
    loadSeq++;
    peopleSeq++;
    render();
    try {
      if (session.connection) {
        if (page === "people") await loadPeople();
        else await loadFeed();
      }
    } catch (error) {
      showError(error);
    }
    return;
  }
  if (e.target.name === "accent-color") {
    prefs.accent = e.target.value;
    theme();
    await savePrefs();
  }
  if (e.target.id === "log-auto-refresh") {
    logAutoRefresh = e.target.checked;
    logPolling();
  }
  if (e.target.id === "codes-saved")
    $("[data-do=confirm-codes]").disabled = !e.target.checked;
  if (["font-choice", "reader-font"].includes(e.target.id)) {
    prefs.font = e.target.value;
    theme();
    syncReadingControls();
    await savePrefs();
  }
  if (e.target.id === "reader-theme") {
    prefs.theme = e.target.value;
    theme();
    await savePrefs();
  }
  if (["text-size", "reader-size"].includes(e.target.id)) await savePrefs();
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = e.target.querySelector("[type=submit]");
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    if (await listsUI.submit(e.target)) return;
    if (e.target.id === "log-filter-form") {
      logFilters = {
        level: $("#log-level").value,
        category: $("#log-category").value,
        hours: $("#log-hours").value,
        search: $("#log-search").value.trim(),
      };
      logResult = null;
      await loadLogs();
    }
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
    if (e.target.id === "quick-search-form") {
      query = $("#quick-search").value;
      searchType = "Posts";
      await go("search");
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
        value = $("#reply-text").value,
        seq = modalSeq;
      drafts.set(id, value);
      await api("/wordpress/reply", { id, text: value });
      // A completed send must not close another post opened while it was in
      // flight. Keep any newer text typed after submitting this reply, too.
      if (drafts.get(id) === value) drafts.delete(id);
      if (seq !== modalSeq || !e.target.isConnected) {
        notify("Reply sent through WordPress.");
        return;
      }
      if ($("#reply-text").value === value) $("#reply-text").value = "";
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
startPwa({
  notify,
  hasDraft: () =>
    [...drafts.values()].some((value) => value.trim()) ||
    !!$("#reply-text")?.value.trim() ||
    ($("#modal").open && !$("#modal").classList.contains("reader")) ||
    ["setup", "recovery"].includes(session?.phase),
});
try {
  await refreshSession();
  render();
  if (connectionNotice === "declined")
    notify("WordPress authorization was declined.");
  else if (connectionNotice === "success") notify("WordPress connected.");
  if (session.phase === "full" && session.connection) {
    if (new URLSearchParams(location.hash.slice(1)).has("author"))
      await routeAuthor();
    else await loadFeed();
  }
} catch (e) {
  error(e.message);
}
