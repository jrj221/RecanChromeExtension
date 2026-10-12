// Check that the extension's Pyodide pipeline gives byte-identical output to the real
// recan command-line tool, for both outputs the extension uses:
//   recan view    <recording> [--starter-code ...] --exclude .html   (the player page)
//   recan summary <recording> --json [--starter-code ...] --exclude .html   (the data behind the red flag)
//
// Usage: RECAN=/path/to/recan [STARTER_DIR=folder-of-.py] node test/parity.mjs <dir-or-file.gz ...>
// Run `node scripts/setup.mjs` first. Recordings are student work: keep them outside the repo.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { TA_OPTIONS, generateHtml, generateSummary, mountRecan } from "../src/runner.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const starterDir = process.env.STARTER_DIR;
const starterNames = starterDir ? readdirSync(starterDir).filter((f) => f.endsWith(".py")).sort() : [];
const options = {
  ...TA_OPTIONS,
  starterCode: starterNames.map((f) => ({ name: f, text: readFileSync(join(starterDir, f), "utf8") })),
};

function collect(args) {
  const out = [];
  for (const a of args) {
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a).sort()) if (f.endsWith(".gz")) out.push(join(a, f));
    } else out.push(a);
  }
  return out;
}

/** Run the real CLI; kind is "view" or "summary". Returns its output, or { cliError }. */
function cli(kind, files) {
  const dir = mkdtempSync(join(tmpdir(), "recan-cli-"));
  const copies = files.map((f) => {
    const dst = join(dir, basename(f));
    copyFileSync(f, dst);
    return dst;
  });
  const args = kind === "view" ? ["view", "--no-open", ...copies] : ["summary", ...copies, "--json", "--output", join(dir, "out.json")];
  if (starterNames.length) args.push("--starter-code", ...starterNames.map((f) => join(starterDir, f)));
  args.push("--exclude", ...TA_OPTIONS.exclude);
  try {
    execFileSync(process.env.RECAN || "recan", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { cliError: String(e.stderr || e.message).trim().split("\n").pop() };
  }
  if (kind === "summary") return readFileSync(join(dir, "out.json"), "utf8");
  const html = readdirSync(dir).filter((f) => f.endsWith(".html"));
  return readFileSync(join(dir, html[0]), "utf8"); // named after the first recording
}

const files = collect(process.argv.slice(2));
if (!files.length) throw new Error("no recordings given");

const py = await loadPyodide({ indexURL: join(root, "vendor/pyodide") + "/" });
await py.loadPackage(["jinja2", "pyyaml"]);
await mountRecan(py, async (path) => new Uint8Array(readFileSync(join(root, path))));

console.log(`starter code: ${starterNames.length ? starterNames.join(", ") : "none"}`);
const groups = [...files.map((f) => [f]), ...(files.length > 1 ? [files] : [])];
let failed = 0;
for (const group of groups) {
  const label = group.length === 1 ? basename(group[0]) : `all ${group.length} together`;
  const recordings = group.map((f) => ({ name: basename(f), bytes: new Uint8Array(readFileSync(f)) }));
  for (const [kind, make] of [["view", generateHtml], ["summary", generateSummary]]) {
    const expected = cli(kind, group);
    if (expected.cliError) {
      console.log(`skip ${label} [${kind}]: CLI raised: ${expected.cliError}`);
      continue;
    }
    const t0 = performance.now();
    const ours = make(py, recordings, options);
    const ms = Math.round(performance.now() - t0);
    const same = ours === expected;
    console.log(`${same ? "ok  " : "FAIL"} ${label} [${kind}]  (${(ours.length / 1e3).toFixed(0)} KB, pyodide ${ms} ms)`);
    if (!same) failed++;
  }
}
process.exit(failed ? 1 : 0);
