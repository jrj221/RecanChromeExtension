// Checks the settings rules (src/settings.js): which files are hidden, how files are ordered, and that stored values
// are cleaned up; plus that the manifest wires the popup and the script together.  Usage: node test/settings.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "src/settings.js"), "utf8");
const { WEBRECAN_DEFAULTS, webrecanIgnored, webrecanCompareFiles, webrecanNormalize, webrecanIsDeadlineField, webrecanParseDateTime, webrecanFormatDateTime, webrecanTodayEndOfDay, webrecanIsAboutNow, webrecanMonthGrid } = new Function(
  `${source}; return { WEBRECAN_DEFAULTS, webrecanIgnored, webrecanCompareFiles, webrecanNormalize, webrecanIsDeadlineField, webrecanParseDateTime, webrecanFormatDateTime, webrecanTodayEndOfDay, webrecanIsAboutNow, webrecanMonthGrid };`,
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
assert.equal("surprise" in webrecanNormalize({ surprise: 1 }), false, "unknown keys are dropped");
assert.equal("hideNamesContaining" in webrecanNormalize({ hideNamesContaining: "x" }), false, "the removed custom-words setting is dropped");
console.log("ok   stored settings are cleaned up");

// ---- the Add Extension form's date picker ----
assert.equal(webrecanIsDeadlineField("override[settings][dueDate][value]"), true);
assert.equal(webrecanIsDeadlineField("override[settings][hardDueDate][value]"), true);
assert.equal(webrecanIsDeadlineField("override[settings][releaseDate][value]"), false, "the release date isn't a deadline");
assert.equal(webrecanIsDeadlineField("override[settings][dueDate][type]"), false);
assert.equal(webrecanIsDeadlineField(""), false);

assert.deepEqual(webrecanParseDateTime("2026-11-13T11:46"), { year: 2026, month: 11, day: 13, hour12: 11, minute: 46, pm: false });
assert.deepEqual(webrecanParseDateTime("2026-11-13T23:59"), { year: 2026, month: 11, day: 13, hour12: 11, minute: 59, pm: true });
assert.deepEqual(webrecanParseDateTime("2026-11-13T00:05"), { year: 2026, month: 11, day: 13, hour12: 12, minute: 5, pm: false }, "midnight is 12 AM");
assert.deepEqual(webrecanParseDateTime("2026-11-13T12:30:15"), { year: 2026, month: 11, day: 13, hour12: 12, minute: 30, pm: true }, "noon is 12 PM; seconds are ignored");
assert.equal(webrecanParseDateTime(""), null);
assert.equal(webrecanParseDateTime("tomorrow"), null);
for (const value of ["2026-11-13T00:00", "2026-11-13T09:07", "2026-11-13T12:00", "2026-11-13T13:45", "2026-11-13T23:59"]) {
  assert.equal(webrecanFormatDateTime(webrecanParseDateTime(value)), value, `${value} survives a round trip`);
}
assert.equal(webrecanFormatDateTime({ year: 2026, month: 3, day: 4, hour12: 12, minute: 0, pm: false }), "2026-03-04T00:00", "12 AM");
assert.equal(webrecanFormatDateTime({ year: 2026, month: 3, day: 4, hour12: 12, minute: 0, pm: true }), "2026-03-04T12:00", "12 PM");
assert.equal(webrecanTodayEndOfDay(new Date(2026, 10, 3, 9, 5)), "2026-11-03T23:59");

const now = new Date(2026, 10, 13, 11, 46);
assert.equal(webrecanIsAboutNow("2026-11-13T11:46", now), true, "the form's own starting value");
assert.equal(webrecanIsAboutNow("2026-11-13T11:50", now), true, "a few minutes off still counts");
assert.equal(webrecanIsAboutNow("2026-11-13T15:00", now), false, "a time someone chose");
assert.equal(webrecanIsAboutNow("2026-11-12T11:46", now), false, "yesterday isn't now");
assert.equal(webrecanIsAboutNow("", now), false);

// November 2026 starts on a Sunday; the calendar always shows 6 weeks, Sunday first
const nov = webrecanMonthGrid(2026, 11);
assert.equal(nov.length, 42);
assert.deepEqual(nov[0], { year: 2026, month: 11, day: 1, inMonth: true });
assert.deepEqual(nov[29], { year: 2026, month: 11, day: 30, inMonth: true });
assert.deepEqual(nov[30], { year: 2026, month: 12, day: 1, inMonth: false }, "the next month fills the last weeks");
// February 2026 starts on a Sunday too; March 2026 starts on a Sunday: use one that doesn't (October 2026 starts on a Thursday)
const oct = webrecanMonthGrid(2026, 10);
assert.deepEqual(oct[0], { year: 2026, month: 9, day: 27, inMonth: false }, "the days before the 1st come from the month before");
assert.deepEqual(oct[4], { year: 2026, month: 10, day: 1, inMonth: true });
const jan = webrecanMonthGrid(2027, 1);
assert.deepEqual(jan[0], { year: 2026, month: 12, day: 27, inMonth: false }, "across a year boundary");
const leap = webrecanMonthGrid(2028, 2);
assert.ok(leap.some((cell) => cell.inMonth && cell.day === 29), "29 February in a leap year");
assert.equal(webrecanMonthGrid(2027, 2).filter((cell) => cell.inMonth).length, 28);
assert.equal(WEBRECAN_DEFAULTS.extensionPicker, true);
console.log("ok   the Add Extension form: which fields get the picker, date and time conversion, and the calendar grid");

// ---- wiring ----
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
assert.deepEqual(manifest.content_scripts[0].js, ["src/settings.js", "src/extension-times.js", "src/content.js"], "settings.js loads before the scripts that use it");
assert.equal(manifest.action.default_popup, "src/popup.html");
const mainWorld = manifest.content_scripts.find((entry) => entry.world === "MAIN");
assert.deepEqual(mainWorld?.js, ["src/main-world-picker.js"], "the page-world script is declared to run in the page's own world");
assert.equal(mainWorld.run_at, "document_start", "and early, before the page can call showPicker()");
assert.deepEqual(mainWorld.matches, manifest.content_scripts[0].matches);
for (const file of ["src/popup.html", "src/popup.js", "src/popup.css", "src/settings.js", "src/extension-times.js", "src/main-world-picker.js"]) assert.ok(existsSync(resolve(root, file)), `${file} exists`);
const html = readFileSync(resolve(root, "src/popup.html"), "utf8");
assert.ok(html.indexOf('src="settings.js"') > -1 && html.indexOf('src="settings.js"') < html.indexOf('src="popup.js"'), "the popup loads settings.js first");
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline scripts (the extension's content security policy forbids them)");
const popup = readFileSync(resolve(root, "src/popup.js"), "utf8");
for (const key of Object.keys(WEBRECAN_DEFAULTS)) {
  if (key === "sortOrder") continue; // radio buttons, below
  assert.ok(html.includes(`id="${key}"`), `the popup has a control for ${key}`);
}
for (const order of ["recordings", "python", "default"]) assert.ok(html.includes(`name="sortOrder" value="${order}"`), `the popup has a radio button for the ${order} order`);
assert.ok(!html.includes("<select"), "the file order is radio buttons, not a dropdown");
assert.ok(popup.includes("webrecanNormalize"));
console.log("ok   the manifest and the popup are wired to the settings");
