// Runs the toolbar popup's script (src/popup.js) against a stand-in page and stand-in storage: it shows the stored
// settings, and saves each change as it is made.  Usage: node test/popup.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

function run(stored) {
  const saved = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = {};
      elements.set(id, { id, value: "", checked: false, textContent: "", addEventListener: (type, fn) => (listeners[type] = fn), fire: (type) => listeners[type]?.() });
    }
    return elements.get(id);
  };
  const storage = {
    get: async (defaults) => ({ ...defaults, ...stored }),
    set: async (change) => void saved.push(change),
  };
  const chrome = { storage: { sync: storage }, runtime: { getManifest: () => ({ version: "9.9.9" }) } };
  const radios = ["recordings", "python", "default"].map((value) => {
    const listeners = {};
    return { value, checked: false, addEventListener: (type, fn) => (listeners[type] = fn), choose() { radios.forEach((r) => (r.checked = r === this)); listeners.change?.(); } };
  });
  const document = { getElementById: element, querySelectorAll: (selector) => (selector === 'input[name="sortOrder"]' ? radios : []) };
  new Function("chrome", "document", "setTimeout", "clearTimeout", `${read("src/settings.js")}\n${read("src/popup.js")}`)(chrome, document, () => 0, () => {});
  const selected = () => radios.find((r) => r.checked)?.value;
  return { element, saved, radios, selected, ready: () => new Promise((r) => setImmediate(r)) };
}

// shows what is stored (with defaults for what isn't)
let page = run({ hideTestFiles: false, sortOrder: "python" });
await page.ready();
assert.equal(page.element("version").textContent, "v9.9.9");
assert.equal(page.element("hideTestFiles").checked, false);
assert.equal(page.element("hideInputOutputFiles").checked, true, "not stored: the default");
assert.equal(page.element("autoCollapse").checked, true);
assert.equal(page.selected(), "python", "the radio for the stored order is chosen");
console.log("ok   the popup shows the stored settings");

// saves each change on its own
page.element("autoCollapse").checked = false;
page.element("autoCollapse").fire("change");
page.radios.find((r) => r.value === "default").choose();
await page.ready();
assert.deepEqual(page.saved, [{ autoCollapse: false }, { sortOrder: "default" }]);
console.log("ok   each change is saved as it is made");

// reset puts everything back
page.element("reset").fire("click");
await page.ready();
const defaults = new Function(`${read("src/settings.js")}; return WEBRECAN_DEFAULTS;`)();
assert.deepEqual(page.saved.at(-1), defaults);
assert.equal(page.selected(), "recordings");
assert.equal(page.element("hideTestFiles").checked, true);
console.log("ok   reset to defaults");

// bad stored values are replaced by defaults
page = run({ sortOrder: "sideways", autoCollapse: "no" });
await page.ready();
assert.equal(page.selected(), "recordings");
assert.equal(page.element("autoCollapse").checked, true);
console.log("ok   nonsense in storage falls back to the defaults");
