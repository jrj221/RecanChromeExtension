// Checks the "Lock resubmission" pieces in content.js that don't need a page: the due date (yesterday 11:59 PM
// Mountain time, as UTC), the request body, and finding the student in the page's data.  Usage: node test/lock.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/content.js"), "utf8");
const section = source.slice(source.indexOf("// ---- lock resubmission ----"), source.indexOf("// ---- end lock resubmission ----"));
const { lockDueDate, isoNoMillis, lockBody, extensionBody, wallTime, fromWallTime, findOwner, parseExtensionsPage, effectiveDates, isLocked, describeDates } = new Function(`${section}; return { lockDueDate, isoNoMillis, lockBody, extensionBody, wallTime, fromWallTime, findOwner, parseExtensionsPage, effectiveDates, isLocked, describeDates };`)();

const due = (iso) => isoNoMillis(lockDueDate(new Date(iso)));
assert.equal(due("2026-11-09T20:36:00Z"), "2026-11-09T06:59:00Z", "Nov 9 1:36 PM MST -> Nov 8 11:59 PM MST");
assert.equal(due("2026-11-09T03:00:00Z"), "2026-11-08T06:59:00Z", "still Nov 8 evening in Denver -> Nov 7 11:59 PM");
assert.equal(due("2026-07-10T12:00:00Z"), "2026-07-10T05:59:00Z", "daylight saving (MDT, UTC-6)");
assert.equal(due("2026-03-08T20:00:00Z"), "2026-03-08T06:59:00Z", "the day clocks go forward: yesterday is still MST");
console.log("ok   due date: yesterday 11:59 PM Mountain, as UTC");

assert.deepEqual(lockBody(10050275, "2026-11-08T20:35:00Z"), {
  override: { user_id: 10050275, settings: { due_date: { type: "absolute", value: "2026-11-08T20:35:00Z" }, hard_due_date: { type: "none", value: "" }, visible: true } },
});
assert.equal(
  JSON.stringify(lockBody(10050275, "2026-11-08T20:35:00Z")),
  '{"override":{"user_id":10050275,"settings":{"due_date":{"type":"absolute","value":"2026-11-08T20:35:00Z"},"hard_due_date":{"type":"none","value":""},"visible":true}}}',
  "the same text Gradescope's own form sent",
);
console.log("ok   request body matches the captured one");

const root = (...blobs) => ({ querySelectorAll: () => blobs.map((b) => ({ getAttribute: () => (typeof b === "string" ? b : JSON.stringify(b)) })) });
const props = (ownerships, extra = {}) => ({ ownerships, ...extra });
assert.deepEqual(findOwner(root(props([{ id: 1, user_id: 77, active: true, uploader: true }]))), { userId: 77, name: "" });
assert.equal(findOwner(root(props([{ user_id: 77, active: true }, { user_id: 78, active: true }]))), null, "two owners (a group): refuse");
assert.deepEqual(findOwner(root(props([{ user_id: 77, active: true }, { user_id: 78, active: false }]))), { userId: 77, name: "" }, "inactive owners are ignored");
assert.equal(findOwner(root({ x: 1 })), null);
assert.equal(findOwner(root("not json \"ownerships\"")), null);
assert.equal(findOwner(root(props([{ user_id: 77 }], { course_members: [{ user_id: 77, full_name: "Ada Lovelace" }] }))).name, "Ada Lovelace");
console.log("ok   finding the student: one active owner, or nothing");

// The grade page: no ownerships, but the files carry the student's user_id and the submission names its owner.
const grade = (files, extra = {}) => ({ assignment: { group_submission: false }, submission: { owner_names: "Ada Lovelace" }, evaluation: { user_id: 999 }, files, ...extra });
assert.deepEqual(findOwner(root(grade([{ user_id: 55 }, { user_id: 55 }]))), { userId: 55, name: "Ada Lovelace" }, "every file names the same student");
assert.equal(findOwner(root(grade([{ user_id: 55 }, { user_id: 56 }]))), null, "files from different users: refuse");
assert.equal(findOwner(root(grade([]))), null, "no files, no id");
assert.equal(findOwner(root(grade([{ user_id: 55 }], { evaluation: { user_id: 999 } }))).userId, 55, "the grader's id (evaluation.user_id) is never used");
console.log("ok   finding the student on the grade page");

// Unlock: the date picker's values, and the request with a late due date or without one.
assert.equal(wallTime(new Date("2026-11-10T06:59:00Z")), "2026-11-09T23:59", "UTC to Mountain wall time");
assert.equal(isoNoMillis(fromWallTime("2026-11-09T23:59")), "2026-11-10T06:59:00Z", "and back");
assert.equal(isoNoMillis(fromWallTime("2026-07-10T09:00")), "2026-07-10T15:00:00Z", "daylight saving (UTC-6)");
assert.equal(fromWallTime(""), null);
assert.equal(fromWallTime("tomorrow"), null);
const now = new Date("2026-11-09T20:36:00Z");
assert.equal(wallTime(lockDueDate(now, -1)), "2026-11-10T23:59", "the picker starts at tomorrow 11:59 PM");
assert.equal(wallTime(lockDueDate(now)), "2026-11-08T23:59", "lock still means yesterday");
assert.deepEqual(extensionBody(5, "2026-11-12T06:59:00Z").override.settings.hard_due_date, { type: "none", value: "" }, "the late due date is always removed");
assert.deepEqual(extensionBody(5, "2026-11-12T06:59:00Z", "2026-11-13T06:59:00Z"), lockBody(5, "2026-11-12T06:59:00Z"), "a late due date can't be passed in");
console.log("ok   unlock: date picker values and request body");

// Lock or unlock? Read from the Extensions page's data (shapes copied from a real page).
const tz = { abbr: "MST", zone: "Mountain Time (US & Canada)", identifier: "America/Denver" };
const base = { release_date: "2026-09-02T00:00", due_date: "2026-09-08T23:59", hard_due_date: "2026-09-15T23:59" };
const extRow = (userId, settings, window = base) => ({ override: { user_id: userId, settings: { visible: true, ...settings } }, inheritedOverride: false, assignment: base, fallbackSubmissionWindow: window, timezone: tz, userId });
const abs = (value) => ({ type: "absolute", value });
const none = { type: "none", value: "" };
const pageOf = (...blobs) => parseExtensionsPage(root(...blobs, { overrides: {}, studentSubmissionWindows: { 3816873: { ...base, due_date: "2026-09-09T23:59", hard_due_date: "2026-09-16T23:59" } }, assignment: base, timezone: tz }));
const data = pageOf(
  extRow(5882243, { due_date: abs("2026-11-07T23:59"), hard_due_date: none }), // a lock: due passed, late removed
  extRow(10050412, { due_date: abs("2026-09-15T23:59") }), // only a due date: the late date stays the assignment's
  extRow(10050581, { hard_due_date: abs("2026-09-30T23:59") }), // only a late date: the due date stays the assignment's
  extRow(7048746, { due_date: abs("2026-09-24T23:59"), hard_due_date: abs("2026-10-26T11:12") }),
  extRow(10050454, { due_date: abs("2026-12-20T23:59"), hard_due_date: none }, { ...base, due_date: "2026-09-09T23:59", hard_due_date: "2026-09-16T23:59" }),
);
const iso = (d) => (d ? isoNoMillis(d) : d);

let eff = effectiveDates(data, 5882243);
assert.deepEqual([iso(eff.due), eff.late, eff.from], ["2026-11-08T06:59:00Z", null, "extension"]);
assert.equal(isLocked(eff, now), true, "due date passed, no late date: locked");

eff = effectiveDates(data, 10050412);
assert.deepEqual([iso(eff.due), iso(eff.late)], ["2026-09-16T05:59:00Z", "2026-09-16T05:59:00Z"], "an unset late date is the assignment's");
eff = effectiveDates(data, 10050581);
assert.deepEqual([iso(eff.due), iso(eff.late)], ["2026-09-09T05:59:00Z", "2026-10-01T05:59:00Z"], "an unset due date is the assignment's");

eff = effectiveDates(data, 7048746);
assert.equal(isLocked(eff, new Date("2026-10-01T00:00:00Z")), false, "past the due date but inside the late window: not locked");
assert.equal(isLocked(eff, now), true, "after the late due date: locked");

eff = effectiveDates(data, 10050454);
assert.equal(isLocked(eff, now), false, "an extension into the future: not locked");
assert.equal(iso(eff.due), "2026-12-21T06:59:00Z");

eff = effectiveDates(data, 3816873);
assert.deepEqual([eff.from, iso(eff.due), iso(eff.late)], ["assignment", "2026-09-10T05:59:00Z", "2026-09-17T05:59:00Z"], "no extension: their section's window");
assert.equal(isLocked(eff, now), true, "an old assignment with no extension counts as locked");

eff = effectiveDates(data, 424242);
assert.deepEqual([eff.from, iso(eff.due)], ["assignment", "2026-09-09T05:59:00Z"], "unknown student: the assignment's own dates");

assert.equal(isLocked({ due: null, late: null }, now), false, "no dates at all: not locked");
assert.match(describeDates(effectiveDates(data, 5882243)), /^Current due date: Nov 7, 2026, 11:59 PM\n\(from their extension\)$/);
assert.match(describeDates(effectiveDates(data, 7048746)), /Current late due date: Oct 26, 2026, 11:12 AM/);
assert.equal(describeDates(null), "Couldn't read their current dates.");
assert.equal(isoNoMillis(fromWallTime("2026-11-07T23:59:30")), "2026-11-08T06:59:00Z", "seconds are accepted");
console.log("ok   lock or unlock: current dates read from the Extensions page");

// The page's group_submission field only says groups are allowed; submissions here are individual, so it's ignored.
const flagged = (extra = {}) => ({ assignment: { group_submission: true }, submission: { assignment_submission_id: 443327677, owner_names: "Ada Lovelace" }, files: [{ user_id: 4146090 }, { user_id: 4146090 }], ...extra });
assert.deepEqual(findOwner(root(flagged())), { userId: 4146090, name: "Ada Lovelace" }, "group_submission: true doesn't stop it");
assert.equal(findOwner(root(flagged({ files: [{ user_id: 1 }, { user_id: 2 }] }))), null, "files from different users: still refused");
console.log("ok   the group_submission field is ignored");
