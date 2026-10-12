// Optional starter-code support. It only does anything if scripts/fetch-starter-code.mjs
// has been run, which creates starter-code.json (and the files it points to).

/** "color_bars.recording.jsonl.gz" -> "color_bars" (the name before the first dot, as recan does). */
export const stemOf = (name) => name.split("/").pop().split(".")[0];

/** The starter index, or null when the optional script hasn't been run. */
export async function loadIndex() {
  try {
    const res = await fetch(chrome.runtime.getURL("starter-code.json"));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
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
