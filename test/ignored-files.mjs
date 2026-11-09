// Checks which file names content.js hides like test files.  Usage: node test/ignored-files.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/content.js"), "utf8");
const code = source.slice(source.indexOf("const IGNORED_FILE"), source.indexOf('const MARK = "data-webrecan";'));
const isTestFile = new Function(`${code}; return isTestFile;`)();

for (const name of [
  "test_words.py", "test_words.recording.jsonl.gz", "instructions.recording.jsonl.gz",
  "words_output.py", "words_input.py", "words_output.recording.jsonl.gz", "words_input.recording.jsonl.gz",
  "Words_OUTPUT.py", "words_output.txt", "hw/sub/words_input.py", "input.py", "output.py", "inputs.py", "my_outputs.py",
  "get_input_value.py", "nan_input.txt", "bullets.output.txt", "words_1.input.txt", "OutputFormatter.py",
]) assert.equal(isTestFile(name), true, `${name} should be hidden`);

for (const name of [
  "words.py", "words.recording.jsonl.gz", "contest.py", "hello.recording.jsonl.gz", "puts.py", "big_words.py",
  "hw/input/solution.py", "output/hello.py",
]) assert.equal(isTestFile(name), false, `${name} should be shown`);
console.log("ok   which files are hidden like test files");
