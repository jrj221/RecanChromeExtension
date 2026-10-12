// Runs upstream's `recan view` inside Pyodide and returns the HTML it writes.
// Environment-agnostic: the extension and the Node parity test both use it.
//
// Nothing here reimplements recan. It mounts upstream's package and calls the
// CLI entry point (recan.main.entry) with the arguments `view --no-open <files>`.

const HOME = "/home/pyodide";

/** Load upstream's recan (as listed by scripts/list-recan-files.mjs) into Pyodide's in-memory FS. */
export async function mountRecan(py, readBytes) {
  const files = JSON.parse(new TextDecoder().decode(await readBytes("recan-files.json")));
  for (const { src, dest } of files) {
    const dir = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "";
    py.FS.mkdirTree(dir ? `${HOME}/${dir}` : HOME);
    py.FS.writeFile(`${HOME}/${dest}`, await readBytes(src));
  }
}

// The TAs' command is `recan view <recording_file> --starter-code <files> --exclude .html`;
// --starter-code is only passed when starter files are available.
export const TA_OPTIONS = { exclude: [".html"] };

// Runs upstream's own entry point and argument parser, exactly like typing the command.
const PYTHON = `
import json, sys
sys.path.insert(0, "${HOME}")
from recan.main import entry

sys.argv = ["recan", *json.loads(RECAN_ARGV)]
entry()
`;

/**
 * Run `recan <command> <recordings> [--starter-code ...] [--exclude ...]` and return its output.
 *
 * @param py         a Pyodide instance with mountRecan() already called
 * @param kind       "view" -> the player page (HTML string)
 *                   "summary" -> the analysis as JSON text (`recan summary --json`)
 * @param recordings [{ name, bytes }] — raw .gz (or .jsonl) bytes, held in memory only
 * @param options    { exclude: [".html"], starterCode: [{ name, text }] }
 */
function runRecan(py, kind, recordings, { exclude = [], starterCode = [] } = {}) {
  const dir = `${HOME}/recordings`;
  const starterDir = `${HOME}/starter`;
  const safe = (name) => name.replace(/[\\/]/g, "_");
  py.FS.mkdirTree(dir);
  py.FS.mkdirTree(starterDir);

  const paths = recordings.map((r) => `${dir}/${safe(r.name)}`);
  recordings.forEach((r, i) => py.FS.writeFile(paths[i], r.bytes));
  const starterPaths = starterCode.map((f) => `${starterDir}/${safe(f.name)}`);
  starterCode.forEach((f, i) => py.FS.writeFile(starterPaths[i], f.text));

  const out = `${HOME}/summary.json`;
  const argv = kind === "view" ? ["view", "--no-open", ...paths] : ["summary", ...paths, "--json", "--output", out];
  if (starterPaths.length) argv.push("--starter-code", ...starterPaths);
  if (exclude.length) argv.push("--exclude", ...exclude);

  try {
    py.globals.set("RECAN_ARGV", JSON.stringify(argv));
    py.runPython(PYTHON);
    if (kind === "summary") return py.FS.readFile(out, { encoding: "utf8" });
    const html = py.FS.readdir(dir).filter((f) => f.endsWith(".html"));
    if (html.length !== 1) throw new Error(`expected one generated page, found ${html.length}`);
    return py.FS.readFile(`${dir}/${html[0]}`, { encoding: "utf8" });
  } finally {
    for (const d of [dir, starterDir]) {
      for (const f of py.FS.readdir(d)) if (f !== "." && f !== "..") py.FS.unlink(`${d}/${f}`);
    }
    if (py.FS.analyzePath(out).exists) py.FS.unlink(out);
  }
}

/** The player page, exactly as `recan view --no-open ...` would write it. */
export const generateHtml = (py, recordings, options) => runRecan(py, "view", recordings, options);

/** The analysis as JSON text, exactly as `recan summary --json ...` would print it. */
export const generateSummary = (py, recordings, options) => runRecan(py, "summary", recordings, options);
