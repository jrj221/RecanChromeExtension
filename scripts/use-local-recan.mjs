// FOR TESTING. Makes the extension run a local checkout of recan instead of the released upstream/ clone,
// so a recan change can be tried in the extension before it is merged.
//
//   node scripts/use-local-recan.mjs [path to the recan repo]     (default: ../code-recording-analysis)
//
// It copies <path>/recan/ into upstream-local/recan/ (git-ignored; a browser extension can only load files
// inside its own folder, so it has to be a copy) and points recan-files.json at it. Run it again after each
// change to recan, then reload the extension.
//
// To go back to the released recan, run `node scripts/setup.mjs`: it rewrites recan-files.json from upstream/.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = resolve(process.argv[2] ?? join(root, "..", "code-recording-analysis"));
const from = join(source, "recan");
if (!existsSync(join(from, "main.py"))) {
  console.error(`${from} doesn't look like recan's source (no main.py). Pass the path to the recan repo.`);
  process.exit(1);
}

const dest = join(root, "upstream-local", "recan");
rmSync(join(root, "upstream-local"), { recursive: true, force: true });
cpSync(from, dest, { recursive: true, filter: (path) => !/__pycache__|\.pyc$/.test(path) });
execFileSync(process.execPath, [join(here, "list-recan-files.mjs"), "--from", "upstream-local"], { stdio: "inherit" });

let state = "";
try {
  const git = (...args) => execFileSync("git", ["-C", source, ...args]).toString().trim();
  const dirty = git("status", "--porcelain") ? ", with uncommitted changes" : "";
  state = ` (${git("rev-parse", "--abbrev-ref", "HEAD")} @ ${git("rev-parse", "--short", "HEAD")}${dirty})`;
} catch {
  // not a git checkout: fine
}
console.log(`local recan ${readFileSync(join(dest, "VERSION"), "utf8").trim()}${state}, copied from ${from}`);
console.log("Reload the extension to use it. Run `node scripts/setup.mjs` to go back to the released recan.");
