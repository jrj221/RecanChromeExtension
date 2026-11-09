// The toolbar popup: shows the settings (see settings.js) and saves each change as soon as it is made. Open Gradescope
// pages notice the change through chrome.storage.onChanged (content.js), so there is no Save button.

const area = chrome.storage.sync ?? chrome.storage.local;
const checkboxes = ["hideTestFiles", "hideInputOutputFiles", "hideInstructionsRecording", "autoCollapse"];
const $ = (id) => document.getElementById(id);
const sortRadios = () => [...document.querySelectorAll('input[name="sortOrder"]')];
const status = $("status");
let statusTimer;

function show(settings) {
  for (const id of checkboxes) $(id).checked = settings[id];
  for (const radio of sortRadios()) radio.checked = radio.value === settings.sortOrder;
}

function say(message) {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ""), 1800);
}

async function save(change) {
  try {
    await area.set(change);
    say("Saved");
  } catch (e) {
    say("Couldn't save");
    console.warn("[webrecan] couldn't save the settings", e);
  }
}

async function start() {
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;
  try {
    show(webrecanNormalize(await area.get(WEBRECAN_DEFAULTS)));
  } catch (e) {
    show(WEBRECAN_DEFAULTS);
    say("Couldn't read the saved settings");
  }
  for (const id of checkboxes) $(id).addEventListener("change", () => save({ [id]: $(id).checked }));
  for (const radio of sortRadios()) radio.addEventListener("change", () => radio.checked && save({ sortOrder: radio.value }));
  $("reset").addEventListener("click", async () => {
    await save(WEBRECAN_DEFAULTS);
    show(WEBRECAN_DEFAULTS);
    say("Back to the defaults");
  });
}
start();
