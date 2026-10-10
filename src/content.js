// Adds a "Run recan" button next to each .gz recording in the Gradescope file list.
//
// Gradescope draws the file list client-side, so rather than depend on its markup
// we find where each recording's file name appears on the page and put the
// button right after it. Anything we cannot place falls back to a small panel.

const GZ = /\.gz(\?|$)/i;
const MARK = "data-webrecan";

// Easter egg: this fraction of clicks goes somewhere else instead.
const EASTER_EGG_ODDS = 0.01;
const EASTER_EGG_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/** Recordings listed in the SubmissionGrader props found in `root` (a Document). */
function parseRecordings(root) {
  // The submission page embeds its files (with presigned S3 URLs) as React props.
  const el = root.querySelector('[data-react-class="SubmissionGrader"]');
  if (!el) return [];
  let props;
  try {
    props = JSON.parse(el.getAttribute("data-react-props"));
  } catch {
    return [];
  }
  return (props.files || [])
    .filter((f) => GZ.test(f.path || "") && (f.url || f.file?.url))
    // Every student's recording has the same name, so identify files by id, not name.
    .map((f) => ({ id: String(f.id ?? f.uuid ?? f.url ?? f.file.url), url: f.url || f.file.url, name: f.path }));
}

// Gradescope can move between submissions (Next student, etc.) without reloading the
// page. The props in the DOM then still belong to the submission we first loaded, so
// for any other URL we fetch that page and read its props instead.
const loadedPath = location.pathname;
const recordingsByPath = new Map(); // pathname -> recordings, for pages other than loadedPath

function currentRecordings() {
  const path = location.pathname;
  if (path === loadedPath) return parseRecordings(document);
  if (!recordingsByPath.has(path)) {
    recordingsByPath.set(path, []); // until the fetch finishes (or if it fails)
    fetch(location.pathname + location.search, { credentials: "include" })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((html) => {
        recordingsByPath.set(path, parseRecordings(new DOMParser().parseFromString(html, "text/html")));
        render();
      })
      .catch((e) => console.warn("[webrecan] could not load recordings for", path, e));
  }
  return recordingsByPath.get(path);
}

async function run(rec, button) {
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "open-recording", url: rec.url, name: rec.name });
    if (!res?.ok) throw new Error(res?.error || "no response");
    button.textContent = "Run recan";
  } catch (e) {
    button.textContent = "Failed: " + e.message;
  } finally {
    button.disabled = false;
  }
}

function makeButton(rec) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "webrecan-btn";
  btn.setAttribute(MARK, rec.id);
  btn.recording = rec; // updated in place if the page reuses this button for another student
  btn.textContent = "Run recan";
  btn.addEventListener("click", (event) => {
    // The name often sits inside a link or tab; don't also trigger that.
    event.preventDefault();
    event.stopPropagation();
    if (Math.random() < EASTER_EGG_ODDS) {
      window.open(EASTER_EGG_URL, "_blank", "noopener");
      return;
    }
    run(btn.recording, btn);
  });
  return btn;
}

/** Elements whose own text is exactly this file name (full path or basename). */
function findNameElements(rec) {
  const names = new Set([rec.name, rec.name.split("/").pop()]);
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !names.has(node.nodeValue.trim())) continue;
    if (parent.closest(`[${MARK}], #webrecan-panel, script, style, textarea`)) continue;
    found.push(parent);
  }
  return found;
}

/** Make sure the button after `anchor` is for `rec`, reusing or replacing a stale one. */
function ensureButton(anchor, rec) {
  const next = anchor.nextElementSibling;
  if (next?.classList.contains("webrecan-btn")) {
    if (next.getAttribute(MARK) === rec.id) return;
    next.remove(); // left over from another submission
  }
  anchor.insertAdjacentElement("afterend", makeButton(rec));
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
    row.append(label, makeButton(rec));
    panel.appendChild(row);
  }
}

function render() {
  const recordings = currentRecordings();

  // Drop buttons for files that are no longer on this submission.
  const current = new Set(recordings.map((r) => r.id));
  for (const btn of document.querySelectorAll(".webrecan-btn")) {
    if (!current.has(btn.getAttribute(MARK))) btn.remove();
  }

  const unplaced = [];
  for (const rec of recordings) {
    const anchors = findNameElements(rec);
    if (!anchors.length) {
      unplaced.push(rec);
      continue;
    }
    for (const el of anchors) {
      // Insert after the enclosing link/tab so a click doesn't nest inside it.
      const anchor = el.closest("a, button, [role=tab]") || el;
      ensureButton(anchor, rec);
    }
  }
  renderFallback(unplaced);
}

// React redraws the list, which can drop our buttons, so re-check after changes.
let timer;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(render, 150);
}).observe(document.body, { childList: true, subtree: true, characterData: true });
render();
