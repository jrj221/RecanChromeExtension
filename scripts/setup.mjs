// One command for first-time setup AND for picking up a new upstream release.
// Safe to re-run: Pyodide is only downloaded once, upstream is `git pull`ed.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const script of ["vendor-pyodide.mjs", "fetch-upstream.mjs", "list-recan-files.mjs"]) {
  execFileSync(process.execPath, [join(here, script)], { stdio: "inherit" });
}
