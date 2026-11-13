// Runs inside Gradescope's own page (manifest "world": "MAIN"), not in the extension's isolated world, because the page
// itself calls the browser's showPicker() when "Due date" or "Late due date" is ticked on the Add an Extension form, and
// only a script in the page's own world can see that call. For the due and late due date fields, while WebRecan's date
// picker is switched on, the call is turned into an event that extension-times.js answers by opening WebRecan's picker.
// Everything else (other fields, or the picker switched off) goes to the browser's own showPicker as before.
(() => {
  const original = HTMLInputElement.prototype.showPicker;
  if (typeof original !== "function") return;
  HTMLInputElement.prototype.showPicker = function (...args) {
    const ours =
      this.type === "datetime-local" &&
      /\[(dueDate|hardDueDate)\]\[value\]$/.test(this.name) &&
      document.documentElement.getAttribute("data-webrecan-picker") === "on";
    if (ours) {
      this.dispatchEvent(new CustomEvent("webrecan-open-picker", { bubbles: true }));
      return;
    }
    return original.apply(this, args);
  };
})();
