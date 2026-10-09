// Fetch the recording, run upstream recan on it in Pyodide, show the page it writes.
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { TA_OPTIONS, generateHtml, mountRecan } from "./runner.js";

const loading = document.getElementById("loading");
const frame = document.getElementById("player");
const $ = (id) => document.getElementById(id);

/** state: "pending" | "active" | "done" | "error" */
const step = (id, state) => ($(`step-${id}`).dataset.state = state);

const readBytes = async (path) => {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} (run scripts/setup.mjs?)`);
  return new Uint8Array(await res.arrayBuffer());
};

async function download(url) {
  // Presigned URL: the signature is in the query string, so no cookies.
  let res;
  try {
    res = await fetch(url, { credentials: "omit" });
  } catch (e) {
    throw new Error(`network request failed (${e.message})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

// The generated page has inline scripts, which extension pages forbid, so it is
// rendered by sandbox.html (a manifest-declared sandbox page).
const sandboxReady = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));

const t0 = performance.now();
const lap = (label) => console.info(`[webrecan] ${label}: ${Math.round(performance.now() - t0)} ms`);

try {
  const params = new URLSearchParams(location.search);
  const name = params.get("name") || "recording.jsonl.gz";
  document.title = `Recording Playback — ${name}`;
  $("filename").textContent = name;

  // Download and Python start-up are independent, so run them at the same time.
  const bytesPromise = download(params.get("url")).then((b) => (lap("downloaded"), step("download", "done"), b));
  bytesPromise.catch(() => step("download", "error"));
  const pyPromise = (async () => {
    const py = await loadPyodide({ indexURL: chrome.runtime.getURL("vendor/pyodide/") });
    lap("pyodide core loaded");
    await py.loadPackage(["jinja2", "pyyaml"]);
    await mountRecan(py, readBytes);
    lap("recan mounted");
    step("python", "done");
    return py;
  })();
  pyPromise.catch(() => step("python", "error"));
  const [bytes, py] = await Promise.all([bytesPromise, pyPromise]);

  step("recan", "active");
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));  // let the step paint before Python blocks
  let html;
  try {
    html = generateHtml(py, [{ name, bytes }], TA_OPTIONS);
  } catch (e) {
    step("recan", "error");
    throw e;
  }
  step("recan", "done");
  lap("recan finished");

  await sandboxReady;
  frame.contentWindow.postMessage({ type: "render", html }, "*");
  loading.style.display = "none";
  frame.style.display = "block";
  lap("shown");
} catch (e) {
  console.error("[webrecan]", e);
  $("card").classList.add("failed");
  $("title").textContent = "Couldn't open this recording";
  $("hint").hidden = true;
  $("error").hidden = false;
  $("error").textContent = e.message || String(e);
}
