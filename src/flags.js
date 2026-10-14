// Turns recan's analysis of one recording (one session from `recan summary --json`)
// into the things the extension flags. Idle time is defined exactly like recan's player
// (player.js mergedIdleIntervals): the union of "idle gap" and "unfocused" intervals.

export const MIN_ACTIVE_SECONDS = 5 * 60;

// A pasted snippet can be huge (hundreds of thousands of characters). The viewer shows at most
// this many characters of each; the real size is still reported.
export const MAX_SNIPPET_CHARS = 20000;

const IDLE_KINDS = new Set(["idle_gap", "unfocused"]);

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

  const pastes = (session.annotations || []).filter((a) => a.kind === "unapproved_paste");
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
