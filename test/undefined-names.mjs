// Catches names content.js uses but never defines (a deleted constant only fails when the code runs, on the page).
// Usage: node test/undefined-names.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/content.js"), "utf8");
for (const name of ["OUR_ELEMENTS", "MARK", "GZ", "PY", "isTestFile", "HIDDEN_TEST"]) {
  assert.match(source, new RegExp(`^(const|let|function) ${name}\\b`, "m"), `${name} is used but not defined`);
}
console.log("ok   names shared between sections of content.js are all defined");
