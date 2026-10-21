// Routes work between the Gradescope page, the viewer tab and the hidden engine page
// (offscreen.js), and remembers which starter folder goes with which assignment.
import { folderLabel, loadIndex, matchFolder, stemOf } from "./starter.js";
import { trackTabReturns } from "./tabreturn.js";

const rememberOpener = trackTabReturns(); // closing a player tab returns you to the tab you opened it from

const NONE = "none"; // saved choice: don't check starter code for this assignment

/**
 * Where a starter-folder choice is remembered. Normally that's the assignment's number from
 * the page address, but some Gradescope pages (e.g. question-by-question grading) have no
 * assignment number, so the choice is also remembered under the set of recording names.
 * A choice is saved under every key that is available and read from the first one found.
 */
function choiceKeys(assignmentId, recordingNames) {
  const names = [...new Set((recordingNames || []).map(stemOf))].sort().join(",");
  return [assignmentId && `starterFolder:${assignmentId}`, names && `starterFolder:names:${names}`].filter(Boolean);
}

// ---- the hidden engine page ----

let creating;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "src/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Keeps a Python (WebAssembly) session loaded to analyze recordings quickly",
    })
    .finally(() => (creating = undefined));
  await creating;
}

async function callEngine(msg) {
  if (!chrome.offscreen || !chrome.runtime.getContexts) throw new Error("this needs Chrome 116 or newer");
  await ensureOffscreen();
  // The page may still be starting up and not listening yet; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
      if (!res?.ok) throw new Error(res?.error || "no response from the recan engine");
      return res;
    } catch (e) {
      if (attempt < 30 && /Receiving end does not exist|message port closed/i.test(e.message)) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw e;
    }
  }
}

// Start Python as soon as a Gradescope page begins loading, so it is ready (or nearly) by the time
// the page has drawn its file list. Asking again is harmless: the engine only starts once.
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status === "loading" && /^https:\/\/www\.gradescope\.com(:\d+)?\//.test(change.url ?? tab.url ?? "")) {
    callEngine({ op: "warm" }).catch(() => {});
  }
});

// ---- starter code (optional) ----

/** Which starter folder applies to this assignment, plus what the picker needs. */
async function starterInfo(assignmentId, recordingNames) {
  const index = await loadIndex();
  if (!index) return { enabled: false };

  const folders = index.folders.map((f) => ({ id: f.id, label: folderLabel(f) }));
  const keys = choiceKeys(assignmentId, recordingNames);
  const stored = keys.length ? await chrome.storage.local.get(keys) : {};
  const saved = keys.map((key) => stored[key]).find((value) => value !== undefined) ?? null;

  let folderId = null;
  let source = null;
  if (saved === NONE) source = "none";
  else if (saved && index.folders.some((f) => f.id === saved)) [folderId, source] = [saved, "saved"];
  else {
    const guess = matchFolder(index, recordingNames);
    if (guess) [folderId, source] = [guess.id, "names"];
  }
  return { enabled: true, folderId, source, folders, commit: index.commit };
}

// ---- messages ----

const handlers = {
  async "starter-info"(msg) {
    return { starter: await starterInfo(msg.assignmentId, msg.recordingNames) };
  },

  async "set-starter-folder"(msg) {
    await chrome.storage.local.set(Object.fromEntries(choiceKeys(msg.assignmentId, msg.recordingNames).map((key) => [key, msg.folderId ?? NONE])));
    return {};
  },

  async analyze(msg) {
    const starter = await starterInfo(msg.assignmentId, msg.recordingNames);
    const res = await callEngine({ op: "summary", url: msg.url, name: msg.name, fileId: msg.fileId, siblings: msg.siblings, folderId: starter.folderId });
    return { evaluation: res.evaluation, starter: { enabled: starter.enabled, folderId: starter.folderId, source: starter.source } };
  },

  // Page script: download these recordings now, so they are ready when analysis starts.
  async prefetch(msg) {
    await callEngine({ op: "prefetch", urls: msg.urls });
    return {};
  },

  // Code-quality checks for the submission's .py files (not related to recan).
  async quality(msg) {
    const res = await callEngine({ op: "quality", files: msg.files });
    return { results: res.results, checks: res.checks };
  },

  // Page script: open the viewer tab for this recording.
  async "open-recording"(msg, sender) {
    const viewer = new URL(chrome.runtime.getURL("src/viewer.html"));
    for (const key of ["url", "name", "assignmentId"]) viewer.searchParams.set(key, msg[key] ?? "");
    viewer.searchParams.set("recordingNames", JSON.stringify(msg.recordingNames ?? []));
    const from = sender?.tab?.id; // the Gradescope tab the click came from
    const tab = await chrome.tabs.create({ url: viewer.href, ...(from != null && { openerTabId: from }) });
    if (from != null && tab.id != null) await rememberOpener(tab.id, from);
    return {};
  },

  // Viewer tab: the three steps of its loading screen.
  async warm() {
    await callEngine({ op: "warm" });
    return {};
  },
  async fetch(msg) {
    await callEngine({ op: "fetch", url: msg.url });
    return {};
  },
  async render(msg) {
    const starter = await starterInfo(msg.assignmentId, msg.recordingNames);
    const res = await callEngine({ op: "view", url: msg.url, name: msg.name, folderId: starter.folderId });
    return { html: res.html };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler || msg.target) return; // ignore messages meant for the engine page
  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (e) => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true;
});
