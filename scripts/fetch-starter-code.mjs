// OPTIONAL. Fetches the CS110 starter code so the extension can check each recording
// against the assignment's starter files (the same check the autograder does).
//
// Needs access to the private BYU-CS-Course-Ops/CS110-course-content repo. Without
// it, git cannot clone and this script stops with an "unauthorized" message; the
// extension works fine without it, it just skips the starter-code checks.
//
// What it does:
//   1. Clones the repo into starter-code-source/ (git-ignored) as a sparse, shallow
//      clone, so only the starter .py files are downloaded (about 1 MB) instead of
//      the whole 500+ MB repo. Labs are skipped:
//      students don't submit them, so they never have recordings to check.
//   2. Writes starter-code.json (git-ignored): the list of assignments and their files,
//      which is what the extension reads. Safe to re-run: it pulls new changes.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/BYU-CS-Course-Ops/CS110-course-content.git";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "starter-code-source");
const posix = (path) => path.split(sep).join("/");

// Students don't submit labs (lab1a, old-lab2a-if-else, ...), so they are never needed.
const isLab = (folderName) => /^(old-)?lab/i.test(folderName);
const SPARSE_PATTERNS = [
  "/canvas/**/assignment/*.py",
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
    "Could not download the CS110 starter code.\n" +
      "This optional step needs access to the private repo BYU-CS-Course-Ops/CS110-course-content.\n" +
      "If git asked you to sign in, use a GitHub account that is in the BYU-CS-Course-Ops organization;\n" +
      "an 'unauthorized' or 'repository not found' error means the account has no access.\n" +
      "You can skip this step: the extension works without it, it just won't check starter code.",
  );
}

// ---- build starter-code.json ----

const canvas = join(dir, "canvas");
const folders = [];

function walk(current) {
  for (const name of readdirSync(current).sort()) {
    if (name === "old-content" || name.startsWith(".")) continue;
    const path = join(current, name);
    if (!statSync(path).isDirectory()) continue;
    if (name === "assignment") {
      // The autograder image does `ADD assignment/*.py`: direct children only.
      const files = readdirSync(path)
        .filter((f) => f.endsWith(".py") && statSync(join(path, f)).isFile())
        .sort();
      if (files.length) {
        const assignment = dirname(path);
        if (isLab(basename(assignment))) continue;
        folders.push({
          id: posix(relative(canvas, assignment)),
          name: basename(assignment),
          files: files.map((f) => ({ name: f, src: posix(relative(root, join(path, f))) })),
        });
      }
    } else {
      walk(path);
    }
  }
}
walk(canvas);

const commit = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"]).toString().trim();
writeFileSync(join(root, "starter-code.json"), JSON.stringify({ commit, folders }, null, 1));
const fileCount = folders.reduce((n, f) => n + f.files.length, 0);
console.log(`starter-code.json: ${folders.length} assignments, ${fileCount} starter files (course content ${commit})`);
