"""Tests for checker/quality.py. Run: python3 test/quality_test.py"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from checker import quality  # noqa: E402
from checker.quality import MAX_FUNCTION_LINES, check_files, check_source, is_ignored, summarize  # noqa: E402


def rules(source):
    """(rule, line) for every issue except duplication (the filler code in these tests repeats)."""
    return [(i.rule, i.line) for i in check_source(source) if i.rule != "duplication"]


def dups(source):
    return [i.line for i in check_source(source) if i.rule == "duplication"]


def function_with_lines(name, total):
    """A function that is exactly `total` physical lines long, def line included."""
    return f"def {name}():\n" + "    x = 1\n" * (total - 1)


class Duplication(unittest.TestCase):
    def test_three_identical_lines_twice(self):
        block = "    a = input('a? ')\n    b = input('b? ')\n    print(a, b)\n"
        source = "def f():\n" + block + "    z = 0\n" + block
        self.assertEqual(dups(source), [6])

    def test_four_copies_are_one_finding(self):
        block = "    a = input('a? ')\n    b = input('b? ')\n    print(a, b)\n"
        findings = [i for i in check_source("def f():\n" + (block + "    z = 0\n") * 4) if i.rule == "duplication"]
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].where, "lines 2-5, 6-9, 10-13 and 14-17 (4 copies)")

    def test_four_copies_with_other_code_between_them(self):
        block = "    while bit.can_move_front():\n        bit.move()\n        bit.paint('blue')\n"
        body = "".join(block + f"    bit.turn{k}()\n" for k in range(4))
        findings = [i for i in check_source("def f(bit):\n" + body) if i.rule == "duplication"]
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].where, "lines 2-4, 6-8, 10-12 and 14-16 (4 copies)")

    def test_copies_dont_run_across_function_boundaries(self):
        source = (
            "def a(bit):\n    bit.move()\n    bit.left()\n\n\n"
            "def turning(bit):\n    bit.left()\n    bit.move()\n    bit.left()\n\n\n"
            "def accommodate3(bit):\n    bit.left()\n    bit.move()\n    bit.right()\n"
        )
        self.assertEqual(dups(source), [])

    def test_two_identical_lines_are_fine(self):
        block = "    a = input('a? ')\n    print(a)\n"
        self.assertEqual(dups("def f():\n" + block + "    z = 0\n" + block), [])

    def test_same_lines_with_other_names_and_values(self):
        source = (
            "def f():\n    t = 0\n    for i in range(5):\n        t += i * 2\n    print('a', t)\n    z = 0\n"
            "    s = 0\n    for k in range(5):\n        s += k * 2\n    print('b', s)\n"
        )
        self.assertEqual(dups(source), [7])

    def test_other_numbers_still_count_as_the_same_code(self):
        source = (
            "def f():\n    t = 0\n    for i in range(5):\n        t += i * 2\n    print('a', t)\n    z = 0\n"
            "    s = 1\n    for k in range(9):\n        s += k * 3\n    print('b', s)\n"
        )
        self.assertEqual(dups(source), [7])

    def test_only_a_few_matching_lines_in_otherwise_different_functions_is_fine(self):
        source = (
            "def a(x):\n    t = 0\n    for i in range(x):\n        t += i\n    print('d', t)\n    return t\n\n\n"
            "def b(y):\n    c = [1]\n    for k in y:\n        c.append(k)\n    print('e', c)\n    return c\n"
        )
        self.assertEqual(dups(source), [])

    def test_different_method_calls_are_not_the_same_code(self):
        source = (
            "def a(bit, color):\n    while bit.can_move_front():\n        bit.move()\n        bit.paint(color)\n    bit.left()\n    bit.left()\n\n\n"
            "def b(bit):\n    while not bit.is_on_white():\n        bit.move()\n    bit.right()\n"
        )
        self.assertEqual(dups(source), [])

    def test_short_functions_sharing_a_few_calls_are_fine(self):
        source = (
            "def up(bit):\n    bit.left()\n    out(bit)\n    come_back(bit)\n"
            "def down(bit):\n    bit.left()\n    bit.move()\n    bit.right()\n    out(bit)\n    come_back(bit)\n"
        )
        self.assertEqual(dups(source), [])

    def test_different_functions_are_fine(self):
        source = (
            "def a(x):\n    t = 0\n    for i in range(x):\n        t += i\n    return t\n\n\n"
            "def b(s):\n    if s == 'q':\n        print('quit')\n    words = s.split()\n    return len(words) > 3 and words[0]\n"
        )
        self.assertEqual(dups(source), [])

    def test_comments_and_blank_lines_dont_hide_a_copy(self):
        block = "    a = input('a? ')\n\n    # next\n    b = input('b? ')\n    print(a, b)\n"
        self.assertEqual(len(dups("def f():\n" + block + "    z = 0\n" + block)), 1)

    def test_fails_on_the_first_one(self):
        block = "    a = input('a? ')\n    b = input('b? ')\n    print(a, b)\n"
        results = check_files([{"name": "a.py", "text": "def f():\n" + block + "    z = 0\n" + block}])
        row = next(r for r in summarize(results) if r["rule"] == "duplication")
        self.assertTrue(row["failed"])
        (item,) = row["items"]  # the repeated code, for the dropdown
        self.assertEqual((item["file"], item["where"]), ("a.py", "lines 2-4 and 6-8"))
        self.assertEqual(item["snippet"], block.replace("    ", "").rstrip("\n"))
        self.assertEqual(item["other"], item["snippet"])  # both copies, for side by side


class Clean(unittest.TestCase):
    def test_well_formatted_file_has_no_issues(self):
        source = (
            "import random\n\n\n"
            "def first(n):\n    while n > 0:\n        n -= 1\n    return n\n\n\n"
            "def second():\n    for i in range(3):\n        print(i)\n\n\n"
            "if __name__ == '__main__':\n    second()\n"
        )
        self.assertEqual(rules(source), [])

    def test_empty_file(self):
        self.assertEqual(rules(""), [])


class Indentation(unittest.TestCase):
    def test_eight_spaces_where_four_belong(self):
        found = check_source("def f():\n        return 1\n")
        self.assertEqual([(i.rule, i.line) for i in found], [("indentation", 2)])
        self.assertIn("8 spaces", found[0].message)
        self.assertIn("Extra indent", found[0].message)

    def test_extra_indent_deep_in_a_block(self):
        source = "def f(x):\n    if x:\n            return 1\n    return 2\n"
        self.assertEqual(rules(source), [("indentation", 3)])

    def test_indent_after_a_line_that_does_not_open_a_block(self):
        found = check_source("x = 1\n    y = 2\n")
        self.assertEqual([(i.rule, i.line) for i in found], [("indentation", 2)])  # one report, not two
        self.assertIn("doesn't start a block", found[0].message)

    def test_two_space_indent(self):
        found = check_source("def f():\n  return 1\n")
        self.assertEqual([(i.rule, i.line) for i in found], [("indentation", 2)])
        self.assertIn("only 2", found[0].message)

    def test_tabs(self):
        found = check_source("def f():\n\treturn 1\n")
        self.assertEqual([(i.rule, i.line) for i in found], [("indentation", 2)])
        self.assertIn("tab", found[0].message)

    def test_dedent_to_a_level_that_does_not_exist(self):
        source = "def f(x):\n    if x:\n        y = 1\n  z = 2\n"
        found = check_source(source)
        self.assertTrue(any(i.rule == "indentation" and i.line == 4 for i in found))

    def test_continuation_lines_are_not_blocks(self):
        source = "x = foo(1,\n            2,\n                3)\n"
        self.assertEqual(rules(source), [])

    def test_comment_after_colon_still_opens_a_block(self):
        self.assertEqual(rules("if True:  # note\n    pass\n"), [])

    def test_one_line_block_with_a_nested_block(self):
        source = "def f():\n    if True:\n        for i in x:\n            pass\n"
        self.assertEqual(rules(source), [])


class WrappedStatements(unittest.TestCase):
    """A statement that wraps onto more lines may indent its continuation lines any way it likes."""

    def test_wrapped_print_aligned_under_the_opening_parenthesis(self):
        source = (
            "def f(a):\n"
            '    print(f"Once upon a time a student found themselves in a {a} class, "\n'
            '          f"and the teacher was so boring that they daydreamed.")\n'
        )
        self.assertEqual(rules(source), [])

    def test_wrapped_print_with_a_hanging_indent(self):
        source = 'def f(a):\n    print(\n        f"first part",\n        f"second part",\n    )\n'
        self.assertEqual(rules(source), [])

    def test_continuation_indented_by_an_odd_amount_or_a_lot_or_too_little(self):
        for continuation in ("         ", " " * 50, ""):
            source = f'def f(a):\n    if a:\n        print("one",\n{continuation}"two")\n'
            self.assertEqual(rules(source), [], f"continuation indented {len(continuation)}")

    def test_backslash_continuation(self):
        self.assertEqual(rules("def f(a):\n    total = a + \\\n            a + \\\n        a\n    return total\n"), [])

    def test_lists_and_dicts_spread_over_lines(self):
        source = 'def f():\n    data = {"a": 1,\n              "b": 2,\n        "c": 3}\n    return data\n'
        self.assertEqual(rules(source), [])

    def test_triple_quoted_string_lines(self):
        source = 'def f():\n    print("""first\n        second\n            third""")\n'
        self.assertEqual(rules(source), [])

    def test_a_real_extra_indent_after_a_wrapped_statement_is_still_flagged(self):
        source = 'def f(a):\n    print("one",\n          "two")\n        a = 1\n'
        self.assertTrue(any(r == "indentation" for r, _ in rules(source)))


class BlankLines(unittest.TestCase):
    def two(self, gap):
        return "def a():\n    pass\n" + "\n" * gap + "def b():\n    pass\n"

    def test_exactly_two_is_fine(self):
        self.assertEqual(rules(self.two(2)), [])

    def test_one_blank_line(self):
        found = check_source(self.two(1))
        self.assertEqual([(i.rule, i.line) for i in found], [("blank-lines", 4)])
        self.assertIn("1 blank line above", found[0].message)

    def test_zero_blank_lines(self):
        found = check_source(self.two(0))
        self.assertEqual([(i.rule, i.line) for i in found], [("blank-lines", 3)])
        self.assertIn("0 blank lines", found[0].message)

    def test_three_blank_lines(self):
        found = check_source(self.two(3))
        self.assertEqual([(i.rule, i.line) for i in found], [("blank-lines", 6)])
        self.assertIn("3 blank lines", found[0].message)

    def test_five_blank_lines_fail_right_away(self):
        for blanks, failed in ((4, False), (5, True), (9, True)):
            results = check_files([{"name": "a.py", "text": self.two(blanks)}])
            self.assertEqual(row(summarize(results), "blank-lines")["failed"], failed, blanks)

    def test_comment_directly_above_a_def_belongs_to_it(self):
        source = "def a():\n    pass\n\n\n# helper for b\ndef b():\n    pass\n"
        self.assertEqual(rules(source), [])

    def test_blank_lines_before_the_comment_are_counted(self):
        source = "def a():\n    pass\n\n# helper for b\ndef b():\n    pass\n"
        self.assertEqual(rules(source), [("blank-lines", 5)])

    def test_decorators_belong_to_the_function(self):
        source = "def a():\n    pass\n\n\n@decorator\ndef b():\n    pass\n"
        self.assertEqual(rules(source), [])
        source = "def a():\n    pass\n\n@decorator\ndef b():\n    pass\n"
        self.assertEqual(rules(source), [("blank-lines", 5)])

    def test_only_neighbouring_functions_are_checked(self):
        source = "import os\ndef a():\n    pass\nx = 1\ndef b():\n    pass\n"
        self.assertEqual(rules(source), [])

    def test_methods_and_nested_functions_are_not_checked(self):
        source = "class C:\n    def a(self):\n        pass\n    def b(self):\n        pass\n"
        self.assertEqual(rules(source), [])
        source = "def outer():\n    def a():\n        pass\n    def b():\n        pass\n"
        self.assertEqual(rules(source), [])

    def test_whitespace_only_lines_count_as_blank(self):
        source = "def a():\n    pass\n    \n  \ndef b():\n    pass\n"
        self.assertEqual(rules(source), [])

    def test_three_functions_each_gap_is_checked(self):
        source = "def a():\n    pass\n\ndef b():\n    pass\n\n\n\ndef c():\n    pass\n"
        self.assertEqual([r for r, _ in rules(source)], ["blank-lines", "blank-lines"])


class MainBlockSpacing(unittest.TestCase):
    def with_main(self, gap, main="if __name__ == '__main__':"):
        return "def run():\n    pass\n" + "\n" * gap + main + "\n    run()\n"

    def test_two_blank_lines_before_the_main_block_is_fine(self):
        self.assertEqual(rules(self.with_main(2)), [])

    def test_wrong_number_before_the_main_block(self):
        for gap, expected in ((0, "0 blank lines"), (1, "1 blank line "), (3, "3 blank lines")):
            found = check_source(self.with_main(gap))
            self.assertEqual([i.rule for i in found], ["blank-lines"], gap)
            self.assertIn(expected, found[0].message)
            self.assertIn("__main__", found[0].message)

    def test_double_quotes_and_reversed_comparison_are_also_the_main_block(self):
        self.assertEqual(rules(self.with_main(1, 'if __name__ == "__main__":')), [("blank-lines", 4)])
        self.assertEqual(rules(self.with_main(1, "if '__main__' == __name__:")), [("blank-lines", 4)])

    def test_a_comment_directly_above_the_main_block_belongs_to_it(self):
        source = "def run():\n    pass\n\n\n# start here\nif __name__ == '__main__':\n    run()\n"
        self.assertEqual(rules(source), [])

    def test_other_if_statements_are_not_the_main_block(self):
        source = "def run():\n    pass\nif x == 1:\n    run()\n"
        self.assertEqual(rules(source), [])

    def test_only_a_function_directly_before_it_is_checked(self):
        source = "def run():\n    pass\nx = 1\nif __name__ == '__main__':\n    run()\n"
        self.assertEqual(rules(source), [])

    def test_a_main_block_with_no_function_before_it(self):
        self.assertEqual(rules("import os\nif __name__ == '__main__':\n    pass\n"), [])


class NestedWhile(unittest.TestCase):
    def test_while_inside_while(self):
        source = "while a:\n    while b:\n        pass\n"
        found = check_source(source)
        self.assertEqual([(i.rule, i.line) for i in found], [("nested-while", 2)])
        self.assertIn("line 1", found[0].message)

    def test_through_if_and_for(self):
        source = "while a:\n    if x:\n        for i in y:\n            while b:\n                pass\n"
        self.assertEqual(rules(source), [("nested-while", 4)])

    def test_sequential_whiles_are_fine(self):
        self.assertEqual(rules("while a:\n    pass\nwhile b:\n    pass\n"), [])

    def test_for_loops_inside_while_are_fine(self):
        self.assertEqual(rules("while a:\n    for i in x:\n        pass\n"), [])

    def test_while_inside_a_function_defined_in_a_while_starts_fresh(self):
        source = "while a:\n    def f():\n        while b:\n            pass\n"
        self.assertEqual(rules(source), [])

    def test_three_deep_reports_each_inner_loop(self):
        source = "while a:\n    while b:\n        while c:\n            pass\n"
        found = check_source(source)
        self.assertEqual([(i.line, i.message[-6:]) for i in found], [(2, "line 1"), (3, "line 2")])

    def test_while_in_the_else_clause_does_not_count_as_nested(self):
        source = "while a:\n    pass\nelse:\n    while b:\n        pass\n"
        self.assertEqual(rules(source), [])

    def test_inside_a_function(self):
        source = "def f():\n    while a:\n        while b:\n            pass\n"
        self.assertEqual(rules(source), [("nested-while", 3)])


class FunctionLength(unittest.TestCase):
    def test_limit_is_documented_as_20(self):
        self.assertEqual(MAX_FUNCTION_LINES, 20)

    def test_nineteen_lines_is_fine(self):
        self.assertEqual(rules(function_with_lines("f", 19)), [])

    def test_twenty_lines_is_too_long(self):
        found = [i for i in check_source(function_with_lines("f", 20)) if i.rule != "duplication"]
        self.assertEqual([(i.rule, i.line) for i in found], [("function-length", 1)])
        self.assertIn("20 lines", found[0].message)

    def test_blank_lines_and_comments_inside_count(self):
        body = "    x = 1\n\n    # note\n" * 7  # 21 lines of body
        self.assertEqual(rules("def f():\n" + body), [("function-length", 1)])

    def test_every_long_function_is_reported_including_nested_and_methods(self):
        source = (
            "def outer():\n" + "    x = 1\n" * 3 + "    def inner():\n" + "        y = 1\n" * 25 + "    return 1\n"
        )
        self.assertEqual([r for r, _ in rules(source)], ["function-length", "function-length"])

    def test_async_function(self):
        source = "async def f():\n" + "    x = 1\n" * 25
        self.assertEqual(rules(source), [("function-length", 1)])

    def test_decorator_line_is_not_counted(self):
        source = "@decorator\n" + function_with_lines("f", 19)
        self.assertEqual(rules(source), [])


class Unparseable(unittest.TestCase):
    def test_syntax_error_is_reported_once(self):
        found = check_source("def f(:\n    pass\n")
        self.assertEqual([i.rule for i in found], ["syntax"])
        self.assertEqual(found[0].line, 1)

    def test_other_checks_are_skipped_when_the_file_cannot_be_read(self):
        source = "def f(:\n" + "    x = 1\n" * 30
        self.assertEqual([i.rule for i in check_source(source)], ["syntax"])

    def test_unterminated_string(self):
        self.assertEqual([i.rule for i in check_source('x = """never closed\n')], ["syntax"])


class IgnoredFiles(unittest.TestCase):
    def test_names_starting_with_test_are_ignored(self):
        for name in ("test_calculator.py", "tests.py", "testing_area.py", "Test_Words.py", "hw/sub/test_x.py", "C:\\work\\test_x.py"):
            self.assertTrue(is_ignored(name), name)

    def test_other_names_are_not(self):
        for name in ("calculator.py", "my_test.py", "contest.py", "latest.py", "hw/test/solution.py"):
            self.assertFalse(is_ignored(name), name)

    def test_check_files_leaves_ignored_files_out(self):
        bad = "while a:\n    while b:\n        pass\n"
        result = check_files([{"name": "test_words.py", "text": bad}, {"name": "words.py", "text": bad}])
        self.assertEqual([r["name"] for r in result], ["words.py"])

    def test_scanning_a_folder_skips_them_but_a_named_file_is_checked(self):
        bad = "while a:\n    while b:\n        pass\n"
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "test_words.py").write_text(bad)
            self.assertEqual(quality.main([folder]), 0)  # only a test file in the folder: nothing to report
            self.assertEqual(quality.main([str(Path(folder) / "test_words.py")]), 1)  # asked for by name


def result(name, *rules_found):
    return {"name": name, "issues": [{"rule": r, "line": 1, "message": ""} for r in rules_found]}


def row(rows, rule):
    return next(r for r in rows if r["rule"] == rule)


class Summary(unittest.TestCase):
    """Indentation and blank lines fail only when broken MORE THAN TWICE across all the files together."""

    def test_two_slips_in_total_are_tolerated(self):
        for rule in ("indentation", "blank-lines"):
            rows = summarize([result("a.py", rule), result("b.py", rule)])
            self.assertFalse(row(rows, rule)["failed"], rule)
            self.assertEqual(row(rows, rule)["count"], 2)
            self.assertEqual(row(rows, rule)["files"], [], "no files listed unless it failed")

    def test_a_third_slip_fails_it_even_when_spread_over_files(self):
        for rule in ("indentation", "blank-lines"):
            rows = summarize([result("a.py", rule, rule), result("b.py", rule), result("c.py")])
            self.assertTrue(row(rows, rule)["failed"], rule)
            self.assertEqual(row(rows, rule)["files"], ["a.py", "b.py"])  # the files that broke it

    def test_the_count_is_over_all_files_not_per_file(self):
        rows = summarize([result("a.py", "blank-lines", "blank-lines"), result("b.py", "blank-lines", "blank-lines")])
        self.assertTrue(row(rows, "blank-lines")["failed"])  # 2 + 2 = 4, though neither file has more than 2

    def test_the_two_spacing_checks_are_counted_separately(self):
        rows = summarize([result("a.py", "indentation", "indentation", "blank-lines", "blank-lines")])
        self.assertFalse(row(rows, "indentation")["failed"])
        self.assertFalse(row(rows, "blank-lines")["failed"])

    def test_nested_while_and_function_length_fail_on_the_first(self):
        rows = summarize([result("a.py", "nested-while", "function-length"), result("b.py")])
        self.assertTrue(row(rows, "nested-while")["failed"])
        self.assertTrue(row(rows, "function-length")["failed"])
        self.assertEqual(row(rows, "nested-while")["files"], ["a.py"])

    def test_everything_passes_when_nothing_was_found(self):
        rows = summarize([result("a.py"), result("b.py")])
        self.assertEqual([r["failed"] for r in rows], [False] * 5)
        self.assertEqual([r["rule"] for r in rows], ["indentation", "blank-lines", "nested-while", "function-length", "duplication"])

    def test_labels(self):
        labels = {r["rule"]: r["label"] for r in summarize([])}
        self.assertEqual(labels["function-length"], "Functions longer than 20 lines")
        self.assertEqual(labels["blank-lines"], "2 blank lines between functions")

    def test_a_file_python_cannot_read_adds_a_row_that_fails_at_once(self):
        rows = summarize([result("a.py", "syntax")])
        self.assertTrue(row(rows, "syntax")["failed"])
        self.assertEqual(row(rows, "syntax")["label"], "Python can't read the file")
        self.assertNotIn("syntax", [r["rule"] for r in summarize([result("a.py")])])

    def test_real_files_end_to_end(self):
        slip = "def a():\n    pass\ndef b():\n    pass\n"  # no blank lines between the functions
        two = summarize(check_files([{"name": "x.py", "text": slip}, {"name": "y.py", "text": slip}]))
        self.assertFalse(row(two, "blank-lines")["failed"])
        three = summarize(check_files([{"name": n, "text": slip} for n in ("x.py", "y.py", "z.py")]))
        self.assertTrue(row(three, "blank-lines")["failed"])
        self.assertEqual(row(three, "blank-lines")["files"], ["x.py", "y.py", "z.py"])


class Api(unittest.TestCase):
    def test_check_files_is_json_friendly(self):
        import json

        result = check_files([
            {"name": "ok.py", "text": "x = 1\n"},
            {"name": "bad.py", "text": "while a:\n    while b:\n        pass\n"},
        ])
        self.assertEqual(result[0], {"name": "ok.py", "issues": []})
        self.assertEqual(result[1]["issues"][0]["rule"], "nested-while")
        json.dumps(result)

    def test_command_line(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "good.py").write_text("x = 1\n")
            self.assertEqual(quality.main([folder]), 0)
            (Path(folder) / "bad.py").write_text("while a:\n    while b:\n        pass\n")
            self.assertEqual(quality.main([folder]), 1)
        self.assertEqual(quality.main([]), 2)

    def test_command_line_tolerates_two_spacing_slips_but_not_three(self):
        slip = "def a():\n    pass\ndef b():\n    pass\n"
        with tempfile.TemporaryDirectory() as folder:
            for name in ("one.py", "two.py"):
                (Path(folder) / name).write_text(slip)
            self.assertEqual(quality.main([folder]), 0)
            (Path(folder) / "three.py").write_text(slip)
            self.assertEqual(quality.main([folder]), 1)


if __name__ == "__main__":
    unittest.main()
