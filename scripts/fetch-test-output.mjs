// OPTIONAL. Fetches each CS110 assignment's expected test output so the extension can pass it to recan as
// --approved-pastes: the Gradescope test results show students the expected output, so a student who copies
// a line from it (an error message, a prompt) isn't pasting something unapproved.
//
// Needs access to the private BYU-CS-Course-Ops/CS110-course-content repo. Without it, git cannot
// clone and this script stops with an "unauthorized" message; the extension works fine without it,
// it just skips the test output.
//
// Run scripts/fetch-starter-code.mjs too: the extension picks an assignment from its starter files, and
// the test output is looked up for that assignment.
//
// What it fetches, from each assignment's test_files/ folder (solutions/, solution/ or assignment/):
//   dialog files   the expected conversation of a program, with the autograder's markup in it (<<inputs>> and
//                  ``grouped text;name;weight``). That's every *.dialog.txt, plus any other file the assignment's
//                  tests pass to dialog(...) (project4's one_guess_win.txt, ...). The extension removes the markup
//                  the same way the autograder does, which leaves exactly the text Gradescope shows as "expected".
//   *.expected*    expected output files, shown as-is.
// Input data (word lists, books, csv files, ...) is not used, even though it sits in the same folder.
//
// What it does:
//   1. Clones the repo into test-output-source/ (git-ignored) as a sparse, shallow clone, so only those
//      files are downloaded (under 1 MB) instead of the whole 500+ MB repo. Labs are skipped:
//      students don't submit them, so they never have recordings to check.
//   2. Writes test-output.json (git-ignored): assignment id -> its files, which is what the extension
//      reads. The id is the assignment folder relative to canvas/, the same id starter-code.json uses.
//      Safe to re-run: it pulls new changes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/BYU-CS-Course-Ops/CS110-course-content.git";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test-output-source");
const posix = (path) => path.split(sep).join("/");

// Students don't submit labs (lab1a, old-lab2a-if-else, ...), so they are never needed.
const isLab = (folderName) => /^(old-)?lab/i.test(folderName);
const SPARSE_PATTERNS = [
  "/canvas/**/test_files/*.txt",
  "/canvas/**/test_files/*.expected*",
  "/canvas/**/solutions/test*.py",
  "/canvas/**/solution/test*.py",
  "!/canvas/old-content/",
  "!/canvas/**/lab*/**",
  "!/canvas/**/old-lab*/**",
  "!/canvas/**/old-solutions/**",
];
// An assignment's test_files sit in one of these folders, which sit directly in the assignment folder.
const TEST_FILE_PARENTS = new Set(["solutions", "solution", "assignment"]);

const git = (...args) => execFileSync("git", args, { stdio: "inherit" });

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

let created = false;
try {
  if (existsSync(join(dir, ".git"))) {
    git("-C", dir, "pull", "--ff-only");
    // Re-apply the patterns, in case they changed since this clone was made.
    git("-C", dir, "sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS);
  } else {
    created = true;
    // Without line-ending conversion, so files are byte-identical on every OS.
    git("-c", "core.autocrlf=false", "clone", "--filter=blob:none", "--no-checkout", "--depth", "1", REPO, dir);
    git("-C", dir, "sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS);
    git("-C", dir, "checkout");
  }
} catch {
  // Remove a half-made clone, but never an existing good one (e.g. if a pull fails offline).
  if (created) rmSync(dir, { recursive: true, force: true });
  fail(
    "Could not download the CS110 test output.\n" +
      "This optional step needs access to the private repo BYU-CS-Course-Ops/CS110-course-content.\n" +
      "If git asked you to sign in, use a GitHub account that is in the BYU-CS-Course-Ops organization;\n" +
      "an 'unauthorized' or 'repository not found' error means the account has no access.\n" +
      "You can skip this step: the extension works without it, it just won't use the test output.",
  );
}

// ---- build test-output.json ----

const canvas = join(dir, "canvas");
const assignments = {};

// The files an assignment's tests pass to dialog(...): `dialog(test_files / "out_of_stock.dialog.txt", ...)`.
function dialogFilesUsedBy(testsDir) {
  const names = new Set();
  for (const f of readdirSync(testsDir)) {
    if (!/^test.*\.py$/.test(f)) continue;
    const text = readFileSync(join(testsDir, f), "utf8");
    for (const m of text.matchAll(/\bdialog\(\s*test_files\s*\/\s*(['"])([^'"]+)\1/g)) names.add(m[2]);
  }
  return names;
}

function walk(current, assignmentDir) {
  for (const name of readdirSync(current).sort()) {
    if (name === "old-content" || name === "old-solutions" || name.startsWith(".")) continue;
    const path = join(current, name);
    if (!statSync(path).isDirectory()) continue;
    if (isLab(name)) continue;
    if (name === "test_files" && assignmentDir) {
      const dialogs = dialogFilesUsedBy(current);
      const kindOf = (f) => (f.endsWith(".dialog.txt") || dialogs.has(f) ? "dialog" : f.includes(".expected") ? "expected" : null);
      const files = readdirSync(path)
        .filter((f) => kindOf(f) && statSync(join(path, f)).isFile())
        .sort()
        .map((f) => ({ name: f, src: posix(relative(root, join(path, f))), kind: kindOf(f) }));
      if (files.length) (assignments[posix(relative(canvas, assignmentDir))] ??= []).push(...files);
    } else {
      // A solutions/, solution/ or assignment/ folder belongs to the folder it is in.
      walk(path, TEST_FILE_PARENTS.has(name) ? current : assignmentDir);
    }
  }
}
walk(canvas, null);

const commit = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"]).toString().trim();
writeFileSync(join(root, "test-output.json"), JSON.stringify({ commit, assignments }, null, 1));
const fileCount = Object.values(assignments).reduce((n, files) => n + files.length, 0);
console.log(`test-output.json: ${Object.keys(assignments).length} assignments, ${fileCount} files (course content ${commit})`);
