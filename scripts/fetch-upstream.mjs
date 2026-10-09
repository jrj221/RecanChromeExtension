// Get (or update) upstream's recan source in upstream/ — a plain git clone of the
// BYU-CS-Course-Ops repo. Read-only: we never commit or push to it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/BYU-CS-Course-Ops/code-recording-analysis.git";
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "upstream");
const git = (...args) => execFileSync("git", args, { stdio: "inherit" });

if (existsSync(join(dir, ".git"))) {
  git("-C", dir, "pull", "--ff-only");
} else {
  git("clone", REPO, dir);
}
const version = readFileSync(join(dir, "recan", "VERSION"), "utf8").trim();
console.log(`upstream recan ${version}`);
