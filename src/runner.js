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

// The TAs' command is `recan view <recording_file> --exclude .html`.
export const TA_OPTIONS = { exclude: [".html"] };

// Same as typing that command (plus --no-open): upstream's own entry point and parser.
const PYTHON = `
import json, sys
sys.path.insert(0, "${HOME}")
from recan.main import entry

sys.argv = ["recan", *json.loads(RECAN_ARGV)]
entry()
`;

/**
 * @param py         a Pyodide instance with mountRecan() already called
 * @param recordings [{ name, bytes }] — raw .gz (or .jsonl) bytes, held in memory only
 * @param options    { exclude: [".html", ...] } — the `--exclude` argument of `recan view`
 * @returns the player page, exactly as the CLI would write it
 */
export function generateHtml(py, recordings, { exclude = [] } = {}) {
  const dir = `${HOME}/recordings`;
  py.FS.mkdirTree(dir);

  const paths = recordings.map((r) => `${dir}/${r.name.replace(/[\\/]/g, "_")}`);
  recordings.forEach((r, i) => py.FS.writeFile(paths[i], r.bytes));

  const argv = ["view", "--no-open", ...paths];
  if (exclude.length) argv.push("--exclude", ...exclude);

  try {
    py.globals.set("RECAN_ARGV", JSON.stringify(argv));
    py.runPython(PYTHON);
    const html = py.FS.readdir(dir).filter((f) => f.endsWith(".html"));
    if (html.length !== 1) throw new Error(`expected one generated page, found ${html.length}`);
    return py.FS.readFile(`${dir}/${html[0]}`, { encoding: "utf8" });
  } finally {
    for (const f of py.FS.readdir(dir)) if (f !== "." && f !== "..") py.FS.unlink(`${dir}/${f}`);
  }
}
