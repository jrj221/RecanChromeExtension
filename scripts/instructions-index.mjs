// Finds each assignment's instructions.md under a canvas/ checkout (used by fetch-instructions.mjs).
//
// An assignment's id is its folder relative to canvas/, the same id starter-code.json uses. Its instructions
// are <id>/instructions.md or, when there is none (the progress checks keep theirs there),
// <id>/solution/instructions.md. Only those two exact paths are ever read: solution/ is never listed or
// walked into, so nothing else in it (such as solution code) is touched.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const posix = (path) => path.split(sep).join("/");
const isFile = (path) => existsSync(path) && statSync(path).isFile();

// Students don't submit labs (lab1a, old-lab2a-if-else, ...), so they are never needed.
export const isLab = (folderName) => /^(old-)?lab/i.test(folderName);

/** assignment id -> instructions.md path relative to `root`. */
export function findInstructions(canvas, root) {
  const assignments = {};
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      if (name === "old-content" || name === "solution" || name.startsWith(".")) continue;
      const path = join(current, name);
      if (!statSync(path).isDirectory()) continue;
      if (isLab(name)) continue;
      const own = join(path, "instructions.md");
      const inSolution = join(path, "solution", "instructions.md");
      const file = isFile(own) ? own : isFile(inSolution) ? inSolution : null;
      if (file) assignments[posix(relative(canvas, path))] = posix(relative(root, file));
      walk(path);
    }
  }
  walk(canvas);
  return assignments;
}
