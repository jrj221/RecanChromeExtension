// A hidden, long-lived page that holds one Pyodide session with recan loaded, so the
// buttons can be analyzed when a Gradescope page opens and a click is fast.
// It runs upstream's recan unmodified; see runner.js. Recordings stay in memory only.
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { evaluateSummaryJson } from "./flags.js";
import { TA_OPTIONS, generateHtml, generateSummary, mountRecan } from "./runner.js";
import { loadIndex, loadStarterFiles } from "./starter.js";

const readBytes = async (path) => {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} (run scripts/setup.mjs?)`);
  return new Uint8Array(await res.arrayBuffer());
};

let pythonPromise;
const getPython = () =>
  (pythonPromise ??= (async () => {
    const py = await loadPyodide({ indexURL: chrome.runtime.getURL("vendor/pyodide/") });
    await py.loadPackage(["jinja2", "pyyaml"]);
    await mountRecan(py, readBytes);
    return py;
  })().catch((e) => {
    pythonPromise = undefined; // allow a retry
    throw e;
  }));

// Downloaded recordings, by URL. A recording is small (a few hundred KB) and the same
// URL is used for the page-load analysis and the click, so this avoids a second download.
const downloads = new Map();
function getRecording(url) {
  if (!downloads.has(url)) {
    if (downloads.size >= 40) downloads.delete(downloads.keys().next().value);
    const promise = (async () => {
      // Presigned URL: the signature is in the query string, so no cookies.
      let res;
      try {
        res = await fetch(url, { credentials: "omit" });
      } catch (e) {
        throw new Error(`network request failed (${e.message})`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return new Uint8Array(await res.arrayBuffer());
    })();
    promise.catch(() => downloads.delete(url));
    downloads.set(url, promise);
  }
  return downloads.get(url);
}

const starterCache = new Map(); // folder id -> [{ name, text }]
async function starterFiles(folderId) {
  if (!folderId) return [];
  if (!starterCache.has(folderId)) {
    const index = await loadIndex();
    starterCache.set(folderId, index ? await loadStarterFiles(index, folderId) : []);
  }
  return starterCache.get(folderId);
}

// recan runs synchronously inside Pyodide, so queue the runs one at a time.
let queue = Promise.resolve();
const serial = (job) => {
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
};

// A file's contents never change, so its analysis can be reused (key: file id + starter folder).
const evaluations = new Map();

async function handle(msg) {
  switch (msg.op) {
    case "warm":
      await getPython();
      return {};
    case "fetch":
      await getRecording(msg.url);
      return {};
    case "summary": {
      const key = `${msg.fileId}|${msg.folderId ?? ""}`;
      if (!evaluations.has(key)) {
        const [bytes, starterCode] = await Promise.all([getRecording(msg.url), starterFiles(msg.folderId)]);
        const evaluation = await serial(async () => {
          const py = await getPython();
          const json = generateSummary(py, [{ name: msg.name, bytes }], { ...TA_OPTIONS, starterCode });
          return evaluateSummaryJson(json);
        });
        evaluations.set(key, evaluation);
      }
      return { evaluation: evaluations.get(key) };
    }
    case "view": {
      const [bytes, starterCode] = await Promise.all([getRecording(msg.url), starterFiles(msg.folderId)]);
      const html = await serial(async () => {
        const py = await getPython();
        return generateHtml(py, [{ name: msg.name, bytes }], { ...TA_OPTIONS, starterCode });
      });
      return { html };
    }
    default:
      throw new Error(`unknown op: ${msg.op}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return; // not for us (messages are broadcast)
  handle(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (e) => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true;
});
