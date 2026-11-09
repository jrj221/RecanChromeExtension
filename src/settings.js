// The extension's settings and the rules that depend on them. This is a plain script (not a module) because it is
// loaded two ways: as a content script next to content.js (which can't import modules), and by the toolbar popup
// (popup.html). Everything here is a global; nothing touches the page or the browser's storage.

const WEBRECAN_DEFAULTS = {
  hideTestFiles: true, // names starting with "test"
  hideInputOutputFiles: true, // "input" or "output" anywhere in the name
  hideInstructionsRecording: true, // instructions.recording.jsonl.gz
  sortOrder: "recordings", // "recordings" (recordings first), "python" (.py files first) or "default" (Gradescope's order)
  autoCollapse: true, // collapse the file Gradescope opens by default
};

const WEBRECAN_SORT_ORDERS = ["recordings", "python", "default"];

/** Is this file hidden (and ignored by the flag and quality checks)? Only the file's own name counts, not its folders. */
function webrecanIgnored(settings, path) {
  const name = String(path).split("/").pop().toLowerCase();
  if (settings.hideTestFiles && name.startsWith("test")) return true;
  if (settings.hideInstructionsRecording && name === "instructions.recording.jsonl.gz") return true;
  return !!settings.hideInputOutputFiles && (name.includes("input") || name.includes("output"));
}

/** 0 for the files that go on top in this order, 1 for the rest. */
function webrecanFileRank(order, name) {
  if (order === "recordings") return /\.gz(\?|$)/i.test(name) ? 0 : 1;
  if (order === "python") return /\.py$/i.test(name) ? 0 : 1;
  return 0;
}

/** Sort comparator for file names: the top group first, then alphabetical (numbers compared as numbers). */
function webrecanCompareFiles(order, a, b) {
  return webrecanFileRank(order, a) - webrecanFileRank(order, b) || a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Stored settings with anything missing or of the wrong kind replaced by its default. */
function webrecanNormalize(stored) {
  const out = { ...WEBRECAN_DEFAULTS };
  for (const key of Object.keys(WEBRECAN_DEFAULTS)) {
    if (typeof stored?.[key] === typeof WEBRECAN_DEFAULTS[key]) out[key] = stored[key];
  }
  if (!WEBRECAN_SORT_ORDERS.includes(out.sortOrder)) out.sortOrder = WEBRECAN_DEFAULTS.sortOrder;
  return out;
}
