"""Tests for checker/quality.py. Run: python3 test/quality_test.py"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from checker import quality  # noqa: E402
from checker.quality import MAX_FUNCTION_LINES, check_files, check_source  # noqa: E402


def rules(source):
    return [(i.rule, i.line) for i in check_source(source)]


def function_with_lines(name, total):
    """A function that is exactly `total` physical lines long, def line included."""
    return f"def {name}():\n" + "    x = 1\n" * (total - 1)


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
        found = check_source(function_with_lines("f", 20))
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


if __name__ == "__main__":
    unittest.main()
