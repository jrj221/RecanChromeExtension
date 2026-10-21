// Checks the reason the extension analyzes a submission's recordings together: code typed in one
// file and pasted into another is an "internal paste" when recan sees both recordings, and an
// unapproved paste when it sees only the second. Needs `node scripts/setup.mjs`.
//
// Usage: node test/cross-file.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { evaluateSession } from "../src/flags.js";
import { TA_OPTIONS, generateSummary, mountRecan } from "../src/runner.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const py = await loadPyodide({ indexURL: resolve(root, "vendor/pyodide/") });
await py.loadPackage(["jinja2", "pyyaml"]);
await mountRecan(py, async (path) => new Uint8Array(readFileSync(resolve(root, path))));

const CODE = "x = compute(1)\ny = compute(2)\nz = x + y\nprint(z)\n";
const edit = (ts, doc, offset, oldFragment, newFragment) => ({
  type: "edit", editor: "jetbrains", recorderVersion: "x", timestamp: ts, document: doc, offset, oldFragment, newFragment,
});
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 10, 0, seconds)).toISOString();
const gz = (events) => new Uint8Array(gzipSync(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));

// wrong_file.py: the code is typed here, one character at a time, then cut out again.
const wrong = "C:\\Users\\s\\hw\\wrong_file.py";
const typed = [...CODE].map((ch, i) => edit(at(i), wrong, i, "", ch));
typed.push(edit(at(100), wrong, 0, CODE, ""));
// right_file.py: much later, the same code arrives in one paste.
const right = "C:\\Users\\s\\hw\\right_file.py";
const pasted = [edit(at(300), right, 0, "", CODE)];

const files = { wrong: gz(typed), right: gz(pasted) };
const sessions = (list) =>
  JSON.parse(generateSummary(py, list.map(([name, bytes]) => ({ name, bytes })), TA_OPTIONS)).map(evaluateSession);

const alone = sessions([["001_right.recording.jsonl.gz", files.right]]);
assert.equal(alone[0].unapproved.count, 1, "alone: the paste looks unapproved");

// The extension numbers the names (000_, 001_...) so recan's sorted order is the order sent.
const together = sessions([["000_wrong.recording.jsonl.gz", files.wrong], ["001_right.recording.jsonl.gz", files.right]]);
assert.equal(together.length, 2);
assert.equal(together[0].document, "wrong_file");
assert.equal(together[1].document, "right_file", "results come back in the order the files were sent");
assert.equal(together[1].unapproved.count, 0, "together: the code came from the other file, so it is an internal paste");
console.log("ok   a paste of code from another recording is internal only when both recordings are analyzed together");
