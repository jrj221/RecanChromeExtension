// Tests for src/tabreturn.js with a stand-in for the chrome tab APIs. Usage: node test/tabreturn.mjs
import assert from "node:assert/strict";
import { trackTabReturns } from "../src/tabreturn.js";
function fake() {
  const store = {}, handlers = {}, calls = [], tabs = { 1: { windowId: 7 }, 5: { windowId: 7 } };
  const ev = (name) => ({ addListener: (f) => (handlers[name] = f) });
  const api = {
    storage: { session: { set: async (o) => Object.assign(store, o), get: async (ks) => Object.fromEntries([].concat(ks).map((k) => [k, store[k]])), remove: async (k) => delete store[k] } },
    tabs: { onActivated: ev("act"), onRemoved: ev("rem"), get: async (id) => { if (!tabs[id]) throw new Error("gone"); return tabs[id]; }, update: async (id, o) => calls.push(["tab", id, o]) },
    windows: { update: async (id, o) => calls.push(["win", id, o]) },
  };
  return { api, handlers, calls, tabs, store };
}
// opened from tab 1; the player (tab 9) is in front when closed -> back to tab 1
let f = fake(); let remember = trackTabReturns(f.api);
await remember(9, 1); f.handlers.act({ tabId: 9, windowId: 7 }); await new Promise((r) => setTimeout(r));
await f.handlers.rem(9, { windowId: 7, isWindowClosing: false });
assert.deepEqual(f.calls, [["tab", 1, { active: true }], ["win", 7, { focused: true }]]);
// the player was open in the background (another tab in front): closing it changes nothing
f = fake(); remember = trackTabReturns(f.api);
await remember(9, 1); f.handlers.act({ tabId: 5, windowId: 7 }); await new Promise((r) => setTimeout(r));
await f.handlers.rem(9, { windowId: 7, isWindowClosing: false });
assert.deepEqual(f.calls, []);
// the window closing: nothing
f = fake(); remember = trackTabReturns(f.api);
await remember(9, 1); f.handlers.act({ tabId: 9, windowId: 7 }); await new Promise((r) => setTimeout(r));
await f.handlers.rem(9, { windowId: 7, isWindowClosing: true });
assert.deepEqual(f.calls, []);
// the original tab is gone: no error, nothing done
f = fake(); remember = trackTabReturns(f.api); delete f.tabs[1];
await remember(9, 1); f.handlers.act({ tabId: 9, windowId: 7 }); await new Promise((r) => setTimeout(r));
await f.handlers.rem(9, { windowId: 7, isWindowClosing: false });
assert.deepEqual(f.calls, []);
// an unrelated tab closing: nothing, and the stored note is only used once
f = fake(); remember = trackTabReturns(f.api);
await f.handlers.rem(42, { windowId: 7, isWindowClosing: false });
assert.deepEqual(f.calls, []);
console.log("tabreturn: returns to the opener only when the player was in front; otherwise leaves things alone");
