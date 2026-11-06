// OPTIONAL. Fetches each CS110 assignment's instructions.md so the extension can pass it to recan as
// --approved-pastes: pasting the sample output (or code) given in the instructions is then an approved
// paste, not an unapproved one. The autograder will do the same.
//
// Needs access to the private BYU-CS-Course-Ops/CS110-course-content repo. Without it, git cannot
// clone and this script stops with an "unauthorized" message; the extension works fine without it,
// it just skips the instructions.
//
// Run scripts/fetch-starter-code.mjs too: the extension picks an assignment from its starter files, and
// the instructions are looked up for that assignment.
//
// What it does:
//   1. Clones the repo into instructions-source/ (git-ignored) as a sparse, shallow clone, so only the
//      instructions.md files are downloaded instead of the whole 500+ MB repo. Labs are skipped:
//      students don't submit them, so they never have recordings to check. A progress check keeps its
//      instructions in solution/instructions.md; that one file is used (see instructions-index.mjs).
//   2. Writes instructions.json (git-ignored): assignment id -> instructions path, which is what the
//      extension reads. The id is the assignment folder relative to canvas/, the same id
//      starter-code.json uses. Safe to re-run: it pulls new changes.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstructions } from "./instructions-index.mjs";

const REPO = "https://github.com/BYU-CS-Course-Ops/CS110-course-content.git";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "instructions-source");

const SPARSE_PATTERNS = [
  "/canvas/**/instructions.md",
  "!/canvas/old-content/",
  "!/canvas/**/lab*/**",
  "!/canvas/**/old-lab*/**",
];

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
    "Could not download the CS110 instructions.\n" +
      "This optional step needs access to the private repo BYU-CS-Course-Ops/CS110-course-content.\n" +
      "If git asked you to sign in, use a GitHub account that is in the BYU-CS-Course-Ops organization;\n" +
      "an 'unauthorized' or 'repository not found' error means the account has no access.\n" +
      "You can skip this step: the extension works without it, it just won't use the instructions.",
  );
}

// ---- build instructions.json ----

const assignments = findInstructions(join(dir, "canvas"), root);

const commit = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"]).toString().trim();
writeFileSync(join(root, "instructions.json"), JSON.stringify({ commit, assignments }, null, 1));
console.log(`instructions.json: ${Object.keys(assignments).length} instructions (course content ${commit})`);
