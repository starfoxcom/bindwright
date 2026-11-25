r"""PreToolUse hook, observe mode: notes a pull request that adds a write to an outside
service without a `Live check:` line in its body.

testing.md asks for one real send of each new kind of write before the work is done, and the
pull request's body records it. This hook reads a plain `gh pr create` that passes a body file,
takes the lines the branch adds from `git diff` (outside test files and the bind's record under
.bindwright/), and when one of them makes a write (an API call with a write method, or an HTTP
client's post, put, patch or delete) and the body has no `Live check:` line, it appends the match
to `<BINDWRIGHT_HOME>/live-check/observed.jsonl` and hands the session one line of context.

It never blocks: every outcome exits 0, so the log shows how often the note fires before any
version refuses. A command is read only when it is plain: outside its quotes it holds letters,
digits and the characters in PLAIN_CHARACTERS. Anything else (chains, pipes, expansions, a
multi-line command) goes unread and makes no note, and so does a create for another branch or
repo (--head, --repo) or one whose base branch git cannot find.
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
# Past this a line is generated (a minified bundle, a source map), not code someone wrote, and
# the patterns' cost on it could outrun the hook's timeout.
MAX_LINE_CHARS = 500
BODY_FILE_OPTIONS = ("--body-file", "-F")
BASE_OPTIONS = ("--base", "-B")
OTHER_TARGET_OPTIONS = ("--head", "-H", "--repo", "-R")
QUOTES = ('"', "'")
# Outside quotes a word may hold letters, digits and these; `\` is a path separator for PowerShell
# only, and `@` (splatting) and `,` (arrays) are plain in bash only.
PLAIN_CHARACTERS = {
    "bash": set("-_./:=@+,"),
    "powershell": set("-_./:=+\\"),
}
SHELLS = {"Bash": "bash", "PowerShell": "powershell"}
WRITE_METHOD = r"(?:POST|PUT|PATCH|DELETE)"
WRITE_PATTERNS = [re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\bgh\s+api\b.*(?:-X|--method)[\s=,\"']+" + WRITE_METHOD + r"\b",
    r"\b_gh\(.*[\"']" + WRITE_METHOD + r"[\"']",
    r"\b(?:requests|httpx|axios)\.(?:post|put|patch|delete)\(",
    r"\bfetch\((?=.*\bmethod\s*:\s*[\"']?" + WRITE_METHOD + r"\b)",
)]
# Files that never send anything to a real service: the bind's record, which stores whole files
# as strings, and test files. Git leaves them out of the diff, so no diff line is parsed for paths.
SENDS_NOTHING = [":(top,exclude).bindwright"] + [":(top,exclude,glob,icase)" + pattern for pattern in (
    "**/test_*", "**/*_test.*", "**/*.test.*", "**/*.spec.*",
    "**/test/**", "**/tests/**", "**/__tests__/**", "**/spec/**",
)]
LIVE_CHECK_LINE = re.compile(r"(?:[-*] )?live check:", re.IGNORECASE)


def read_words(command, shell):
    """The command's words as the shell reads them, or None when the command is not plain.

    A quote wraps a whole word and holds printable ASCII only: the shells split a word glued to
    a quote differently, and PowerShell also ends a string at typographic quotes."""
    plain = PLAIN_CHARACTERS[shell]
    words, word, quote, started, closed = [], [], None, False, False
    for char in command:
        if quote:
            if char == quote:
                quote, closed = None, True
            elif not (char.isascii() and char.isprintable()) or (quote == '"' and char in "$`\\"):
                return None
            else:
                word.append(char)
            continue
        if char == " ":
            if started:
                words.append("".join(word))
            word, started, closed = [], False, False
        elif closed or (char in QUOTES and started):
            return None
        elif char in QUOTES:
            quote, started = char, True
        elif (char.isascii() and char.isalnum()) or char in plain:
            word.append(char)
            started = True
        else:
            return None
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
            value = words[index + 1] if index + 1 < len(words) else ""
    return value


def pr_request(command, shell):
    """(the body file, the base option) for a plain `gh pr create` of the checked-out branch that
    passes a body file; None for any other command."""
    words = read_words(command, shell) or []
    if words[:3] != ["gh", "pr", "create"] or option_value(words, OTHER_TARGET_OPTIONS) is not None:
        return None
    # gh also takes a short option with its value attached (-Hother) or several at once (-dH):
    # only a lone one is read.
    if any(word.startswith("-") and not word.startswith("--") and len(word) != 2 for word in words):
        return None
    body_file = option_value(words, BODY_FILE_OPTIONS)
    if not body_file:
        return None
    return body_file, option_value(words, BASE_OPTIONS)


def write_lines(diff):
    """The added lines of a diff that make a write to an outside service, without their `+`."""
    added = [line[1:].strip() for line in diff.splitlines()
             if line.startswith("+") and not line.startswith("+++ ") and len(line) <= MAX_LINE_CHARS]
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
    """The ref the PR's diff starts from, or None when git cannot find it: `origin/<base>` (or a
    local `<base>`) for --base, else the remote's default branch, which gh targets without one."""
    if base is None:
        candidates = [git(cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")]
    else:
        candidates = ["origin/" + base, base]
    for ref in candidates:
        if ref and git(cwd, "rev-parse", "--verify", "--quiet", ref + "^{commit}"):
            return ref
    return None


def record(repo, matches):
    """Appends one JSON line describing the note to the log."""
    home = os.environ.get(HOME_VARIABLE) or os.path.join(os.path.expanduser("~"), ".bindwright")
    folder = os.path.join(home, LOG_PARTS[0])
    os.makedirs(folder, exist_ok=True)
    entry = {
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "repo": repo,
        "command": "gh pr create",
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
    body_file, base = request
    body = read_body(os.path.join(cwd, body_file))
    repo = git(cwd, "rev-parse", "--show-toplevel")
    start = base_ref(cwd, base) if body is not None and repo else None
    if start is None:
        return False
    diff = git(cwd, "diff", "--no-color", "--no-ext-diff", "--no-textconv", start + "...HEAD",
               "--", ":/", *SENDS_NOTHING)
    if diff is None:
        return False
    matches = write_lines(diff)
    if not matches or has_live_check(body):
        return False
    record(repo, matches)
    return True


def main():
    # Windows searches the working folder for a program before PATH; a repo's own git must not run.
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    try:
        noted = observe(json.loads(sys.stdin.buffer.read().decode("utf-8", "replace")))
    except Exception:  # observe mode: no failure of this hook may block the tool call
        return 0
    if noted:
        # Claude Code shows the session a PreToolUse hook's additionalContext; stderr on exit 0 it drops.
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": NOTE}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
