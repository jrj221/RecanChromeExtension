// Check that the extension's Pyodide pipeline produces byte-identical HTML to the
// real `recan view --no-open` CLI.
//
// Usage: RECAN=/path/to/recan node test/parity.mjs <dir-or-file.gz ...>
// Runs the TAs' command, `recan view <recording_file> --exclude .html`, both ways.
// Run `node scripts/setup.mjs` first. Recordings are student work: keep them
// outside the repo.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";
import { TA_OPTIONS, generateHtml, mountRecan } from "../src/runner.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collect(args) {
  const out = [];
  for (const a of args) {
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a).sort()) if (f.endsWith(".gz")) out.push(join(a, f));
    } else out.push(a);
  }
  return out;
}

function cliHtml(files) {
  const dir = mkdtempSync(join(tmpdir(), "recan-cli-"));
  const copies = files.map((f) => {
    const dst = join(dir, basename(f));
    copyFileSync(f, dst);
    return dst;
  });
  try {
    execFileSync(process.env.RECAN || "recan", ["view", "--no-open", ...copies, "--exclude", ...TA_OPTIONS.exclude], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { cliError: String(e.stderr || e.message).trim().split("\n").pop() };
  }
  const html = readdirSync(dir).filter((f) => f.endsWith(".html"));
  // `recan view` names the page after the first recording (sorted).
  return readFileSync(join(dir, html[0]), "utf8");
}

const files = collect(process.argv.slice(2));
if (!files.length) throw new Error("no recordings given");

const py = await loadPyodide({ indexURL: join(root, "vendor/pyodide") + "/" });
await py.loadPackage(["jinja2", "pyyaml"]);
await mountRecan(py, async (path) => new Uint8Array(readFileSync(join(root, path))));

const groups = [...files.map((f) => [f]), ...(files.length > 1 ? [files] : [])];
let failed = 0;
for (const group of groups) {
  const label = group.length === 1 ? basename(group[0]) : `all ${group.length} together`;
  const expected = cliHtml(group);
  if (expected.cliError) {
    console.log(`skip ${label}: CLI raised: ${expected.cliError}`);
    continue;
  }
  const t0 = performance.now();
  const ours = generateHtml(
    py,
    group.map((f) => ({ name: basename(f), bytes: new Uint8Array(readFileSync(f)) })),
    TA_OPTIONS,
  );
  const ms = Math.round(performance.now() - t0);
  const same = ours === expected;
  console.log(`${same ? "ok  " : "FAIL"} ${label}  (${(ours.length / 1e6).toFixed(1)} MB html, pyodide ${ms} ms)`);
  if (!same) failed++;
}
process.exit(failed ? 1 : 0);
