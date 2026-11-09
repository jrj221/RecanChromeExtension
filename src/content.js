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
const PY = /\.py$/i;

// Hidden files (test files, ...): which ones is set in the toolbar popup; see src/settings.js. They are hidden from the
// file view and ignored by the flag and quality checks. (Whether code quality skips the names itself is up to this
// side: the checker is called without its own list, so un-hiding a file also gets it checked.)
let settings = { ...WEBRECAN_DEFAULTS };
let settingsLoaded = false;
const isTestFile = (path) => webrecanIgnored(settings, path);
const MARK = "data-webrecan";
// Everything this extension adds to the page; its own text and elements must never be read as the page's.
const OUR_ELEMENTS = ".webrecan-ctl, .webrecan-pop, .webrecan-banner, .webrecan-lockbar, .webrecan-dialog, .webrecan-autograder, #webrecan-panel";
// ---- per-assignment limits ----
//
// EDIT THE LIMITS HERE. Each table is keyed by the assignment's title exactly as Gradescope shows it (case
// doesn't matter), e.g.  "Homework 4b": 10,   Anything not listed uses the default above its table.

// Minimum non-idle time, in minutes: a recording under it is flagged.
const DEFAULT_MIN_ACTIVE_MINUTES = 2;
const MIN_ACTIVE_MINUTES = {
  "Homework 4c - Program Arguments": 0.5, // 30 seconds
  // "Homework 4b": 10,
  // "Lab 4a - Strings": 5,
};

// Fewest functions the submission's .py files may define together (decomposition): fewer is flagged in the code quality box.
const DEFAULT_MIN_FUNCTIONS = 2;
const MIN_FUNCTIONS = {
  // "Homework 4b": 3,
  // "Lab 1 - Hello": 1,
};

/** The assignment's own title(s): page.assignmentTitle is several names joined with " | ". */
const titleParts = (title) => String(title || "").split("|").map((t) => t.trim().toLowerCase()).filter(Boolean);

/** The value in `table` for the assignment with this title, or `fallback`. */
function limitFor(table, title, fallback) {
  const parts = titleParts(title);
  for (const [name, value] of Object.entries(table)) {
    if (parts.includes(name.trim().toLowerCase())) return value;
  }
  return fallback;
}

/** The minimum non-idle seconds for the assignment with this title. */
const minActiveSeconds = (title) => limitFor(MIN_ACTIVE_MINUTES, title, DEFAULT_MIN_ACTIVE_MINUTES) * 60;
const minFunctions = (title) => limitFor(MIN_FUNCTIONS, title, DEFAULT_MIN_FUNCTIONS);

const lowActive = (e) => e.activeSeconds < minActiveSeconds(page.assignmentTitle);
// The recording's flags with the time check judged against this assignment's minimum.
const isFlagged = (e) => lowActive(e) || e.flags.unapprovedPastes || e.flags.starterMismatch;
// ---- end per-assignment limits ----
// Progress checks are meant to be short: a total recording time (idle included) over this is flagged.
const MAX_PROGRESS_CHECK_SECONDS = 2 * 60 * 60;
const isProgressCheck = (title) => /progress\s*check/i.test(title || "");
const tooLong = (e) => isProgressCheck(page.assignmentTitle) && e.totalSeconds > MAX_PROGRESS_CHECK_SECONDS;

// Easter egg: this fraction of clicks goes somewhere else instead.
const EASTER_EGG_ODDS = 0.01;
const EASTER_EGG_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

// ---- reading the page ----

/**
 * Where the submission's files are in the page data. The grading page embeds them as the props of the
 * SubmissionGrader component (`files`); other pages that show the same files (such as the assignment's
 * submission page, ?view=files) use other components, so every embedded props blob is searched for a
 * list of files (objects with a `path` and a download `url`), SubmissionGrader first.
 */
function findSubmissionData(root) {
  const nodes = [root.querySelector('[data-react-class="SubmissionGrader"]'), ...root.querySelectorAll("[data-react-props]")];
  for (const node of new Set(nodes.filter(Boolean))) {
    let props;
    try {
      props = JSON.parse(node.getAttribute("data-react-props"));
    } catch {
      continue;
    }
    const files = Array.isArray(props?.files) && props.files.some(isFileLike) ? props.files : findFileList(props);
    if (files) return { props, files };
  }
  return null;
}

const isFileLike = (f) => f && typeof f === "object" && typeof f.path === "string" && !!(f.url || f.file?.url);

function findFileList(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (Array.isArray(node) && node.some(isFileLike)) return node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findFileList(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The embedded props that carry the assignment (its title), whichever component they belong to. */
function assignmentProps(root) {
  for (const node of root.querySelectorAll("[data-react-props]")) {
    const raw = node.getAttribute("data-react-props") || "";
    if (!raw.includes('"assignment"')) continue; // cheap check before parsing a big blob
    try {
      const props = JSON.parse(raw);
      if (props?.assignment) return props;
    } catch {
      // not JSON; ignore
    }
  }
  return null;
}

/**
 * The files drawn on the page as download links to Gradescope's storage, for pages whose data has no file
 * list (the assignment's submission page keeps the files out of its props; they are only in the links).
 */
function filesFromLinks(root) {
  const seen = new Set();
  const files = [];
  for (const link of root.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (!/amazonaws\.com\//.test(href)) continue;
    let path;
    try {
      path = decodeURIComponent(new URL(href, "https://www.gradescope.com").pathname.split("/").pop());
    } catch {
      continue;
    }
    const id = href.match(/\/file\/(\d+)\//)?.[1] ?? href;
    if (!path || seen.has(id)) continue;
    seen.add(id);
    files.push({ id, url: href, path });
  }
  return files;
}

/** All the submitted files. (Which are recordings and sources depends on the settings; see currentPage.) */
function parsePage(root) {
  const data = findSubmissionData(root);
  const props = data?.props ?? assignmentProps(root);
  // The assignment's name (falling back to the page title, which carries it too).
  const assignmentTitle = [props?.assignment?.title, props?.assignment?.name, props?.assignment_title, root.title].filter(Boolean).join(" | ");
  let files = data ? data.files.filter(isFileLike) : [];
  if (!files.length) files = filesFromLinks(root);
  // Every student's recording has the same name, so identify files by id, not name.
  const describe = (f) => ({ id: String(f.id ?? f.uuid ?? f.url ?? f.file.url), url: f.url || f.file.url, name: f.path });
  return {
    assignmentTitle,
    previousFlag: previousSubmissionsFlag(root),
    owner: findOwner(root),
    files: files.map(describe),
  };
}

// Gradescope can move between submissions (Next student, etc.) without reloading the
// page. The props in the DOM then still belong to the submission we first loaded, so
// for any other URL we fetch that page and read its props instead.
const loadedPath = location.pathname;
const pagesByPath = new Map(); // pathname -> the parsed page, for pages other than loadedPath

function currentPage() {
  const path = location.pathname;
  const assignmentId = path.match(/\/assignments\/(\d+)/)?.[1] ?? "";
  let parsed;
  if (path === loadedPath) parsed = parsePage(document);
  else {
    if (!pagesByPath.has(path)) {
      pagesByPath.set(path, { files: [] }); // until the fetch finishes (or if it fails)
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
  // Hidden files are neither analyzed nor checked. Worked out here, not when the page is parsed, so a change in
  // the settings applies to pages already read.
  const recordings = parsed.files.filter((f) => GZ.test(f.name || "") && !isTestFile(f.name));
  const sources = parsed.files.filter((f) => PY.test(f.name || "") && !isTestFile(f.name));
  // The recording names tell us which assignment's starter code to use (see starter.js).
  return { ...parsed, recordings, sources, assignmentId, recordingNames: recordings.map((r) => r.name) };
}

// ---- talking to the extension ----

let page = { files: [], recordings: [], sources: [], assignmentId: "", assignmentTitle: "", recordingNames: [] }; // the page last rendered

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
  send({
    type: "analyze",
    url: rec.url,
    name: rec.name,
    fileId: rec.id,
    // All the recordings of this submission: they're analyzed together so a paste of code that came from another file counts as internal.
    siblings: page.recordings.map((r) => ({ fileId: r.id, url: r.url, name: r.name })),
    assignmentId: page.assignmentId,
    recordingNames: page.recordingNames,
  })
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

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---- code quality banner ----
//
// A small box at the top of the page: green when every .py file in the submission passes the
// checks in checker/quality.py, a warning block otherwise. Clicking the warning shows each check
// and which files failed it (not why; run checker/quality.py for the details). This is separate
// from recan.

let quality = { key: "", status: "none" }; // status: "none" | "pending" | "done" | "error"
let banner = null;
let previousFlag = null; // text from the autograder's Previous Submission(s) test, shown in the box, or null

const prefetched = new Set();
/** Start downloading recordings right away (while the page draws its file list); analysis uses them later. */
function prefetchRecordings(recordings) {
  const urls = recordings.map((r) => r.url).filter((url) => !prefetched.has(url));
  if (!urls.length) return;
  urls.forEach((url) => prefetched.add(url));
  send({ type: "prefetch", urls }).catch(() => {});
}

function requestQuality(sources) {
  const min = minFunctions(page.assignmentTitle);
  const key = sources.map((s) => s.id).join(",") + `|${min}`;
  if (key === quality.key) return;
  quality = { key, status: sources.length ? "pending" : "none" };
  if (!sources.length) return;
  send({ type: "quality", files: sources.map(({ id, url, name }) => ({ id, url, name })), minFunctions: min })
    .then((res) => key === quality.key && (quality = { key, status: "done", checks: res.checks }))
    .catch((e) => key === quality.key && (quality = { key, status: "error", error: e.message }))
    .finally(paintBanner);
}

function paintBanner() {
  paintBannerBox();
  paintLockButton();
}

function paintBannerBox() {
  if (quality.status === "none" && !previousFlag) {
    banner?.remove();
    banner = null;
    return;
  }
  if (!banner) {
    banner = document.createElement("details");
    created.add(banner);
    banner.className = "webrecan-banner";
  }
  // Sit above the first file so it scrolls with the files, not the page.
  const spot = bannerSpot() ?? autograderSpot();
  if (spot) {
    banner.classList.remove("is-floating");
    if (banner.parentNode !== spot.parent || banner.nextSibling !== spot.before) spot.parent.insertBefore(banner, spot.before);
  } else {
    // No file view to sit above (some pages draw the files differently). Float over the page instead of adding
    // a row to the layout: a full-height page has no room for one and would push its bottom bar off screen.
    banner.classList.add("is-floating");
    if (banner.parentNode !== document.body) document.body.append(banner);
  }
  const signature = JSON.stringify([quality, previousFlag]);
  if (banner.dataset.sig === signature) return; // nothing changed; don't touch the DOM
  banner.dataset.sig = signature;
  fillBanner();
}

/** Where the banner goes: just above the first file shown in the file viewer, else the top of the file pane. */
const FILE_VIEW = '[class*="FileViewer" i], [class*="CodeViewer" i], [class*="code-viewer" i], .submissionFileViewer, pre';

/** Is this inside the autograder's output (which has its own <pre>), not the student's files? */
function inAutograderOutput(node) {
  let ancestor = node.parentElement;
  for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
    if (/autograder\s+(output|results)/i.test((ancestor.textContent || "").slice(0, 400))) return true;
  }
  return false;
}

/**
 * Just below the "Autograder Results" card, for pages with no file view to sit above. The card is found from its
 * heading's text: it's the nearest ancestor of the heading drawn with a border (the bordered box in the page).
 */
function autograderSpot() {
  const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, button, summary, a, span, div")].find(
    (node) => !node.closest(".webrecan-banner, .webrecan-ctl, .webrecan-pop, #webrecan-panel") && /^\s*autograder results\s*$/i.test(node.textContent || "") && !node.querySelector("h1, h2, h3, h4, h5, h6"),
  );
  if (!heading) return null;
  const bordered = (node) => {
    const style = getComputedStyle(node);
    return style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0;
  };
  let card = null;
  let node = heading;
  for (let depth = 0; node && node !== document.body && depth < 10; depth++, node = node.parentElement) {
    if (bordered(node)) {
      card = node;
      break;
    }
  }
  card ??= heading; // no bordered box found: just below the heading itself
  if (!card.parentElement) return null;
  const next = card.nextSibling;
  return { parent: card.parentElement, before: next === banner ? banner.nextSibling : next }; // (already there: stay put)
}

function bannerSpot() {
  const first = [...document.querySelectorAll(FILE_VIEW)].find(
    (node) => !node.closest(".webrecan-ctl, .webrecan-pop, .webrecan-banner, #webrecan-panel, [data-webrecan-test-file]") && (node.tagName !== "PRE" || !inAutograderOutput(node)),
  );
  if (first?.parentNode) return { parent: first.parentNode, before: first };
  const anchor = document.querySelector(".webrecan-ctl");
  for (let node = anchor?.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return { parent: node, before: node.firstChild };
  }
  return null;
}

/** Scrolling one of the two boxes (either way) scrolls the other by the same amount. */
function syncScroll(a, b) {
  for (const [from, to] of [[a, b], [b, a]]) {
    from.addEventListener("scroll", () => {
      if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop;
      if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
    });
  }
}

/** The file's section in Gradescope's file list, matched by its name (or just the last part of its path). */
function fileSection(name) {
  const sections = [...document.querySelectorAll("section.fileViewer")];
  const base = (n) => String(n).split("/").pop();
  return sections.find((s) => fileViewerName(s) === name) ?? sections.find((s) => base(fileViewerName(s)) === base(name)) ?? null;
}

/** Open the file (if it's collapsed) and scroll it into view. */
function showFile(name) {
  const section = fileSection(name);
  if (!section) return;
  const toggle = section.querySelector(".fileViewerHeader--toggleButton");
  if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
  const scroll = () => section.scrollIntoView({ behavior: "smooth", block: "start" });
  scroll();
  setTimeout(scroll, 250); // once the file's lines have been drawn and the page has settled
}

/** A file name in the banner; clicking it jumps to that file on the page. */
function fileLink(name) {
  const link = el("button", "file-link", name);
  link.type = "button";
  link.title = "Show this file";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showFile(name);
  });
  return link;
}

function fillBanner() {
  const summary = el("summary");
  const body = el("div", "body");
  banner.classList.remove("is-ok", "is-bad", "is-pending");
  banner.open = false;

  // The checker decides which checks failed (it counts across all the files) and names them.
  const failedChecks = quality.status === "done" ? quality.checks.filter((check) => check.failed) : [];

  // Earlier submissions come first, in bold, so it can't be missed.
  if (previousFlag) {
    const row = el("div", "check fail previous");
    row.append(el("span", "mark", "⚠"), el("strong", "label", previousFlag[0].toUpperCase() + previousFlag.slice(1)));
    body.append(row);
  }
  for (const check of failedChecks) {
    const row = el("div", "check fail");
    const names = el("span", "files");
    check.files.forEach((file, i) => {
      if (i) names.append(", ");
      names.append(fileLink(file));
    });
    row.append(el("span", "mark", "✗"), el("span", "label", check.label), names);
    body.append(row);
    // Duplicated code: a dropdown per repeated snippet.
    for (const item of check.items || []) {
      const dup = el("details", "dup");
      const copies = el("div", "copies"); // the two copies, side by side
      const left = el("pre", "", item.snippet);
      const right = el("pre", "", item.other);
      copies.append(left, right);
      dup.append(el("summary", "", `${item.file}: ${item.where}`), copies);
      syncScroll(left, right);
      body.append(dup);
    }
  }

  if (previousFlag || failedChecks.length) {
    const parts = [];
    if (previousFlag) parts.push("Previous submission(s)");
    if (failedChecks.length) parts.push("Code quality: some checks failed");
    else if (quality.status === "pending") parts.push("checking code quality…");
    banner.classList.add("is-bad");
    summary.textContent = "⚠ " + parts.join(" · ");
    banner.open = true; // problems are shown right away
  } else if (quality.status === "pending") {
    banner.classList.add("is-pending");
    summary.textContent = "Checking code quality…";
  } else if (quality.status === "error") {
    banner.classList.add("is-pending");
    summary.textContent = `Couldn't check code quality: ${quality.error}`;
  } else {
    banner.classList.add("is-ok");
    summary.textContent = "✓ Code quality: all checks passed";
  }

  // Nothing to show (everything passed, or still working): the box can't be opened.
  if (!body.children.length) {
    banner.open = false;
    summary.addEventListener("click", (event) => event.preventDefault());
  }
  banner.replaceChildren(summary, body);
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
  if (entry?.status === "done" && (isFlagged(entry.evaluation) || tooLong(entry.evaluation))) return { flagged: true, tone: "flag" };
  return { flagged: false, tone: "" };
}

function paint(ctl) {
  if (!ctl.recording) return; // a stale copy; render() removes these
  ctl.dataset.state = analyses.get(ctl.recording.id)?.status ?? "pending"; // pending | done | error
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
  snippetAuto = null;
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

  // The pasted-code viewer is open by default: as soon as this card has the analysis and there is at
  // least one unapproved paste. Only once per card, so hiding it stays hidden when the card is rebuilt.
  if (entry?.status === "done" && entry.evaluation.unapproved?.snippets?.length && snippetAuto !== rec.id && !listWasOpen) {
    snippetAuto = rec.id;
    snippetView = { recId: rec.id, index: 0 };
  }

  // The heading: the file name, and an X that closes this card and the viewer together.
  const close = el("button", "pop-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", (event) => {
    event.preventDefault();
    closePopover();
  });
  const heading = el("div", "title");
  heading.append(el("span", "", rec.name), close);
  const parts = [heading];

  if (entry?.status === "error") {
    parts.push(el("div", "row flag", `Couldn't analyze this recording: ${entry.error}`));
  } else if (entry?.status === "done") {
    const e = entry.evaluation;
    parts.push(
      row(
        lowActive(e),
        "Time",
        `${duration(e.activeSeconds)} non-idle of ${duration(e.totalSeconds)} total`,
        lowActive(e)
          ? `Under the ${minActiveSeconds(page.assignmentTitle) / 60} minute minimum. Idle (no activity for 5+ seconds, or the editor not focused): ${duration(e.idleSeconds)}.`
          : `Idle (no activity for 5+ seconds, or the editor not focused): ${duration(e.idleSeconds)}.`,
      ),
      ...(isProgressCheck(page.assignmentTitle)
        ? [
            row(
              tooLong(e),
              "Progress check time",
              `${duration(e.totalSeconds)} total (idle included)`,
              tooLong(e) ? `Over the ${MAX_PROGRESS_CHECK_SECONDS / 3600} hour limit for progress checks.` : undefined,
            ),
          ]
        : []),
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
  syncShowButton();
}

/** The button on the unapproved pastes row says Hide while the viewer is open, Show otherwise. */
function syncShowButton() {
  const button = pop?.querySelector(".webrecan-show");
  if (!button) return;
  const open = snippetView !== null && snippetView.recId === popoverFor?.recording?.id;
  button.textContent = open ? "Hide" : "Show";
  button.setAttribute("aria-expanded", String(open));
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
let snippetAuto = null; // the recording the viewer was last opened for BY DEFAULT in this card (so hiding it sticks)

function showSnippet(ctl) {
  closeList(); // the dropdown and the viewer share the space beside the card
  snippetView = { recId: ctl.recording.id, index: 0 };
  positionPopover(ctl); // make room: the card moves over, then the viewer is placed beside it
  renderSnippetCard();
  syncShowButton();
}

function closeSnippet() {
  const wasOpen = snippetView !== null;
  snippetView = null;
  pop?.querySelector(".webrecan-snip")?.remove();
  if (wasOpen && popoverFor?.isConnected) positionPopover(popoverFor); // back beside the ? button
  syncShowButton();
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
    // A line the paste covers (all of its code, ignoring leading indentation) is highlighted whole.
    // A line it only partly covers highlights just the pasted characters.
    const from = Math.max(start, lineStart);
    const to = Math.min(end, lineEnd);
    const indent = line.length - line.trimStart().length;
    const empty = !line.length && start <= lineStart && end > lineStart;
    const whole = empty || (from < to && from <= lineStart + indent && to >= lineEnd);
    if (whole) {
      row.classList.add("hl");
      firstHighlight ??= row;
      code.textContent = line;
    } else if (from < to) {
      row.classList.add("part");
      firstHighlight ??= row;
      code.append(
        document.createTextNode(line.slice(0, from - lineStart)),
        el("mark", "", line.slice(from - lineStart, to - lineStart)),
        document.createTextNode(line.slice(to - lineStart)),
      );
    } else {
      code.textContent = line;
    }
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

// ---- lock resubmission ----
//
// Two buttons under the total points (on the grade page).
//   Lock Assignment    gives the student an extension whose due date has already passed and that has no late due
//                      date, so they can't submit again.
//   Unlock Assignment  opens a small date picker; it then gives the student an extension with the due date you
//                      pick (and no late due date), replacing any extension they had.
// They send the same requests as Gradescope's own extension forms, from the logged-in page, using the page's
// CSRF token. Each asks first.

const LOCK_TIME_ZONE = "America/Denver"; // the course's time zone; Gradescope's API takes UTC, so times are converted here
const LOCK_DAYS_AGO = 1; // Lock: the due date is this many days back...
const LOCK_HOUR = 23; // ...at this time of day
const LOCK_MINUTE = 59;

/** Minutes the zone is ahead of UTC at this moment (negative for Denver). */
function zoneOffsetMinutes(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return (Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - ms) / 60000;
}

/** The moment it is year-month-day hour:minute on the wall clock in `zone` (daylight saving included). */
function zonedInstant(year, month, day, hour, minute, zone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMinutes(guess, zone) * 60000;
  return new Date(guess - zoneOffsetMinutes(first, zone) * 60000);
}

/** The due date to set: `daysAgo` days before today (in the course's time zone) at LOCK_HOUR:LOCK_MINUTE. */
function lockDueDate(now = new Date(), daysAgo = LOCK_DAYS_AGO) {
  const today = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: LOCK_TIME_ZONE, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((p) => [p.type, Number(p.value)]));
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day - daysAgo));
  return zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), LOCK_HOUR, LOCK_MINUTE, LOCK_TIME_ZONE);
}

const isoNoMillis = (date) => date.toISOString().replace(".000Z", "Z");

/** "2026-11-09T23:59": the wall-clock time in the course's time zone, as a datetime-local input writes it. */
function wallTime(date, zone = LOCK_TIME_ZONE) {
  const v = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
}

/** The moment a datetime-local value ("2026-11-09T23:59") is, read as a wall-clock time in the course's time zone; null if it's blank or malformed. */
function fromWallTime(value, zone = LOCK_TIME_ZONE) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
  return m ? zonedInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), zone) : null;
}

/** The request body Gradescope's form sends: a due date, and never a late due date (it is always removed). */
const extensionBody = (userId, dueIso) => ({
  override: { user_id: userId, settings: { due_date: { type: "absolute", value: dueIso }, hard_due_date: { type: "none", value: "" }, visible: true } },
});
const lockBody = (userId, dueIso) => extensionBody(userId, dueIso);

/** The first array stored under `key` anywhere in parsed props. */
function findArray(node, key, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return null;
  if (!Array.isArray(node) && Array.isArray(node[key])) return node[key];
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findArray(value, key, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The student this submission belongs to, { userId, name }, or null when it can't be told (or it's a group
 * submission with several owners). The submission page lists `ownerships`; the grade page has no such list, but
 * every file carries the student's `user_id` and the submission has `owner_names`.
 */
function findOwner(root) {
  for (const node of root.querySelectorAll("[data-react-props]")) {
    const raw = node.getAttribute("data-react-props") || "";
    if (!raw.includes('"ownerships"') && !raw.includes('"owner_names"')) continue; // cheap check before parsing a big blob
    let props;
    try {
      props = JSON.parse(raw);
    } catch {
      continue;
    }
    if (props?.assignment?.group_submission === true) continue;
    let userId = null;
    const owners = (findArray(props, "ownerships") || []).filter((o) => o && o.active !== false && Number.isInteger(o.user_id));
    if (owners.length === 1) userId = owners[0].user_id;
    else if (!owners.length) {
      const ids = new Set((findArray(props, "files") || []).map((f) => f?.user_id).filter(Number.isInteger));
      if (ids.size === 1) userId = [...ids][0];
    }
    if (userId === null) continue;
    let name = typeof props?.submission?.owner_names === "string" ? props.submission.owner_names.trim() : "";
    const look = (n, depth = 0) => {
      if (name || !n || typeof n !== "object" || depth > 12) return;
      if (!Array.isArray(n) && (n.user_id === userId || n.id === userId)) name = [n.full_name, n.name].find((v) => typeof v === "string" && v.trim()) || "";
      for (const value of Array.isArray(n) ? n : Object.values(n)) look(value, depth + 1);
    };
    look(props);
    return { userId, name };
  }
  return null;
}

/** { course, assignment } from the sidebar's Extensions link (the grade page's own address has no assignment id). */
function extensionIds() {
  for (const link of document.querySelectorAll('a[href$="/extensions"]')) {
    const m = (link.getAttribute("href") || "").match(/\/courses\/(\d+)\/assignments\/(\d+)\/extensions$/);
    if (m) return { course: m[1], assignment: m[2] };
  }
  return null;
}

let lockBar = null;
let lockButton = null;
let unlockButton = null;
let dateState = { key: "", eff: null, loaded: false }; // the current student's dates; `loaded` once they have been read (eff stays null if they couldn't be)

/**
 * What the Extensions page says about everyone's dates: { rows, windows, assignment, zone }.
 *   rows        user id -> { settings, window }: each extension (its due_date / hard_due_date) and the student's own base window
 *   windows     user id -> the student's base window (their section's dates), for students with no extension
 *   assignment  the assignment's own dates
 * Dates are wall-clock strings in the course's time zone, like "2026-11-07T23:59".
 */
function parseExtensionsPage(root) {
  const out = { rows: new Map(), windows: {}, assignment: null, zone: null };
  for (const node of root.querySelectorAll("[data-react-props]")) {
    const raw = node.getAttribute("data-react-props") || "";
    if (!raw.includes('"override"') && !raw.includes('"studentSubmissionWindows"')) continue; // cheap check before parsing a big blob
    let props;
    try {
      props = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof props?.timezone?.identifier === "string") out.zone ??= props.timezone.identifier;
    if (props?.override && Number.isInteger(props.userId)) out.rows.set(props.userId, { settings: props.override.settings || {}, window: props.fallbackSubmissionWindow || null });
    if (props?.studentSubmissionWindows && typeof props.studentSubmissionWindows === "object") Object.assign(out.windows, props.studentSubmissionWindows);
    if (props?.assignment && typeof props.assignment === "object" && "due_date" in props.assignment) out.assignment ??= props.assignment;
  }
  return out;
}

/** The student's due date and late due date as they stand now: { due, late (Dates or null), from, zone }. */
function effectiveDates(data, userId) {
  const zone = data.zone || LOCK_TIME_ZONE;
  const row = data.rows.get(userId);
  const base = row?.window || data.windows[String(userId)] || data.assignment || {};
  const at = (value) => fromWallTime(value, zone);
  const ext = row?.settings || {};
  const overridden = (setting) => (setting?.type === "absolute" && setting.value ? at(setting.value) : undefined); // undefined: not overridden
  let due = at(base.due_date);
  let late = at(base.hard_due_date);
  if (row) {
    due = overridden(ext.due_date) ?? due;
    if (ext.hard_due_date?.type === "none") late = null;
    else late = overridden(ext.hard_due_date) ?? late; // absent: the base window's
  }
  return { due, late, from: row ? "extension" : "assignment", zone };
}

/** Locked = the last moment they can still submit (the late due date if there is one, else the due date) has passed. */
function isLocked(eff, now = new Date()) {
  const last = eff.late ?? eff.due;
  return !!last && last <= now;
}

/** "Current due date: …" lines for the prompts. */
function describeDates(eff) {
  if (!eff) return "Couldn't read their current dates.";
  const format = (d) => new Intl.DateTimeFormat("en-US", { timeZone: eff.zone, dateStyle: "medium", timeStyle: "short" }).format(d);
  const source = eff.from === "extension" ? "from their extension" : "the assignment's own dates; no extension";
  return `Current due date: ${eff.due ? format(eff.due) : "none"}${eff.late ? `\nCurrent late due date: ${format(eff.late)}` : ""}\n(${source})`;
}

const extensionPages = new Map(); // assignment id -> { at, promise } (the parsed Extensions page, kept for a minute)
const EXTENSIONS_TTL_MS = 60 * 1000;

function loadExtensionsPage(ids) {
  const kept = extensionPages.get(ids.assignment);
  if (kept && Date.now() - kept.at < EXTENSIONS_TTL_MS) return kept.promise;
  const promise = fetch(`/courses/${ids.course}/assignments/${ids.assignment}/extensions`, { credentials: "include" }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} loading the Extensions page`);
    return parseExtensionsPage(new DOMParser().parseFromString(await res.text(), "text/html"));
  });
  extensionPages.set(ids.assignment, { at: Date.now(), promise });
  promise.catch(() => extensionPages.delete(ids.assignment));
  return promise;
}

/** This student's current dates, or null if they couldn't be read. */
async function currentDates(ids, owner) {
  try {
    return effectiveDates(await loadExtensionsPage(ids), owner.userId);
  } catch (e) {
    console.warn("[webrecan] couldn't read the student's dates", e);
    return null;
  }
}

/** Read the student's dates again (after we changed their extension); the buttons keep their state until the new one arrives. */
function refreshDates(ids, owner) {
  extensionPages.delete(ids.assignment);
  const key = `${ids.assignment}:${owner.userId}`;
  currentDates(ids, owner).then((eff) => {
    if (dateState.key !== key) return;
    dateState = { key, eff, loaded: true };
    paintLockButton();
  });
}

/** What the prompts say about the student and the assignment. */
function lockSubject(owner) {
  const who = owner.name || `user ${owner.userId}`; // the id is only shown when the page gives no name
  const title = page.assignmentTitle.split("|")[0].trim() || "this assignment";
  return { who, title };
}

/** Everything a request needs, or an alert saying what's missing (null). */
function lockContext() {
  const ids = extensionIds();
  const owner = page.owner;
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!ids) alert("WebRecan: couldn't find this assignment's id (the Extensions link in the left menu), so nothing was sent.");
  else if (!owner) alert("WebRecan: couldn't tell which single student this submission belongs to, so nothing was sent.");
  else if (!token) alert("WebRecan: couldn't find Gradescope's security token on this page, so nothing was sent.");
  else return { ids, owner, token, ...lockSubject(owner) };
  return null;
}

/** Add an extension (POST the form's JSON); throws if Gradescope says no. */
async function createExtension({ ids, token }, body) {
  const res = await fetch(`/courses/${ids.course}/assignments/${ids.assignment}/extensions`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": token, "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function lockResubmission() {
  const ctx = lockContext();
  if (!ctx) return;
  lockButton.disabled = true;
  try {
    const eff = await currentDates(ctx.ids, ctx.owner);
    const due = lockDueDate();
    const format = (d) => new Intl.DateTimeFormat("en-US", { timeZone: LOCK_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(d);
    if (!confirm(`Lock the assignment for ${ctx.who}\non ${ctx.title}?\n\n${describeDates(eff)}\n\nThis replaces it with an extension due ${format(due)} and removes the late due date.`)) return;
    await createExtension(ctx, lockBody(ctx.owner.userId, isoNoMillis(due)));
    refreshDates(ctx.ids, ctx.owner);
  } catch (e) {
    alert(`WebRecan: Gradescope didn't accept it. ${e.message}`);
  } finally {
    lockButton.disabled = false;
    paintLockButton();
  }
}

/** The date picker: resolves the due date (a Date) or null if cancelled. */
function askUnlockDates({ who, title, current }) {
  return new Promise((resolve) => {
    const overlay = el("div", "webrecan-dialog");
    created.add(overlay);
    const box = el("div", "box");
    const field = (label, hint) => {
      const input = el("input");
      input.type = "datetime-local";
      const wrap = el("label", "field");
      wrap.append(el("span", "name", label), input, el("span", "hint", hint));
      return { wrap, input };
    };
    const due = field("New due date (Mountain time)", "When they can submit until. Any late due date is removed.");
    due.input.value = wallTime(lockDueDate(new Date(), -1)); // tomorrow, 11:59 PM
    const error = el("div", "error");
    const cancel = el("button", "cancel", "Cancel");
    const ok = el("button", "ok", "Unlock");
    cancel.type = ok.type = "button";
    const done = (value) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        done(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => done(null));
    overlay.addEventListener("mousedown", (event) => event.target === overlay && done(null));
    ok.addEventListener("click", () => {
      const dueDate = fromWallTime(due.input.value);
      if (!dueDate) return void (error.textContent = "Pick a due date.");
      if (dueDate <= new Date()) return void (error.textContent = "The due date has to be in the future, or they still can't submit.");
      done(dueDate);
    });
    const buttons = el("div", "buttons");
    buttons.append(cancel, ok);
    box.append(
      el("div", "title", "Unlock Assignment"),
      el("div", "about", `${who}\n${title}`),
      el("div", "current", `${current}\nThis extension will be replaced.`),
      due.wrap,
      error,
      buttons,
    );
    overlay.append(box);
    document.body.append(overlay);
    due.input.focus();
  });
}

/** Let the student submit again: show their current dates, pick the new due date, replace their extension with it. */
async function unlockResubmission() {
  const ctx = lockContext();
  if (!ctx) return;
  unlockButton.disabled = true;
  try {
    const eff = await currentDates(ctx.ids, ctx.owner);
    const picked = await askUnlockDates({ who: ctx.who, title: ctx.title, current: describeDates(eff) });
    if (!picked) return;
    // Adding an extension for a student replaces the one they had, so this is all it takes.
    await createExtension(ctx, extensionBody(ctx.owner.userId, isoNoMillis(picked)));
    refreshDates(ctx.ids, ctx.owner);
    alert(`WebRecan: ${ctx.who} now has an extension due ${new Intl.DateTimeFormat("en-US", { timeZone: LOCK_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(picked)}.`);
  } catch (e) {
    alert(`WebRecan: Gradescope didn't accept it. ${e.message}\n\nCheck the student's extension on the Extensions page.`);
  } finally {
    unlockButton.disabled = false;
    paintLockButton();
  }
}

/** A button with a Font Awesome icon (Gradescope's pages already load it) and a label. */
function iconButton(className, icon, label) {
  const button = el("button", className);
  const i = el("i", `fa ${icon}`);
  i.setAttribute("aria-hidden", "true");
  button.append(i, el("span", "", ` ${label}`));
  button.type = "button";
  return button;
}

/**
 * The buttons sit side by side right under the total points ("10.0 / 10.0 pts"), on grade pages only. Only the one
 * that makes sense shows: Lock while the student can still submit, Unlock once they can't. Nothing shows until the
 * student's dates have been read (both show if they can't be).
 */
function paintLockButton() {
  const onGradePage = /\/questions\/\d+\/submissions\/\d+\/grade/.test(location.pathname);
  const ratio = document.querySelector(".totalPoints--ratio");
  if (!onGradePage || !ratio) {
    lockBar?.remove();
    return;
  }
  if (!lockBar) {
    lockBar = el("div", "webrecan-lockbar");
    lockButton = iconButton("webrecan-lock", "fa-lock", "Lock Assignment");
    unlockButton = iconButton("webrecan-lock webrecan-unlock", "fa-unlock", "Unlock Assignment");
    lockButton.title = "Give this student an extension with a due date that has passed, so they can't submit again.";
    unlockButton.title = "Let this student submit again: pick a new due date for their extension.";
    lockButton.addEventListener("click", lockResubmission);
    unlockButton.addEventListener("click", unlockResubmission);
    lockBar.append(lockButton, unlockButton);
    created.add(lockBar);
  }
  if (ratio.nextElementSibling !== lockBar) ratio.after(lockBar); // moved only when it isn't already there (moving it resets the hover)

  const ids = extensionIds();
  const owner = page.owner;
  const parsed = "owner" in page; // false for the placeholder used while another submission's page is still being fetched
  const key = ids && owner ? `${ids.assignment}:${owner.userId}` : "";
  if (key !== dateState.key) {
    dateState = { key, eff: null, loaded: false };
    if (key) {
      currentDates(ids, owner).then((eff) => {
        if (dateState.key !== key) return;
        dateState = { key, eff, loaded: true };
        paintLockButton();
      });
    }
  }
  // Decide before drawing anything, so the wrong button never flashes up:
  //   wait    the student's dates haven't been read yet: the bar is invisible (but keeps its room)
  //   both    nothing to go on (no student found, or the dates couldn't be read): both buttons, so each can say why it can't act
  //   lock / unlock   the one that makes sense
  let show;
  if (!ids || !parsed || (key && !dateState.loaded)) show = "wait";
  else if (!key || !dateState.eff) show = "both";
  else show = isLocked(dateState.eff) ? "unlock" : "lock";
  const visibility = show === "wait" ? "hidden" : "";
  if (lockBar.style.visibility !== visibility) lockBar.style.visibility = visibility;
  if (lockButton.hidden !== (show === "unlock")) lockButton.hidden = show === "unlock";
  if (unlockButton.hidden !== (show === "lock")) unlockButton.hidden = show === "lock";
}
// ---- end lock resubmission ----

// ---- autograder: the "Previous submissions" test ----
//
// Gradescope embeds every autograder test in the page's data (the React props) as { name, status, ... }.
// This finds the "Previous Submission(s)" test there and flags it unless its status says "passed".
// If the test can't be found, nothing is flagged. Nothing is read from the drawn page.

const PREVIOUS_TEST_NAME = /previous\s+submission/i; // "Previous Submission(s)" and "Previous Submissions"

/** The test named "Previous Submission(s)" in the parsed props, or null. */
function findPreviousSubmissionsTest(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return null;
  if (!Array.isArray(node) && typeof node.name === "string" && PREVIOUS_TEST_NAME.test(node.name)) return node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findPreviousSubmissionsTest(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The message for the red box, or null when there's nothing to flag. */
function previousSubmissionsFlag(root = document) {
  for (const node of root.querySelectorAll("[data-react-props]")) {
    const raw = node.getAttribute("data-react-props") || "";
    if (!PREVIOUS_TEST_NAME.test(raw)) continue; // cheap check before parsing a big blob
    let test;
    try {
      test = findPreviousSubmissionsTest(JSON.parse(raw));
    } catch {
      continue; // not JSON
    }
    if (test) return /^passed$/i.test(String(test.status)) ? null : "the “Previous Submission(s)” test failed";
  }
  return null;
}

/** Remember what the autograder says about earlier submissions; the code quality box shows it. */
function updatePreviousFlag() {
  previousFlag = page.previousFlag ?? null; // read from this submission's own data (see parsePage), not the first page's
}

// ---- placing the buttons ----

/** Elements whose own text is exactly this file name (full path or basename). */
function findNameElements(rec) {
  const names = new Set([rec.name, rec.name.split("/").pop()]);
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !names.has(node.nodeValue.trim())) continue;
    if (parent.closest(`[${MARK}], #webrecan-panel, .webrecan-pop, .webrecan-banner, script, style, textarea, pre, code`)) continue;
    found.push(parent);
  }
  return found;
}

// Hide with a marker instead of removing React's nodes, so file selection and downloads for
// the remaining files keep their original handlers. Recompute on every render: Gradescope
// can reuse a row for a different file when switching submissions.
const HIDDEN_TEST = "data-webrecan-test-file";
const FILE_ENTRY = 'li, tr, [role="treeitem"], [role="tab"], [role="tabpanel"], .submissionFile, [class*="submissionFile--"], [class*="file-preview" i], [class*="filePreview" i]';
const FILE_SEPARATOR = 'hr, [role="separator"], [class*="separator" i], [class*="divider" i]';
const GRADING_REGION = 'html, body, main, form, nav, aside, #main-content, [data-react-class], [role="main"], [class*="autograder" i], [class*="rubric" i]';

/** Map file identities onto their ancestors, independent of Gradescope's CSS class names. */
function fileOwnership(entries) {
  const owners = new Map();
  for (const { file, nodes } of entries) {
    for (const node of nodes) {
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (!owners.has(ancestor)) owners.set(ancestor, new Set());
        owners.get(ancestor).add(file.id);
      }
    }
  }
  return owners;
}

/** The entire branch for this file, stopping where the next file or grading UI begins. */
function outerFileContainer(node, owners) {
  let container = null;
  for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
    if ((owners.get(ancestor)?.size ?? 0) > 1) return container;
    if (ancestor.matches(GRADING_REGION) || ancestor.querySelector(GRADING_REGION)) break;
    container = ancestor;
  }
  return container;
}

/** Collapse the leftover borders/spacing around a hidden card, without hiding other content. */
function collapseHiddenFileWrappers(hidden) {
  const hasOnlyHiddenContent = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return !node.nodeValue.trim();
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    if (hidden.has(node)) return true;
    if (node.matches(GRADING_REGION + ", " + OUR_ELEMENTS)) return false;
    if (node.matches("hr")) return true;
    // Empty controls, images, and previews can still be meaningful. Only structural
    // wrappers and separators can disappear along with their hidden children.
    if (!node.matches("div, span, section, article, li, ul, ol, " + FILE_SEPARATOR) || node.matches('[role]:not([role="separator"]), [tabindex], [contenteditable]')) return false;
    return [...node.childNodes].every(hasOnlyHiddenContent);
  };

  for (const node of [...hidden]) {
    for (let parent = node.parentElement; parent && hasOnlyHiddenContent(parent); parent = parent.parentElement) {
      hidden.add(parent);
    }
  }
  // Some layouts put an <hr> between cards rather than a border on the card itself.
  for (const node of [...hidden]) {
    for (const sibling of [node.previousElementSibling, node.nextElementSibling]) {
      if (sibling?.matches(FILE_SEPARATOR) && hasOnlyHiddenContent(sibling)) hidden.add(sibling);
    }
  }
}

// Signed download URLs can acquire a different query string when Gradescope redraws a file.
const downloadKey = (url) => {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
};

function hideTestFiles(files) {
  const links = [...document.querySelectorAll("a[href]")].filter((link) => !link.closest(OUR_ELEMENTS));
  const entries = files.map((file) => {
    const names = findNameElements(file);
    const key = downloadKey(file.url);
    const downloads = key ? links.filter((link) => downloadKey(link.getAttribute("href")) === key) : [];
    return { file, names, downloads, nodes: [...names, ...downloads] };
  });
  const owners = fileOwnership(entries);
  const hidden = new Set();
  for (const { file, names, downloads, nodes } of entries) {
    if (!isTestFile(file.name)) continue;
    const separateDownloads = downloads.filter((link) => !names.some((name) => link.contains(name)));
    for (const node of nodes) {
      if (node.closest('[class*="autograder" i], [class*="testCase" i]')) continue;
      const container = outerFileContainer(node, owners);
      if (container) {
        hidden.add(container);
        continue;
      }
      let target = node.closest("a, button") || node;
      // Never hide a shared list/viewer containing another file, or the grading UI itself.
      const containsOtherFile = (candidate) => entries.some((entry) => entry.file.id !== file.id && entry.nodes.some((other) => candidate.contains(other)));
      if (containsOtherFile(target)) target = node;
      let foundCard = false;
      for (let ancestor = target; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        if (containsOtherFile(ancestor)) break;
        if (ancestor.matches(FILE_ENTRY)) target = ancestor;
        // Some Gradescope layouts use an ordinary div for the whole file card. Its title
        // and Download link are siblings, so hiding just the title leaves an empty card.
        if (!foundCard && !ancestor.matches("a, button") && names.some((name) => ancestor.contains(name)) && separateDownloads.some((link) => ancestor.contains(link))) {
          target = ancestor;
          foundCard = true;
        }
      }
      hidden.add(target);
    }
  }
  collapseHiddenFileWrappers(hidden);
  for (const node of document.querySelectorAll(`[${HIDDEN_TEST}]`)) {
    if (!hidden.has(node)) node.removeAttribute(HIDDEN_TEST);
  }
  for (const node of hidden) {
    if (!node.hasAttribute(HIDDEN_TEST)) node.setAttribute(HIDDEN_TEST, "");
  }
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
// In the chosen order (recordings first, .py files first, or Gradescope's own), each group alphabetical. The sections are not moved
// (React owns them); the parent is made a column and each section gets a CSS `order`.
const fileViewerName = (section) => (section.querySelector(".fileViewerHeader--toggleButton")?.textContent || "").trim();
function sortFileViewers() {
  const all = [...document.querySelectorAll("section.fileViewer")].map((node) => ({ node, name: fileViewerName(node) }));
  // A hidden file's whole section is hidden (not just its contents), so no empty box is left in the column.
  for (const { node, name } of all) if (isTestFile(name) && !node.hasAttribute(HIDDEN_TEST)) node.setAttribute(HIDDEN_TEST, "");
  if (settings.sortOrder === "default") {
    // Gradescope's own order: take back anything we set.
    for (const { node } of all) {
      if (node.style.order) node.style.order = "";
      node.parentElement?.classList.remove("webrecan-sorted");
    }
    return;
  }
  const sections = all.filter(({ name }) => !isTestFile(name));
  sections.sort((a, b) => webrecanCompareFiles(settings.sortOrder, a.name, b.name));
  sections.forEach(({ node }, i) => {
    node.parentElement?.classList.add("webrecan-sorted");
    if (node.style.order !== String(i + 1)) node.style.order = String(i + 1); // 0 is left for our banner
  });
}

// Gradescope opens the first file of every submission. Collapse it once per submission so the page
// starts compact; after that the grader's own clicks are left alone.
const OPEN_FILE_TOGGLE = '.fileViewerHeader.open button.fileViewerHeader--toggleButton[aria-expanded="true"]';
let collapsedPath = "";
function collapseFirstFile() {
  if (collapsedPath === location.pathname) return;
  if (!settings.autoCollapse) {
    collapsedPath = location.pathname; // switched off: leave this submission alone, even if it's switched on later
    return;
  }
  const toggle = document.querySelector(OPEN_FILE_TOGGLE);
  if (!toggle) return; // the files aren't drawn yet; try again on the next render
  collapsedPath = location.pathname;
  toggle.click();
}

let seenPath = "";
let seenAt = Date.now();

function render() {
  if (!settingsLoaded) return; // the settings decide what is hidden and sorted, so wait for them
  // Remove lifeless copies of our elements (see `created`); live ones are re-added below.
  for (const node of document.querySelectorAll(".webrecan-ctl, .webrecan-pop, .webrecan-banner, .webrecan-lockbar, .webrecan-dialog, .webrecan-autograder, #webrecan-panel")) {
    if (!created.has(node)) node.remove();
  }
  page = currentPage();
  hideTestFiles(page.files);
  sortFileViewers();
  collapseFirstFile();
  const recordings = page.recordings;
  if (location.pathname !== seenPath) [seenPath, seenAt] = [location.pathname, Date.now()];

  // Drop controls for files that are no longer on this submission.
  const current = new Set(recordings.map((r) => r.id));
  for (const ctl of document.querySelectorAll(".webrecan-ctl")) {
    if (!current.has(ctl.getAttribute(MARK))) ctl.remove();
  }

  if (recordings.length) requestStarterInfo();
  prefetchRecordings(recordings);
  requestQuality(page.sources);

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
  updatePreviousFlag();
  paintBanner();
}

// React redraws the list, which can drop our buttons, so re-check after changes
// (ignoring changes we made ourselves).
const ours = ".webrecan-ctl, .webrecan-pop, .webrecan-banner, .webrecan-lockbar, .webrecan-dialog, .webrecan-autograder, #webrecan-panel";
let timer;
new MutationObserver((mutations) => {
  const foreign = mutations.some((m) => !(m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest(ours));
  if (!foreign) return;
  clearTimeout(timer);
  timer = setTimeout(render, 150);
}).observe(document.body, { childList: true, subtree: true, characterData: true });

// The settings come from the toolbar popup (stored with the browser's extension storage, which follows the profile
// from one computer to another where sync is on). A change applies right away.
const settingsArea = chrome.storage.sync ?? chrome.storage.local;
async function loadSettings() {
  try {
    settings = webrecanNormalize(await settingsArea.get(WEBRECAN_DEFAULTS));
  } catch (e) {
    console.warn("[webrecan] couldn't read the settings; using the defaults", e);
  }
  settingsLoaded = true;
}
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== (chrome.storage.sync ? "sync" : "local")) return;
  await loadSettings();
  render();
});
loadSettings().then(render);
