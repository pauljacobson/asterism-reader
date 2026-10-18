export function createListsUI({
  api,
  esc,
  author,
  button,
  modal,
  close,
  notify,
  paint,
  navigate,
  changed,
}) {
  const root = "/wordpress/lists";
  let lists = [],
    directory = [],
    detail = null,
    synced = null,
    selected = "",
    csv = "",
    syncing = false,
    progress = 0;
  const get = (s) => document.querySelector(s);
  const overview = async () => {
    const result = await api(root);
    lists = result.lists;
    synced = result.synced;
    if (selected && !lists.some((l) => l.id === selected)) selected = "";
  };
  const load = async () => {
    await overview();
    directory = (await api(root + "/directory")).accounts;
    if (detail && lists.some((l) => l.id === detail.id))
      detail = await api(root + "/" + detail.id);
    else detail = null;
  };
  const options = (value = "") =>
    `<option value="">Choose a followed account</option>${directory.map((a) => `<option value="${esc(a.key)}" ${a.key === value ? "selected" : ""}>${esc(a.account.display_name || a.account.acct || a.key)} · ${esc(a.key)}</option>`).join("")}`;
  const filter = (id) =>
    `<label class="list-filter" for="${id}"><span>List</span><select id="${id}"><option value="">All people</option>${lists.map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? "selected" : ""}>${esc(l.title)}</option>`).join("")}</select></label>`;
  const member = (m) =>
    `<div class="list-member">${m.account ? author(m.account) : `<div class="list-unmatched"><strong>${esc(m.key)}</strong><p class="muted">Not matched to a followed account. The membership is retained.</p></div>`}<div class="list-actions">${!m.account ? button("Match account", "list-resolve", `data-key="${esc(m.key)}"`) : ""}${button("Remove", "list-remove-member", `data-key="${esc(m.key)}"`)}</div></div>`;
  function focusDetail() {
    if (matchMedia("(max-width: 1050px)").matches) {
      get("#list-detail")?.focus({ preventScroll: true });
      get("#list-detail")?.scrollIntoView({ block: "start" });
    }
  }
  function detailView() {
    if (!detail)
      return `<section class="panel"><h2>Your constellations</h2><p>Choose a list to edit its name and members, or import your Mastodon lists to get started.</p></section>`;
    const matched = detail.members.filter((m) => m.account),
      pending = detail.members.filter((m) => !m.account);
    return `<section class="panel"><div class="list-choose">${button("Choose another list", "list-choose")}</div><h2>${esc(detail.title)}</h2><form id="list-rename-form" class="list-inline-form"><label class="sr-only" for="list-title">List name</label><input id="list-title" type="text" required maxlength="80" value="${esc(detail.title)}"><button class="button" type="submit">Rename</button></form><div class="list-actions">${button("Read this list", "list-read", `data-id="${esc(detail.id)}"`)}${button("Delete list", "list-delete", "", "danger")}</div><h3 class="spacer">Add a person</h3><p class="muted">Choose from your most recently refreshed WordPress follows.</p><form id="list-add-form" class="stack spacer"><label class="sr-only" for="list-add-account">Followed account</label><select id="list-add-account" required>${options()}</select><button class="button" type="submit" ${!directory.length ? "disabled" : ""}>Add to list</button></form><h3 class="spacer">Members · ${matched.length}</h3>${matched.map(member).join("") || '<p class="muted spacer">No matched members yet.</p>'}${pending.length ? `<details class="spacer"><summary>Unmatched accounts · ${pending.length}</summary><p class="muted spacer">A handle may have changed, or the account may no longer be followed. Match it explicitly to a current follow, or keep it here for later.</p>${pending.map(member).join("")}</details>` : ""}</section>`;
  }
  function page() {
    return `<div class="page-heading"><div><div class="kicker">Organize your orbit</div><h1>Lists.</h1><p class="subtitle">Your lists are saved to your Asterism account across devices. A person can belong to more than one list.</p></div>${button("Back to feed", "back-feed")}</div><div class="lists-layout"><div><section class="panel" id="list-index"><h2>Your lists</h2><form id="list-create-form" class="list-inline-form"><label class="sr-only" for="new-list-title">New list name</label><input id="new-list-title" type="text" required maxlength="80" placeholder="New list name"><button class="button" type="submit">Create list</button></form><div class="list-picker">${lists.map((l) => `<button class="list-pick" data-do="list-open" data-id="${esc(l.id)}" aria-pressed="${detail?.id === l.id}"><strong>${esc(l.title)}</strong><span>${l.matched} matched${l.pending ? ` · ${l.pending} unmatched` : ""}</span></button>`).join("") || '<p class="muted">No lists yet.</p>'}</div></section><section class="panel"><h2>WordPress follows</h2><p>Refresh all pages of your follows to match imported handles and add people to lists.</p><p class="muted spacer">${synced ? `Last completed refresh: ${esc(new Date(synced).toLocaleString())}` : "Your follows have not been refreshed for lists yet."}</p>${button(syncing ? "Refreshing…" : "Refresh follows", "list-sync", syncing ? "disabled" : "")}<p class="muted" role="status">${syncing ? `${progress} accounts loaded…` : ""}</p></section><section class="panel"><h2>Import Mastodon lists</h2><p>Choose the lists.csv from your export. Preview before importing. Existing lists and memberships are merged; re-importing preserves later edits. Importing never follows anyone.</p><form id="list-import-form" class="stack spacer"><label for="list-import-file">Mastodon lists.csv</label><input id="list-import-file" type="file" accept=".csv,text/csv" required><button class="button" type="submit">Preview import</button></form></section></div><div id="list-detail" tabindex="-1">${detailView()}</div></div>`;
  }
  async function updated() {
    await load();
    await changed();
    paint();
  }
  async function click(b) {
    const action = b.dataset.do,
      id = b.dataset.id;
    if (action === "manage-lists") {
      await navigate("lists");
      return true;
    }
    if (action === "list-open") {
      detail = await api(root + "/" + encodeURIComponent(id));
      paint();
      focusDetail();
      return true;
    }
    if (action === "list-choose") {
      get("#list-index")?.scrollIntoView({ block: "start" });
      get("#new-list-title")?.focus({ preventScroll: true });
      return true;
    }
    if (action === "list-read") {
      selected = id;
      await changed();
      await navigate("feed");
      return true;
    }
    if (action === "list-sync") {
      if (syncing) return true;
      syncing = true;
      progress = 0;
      paint();
      try {
        let run;
        for (let i = 0; i < 200; i++) {
          const result = await api(root + "/sync", run ? { run } : {});
          run = result.run;
          progress = result.count;
          paint();
          if (result.complete) {
            await updated();
            notify(`${result.count} followed accounts refreshed.`);
            break;
          }
          if (i === 199)
            throw Error(
              "The follow refresh reached its 200-page limit. Previous matches were retained.",
            );
        }
      } finally {
        syncing = false;
        await load();
        paint();
      }
      return true;
    }
    if (action === "list-delete") {
      modal(
        "Delete this list?",
        `<p>Delete <strong>${esc(detail.title)}</strong> and its memberships? People will remain followed on WordPress. Re-importing the same export will not recreate this list.</p>${button("Delete list", "list-confirm-delete", `data-id="${esc(detail.id)}"`, "danger")}`,
      );
      return true;
    }
    if (action === "list-confirm-delete") {
      await api(root + "/" + encodeURIComponent(id), {}, "DELETE");
      detail = null;
      await updated();
      close();
      notify("List deleted.");
      return true;
    }
    if (action === "list-remove-member") {
      await api(
        root + "/" + detail.id + "/members",
        { key: b.dataset.key, present: false },
        "PUT",
      );
      await updated();
      return true;
    }
    if (action === "list-resolve") {
      modal(
        "Match an imported account",
        `<p>Choose the current followed account that should replace <strong>${esc(b.dataset.key)}</strong> in this list. Asterism will not guess account migrations.</p><form id="list-resolve-form" data-from="${esc(b.dataset.key)}" data-id="${esc(detail.id)}" class="stack spacer"><label for="list-resolve-account">Current followed account</label><select id="list-resolve-account" required>${options()}</select><button type="submit" class="button primary">Save match</button></form>`,
      );
      return true;
    }
    if (action === "list-confirm-import") {
      const result = await api(root + "/import", { csv });
      csv = "";
      await updated();
      close();
      notify(
        `Imported ${result.created} new lists and ${result.added} memberships. ${result.skipped} previously imported memberships left unchanged.`,
      );
      return true;
    }
    if (action === "person-lists") {
      await load();
      const key = b.dataset.key;
      const { ids } = await api(
        root + "/memberships?" + new URLSearchParams({ key }),
      );
      modal(
        "Choose lists",
        `<p>${esc(key)} can belong to more than one list.</p><form id="person-lists-form" data-key="${esc(key)}" class="stack spacer">${lists.map((l) => `<label><input type="checkbox" name="person-list" value="${esc(l.id)}" ${ids.includes(l.id) ? "checked" : ""} data-original="${ids.includes(l.id)}"> ${esc(l.title)}</label>`).join("") || "<p>Create a list in Lists first.</p>"}<button type="submit" class="button primary">Save list choices</button></form>`,
      );
      return true;
    }
    return false;
  }
  async function submit(form) {
    if (form.id === "list-create-form") {
      const { id } = await api(root, { title: get("#new-list-title").value });
      detail = await api(root + "/" + id);
      await updated();
      focusDetail();
      return true;
    }
    if (form.id === "list-rename-form") {
      await api(
        root + "/" + detail.id,
        { title: get("#list-title").value },
        "PUT",
      );
      await updated();
      return true;
    }
    if (form.id === "list-add-form") {
      await api(
        root + "/" + detail.id + "/members",
        { key: get("#list-add-account").value, present: true },
        "PUT",
      );
      await updated();
      return true;
    }
    if (form.id === "list-resolve-form") {
      await api(root + "/" + form.dataset.id + "/resolve", {
        from: form.dataset.from,
        to: get("#list-resolve-account").value,
      });
      await updated();
      close();
      return true;
    }
    if (form.id === "person-lists-form") {
      for (const input of form.querySelectorAll('[name="person-list"]'))
        if (String(input.checked) !== input.dataset.original)
          await api(
            root + "/" + input.value + "/members",
            { key: form.dataset.key, present: input.checked },
            "PUT",
          );
      await updated();
      close();
      notify("List choices saved.");
      return true;
    }
    if (form.id === "list-import-form") {
      const file = get("#list-import-file").files[0];
      if (!file || file.size > 256_000)
        throw Error("Choose a lists.csv smaller than 256 KB.");
      csv = await file.text();
      const result = await api(root + "/import/preview", { csv });
      modal(
        "Preview Mastodon list import",
        `<p><strong>${result.lists} lists · ${result.memberships} memberships · ${result.accounts} accounts</strong></p><p class="spacer">${result.matched} memberships match your refreshed WordPress follows. ${result.unmatched.length} accounts are unmatched and will be kept for review. ${!synced ? "Refresh follows first for an accurate match summary." : ""}</p><p class="muted spacer">New memberships are merged. Previously imported memberships are left unchanged so that your edits, removals, and renamed or deleted lists stay intact. Empty lists are not represented in a Mastodon membership export.</p>${result.unmatched.length ? `<details class="spacer"><summary>Review unmatched accounts</summary><ul class="import-unmatched">${result.unmatched.map((a) => `<li><strong>${esc(a.key)}</strong><small>${esc(a.lists.join(", "))}</small></li>`).join("")}</ul></details>` : ""}${button("Import lists", "list-confirm-import", "", "primary")}`,
      );
      return true;
    }
    return false;
  }
  return {
    page,
    filter,
    overview,
    load,
    click,
    submit,
    get selected() {
      return selected;
    },
    select(id) {
      selected = lists.some((l) => l.id === id) ? id : "";
    },
  };
}
