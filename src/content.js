// Adds a "Run recan" button next to each .gz recording in the Gradescope file list.
//
// When the page opens, each recording is also analyzed in the background (by recan,
// see offscreen.js). The button turns red when the recording looks worth a closer
// look, and a "?" button beside every recording shows the details (and why, if flagged).
//
// Gradescope draws the file list client-side, so rather than depend on its markup
// we find where each recording's file name appears on the page and put the
// button right after it. Anything we cannot place falls back to a small panel.

const GZ = /\.gz(\?|$)/i;
const MARK = "data-webrecan";
const MIN_ACTIVE_SECONDS = 2 * 60; // keep in sync with flags.js (content scripts can't import modules)

// Easter egg: this fraction of clicks goes somewhere else instead.
const EASTER_EGG_ODDS = 0.01;
const EASTER_EGG_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// ---- reading the page ----

/** { recordings } from the SubmissionGrader props found in `root` (a Document). */
function parsePage(root) {
  // The submission page embeds its files (with presigned S3 URLs) as React props.
  const el = root.querySelector('[data-react-class="SubmissionGrader"]');
  if (!el) return { recordings: [] };
  let props;
  try {
    props = JSON.parse(el.getAttribute("data-react-props"));
  } catch {
    return { recordings: [] };
  }
  return {
    recordings: (props.files || [])
      .filter((f) => GZ.test(f.path || "") && (f.url || f.file?.url))
      // Every student's recording has the same name, so identify files by id, not name.
      .map((f) => ({ id: String(f.id ?? f.uuid ?? f.url ?? f.file.url), url: f.url || f.file.url, name: f.path })),
  };
}

// Gradescope can move between submissions (Next student, etc.) without reloading the
// page. The props in the DOM then still belong to the submission we first loaded, so
// for any other URL we fetch that page and read its props instead.
const loadedPath = location.pathname;
const pagesByPath = new Map(); // pathname -> { recordings }, for pages other than loadedPath

function currentPage() {
  const path = location.pathname;
  const assignmentId = path.match(/\/assignments\/(\d+)/)?.[1] ?? "";
  let parsed;
  if (path === loadedPath) parsed = parsePage(document);
  else {
    if (!pagesByPath.has(path)) {
      pagesByPath.set(path, { recordings: [] }); // until the fetch finishes (or if it fails)
      fetch(location.pathname + location.search, { credentials: "include" })
        .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((html) => {
          pagesByPath.set(path, parsePage(new DOMParser().parseFromString(html, "text/html")));
          render();
        })
        .catch((e) => console.warn("[webrecan] could not load recordings for", path, e));
    }
    parsed = pagesByPath.get(path);
  }
  // The recording names tell us which assignment's starter code to use (see starter.js).
  return { ...parsed, assignmentId, recordingNames: parsed.recordings.map((r) => r.name) };
}

// ---- talking to the extension ----

let page = { recordings: [], assignmentId: "", recordingNames: [] }; // the page last rendered

const analyses = new Map(); // recording id -> { status: "pending" | "done" | "error", evaluation, starter, error }
const starterInfos = new Map(); // assignment id + recording names -> { enabled, folderId, source, folders } | "pending"
const starterKey = () => `${page.assignmentId}|${page.recordingNames.join(",")}`;

const send = (message) =>
  chrome.runtime.sendMessage(message).then((res) => {
    if (!res?.ok) throw new Error(res?.error || "no response from the extension");
    return res;
  });

function requestAnalysis(rec) {
  if (analyses.has(rec.id)) return;
  analyses.set(rec.id, { status: "pending" });
  send({ type: "analyze", url: rec.url, name: rec.name, fileId: rec.id, assignmentId: page.assignmentId, recordingNames: page.recordingNames })
    .then((res) => {
      if (!res.evaluation) throw new Error("the extension returned no analysis");
      analyses.set(rec.id, { status: "done", evaluation: res.evaluation, starter: res.starter });
    })
    .catch((e) => analyses.set(rec.id, { status: "error", error: e.message }))
    .finally(paintAll);
}

function requestStarterInfo() {
  const key = starterKey();
  if (starterInfos.has(key)) return;
  starterInfos.set(key, "pending");
  send({ type: "starter-info", assignmentId: page.assignmentId, recordingNames: page.recordingNames })
    .then((res) => starterInfos.set(key, res.starter))
    .catch(() => starterInfos.set(key, { enabled: false }))
    .finally(paintAll);
}

async function chooseStarterFolder(folderId) {
  await send({ type: "set-starter-folder", assignmentId: page.assignmentId, recordingNames: page.recordingNames, folderId: folderId === "none" ? null : folderId });
  analyses.clear();
  starterInfos.clear();
  render();
}

// ---- the buttons ----

// Everything this script puts on the page. If the page copies its own HTML (page caches,
// innerHTML round trips), the copies of our elements come back with no behavior attached, so
// anything not in this set is stale and gets removed and rebuilt.
const created = new WeakSet();

function openRecording(rec, button) {
  button.disabled = true;
  button.textContent = "Opening…";
  send({ type: "open-recording", url: rec.url, name: rec.name, assignmentId: page.assignmentId, recordingNames: page.recordingNames })
    .then(() => (button.textContent = "Run recan"))
    .catch((e) => (button.textContent = "Failed: " + e.message))
    .finally(() => (button.disabled = false));
}

function makeControl(rec) {
  const ctl = document.createElement("span");
  created.add(ctl);
  ctl.className = "webrecan-ctl";
  ctl.setAttribute(MARK, rec.id);
  ctl.recording = rec;

  const run = document.createElement("button");
  run.type = "button";
  run.className = "webrecan-btn";
  run.textContent = "Run recan";
  run.addEventListener("click", (event) => {
    // The name often sits inside a link or tab; don't also trigger that.
    event.preventDefault();
    event.stopPropagation();
    if (Math.random() < EASTER_EGG_ODDS) {
      window.open(EASTER_EGG_URL, "_blank", "noopener");
      return;
    }
    openRecording(ctl.recording, run);
  });

  const info = document.createElement("button");
  info.type = "button";
  info.className = "webrecan-info";
  info.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePopover(ctl);
  });

  ctl.append(run, info);
  return ctl;
}

/** How should this control look? The ? button is always there; its color says what was found. */
function stateOf(rec) {
  const entry = analyses.get(rec.id);
  if (entry?.status === "error") return { flagged: false, tone: "error" };
  if (entry?.status === "done" && entry.evaluation.flagged) return { flagged: true, tone: "flag" };
  return { flagged: false, tone: "" };
}

function paint(ctl) {
  if (!ctl.recording) return; // a stale copy; render() removes these
  const state = stateOf(ctl.recording);
  const [run, info] = ctl.children;
  // The wrapper's classes set the color (text + border) of both buttons.
  ctl.classList.toggle("is-flagged", state.flagged);
  ctl.classList.toggle("is-error", state.tone === "error");
  run.title = state.flagged ? "This recording was flagged. Click ? to see why." : "";
  info.title = state.flagged ? "Why was this flagged?" : "Details";
  info.setAttribute("aria-label", info.title);
}

function paintAll() {
  for (const ctl of document.querySelectorAll(".webrecan-ctl")) paint(ctl);
  if (!popoverFor) return closePopover();

  // If the page redrew the button the card belongs to, follow it to the new element.
  if (!popoverFor.isConnected) {
    const id = popoverFor.getAttribute(MARK);
    const next = [...document.querySelectorAll(".webrecan-ctl")].find((c) => created.has(c) && c.getAttribute(MARK) === id);
    if (next) {
      popoverFor = next;
      if (pop) pop.dataset.sig = ""; // new anchor: lay the card out again
    } else {
      // The new button isn't there yet (render() puts it back in a moment): keep the card as it
      // is. Only close it if that recording is really gone from this page.
      if (!page.recordings.some((r) => r.id === id)) closePopover();
      return;
    }
  }
  fillPopover(popoverFor);
}

// ---- the explanation popover ----

let pop = null;
let popoverFor = null;

function closePopover() {
  pop?.remove();
  pop = null;
  popoverFor = null;
  snippetView = null;
}

function togglePopover(ctl) {
  if (popoverFor === ctl) return closePopover();
  closePopover();
  popoverFor = ctl;
  pop = document.createElement("div");
  created.add(pop);
  pop.className = "webrecan-pop";
  document.body.appendChild(pop);
  fillPopover(ctl);
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function duration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function row(flagged, label, text, detail, action) {
  const r = el("div", flagged ? "row flag" : "row");
  const head = el("div", "row-head");
  head.append(el("strong", "", label));
  if (action) {
    const button = el("button", "webrecan-show", action.label);
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      action.onClick();
    });
    head.append(button);
  }
  r.append(head, el("span", "", text));
  if (detail) r.append(el("small", "", detail));
  return r;
}

function fillPopover(ctl) {
  if (!pop || !ctl.recording) return;
  const rec = ctl.recording;
  const entry = analyses.get(rec.id);
  const starterInfo = starterInfos.get(starterKey());

  // This runs every time the page changes, which on Gradescope is constantly. Rebuilding the
  // card would wipe out an open dropdown mid-click, so leave it alone unless something changed.
  const signature = JSON.stringify([rec.id, entry, starterInfo]);
  if (pop.dataset.sig === signature) return;
  pop.dataset.sig = signature;
  const listWasOpen = !!pop.querySelector(".picker-list:not([hidden])");
  const listScroll = pop.querySelector(".picker-list")?.scrollTop ?? 0;

  const parts = [el("div", "title", rec.name)];

  if (entry?.status === "error") {
    parts.push(el("div", "row flag", `Couldn't analyze this recording: ${entry.error}`));
  } else if (entry?.status === "done") {
    const e = entry.evaluation;
    parts.push(
      row(
        e.flags.lowActiveTime,
        "Time",
        `${duration(e.activeSeconds)} non-idle of ${duration(e.totalSeconds)} total`,
        e.flags.lowActiveTime
          ? `Under the ${MIN_ACTIVE_SECONDS / 60} minute minimum. Idle (no activity for 5+ seconds, or the editor not focused): ${duration(e.idleSeconds)}.`
          : `Idle (no activity for 5+ seconds, or the editor not focused): ${duration(e.idleSeconds)}.`,
      ),
      row(
        e.flags.unapprovedPastes,
        "Unapproved pastes",
        e.unapproved.count
          ? `${e.unapproved.count} paste${e.unapproved.count === 1 ? "" : "s"} · ${e.unapproved.chars.toLocaleString()} characters`
          : "None",
        undefined,
        e.unapproved.snippets?.length
          ? { label: "Show", onClick: () => (snippetView?.recId === rec.id ? closeSnippet() : showSnippet(ctl)) }
          : undefined,
      ),
    );
    if (starterInfo && starterInfo !== "pending" && starterInfo.enabled) {
      if (e.starter === true) parts.push(row(false, "Starter code", "Matches"));
      else if (e.starter === false) parts.push(row(true, "Starter code", "Does not match"));
      else if (starterInfo.folderId) parts.push(row(false, "Starter code", "Not checked", "This folder does not contain starter code for this recording."));
      else if (starterInfo.source === "none") parts.push(row(false, "Starter code", "Not checked", "Starter code checking is turned off for this assignment."));
      else parts.push(row(false, "Starter code", "Not checked", "Choose the assignment below to check it."));
    }
  } else {
    parts.push(el("div", "row", "Analyzing…"));
  }

  if (starterInfo && starterInfo !== "pending" && starterInfo.enabled) parts.push(starterPicker(starterInfo));

  pop.replaceChildren(...parts);
  positionPopover(ctl);

  if (listWasOpen) {
    // The content changed while the dropdown was open: keep it open, where it was.
    const list = pop.querySelector(".picker-list");
    if (list) {
      list.hidden = false;
      pop.querySelector(".picker-toggle").setAttribute("aria-expanded", "true");
      placeList(list);
      list.scrollTop = listScroll;
    }
  }
  renderSnippetCard(); // the viewer is a child of the card, so it was just removed; put it back
}

/**
 * A dropdown that shows about ten assignments and scrolls for the rest. (A native <select>
 * can't limit how tall its list is, so this is a button plus a scrolling list.)
 */
function starterPicker(info) {
  const wrap = el("div", "picker");
  wrap.append(el("label", "", "Assignment for starter code"));

  const options = [{ value: "none", text: "Don't check starter code" }, ...info.folders.map((f) => ({ value: f.id, text: f.label }))];
  const current = info.source === "none" ? "none" : info.folderId || "";
  const toggle = el("button", "picker-toggle", options.find((o) => o.value === current)?.text ?? "Choose…");
  toggle.type = "button";
  toggle.setAttribute("aria-haspopup", "listbox");
  toggle.setAttribute("aria-expanded", "false"); // the CSS arrow points up while this is "true"

  const list = el("ul", "picker-list");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  for (const option of options) {
    const item = el("li", option.value === current ? "selected" : "", option.text);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.value === current));
    item.addEventListener("click", () => {
      closeList();
      if (option.value !== current) chooseStarterFolder(option.value);
    });
    list.append(item);
  }

  toggle.addEventListener("click", () => {
    if (!list.hidden) return closeList();
    closeSnippet();
    list.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    placeList(list);
    list.querySelector(".selected")?.scrollIntoView({ block: "center" }); // show the neighbors too
  });
  wrap.append(toggle, list);
  return wrap;
}

/** Close the dropdown card (if open) and point its arrow back down. */
function closeList() {
  const list = pop?.querySelector(".picker-list");
  if (list) list.hidden = true;
  pop?.querySelector(".picker-toggle")?.setAttribute("aria-expanded", "false");
}

const LIST_WIDTH = 240;
const MIN_LIST_WIDTH = 160;
const SNIPPET_WIDTH = 640;
const MIN_SNIPPET_WIDTH = 260;
const SNIPPET_MAX_HEIGHT = 560;
const GAP = 8;
let popSide = "right"; // which side of the "?" button the cards open on

/**
 * The info card opens beside the "?" button (never over it), level with it, on whichever side
 * has room for the card plus the dropdown card that can open next to it.
 */
/** How wide the viewer can be: its full width, or less if the window is narrow. */
const viewerWidth = (cardWidth) => Math.max(MIN_SNIPPET_WIDTH, Math.min(SNIPPET_WIDTH, window.innerWidth - cardWidth - 3 * GAP));

function positionPopover(ctl) {
  const anchor = ctl.querySelector(".webrecan-info").getBoundingClientRect();
  const width = pop.offsetWidth;
  const need = width + GAP + MIN_SNIPPET_WIDTH + GAP;
  const roomRight = window.innerWidth - anchor.right - GAP;
  const roomLeft = anchor.left - GAP;
  // The right is preferred: the pasted-code viewer opens to the right of this card. Go left only when
  // the right has no room even for a narrow viewer and the left does.
  popSide = roomRight >= need ? "right" : roomLeft >= need ? "left" : roomRight >= roomLeft ? "right" : "left";
  let left = popSide === "right" ? anchor.right + GAP : anchor.left - GAP - width;
  if (snippetView) {
    // The viewer opens beside this card and needs its full width, so move this card over to make room
    // (it may end up over the button and the file list; it goes back when the viewer closes).
    const room = viewerWidth(width) + GAP;
    left = popSide === "right" ? Math.min(left, window.innerWidth - GAP - room - width) : Math.max(left, GAP + room);
  }
  pop.style.left = `${Math.max(GAP, Math.min(left, window.innerWidth - width - GAP))}px`;
  // Level with the button, pulled up only if it would run off the bottom of the screen. Beside the
  // button, so it doesn't cover it, unless the viewer is open and has pushed it over.
  pop.style.top = `${Math.max(GAP, Math.min(anchor.top, window.innerHeight - pop.offsetHeight - GAP))}px`;
}

/**
 * A card beside the info card (the dropdown, or the pasted-code viewer): the same top and
 * height, on its far side. It is up to maxWidth wide but narrows to fit the room there is.
 */
function placeSideCard(card, maxWidth, minWidth, tall = false) {
  const box = pop.getBoundingClientRect();
  const room = popSide === "right" ? window.innerWidth - box.right - 2 * GAP : box.left - 2 * GAP;
  const width = Math.max(minWidth, Math.min(maxWidth, room));
  const left = popSide === "right" ? box.right + GAP : box.left - GAP - width;
  card.style.width = `${width}px`;
  card.style.left = `${Math.max(GAP, Math.min(left, window.innerWidth - width - GAP))}px`;
  card.style.top = `${box.top}px`;
  // Same height as the info card; a tall card (the file viewer) may grow downward to show more.
  const height = tall ? Math.max(box.height, Math.min(SNIPPET_MAX_HEIGHT, window.innerHeight - box.top - GAP)) : box.height;
  card.style.height = `${height}px`;
}

const placeList = (list) => placeSideCard(list, LIST_WIDTH, MIN_LIST_WIDTH);

// ---- the pasted-code viewer ----
//
// "Show" on the unapproved pastes row opens a card beside the info card with the pasted text.
// With more than one paste there are arrows to step through them (or the Left/Right keys).

let snippetView = null; // { recId, index } while the viewer is open

function showSnippet(ctl) {
  closeList(); // the dropdown and the viewer share the space beside the card
  snippetView = { recId: ctl.recording.id, index: 0 };
  positionPopover(ctl); // make room: the card moves over, then the viewer is placed beside it
  renderSnippetCard();
}

function closeSnippet() {
  const wasOpen = snippetView !== null;
  snippetView = null;
  pop?.querySelector(".webrecan-snip")?.remove();
  if (wasOpen && popoverFor?.isConnected) positionPopover(popoverFor); // back beside the ? button
}

function stepSnippet(delta) {
  if (!snippetView) return;
  snippetView.index += delta;
  renderSnippetCard();
}

function renderSnippetCard() {
  pop?.querySelector(".webrecan-snip")?.remove();
  if (!pop || !snippetView) return;
  const rec = popoverFor?.recording;
  const snippets = (rec && analyses.get(rec.id)?.evaluation?.unapproved?.snippets) || [];
  if (!rec || rec.id !== snippetView.recId || !snippets.length) {
    snippetView = null;
    return;
  }
  const index = (snippetView.index = Math.max(0, Math.min(snippetView.index, snippets.length - 1)));
  const snippet = snippets[index];

  const button = (text, label, onClick, disabled = false) => {
    const b = el("button", "snip-btn", text);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.disabled = disabled;
    b.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    return b;
  };

  const head = el("div", "snip-head");
  head.append(el("strong", "", snippets.length > 1 ? `Paste ${index + 1} of ${snippets.length}` : "Pasted code"));
  const nav = el("div", "snip-nav");
  if (snippets.length > 1) {
    nav.append(
      button("‹", "Previous paste", () => stepSnippet(-1), index === 0),
      button("›", "Next paste", () => stepSnippet(1), index === snippets.length - 1),
    );
  }
  nav.append(button("✕", "Close", closeSnippet));
  head.append(nav);

  const { view, firstHighlight } = codeView(snippet);
  const parts = [head, view];
  // Notes only when something is unusual: the file couldn't be rebuilt, or the paste was cut off.
  if (!snippet.file) parts.push(el("div", "snip-note", "The rest of the file can't be rebuilt from this recording, so only the pasted code is shown."));
  if (snippet.truncated && !snippet.file) {
    parts.push(el("div", "snip-note", `Showing the first ${snippet.text.length.toLocaleString()} of ${snippet.chars.toLocaleString()} characters.`));
  }

  const card = el("div", "webrecan-snip");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Pasted code in the file");
  card.append(...parts);
  pop.append(card);
  placeSideCard(card, SNIPPET_WIDTH, MIN_SNIPPET_WIDTH, true);
  // Bring the highlighted paste into view, with a little of the code above it for context.
  if (firstHighlight) view.scrollTop = Math.max(0, firstHighlight.offsetTop - view.clientHeight / 4);
}

/**
 * The code area: the whole file (or just the pasted text, if the file couldn't be rebuilt) with
 * line numbers, and the pasted range highlighted. Everything is set as text, never as HTML.
 */
function codeView(snippet) {
  const file = snippet.file;
  const text = file ? file.text : snippet.text;
  const [start, end] = file ? [file.start, file.end] : [0, 0]; // nothing to highlight when only the paste is shown
  const firstLine = file ? file.firstLine : 1;

  const view = el("div", "snip-code");
  let firstHighlight = null;
  let lineStart = 0;
  text.split("\n").forEach((line, i) => {
    const lineEnd = lineStart + line.length;
    const row = el("div", "snip-line");
    const code = el("span", "snip-text");
    // Any line the paste touches gets the normal highlight (a partly pasted line isn't singled out).
    const touched = Math.max(start, lineStart) < Math.min(end, lineEnd) || (!line.length && start <= lineStart && end > lineStart);
    if (touched) {
      row.classList.add("hl");
      firstHighlight ??= row;
    }
    code.textContent = line;
    row.append(el("span", "snip-num", String(firstLine + i)), code);
    view.append(row);
    lineStart = lineEnd + 1;
  });
  return { view, firstHighlight };
}

document.addEventListener(
  "click",
  (event) => {
    if (pop?.querySelector(".picker-list:not([hidden])") && !event.target.closest?.(".picker-list, .picker-toggle")) closeList();
    if (pop && !event.target.closest?.(".webrecan-pop, .webrecan-info")) closePopover();
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") return snippetView ? closeSnippet() : closePopover();
  const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
  if (snippetView && !typing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    stepSnippet(event.key === "ArrowRight" ? 1 : -1);
  }
});

// ---- placing the buttons ----

/** Elements whose own text is exactly this file name (full path or basename). */
function findNameElements(rec) {
  const names = new Set([rec.name, rec.name.split("/").pop()]);
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !names.has(node.nodeValue.trim())) continue;
    if (parent.closest(`[${MARK}], #webrecan-panel, .webrecan-pop, script, style, textarea`)) continue;
    found.push(parent);
  }
  return found;
}

/** Make sure the control after `anchor` is for `rec`, replacing a stale one. */
function ensureControl(anchor, rec) {
  const next = anchor.nextElementSibling;
  if (next?.classList.contains("webrecan-ctl")) {
    if (next.getAttribute(MARK) === rec.id) return;
    next.remove(); // left over from another submission
  }
  anchor.insertAdjacentElement("afterend", makeControl(rec));
}

let panel;
function renderFallback(unplaced) {
  if (!unplaced.length) {
    panel?.remove();
    panel = null;
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    created.add(panel);
    panel.id = "webrecan-panel";
    document.body.appendChild(panel);
  }
  const key = unplaced.map((r) => r.id).join("|");
  if (panel.dataset.key === key) return;
  panel.dataset.key = key;
  panel.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = `Recan recordings (v${chrome.runtime.getManifest().version})`;
  panel.appendChild(title);
  for (const rec of unplaced) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = rec.name;
    row.append(label, makeControl(rec));
    panel.appendChild(row);
  }
}

// If a recording's file name can't be found on the page, we only fall back to the corner panel
// when NONE of them can (so the page isn't laid out as we expect), and only after giving the page
// a moment to draw its file list. A recording that is in the page data but not in the visible
// file list (e.g. left over from another assignment) is simply skipped.
const FALLBACK_AFTER_MS = 3000;
let seenPath = "";
let seenAt = Date.now();

function render() {
  // Remove lifeless copies of our elements (see `created`); live ones are re-added below.
  for (const node of document.querySelectorAll(".webrecan-ctl, .webrecan-pop, #webrecan-panel")) {
    if (!created.has(node)) node.remove();
  }
  page = currentPage();
  const recordings = page.recordings;
  if (location.pathname !== seenPath) [seenPath, seenAt] = [location.pathname, Date.now()];

  // Drop controls for files that are no longer on this submission.
  const current = new Set(recordings.map((r) => r.id));
  for (const ctl of document.querySelectorAll(".webrecan-ctl")) {
    if (!current.has(ctl.getAttribute(MARK))) ctl.remove();
  }

  if (recordings.length) requestStarterInfo();

  const placed = [];
  const unplaced = [];
  for (const rec of recordings) {
    const anchors = findNameElements(rec);
    if (!anchors.length) {
      unplaced.push(rec);
      continue;
    }
    placed.push(rec);
    for (const node of anchors) {
      // Insert after the enclosing link/tab so a click doesn't nest inside it.
      ensureControl(node.closest("a, button, [role=tab]") || node, rec);
    }
  }

  let fallback = [];
  if (!placed.length && unplaced.length) {
    if (Date.now() - seenAt >= FALLBACK_AFTER_MS) fallback = unplaced;
    else setTimeout(render, FALLBACK_AFTER_MS - (Date.now() - seenAt) + 50); // check again once the page has had time
  }

  // Only analyze recordings that are shown (inline, or in the fallback panel).
  for (const rec of [...placed, ...fallback]) requestAnalysis(rec);
  renderFallback(fallback);
  paintAll();
}

// React redraws the list, which can drop our buttons, so re-check after changes
// (ignoring changes we made ourselves).
const ours = ".webrecan-ctl, .webrecan-pop, #webrecan-panel";
let timer;
new MutationObserver((mutations) => {
  const foreign = mutations.some((m) => !(m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest(ours));
  if (!foreign) return;
  clearTimeout(timer);
  timer = setTimeout(render, 150);
}).observe(document.body, { childList: true, subtree: true, characterData: true });
render();
