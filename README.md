# WebRecan

A Chrome extension for the best TAs around. On a Gradescope submission page it adds a **Run Recan** button
next to each `.recording.jsonl.gz` file. Clicking it opens the normal
[recan](https://github.com/BYU-CS-Course-Ops/code-recording-analysis) player in a new tab.
It's the same as downloading the recording and running
`recan view <recording_file> --exclude .html`, without the download, the terminal,
or the file left behind.

It also checks every recording when the page opens. A button turns **red** when the recording has under
2 minutes of non-idle time, has unapproved pastes, or doesn't start with the assignment's starter code, and an
**?** button next to every recording shows the details, and says why when it's red. See [When does a Run Recan button turn red?](#when-does-a-run-recan-button-turn-red)

It also checks the student's Python files for code quality. A small box at the top of the page is **green** when every
`.py` file in the submission passes. If not, it's a red **warning**; click it to see each check and which files failed it.
See [Code quality checker](#code-quality-checker). This is separate from recan.

This repo contains only the extension. It does not contain recan itself. See the `Install` section for more info.

## Contents

- [Install](#install)
  - [What `setup.mjs` does](#what-setupmjs-does)
  - [Optional: starter-code checks](#optional-starter-code-checks)
- [Code quality checker](#code-quality-checker)
- [Testing](#testing)
- [Layout](#layout)
- [FAQ](#faq)
  - [How do I update recan?](#how-do-i-update-recan)
  - [When does a Run Recan button turn red?](#when-does-a-run-recan-button-turn-red)
  - [What does the ? button show?](#what-does-the--button-show)
  - [How do I see the pasted code?](#how-do-i-see-the-pasted-code)
  - [How does it know which starter code to use?](#how-does-it-know-which-starter-code-to-use)
  - [What if the starter-code script says unauthorized?](#what-if-the-starter-code-script-says-unauthorized)
  - [How does the extension check recordings before I click?](#how-does-the-extension-check-recordings-before-i-click)
  - [Is the code quality checker part of recan?](#is-the-code-quality-checker-part-of-recan)
  - [How is a function's length counted?](#how-is-a-functions-length-counted)
  - [What happens when I click Run Recan?](#what-happens-when-i-click-run-recan)
  - [Is the recording saved or uploaded anywhere?](#is-the-recording-saved-or-uploaded-anywhere)
  - [Why run recan's Python in the browser instead of rewriting it in JavaScript?](#why-run-recans-python-in-the-browser-instead-of-rewriting-it-in-javascript)
  - [What is `pydivsufsort`, and how does the stand-in work?](#what-is-pydivsufsort-and-how-does-the-stand-in-work)
  - [Why does the player open in a sandboxed frame?](#why-does-the-player-open-in-a-sandboxed-frame)
  - [Why `--exclude .html`?](#why---exclude-html)
  - [Why does the first page take a moment?](#why-does-the-first-page-take-a-moment)
  - [Why does the manifest allow an Amazon S3 address?](#why-does-the-manifest-allow-an-amazon-s3-address)

<br>

## Install

You need Chrome 116+, Node 18+ and git. From the repo root (the folder with `manifest.json`) run:

```
node scripts/setup.mjs
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose this repo.

> [!TIP]
> To update to a newer recan release, see [How do I update recan?](#how-do-i-update-recan) in the FAQ.

<br>

### What `setup.mjs` does

It runs three scripts in order. Each one is also runnable on its own.

| Step | Script | What it does | Where it ends up |
|---|---|---|---|
| 1 | `vendor-pyodide.mjs` | Downloads **Pyodide**, a copy of the Python interpreter compiled to run inside a browser (about 16 MB). Files are checked against published hashes, and the download is skipped if you already have the right version. It uses only Node itself, so `npm` and `tar` aren't needed. | `vendor/pyodide/` |
| 2 | `fetch-upstream.mjs` | Clones **recan** with `git clone` of the BYU-CS-Course-Ops repo, or `git pull` if it's already cloned. | `upstream/` |
| 3 | `list-recan-files.mjs` | Writes a list of the files in `upstream/recan/`, plus our one stand-in file (see [the FAQ](#what-is-pydivsufsort-and-how-does-the-stand-in-work)). A browser page can't list a folder, so the extension needs this list to know which files to load into Python. Nothing is copied: the extension reads the files straight from `upstream/`. | `recan-files.json` |

`vendor/`, `upstream/` and `recan-files.json` are all git-ignored. They are downloaded or generated, never edited by hand.

<br>

### Optional: starter-code checks

Out of the box the extension doesn't know each assignment's starter code, so it skips the starter-code check. If you
have access to the private **BYU-CS-Course-Ops/CS110-course-content** repo, one extra command turns the check on:

```
node scripts/fetch-starter-code.mjs
```

It downloads only the assignments' starter `.py` files, about 1.4 MB instead of the whole 500+ MB repo, into
`starter-code-source/`, and writes `starter-code.json` describing them. Labs are skipped, since students don't submit them. Both are git-ignored, so they stay on your machine. Run it again any
time to pull new changes, then reload the extension.

> [!WARNING]
> This step needs access to that private repo. If you don't have it, the script stops with an "unauthorized" /
> "repository not found" error and leaves nothing behind. That's fine: the extension works without it, it just
> won't check starter code. See [What if the starter-code script says unauthorized?](#what-if-the-starter-code-script-says-unauthorized)

With it set up, recordings are also run with `--starter-code`, so a recording that doesn't begin with the assignment's
starter code is flagged, and pasting the starter code isn't counted as an unapproved paste (the same checks the
autograder does). See [How does it know which starter code to use?](#how-does-it-know-which-starter-code-to-use)

<br>

## Code quality checker

`checker/quality.py` scans the `.py` files in a submission. On a Gradescope submission page the extension runs it on
every Python file listed there and shows one small box at the top of the page:

- **Green**, "✓ Code quality: all checks passed", when every check passes.
- A red **warning**, "⚠ Code quality: some checks failed", otherwise. Click it to see the checks, a ✓ or ✗ for each, and
  next to each ✗ the files that failed it. It doesn't say why; for the exact lines and reasons, run the checker from a
  terminal (below).

Checks are judged across **all the files together**, not file by file. Indentation and blank-line slips are common and
minor, so each of those two only fails once it has happened **more than twice in total** (three or more, however they're
spread over the files). Nested while loops and long functions fail on the first one.

| Check | What passes |
|---|---|
| **Indentation** | Every block is indented exactly 4 spaces deeper than the line that opens it. Flags extra indents (8 spaces where 4 belong, or an indent after a line that doesn't open a block), and too-small indents. A tab counts as 4 spaces, so one tab per level is fine. A statement that wraps onto more lines (a long `print(...)`, a list, a backslash continuation) can indent its continuation lines any way it likes. **Fails only if it happens more than twice across all the files together.** |
| **2 blank lines between functions** | The last import at the top and the first function, two functions that follow each other, or a function followed by the `if __name__ == "__main__":` block, have exactly 2 blank lines between them (not more, not fewer). Comments and decorators directly above a function (or that `if`) count as part of it. Methods inside classes and nested functions aren't checked. **Fails only if it happens more than twice across all the files together,** except that no blank line at all, or 5 or more, fails it right away. |
| **No nested while loops** | No `while` loop contains another `while` loop, at any depth. A function defined inside a loop starts fresh. |
| **Duplicated code** | Within a file: 3+ identical lines that appear twice, or 4+ lines that appear twice and differ only in string contents, numbers and variable names (so they could be one function with parameters). Method calls and called functions have to match exactly. Blank lines, comments and lines like `else:` or `return` don't count. Fails on the first one, and the box shows both copies side by side in a dropdown. The limits are constants at the top of `checker/quality.py`. |
| **Functions longer than 20 lines** | Every function is **shorter than 20 lines**, so a function of 20 lines or more fails the check. |

**Test files are ignored.** Any file whose name starts with `test` (`test_calculator.py`, `tests.py`, ...) isn't checked, so
the box never counts it. When you scan a folder from the command line they're skipped too (a file you name yourself is
still checked).

A file that Python can't read at all (a syntax error) isn't skipped: it adds a fifth row, "Python can't read the file",
to the warning.

The limits live at the top of `checker/quality.py` (`INDENT_WIDTH`, `BLANK_LINES_BETWEEN_FUNCTIONS`, `MAX_FUNCTION_LINES`,
and `ALLOWED_VIOLATIONS`, the "more than twice" allowance for the two spacing checks).

It also runs on its own, with just Python and no extension or recan:

```
python3 checker/quality.py <file-or-folder> [more ...]
```

It prints `file:line: [rule] message` for each issue, then one line per check (ok or FAIL, with how many it found and which
files), and exits with 1 if any check failed. Like the box, it counts slips across all the files you give it.

<br>

## Testing

```
RECAN=/path/to/recan node test/parity.mjs <folder of .gz recordings>
```

Runs each recording two ways, through the extension's Pyodide pipeline and through the real recan command-line tool,
and checks the output is **identical** for both things the extension uses: the player page
(`recan view --no-open ... --exclude .html`) and the analysis behind the red flag
(`recan summary --json ... --exclude .html`). `RECAN` is your installed `recan` command (it needs recan's Python
dependencies). To include starter code, also set `STARTER_DIR=<folder of the assignment's starter .py files>`.
`node test/flags.mjs [folder of .gz recordings]` checks how recan's analysis becomes the flags and the pasted-code snippets,
including rebuilding the whole file at a paste (with a folder, it also compares them with recan's real output). `node test/cross-file.mjs` checks that code moved between two files' recordings is an internal paste only when both are analyzed together. Run the parity test after every upstream update. `python3 test/gen_synthetic.py <folder>` writes extra edge-case recordings.

> [!WARNING]
> Keep real recordings out of this repo; they're student work (`*.gz` is git-ignored).

The code quality checker has its own tests, which need only Python:

```
python3 test/quality_test.py                                # the rules, case by case
node test/quality-parity.mjs <folder of .py files>          # same results in the extension's Python as in regular Python
```

<br>

## Layout

```
manifest.json        extension definition (Gradescope + its S3 recording storage, plus storage and offscreen)
icons/               blue "R" icon (icon.svg is the source; the PNGs are rendered from it)
checker/             quality.py                 the code quality checks (standalone, standard library only)
src/                 content.js + content.css   the buttons, red flag, "?" popover and code quality box on Gradescope
                     background.js              routes messages, remembers your starter-code choices
                     offscreen.*                the hidden page that keeps Python + recan loaded
                     runner.js                  runs recan's own command line inside Python
                     flags.js                   turns recan's analysis into the red-flag checks
                     starter.js                 optional starter-code lookup and matching by recording name
                     quality.js                 runs checker/quality.py in the Python session
                     viewer.*, sandbox.*        the tab that shows the recan player
shims/               pydivsufsort.py stand-in
scripts/             setup.mjs and its steps; fetch-starter-code.mjs (optional)
test/                parity.mjs, flags.mjs, gen_synthetic.py, quality_test.py, quality-parity.mjs
vendor/  upstream/  recan-files.json   downloaded or generated by setup (git-ignored)
starter-code-source/  starter-code.json   from the optional starter-code script (git-ignored)
```

<br>

## FAQ

### How do I update recan?

1. Run `node scripts/setup.mjs` again. The `git pull` brings in the new recan, and step 3 refreshes the file list.
2. Reload the extension on `chrome://extensions`.
3. Run the [parity test](#testing) to confirm the extension still produces the same output as the real recan.

> [!TIP]
> If the parity test fails after an update, recan probably started using more of `pydivsufsort`, or changed how
> `view` works. See [the stand-in FAQ](#what-is-pydivsufsort-and-how-does-the-stand-in-work).

---

### When does a Run Recan button turn red?

When the recording has any of these (each recording is checked on its own):

- **Under 2 minutes of non-idle time.** Non-idle time is the recording's total length minus its idle time, using
  recan's own definition: time with no activity for over 5 seconds, plus time the editor wasn't focused. This is the same
  idle time the player skips with its "Skip idle" option.
- **Any unapproved pastes of 3+ lines** (`MIN_PASTED_LINES` in `src/flags.js`). Large insertions that aren't an IDE action, text copied from earlier in the student's
  own file, or approved starter code.
- **A starter-code mismatch.** The recording doesn't begin with the assignment's starter code. This is only checked if
  you set up [the optional starter-code step](#optional-starter-code-checks).

Recordings whose names start with `test` (like `test_words.recording.jsonl.gz`) are left out of this: they keep their
**Run recan** button, but are never analyzed or flagged and have no **?** button.

Everything is worked out by recan itself (`recan summary --json`); the extension only applies the 2 minute rule and
counts the results. The 2 minutes is `MIN_ACTIVE_SECONDS` in `src/flags.js` (and `src/content.js`, which can't share
modules with it).

---

### What is the red "Previous submissions" box?

On a submission page, if the autograder results show the **Previous submissions** test failed, a small red box says so at
the top of the page. The extension looks for that test by name in the data the page embeds, and if it isn't there, in the
results drawn on the page, and only shows the box when it clearly failed (a failed status, or a score below the maximum). The
test's name is `AUTOGRADER_TEST` near the top of the autograder section in `src/content.js`.

### What does the ? button show?

It appears next to every recording's **Run recan** button once it has been analyzed, so you can look at the details
even when nothing is flagged. It's red next to a red button (and explains why), blue otherwise, and gray if the
recording couldn't be analyzed (it then shows the error). It shows:

- **Time:** non-idle time out of total time, and the idle time.
- **Unapproved pastes:** how many, and how many characters in total. Click **Show** (when there is at least one) to see
  the pasted code itself. See [below](#how-do-i-see-the-pasted-code).
- **Starter code** (only if the optional step is set up): whether the recording matches, doesn't match, or wasn't
  checked.

When the optional step is set up it also has a **picker** for which assignment's starter code to use.

---

### How do I see the pasted code?

It opens by itself. When a recording has at least one unapproved paste, opening its **?** card also opens a second card, the
paste viewer, to the **right** of it. (If the analysis isn't finished yet when you open the **?** card, the viewer opens the moment
it is.) It shows **the whole file as it was at the end of that paste**, with line numbers and the pasted code **highlighted** (a line the paste fully covers is highlighted whole; on a line it only partly covers, just the pasted characters are), scrolled so the paste is in view. It's wide, so the **?** card slides over to the
left to make room (it can end up over the button and the file list).

- The button next to **Unapproved pastes** says **Hide** while the viewer is open and **Show** when it's closed. Hiding it
  sticks: the viewer won't pop back open until you open the **?** card again.
- The **✕** in the **?** card's heading closes **both** cards in one click. The **✕** in the viewer closes only the viewer.
  **Escape** closes the viewer first, then the **?** card.
- The file is rebuilt from the recording's edits (recan's `summary --json` already includes them), so it shows exactly what
  the student had at that moment. If the IDE re-indented the paste a few milliseconds later, you see the re-indented text,
  which is also what recan counts as the paste.
- If the recording has more than one unapproved paste, the heading reads "Paste 2 of 3" and there are **‹ ›** arrows to
  step through them, in order. The file shown is the file *at that paste*, so an earlier paste appears as plain context and
  a later one isn't there yet. The **Left** and **Right** arrow keys do the same while the viewer is open (ignored while
  you're typing in a page field).
- Very large files are cut to a window of 100,000 characters around the paste (with the real line numbers). If a recording
  doesn't carry enough to rebuild the file, a short note says so and the card shows just the pasted code.
- Opening the starter-code dropdown closes the viewer (they share the space beside the **?** card); **Show** closes the dropdown.
- In a narrow window the viewer narrows to fit, and the **?** card moves as far over as it needs. If the **?** button is at the far
  right of the window, the cards open on the left instead (the **?** card then slides right to make room).

The pasted code is always shown as plain text, never run. These are the same pastes recan counts as unapproved
(`recan summary --json`), not a separate detection.

---

### How does it know which starter code to use?

Only if you ran the optional script. It uses the recording's file name: `color_bars.recording.jsonl.gz` goes with
the starter file `color_bars.py`. Nothing is read from Gradescope's assignment title.

1. **Matching the names.** For each assignment's starter folder it counts how many of the page's recordings have a
   starter file with the same name, and the folder with the most wins. A submission with all of an assignment's files
   picks it out reliably. Of the 113 starter file names (labs aside), 104 appear in only one assignment.
2. **When names overlap.** A few names are shared (for example `invert` is in both `homework2a` and `project2`, and the
   homework 3 assignments reuse each other's files). If two folders tie, a picker in the **?** popover lists the
   assignments. Choose one (or "Don't check starter code") and it's remembered for that assignment on this browser.

Recan matches starter files to recordings by file name and treats every starter file's text as approved, so the
extension gives it **one assignment's** files at a time. The autograder doesn't need any matching: each assignment's
Docker image already contains just that assignment's starter code.

---

### What if the starter-code script says unauthorized?

It needs access to the private BYU-CS-Course-Ops/CS110-course-content repo. Sign in to GitHub with an account in that
organization when git asks (on Windows a browser window opens). If you don't have access, skip the script: the
extension works without it and just doesn't check starter code. Nothing is left behind after a failed run, and if you
already had a working `starter-code-source/` a failed update never deletes it.

---

### How does the extension check recordings before I click?

When a submission page opens, each recording is downloaded into memory and analyzed by recan. This happens in a hidden
extension page (`src/offscreen.html`) that stays open and keeps Python and recan loaded. That's why clicking **Run
Recan** is fast afterwards: the recording and the Python session are already there. It's also why the extension asks for
the `offscreen` permission and needs Chrome 116 or newer. Results are cached per file, so revisiting a submission is
instant. Opening a page downloads that submission's recordings (a few hundred KB each) from Gradescope's storage, the same
files the page already links to. That download starts right away, before the file list is drawn, so it can include a
recording that the page ends up not showing (it is never analyzed or displayed).

---

### Is the code quality checker part of recan?

No. It's a separate module (`checker/quality.py`) that uses only Python's standard library. Recan doesn't know about it and
it doesn't use recan's output. The extension happens to run both in the same Python session, because that session is
already loaded, but it works the same from a terminal.

---

### How is a function's length counted?

In lines of code, from the `def` line through the end of the function. **Blank lines, comment lines and the docstring are not
counted.** A function has to be **shorter than 20** lines, so 19 is fine and 20 is flagged. Decorators above the `def`
aren't counted. Nested functions and methods are each measured on their own.

The submission's recordings are analyzed **together** in one `recan summary` run (the player still opens one recording at a
time). That's because recan checks every paste against what all the recordings in the run had written earlier: code typed in
one file and pasted into another (for example, written in the wrong file and moved) counts as an internal paste, not an
unapproved one. If the group can't be analyzed (say one recording is damaged), each file falls back to being analyzed alone.

---

### What happens when I click Run Recan?

1. The page script (`src/content.js`) has already put the button next to each recording and colored it from the analysis.
2. The click asks the background script (`src/background.js`) to open a viewer tab.
3. The viewer tab (`src/viewer.js`) asks the hidden engine page (`src/offscreen.js`) to start Python and fetch the
   recording. Usually both are already done.
4. The engine calls recan's own command-line entry point, as if you had typed
   `recan view --no-open <recording> [--starter-code <starter files>] --exclude .html` (`src/runner.js`). recan writes
   its player page into Pyodide's in-memory file system.
5. The page is shown in a sandboxed frame (`src/sandbox.html`).

---

### Is the recording saved or uploaded anywhere?

> [!NOTE]
> No. The recording goes from Gradescope's storage straight into your browser's memory, is processed there, and is
> gone when you close the browser or the extension reloads. Nothing is written to disk and nothing is sent to any other
> server. The only thing stored (in this browser's extension storage) is which starter folder you picked for an assignment.

---

### Why run recan's Python in the browser instead of rewriting it in JavaScript?

A rewrite would be a second copy of recan's detection logic that could quietly drift from the real one. Running the
actual Python (with Pyodide) means the extension uses exactly what upstream ships, and updating is a `git pull`.
The parity test proves the output is identical to the real command-line tool.

---

### What is `pydivsufsort`, and how does the stand-in work?

> [!IMPORTANT]
> This is the only part of the extension that is not upstream's code: `shims/pydivsufsort.py`.

**What recan uses it for.** To flag an "internal paste", recan asks: *has this exact text appeared earlier in the
student's own file?* To answer quickly, `recan/algorithm.py` joins every version of the file into one big block of
bytes and builds a **suffix array** of it with `pydivsufsort.divsufsort`: a sorted index of every position in the
text, so a snippet can be looked up without rescanning. For each paste it calls `pydivsufsort.sa_search` to find where
the snippet occurs, then checks whether any match comes before the paste.

**Why it can't be used here.** `pydivsufsort` is a thin Python wrapper around compiled C code. Pyodide can only run
packages that have been built for WebAssembly, and this one hasn't.

**What the stand-in does.** `shims/pydivsufsort.py` provides the same two names with the same return shapes:

- `divsufsort(block)` returns an empty list-like object, which recan keeps as its "index".
- `sa_search(block, index, snippet)` finds every position of the snippet with `bytes.find`, adds those positions to
  that object, and returns `(count, start)`, which recan slices to read the matches back.

**What is the same and what is different.**

- *Same answers.* The real package returns matches in index order and the stand-in in text order, but recan only
  asks "is there any match before this paste?", so order doesn't matter. The parity test checks this on every update.
- *Slower in theory.* The real package builds its index once and each lookup is very fast; the stand-in rescans the
  text for every paste. For TA-sized recordings the difference is not noticeable.
- *It fails loudly.* If a future recan release calls anything else from that package, the import or call raises an
  error instead of quietly giving wrong results. That is when to extend the stand-in.

---

### Why does the player open in a sandboxed frame?

Chrome blocks inline scripts on extension pages, and recan's player page is built from inline scripts. A sandboxed
page (`src/sandbox.html`) is allowed to run them but has no access to the extension's own permissions.

---

### Why `--exclude .html`?

It's the flag the TAs run recan with. It drops edits to `.html` files, which in the sample recordings were generated
output rather than student code. One 17 MB recording became about 0.3 MB, so the player opens much faster. The value
lives in one place, `TA_OPTIONS` in `src/runner.js`.

---

### Why does the first page take a moment?

Python has to start once per browser session (about a second, most of the wait), then recan runs on each recording in a
fraction of a second. To hide that, the extension starts Python as soon as a Gradescope page *begins* loading, loads recan's
code while doing so, and downloads the page's recordings while Gradescope is still drawing its file list. On a page
that takes a second or two to load, the flags are usually ready within half a second of the page appearing. After that the
Python session stays loaded and results are remembered per file, so reopening a submission is nearly instant. The viewer
logs `[webrecan] …: N ms` timings to its DevTools console if you want to see where time goes.

---

### Why does the manifest allow an Amazon S3 address?

Gradescope stores uploaded files on S3 and gives the page a temporary download link. The extension needs permission to
fetch from that one storage address (`production-gradescope-uploads.s3-us-west-2.amazonaws.com`), in addition to
`www.gradescope.com`, which is where the buttons appear. It also uses two Chrome permissions: `storage`, to remember
your starter-code choice for each assignment, and `offscreen`, for the hidden page that keeps Python loaded. It has no
other permissions.
