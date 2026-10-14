"""Code-quality checks for student Python files.

Independent of recan: this imports nothing but the standard library, and nothing in recan
uses it. It can be run on its own from a terminal:

    python3 checker/quality.py <file-or-folder> [more ...]

and the Chrome extension runs the same code in its Python session (see src/quality.js).

The checks, and the judgment calls where the rules leave room for interpretation:

  indentation      Each block must be indented exactly 4 spaces deeper than the line that opens
                   it. Flags extra indents (8 spaces where 4 is expected, or an indent after a
                   line that doesn't open a block), indents that are too small, and tabs.
  blank-lines      Two top-level functions that follow one another must be separated by exactly
                   2 blank lines. Comments and decorators directly above a `def` count as part
                   of that function. Methods inside classes and nested functions are not checked.
  nested-while     A `while` loop may not contain another `while` loop (at any depth, through
                   if/for/try). A nested function or class starts fresh.
  function-length  Every function must be shorter than MAX_FUNCTION_LINES. The length is counted
                   in physical lines, from the `def` line to the last line of the function,
                   including blank lines, comments and the docstring.
"""
from __future__ import annotations

import ast
import io
import sys
import tokenize
from dataclasses import asdict, dataclass
from pathlib import Path

INDENT_WIDTH = 4
BLANK_LINES_BETWEEN_FUNCTIONS = 2
MAX_FUNCTION_LINES = 20  # a function must be SHORTER than this

RULE_TITLES = {
    "indentation": "Indentation",
    "blank-lines": "Blank lines between functions",
    "nested-while": "Nested while loops",
    "function-length": "Function length",
    "syntax": "Python can't read this file",
}


@dataclass(frozen=True)
class Issue:
    rule: str
    line: int
    message: str


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


# ---- blank lines between functions ----

def _check_blank_lines(tree: ast.Module, lines: list[str]) -> list[Issue]:
    issues = []
    for before, node in zip(tree.body, tree.body[1:]):
        if not (_is_function(before) and _is_function(node)):
            continue
        blanks = _blank_lines_above(lines, _first_line(node, lines))
        if blanks != BLANK_LINES_BETWEEN_FUNCTIONS:
            plural = "" if blanks == 1 else "s"
            issues.append(Issue(
                "blank-lines", node.lineno,
                f"'{node.name}' has {blanks} blank line{plural} above it; there should be exactly {BLANK_LINES_BETWEEN_FUNCTIONS}",
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
    return sorted(issues, key=lambda i: (i.line, i.rule))


def check_files(files: list[dict]) -> list[dict]:
    """Check several files. `files` is [{"name": ..., "text": ...}]; the result is JSON-friendly."""
    return [
        {"name": f["name"], "issues": [asdict(issue) for issue in check_source(f["text"])]}
        for f in files
    ]


def _python_files(paths: list[str]) -> list[Path]:
    found: list[Path] = []
    for raw in paths:
        path = Path(raw)
        found += sorted(path.rglob("*.py")) if path.is_dir() else [path]
    return found


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: python3 checker/quality.py <file-or-folder> [more ...]")
        return 2
    total = 0
    files = _python_files(argv)
    for path in files:
        for issue in check_source(path.read_text(encoding="utf-8", errors="replace")):
            print(f"{path}:{issue.line}: [{issue.rule}] {issue.message}")
            total += 1
    print(f"\n{total} issue(s) in {len(files)} file(s)")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
