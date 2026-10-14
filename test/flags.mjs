// Tests for src/flags.js: how recan's analysis becomes the flags and the pasted-code snippets.
//
// Usage: node test/flags.mjs [folder-of-.gz-recordings]
// The synthetic cases always run. With a folder of recordings (kept outside the repo: they are student
// work) it also checks the snippets against recan's real output. Needs `node scripts/setup.mjs`.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SNIPPET_CHARS, evaluateSession, evaluateSummaryJson } from "../src/flags.js";

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
const paste = (fragment, at, extra = {}) => ({
  kind: "unapproved_paste",
  timestamp: at,
  fragment,
  char_count: fragment.length,
  line_count: fragment.split("\n").length,
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
      paste("print('a')\nprint('b')", "2026-10-04T02:10:30.000000Z"),
      { kind: "approved_paste", timestamp: "2026-10-04T02:20:00.000000Z", fragment: "skip me", char_count: 7, line_count: 1 },
      paste("x = 1", "2026-10-04T02:45:00.500000Z"),
    ]),
  );
  assert.equal(flags.unapprovedPastes, true);
  assert.equal(unapproved.count, 2);
  assert.equal(unapproved.chars, 21 + 5);
  assert.deepEqual(unapproved.snippets.map((s) => s.text), ["print('a')\nprint('b')", "x = 1"]);
  assert.deepEqual(unapproved.snippets.map((s) => s.lines), [2, 1]);
  assert.deepEqual(unapproved.snippets.map((s) => s.chars), [21, 5]);
  assert.deepEqual(unapproved.snippets.map((s) => s.atSeconds), [630, 2700.5]); // seconds after the recording started
  assert.deepEqual(unapproved.snippets.map((s) => s.truncated), [false, false]);
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
  const s = session([{ kind: "unapproved_paste", timestamp: "2026-10-04T02:10:00.000000Z" }]);
  const [snippet] = evaluateSession(s).unapproved.snippets;
  assert.equal(snippet.text, "");
  assert.equal(snippet.chars, 0);
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
    });
    total += raw.length;
    checks++;
    console.log(`ok   ${name}: ${raw.length} unapproved paste(s) match recan's output exactly`);
  }
  console.log(`     (${total} real pastes checked)`);
}
console.log(`\n${checks} checks passed`);
