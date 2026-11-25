r"""PostToolUse hook, observe mode: notes a pull request that adds a write to an outside
service without a `Live check:` line in its body.

testing.md asks for one real send of each new kind of write before the work is done, and the
pull request's body records it. After a `gh pr create` or `gh pr edit` prints the pull request's
address, this hook asks GitHub for that pull request's body and diff, so the branch, base and repo
are the ones GitHub holds, never a guess from the command's text. When a line the diff adds
outside test files and the bind's record under .bindwright/ makes a write (an API call with a
write method, or an HTTP client's post, put, patch or delete) and the body has no `Live check:`
line, it appends the match to `<BINDWRIGHT_HOME>/live-check/observed.jsonl` and hands the session
one line of context.

It never blocks: every outcome exits 0, so the log shows how often the note fires before any
version refuses. Output with no address, or with more than one, makes no note, and so does a gh
that fails or runs out of time.
"""

import datetime
import json
import os
import re
import subprocess
import sys

NOTE = ("Live check: this PR adds a write to an outside service and its body has no `Live check:` "
        "line (testing.md § Test the real code)")
HOME_VARIABLE = "BINDWRIGHT_HOME"
LOG_PARTS = ("live-check", "observed.jsonl")
# Two gh calls at most, inside the 30 s the settings entry gives the hook.
GH_SECONDS = 10
MAX_MATCHES = 5
MAX_MATCH_CHARS = 200
# Past this a line is generated (a minified bundle, a source map), not code someone wrote, and
# the patterns' cost on it could outrun the hook's timeout.
MAX_LINE_CHARS = 500
SHELLS = {"Bash", "PowerShell"}
PR_COMMAND = re.compile(r"\bgh\s+pr\s+(?:create|edit)\b")
# gh prints the pull request's address on a line of its own.
PR_ADDRESS = re.compile(r"https://[A-Za-z0-9.-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/\d+")
FILE_HEADER = re.compile(r'diff --git (?:"a/.*" "b/(.*)"|a/.* b/(.*))')
WRITE_METHOD = r"(?:POST|PUT|PATCH|DELETE)"
WRITE_PATTERNS = [re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\bgh\s+api\b.*(?:-X|--method)[\s=,\"']+" + WRITE_METHOD + r"\b",
    r"\b_gh\(.*[\"']" + WRITE_METHOD + r"[\"']",
    r"\b(?:requests|httpx|axios)\.(?:post|put|patch|delete)\(",
    r"\bfetch\((?=.*\bmethod\s*:\s*[\"']?" + WRITE_METHOD + r"\b)",
)]
RECORD_FOLDER = ".bindwright"
TEST_FOLDERS = {"test", "tests", "__tests__", "spec"}
TEST_NAME_MARKERS = ("_test.", ".test.", ".spec.")
LIVE_CHECK_LINE = re.compile(r"(?:[-*] )?live check:", re.IGNORECASE)


def sends_nothing(path):
    """Whether a repo path holds text that never reaches a real service: a test file, or the
    bind's record under .bindwright/, which stores whole files as strings."""
    parts = path.lower().split("/")
    name = parts[-1]
    return (parts[0] == RECORD_FOLDER or any(part in TEST_FOLDERS for part in parts[:-1])
            or name.startswith("test_") or any(marker in name for marker in TEST_NAME_MARKERS))


def write_lines(diff):
    """The lines a diff adds that make a write to an outside service, without their `+`.

    A section starts at its `diff --git` line and its added lines come after its first `@@`, so
    content that reads like a header is never taken for one."""
    added, skipped, in_hunk = [], True, False
    for line in diff.splitlines():
        header = FILE_HEADER.fullmatch(line)
        if header:
            skipped, in_hunk = sends_nothing(header.group(1) or header.group(2)), False
        elif line.startswith("diff --git "):
            skipped, in_hunk = True, False
        elif line.startswith("@@"):
            in_hunk = True
        elif in_hunk and not skipped and line.startswith("+") and len(line) <= MAX_LINE_CHARS:
            added.append(line[1:].strip())
    return [line for line in added if any(pattern.search(line) for pattern in WRITE_PATTERNS)]


def has_live_check(body):
    """Whether a line of the body starts with `Live check:`, optionally as a list item."""
    return any(LIVE_CHECK_LINE.match(line) for line in body.splitlines())


def gh(*args):
    """What gh prints, or None when it fails or runs out of time."""
    try:
        done = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=GH_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def pr_address(event):
    """The address a `gh pr create` or `gh pr edit` printed, or None for any other call."""
    if not isinstance(event, dict) or event.get("tool_name") not in SHELLS:
        return None
    tool_input = event.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not PR_COMMAND.search(command):
        return None
    response = event.get("tool_response")
    if isinstance(response, dict):
        response = response.get("stdout") if isinstance(response.get("stdout"), str) else response.get("output")
    if not isinstance(response, str):
        return None
    addresses = [line.strip() for line in response.splitlines() if PR_ADDRESS.fullmatch(line.strip())]
    return addresses[0] if len(addresses) == 1 else None


def record(address, matches):
    """Appends one JSON line describing the note to the log."""
    home = os.environ.get(HOME_VARIABLE) or os.path.join(os.path.expanduser("~"), ".bindwright")
    folder = os.path.join(home, LOG_PARTS[0])
    os.makedirs(folder, exist_ok=True)
    entry = {
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "pull_request": address,
        "matches": [line[:MAX_MATCH_CHARS] for line in matches[:MAX_MATCHES]],
    }
    with open(os.path.join(folder, LOG_PARTS[1]), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def observe(event):
    """Records the pull request when it adds an unchecked write; returns whether it did."""
    address = pr_address(event)
    body = gh("pr", "view", address, "--json", "body", "--jq", ".body") if address else None
    if body is None or has_live_check(body):
        return False
    diff = gh("pr", "diff", address, "--color", "never")
    matches = write_lines(diff) if diff is not None else []
    if not matches:
        return False
    record(address, matches)
    return True


def main():
    # Windows searches the working folder for a program before PATH; a repo's own gh must not run.
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    try:
        noted = observe(json.loads(sys.stdin.buffer.read().decode("utf-8", "replace")))
    except Exception:  # observe mode: no failure of this hook may block the tool call
        return 0
    if noted:
        # Claude Code shows the session a hook's additionalContext; stderr on exit 0 it drops.
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": NOTE}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
