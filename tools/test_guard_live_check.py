"""Tests for _core/project-template/.claude/hooks/live-check.py, the observe-only guard that notes
a pull request adding a write to an outside service without a `Live check:` line in its body.

Each case builds a throwaway git repo (a base commit on main, a feature commit on top) and runs
the hook on a `gh pr` command the way a session does, with BINDWRIGHT_HOME pointed at a temp
folder so the real log is never touched.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "_core", "project-template", ".claude", "hooks", "live-check.py")
GIT_QUIET = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
             "-c", "commit.gpgsign=false", "-c", "core.hooksPath="]
NOTE = "Live check: this PR adds a write to an outside service"
PLAIN_LINE = "def add(a, b):"
POST_LINE = "requests.post(url, json=payload)"
BODY = "## What\nAdds the sync.\n"
BODY_WITH_CHECK = "## What\nAdds the sync.\n\n- Live check: sent one POST to the test account, got 201.\n"


def git(folder, *args):
    subprocess.run(["git", *GIT_QUIET, *args], cwd=folder, check=True, capture_output=True)


def write(folder, name, text):
    with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
        handle.write(text)


def make_repo(folder, added_lines, body=None, path="api.py"):
    """A repo whose feature branch adds `added_lines` to `path`, with the body in body.md."""
    git(folder, "init", "-q", "-b", "main")
    write(folder, "README.md", "base\n")
    git(folder, "add", "README.md")
    git(folder, "commit", "-q", "-m", "chore: base")
    git(folder, "checkout", "-q", "-b", "feature")
    os.makedirs(os.path.dirname(os.path.join(folder, path)), exist_ok=True)
    write(folder, path, "".join(line + "\n" for line in added_lines))
    git(folder, "add", path)
    git(folder, "commit", "-q", "-m", "feat: add the sync")
    if body is not None:
        write(folder, "body.md", body)


def run_hook(folder, home, command, tool="Bash"):
    """(exit code, stderr) of the hook for one command run in `folder`."""
    event = {"tool_name": tool, "tool_input": {"command": command}, "cwd": folder}
    env = dict(os.environ, BINDWRIGHT_HOME=home)
    done = subprocess.run([sys.executable, "-I", HOOK], input=json.dumps(event).encode("utf-8"),
                          capture_output=True, env=env, timeout=60)
    return done.returncode, done.stderr.decode("utf-8", "replace")


def observed(home):
    """The entries the hook logged under `home`."""
    path = os.path.join(home, "live-check", "observed.jsonl")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class PullRequestNotes(unittest.TestCase):
    # name, command, body text (None: no body file), added lines, a note expected
    CREATE = "gh pr create --base main --body-file body.md"
    EDIT = "gh pr edit --base main --body-file body.md"
    ROWS = [
        ("create with a write and no Live check line notes", CREATE, BODY, [POST_LINE], True),
        ("create whose body has the Live check line makes no note", CREATE, BODY_WITH_CHECK,
         [POST_LINE], False),
        ("create that adds no write makes no note", CREATE, BODY, [PLAIN_LINE], False),
        ("edit with a write and no Live check line notes", EDIT, BODY, [POST_LINE], True),
        ("edit whose body has the Live check line makes no note", EDIT, BODY_WITH_CHECK,
         [POST_LINE], False),
        ("the -F and -B short forms with a write notes", "gh pr create -B main -F body.md",
         BODY, [POST_LINE], True),
        ("the --body-file=value form with a dash-list Live check line makes no note",
         "gh pr create --base main --body-file=body.md", "- Live check: sent it\n", [POST_LINE], False),
        ("a command it cannot read plainly makes no note", 'gh pr create --base main --body-file "$BODY"',
         BODY, [POST_LINE], False),
        ("a chained command it cannot read plainly makes no note", CREATE + " && echo done",
         BODY, [POST_LINE], False),
        ("an unreadable body file makes no note", "gh pr create --base main --body-file missing.md",
         None, [POST_LINE], False),
        ("a command that is not gh pr makes no note", "gh issue create --title x --body-file body.md",
         BODY, [POST_LINE], False),
    ]

    def test_pull_request_rows(self):
        for name, command, body, added, expect_note in self.ROWS:
            with self.subTest(name), tempfile.TemporaryDirectory() as folder, \
                    tempfile.TemporaryDirectory() as home:
                make_repo(folder, added, body)
                code, stderr = run_hook(folder, home, command)
                self.assertEqual(code, 0)
                self.assertEqual(NOTE in stderr, expect_note)
                self.assertEqual(len(observed(home)), 1 if expect_note else 0)


class WriteLines(unittest.TestCase):
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
            with self.subTest(name), tempfile.TemporaryDirectory() as folder, \
                    tempfile.TemporaryDirectory() as home:
                make_repo(folder, [line], BODY)
                run_hook(folder, home, "gh pr create --base main --body-file body.md")
                self.assertEqual(len(observed(home)), 1 if expect_write else 0)


class FilesThatSendNothing(unittest.TestCase):
    # name, path the write is added in, a note expected
    ROWS = [
        ("the bind's record under .bindwright/ makes no note", ".bindwright/pristine.json", False),
        ("a test_ file makes no note", "tools/test_sync.py", False),
        ("a .test. file makes no note", "engine/test/sync.test.js", False),
        ("a file under tests/ makes no note", "tests/fakes.py", False),
        ("a _test. file makes no note", "sync_test.go", False),
        ("a file whose name only holds the word test notes", "latest.py", True),
    ]

    def test_test_file_rows(self):
        for name, path, expect_note in self.ROWS:
            with self.subTest(name), tempfile.TemporaryDirectory() as folder, \
                    tempfile.TemporaryDirectory() as home:
                make_repo(folder, [POST_LINE], BODY, path)
                run_hook(folder, home, "gh pr create --base main --body-file body.md")
                self.assertEqual(len(observed(home)), 1 if expect_note else 0)


class LogEntry(unittest.TestCase):
    def test_entry_keeps_five_matches_cut_to_200_characters(self):
        lines = [f'gh api -X POST repos/owner/repo/{"x" * 300}{i}' for i in range(7)]
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as home:
            make_repo(folder, lines, BODY)
            code, stderr = run_hook(folder, home, "gh pr create --base main --body-file body.md")
            entries = observed(home)
        self.assertEqual(code, 0)
        self.assertIn(NOTE, stderr)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["command"], "gh pr create")
        self.assertEqual(len(entries[0]["matches"]), 5)
        self.assertTrue(all(len(match) <= 200 for match in entries[0]["matches"]))
        self.assertTrue(entries[0]["time"] and entries[0]["repo"])


if __name__ == "__main__":
    unittest.main()
