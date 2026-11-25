"""Long commands stay fast in every guard's text checks. A check past the hook's timeout ends in
a refusal of the command, so a pattern whose time grows with the square or cube of the input
would refuse ordinary long commands and PR bodies."""
import importlib.util
import os
import shutil
import sys
import tempfile
import time
import unittest

# The hooks load from the templates, where a __pycache__ folder would ship with every bind.
sys.dont_write_bytecode = True

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS = os.path.join(REPO, "_core", "global-template", "hooks")
PROJECT_HOOKS = os.path.join(REPO, "_core", "project-template", ".claude", "hooks")
# Each row runs in milliseconds; the patterns this guards against took from 3 s to minutes.
SECONDS = 1.0


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LongInputTest(unittest.TestCase):

    def setUp(self):
        self.rules = load("tool_rules", os.path.join(HOOKS, "tool-rules.py"))
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        self.rules.OBSERVED_LOG = os.path.join(folder, "observed.jsonl")
        self.rules.GIT_BASH = True
        self.attribution = load("no_ai_attribution_hook", os.path.join(HOOKS, "no-ai-attribution.py"))
        self.version = load("version_check", os.path.join(PROJECT_HOOKS, "version-check.py"))

    def test_each_check_finishes_long_input_in_time(self):
        scan = self.attribution.ATTRIBUTION.search
        rows = [
            ("observe log: a long run with no digit", lambda t: self.rules.refusal(t, "bash"),
             "gh pr create --body " + "x" * 40000),
            ("tool rules: PowerShell here-strings that never close", lambda t: self.rules.refusal(t, "powershell"),
             "@'\n" * 6000),
            ("tool rules: a here-document full of `(`", lambda t: self.rules.refusal(t, "bash"),
             "cat <<EOF\n" + "(" * 100000 + "\nEOF"),
            *[(f"tool rules: one line of repeated `{word}`", lambda t: self.rules.refusal(t, "bash"),
               (word + " ") * (100000 // len(word)))
              for word in ("gh pr merge", "gh run rerun", "git stash", "gh pr create", "git show", "git commit -m",
                           "gh pr edit --title")],
            # Just under the length rows' 10 000-character cap, so each is split and read in full.
            *[(f"tool rules: one plain command of many `{word}` words", lambda t: self.rules.refusal(t, "bash"),
               "git " + word * 1980 + "commit -m 'x'")
              for word in ("-c x ", "-C x ")],
            ("tool rules: a commit of many short-option clusters", lambda t: self.rules.refusal(t, "bash"),
             "git commit " + "-av " * 2470 + "-m 'x'"),
            ("tool rules: a PR edit of many titles", lambda t: self.rules.refusal(t, "bash"),
             "gh pr edit " + "-t x " * 1975),
            *[(f"tool rules: a branch switch before many blank lines ({shell})",
               lambda t, shell=shell: self.rules.refusal(t, shell), "git checkout x" + "\n" * 100000)
              for shell in ("bash", "powershell")],
            ("attribution: one line of repeated `gh pr`", self.attribution.routes_in, "gh pr " * 3000),
            ("attribution: one line of repeated `git config`", self.attribution.routes_in, "git config " * 2000),
            ("attribution: a long separator run after `made by`", scan, "made by" + " " * 20000 + "x"),
            ("attribution: a long separator run after `ai`", scan, "ai" + " " * 20000 + "x"),
            ("attribution: a long blank run after a co-author trailer", scan,
             "Co-Authored-By" + " " * 20000 + "x"),
            ("version check: repeated `gh pr`", self.version.may_be_release, "gh pr " * 3000),
        ]
        for name, check, text in rows:
            with self.subTest(name):
                start = time.perf_counter()
                check(text)
                self.assertLess(time.perf_counter() - start, SECONDS)


if __name__ == "__main__":
    unittest.main()
