// Runs src/extension-times.js against a stand-in page: clicking the due date or late due date field of the Add Extension
// form opens WebRecan's own calendar and time picker (the browser's own is blocked), which starts at 11:59 PM and writes
// the chosen date and time into the field; the release date and the edit form are untouched.
// Usage: node test/extension-times.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

// ---- a small stand-in page ----
class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.attributes = new Map();
    this.listeners = {};
    this.value = "";
    this.parent = null;
    const classes = () => this.className.split(" ").filter(Boolean);
    this.classList = {
      add: (name) => { if (!classes().includes(name)) this.className = [...classes(), name].join(" "); },
      toggle: (name, on) => { const has = classes().includes(name); if (on && !has) this.classList.add(name); if (!on && has) this.className = classes().filter((c) => c !== name).join(" "); },
      contains: (name) => classes().includes(name),
    };
  }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  focus() {}
  fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
}
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };

class FakeInput extends FakeEl {
  constructor(name, start, form) {
    super("input");
    this.type = "datetime-local";
    this.name = name;
    this._value = start;
    this.form = form;
    this.events = [];
    form.inputs.push(this);
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  closest(selector) { return selector === "form" ? this.form : null; }
  dispatchEvent(event) { this.events.push(event.type); }
}
const makeForm = (submitText) => ({ inputs: [], querySelectorAll: (s) => (s === 'button[type="submit"]' ? [{ textContent: submitText }] : []) });

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const today = local(now).slice(0, 10);

function load({ pathname = "/courses/1/assignments/2/extensions", forms, enabled = true }) {
  const body = new FakeEl("body");
  const documentListeners = [];
  const rootAttributes = new Map();
  const document = {
    body,
    documentElement: { setAttribute: (name, value) => rootAttributes.set(name, String(value)), getAttribute: (name) => rootAttributes.get(name) ?? null },
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (type, fn) => documentListeners.push({ type, fn }),
    removeEventListener: (type, fn) => documentListeners.splice(documentListeners.findIndex((l) => l.type === type && l.fn === fn), 1),
    querySelectorAll: (selector) => (selector === 'input[type="datetime-local"]' ? forms.flatMap((f) => f.inputs) : []),
  };
  const chrome = { storage: { sync: { get: async (d) => ({ ...d, extensionPicker: enabled }) }, onChanged: { addListener() {} } } };
  const HTMLInputElement = function () {};
  Object.defineProperty(HTMLInputElement.prototype, "value", { set(v) { this._value = v; }, get() { return this._value; }, configurable: true });
  const timers = [];
  const code = `${read("src/settings.js")}\n${read("src/extension-times.js")}`;
  new Function("chrome", "document", "location", "HTMLInputElement", "MutationObserver", "Event", "setTimeout", "clearTimeout", "console", code)(
    chrome, document, { pathname }, HTMLInputElement, class { observe() {} }, class Event { constructor(type) { this.type = type; } },
    (fn) => (timers.push(fn), timers.length), () => {}, console,
  );
  const dialog = () => body.children.find((c) => c.className.includes("webrecan-pickerdialog"));
  const all = () => (dialog() ? walk(dialog()) : []);
  const byClass = (name) => all().find((e) => e.classList.contains(name));
  const button = (text) => all().find((e) => e.tag === "button" && e.textContent === text && !e.classList.contains("day"));
  const day = (date) => all().find((e) => e.getAttribute("data-date") === date);
  const wheel = (name) => all().find((e) => e.classList.contains("wheel") && e.classList.contains(name));
  const timefield = (name) => all().find((e) => e.classList.contains("timefield") && e.classList.contains(name));
  const popOf = (name) => walk(timefield(name).parent).find((e) => e.classList.contains("wheel-pop"));
  const isOpen = (name) => popOf(name).hidden === false;
  const opt = (name, label) => walk(wheel(name)).find((e) => e.tag === "button" && e.textContent === label);
  const chosen = (name) => timefield(name).textContent; // what the field shows
  const highlighted = (name) => walk(wheel(name)).filter((e) => e.tag === "button" && e.classList.contains("on")).map((e) => e.textContent);
  const click = (el) => el.fire("click", {});
  const claimed = (input, type) => {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    input.fire(type, event);
    return event;
  };
  // choose a value the way a user does: click the field, then the value in the list that opens above it
  const pick = (name, label) => {
    click(timefield(name));
    assert.equal(isOpen(name), true, `clicking the ${name} field opens its list`);
    click(opt(name, label));
    assert.equal(isOpen(name), false, `choosing a ${name} closes the list`);
  };
  const press = async (input) => { const event = claimed(input, "click"); await new Promise((r) => setImmediate(r)); return event; };
  const escape = () => documentListeners.filter((l) => l.type === "keydown").forEach((l) => l.fn({ key: "Escape", stopPropagation() {} }));
  // what main-world-picker.js does when the page calls showPicker(): an event on the field, which reaches the document
  const fromPage = (input) => documentListeners.filter((l) => l.type === "webrecan-open-picker").forEach((l) => l.fn({ target: input }));
  return { body, dialog, all, byClass, button, day, wheel, timefield, popOf, isOpen, opt, chosen, highlighted, pick, click, claimed, press, escape, fromPage, flag: () => rootAttributes.get("data-webrecan-picker"), ready: () => new Promise((r) => setImmediate(r)), rescan: () => timers.splice(0).forEach((f) => f()) };
}

// ---- the picker's overlay must not be something content.js deletes ----
// content.js removes every element matching these selectors that it didn't make itself; the picker is made here.
{
  const cleanup = read("src/content.js").match(/for \(const node of document\.querySelectorAll\("([^"]*webrecan-ctl[^"]*)"\)\) \{\n\s*if \(!created\.has\(node\)\) node\.remove\(\);/);
  assert.ok(cleanup, "found content.js's cleanup of its own elements");
  const classes = cleanup[1].split(",").map((s) => s.trim()).filter((s) => s.startsWith(".")).map((s) => s.slice(1));
  const f2 = makeForm("Add Extension");
  const field = new FakeInput("override[settings][dueDate][value]", local(now), f2);
  const open = load({ forms: [f2] });
  await open.ready();
  await open.press(field);
  const overlayClasses = open.dialog().className.split(" ");
  for (const name of classes) assert.ok(!overlayClasses.includes(name), `the picker's overlay is not "${name}", which content.js deletes`);
  console.log("ok   the picker's overlay isn't one of the classes content.js cleans up");
}

// ---- which fields get the picker ----
const form = makeForm("Add Extension");
const due = new FakeInput("override[settings][dueDate][value]", local(now), form);
const late = new FakeInput("override[settings][hardDueDate][value]", local(now), form);
const release = new FakeInput("override[settings][releaseDate][value]", local(now), form);
const page = load({ forms: [form] });
await page.ready();
assert.ok(due.hasAttribute("data-webrecan-picker") && late.hasAttribute("data-webrecan-picker"), "the due and late due fields");
assert.ok(due.classList.contains("webrecan-pickable"));
assert.equal(release.hasAttribute("data-webrecan-picker"), false, "not the release date");
assert.equal(page.claimed(release, "click").prevented, false, "the release date keeps the browser's own picker");
assert.equal(page.dialog(), undefined, "nothing opens by itself");
console.log("ok   the due and late due date fields get the picker; the release date doesn't");

// ---- clicking opens it, starting at 11:59 PM on the field's date ----
let event = await page.press(due);
assert.equal(event.prevented && event.stopped, true, "the browser's own picker is blocked");
assert.equal(page.claimed(due, "mousedown").prevented, true, "so is the focus click that would open it");
assert.ok(page.dialog(), "ours opens");
assert.equal(page.byClass("title").textContent, "Due date");
assert.equal(page.chosen("hour"), "11");
assert.equal(page.chosen("minute"), "59");
assert.equal(page.chosen("meridiem"), "PM");
assert.equal(page.button("Set to 11:59 PM").hidden, true, "already 11:59 PM: no button to set it");
assert.equal(page.wheel("hour").children.length, 12, "hours 1 to 12");
assert.equal(page.wheel("minute").children.length, 60, "minutes 00 to 59");
assert.equal(page.opt("minute", "05") !== undefined, true, "minutes are two digits");
for (const name of ["hour", "minute", "meridiem"]) assert.equal(page.isOpen(name), false, `the ${name} list is closed until its field is clicked`);
assert.equal(page.day(today).classList.contains("selected"), true, "the field's date is selected");
assert.equal(due.value, local(now), "nothing is written until Set");
console.log("ok   clicking the field opens WebRecan's picker at 11:59 PM on the field's date");

// ---- the time fields: lists open on click, one at a time, above their field ----
{
  assert.equal(page.byClass("calendar").parent, page.byClass("time").parent, "the time sits next to the calendar, in the same row");
  assert.ok(page.byClass("layout"), "calendar and time share one row");
  page.click(page.timefield("hour"));
  assert.equal(page.isOpen("hour"), true);
  assert.equal(page.timefield("hour").getAttribute("aria-expanded"), "true");
  page.click(page.timefield("minute"));
  assert.equal(page.isOpen("minute"), true);
  assert.equal(page.isOpen("hour"), false, "opening another list closes the first");
  assert.equal(page.timefield("hour").getAttribute("aria-expanded"), "false");
  page.click(page.timefield("minute"));
  assert.equal(page.isOpen("minute"), false, "clicking the field again closes it");
  page.click(page.timefield("meridiem"));
  page.dialog().fire("mousedown", { target: { closest: () => null } }); // a click somewhere else in the picker
  assert.equal(page.isOpen("meridiem"), false, "clicking elsewhere closes an open list");
  page.click(page.timefield("meridiem"));
  page.dialog().fire("mousedown", { target: { closest: (selector) => (selector === ".wheel-column" ? {} : null) } }); // inside the list
  assert.equal(page.isOpen("meridiem"), true, "clicking inside the open list doesn't");
  page.escape();
  assert.equal(page.isOpen("meridiem"), false, "the first Escape closes the list");
  assert.ok(page.dialog(), "and leaves the picker open");
  assert.equal(chosenAfterEscape(page), true);
  console.log("ok   the time fields open their lists on click, one at a time; Escape closes the list before the picker");
}
function chosenAfterEscape(p) { return p.chosen("hour") === "11" && p.chosen("minute") === "59" && p.chosen("meridiem") === "PM"; }

// ---- pick another day and set it ----
const other = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const otherDate = local(other).slice(0, 10);
page.click(page.day(otherDate));
assert.equal(page.day(otherDate).classList.contains("selected"), true);
assert.equal(page.day(today).classList.contains("selected"), false);
page.click(page.button("Set"));
await page.ready(); // the click handler finishes in the next tick
assert.equal(due.value, `${otherDate}T23:59`, "the chosen date at 11:59 PM goes into the field");
assert.deepEqual(due.events, ["input", "change"], "React is told, the way typing would");
assert.equal(page.dialog(), undefined, "the picker closes");
console.log("ok   picking a day and pressing Set writes the date and time into the field");

// ---- the late due date has its own title; cancelling changes nothing ----
await page.press(late);
assert.equal(page.byClass("title").textContent, "Late due date");
page.click(page.button("Cancel"));
await page.ready();
assert.equal(late.value, local(now));
assert.equal(page.dialog(), undefined);
await page.press(late);
page.escape();
await page.ready();
assert.equal(page.dialog(), undefined, "Escape closes it too");
assert.equal(late.value, local(now));
await page.press(late);
page.dialog().fire("mousedown", { target: page.dialog() });
await page.ready();
assert.equal(page.dialog(), undefined, "so does clicking outside it");
console.log("ok   cancelling, Escape and clicking outside change nothing");

// ---- a time that was already chosen is kept; the time controls work ----
due.value = "2027-03-01T15:30";
await page.press(due);
assert.equal(page.byClass("month").textContent, "March 2027");
assert.equal(page.chosen("hour"), "3");
assert.equal(page.chosen("minute"), "30");
assert.equal(page.chosen("meridiem"), "PM");
assert.equal(page.button("Set to 11:59 PM").hidden, false, "not 11:59 PM: the button is there");
assert.equal(page.day("2027-03-01").classList.contains("selected"), true);
page.pick("minute", "45");
page.pick("hour", "9");
page.pick("meridiem", "AM");
assert.equal(page.chosen("minute"), "45", "only the chosen minute is highlighted");
assert.equal(page.chosen("hour"), "9");
assert.equal(page.chosen("meridiem"), "AM");
assert.deepEqual(page.highlighted("minute"), ["45"], "only the chosen minute is highlighted in its list");
page.click(page.button("Set"));
await page.ready(); // the click handler finishes in the next tick
assert.equal(due.value, "2027-03-01T09:45", "hour, minute and AM/PM are all used");
console.log("ok   a chosen time is kept when the picker reopens; hour, minute and AM/PM work");

// ---- the 11:59 PM preset, and moving between months ----
due.value = "2027-03-01T08:00";
await page.press(due);
assert.equal(page.button("Set to 11:59 PM").hidden, false, "8:00 AM: the button is there");
page.click(page.button("Set to 11:59 PM"));
assert.equal(page.chosen("hour"), "11");
assert.equal(page.chosen("minute"), "59");
assert.equal(page.chosen("meridiem"), "PM");
assert.equal(page.button("Set to 11:59 PM").hidden, true, "and it goes away once the time is 11:59 PM");
page.pick("minute", "58");
assert.equal(page.button("Set to 11:59 PM").hidden, false, "11:58 PM: it comes back");
page.pick("minute", "59");
assert.equal(page.button("Set to 11:59 PM").hidden, true);
page.pick("meridiem", "AM");
assert.equal(page.button("Set to 11:59 PM").hidden, false, "11:59 AM isn't 11:59 PM");
page.pick("meridiem", "PM");
page.click(page.byClass("step") && walk(page.dialog()).filter((e) => e.classList.contains("step"))[1]); // next month
assert.equal(page.byClass("month").textContent, "April 2027");
page.click(page.day("2027-04-15"));
page.click(page.button("Set"));
await page.ready(); // the click handler finishes in the next tick
assert.equal(due.value, "2027-04-15T23:59", "a day in another month, at 11:59 PM");
await page.press(due);
page.click(walk(page.dialog()).filter((e) => e.classList.contains("step"))[0]); // previous month
assert.equal(page.byClass("month").textContent, "March 2027");
page.click(page.button("Cancel"));
await page.ready();
console.log("ok   the 11:59 PM preset, and moving between months");

// ---- an empty field starts at today, 11:59 PM ----
due.value = "";
await page.press(due);
assert.equal(page.day(today).classList.contains("selected"), true);
assert.equal(page.chosen("hour"), "11");
assert.equal(page.chosen("minute"), "59");
page.click(page.button("Set"));
await page.ready(); // the click handler finishes in the next tick
assert.equal(due.value, `${today}T23:59`);
console.log("ok   an empty field starts at today, 11:59 PM");

// ---- the edit form, other pages, and the switch ----
{
  const editForm = makeForm("Save");
  const input = new FakeInput("override[settings][dueDate][value]", local(now), editForm);
  const edit = load({ forms: [editForm] });
  await edit.ready();
  assert.equal(input.hasAttribute("data-webrecan-picker"), false);
  assert.equal(edit.claimed(input, "click").prevented, false);
  console.log("ok   the edit form is left alone");
}
{
  const addForm = makeForm("Add Extension");
  const input = new FakeInput("override[settings][dueDate][value]", local(now), addForm);
  const elsewhere = load({ pathname: "/courses/1/assignments/2/submissions/3", forms: [addForm] });
  await elsewhere.ready();
  assert.equal(input.hasAttribute("data-webrecan-picker"), false);
  console.log("ok   only the Extensions page is touched");
}
{
  const addForm = makeForm("Add Extension");
  const input = new FakeInput("override[settings][dueDate][value]", local(now), addForm);
  const off = load({ forms: [addForm], enabled: false });
  await off.ready();
  const click = await off.press(input);
  assert.equal(click.prevented, false, "switched off in the popup: the browser's own picker works as it always did");
  assert.equal(off.dialog(), undefined);
  console.log("ok   it can be switched off");
}

// ---- the page's own showPicker() call (turned into an event by main-world-picker.js) ----
{
  const addForm = makeForm("Add Extension");
  const input = new FakeInput("override[settings][dueDate][value]", local(now), addForm);
  const p = load({ forms: [addForm] });
  await p.ready();
  assert.equal(p.flag(), "on", "the page-world script is told to hand showPicker() calls over");
  p.fromPage(input);
  assert.ok(p.dialog(), "ticking the box (the page's showPicker call) opens WebRecan's picker");
  p.fromPage(input);
  assert.equal(p.body.children.filter((c) => c.className.includes("webrecan-pickerdialog")).length, 1, "never two pickers at once");
  p.click(p.button("Cancel"));
  await p.ready();
  console.log("ok   the page's own showPicker() call opens WebRecan's picker, once");
}
{
  const editForm = makeForm("Save");
  const input = new FakeInput("override[settings][dueDate][value]", local(now), editForm);
  let native = 0;
  input.showPicker = () => native++;
  const p = load({ forms: [editForm] });
  await p.ready();
  p.fromPage(input);
  assert.equal(p.dialog(), undefined);
  assert.equal(native, 1, "a field that isn't ours gets the browser's own picker");
  console.log("ok   a field that isn't ours still gets the browser's own picker");
}
{
  const addForm = makeForm("Add Extension");
  new FakeInput("override[settings][dueDate][value]", local(now), addForm);
  const off = load({ forms: [addForm], enabled: false });
  await off.ready();
  assert.equal(off.flag(), "off", "switched off: the page-world script leaves showPicker() alone");
  const elsewhere = load({ pathname: "/courses/1/assignments/2/submissions/3", forms: [addForm] });
  await elsewhere.ready();
  assert.equal(elsewhere.flag(), "off", "and so it does on other pages");
  console.log("ok   the page-world script is only switched on for the Extensions page, with the picker on");
}

// ---- main-world-picker.js itself ----
{
  const run = (flag) => {
    const calls = { native: 0, events: [] };
    class HTMLInputElement {}
    HTMLInputElement.prototype.showPicker = function () { calls.native++; };
    const document = { documentElement: { getAttribute: () => flag } };
    new Function("HTMLInputElement", "document", "CustomEvent", read("src/main-world-picker.js"))(HTMLInputElement, document, class CustomEvent { constructor(type) { this.type = type; } });
    const field = (type, name) => Object.assign(new HTMLInputElement(), { type, name, dispatchEvent(e) { calls.events.push(e.type); } });
    return { calls, field };
  };
  let page = run("on");
  page.field("datetime-local", "override[settings][dueDate][value]").showPicker();
  page.field("datetime-local", "override[settings][hardDueDate][value]").showPicker();
  assert.deepEqual(page.calls.events, ["webrecan-open-picker", "webrecan-open-picker"], "the due and late due date fields are handed over");
  assert.equal(page.calls.native, 0, "and the browser's own picker doesn't open");
  page.field("datetime-local", "override[settings][releaseDate][value]").showPicker();
  page.field("text", "override[settings][dueDate][value]").showPicker();
  assert.equal(page.calls.native, 2, "the release date, and anything that isn't a date field, are left alone");
  page = run("off");
  page.field("datetime-local", "override[settings][dueDate][value]").showPicker();
  assert.deepEqual(page.calls.events, []);
  assert.equal(page.calls.native, 1, "switched off: the browser's own picker");
  page = run(null);
  page.field("datetime-local", "override[settings][dueDate][value]").showPicker();
  assert.equal(page.calls.native, 1, "before the extension has said anything: the browser's own picker");
  console.log("ok   main-world-picker.js hands over only the due and late due date fields, only while switched on");
}
