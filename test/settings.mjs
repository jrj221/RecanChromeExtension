// Checks the settings rules (src/settings.js): which files are hidden, how files are ordered, and that stored values
// are cleaned up; plus that the manifest wires the popup and the script together.  Usage: node test/settings.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "src/settings.js"), "utf8");
const { WEBRECAN_DEFAULTS, webrecanIgnored, webrecanCompareFiles, webrecanNormalize, webrecanCustomWords } = new Function(
  `${source}; return { WEBRECAN_DEFAULTS, webrecanIgnored, webrecanCompareFiles, webrecanNormalize, webrecanCustomWords };`,
)();

// ---- hidden files ----
const hidden = (settings, name) => webrecanIgnored({ ...WEBRECAN_DEFAULTS, ...settings }, name);

for (const name of [
  "test_words.py", "test_words.recording.jsonl.gz", "Test_Words.py", "hw/sub/test_x.py", "instructions.recording.jsonl.gz",
  "words_output.py", "input.py", "inputs.py", "my_outputs.py", "get_input_value.py", "nan_input.txt", "words_1.input.txt", "OutputFormatter.py",
]) assert.equal(hidden({}, name), true, `${name} is hidden by default`);
for (const name of ["words.py", "words.recording.jsonl.gz", "contest.py", "puts.py", "big_words.py", "hw/input/solution.py", "output/hello.py"]) {
  assert.equal(hidden({}, name), false, `${name} is shown by default`);
}
console.log("ok   default hiding: test files, input/output files, the instructions recording");

assert.equal(hidden({ hideTestFiles: false }, "test_words.py"), false);
assert.equal(hidden({ hideTestFiles: false }, "words_output.py"), true, "the other rules still apply");
assert.equal(hidden({ hideInputOutputFiles: false }, "words_output.py"), false);
assert.equal(hidden({ hideInputOutputFiles: false }, "test_words.py"), true);
assert.equal(hidden({ hideInstructionsRecording: false }, "instructions.recording.jsonl.gz"), false);
assert.equal(hidden({ hideInstructionsRecording: false }, "my_instructions.recording.jsonl.gz"), false, "only that exact name");
assert.equal(hidden({ hideTestFiles: false, hideInputOutputFiles: false, hideInstructionsRecording: false }, "test_output.py"), false, "everything off: nothing is hidden");
console.log("ok   each hiding rule can be switched off on its own");

assert.deepEqual(webrecanCustomWords(" Scratch,  OLD_ ,, "), ["scratch", "old_"]);
assert.deepEqual(webrecanCustomWords(""), []);
assert.equal(hidden({ hideNamesContaining: "scratch, old_" }, "my_Scratch_file.py"), true);
assert.equal(hidden({ hideNamesContaining: "scratch, old_" }, "OLD_words.py"), true);
assert.equal(hidden({ hideNamesContaining: "scratch, old_" }, "words.py"), false);
assert.equal(hidden({ hideNamesContaining: "," }, "words.py"), false, "an empty word hides nothing");
assert.equal(hidden({ hideNamesContaining: "work" }, "work/words.py"), false, "folders aren't part of the name");
console.log("ok   extra words to hide");

// ---- order ----
const order = (mode, names) => [...names].sort((a, b) => webrecanCompareFiles(mode, a, b));
const names = ["b.py", "a.py", "z.recording.jsonl.gz", "a.recording.jsonl.gz", "notes.txt", "lab10.py", "lab2.py"];
assert.deepEqual(order("recordings", names), ["a.recording.jsonl.gz", "z.recording.jsonl.gz", "a.py", "b.py", "lab2.py", "lab10.py", "notes.txt"]);
assert.deepEqual(order("python", names), ["a.py", "b.py", "lab2.py", "lab10.py", "a.recording.jsonl.gz", "notes.txt", "z.recording.jsonl.gz"]);
console.log("ok   file order: recordings first, or .py files first; alphabetical within each group");

// ---- stored values ----
assert.deepEqual(webrecanNormalize(undefined), WEBRECAN_DEFAULTS);
assert.deepEqual(webrecanNormalize({}), WEBRECAN_DEFAULTS);
assert.equal(webrecanNormalize({ sortOrder: "python" }).sortOrder, "python");
assert.equal(webrecanNormalize({ sortOrder: "sideways" }).sortOrder, "recordings", "an unknown order falls back");
assert.equal(webrecanNormalize({ autoCollapse: "yes" }).autoCollapse, true, "a value of the wrong kind falls back");
assert.equal(webrecanNormalize({ autoCollapse: false }).autoCollapse, false);
assert.equal(webrecanNormalize({ hideNamesContaining: 5 }).hideNamesContaining, "");
assert.equal("surprise" in webrecanNormalize({ surprise: 1 }), false, "unknown keys are dropped");
console.log("ok   stored settings are cleaned up");

// ---- wiring ----
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
assert.deepEqual(manifest.content_scripts[0].js, ["src/settings.js", "src/content.js"], "settings.js loads before content.js");
assert.equal(manifest.action.default_popup, "src/popup.html");
for (const file of ["src/popup.html", "src/popup.js", "src/popup.css", "src/settings.js"]) assert.ok(existsSync(resolve(root, file)), `${file} exists`);
const html = readFileSync(resolve(root, "src/popup.html"), "utf8");
assert.ok(html.indexOf('src="settings.js"') > -1 && html.indexOf('src="settings.js"') < html.indexOf('src="popup.js"'), "the popup loads settings.js first");
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline scripts (the extension's content security policy forbids them)");
const popup = readFileSync(resolve(root, "src/popup.js"), "utf8");
for (const key of Object.keys(WEBRECAN_DEFAULTS)) assert.ok(html.includes(`id="${key}"`), `the popup has a control for ${key}`);
assert.ok(popup.includes("webrecanNormalize"));
console.log("ok   the manifest and the popup are wired to the settings");
