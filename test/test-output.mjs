// Checks that the expected test output (what Gradescope shows as "expected"), passed to recan as
// --approved-pastes, stops a paste of it being counted as an unapproved paste. Needs `node scripts/setup.mjs`;
// the last check also needs `node scripts/fetch-test-output.mjs` and is skipped without it.
//
// Usage: node test/test-output.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { evaluateSession } from "../src/flags.js";
import { TA_OPTIONS, generateSummary, mountRecan } from "../src/runner.js";
import { expectedOutputText } from "../src/starter.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- the markup is removed exactly as the autograder does it (compared with byu_pytest_utils on every fetched file) ---
const DIALOG = "What items are out of stock?\nItem: <<bread>>\nItem: <<>>\n``\n;apples;10````I'm sorry,;sorry;20`` the item ``BREAD;upper-case;20`` is out of stock.\n";
assert.equal(
  expectedOutputText(DIALOG, "dialog"),
  "What items are out of stock?\nItem: bread\nItem: \n\nI'm sorry, the item BREAD is out of stock.\n",
);
assert.equal(expectedOutputText("a <<b>> ``c;name;5`` d", "dialog"), "a b c d", "dialog: inputs and groups");
assert.equal(expectedOutputText("a <<b>> ``c;name;5`` d", "expected"), "a <<b>> c d", "an expected file only has groups");
assert.equal(expectedOutputText("plain text\n", "dialog"), "plain text\n", "no markup: unchanged");
console.log("ok   expected output text has the autograder's markup removed");

// --- recan approves a paste of it ---
const py = await loadPyodide({ indexURL: resolve(root, "vendor/pyodide/") });
await py.loadPackage(["jinja2", "pyyaml"]);
await mountRecan(py, async (path) => new Uint8Array(readFileSync(resolve(root, path))));

const edit = (ts, doc, offset, oldFragment, newFragment) => ({
  type: "edit", editor: "jetbrains", recorderVersion: "x", timestamp: ts, document: doc, offset, oldFragment, newFragment,
});
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 10, 0, seconds)).toISOString();
const gz = (events) => new Uint8Array(gzipSync(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
const doc = "C:\\Users\\s\\hw\\out_of_stock.py";
const run = (pasted, approvedPastes) => {
  const recordings = [{ name: "000_out_of_stock.recording.jsonl.gz", bytes: gz([edit(at(0), doc, 0, "", pasted)]) }];
  return evaluateSession(JSON.parse(generateSummary(py, recordings, { ...TA_OPTIONS, approvedPastes }))[0]);
};

const MESSAGE = "I'm sorry, the item BREAD is out of stock.";
assert.equal(run(MESSAGE, []).unapproved.count, 1, "without it, the message is an unapproved paste");
const sources = [expectedOutputText(DIALOG, "dialog"), expectedOutputText("unrelated\n", "dialog")];
assert.equal(run(MESSAGE, sources).unapproved.count, 0, "with it, the message is approved");
assert.equal(run("print('never in any output')\n", sources).unapproved.count, 1, "other text is still unapproved");
// Each file is its own source: text that runs from the end of one file into the start of the next isn't approved.
assert.equal(run("out of stock.\nunrelated\n", sources).unapproved.count, 1, "a paste can't span two files");
console.log("ok   a paste of the expected test output is approved, other pastes aren't, and files stay separate");

// --- the real course content, when it has been fetched ---
const indexPath = resolve(root, "test-output.json");
if (existsSync(indexPath)) {
  const files = JSON.parse(readFileSync(indexPath, "utf8")).assignments["unit4-strings/day4b-substrings/homework4b"];
  const real = files.map((f) => expectedOutputText(readFileSync(resolve(root, f.src), "utf8"), f.kind));
  assert.equal(run(MESSAGE, []).unapproved.count, 1);
  assert.equal(run(MESSAGE, real).unapproved.count, 0, "homework4b's real expected output approves the BREAD message");
  console.log("ok   homework4b's real test output approves 'I'm sorry, the item BREAD is out of stock.'");
} else {
  console.log("skip homework4b check: run `node scripts/fetch-test-output.mjs` first");
}
