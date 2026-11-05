// One command for first-time setup AND for picking up a new upstream release.
// Safe to re-run: Pyodide is only downloaded once, upstream is `git pull`ed.
//
//   node scripts/setup.mjs                         required steps only
//   node scripts/setup.mjs --with-course-content   also fetch starter code, instructions and test output
//
// The course-content steps need access to the private course repo, so a failure there is reported and setup
// carries on.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = (script) => execFileSync(process.execPath, [join(here, script)], { stdio: "inherit" });

const FLAG = "--with-course-content";
const OPTIONAL = ["fetch-starter-code.mjs", "fetch-instructions.mjs", "fetch-test-output.mjs"];

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== FLAG);
if (unknown.length) {
  console.error(`Unknown argument: ${unknown.join(" ")}\nUsage: node scripts/setup.mjs [${FLAG}]`);
  process.exit(2);
}

for (const script of ["vendor-pyodide.mjs", "fetch-upstream.mjs", "list-recan-files.mjs"]) run(script);

if (args.includes(FLAG)) {
  const failed = [];
  for (const script of OPTIONAL) {
    try {
      run(script);
    } catch {
      failed.push(script);
    }
  }
  if (failed.length) {
    console.log(`\nSkipped (failed, probably no access to the course repo): ${failed.join(", ")}`);
    console.log("Setup is otherwise complete; the extension works without them. Re-run any of them on its own later.");
  }
} else {
  console.log(`\nSkipped the optional course-content steps. Add ${FLAG} to run them.`);
}
