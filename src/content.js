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

function findRecordings() {
  // The submission page embeds its files (with presigned S3 URLs) as React props.
  const el = document.querySelector('[data-react-class="SubmissionGrader"]');
  if (!el) return [];
  let props;
  try {
    props = JSON.parse(el.getAttribute("data-react-props"));
  } catch {
    return [];
  }
  return (props.files || [])
    .filter((f) => GZ.test(f.path || "") && (f.url || f.file?.url))
    .map((f) => ({ url: f.url || f.file.url, name: f.path }));
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
  btn.setAttribute(MARK, rec.name);
  btn.textContent = "Run recan";
  btn.addEventListener("click", (event) => {
    // The name often sits inside a link or tab; don't also trigger that.
    event.preventDefault();
    event.stopPropagation();
    if (Math.random() < EASTER_EGG_ODDS) {
      window.open(EASTER_EGG_URL, "_blank", "noopener");
      return;
    }
    run(rec, btn);
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

function hasButton(anchor, rec) {
  const next = anchor.nextElementSibling;
  return !!next && next.getAttribute(MARK) === rec.name;
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
  const key = unplaced.map((r) => r.url).join("|");
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
  const unplaced = [];
  for (const rec of findRecordings()) {
    const anchors = findNameElements(rec);
    if (!anchors.length) {
      unplaced.push(rec);
      continue;
    }
    for (const el of anchors) {
      // Insert after the enclosing link/tab so a click doesn't nest inside it.
      const anchor = el.closest("a, button, [role=tab]") || el;
      if (!hasButton(anchor, rec)) anchor.insertAdjacentElement("afterend", makeButton(rec));
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
