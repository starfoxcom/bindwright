"""Tests for _core/project-template/.claude/hooks/live-check.py, the observe-only guard that notes
a pull request adding a write to an outside service without a `Live check:` line in its body.

The hook asks GitHub for the pull request through gh; these tests stand in for gh alone, the
network edge, with a fake that answers the two reads the hook makes and fails any other call.
BINDWRIGHT_HOME points at a temp folder, so the real log is never touched.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "_core", "project-template", ".claude", "hooks", "live-check.py")
ADDRESS = "https://github.com/owner/repo/pull/12"
POST_LINE = "requests.post(url, json=payload)"
PLAIN_LINE = "def add(a, b):"
BODY = "## What\nAdds the sync.\n"
BODY_WITH_CHECK = "## What\nAdds the sync.\n\n- Live check: sent one POST to the test account, got 201.\n"


def load_hook():
    """The hook as a module, loaded without a bytecode cache, which would land in the template."""
    spec = importlib.util.spec_from_file_location("live_check", HOOK)
    module = importlib.util.module_from_spec(spec)
    with mock.patch.object(sys, "dont_write_bytecode", True):
        spec.loader.exec_module(module)
    return module


def diff_of(path, lines):
    """A unified diff that adds `lines` to `path`, as gh pr diff prints it."""
    return ("diff --git a/%s b/%s\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/%s\n"
            "@@ -0,0 +1,%d @@\n" % (path, path, path, len(lines))) + "".join("+" + line + "\n" for line in lines)


def event(command="gh pr create --base develop --body-file body.md", stdout=ADDRESS + "\n", tool="Bash"):
    return {"tool_name": tool, "tool_input": {"command": command},
            "tool_response": {"stdout": stdout, "stderr": ""}, "cwd": "/repo"}


def fake_gh(body, diff):
    """gh answering the pull request's body and diff for ADDRESS, and failing every other call."""
    def gh(*args):
        if args[:3] == ("pr", "view", ADDRESS) and args[3:] == ("--json", "body", "--jq", ".body"):
            return body
        if args[:3] == ("pr", "diff", ADDRESS):
            return diff
        return None
    return gh


class HookTest(unittest.TestCase):
    def setUp(self):
        self.hook = load_hook()
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        patcher = mock.patch.dict(os.environ, {"BINDWRIGHT_HOME": self.home.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def observe(self, the_event, body=BODY, diff=None):
        self.hook.gh = fake_gh(body, diff_of("api.py", [POST_LINE]) if diff is None else diff)
        return self.hook.observe(the_event)

    def observed(self):
        path = os.path.join(self.home.name, "live-check", "observed.jsonl")
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]


class WhichCalls(HookTest):
    # name, event, a note expected
    ROWS = [
        ("a create that prints its address notes", event(), True),
        ("an edit that prints its address notes", event("gh pr edit 12 --body-file body.md"), True),
        ("a PowerShell create notes", event(tool="PowerShell"), True),
        ("output under `output` instead of `stdout` notes",
         dict(event(), tool_response={"output": ADDRESS + "\n"}), True),
        ("another gh command makes no note", event("gh issue create --body-file body.md"), False),
        ("a command that only mentions a create but prints no address makes no note",
         event("echo gh pr create", stdout="gh pr create\n"), False),
        ("an address inside a sentence makes no note", event(stdout="Opened " + ADDRESS + " today\n"), False),
        ("two addresses make no note", event(stdout=ADDRESS + "\n" + ADDRESS + "3\n"), False),
        ("a tool that is not a shell makes no note", dict(event(), tool_name="Read"), False),
        ("a failed create with no output makes no note", dict(event(), tool_response={"stdout": ""}), False),
    ]

    def test_which_calls_are_read(self):
        for name, the_event, expect_note in self.ROWS:
            with self.subTest(name):
                self.assertEqual(self.observe(the_event), expect_note)


class WhatThePullRequestHolds(HookTest):
    # name, body, diff, a note expected
    ROWS = [
        ("a write and no Live check line notes", BODY, diff_of("api.py", [POST_LINE]), True),
        ("a body with the Live check line makes no note", BODY_WITH_CHECK, diff_of("api.py", [POST_LINE]), False),
        ("a dash-list Live check line makes no note", "- Live check: sent it\n", diff_of("api.py", [POST_LINE]),
         False),
        ("a Live check after a form feed mid-line is no Live check line",
         "See \x0cLive check: later\n", diff_of("api.py", [POST_LINE]), True),
        ("a diff that adds no write makes no note", BODY, diff_of("api.py", [PLAIN_LINE]), False),
        ("a body gh cannot read makes no note", None, diff_of("api.py", [POST_LINE]), False),
        ("a diff gh cannot read makes no note", BODY, None, False),
        ("a test_ file makes no note", BODY, diff_of("tools/test_sync.py", [POST_LINE]), False),
        ("a .test. file makes no note", BODY, diff_of("engine/test/sync.test.js", [POST_LINE]), False),
        ("a file under tests/ makes no note", BODY, diff_of("tests/fakes.py", [POST_LINE]), False),
        ("a _test. file makes no note", BODY, diff_of("sync_test.go", [POST_LINE]), False),
        ("the bind's record makes no note", BODY, diff_of(".bindwright/pristine.json", [POST_LINE]), False),
        ("a file whose name only holds the word test notes", BODY, diff_of("latest.py", [POST_LINE]), True),
        ("a write after a test file's section notes",
         BODY, diff_of("tests/fakes.py", [POST_LINE]) + diff_of("api.py", [POST_LINE]), True),
        ("an added line that reads like a header keeps its file",
         BODY, diff_of("api.py", ["++ b/tests/fakes.py", POST_LINE]), True),
        ("a form feed inside an added line does not start a new section",
         BODY, diff_of("api.py", ["x = '\x0cdiff --git a/t b/tests/t'", POST_LINE]), True),
        ("a line past 500 characters, as in a minified bundle, is skipped",
         BODY, diff_of("api.py", ["requests.post(" + "gh api x " * 60 + ")"]), False),
    ]

    def test_pull_request_rows(self):
        for name, body, diff, expect_note in self.ROWS:
            with self.subTest(name):
                self.hook.gh = fake_gh(body, diff)
                self.assertEqual(self.hook.observe(event()), expect_note)


class WriteLines(HookTest):
    # name, added line, a write expected
    ROWS = [
        ("gh api with -X POST", 'gh api -X POST repos/owner/repo/issues', True),
        ("gh api with --method=DELETE", 'gh api --method=DELETE repos/owner/repo/labels/x', True),
        ("gh api with a lowercase write method", 'gh api -X patch repos/owner/repo', True),
        ("a _gh call with a PUT string", '_gh("repos/owner/repo", "PUT", payload)', True),
        ("requests.patch", "requests.patch(url, json=data)", True),
        ("httpx.delete", "httpx.delete(url)", True),
        ("axios.post", "axios.post(url, body)", True),
        ("fetch with a POST method", 'fetch(url, { method: "POST", body })', True),
        ("gh api with a GET makes no write", "gh api repos/owner/repo", False),
        ("gh api with -X GET makes no write", "gh api -X GET repos/owner/repo", False),
        ("a _gh call with a GET string", '_gh("repos/owner/repo", "GET")', False),
        ("requests.get makes no write", "requests.get(url)", False),
        ("fetch with a GET method makes no write", 'fetch(url, { method: "GET" })', False),
    ]

    def test_write_rows(self):
        for name, line, expect_write in self.ROWS:
            with self.subTest(name):
                self.assertEqual(bool(self.hook.write_lines(diff_of("api.py", [line]))), expect_write)


class LogEntry(HookTest):
    def test_entry_keeps_five_matches_cut_to_200_characters(self):
        lines = ['gh api -X POST repos/owner/repo/%s%d' % ("x" * 300, i) for i in range(7)]
        self.assertTrue(self.observe(event(), diff=diff_of("api.py", lines)))
        entries = self.observed()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["pull_request"], ADDRESS)
        self.assertEqual(len(entries[0]["matches"]), 5)
        self.assertTrue(all(len(match) <= 200 for match in entries[0]["matches"]))
        self.assertTrue(entries[0]["time"])


class NeverBlocks(unittest.TestCase):
    def run_hook(self, stdin, path):
        env = dict(os.environ, PATH=path)
        with tempfile.TemporaryDirectory() as home:
            env["BINDWRIGHT_HOME"] = home
            return subprocess.run([sys.executable, "-I", HOOK], input=stdin, capture_output=True, env=env,
                                  timeout=60)

    def test_every_failure_exits_0_with_nothing_said(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(os.rmdir, empty)
        for name, stdin in [("input that is not JSON", b"{not json"),
                            ("a create with no gh on PATH", json.dumps(event()).encode())]:
            with self.subTest(name):
                done = self.run_hook(stdin, empty)
                self.assertEqual(done.returncode, 0)
                self.assertEqual(done.stdout, b"")

    def test_a_note_reaches_the_session_as_context(self):
        hook = load_hook()
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"BINDWRIGHT_HOME": home}), \
                mock.patch("sys.stdin", mock.Mock(buffer=mock.Mock(read=lambda: json.dumps(event()).encode()))), \
                mock.patch("builtins.print") as printed:
            hook.gh = fake_gh(BODY, diff_of("api.py", [POST_LINE]))
            self.assertEqual(hook.main(), 0)
        output = json.loads(printed.call_args[0][0])["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PostToolUse")
        self.assertIn("Live check:", output["additionalContext"])


if __name__ == "__main__":
    unittest.main()
