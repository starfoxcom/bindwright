"""Tests for _core/project-template/.claude/hooks/live-check.py, the observe-only guard that notes
a pull request adding a write to an outside service without a `Live check:` line in its body.

The hook asks GitHub's API for the pull request through gh; these tests stand in for gh alone,
the network edge, with a fake that answers the two reads the hook makes and fails any other call.
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
PULL_PATH = "repos/owner/repo/pulls/12"
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


def file_of(path, lines):
    """One changed file as GitHub's list of pull request files gives it."""
    patch = "@@ -0,0 +1,%d @@\n" % len(lines) + "\n".join("+" + line for line in lines)
    return {"filename": path, "status": "added", "patch": patch}


def event(command="gh pr create --base develop --body-file body.md", stdout=ADDRESS + "\n", tool="Bash"):
    return {"tool_name": tool, "tool_input": {"command": command},
            "tool_response": {"stdout": stdout, "stderr": ""}, "cwd": "/repo"}


def plant_gh(folder):
    """A stand-in gh in `folder`, found by name on PATH."""
    os.makedirs(folder, exist_ok=True)
    planted = os.path.join(folder, "gh.bat" if os.name == "nt" else "gh")
    with open(planted, "w", encoding="utf-8") as script:
        script.write("exit 0\n")
    os.chmod(planted, 0o755)
    return planted


def fake_gh(body, files):
    """gh answering the pull request and its files for ADDRESS, one page per file the way
    --paginate prints pages, and failing every other call."""
    def gh(_folders, *args):
        if args == ("api", "--hostname", "github.com", PULL_PATH) and body is not None:
            return json.dumps({"number": 12, "body": body})
        if args == ("api", "--hostname", "github.com", "--paginate", PULL_PATH + "/files") and files is not None:
            return "".join(json.dumps([changed]) for changed in files) or "[]"
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

    def observe(self, the_event, body=BODY, files=None):
        self.hook.gh = fake_gh(body, [file_of("api.py", [POST_LINE])] if files is None else files)
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


class OtherHosts(HookTest):
    def test_an_address_on_another_host_sends_gh_nowhere(self):
        calls = []
        self.hook.gh = lambda *args: calls.append(args)
        for address in ("https://collector.example/a/b/pull/1", "https://github.com.collector.example/a/b/pull/1",
                        "https://ghe.example.com/a/b/pull/1"):
            with self.subTest(address):
                self.assertFalse(self.hook.observe(event(stdout=address + "\n")))
        self.assertEqual(calls, [])


class WhatThePullRequestHolds(HookTest):
    # name, body, changed files, a note expected
    ROWS = [
        ("a write and no Live check line notes", BODY, [file_of("api.py", [POST_LINE])], True),
        ("a body with the Live check line makes no note", BODY_WITH_CHECK, [file_of("api.py", [POST_LINE])], False),
        ("a dash-list Live check line makes no note", "- Live check: sent it\n", [file_of("api.py", [POST_LINE])],
         False),
        ("a Live check after a carriage return or form feed mid-line is no Live check line",
         "See \r\x0cLive check: later\n", [file_of("api.py", [POST_LINE])], True),
        ("files that add no write make no note", BODY, [file_of("api.py", [PLAIN_LINE])], False),
        ("a pull request gh cannot read makes no note", None, [file_of("api.py", [POST_LINE])], False),
        ("files gh cannot read make no note", BODY, None, False),
        ("a file GitHub sends no patch for, as for a binary or huge one, makes no note",
         BODY, [{"filename": "api.py", "status": "modified"}], False),
        ("a test_ file makes no note", BODY, [file_of("tools/test_sync.py", [POST_LINE])], False),
        ("a .test. file makes no note", BODY, [file_of("engine/test/sync.test.js", [POST_LINE])], False),
        ("a file under tests/ makes no note", BODY, [file_of("tests/fakes.py", [POST_LINE])], False),
        ("a _test. file makes no note", BODY, [file_of("sync_test.go", [POST_LINE])], False),
        ("the bind's record makes no note", BODY, [file_of(".bindwright/pristine.json", [POST_LINE])], False),
        ("a file whose name only holds the word test notes", BODY, [file_of("latest.py", [POST_LINE])], True),
        ("a write on a later page, after a test file, notes",
         BODY, [file_of("tests/fakes.py", [POST_LINE]), file_of("api.py", [POST_LINE])], True),
        ("content that reads like a diff header keeps its file",
         BODY, [file_of("api.py", ["x = '\r\x0cdiff --git a/t b/tests/t'", "++ b/tests/t", POST_LINE])], True),
        ("a line past 500 characters, as in a minified bundle, is skipped",
         BODY, [file_of("api.py", ["requests.post(" + "gh api x " * 60 + ")"])], False),
    ]

    def test_pull_request_rows(self):
        for name, body, files, expect_note in self.ROWS:
            with self.subTest(name):
                self.hook.gh = fake_gh(body, files)
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
                self.assertEqual(bool(self.hook.write_lines([file_of("api.py", [line])])), expect_write)


class LogEntry(HookTest):
    def test_entry_keeps_five_matches_cut_to_200_characters(self):
        lines = ['gh api -X POST repos/owner/repo/%s%d' % ("x" * 300, i) for i in range(7)]
        self.assertTrue(self.observe(event(), files=[file_of("api.py", lines)]))
        entries = self.observed()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["pull_request"], ADDRESS)
        self.assertEqual(len(entries[0]["matches"]), 5)
        self.assertTrue(all(len(match) <= 200 for match in entries[0]["matches"]))
        self.assertTrue(entries[0]["time"])


class FakeProcess:
    """A started gh: prints `out`, or outlasts every wait when `hangs`, so a second wait fails the test."""

    def __init__(self, out=b"", hangs=False):
        self.out, self.hangs, self.returncode, self.killed, self.waits = out, hangs, 0, False, 0

    def communicate(self, timeout=None):
        self.waits += 1
        if self.waits > 1:
            raise AssertionError("waited for gh's output again")
        if self.hangs:
            raise subprocess.TimeoutExpired("gh", timeout)
        return self.out, None

    def kill(self):
        self.killed = True


class GhOutput(unittest.TestCase):
    OWN = os.path.abspath(os.path.join(os.sep, "usr", "bin", "gh"))

    def run_gh(self, process):
        hook = load_hook()
        with mock.patch.object(hook.subprocess, "Popen", return_value=process), \
                mock.patch.object(hook.shutil, "which", return_value=self.OWN):
            return hook.gh([os.path.dirname(self.OWN)], "api", "x")

    def test_gh_output_keeps_every_line_ending(self):
        self.assertEqual(self.run_gh(FakeProcess(b'{"body": "a"}\r\nb\rc')), '{"body": "a"}\r\nb\rc')

    def test_a_gh_that_outlasts_its_time_is_killed_without_a_second_wait(self):
        process = FakeProcess(hangs=True)
        self.assertIsNone(self.run_gh(process))
        self.assertTrue(process.killed)

    def test_a_gh_inside_the_session_folder_never_runs(self):
        # A repo can ship its own gh first on PATH; the hook runs the user's install instead.
        hook = load_hook()
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as elsewhere:
            os.mkdir(os.path.join(repo, ".git"))
            shipped, own = plant_gh(os.path.join(repo, "bin")), plant_gh(elsewhere)
            with mock.patch.dict(os.environ, {"PATH": os.pathsep.join([os.path.dirname(shipped), elsewhere])}), \
                    mock.patch.object(hook.subprocess, "Popen", side_effect=lambda *a, **k: FakeProcess(b"{}")) \
                    as popen:
                hook.read_pull_request(hook.trusted_folders(repo), "owner/repo", "12")
            ran = {hook.real_path(call.args[0][0]) for call in popen.call_args_list}
            self.assertEqual(ran, {hook.real_path(own)}, shipped)


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
            hook.gh = fake_gh(BODY, [file_of("api.py", [POST_LINE])])
            self.assertEqual(hook.main(), 0)
        output = json.loads(printed.call_args[0][0])["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PostToolUse")
        self.assertIn("Live check:", output["additionalContext"])


if __name__ == "__main__":
    unittest.main()
