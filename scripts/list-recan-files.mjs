// Write recan-files.json: which files the extension should load into Pyodide, and
// where they go in its (in-memory) file system. A browser page can't list a
// folder, so the list is made here. Nothing is copied: the files are read straight
// from upstream/recan/ at run time. Also lists our pydivsufsort stand-in.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const recan = join(root, "upstream", "recan");

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__" || name.endsWith(".pyc")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push({ src: relative(root, path), dest: relative(join(root, "upstream"), path) });
  }
}
walk(recan);
files.push({ src: "shims/pydivsufsort.py", dest: "pydivsufsort.py" });

writeFileSync(join(root, "recan-files.json"), JSON.stringify(files, null, 1));
console.log(`recan-files.json: ${files.length} files (${files.length - 1} from upstream/recan/)`);
