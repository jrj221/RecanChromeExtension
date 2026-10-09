// Download the Pyodide runtime into vendor/pyodide/ and verify the wheels against
// the hashes in Pyodide's own lock file. Skipped if already present (see scripts/setup.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "314.0.7";
const PACKAGES = ["jinja2", "markupsafe", "pyyaml"]; // what recan imports (yaml, jinja2)
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "vendor", "pyodide");
const stamp = join(dest, "VERSION");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) {
  console.log(`pyodide ${VERSION} already in vendor/pyodide/`);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });

const work = mkdtempSync(join(tmpdir(), "pyodide-"));
execFileSync("npm", ["pack", `pyodide@${VERSION}`, "--silent"], { cwd: work });
execFileSync("tar", ["xzf", `pyodide-${VERSION}.tgz`], { cwd: work });
const pkg = join(work, "package");

for (const f of ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]) {
  copyFileSync(join(pkg, f), join(dest, f));
}

const lock = JSON.parse(readFileSync(join(pkg, "pyodide-lock.json"), "utf8")).packages;
for (const name of PACKAGES) {
  const { file_name, sha256 } = lock[name];
  const res = await fetch(`https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/${file_name}`);
  if (!res.ok) throw new Error(`${file_name}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error(`${file_name}: sha256 mismatch`);
  }
  writeFileSync(join(dest, file_name), bytes);
}
writeFileSync(stamp, VERSION + "\n"); // written last: a half-finished download is retried
console.log(`pyodide ${VERSION} vendored into vendor/pyodide/`);
