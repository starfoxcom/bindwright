"""Tests for .github/scripts/pin_check.py, the weekly pin check's report."""

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".github", "scripts"))
import pin_check  # noqa: E402

OLD_SHA = "7ada98c10deffc4c13fe5079693edf312888ff3b"
NEW_SHA = "1234567890abcdef1234567890abcdef12345678"
WORKFLOW = f"""\
jobs:
  review:
    env:
      CLI_VERSION: "2.1.300"
    steps:
      - uses: anthropics/claude-code-action@{OLD_SHA}  # v1 (v1.0.213)
      - name: backup
        env:
          CLI_VERSION: "2.1.280"
        uses: anthropics/claude-code-action@{OLD_SHA}  # v1 (v1.0.213)
"""


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = pin_check.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class Pins(unittest.TestCase):
    def test_every_pin_is_found_with_its_place(self):
        got = pin_check.pins("w.yml", WORKFLOW)
        self.assertEqual(got, [("cli", "2.1.300", "2.1.300", "w.yml:4"),
                               ("action", OLD_SHA, "v1 (v1.0.213)", "w.yml:6"),
                               ("cli", "2.1.280", "2.1.280", "w.yml:9"),
                               ("action", OLD_SHA, "v1 (v1.0.213)", "w.yml:10")])

    def test_other_lines_are_not_pins(self):
        for line in ('  CLI_VERSION: "${{ env.X }}"', "  # CLI_VERSION: 2.1.1", 'NOT_CLI_VERSION: "2.1.1"',
                     "  uses: anthropics/claude-code-action@v1", "  uses: other/claude-code-action@" + OLD_SHA,
                     '  echo "uses: anthropics/claude-code-action@' + OLD_SHA + '"'):
            with self.subTest(line=line):
                self.assertEqual(pin_check.pins("w", line), [])

    def test_a_pin_without_a_comment_is_named_by_its_sha(self):
        got = pin_check.pins("w", "uses: anthropics/claude-code-action@" + OLD_SHA)
        self.assertEqual(got[0][2], OLD_SHA[:12])

    def test_quotes_and_a_trailing_comment_are_optional(self):
        for line in ("  PINNED_VERSION: 2.1.299", '  PINNED_VERSION: "2.1.299"  # mods'):
            with self.subTest(line=line):
                self.assertEqual(pin_check.pins("w", line)[0][1], "2.1.299")


class Behind(unittest.TestCase):
    FOUND = pin_check.pins("w.yml", WORKFLOW)

    def test_versions_compare_as_numbers(self):
        # 2.1.300 is newer than 2.1.31, though not as text.
        for newest, stale in (("2.1.300", ["2.1.280"]), ("2.1.299", ["2.1.280"]), ("2.1.301", ["2.1.300", "2.1.280"]),
                              ("2.1.280", []), ("2.2.0", ["2.1.300", "2.1.280"]), ("2.1.31", [])):
            with self.subTest(newest=newest):
                got = pin_check.behind(self.FOUND, newest, OLD_SHA)
                self.assertEqual([label for kind, label, _ in got if kind == "cli"], stale)

    def test_an_action_pin_off_the_newest_commit_is_behind_once_with_every_place(self):
        got = pin_check.behind(self.FOUND, "2.1.280", NEW_SHA)
        self.assertEqual(got, [("action", "v1 (v1.0.213)", ["w.yml:6", "w.yml:10"])])
        self.assertEqual(pin_check.behind(self.FOUND, "2.1.280", OLD_SHA), [])


class Main(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".yml")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(WORKFLOW)
        self.addCleanup(os.remove, self.path)

    def test_the_report_lists_each_stale_value_once(self):
        code, out, _ = run("--cli", "2.1.300", "--action-sha", NEW_SHA, "--action-version", "v1.0.220", self.path)
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(len(lines), 2, out)
        self.assertIn("- CLI `2.1.280` is behind the newest CLI 2.1.300: `%s:9`" % self.path, lines)
        self.assertIn("- Review action `v1 (v1.0.213)` is behind the newest action v1.0.220: `%s:6`, `%s:10`"
                      % (self.path, self.path), lines)

    def test_nothing_is_printed_when_every_pin_is_current(self):
        self.assertEqual(run("--cli", "2.1.280", "--action-sha", OLD_SHA, "--action-version", "v1.0.213", self.path),
                         (0, "", ""))

    def test_an_action_used_by_a_tag_is_listed(self):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write("      - uses: actions/checkout@v6\n      - uses: ./local-action\n"
                     "      - uses: actions/setup-python@" + OLD_SHA + "  # v6\n"
                     "      - uses: docker://alpine:3.20\n"
                     "      - uses: 'docker://alpine@sha256:" + "0" * 64 + "'\n")
        _, out, _ = run("--cli", "2.1.280", "--action-sha", OLD_SHA, "--action-version", "v1.0.213", self.path)
        self.assertEqual(out, "- Action `actions/checkout@v6` at `%s:11` is not pinned to a commit\n"
                              "- Action `docker://alpine:3.20` at `%s:14` is not pinned to a commit\n"
                              % (self.path, self.path))

    def test_bad_arguments_and_missing_files_fail(self):
        for argv in ([], ["--cli", "2.1.300", "--action-sha", OLD_SHA, "--action-version", "v1"],
                     ["--cli", "latest", "--action-sha", OLD_SHA, "--action-version", "v1", self.path],
                     ["--cli", "2.1.300", "--action-sha", "v1", "--action-version", "v1", self.path],
                     ["--cli", "2.1.300", "--action-sha", OLD_SHA, "--action-version", "v1", self.path + ".gone"],
                     ["--cli"]):
            with self.subTest(argv=argv):
                code, out, err = run(*argv)
                self.assertEqual((code, out), (1, ""))
                self.assertTrue(err.startswith("pin_check: "), err)


TAG_SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"
DIFF = f"""\
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,6 @@
-      - uses: actions/checkout@v6
+      - uses: actions/checkout@{NEW_SHA}  # v6 (v6.1.0)
+      - uses: github/codeql-action/init@{OLD_SHA} # v3.2.1
+      - uses: actions/cache@v4
+      - uses: ../../evil/x@{NEW_SHA}  # v1
+      - uses: local/plain@{OLD_SHA}
       - uses: actions/setup-node@{OLD_SHA}  # v4
"""


class AddedPins(unittest.TestCase):
    def test_reads_each_pin_the_diff_adds_with_its_tags(self):
        self.assertEqual(pin_check.added_pins(DIFF), [
            ("actions/checkout", NEW_SHA, ["v6", "v6.1.0"]),
            ("github/codeql-action", OLD_SHA, ["v3.2.1"]),
            ("local/plain", OLD_SHA, []),
        ])

    def test_keeps_the_first_tags_and_splits_only_on_newlines(self):
        many = " ".join("v%d" % i for i in range(1, 50))
        line = "+  uses: o/r@%s  # %s\x0c+  uses: p/q@%s  # v1\n" % (NEW_SHA, many, OLD_SHA)
        self.assertEqual(pin_check.added_pins(line), [("o/r", NEW_SHA, ["v1", "v2", "v3", "v4"])])


class Provenance(unittest.TestCase):
    """Each outcome a lookup can have, against a fake API."""

    REFS = {
        "repos/o/r/git/ref/tags/v1.2.0": {"object": {"type": "commit", "sha": NEW_SHA}},
        "repos/o/r/git/ref/tags/v1": {"object": {"type": "commit", "sha": OLD_SHA}},
        "repos/o/r/git/ref/tags/v2": {"object": {"type": "tag", "sha": TAG_SHA}},
        "repos/o/r/git/tags/" + TAG_SHA: {"object": {"type": "commit", "sha": NEW_SHA}},
        "repos/o/r/git/ref/tags/v3": [{"ref": "refs/tags/v3.0.0"}],
    }

    def fetch(self, path):
        if path == "repos/o/r/git/ref/tags/v9":
            raise LookupError("HTTP 502")
        return self.REFS.get(path)

    def test_says_which_tags_point_to_the_pinned_commit(self):
        cases = [
            ("matching tag", ["v1.2.0"], "tag `v1.2.0` points to this commit."),
            ("annotated tag", ["v2"], "tag `v2` points to this commit."),
            ("moved tag", ["v1"], "tag `v1` points to `%s`, not this commit." % OLD_SHA),
            ("no such tag", ["v4"], "`o/r` has no tag `v4`."),
            ("prefix match only", ["v3"], "`o/r` has no tag `v3`."),
            ("api error", ["v9"], "tag `v9` could not be looked up (HTTP 502)."),
            ("no tag named", [], "its comment names no release tag, so there is nothing to check it against."),
        ]
        for label, tags, want in cases:
            with self.subTest(label):
                got = pin_check.provenance([("o/r", NEW_SHA, tags)], self.fetch)
                self.assertEqual(got, "- `o/r@%s`: %s\n" % (NEW_SHA, want))

    def test_looks_each_tag_up_once(self):
        calls = []
        pin_check.provenance([("o/r", NEW_SHA, ["v1.2.0"]), ("o/r", OLD_SHA, ["v1.2.0"])],
                             lambda path: calls.append(path) or self.fetch(path))
        self.assertEqual(calls, ["repos/o/r/git/ref/tags/v1.2.0"])

    def test_caps_the_lookups(self):
        found = [("o/r", NEW_SHA, [])] * (pin_check.MAX_PINS + 2)
        got = pin_check.provenance(found, self.fetch).splitlines()
        self.assertEqual((len(got), got[-1]), (pin_check.MAX_PINS + 1, "- 2 more pins were not looked up."))


if __name__ == "__main__":
    unittest.main()
