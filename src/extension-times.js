// On a course's Extensions page (/courses/<id>/assignments/<id>/extensions), clicking the due date or late due date field
// of the Add an Extension form opens WebRecan's own calendar and time picker instead of Chrome's (which no extension can
// change). The picker starts at 11:59 PM on the field's date; picking a date and time writes it into the field, and
// Gradescope's own "Add Extension" button then sends it. The release date and the form for editing an extension are left
// alone. The switch for this is in the toolbar popup (settings.js).
//
// Gradescope draws the form with React, so the value is set the way a user's typing would: the new value, then the
// "input" and "change" events that React listens for. Gradescope also opens the browser's picker by itself when
// "Due date" or "Late due date" is ticked, by calling showPicker(); main-world-picker.js (which runs in the page's own
// world) turns that into a "webrecan-open-picker" event, answered here.
// Wrapped in a function: content scripts share one global scope, and content.js uses plain names like `settings`.
(() => {
  const PAGE = /^\/courses\/\d+\/assignments\/\d+\/extensions\/?$/;
  const MARK = "data-webrecan-picker";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const area = chrome.storage.sync ?? chrome.storage.local;
  let enabled = WEBRECAN_DEFAULTS.extensionPicker;

  const h = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** Only the form that adds an extension (its submit button says so); the edit form is left alone. */
  function isAddForm(input) {
    const form = input.closest("form");
    return !!form && [...form.querySelectorAll('button[type="submit"]')].some((button) => /^\s*add extension\s*$/i.test(button.textContent));
  }

  function setValue(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Where the picker starts: the field's own date at 11:59 PM if it still holds the form's starting value, else what it holds. */
  function startingPoint(value) {
    const parsed = webrecanParseDateTime(value);
    if (!parsed) return webrecanParseDateTime(webrecanTodayEndOfDay());
    return webrecanIsAboutNow(value) ? { ...parsed, hour12: 11, minute: 59, pm: true } : parsed;
  }

  /** The calendar and time picker. Resolves a datetime-local value ("2026-11-13T23:59"), or null if it was cancelled. */
  function askDateTime({ title, value }) {
    return new Promise((resolve) => {
      const picked = startingPoint(value); // { year, month, day, hour12, minute, pm }
      let viewYear = picked.year;
      let viewMonth = picked.month;
      const today = new Date();

      const overlay = h("div", "webrecan-pickerdialog"); // not "webrecan-dialog": content.js deletes those it didn't make
      const box = h("div", "box webrecan-picker");
      const monthLabel = h("span", "month");
      const grid = h("div", "grid");
      const prev = h("button", "step", "‹");
      const next = h("button", "step", "›");
      prev.type = next.type = "button";
      prev.setAttribute("aria-label", "Previous month");
      next.setAttribute("aria-label", "Next month");

      let openWheel = null; // the time field whose list is showing; only one at a time
      const closeWheel = () => {
        openWheel?.close();
        openWheel = null;
      };

      /**
       * One time field (hour, minute or AM/PM): a button showing the value. Clicking it opens a scrollable list of the
       * choices just above it (like the time columns in Chrome's picker); picking one closes the list again.
       */
      const makeWheel = (name, label, options, onPick) => {
        const column = h("div", "wheel-column");
        const field = h("button", `timefield ${name}`);
        field.type = "button";
        field.setAttribute("aria-haspopup", "listbox");
        field.setAttribute("aria-expanded", "false");
        field.setAttribute("aria-label", label);
        const pop = h("div", "wheel-pop");
        pop.hidden = true;
        const list = h("div", `wheel ${name}`);
        list.setAttribute("role", "listbox");
        list.setAttribute("aria-label", label);
        const items = options.map(({ value, text }) => {
          const item = h("button", "opt", text);
          item.type = "button";
          item.setAttribute("role", "option");
          item.addEventListener("click", () => {
            onPick(value);
            closeWheel();
          });
          list.append(item);
          return { value, text, item };
        });
        pop.append(list);
        column.append(field, pop);

        const wheel = {
          column,
          show(value) {
            for (const entry of items) {
              const on = entry.value === value;
              entry.item.classList.toggle("on", on);
              entry.item.setAttribute("aria-selected", String(on));
              if (on) field.textContent = entry.text;
            }
          },
          open() {
            pop.hidden = false;
            field.setAttribute("aria-expanded", "true");
            const on = items.find((entry) => entry.item.classList.contains("on"));
            // keep the chosen value in view, in the middle of the list
            if (on && list.clientHeight) list.scrollTop = on.item.offsetTop - (list.clientHeight - on.item.offsetHeight) / 2;
          },
          close() {
            pop.hidden = true;
            field.setAttribute("aria-expanded", "false");
          },
        };
        field.addEventListener("click", () => {
          if (openWheel === wheel) return closeWheel();
          closeWheel();
          wheel.open();
          openWheel = wheel;
        });
        return wheel;
      };
      const hourWheel = makeWheel("hour", "Hour", Array.from({ length: 12 }, (_, i) => ({ value: i + 1, text: String(i + 1) })), (value) => {
        picked.hour12 = value;
        showTime();
      });
      const minuteWheel = makeWheel("minute", "Minute", Array.from({ length: 60 }, (_, i) => ({ value: i, text: webrecanPad2(i) })), (value) => {
        picked.minute = value;
        showTime();
      });
      const meridiemWheel = makeWheel("meridiem", "AM or PM", [{ value: false, text: "AM" }, { value: true, text: "PM" }], (value) => {
        picked.pm = value;
        showTime();
      });
      const endOfDay = h("button", "preset", "Set to 11:59 PM");
      endOfDay.type = "button";

      function showTime() {
        hourWheel.show(picked.hour12);
        minuteWheel.show(picked.minute);
        meridiemWheel.show(picked.pm);
        // Only useful when the time isn't 11:59 PM already
        endOfDay.hidden = picked.hour12 === 11 && picked.minute === 59 && picked.pm;
      }

      function showMonth() {
        monthLabel.textContent = `${MONTHS[viewMonth - 1]} ${viewYear}`;
        grid.replaceChildren(...WEEKDAYS.map((name) => h("span", "dow", name)));
        for (const cell of webrecanMonthGrid(viewYear, viewMonth)) {
          const button = h("button", "day", String(cell.day));
          button.type = "button";
          button.setAttribute("data-date", `${cell.year}-${webrecanPad2(cell.month)}-${webrecanPad2(cell.day)}`);
          if (!cell.inMonth) button.classList.add("other");
          if (cell.year === today.getFullYear() && cell.month === today.getMonth() + 1 && cell.day === today.getDate()) button.classList.add("today");
          if (cell.year === picked.year && cell.month === picked.month && cell.day === picked.day) button.classList.add("selected");
          button.addEventListener("click", () => {
            Object.assign(picked, { year: cell.year, month: cell.month, day: cell.day });
            viewYear = cell.year;
            viewMonth = cell.month;
            showMonth();
          });
          grid.append(button);
        }
      }

      const move = (by) => {
        const d = new Date(viewYear, viewMonth - 1 + by, 1);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth() + 1;
        showMonth();
      };
      prev.addEventListener("click", () => move(-1));
      next.addEventListener("click", () => move(1));
      endOfDay.addEventListener("click", () => {
        Object.assign(picked, { hour12: 11, minute: 59, pm: true });
        showTime();
      });

      const cancel = h("button", "cancel", "Cancel");
      const ok = h("button", "ok", "Set");
      cancel.type = ok.type = "button";
      const done = (result) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(result);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (openWheel) closeWheel(); // the first Escape closes an open list, the next closes the picker
          else done(null);
        }
      };
      document.addEventListener("keydown", onKey, true);
      cancel.addEventListener("click", () => done(null));
      ok.addEventListener("click", () => done(webrecanFormatDateTime(picked)));
      overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) return done(null);
        if (openWheel && !event.target?.closest?.(".wheel-column")) closeWheel(); // a click anywhere else closes an open list
      });

      const nav = h("div", "nav");
      nav.append(prev, monthLabel, next);
      const calendar = h("div", "calendar");
      calendar.append(nav, grid);
      // the time sits to the right of the calendar: three fields, one above the other, and the 11:59 PM shortcut under them
      const time = h("div", "time");
      time.append(h("div", "time-title", "Time"), hourWheel.column, minuteWheel.column, meridiemWheel.column, endOfDay);
      const layout = h("div", "layout");
      layout.append(calendar, time);
      const buttons = h("div", "buttons");
      buttons.append(cancel, ok);
      box.append(h("div", "title", title), layout, buttons);
      overlay.append(box);
      document.body.append(overlay);
      showMonth();
      showTime();
      ok.focus();
    });
  }

  let open = false; // one picker at a time

  /** Open the picker for a field and write what is chosen into it. */
  async function pick(input) {
    if (open) return;
    open = true;
    try {
      const title = /\[hardDueDate\]/.test(input.name) ? "Late due date" : "Due date";
      const chosen = await askDateTime({ title, value: input.value });
      if (chosen) setValue(input, chosen);
    } finally {
      open = false;
    }
  }

  /** Is this a field WebRecan's picker is for, right now? */
  const ours = (input) => enabled && PAGE.test(location.pathname) && webrecanIsDeadlineField(input.name) && isAddForm(input);

  /** Make a field open the picker when it is clicked (the browser's own picker is blocked). */
  function attach(input) {
    if (input.hasAttribute(MARK)) return;
    input.setAttribute(MARK, "");
    input.classList.add("webrecan-pickable");
    const claim = (event) => {
      if (!enabled) return false; // switched off: the field behaves as it always did
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    input.addEventListener("mousedown", claim, true);
    input.addEventListener(
      "click",
      (event) => {
        if (claim(event)) pick(input);
      },
      true,
    );
  }

  // Gradescope's own showPicker() call, turned into this event by main-world-picker.js. Listened for on the document, from
  // the start: the call can come the moment a field is drawn, before any scan has looked at it.
  document.addEventListener("webrecan-open-picker", (event) => {
    const input = event.target;
    if (ours(input)) pick(input);
    else input.showPicker(); // not a field of ours after all: the browser's own picker (from this world, so not caught again)
  });

  /** Tell the page-world script whether to hand showPicker() calls over to us. */
  const publish = () => document.documentElement.setAttribute("data-webrecan-picker", enabled && PAGE.test(location.pathname) ? "on" : "off");

  function scan() {
    if (!PAGE.test(location.pathname)) return;
    for (const input of document.querySelectorAll('input[type="datetime-local"]')) {
      if (webrecanIsDeadlineField(input.name) && isAddForm(input)) attach(input);
    }
  }

  let timer;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 30);
  };

  async function start() {
    try {
      enabled = webrecanNormalize(await area.get(WEBRECAN_DEFAULTS)).extensionPicker;
    } catch (e) {
      console.warn("[webrecan] couldn't read the settings; using the defaults", e);
    }
    publish();
    chrome.storage.onChanged.addListener(async () => {
      try {
        enabled = webrecanNormalize(await area.get(WEBRECAN_DEFAULTS)).extensionPicker;
      } catch {
        // keep what we have
      }
      publish();
    });
    new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
    scan();
  }
  start();
})();
