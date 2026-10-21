// Viewer tab: asks the recan engine for the player page and shows it. The engine
// (offscreen.js) does the download and runs upstream recan; this page only drives the
// loading screen and displays the result.
const loading = document.getElementById("loading");
const frame = document.getElementById("player");
const $ = (id) => document.getElementById(id);

/** state: "pending" | "active" | "done" | "error" */
const step = (id, state) => ($(`step-${id}`).dataset.state = state);

async function ask(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error || "no response from the extension");
  return res;
}

// The generated page has inline scripts, which extension pages forbid, so it is
// rendered by sandbox.html (a manifest-declared sandbox page).
const sandboxReady = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));

const t0 = performance.now();
const lap = (label) => console.info(`[webrecan] ${label}: ${Math.round(performance.now() - t0)} ms`);

try {
  const params = new URLSearchParams(location.search);
  const name = params.get("name") || "recording.jsonl.gz";
  const job = { url: params.get("url"), name, assignmentId: params.get("assignmentId"), recordingNames: JSON.parse(params.get("recordingNames") || "[]") };
  document.title = `Recording Playback — ${name}`;
  $("filename").textContent = name;

  // Starting Python and downloading are independent, so do both at once.
  const downloading = ask({ type: "fetch", url: job.url }).then(() => (lap("downloaded"), step("download", "done")));
  const starting = ask({ type: "warm" }).then(() => (lap("python ready"), step("python", "done")));
  downloading.catch(() => step("download", "error"));
  starting.catch(() => step("python", "error"));
  await Promise.all([downloading, starting]);

  step("recan", "active");
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r))); // let the step paint
  let html;
  try {
    ({ html } = await ask({ type: "render", ...job }));
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
