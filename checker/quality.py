"""Code-quality checks for student Python files.

Independent of recan: this imports nothing but the standard library, and nothing in recan
uses it. It can be run on its own from a terminal:

    python3 checker/quality.py <file-or-folder> [more ...]

and the Chrome extension runs the same code in its Python session (see src/quality.js).

The checks, and the judgment calls where the rules leave room for interpretation:

  indentation      Each block must be indented exactly 4 spaces deeper than the line that opens
                   it. Flags extra indents (8 spaces where 4 is expected, or an indent after a
                   line that doesn't open a block), indents that are too small, and tabs.
  blank-lines      Two top-level functions that follow one another, or a top-level function and
                   the `if __name__ == "__main__":` block right after it, must be separated by
                   exactly 2 blank lines. Comments and decorators directly above a `def` (or the
                   `if`) count as part of it. Methods inside classes and nested functions are
                   not checked.
  nested-while     A `while` loop may not contain another `while` loop (at any depth, through
                   if/for/try). A nested function or class starts fresh.
  function-length  Every function must be shorter than MAX_FUNCTION_LINES. The length is counted
                   in physical lines, from the `def` line to the last line of the function,
                   including blank lines, comments and the docstring.
  duplication      Code that should be one function, within a file: a run of MIN_DUPLICATE_LINES
                   or more identical lines that appears twice; a run of MIN_SIMILAR_LINES or more
                   that appears twice and differs only in names and values (variables, numbers,
                   strings); and two functions whose lines align at SIMILAR_RATIO or better once
                   names and values are blanked out. Blank lines, comments and lines like `else:`
                   or `return` don't count.

Spacing slips are common and minor, so indentation and blank lines only FAIL when they happen
more than twice across ALL the files together (see ALLOWED_VIOLATIONS and summarize). Nested while
loops and long functions fail on the first one.

A statement that wraps onto more lines (a long print(...), a list, a backslash continuation) may
indent its continuation lines any way it likes; only new blocks are held to the 4-space rule.

Files whose names start with "test" (test_calculator.py, tests.py, ...) are ignored: see is_ignored.
"""
from __future__ import annotations

import ast
import difflib
import io
import re
import sys
import textwrap
import tokenize
from dataclasses import asdict, dataclass
from pathlib import Path

INDENT_WIDTH = 4
BLANK_LINES_BETWEEN_FUNCTIONS = 2
MAX_FUNCTION_LINES = 20  # a function must be SHORTER than this
MIN_DUPLICATE_LINES = 3  # this many identical lines, twice, is duplicated code
MIN_SIMILAR_LINES = 4  # this many lines that match once names and values are blanked out
SIMILAR_RATIO = 0.8  # two functions this alike (0 to 1) could be one function with parameters
MIN_FUNCTION_LINES = 4  # shorter functions aren't compared
MAX_COMPARED_LINES = 3000  # skip the duplication check on files longer than this

IGNORED_PREFIX = "test"  # files whose names start with this are not checked


def is_ignored(name: str) -> bool:
    """True for files the checks skip: names starting with "test" (any case), in any folder."""
    return name.replace("\\", "/").split("/")[-1].lower().startswith(IGNORED_PREFIX)


# The checks, in the order they are reported, with the names shown to the grader.
CHECKS = [
    ("indentation", "Indentation"),
    ("blank-lines", "2 blank lines between functions"),
    ("nested-while", "No nested while loops"),
    ("function-length", f"Functions longer than {MAX_FUNCTION_LINES} lines"),
    ("duplication", "Duplicated code"),
]
SYNTAX_CHECK = ("syntax", "Python can't read the file")  # only reported if some file has the problem

# How many times a check may be broken, across ALL the files together, before it fails.
# A check not listed here fails on the first violation.
ALLOWED_VIOLATIONS = {"indentation": 2, "blank-lines": 2}

# This many blank lines (or more) between functions is so far off that the check fails right
# away, even if it's under the allowance.
EGREGIOUS_BLANK_LINES = 5


@dataclass(frozen=True)
class Issue:
    rule: str
    line: int
    message: str
    severe: bool = False  # fails its check by itself, regardless of the allowance
    snippet: str = ""  # duplication only: the code that was repeated (one copy)
    where: str = ""  # duplication only: e.g. "lines 4-8 and 14-18"


# ---- indentation ----

def _check_indentation(source: str) -> list[Issue]:
    """Compare every new block's indent with the indent of the line that opens it."""
    issues: list[Issue] = []
    widths = [0]  # indent width of each open block
    block_opened = False  # did the previous logical line end with ':'?
    last = None  # last meaningful token of the current logical line

    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.INDENT:
                line = tok.start[0]
                width = len(tok.string)
                if "\t" in tok.string:
                    issues.append(Issue("indentation", line, f"Indented with a tab; use {INDENT_WIDTH} spaces per level"))
                    width = len(tok.string.expandtabs(INDENT_WIDTH))
                if not block_opened:
                    issues.append(Issue("indentation", line, "Extra indent: the line above doesn't start a block"))
                else:
                    step = width - widths[-1]
                    if step > INDENT_WIDTH:
                        issues.append(Issue("indentation", line, f"Extra indent: {step} spaces deeper than the line above (should be {INDENT_WIDTH})"))
                    elif step < INDENT_WIDTH:
                        issues.append(Issue("indentation", line, f"Indented only {step} spaces deeper than the line above (should be {INDENT_WIDTH})"))
                widths.append(width)
            elif tok.type == tokenize.DEDENT:
                if len(widths) > 1:
                    widths.pop()
            elif tok.type == tokenize.NEWLINE:
                block_opened = last is not None and last.string == ":"
                last = None
            elif tok.type in (tokenize.COMMENT, tokenize.NL, tokenize.ENCODING):
                continue
            else:
                last = tok
    except IndentationError as error:  # includes TabError and "unindent does not match"
        issues.append(Issue("indentation", _line_of(error), f"Inconsistent indentation: {error.msg}"))
    except (tokenize.TokenError, SyntaxError):
        pass  # reported by the parser below, with a better message
    return issues


def _line_of(error: SyntaxError) -> int:
    return error.lineno or 1


# ---- helpers for the checks that use the syntax tree ----

def _is_function(node: ast.AST) -> bool:
    return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))


def _first_line(node: ast.AST, lines: list[str]) -> int:
    """First line of a definition: its first decorator, plus any comment lines directly above."""
    start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
    while start >= 2 and lines[start - 2].lstrip().startswith("#"):
        start -= 1
    return start


def _blank_lines_above(lines: list[str], line: int) -> int:
    count = 0
    index = line - 2  # 0-based index of the line above `line`
    while index >= 0 and not lines[index].strip():
        count += 1
        index -= 1
    return count


# ---- blank lines between functions (and before the main block) ----

def _is_main_block(node: ast.AST) -> bool:
    """`if __name__ == "__main__":` (either side of the ==)."""
    if not (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)):
        return False
    test = node.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False
    sides = [test.left, test.comparators[0]]
    return (
        any(isinstance(s, ast.Name) and s.id == "__name__" for s in sides)
        and any(isinstance(s, ast.Constant) and s.value == "__main__" for s in sides)
    )


def _check_blank_lines(tree: ast.Module, lines: list[str]) -> list[Issue]:
    issues = []
    for before, node in zip(tree.body, tree.body[1:]):
        # A function followed by another function, or by the `if __name__ == "__main__":` block.
        if not (_is_function(before) and (_is_function(node) or _is_main_block(node))):
            continue
        blanks = _blank_lines_above(lines, _first_line(node, lines))
        if blanks != BLANK_LINES_BETWEEN_FUNCTIONS:
            plural = "" if blanks == 1 else "s"
            name = f"'{node.name}'" if _is_function(node) else 'the `if __name__ == "__main__"` block'
            issues.append(Issue(
                "blank-lines", node.lineno,
                f"{name} has {blanks} blank line{plural} above it; there should be exactly {BLANK_LINES_BETWEEN_FUNCTIONS}",
                severe=blanks >= EGREGIOUS_BLANK_LINES,
            ))
    return issues


# ---- nested while loops ----

def _check_nested_while(tree: ast.Module) -> list[Issue]:
    issues = []

    def visit(node: ast.AST, outer_while: int | None) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                visit(child, None)  # a new scope starts fresh
            elif isinstance(child, ast.While):
                if outer_while is not None:
                    issues.append(Issue("nested-while", child.lineno, f"while loop inside the while loop on line {outer_while}"))
                for statement in child.body:
                    visit_statement(statement, child.lineno)
                for statement in child.orelse:  # the loop's else clause doesn't repeat
                    visit_statement(statement, outer_while)
            else:
                visit(child, outer_while)

    def visit_statement(statement: ast.AST, outer_while: int | None) -> None:
        # A statement can itself be a while loop, so wrap it to reuse `visit`.
        visit(ast.Module(body=[statement], type_ignores=[]), outer_while)

    visit(tree, None)
    return issues


# ---- function length ----

def _check_function_length(tree: ast.Module) -> list[Issue]:
    issues = []
    for node in ast.walk(tree):
        if _is_function(node):
            length = node.end_lineno - node.lineno + 1
            if length >= MAX_FUNCTION_LINES:
                issues.append(Issue(
                    "function-length", node.lineno,
                    f"'{node.name}' is {length} lines long; functions should be shorter than {MAX_FUNCTION_LINES} (break it into smaller functions)",
                ))
    return issues


# ---- duplicated code ----

_STRING = re.compile(
    r"""[rbfuRBFU]{0,2}(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"""
)
_NUMBER = re.compile(r"\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b")
_NAME = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
# Words that stay as they are when a line is reduced to its shape (the rest become "I").
_KEYWORDS = {
    "and", "as", "assert", "break", "class", "continue", "def", "del", "elif", "else", "except",
    "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None",
    "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
    "print", "input", "range", "len", "int", "str", "float",
}
_TRIVIAL = re.compile(r"^(?:else|try|finally|return|break|continue|pass|[)\]}]+)\s*:?$")


def _shape(line: str) -> str:
    """The line with strings, numbers and variable names blanked out. Keywords, built-ins, and
    anything that is called or reached through a dot (bit.move(), fill_down(...)) are kept."""
    line = _STRING.sub("S", line)
    line = _NUMBER.sub("N", line)
    line = re.sub(r"\b(def|class)\s+\w+", r"\1 F", line)  # a function's own name doesn't matter

    def blank(match: re.Match) -> str:
        word = match.group(0)
        if word in _KEYWORDS or word in ("S", "N", "F"):
            return word
        before, after = line[:match.start()].rstrip(), line[match.end():].lstrip()
        if before.endswith(".") or after.startswith("("):
            return word  # methods and called functions are what the code DOES, so they must match
        return "I"  # a variable: could become a parameter

    return _NAME.sub(blank, line)


def _code_lines(source: str) -> list[tuple[int, str, str]]:
    """(line number, exact text, shape) for each line that carries code, skipping blanks,
    comments and trivial lines like `else:`. Whitespace inside a line is squeezed."""
    found = []
    for number, raw in enumerate(source.splitlines(), 1):
        text = " ".join(raw.split())
        if not text or text.startswith("#") or _TRIVIAL.match(text):
            continue
        found.append((number, text, _shape(text)))
    return found


def _runs(keys: list[str], minimum: int) -> list[tuple[int, int, int]]:
    """Maximal runs where keys[i:i+n] == keys[j:j+n], i < j, not overlapping: (i, j, n)."""
    runs = []
    count = len(keys)
    for gap in range(1, count):
        n = 0
        for i in range(count - gap + 1):
            if i < count - gap and keys[i] == keys[i + gap]:
                n += 1
                continue
            if n:
                length = min(n, gap)  # the two copies can't overlap
                if length >= minimum:
                    runs.append((i - n, i - n + gap, length))
            n = 0
    return runs


def _excerpt(source: str, first: int, last: int) -> str:
    """Source lines first..last (1-based), with the common indentation removed."""
    return textwrap.dedent("\n".join(source.splitlines()[first - 1:last]))


def _check_duplication(tree: ast.Module, source: str) -> list[Issue]:
    code = _code_lines(source)
    if len(code) > MAX_COMPARED_LINES:
        return []
    issues: list[Issue] = []
    claimed: list[tuple[int, int]] = []  # (first, last) code-line ranges already reported

    def covered(first: int, last: int) -> bool:
        return any(first <= b and a <= last for a, b in claimed)  # any overlap

    # Similar functions first: they are the bigger finding and swallow the runs inside them.
    functions = []
    for node in ast.walk(tree):
        if _is_function(node):
            body = [k for k, (n, _, _) in enumerate(code) if node.lineno <= n <= node.end_lineno]
            if len(body) >= MIN_FUNCTION_LINES:
                functions.append((node, body))
    functions.sort(key=lambda f: f[0].lineno)
    for a in range(len(functions)):
        for b in range(a + 1, len(functions)):
            (fa, ba), (fb, bb) = functions[a], functions[b]
            if fb.lineno <= fa.end_lineno:
                continue  # one is inside the other
            shapes_a = [code[k][2] for k in ba]
            shapes_b = [code[k][2] for k in bb]
            ratio = difflib.SequenceMatcher(None, shapes_a, shapes_b, autojunk=False).ratio()
            if ratio >= SIMILAR_RATIO:
                issues.append(Issue(
                    "duplication", fb.lineno,
                    f"'{fb.name}' is {round(ratio * 100)}% the same as '{fa.name}' (line {fa.lineno}); "
                    "combine them into one function with parameters",
                    snippet=_excerpt(source, fa.lineno, fa.end_lineno),
                    where=f"'{fa.name}' (line {fa.lineno}) and '{fb.name}' (line {fb.lineno})",
                ))
                claimed += [(ba[0], ba[-1]), (bb[0], bb[-1])]

    exact = _runs([c[1] for c in code], MIN_DUPLICATE_LINES)
    similar = _runs([c[2] for c in code], MIN_SIMILAR_LINES)
    for i, j, n in sorted(exact, key=lambda r: -r[2]) + sorted(similar, key=lambda r: -r[2]):
        if covered(j, j + n - 1) or covered(i, i + n - 1):
            continue
        identical = all(code[i + k][1] == code[j + k][1] for k in range(n))
        what = "the same" if identical else "nearly the same (only names or values differ)"
        issues.append(Issue(
            "duplication", code[j][0],
            f"{n} lines here are {what} as the lines starting at line {code[i][0]}; make them one function",
            snippet=_excerpt(source, code[i][0], code[i + n - 1][0]),
            where=f"lines {code[i][0]}-{code[i + n - 1][0]} and {code[j][0]}-{code[j + n - 1][0]}",
        ))
        claimed += [(i, i + n - 1), (j, j + n - 1)]
    return issues


# ---- public API ----

def check_source(source: str) -> list[Issue]:
    """All issues in one file's source code, in line order."""
    issues = _check_indentation(source)
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        line = _line_of(error)
        rule = "indentation" if isinstance(error, IndentationError) else "syntax"
        if not any(i.rule == "indentation" and i.line == line for i in issues):
            issues.append(Issue(rule, line, f"Python can't run this file: {error.msg}"))
        return sorted(issues, key=lambda i: (i.line, i.rule))

    lines = source.splitlines()
    issues += _check_blank_lines(tree, lines)
    issues += _check_nested_while(tree)
    issues += _check_function_length(tree)
    issues += _check_duplication(tree, source)
    return sorted(issues, key=lambda i: (i.line, i.rule))


def check_files(files: list[dict]) -> list[dict]:
    """Check several files. `files` is [{"name": ..., "text": ...}]; the result is JSON-friendly.

    Ignored files (see is_ignored) are left out of the result entirely.
    """
    return [
        {"name": f["name"], "issues": [asdict(issue) for issue in check_source(f["text"])]}
        for f in files
        if not is_ignored(f["name"])
    ]


def summarize(results: list[dict]) -> list[dict]:
    """One row per check, from the per-file results of check_files.

    A check fails when it was broken more than ALLOWED_VIOLATIONS times across ALL the files
    together (more than 0 times if it isn't listed there). `files` names the files that broke it,
    and is only filled in when the check failed.
    """
    checks = list(CHECKS)
    if any(issue["rule"] == SYNTAX_CHECK[0] for r in results for issue in r["issues"]):
        checks.append(SYNTAX_CHECK)
    rows = []
    for rule, label in checks:
        files = [r["name"] for r in results if any(i["rule"] == rule for i in r["issues"])]
        count = sum(1 for r in results for i in r["issues"] if i["rule"] == rule)
        allowed = ALLOWED_VIOLATIONS.get(rule, 0)
        severe = any(i["rule"] == rule and i.get("severe") for r in results for i in r["issues"])
        failed = count > allowed or severe
        row = {"rule": rule, "label": label, "count": count, "allowed": allowed,
               "failed": failed, "files": files if failed else []}
        if rule == "duplication" and failed:  # the repeated code, to show under the check
            row["items"] = [
                {"file": r["name"], "line": i["line"], "where": i["where"], "snippet": i["snippet"]}
                for r in results for i in r["issues"] if i["rule"] == rule
            ]
        rows.append(row)
    return rows


def _python_files(paths: list[str]) -> list[Path]:
    """The files to check. Scanning a folder skips ignored files; a file you name yourself is checked."""
    found: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            found += [p for p in sorted(path.rglob("*.py")) if not is_ignored(p.name)]
        else:
            found.append(path)
    return found


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: python3 checker/quality.py <file-or-folder> [more ...]")
        return 2
    total = 0
    files = _python_files(argv)
    results = []
    for path in files:
        issues = check_source(path.read_text(encoding="utf-8", errors="replace"))
        results.append({"name": str(path), "issues": [asdict(i) for i in issues]})
        for issue in issues:
            print(f"{path}:{issue.line}: [{issue.rule}] {issue.message}")
            total += 1
    print(f"\n{total} issue(s) in {len(files)} file(s)\n")
    rows = summarize(results)
    for row in rows:
        allowed = f", up to {row['allowed']} allowed" if row["allowed"] else ""
        print(f"{'FAIL' if row['failed'] else 'ok  '} {row['label']} ({row['count']} found{allowed})")
        if row["files"]:
            print(f"       in: {', '.join(row['files'])}")
    return 1 if any(row["failed"] for row in rows) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
