// Write recan-files.json: which files the extension should load into Pyodide, and
// where they go in its (in-memory) file system. A browser page can't list a
// folder, so the list is made here. Nothing is copied: the files are read straight
// from upstream/recan/ at run time. Also lists our pydivsufsort stand-in.
//
// `--from <folder>` reads <folder>/recan/ instead of upstream/recan/ (use-local-recan.mjs does this to
// test a local copy of recan). Files are still loaded into Pyodide at the same place either way.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromIndex = process.argv.indexOf("--from");
const sourceName = fromIndex > 0 ? process.argv[fromIndex + 1] : "upstream";
const sourceDir = join(root, sourceName);
const recan = join(sourceDir, "recan");

// The extension fetches these as URLs, so always use forward slashes (Windows paths use \\).
const posix = (path) => path.split(sep).join("/");

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__" || name.endsWith(".pyc")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push({ src: posix(relative(root, path)), dest: posix(relative(sourceDir, path)) });
  }
}
walk(recan);
files.push({ src: "shims/pydivsufsort.py", dest: "pydivsufsort.py" });

writeFileSync(join(root, "recan-files.json"), JSON.stringify(files, null, 1));
console.log(`recan-files.json: ${files.length} files (${files.length - 1} from ${sourceName}/recan/)`);
