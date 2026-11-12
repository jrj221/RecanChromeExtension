// Checks default-approved-pastes.txt: how it is split, and that pasting one of its entries is approved
// for every assignment (it is passed to recan as --approved-pastes). Needs `node scripts/setup.mjs`.
//
// Usage: node test/default-approved-pastes.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { evaluateSession } from "../src/flags.js";
import { TA_OPTIONS, generateSummary, mountRecan } from "../src/runner.js";
import { parseDefaultApprovedPastes } from "../src/starter.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- parsing ----
assert.deepEqual(parseDefaultApprovedPastes("a\nb\n---\nc\n"), ["a\nb", "c"]);
assert.deepEqual(parseDefaultApprovedPastes("a\r\n---\r\nb\r\n"), ["a", "b"], "CRLF is accepted");
assert.deepEqual(parseDefaultApprovedPastes("\n---\n\n---\na\n---  \n"), ["a"], "blank entries are dropped");
assert.deepEqual(parseDefaultApprovedPastes("x --- y\n"), ["x --- y"], "only a line of just --- separates");
console.log("ok   entries are split on a line containing only ---");

const defaults = parseDefaultApprovedPastes(readFileSync(resolve(root, "default-approved-pastes.txt"), "utf8"));
assert.ok(defaults.length >= 3, "the real file has entries");
assert.ok(defaults.every((entry) => !entry.includes("---")), "no entry contains the separator");
console.log(`ok   default-approved-pastes.txt has ${defaults.length} entries`);

// ---- end to end ----
const py = await loadPyodide({ indexURL: resolve(root, "vendor/pyodide/") });
await py.loadPackage(["jinja2", "pyyaml"]);
await mountRecan(py, async (path) => new Uint8Array(readFileSync(resolve(root, path))));

const edit = (ts, doc, offset, oldFragment, newFragment) => ({
  type: "edit", editor: "jetbrains", recorderVersion: "x", timestamp: ts, document: doc, offset, oldFragment, newFragment,
});
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 10, 0, seconds)).toISOString();
const gz = (events) => new Uint8Array(gzipSync(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
const doc = "C:\\Users\\s\\hw\\project.py";
const recording = (pasted) => [{ name: "000_project.recording.jsonl.gz", bytes: gz([edit(at(0), doc, 0, "", pasted)]) }];
const run = (pasted, approvedPastes) =>
  evaluateSession(JSON.parse(generateSummary(py, recording(pasted), { ...TA_OPTIONS, approvedPastes }))[0]);

for (const pasted of ["if __name__ == '__main__':", 'if __name__ == "__main__":', "if __name__  ==  '__main__':", "import sys\n"]) {
  assert.equal(run(pasted, []).unapproved.count, 1, `without the defaults ${JSON.stringify(pasted)} is unapproved`);
  assert.equal(run(pasted, defaults).unapproved.count, 0, `with the defaults ${JSON.stringify(pasted)} is approved`);
}
console.log("ok   pasting a default entry is approved with the defaults and unapproved without them");

assert.equal(run("if __name__ == '__main__':\n    evil()\n", defaults).unapproved.count, 1, "a near miss is still unapproved");
console.log("ok   a near miss of a default entry is still unapproved");
