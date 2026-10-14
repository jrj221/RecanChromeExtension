// Tests for src/flags.js: how recan's analysis becomes the flags and the pasted-code snippets.
//
// Usage: node test/flags.mjs [folder-of-.gz-recordings]
// The synthetic cases always run. With a folder of recordings (kept outside the repo: they are student
// work) it also checks the snippets against recan's real output. Needs `node scripts/setup.mjs`.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_CHARS, MAX_SNIPPET_CHARS, MIN_PASTED_LINES, documentAt, evaluateSession, evaluateSummaryJson } from "../src/flags.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const test = (name, fn) => {
  fn();
  checks++;
  console.log(`ok   ${name}`);
};

const session = (annotations) => ({
  start_time: "2026-10-04T02:00:00.000000Z",
  end_time: "2026-10-04T03:00:00.000000Z",
  annotations,
  starts_with_starter_code: null,
});
const lines = (n) => Array.from({ length: n }, (_, i) => `line${i}`).join("\n"); // n lines of text
const paste = (fragment, at, extra = {}) => ({
  kind: "unapproved_paste",
  timestamp: at,
  fragment,
  char_count: fragment.length,
  // Long enough to count, unless a test sets line_count itself.
  line_count: Math.max(MIN_PASTED_LINES, fragment.split("\n").length),
  ...extra,
});

test("no pastes: count 0 and no snippets", () => {
  const { unapproved, flags } = evaluateSession(session([]));
  assert.deepEqual(unapproved, { count: 0, chars: 0, snippets: [] });
  assert.equal(flags.unapprovedPastes, false);
});

test("each unapproved paste becomes a snippet, in order, with its text, size and time", () => {
  const { unapproved, flags } = evaluateSession(
    session([
      paste("print('a')\nprint('b')\nprint('c')", "2026-10-04T02:10:30.000000Z"),
      { kind: "approved_paste", timestamp: "2026-10-04T02:20:00.000000Z", fragment: "skip me", char_count: 7, line_count: 1 },
      paste("x = 1\ny = 2\nz = 3", "2026-10-04T02:45:00.500000Z"),
    ]),
  );
  assert.equal(flags.unapprovedPastes, true);
  assert.equal(unapproved.count, 2);
  assert.equal(unapproved.chars, 32 + 17);
  assert.deepEqual(unapproved.snippets.map((s) => s.text), ["print('a')\nprint('b')\nprint('c')", "x = 1\ny = 2\nz = 3"]);
  assert.deepEqual(unapproved.snippets.map((s) => s.lines), [3, 3]);
  assert.deepEqual(unapproved.snippets.map((s) => s.chars), [32, 17]);
  assert.deepEqual(unapproved.snippets.map((s) => s.atSeconds), [630, 2700.5]); // seconds after the recording started
  assert.deepEqual(unapproved.snippets.map((s) => s.truncated), [false, false]);
});

test("pastes shorter than MIN_PASTED_LINES are not counted, flagged or shown", () => {
  const at = "2026-10-04T02:10:00.000000Z";
  const short = evaluateSession(session([paste(lines(MIN_PASTED_LINES - 1), at, { line_count: MIN_PASTED_LINES - 1 })]));
  assert.deepEqual(short.unapproved, { count: 0, chars: 0, snippets: [] });
  assert.equal(short.flags.unapprovedPastes, false);
  const exact = evaluateSession(session([paste(lines(MIN_PASTED_LINES), at), paste("one liner", at, { line_count: 1 })]));
  assert.equal(exact.unapproved.count, 1);
  assert.equal(exact.flags.unapprovedPastes, true);
});

test("a huge paste is cut to the limit but its real size is kept", () => {
  const big = "a".repeat(MAX_SNIPPET_CHARS * 3);
  const [snippet] = evaluateSession(session([paste(big, "2026-10-04T02:10:00.000000Z")])).unapproved.snippets;
  assert.equal(snippet.text.length, MAX_SNIPPET_CHARS);
  assert.equal(snippet.truncated, true);
  assert.equal(snippet.chars, MAX_SNIPPET_CHARS * 3);
});

test("a paste exactly at the limit is not marked truncated", () => {
  const [snippet] = evaluateSession(session([paste("b".repeat(MAX_SNIPPET_CHARS), "2026-10-04T02:10:00.000000Z")])).unapproved.snippets;
  assert.equal(snippet.truncated, false);
});

test("text that could be mistaken for markup is kept as plain text", () => {
  const evil = "<img src=x onerror=alert(1)><script>boom()</script>";
  assert.equal(evaluateSession(session([paste(evil, "2026-10-04T02:10:00.000000Z")])).unapproved.snippets[0].text, evil);
});

test("a recording with no usable times still lists the pastes, without a time", () => {
  const s = { annotations: [paste("x", "2026-10-04T02:10:00.000000Z")] };
  const [snippet] = evaluateSession(s).unapproved.snippets;
  assert.equal(snippet.atSeconds, null);
  assert.equal(snippet.text, "x");
});

test("missing fragment or sizes don't crash", () => {
  const s = session([{ kind: "unapproved_paste", timestamp: "2026-10-04T02:10:00.000000Z", line_count: MIN_PASTED_LINES }]);
  const [snippet] = evaluateSession(s).unapproved.snippets;
  assert.equal(snippet.text, "");
  assert.equal(snippet.chars, 0);
});

// ---- the whole file at the moment of a paste ----

// entries: 0 initial "xa\nb\n" | 1 types "x" | 2 pastes "P1\nP2\n" before the "b" | 3 deletes the "x"
const fileSession = (extra = {}) => ({
  start_time: "2026-10-04T02:00:00.000000Z",
  end_time: "2026-10-04T03:00:00.000000Z",
  starts_with_starter_code: null,
  entries: [
    { type: "initialSnapshot", document_text: "a\nb\n" },
    { type: "edit", offset: 0, oldFragment: "", newFragment: "x" },
    { type: "edit", offset: 3, oldFragment: "", newFragment: "P1\nP2\n" },
    { type: "edit", offset: 0, oldFragment: "x", newFragment: "" },
  ],
  snapshots: [],
  annotations: [{ ...paste("P1\nP2\n", "2026-10-04T02:10:00.000000Z"), source_entry: 2, entry_start: 2, entry_end: 2 }],
  ...extra,
});

test("documentAt replays the edits from the initial snapshot", () => {
  const s = fileSession();
  assert.equal(documentAt(s, 0), "a\nb\n");
  assert.equal(documentAt(s, 1), "xa\nb\n");
  assert.equal(documentAt(s, 2), "xa\nP1\nP2\nb\n");
  assert.equal(documentAt(s, 3), "a\nP1\nP2\nb\n");
});

test("documentAt starts from the latest snapshot when there is one, and gets the same answer", () => {
  const s = fileSession({ snapshots: [{ after_idx: 1, document_text: "xa\nb\n" }] });
  for (let i = 0; i <= 3; i++) assert.equal(documentAt(s, i), documentAt(fileSession(), i), `index ${i}`);
  // a snapshot that is wrong proves it is really used as the starting point
  const lie = fileSession({ snapshots: [{ after_idx: 1, document_text: "SNAPSHOT" }] });
  assert.equal(documentAt(lie, 2), "SNAP1\nP2\nPSHOT"); // the paste (offset 3) lands inside the snapshot text
});

test("the paste comes with the whole file at the end of the paste and where the paste is in it", () => {
  const { file } = evaluateSession(fileSession()).unapproved.snippets[0];
  assert.equal(file.text, "xa\nP1\nP2\nb\n"); // right after the paste (the next edit is a separate action)
  assert.equal(file.text.slice(file.start, file.end), "P1\nP2\n");
  assert.deepEqual([file.start, file.end, file.firstLine], [3, 9, 1]);
});

test("an IDE re-indent right after the paste is included, and the highlight is recan's final text", () => {
  const first = "    p1\n";
  const s = {
    start_time: "2026-10-04T02:00:00.000000Z",
    end_time: "2026-10-04T03:00:00.000000Z",
    entries: [
      { type: "initialSnapshot", document_text: "a\nb\n" },
      { type: "edit", offset: 2, oldFragment: "", newFragment: first + "            p2\n" }, // pasted with 12 spaces on line 2
      { type: "edit", offset: 2 + first.length, oldFragment: "            p2", newFragment: "    p2" }, // the IDE fixes it
      { type: "edit", offset: 0, oldFragment: "a", newFragment: "A" }, // a later, separate edit
    ],
    snapshots: [],
    annotations: [{ ...paste(first + "    p2\n", "2026-10-04T02:10:00.000000Z"), source_entry: 1, entry_end: 2 }],
  };
  const { file } = evaluateSession(s).unapproved.snippets[0];
  assert.equal(file.text, "a\n    p1\n    p2\nb\n"); // after the fix-up, before the later edit
  assert.equal(file.text.slice(file.start, file.end), "    p1\n    p2\n");
});

test("a re-indent BEFORE the paste in the same burst moves the highlight with it", () => {
  const s = {
    start_time: "2026-10-04T02:00:00.000000Z",
    end_time: "2026-10-04T03:00:00.000000Z",
    entries: [
      { type: "initialSnapshot", document_text: "a\nb\n" },
      { type: "edit", offset: 2, oldFragment: "", newFragment: "NEW1\nNEW2\n" },
      { type: "edit", offset: 0, oldFragment: "a", newFragment: "ab" }, // a line above grows by one character
    ],
    snapshots: [],
    annotations: [{ ...paste("NEW1\nNEW2\n", "2026-10-04T02:10:00.000000Z"), source_entry: 1, entry_end: 2 }],
  };
  const { file } = evaluateSession(s).unapproved.snippets[0];
  assert.equal(file.text, "ab\nNEW1\nNEW2\nb\n");
  assert.equal(file.text.slice(file.start, file.end), "NEW1\nNEW2\n");
});

test("a recording without the edit history falls back to the pasted text alone", () => {
  const { entries, ...without } = fileSession();
  assert.equal(evaluateSession(without).unapproved.snippets[0].file, null);
  assert.equal(evaluateSession(without).unapproved.snippets[0].text, "P1\nP2\n");
});

test("an edit past the end of the file is still found by its text", () => {
  const s = fileSession();
  s.entries[2] = { type: "edit", offset: 999, oldFragment: "", newFragment: "P1\nP2\n" }; // lands at the end of the file
  const { file } = evaluateSession(s).unapproved.snippets[0];
  assert.equal(file.text, "xa\nb\nP1\nP2\n");
  assert.equal(file.text.slice(file.start, file.end), "P1\nP2\n");
});

test("if recan's pasted text can't be found in the rebuilt file, it doesn't guess", () => {
  const s = fileSession();
  s.annotations[0].fragment = "TEXT THAT IS NOWHERE IN THE FILE";
  const [snippet] = evaluateSession(s).unapproved.snippets;
  assert.equal(snippet.file, null);
  assert.equal(snippet.text, "TEXT THAT IS NOWHERE IN THE FILE"); // the viewer still has the pasted text to show
});

test("the paste annotation pointing at something that isn't an edit gives no file, not a crash", () => {
  const s = fileSession();
  s.annotations[0].source_entry = 0; // the initial snapshot
  assert.equal(evaluateSession(s).unapproved.snippets[0].file, null);
  s.annotations[0].source_entry = 99; // out of range
  assert.equal(evaluateSession(s).unapproved.snippets[0].file, null);
});

test("a very large file is cut to a window around the paste, on a line boundary, with the right line numbers", () => {
  const line = "x".repeat(99) + "\n";
  const big = line.repeat(3000); // 300,000 characters
  const at = 200 * 100; // start of line 201
  const s = {
    start_time: "2026-10-04T02:00:00.000000Z",
    end_time: "2026-10-04T03:00:00.000000Z",
    entries: [
      { type: "initialSnapshot", document_text: big },
      { type: "edit", offset: at, oldFragment: "", newFragment: "PASTED\nCODE\n" },
    ],
    snapshots: [],
    annotations: [{ ...paste("PASTED\nCODE\n", "2026-10-04T02:10:00.000000Z"), source_entry: 1 }],
  };
  const { file } = evaluateSession(s).unapproved.snippets[0];
  assert.ok(file.text.length <= MAX_FILE_CHARS);
  assert.equal(file.text.slice(file.start, file.end), "PASTED\nCODE\n");
  assert.ok(file.text.startsWith("x"), "starts at the beginning of a line");
  const before = documentAt(s, 1).slice(0, at + 0).split("\n").length - 1; // lines before the paste
  const shownBefore = file.text.slice(0, file.start).split("\n").length - 1;
  assert.equal(file.firstLine + shownBefore, before + 1, "line numbers still match the real file");
});

// ---- against recan's real output ----
const folder = process.argv[2];
if (folder) {
  const { loadPyodide } = await import("../vendor/pyodide/pyodide.mjs");
  const { TA_OPTIONS, generateSummary, mountRecan } = await import("../src/runner.js");
  const py = await loadPyodide({ indexURL: join(root, "vendor/pyodide") + "/" });
  await py.loadPackage(["jinja2", "pyyaml"]);
  await mountRecan(py, async (path) => new Uint8Array(readFileSync(join(root, path))));

  let total = 0;
  for (const name of readdirSync(folder).filter((f) => f.endsWith(".gz")).sort()) {
    const json = generateSummary(py, [{ name, bytes: new Uint8Array(readFileSync(join(folder, name))) }], TA_OPTIONS);
    const raw = JSON.parse(json)[0].annotations.filter((a) => a.kind === "unapproved_paste");
    const { unapproved } = evaluateSummaryJson(json);
    assert.equal(unapproved.snippets.length, raw.length, `${name}: one snippet per unapproved paste`);
    raw.forEach((a, i) => {
      const s = unapproved.snippets[i];
      assert.equal(s.text, a.fragment.slice(0, MAX_SNIPPET_CHARS), `${name} #${i + 1}: text`);
      assert.equal(s.chars, a.char_count, `${name} #${i + 1}: characters`);
      assert.equal(s.lines, a.line_count, `${name} #${i + 1}: lines`);
      assert.ok(s.atSeconds >= 0, `${name} #${i + 1}: has a time`);
      // the whole file at that moment, with the pasted text exactly where the highlight says
      assert.ok(s.file, `${name} #${i + 1}: the file could be rebuilt`);
      if (!s.truncated) assert.equal(s.file.text.slice(s.file.start, s.file.end), s.text, `${name} #${i + 1}: highlight is the pasted text`);
      assert.ok(s.file.text.length >= s.file.end - s.file.start, `${name} #${i + 1}: file contains the paste`);
    });
    if (name.startsWith("multi")) {
      // each later paste is put at the top, so the file grows and still holds the earlier pastes and the starter lines
      const files = unapproved.snippets.map((s) => s.file.text);
      assert.ok(files.every((f) => f.endsWith("def solve():\n    pass\n")), "multi: starter code at the end of each file");
      assert.ok(files[1].includes(unapproved.snippets[0].text) && files[2].includes(unapproved.snippets[1].text), "multi: earlier pastes are in later files");
      assert.ok(!files[0].includes(unapproved.snippets[1].text), "multi: the file is shown AT that moment, before later pastes");
    }
    total += raw.length;
    checks++;
    console.log(`ok   ${name}: ${raw.length} unapproved paste(s) match recan's output exactly`);
  }
  console.log(`     (${total} real pastes checked)`);
}
console.log(`\n${checks} checks passed`);
