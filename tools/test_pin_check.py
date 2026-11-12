"""Tests for .github/scripts/pin_check.py, the weekly pin check's report."""

import io
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
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

    def test_takes_only_checked_fields(self):
        cases = [
            ("quoted value", "+  uses: 'o/r@%s'  # v1" % NEW_SHA, [("o/r", NEW_SHA, ["v1"])]),
            ("hash glued to the id", "+  uses: o/r@%s#x v1" % NEW_SHA, []),
            ("quote glued to the id", '+  uses: o/r@%s"x # v1' % NEW_SHA, []),
            ("double-quoted value", '+  uses: "o/r@%s"  # v1' % NEW_SHA, [("o/r", NEW_SHA, ["v1"])]),
            ("unclosed quote", "+  uses: 'o/r@%s  # v1" % NEW_SHA, []),
            ("no-break space after the id", "+  uses: o/r@%s\u00a0x  # v1" % NEW_SHA, []),
            ("id with trailing text", "+  uses: o/r@%sz  # v1" % NEW_SHA, []),
            ("non-ASCII owner", "+  uses: ö/r@%s  # v1" % NEW_SHA, []),
            ("non-ASCII digit in a tag", "+  uses: o/r@%s  # v١ v2" % NEW_SHA, [("o/r", NEW_SHA, ["v2"])]),
            ("overlong tag", "+  uses: o/r@%s  # v%s v2" % (NEW_SHA, "1" * 60), [("o/r", NEW_SHA, ["v2"])]),
            ("overlong owner", "+  uses: %s/r@%s  # v1" % ("o" * 40, NEW_SHA), []),
            ("diff header", "+++ b/uses: o/r@%s  # v1" % NEW_SHA, []),
        ]
        for label, line, want in cases:
            with self.subTest(label):
                self.assertEqual(pin_check.added_pins(line + "\n"), want)


class Provenance(unittest.TestCase):
    """Each outcome a lookup can have, against a fake API."""

    REFS = {
        "repos/o/r/git/ref/tags/v1.2.0": {"object": {"type": "commit", "sha": NEW_SHA}},
        "repos/o/r/git/ref/tags/v1": {"object": {"type": "commit", "sha": OLD_SHA}},
        "repos/o/r/git/ref/tags/v2": {"object": {"type": "tag", "sha": TAG_SHA}},
        "repos/o/r/git/tags/" + TAG_SHA: {"object": {"type": "commit", "sha": NEW_SHA}},
        "repos/o/r/git/ref/tags/v3": [{"ref": "refs/tags/v3.0.0"}],
        "repos/o/r/git/ref/tags/v5": {"object": {"type": "tag", "sha": "1" * 40}},
        "repos/o/r/git/tags/" + "1" * 40: {"object": {"type": "tag", "sha": "2" * 40}},
        "repos/o/r/git/tags/" + "2" * 40: {"object": {"type": "commit", "sha": NEW_SHA}},
        "repos/o/r/git/ref/tags/v6": {"ref": "refs/tags/v6"},
        "repos/o/r/git/ref/tags/v7": {"object": {"type": "tag", "sha": "3" * 40}},
        "repos/o/r/git/ref/tags/v8": {"object": {"type": "tree", "sha": NEW_SHA}},
    }

    def fetch(self, path):
        if path == "repos/o/r/git/ref/tags/v9":
            raise LookupError(path)
        return self.REFS.get(path)

    def verdict(self, tags, sha=NEW_SHA):
        line = pin_check.provenance([("o/r", sha, tags)], self.fetch)
        return line.removeprefix("- `o/r@%s`: " % sha).rstrip("\n")

    def test_verifies_a_pin_only_on_a_tag_at_its_commit(self):
        cases = [
            ("matching tag", ["v1.2.0"], "verified: tag `v1.2.0` points to this commit."),
            ("annotated tag", ["v2"], "verified: tag `v2` points to this commit."),
            ("tag on a tag", ["v5"], "verified: tag `v5` points to this commit."),
            ("major tag moved on", ["v1", "v1.2.0"], "verified: tag `v1.2.0` points to this commit."),
            ("only a moved tag", ["v1"], "not verified: no tag it names points to this commit."),
            ("no such tag", ["v4"], "not verified: no tag it names points to this commit."),
            ("prefix match only", ["v3"], "not verified: no tag it names points to this commit."),
            ("reply without an object", ["v6"], "not verified: no tag it names points to this commit."),
            ("annotated tag object missing", ["v7"], "not verified: no tag it names points to this commit."),
            ("not a commit", ["v8"], "not verified: no tag it names points to this commit."),
            ("api error", ["v9"], "not verified: a lookup failed."),
            ("no tag named", [], "not verified: its comment names no release tag."),
        ]
        for label, tags, want in cases:
            with self.subTest(label):
                self.assertEqual(self.verdict(tags), want)

    def test_looks_each_tag_up_once_and_judges_each_pin(self):
        calls = []
        got = pin_check.provenance([("o/r", NEW_SHA, ["v1.2.0"]), ("o/r", OLD_SHA, ["v1.2.0"])],
                                   lambda path: calls.append(path) or self.fetch(path))
        self.assertEqual(calls, ["repos/o/r/git/ref/tags/v1.2.0"])
        self.assertEqual(got, "- `o/r@%s`: verified: tag `v1.2.0` points to this commit.\n"
                              "- `o/r@%s`: not verified: no tag it names points to this commit.\n"
                              % (NEW_SHA, OLD_SHA))

    def test_caps_the_lookups(self):
        found = [("o/r", NEW_SHA, [])] * (pin_check.MAX_PINS + 2)
        got = pin_check.provenance(found, self.fetch).splitlines()
        self.assertEqual((len(got), got[-1]), (pin_check.MAX_PINS + 1, "- 2 more pins were not looked up."))


def completed(code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(["gh"], code, stdout, stderr)


class GhFetch(unittest.TestCase):
    """`gh api` replies, with the process and the retry pause faked."""

    def fetch(self, *replies):
        calls = iter(replies)

        def run(*_args, **_kwargs):
            reply = next(calls)
            if isinstance(reply, Exception):
                raise reply
            return reply

        with mock.patch.object(pin_check.subprocess, "run", side_effect=run) as fake, \
                mock.patch.object(pin_check.time, "sleep"):
            try:
                return pin_check.gh_fetch("repos/o/r/git/ref/tags/v1"), fake.call_count
            except LookupError:
                return LookupError, fake.call_count

    def test_reads_each_reply(self):
        timeout = subprocess.TimeoutExpired(["gh"], 15)
        cases = [
            ("json", [completed(stdout='{"a": 1}')], ({"a": 1}, 1)),
            ("404", [completed(1, stderr="gh: Not Found (HTTP 404)")], (None, 1)),
            ("error then json", [completed(1, stderr="HTTP 502"), completed(stdout="[]")], ([], 2)),
            ("two errors", [completed(1, stderr="HTTP 403"), completed(1, stderr="HTTP 403")], (LookupError, 2)),
            ("not json twice", [completed(stdout="<html>"), completed(stdout="<html>")], (LookupError, 2)),
            ("timeout then missing gh", [timeout, OSError("no gh")], (LookupError, 2)),
        ]
        for label, replies, want in cases:
            with self.subTest(label):
                self.assertEqual(self.fetch(*replies), want)

    def test_added_reads_the_diff_from_stdin(self):
        ref = '{"object": {"type": "commit", "sha": "%s"}}' % NEW_SHA
        with mock.patch.object(pin_check.subprocess, "run", return_value=completed(stdout=ref)), \
                mock.patch.object(sys, "stdin", io.StringIO(DIFF)):
            code, out, _ = run("added")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines()[0], "- `actions/checkout@%s`: verified: tag `v6` points to this commit."
                         % NEW_SHA)


if __name__ == "__main__":
    unittest.main()
