// Runs checker/quality.py (the code-quality checks) in a Pyodide session. This is separate
// from recan: it never touches recan's files and recan never touches it.

const HOME = "/home/pyodide";

/** Copy the checker package into Pyodide's in-memory file system. */
export async function mountChecker(py, readBytes) {
  py.FS.mkdirTree(`${HOME}/checker`);
  for (const name of ["__init__.py", "quality.py"]) {
    py.FS.writeFile(`${HOME}/checker/${name}`, await readBytes(`checker/${name}`));
  }
}

/**
 * @param py    a Pyodide instance with mountChecker() already called
 * @param files [{ name, text }] — the Python source of each file
 * @returns     [{ name, issues: [{ rule, line, message }] }], one entry per file, in order
 *              (every file given is checked: the caller decides which files are hidden, see settings.js)
 */
export function checkQuality(py, files) {
  py.globals.set("QUALITY_FILES", JSON.stringify(files));
  const json = py.runPython(`
import json, sys
sys.path.insert(0, "${HOME}")
from checker.quality import check_files

json.dumps(check_files(json.loads(QUALITY_FILES), skip_ignored=False))
`);
  return JSON.parse(json);
}

/**
 * One row per check, from the per-file results: { rule, label, count, allowed, failed, files }.
 * A check fails when it was broken more than its allowance across ALL the files together
 * (see checker/quality.py: summarize), so this has to look at the whole submission at once.
 * `minFunctions` (or null for no such check) is the fewest functions the submission may define.
 */
export function summarizeQuality(py, results, minFunctions = null) {
  py.globals.set("QUALITY_RESULTS", JSON.stringify(results));
  py.globals.set("QUALITY_MIN_FUNCTIONS", JSON.stringify(minFunctions));
  const json = py.runPython(`
import json, sys
sys.path.insert(0, "${HOME}")
from checker.quality import summarize

json.dumps(summarize(json.loads(QUALITY_RESULTS), min_functions=json.loads(QUALITY_MIN_FUNCTIONS)))
`);
  return JSON.parse(json);
}
