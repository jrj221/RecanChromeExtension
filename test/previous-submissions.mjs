// Checks how the extension reads the autograder's "Previous Submission(s)" test from the page's embedded data.
// content.js is a content script, not a module, so the code is cut out of the file and run with a fake page.
//
// Usage: node test/previous-submissions.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/content.js"), "utf8");
const section = source.slice(
  source.indexOf('// ---- autograder: the "Previous submissions" test ----'),
  source.indexOf("// ---- placing the buttons ----"),
);

/** What the red box would say for a page whose embedded data is `props` (a string is used as-is, as a broken blob). */
function flagFor(...blobs) {
  const nodes = blobs.map((b) => ({ getAttribute: () => (typeof b === "string" ? b : JSON.stringify(b)) }));
  const document = { querySelectorAll: () => nodes };
  return new Function("document", `${section}; return previousSubmissionsFlag();`)(document);
}

const test = (fields) => ({
  name: "Previous Submission(s)", tags: null, score: 0.0, number: null, output: "You have made 0 previous submissions.",
  status: "passed", max_score: 0.0, extra_data: null, visibility: null, name_format: "text", output_format: "text",
  show_test_to_students: true, ...fields,
});
const page = (...tests) => ({ assignment: { title: "Homework 4b" }, results: { tests } });
const other = { name: "doubles", score: 0, max_score: 4, status: "failed", output: "AssertionError: ..." };

// The real data from a grade page: passed, 0 of 0 points, no earlier submissions.
assert.equal(flagFor(page(other, test({}))), null);
console.log("ok   passed with 0 previous submissions: nothing to flag, even when another test failed");

const FAILED = "the “Previous Submission(s)” test failed";
assert.equal(flagFor(page(test({ status: "failed" }))), FAILED);
assert.equal(flagFor(page(test({ status: "failed", output: "You have made 2 previous submissions." }))), FAILED);
assert.equal(flagFor(page(test({ status: undefined }))), FAILED, "no status: it doesn't say passed");
assert.equal(flagFor(page(test({ status: "PASSED" }))), null, "case doesn't matter");
console.log("ok   anything that doesn't say passed: flagged as failed");

assert.equal(flagFor(page(other)), null, "no such test on the page");
assert.equal(flagFor("not json {Previous Submission"), null, "a blob that isn't JSON is skipped");
assert.equal(flagFor({ x: 1 }), null, "a blob without the test is skipped");
assert.equal(flagFor("{bad Previous Submission", page(test({ status: "failed" }))), FAILED, "later blobs are still read");
assert.equal(flagFor(page({ ...other, name: "Something else", output: "previous submission failed" })), null, "only the test's name counts");
console.log("ok   no test, broken data, or other tests mentioning the words: nothing to flag");
