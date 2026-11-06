// Checks the per-assignment minimum non-idle time in content.js.  Usage: node test/min-active.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/content.js"), "utf8");
const section = source.slice(source.indexOf("// ---- minimum non-idle time per assignment ----"), source.indexOf("// ---- end minimum time ----"));
const make = (table) =>
  new Function("page", `${section.replace(/const MIN_ACTIVE_MINUTES = \{[\s\S]*?\n\};/, `const MIN_ACTIVE_MINUTES = ${JSON.stringify(table)};`)}; return { minActiveSeconds, isFlagged };`);
const { minActiveSeconds, isFlagged } = make({ "Homework 4b": 10 })({ assignmentTitle: "Homework 4B | Gradescope" });
assert.equal(minActiveSeconds("homework 4b"), 600);
assert.equal(minActiveSeconds("Homework 4b | Gradescope"), 600);
assert.equal(minActiveSeconds("Homework 4"), 120, "no partial matches");
assert.equal(minActiveSeconds(""), 120);
const ev = (activeSeconds) => ({ activeSeconds, flags: { unapprovedPastes: false, starterMismatch: false } });
assert.equal(isFlagged(ev(300)), true, "5 min is under this assignment's 10");
assert.equal(isFlagged(ev(700)), false);
console.log("ok   per-assignment minimum time");
