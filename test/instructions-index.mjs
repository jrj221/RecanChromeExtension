// Checks which instructions.md file is used for each assignment id. No setup or network needed.
//
// Usage: node test/instructions-index.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInstructions } from "../scripts/instructions-index.mjs";

const root = mkdtempSync(join(tmpdir(), "instr-"));
const canvas = join(root, "canvas");
const put = (rel, text = "x") => {
  const path = join(canvas, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
try {
  put("unit1/homework1a/instructions.md");
  put("unit1/homework1a/assignment/starter.py");
  put("unit1/progress-check1/solution/instructions.md");
  put("unit1/progress-check1/solution/solution.py", "THE ANSWER");
  put("unit2/project2/instructions.md", "own");
  put("unit2/project2/solution/instructions.md", "solution copy");
  put("unit2/lab2a/instructions.md");
  put("unit2/project2/solution/deeper/instructions.md");

  const found = findInstructions(canvas, root);
  assert.deepEqual(found, {
    "unit1/homework1a": "canvas/unit1/homework1a/instructions.md",
    "unit1/progress-check1": "canvas/unit1/progress-check1/solution/instructions.md",
    "unit2/project2": "canvas/unit2/project2/instructions.md",
  });
  console.log("ok   instructions.md is used; a progress check falls back to solution/instructions.md");
  console.log("ok   the assignment's own instructions.md wins over solution/instructions.md");
  console.log("ok   labs are skipped, and solution/ is never walked into (no 'solution' ids)");
} finally {
  rmSync(root, { recursive: true, force: true });
}
