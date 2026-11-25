r"""PreToolUse hook, observe mode: notes a pull request that adds a write to an outside
service without a `Live check:` line in its body.

testing.md asks for one real send of each new kind of write before the work is done, and the
pull request's body records it. This hook reads a plain `gh pr create` or `gh pr edit` that
passes a body file, takes the lines the branch adds from `git diff` (outside test files and the
bind's record under .bindwright/), and when one of them makes a write (an API call with a write
method, or an HTTP client's post, put, patch or delete) and the body has no `Live check:` line,
it appends the match to
`<BINDWRIGHT_HOME>/live-check/observed.jsonl` and prints one line to stderr.

It never blocks: every outcome exits 0, so the log shows how often the note fires before any
version refuses. A command is read only when it is plain: outside its quotes it holds letters,
digits and the characters in PLAIN_CHARACTERS. Anything else (chains, pipes, expansions, a
multi-line command) goes unread and makes no note.
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
GIT_SECONDS = 6
MAX_MATCHES = 5
MAX_MATCH_CHARS = 200
BODY_FILE_OPTIONS = ("--body-file", "-F")
BASE_OPTIONS = ("--base", "-B")
QUOTES = ('"', "'")
# Outside quotes a word may hold letters, digits and these; `\` is a path separator for PowerShell only.
PLAIN_CHARACTERS = {
    "bash": set("-_./:=@+,"),
    "powershell": set("-_./:=@+,\\"),
}
SHELLS = {"Bash": "bash", "PowerShell": "powershell"}
WRITE_METHOD = r"(?:POST|PUT|PATCH|DELETE)"
WRITE_PATTERNS = [re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\bgh\b.*\bapi\b.*(?:-X|--method)[\s=,\"']+" + WRITE_METHOD + r"\b",
    r"\b_gh\(.*[\"']" + WRITE_METHOD + r"[\"']",
    r"\b(?:requests|httpx|axios)\.(?:post|put|patch|delete)\(",
    r"\bfetch\((?=.*\bmethod\s*:\s*[\"']?" + WRITE_METHOD + r"\b)",
)]
RECORD_FOLDER = ".bindwright"
TEST_FOLDERS = {"test", "tests", "__tests__", "spec"}
TEST_NAME_MARKERS = ("_test.", ".test.", ".spec.")
LIVE_CHECK_LINE = re.compile(r"(?:[-*] )?live check:", re.IGNORECASE)


def read_words(command, shell):
    """The command's words as the shell reads them, or None when the command is not plain."""
    plain = PLAIN_CHARACTERS[shell]
    words, word, quote, started, previous = [], [], None, False, ""
    for char in command:
        if quote:
            if char == quote:
                quote = None
            elif quote == '"' and char in "$`\\":
                return None
            else:
                word.append(char)
            previous = char
            continue
        if char in QUOTES:
            # Adjacent quotes mean different things in bash and PowerShell, so they go unread.
            if previous in QUOTES:
                return None
            quote, started = char, True
        elif char == " ":
            if started:
                words.append("".join(word))
            word, started = [], False
        elif (char.isascii() and char.isalnum()) or char in plain:
            word.append(char)
            started = True
        else:
            return None
        previous = char
    if quote:
        return None
    if started:
        words.append("".join(word))
    return words


def option_value(words, names):
    """The value the last of `names` takes: `--name value`, `--name=value` or `-N value`."""
    value = None
    for index, word in enumerate(words):
        name, has_equals, rest = word.partition("=")
        if name not in names:
            continue
        if has_equals:
            value = rest
        else:
            value = words[index + 1] if index + 1 < len(words) else None
    return value


def pr_request(command, shell):
    """(the command's kind, the body file, the base option) for a plain `gh pr create` or
    `gh pr edit` that passes a body file; None for any other command."""
    words = read_words(command, shell) or []
    if words[:2] != ["gh", "pr"] or words[2:3] not in (["create"], ["edit"]):
        return None
    body_file = option_value(words, BODY_FILE_OPTIONS)
    if body_file is None:
        return None
    return "gh pr " + words[2], body_file, option_value(words, BASE_OPTIONS)


def sends_nothing(path):
    """Whether a repo path holds text that never reaches a real service: a test file, or the
    bind's record under .bindwright/, which stores whole files as strings."""
    parts = path.lower().split("/")
    name = parts[-1]
    return (parts[0] == RECORD_FOLDER or any(part in TEST_FOLDERS for part in parts[:-1])
            or name.startswith("test_") or any(marker in name for marker in TEST_NAME_MARKERS))


def write_lines(diff):
    """The added lines of a diff that make a write to an outside service, without their `+`,
    leaving out files that send nothing."""
    added, skipped = [], False
    for line in diff.splitlines():
        if line.startswith("+++"):
            path = line[4:].strip()
            skipped = sends_nothing(path[2:] if path.startswith("b/") else path)
        elif line.startswith("+") and not skipped:
            added.append(line[1:].strip())
    return [line for line in added if any(pattern.search(line) for pattern in WRITE_PATTERNS)]


def has_live_check(body):
    """Whether a line of the body starts with `Live check:`, optionally as a list item."""
    return any(LIVE_CHECK_LINE.match(line) for line in body.splitlines())


def read_body(path):
    """The body file's text, or None when it cannot be read."""
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def git(cwd, *args):
    """What git prints, stripped, or None when git fails or runs out of time."""
    try:
        done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=GIT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def base_ref(cwd, base):
    """The ref a PR's diff starts from: `origin/<base>` (or `<base>`) for --base, else the
    remote's default branch, falling back to origin/main."""
    if base is None:
        return git(cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD") or "origin/main"
    remote = "origin/" + base
    if git(cwd, "rev-parse", "--verify", "--quiet", remote + "^{commit}"):
        return remote
    return base


def record(repo, kind, matches):
    """Appends one JSON line describing the note to the log."""
    home = os.environ.get(HOME_VARIABLE) or os.path.join(os.path.expanduser("~"), ".bindwright")
    folder = os.path.join(home, LOG_PARTS[0])
    os.makedirs(folder, exist_ok=True)
    entry = {
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "repo": repo,
        "command": kind,
        "matches": [line[:MAX_MATCH_CHARS] for line in matches[:MAX_MATCHES]],
    }
    with open(os.path.join(folder, LOG_PARTS[1]), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def observe(event):
    """Records the command when it adds an unchecked write; returns whether it did."""
    if not isinstance(event, dict) or event.get("tool_name") not in SHELLS:
        return False
    tool_input = event.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    cwd = event.get("cwd")
    if not isinstance(command, str) or not isinstance(cwd, str) or not cwd:
        return False
    request = pr_request(command, SHELLS[event["tool_name"]])
    if request is None:
        return False
    kind, body_file, base = request
    body = read_body(os.path.join(cwd, body_file))
    repo = git(cwd, "rev-parse", "--show-toplevel")
    if body is None or not repo:
        return False
    diff = git(cwd, "diff", "--no-color", "--no-ext-diff", "--no-textconv",
               base_ref(cwd, base) + "...HEAD")
    if diff is None:
        return False
    matches = write_lines(diff)
    if not matches or has_live_check(body):
        return False
    record(repo, kind, matches)
    return True


def main():
    # Windows searches the working folder for a program before PATH; a repo's own git must not run.
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    try:
        noted = observe(json.loads(sys.stdin.buffer.read().decode("utf-8", "replace")))
    except Exception:  # observe mode: no failure of this hook may block the tool call
        return 0
    if noted:
        print(NOTE, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
