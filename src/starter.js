// Optional starter-code support. It only does anything if scripts/fetch-starter-code.mjs
// has been run, which creates starter-code.json (and the files it points to).

/** "color_bars.recording.jsonl.gz" -> "color_bars" (the name before the first dot, as recan does). */
export const stemOf = (name) => name.split("/").pop().split(".")[0];

/**
 * The starter index, or null when the optional script hasn't been run. Read once per session:
 * it only changes when the script is re-run, and the extension is reloaded after that.
 */
let indexPromise;
export function loadIndex() {
  return (indexPromise ??= (async () => {
    try {
      const res = await fetch(chrome.runtime.getURL("starter-code.json"));
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  })());
}

/**
 * Guess the assignment's starter folder from the recording names on the page: a recording
 * `color_bars.recording.jsonl.gz` goes with the starter file `color_bars.py`. The folder that
 * has the most of the page's recordings wins. Returns null when nothing matches or two
 * folders tie (generic names like exercise1 appear in several labs), so the user is asked.
 */
export function matchFolder(index, recordingNames) {
  const stems = new Set((recordingNames || []).map(stemOf));
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const folder of index.folders) {
    const score = folder.files.filter((f) => stems.has(stemOf(f.name))).length;
    if (score > bestScore) [best, bestScore, tied] = [folder, score, false];
    else if (score === bestScore && score > 0) tied = true;
  }
  return tied ? null : best;
}

/** What the picker shows: the assignment's folder name, e.g. homework2d. */
export const folderLabel = (f) => f.name;

/** The folder's starter files as [{ name, text }]. */
export async function loadStarterFiles(index, folderId) {
  const folder = index.folders.find((f) => f.id === folderId);
  if (!folder) return [];
  return Promise.all(
    folder.files.map(async (file) => {
      const res = await fetch(chrome.runtime.getURL(file.src));
      if (!res.ok) throw new Error(`${file.src}: HTTP ${res.status} (re-run scripts/fetch-starter-code.mjs?)`);
      return { name: file.name, text: await res.text() };
    }),
  );
}

// ---- instructions (optional, separate from the starter code) ----
// Only does anything if scripts/fetch-instructions.mjs has been run, which creates instructions.json.

let instructionsIndexPromise;
function loadInstructionsIndex() {
  return (instructionsIndexPromise ??= (async () => {
    try {
      const res = await fetch(chrome.runtime.getURL("instructions.json"));
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  })());
}

/**
 * The instructions.md text for an assignment (the same id as a starter folder), or null when the
 * script hasn't been run or the assignment has none. recan gets it as --approved-pastes, so pasting
 * the sample output from the instructions isn't counted as an unapproved paste.
 */
export async function loadInstructions(folderId) {
  const src = (await loadInstructionsIndex())?.assignments?.[folderId];
  if (!src) return null;
  const res = await fetch(chrome.runtime.getURL(src));
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status} (re-run scripts/fetch-instructions.mjs?)`);
  return res.text();
}

// ---- test output (optional, separate from the starter code) ----
// Only does anything if scripts/fetch-test-output.mjs has been run, which creates test-output.json.

let testOutputIndexPromise;
function loadTestOutputIndex() {
  return (testOutputIndexPromise ??= (async () => {
    try {
      const res = await fetch(chrome.runtime.getURL("test-output.json"));
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  })());
}

/**
 * What Gradescope shows as "expected" for a test file, given the file's text. The autograder
 * (byu_pytest_utils) removes its markup first: for a dialog file, <<text>> marks input the autograder
 * types and is left as plain text; for both kinds, ``text;name;weight`` marks scored text and is left
 * as just the text. An expected-output file only has the second kind of markup.
 */
export function expectedOutputText(raw, kind) {
  const withoutInputMarks = kind === "dialog" ? raw.replace(/<<([\s\S]*?)>>/g, "$1") : raw;
  return withoutInputMarks.replace(/``([\s\S]*?);([\s\S]+?);(\d+?)``/g, "$1");
}

/**
 * The expected test output for an assignment (the same id as a starter folder), one string per file
 * (a paste has to fall within a single one), or [] when the script hasn't been run or the assignment
 * has none. recan gets these as --approved-pastes, so copying from the expected output Gradescope
 * shows isn't counted as an unapproved paste.
 */
export async function loadTestOutput(folderId) {
  const files = (await loadTestOutputIndex())?.assignments?.[folderId] ?? [];
  return Promise.all(
    files.map(async (file) => {
      const res = await fetch(chrome.runtime.getURL(file.src));
      if (!res.ok) throw new Error(`${file.src}: HTTP ${res.status} (re-run scripts/fetch-test-output.mjs?)`);
      return expectedOutputText(await res.text(), file.kind);
    }),
  );
}
