// Download the Pyodide runtime into vendor/pyodide/ and verify it.
//
// Needs only Node: no npm, tar or shell, so it behaves the same on Windows, Mac and
// Linux. The core files come from Pyodide's npm tarball (checked against the hash the
// npm registry publishes); the wheels recan needs are checked against the hashes in
// Pyodide's own lock file. Skipped if already present (see scripts/setup.mjs).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const VERSION = "314.0.7";
const CORE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const PACKAGES = ["jinja2", "markupsafe", "pyyaml"]; // what recan imports (yaml, jinja2)
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "vendor", "pyodide");
const stamp = join(dest, "VERSION");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) {
  console.log(`pyodide ${VERSION} already in vendor/pyodide/`);
  process.exit(0);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal tar reader: returns Map(path -> bytes) for the regular files in an archive. */
function untar(buf) {
  const text = (b, from, len) => b.toString("utf8", from, from + len).replace(/\0.*$/s, "");
  const files = new Map();
  for (let pos = 0; pos + 512 <= buf.length; ) {
    if (buf.subarray(pos, pos + 512).every((byte) => byte === 0)) break; // end of archive
    const name = text(buf, pos, 100);
    const prefix = text(buf, pos + 345, 155);
    const size = parseInt(text(buf, pos + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(buf[pos + 156]);
    pos += 512;
    if (type === "0" || type === "\0") files.set(prefix ? `${prefix}/${name}` : name, buf.subarray(pos, pos + size));
    pos += Math.ceil(size / 512) * 512;
  }
  return files;
}

mkdirSync(dest, { recursive: true });

const { dist } = await (await fetch(`https://registry.npmjs.org/pyodide/${VERSION}`)).json();
const tarball = await download(dist.tarball);
if (dist.integrity) {
  const [algorithm, expected] = dist.integrity.split("-");
  if (createHash(algorithm).update(tarball).digest("base64") !== expected) {
    throw new Error("pyodide tarball failed its integrity check");
  }
} else if (createHash("sha1").update(tarball).digest("hex") !== dist.shasum) {
  throw new Error("pyodide tarball failed its checksum");
}
const archive = untar(gunzipSync(tarball));
for (const name of CORE_FILES) {
  const bytes = archive.get(`package/${name}`);
  if (!bytes) throw new Error(`${name} not found in the pyodide package`);
  writeFileSync(join(dest, name), bytes);
}

const lock = JSON.parse(readFileSync(join(dest, "pyodide-lock.json"), "utf8")).packages;
for (const name of PACKAGES) {
  const { file_name, sha256 } = lock[name];
  const bytes = await download(`https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/${file_name}`);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error(`${file_name}: sha256 mismatch`);
  }
  writeFileSync(join(dest, file_name), bytes);
}
writeFileSync(stamp, VERSION + "\n"); // written last: a half-finished download is retried
console.log(`pyodide ${VERSION} vendored into vendor/pyodide/`);
