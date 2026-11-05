// Checks that the assignment's instructions, passed to recan as --approved-pastes, stop a paste of
// sample output from the instructions being counted as an unapproved paste. Needs `node scripts/setup.mjs`.
//
// Usage: node test/instructions.mjs
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

// A made-up instructions file (CRLF line endings, like a Windows checkout): prose and a sample-output block.
const SAMPLE = "Team Bigs\nTotal members: 2\nAverage age: 14\nYoungest age: 13\n";
const INSTRUCTIONS = `# Project\r\n\r\nHere is some sample output:\r\n\r\n\`\`\`\r\n${SAMPLE.replace(/\n/g, "\r\n")}\`\`\`\r\n`;

const edit = (ts, doc, offset, oldFragment, newFragment) => ({
  type: "edit", editor: "jetbrains", recorderVersion: "x", timestamp: ts, document: doc, offset, oldFragment, newFragment,
});
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 10, 0, seconds)).toISOString();
const gz = (events) => new Uint8Array(gzipSync(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
const doc = "C:\\Users\\s\\hw\\project.py";
const recording = (pasted) => [{ name: "000_project.recording.jsonl.gz", bytes: gz([edit(at(0), doc, 0, "", pasted)]) }];
const run = (pasted, approvedPastes) =>
  evaluateSession(JSON.parse(generateSummary(py, recording(pasted), { ...TA_OPTIONS, approvedPastes }))[0]);

const without = run(SAMPLE, []);
assert.equal(without.unapproved.count, 1, "without instructions the sample output is an unapproved paste");
console.log("ok   no instructions: a paste of sample output is unapproved");

const withIt = run(SAMPLE, [INSTRUCTIONS]);
assert.equal(withIt.unapproved.count, 0, "with instructions the sample output is approved");
console.log("ok   with instructions: a paste of sample output is approved");

const other = run("print('something the instructions never mention')\n", [INSTRUCTIONS]);
assert.equal(other.unapproved.count, 1, "a paste that is not in the instructions is still unapproved");
console.log("ok   with instructions: a paste that isn't in them is still unapproved");

const empty = run("print('hi, nothing approved here')\n", [""]);
assert.equal(empty.unapproved.count, 1, "an empty instructions file approves nothing");
console.log("ok   an empty instructions file approves nothing");

// Instructions are Markdown with hard-wrapped lists; students paste what the rendered page shows (no `1.`/`-`
// markers, one line per item). Needs a recan that matches loosely (0.2.27+, or the local copy).
const LIST_INSTRUCTIONS = "Write a program that:\n\n1. Using a sequence of inputs, prompt the person for a list of out-of-stock\n   items\n2. Using a sequence of inputs, prompt the person for the items they would like\n   to purchase\n   - If the item is out-of-stock, inform the person\n";
const rendered = "Using a sequence of inputs, prompt the person for a list of out-of-stock items\nUsing a sequence of inputs, prompt the person for the items they would like to purchase\nIf the item is out-of-stock, inform the person";
assert.equal(run(rendered, []).unapproved.count, 1, "the rendered list is unapproved without the instructions");
assert.equal(run(rendered, [LIST_INSTRUCTIONS]).unapproved.count, 0, "the rendered list matches the Markdown source");
console.log("ok   a list copied from the rendered instructions matches their wrapped Markdown source");
