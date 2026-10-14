// Check that checker/quality.py gives identical results in the extension's Python (Pyodide)
// and in regular Python, on every .py file in the folders you give it.
//
// Usage: [PYTHON=python3] node test/quality-parity.mjs <folder-or-file.py ...>
// Needs `node scripts/setup.mjs` to have been run (for Pyodide). No recan needed.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { checkQuality, mountChecker } from "../src/quality.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collect(paths) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
    else if (p.endsWith(".py")) out.push(p);
  };
  paths.forEach(walk);
  return out;
}

const paths = collect(process.argv.slice(2));
if (!paths.length) throw new Error("no .py files given");
const files = paths.map((p) => ({ name: p, text: readFileSync(p, "utf8") }));

const py = await loadPyodide({ indexURL: join(root, "vendor/pyodide") + "/" });
await mountChecker(py, async (path) => new Uint8Array(readFileSync(join(root, path))));
const inPyodide = checkQuality(py, files);

const inCPython = JSON.parse(
  execFileSync(
    process.env.PYTHON || "python3",
    ["-c", "import json, sys; sys.path.insert(0, sys.argv[1]); from checker.quality import check_files; print(json.dumps(check_files(json.load(sys.stdin))))", root],
    { input: JSON.stringify(files), maxBuffer: 1 << 28 },
  ).toString(),
);

let different = 0;
inPyodide.forEach((result, i) => {
  if (JSON.stringify(result) !== JSON.stringify(inCPython[i])) {
    different++;
    console.log(`DIFFERENT ${result.name}\n   pyodide: ${JSON.stringify(result.issues)}\n   python : ${JSON.stringify(inCPython[i].issues)}`);
  }
});
const issues = inPyodide.reduce((n, r) => n + r.issues.length, 0);
console.log(`${different ? "FAIL" : "ok  "} ${files.length} files, ${issues} issues found; ${different} file(s) differ between Pyodide and regular Python`);
process.exit(different ? 1 : 0);
