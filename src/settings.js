// The extension's settings and the rules that depend on them. This is a plain script (not a module) because it is
// loaded two ways: as a content script next to content.js (which can't import modules), and by the toolbar popup
// (popup.html). Everything here is a global; nothing touches the page or the browser's storage.

const WEBRECAN_DEFAULTS = {
  hideTestFiles: true, // names starting with "test"
  hideInputOutputFiles: true, // "input" or "output" anywhere in the name
  hideInstructionsRecording: true, // instructions.recording.jsonl.gz
  sortOrder: "recordings", // "recordings" (recordings first), "python" (.py files first) or "default" (Gradescope's order)
  autoCollapse: true, // collapse the file Gradescope opens by default
  extensionPicker: true, // on the Add Extension form, WebRecan's own date and time picker for the due and late due date fields (src/extension-times.js)
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

// ---- the Add Extension form (see extension-times.js) ----

const webrecanPad2 = (n) => String(n).padStart(2, "0");

/** Is this one of the form's due or late due date fields (not the release date)? */
function webrecanIsDeadlineField(name) {
  return /\[(dueDate|hardDueDate)\]\[value\]$/.test(String(name || ""));
}

/** "2026-11-13T11:46" -> { year, month (1-12), day, hour12 (1-12), minute, pm }; null if it isn't a date and time. */
function webrecanParseDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || ""));
  if (!m) return null;
  const hour24 = Number(m[4]);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour12: hour24 % 12 || 12, minute: Number(m[5]), pm: hour24 >= 12 };
}

/** The reverse: a datetime-local field's value, "2026-11-13T23:59". */
function webrecanFormatDateTime({ year, month, day, hour12, minute, pm }) {
  const hour24 = (hour12 % 12) + (pm ? 12 : 0);
  return `${year}-${webrecanPad2(month)}-${webrecanPad2(day)}T${webrecanPad2(hour24)}:${webrecanPad2(minute)}`;
}

/** Today at 11:59 PM, in the browser's time zone, as a datetime-local field writes it. */
function webrecanTodayEndOfDay(now = new Date()) {
  return webrecanFormatDateTime({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour12: 11, minute: 59, pm: true });
}

/** Is this the form's own starting value (about the time it was opened), as opposed to something chosen? */
function webrecanIsAboutNow(value, now = new Date(), toleranceMinutes = 5) {
  if (!webrecanParseDateTime(value)) return false;
  const when = new Date(value); // no zone in the string: read as the browser's own time
  return Number.isFinite(when.getTime()) && Math.abs(when.getTime() - now.getTime()) <= toleranceMinutes * 60 * 1000;
}

/** The 6 weeks (42 days, Sunday first) a calendar shows for a month (1-12): { year, month, day, inMonth }. */
function webrecanMonthGrid(year, month) {
  const start = new Date(year, month - 1, 1 - new Date(year, month - 1, 1).getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), inMonth: d.getMonth() === month - 1 };
  });
}
