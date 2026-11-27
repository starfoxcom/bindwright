"""The guards' path helpers stay identical in every copy.

Each guard is installed on its own: tool-rules.py into the user's hook folder,
version-check.py and the attribution guard into the project's, and
version_check.py into .github/scripts, which CI runs with `python -I`. No
folder holds all four, so they cannot import one shared module, and this test
keeps the copies from drifting instead. Each guard starts repo_folder from a
different place, but the function is the same in all four.
"""

import ast
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARDS = [
    "_core/global-template/hooks/tool-rules.py",
    "_core/project-template/.claude/hooks/no_ai_attribution/shell.py",
    "_core/project-template/.claude/hooks/version-check.py",
    "_core/project-template/.github/scripts/version_check.py",
]
SHARED = ("real_path", "resolved", "is_within", "repo_folder")


def functions(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        text = fh.read()
    return {node.name: ast.get_source_segment(text, node)
            for node in ast.parse(text).body if isinstance(node, ast.FunctionDef)}


class GuardCopies(unittest.TestCase):
    def test_the_path_helpers_match_in_every_guard(self):
        first, *rest = GUARDS
        expected = functions(first)
        for path in rest:
            found = functions(path)
            for name in SHARED:
                with self.subTest(guard=path, helper=name):
                    self.assertIsNotNone(found.get(name), "missing")
                    self.assertEqual(found[name], expected[name])


if __name__ == "__main__":
    unittest.main()
