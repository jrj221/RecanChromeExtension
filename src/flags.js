// Turns recan's analysis of one recording (one session from `recan summary --json`)
// into the things the extension flags. Idle time is defined exactly like recan's player
// (player.js mergedIdleIntervals): the union of "idle gap" and "unfocused" intervals.

export const MIN_ACTIVE_SECONDS = 2 * 60;

// Unapproved pastes shorter than this many lines are ignored: not counted, not flagged, not
// shown. Set to 1 to count every paste.
export const MIN_PASTED_LINES = 1;

// A pasted snippet can be huge (hundreds of thousands of characters). The viewer shows at most
// this many characters of each; the real size is still reported.
export const MAX_SNIPPET_CHARS = 20000;

// When a paste is shown inside the whole file, a very large file is cut to a window of at most
// this many characters around the paste.
export const MAX_FILE_CHARS = 100000;

const IDLE_KINDS = new Set(["idle_gap", "unfocused"]);

/**
 * The document as it was right after entry `index` of the recording: start from the latest
 * snapshot at or before it (or the recorder's initial snapshot) and replay the edits since.
 * Offsets are UTF-16 units, like the player's own replay.
 */
export function documentAt(session, index) {
  const entries = session.entries || [];
  let text = "";
  let from = 0;
  const snapshot = (session.snapshots || []).filter((s) => s.after_idx <= index).at(-1);
  if (snapshot) {
    text = snapshot.document_text;
    from = snapshot.after_idx + 1;
  } else {
    const initial = entries.findIndex((e) => e.type === "initialSnapshot");
    if (initial >= 0 && initial <= index) {
      text = entries[initial].document_text;
      from = initial + 1;
    }
  }
  for (let i = from; i <= index && i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "edit") text = text.slice(0, e.offset) + e.newFragment + text.slice(e.offset + e.oldFragment.length);
  }
  return text;
}

/**
 * Where the pasted text sits in the file once the whole paste is done. A paste is often followed,
 * within milliseconds, by the IDE re-indenting it, and recan reports the final text. So this
 * starts from the pasting edit and follows the pasted range through the edits that came after it
 * in the same burst (the same bookkeeping recan uses to find its final text). The result is only
 * trusted if it reproduces recan's text exactly; otherwise the text is searched for.
 */
function pasteRange(doc, entries, annotation) {
  const pasted = entries[annotation.source_entry];
  let start = pasted.offset;
  let end = start + pasted.newFragment.length;
  for (let i = annotation.source_entry + 1; i <= annotation.entry_end && i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "edit") continue;
    const editEnd = e.offset + e.oldFragment.length;
    const replacementEnd = e.offset + e.newFragment.length;
    const delta = replacementEnd - editEnd;
    if (editEnd <= start) {
      start += delta; // before the paste: it moves
      end += delta;
    } else if (e.offset >= end) {
      continue; // after the paste: it doesn't touch it
    } else {
      start = Math.min(start, e.offset); // overlaps it
      end = Math.max(replacementEnd, end + delta);
    }
  }
  start = Math.max(0, Math.min(start, doc.length));
  end = Math.max(start, Math.min(end, doc.length));
  if (doc.slice(start, end) === annotation.fragment) return [start, end];

  const found = annotation.fragment ? doc.indexOf(annotation.fragment, Math.max(0, start - 2000)) : -1;
  return found >= 0 ? [found, found + annotation.fragment.length] : null;
}

/**
 * The whole file at the end of an unapproved paste, with where the paste is.
 * Returns { text, start, end, firstLine } (the pasted text is text.slice(start, end), and
 * firstLine is the 1-based line number of the first line of `text`), or null when the
 * recording doesn't carry enough to rebuild the file (the viewer then shows just the paste).
 */
function fileAtPaste(session, annotation) {
  const entries = session.entries || [];
  const pasted = entries[annotation.source_entry];
  if (!pasted || pasted.type !== "edit" || typeof annotation.fragment !== "string") return null;
  const last = Math.max(annotation.source_entry, annotation.entry_end ?? annotation.source_entry);
  const doc = documentAt(session, last);
  const range = pasteRange(doc, entries, { ...annotation, entry_end: last });
  if (!range) return null; // the replay didn't line up; don't guess
  const [start, end] = range;

  if (doc.length <= MAX_FILE_CHARS) return { text: doc, start, end, firstLine: 1 };
  // A very large file: keep a window around the paste, starting at a line boundary.
  const wanted = Math.max(0, start - Math.floor(MAX_FILE_CHARS / 5));
  const from = doc.lastIndexOf("\n", wanted) + 1;
  const to = Math.min(doc.length, from + MAX_FILE_CHARS);
  return {
    text: doc.slice(from, to),
    start: start - from,
    end: Math.min(end, to) - from,
    firstLine: doc.slice(0, from).split("\n").length,
  };
}

export function evaluateSession(session) {
  const startMs = Date.parse(session.start_time);
  const endMs = Date.parse(session.end_time);
  const hasTimes = Number.isFinite(startMs) && Number.isFinite(endMs);
  const totalSeconds = hasTimes ? (endMs - startMs) / 1000 : 0;

  // Union of idle intervals, clipped to the recording.
  const intervals = [];
  if (hasTimes) {
    for (const a of session.annotations || []) {
      if (!IDLE_KINDS.has(a.kind)) continue;
      const from = Math.max(startMs, Date.parse(a.timestamp));
      const to = Math.min(endMs, Date.parse(a.end_timestamp));
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) intervals.push([from, to]);
    }
  }
  intervals.sort((x, y) => x[0] - y[0]);
  let idleMs = 0;
  let current = null;
  for (const [from, to] of intervals) {
    if (current && from <= current[1]) current[1] = Math.max(current[1], to);
    else {
      if (current) idleMs += current[1] - current[0];
      current = [from, to];
    }
  }
  if (current) idleMs += current[1] - current[0];
  const idleSeconds = idleMs / 1000;
  const activeSeconds = Math.max(0, totalSeconds - idleSeconds);

  const pastedLines = (a) => a.line_count ?? String(a.fragment ?? "").split("\n").length;
  const pastes = (session.annotations || []).filter((a) => a.kind === "unapproved_paste" && pastedLines(a) >= MIN_PASTED_LINES);
  const unapproved = {
    count: pastes.length,
    chars: pastes.reduce((n, a) => n + (a.char_count || 0), 0),
    // The pasted text of each one, in the order they happened (recan sorts annotations by time).
    snippets: pastes.map((a) => {
      const text = String(a.fragment ?? "");
      const at = Date.parse(a.timestamp);
      return {
        text: text.slice(0, MAX_SNIPPET_CHARS),
        truncated: text.length > MAX_SNIPPET_CHARS,
        chars: a.char_count ?? text.length,
        lines: a.line_count ?? text.split("\n").length,
        atSeconds: hasTimes && Number.isFinite(at) ? Math.max(0, (at - startMs) / 1000) : null, // into the recording
        file: fileAtPaste(session, a),
      };
    }),
  };

  // true = starts with the starter code, false = does not, null = not checked
  // (no starter files given, or none for this document).
  const starter = session.starts_with_starter_code ?? null;

  const flags = {
    lowActiveTime: activeSeconds < MIN_ACTIVE_SECONDS,
    unapprovedPastes: unapproved.count > 0,
    starterMismatch: starter === false,
  };
  return {
    document: session.document,
    totalSeconds,
    idleSeconds,
    activeSeconds,
    unapproved,
    starter,
    flags,
    flagged: Object.values(flags).some(Boolean),
  };
}

/** Parse the JSON `recan summary --json` printed for a single recording. */
export function evaluateSummaryJson(text) {
  const sessions = JSON.parse(text);
  if (!sessions.length) throw new Error("recan produced no analysis for this recording");
  return evaluateSession(sessions[0]);
}

export function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
