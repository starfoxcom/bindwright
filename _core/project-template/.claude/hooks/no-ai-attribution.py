#!/usr/bin/env python3
"""PreToolUse guard: nothing authored from a Claude session carries AI
attribution when it is written the ordinary way.

Rule (.claude/rules/git.md): commits, PR titles and bodies, issue bodies,
comments, reviews, releases and tags belong to the maintainer. The harness
can inject a note asking for attribution trailers; this hook is the
mechanical answer so the note can never win.

The contract is "no attribution", not "no mention". Denied: a Co-Authored-By
naming an AI, an Anthropic noreply address, "Generated with / written by
<AI>", a line ending "via Claude Code" or "by Claude", a Claude Code session
link or Claude-Session trailer, a session id, "AI-assisted / AI-generated"
and the robot emoji. Plain mentions pass: "fix the Claude Code hook config",
"compatible with Claude Code", "integration with LLM providers", CLAUDE.md,
the repo's own name, a human Co-Authored-By.

What is scanned, for any git write, gh write or GitHub API call:
  * The full command text: inline -m / --body / --title / --notes values,
    here-docs, here-strings and PowerShell -Body all live there.
  * Every file a git write, gh, curl, Invoke-RestMethod/WebRequest or
    Get-Content command names as a message or body (-F / --file /
    --template for git; --body-file / --notes-file / --input / -F and
    --field key=@file for gh; -d @file and -F key=@file for curl; -InFile;
    Get-Content's path). Bindwright's helper parses the command the way
    the shell does (tree-sitter, `hooks/shell-words.mjs`), so a text tool's
    own flags (`awk -F,`, `grep -F word`) and a flag inside quoted text, a
    here-doc or a here-string are another command's words, not a body
    file. `cd`, `Set-Location` and `git -C` set the folder a relative path
    resolves from. A file it cannot read, or one named by text built at
    run time, is denied, so a typo cannot slip a body through unread.
    Without the helper or Node it reads every file flag in the command
    text instead, a text tool's included.

It is a safety net for attribution written the ordinary way, not a sandbox
against a command built to slip past it. No text check can be one. These
pass unread: message text the shell builds at run time ($VAR, $(...),
backticks, eval), a body file the command itself writes, a body piped in
on stdin, a message reused from another commit
(-C / --reuse-message), flags that skip git's own hooks, and text a program
started by the command writes on its own. The repo's `attribution` settings
switch off the harness's own trailers; this hook catches the ones written
by hand.

The repo registers this file through run-hook.sh, which skips it when
~/.claude/hooks/no-ai-attribution.py exists and ~/.claude/settings.json
names it outside a permission rule.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent
exit 0 otherwise. Never blocks read-only commands.
"""
import json
import os
import re
import shutil
import subprocess
import sys

# Obfuscation-tolerant: optional zero-width / separator chars between letters.
_Z = r"[​‌‍⁠﻿\s\-_.*]*"


def _fuzzy(word):
    return _Z.join(re.escape(ch) for ch in word)


CLAUDE = _fuzzy("claude")
ANTHROPIC = _fuzzy("anthropic")
# Tool names that make a phrase attribution. `cursor` alone is an ordinary UI
# word ("pointer with cursor"), so only "Cursor AI / IDE / agent" counts.
AI = (r"(?:" + CLAUDE + "|" + ANTHROPIC + r"|ai|llm|assistant|copilot|codex|chat" + _Z + r"gpt|gpt|gemini|"
      r"cursor" + _Z + r"(?:ai|ide|agent))")
AN = r"(?:an?" + _Z + r")?"

# Bindwright's own Attribution workflow imports ATTRIBUTION and strip_paths from
# this file: keep both names, and keep importing it free of side effects (main()
# runs only as a script).
ATTRIBUTION = re.compile(
    "|".join([
        # Co-Authored-By naming an AI; a human co-author passes.
        r"co" + _Z + r"-?" + _Z + r"authored" + _Z + r"-?" + _Z + r"by\s*:?[^\n]*?\b" + AI + r"\b",
        r"noreply@" + ANTHROPIC,
        r"\b(?:generated|written|created|made|authored|produced|assisted|co-?written)" + _Z
        + r"(?:with|by|using|via)" + _Z + r":?" + _Z + AN + AI + r"\b",
        # Trailer forms with a colon: "Assisted-by: <AI>:<model>", "Made-with: Cursor".
        r"\b(?:generated|written|created|made|authored|produced|assisted|co-?written)" + _Z
        + r"(?:with|by|using|via)" + _Z + r":[ \t]*" + AN + r"(?:" + AI + r"|cursor)\b",
        # A line or quoted message that ends "via Claude Code" / "by Claude".
        # Not "with" / "using": "compatible with Claude Code" is a mention.
        r"\b(?:by|via)" + _Z + CLAUDE + r"(?:" + _Z + r"code)?(?=[\s.!)\]]*(?:$|['\"`]))",
        r"claude\.(?:ai|com)/(?:code|claude-code)\b",
        r"\b" + CLAUDE + r"[-_]session\s*:",
        r"session_[0-9a-z]{20,}",
        r"\U0001F916",                       # robot emoji
        r"\bai" + _Z + r"-?" + _Z + r"(?:assisted|generated|written|authored)",
    ]),
    re.I | re.M,
)

# A subcommand is a whole word: one inside a path or a name (`.claude/hooks/push-guard.py`,
# `commit-msg`) names no write.
_WORD_START = r"(?<![\w./\\:-])"
_WORD_END = r"(?![\w./-])"
GIT_WRITE = re.compile(
    r"\bgit\b[^|;&\n]*?" + _WORD_START
    + r"(commit-tree|commit|merge|push|tag|notes|am|cherry-pick|revert|rebase|replace)"
    + _WORD_END, re.I)
GH_WRITE = re.compile(
    r"\bgh\b[^|;&\n]*?" + _WORD_START + r"(pr|issue|release|gist|repo)" + _WORD_END + r"[^|;&\n]*?"
    + _WORD_START + r"(create|edit|comment|review|merge|close|reopen)" + _WORD_END, re.I)
GH_API = re.compile(r"\bgh\b[^|;&\n]*?" + _WORD_START + r"api" + _WORD_END, re.I)
HTTP_GH = re.compile(r"\b(?:curl|Invoke-(?:RestMethod|WebRequest))\b[^|;&\n]*api\.github\.com", re.I)

# Without the parser: flags whose next token is a file the hook must read. `-F`
# is case-sensitive: a lowercase `-f` is `git tag -f` (force) or `gh pr create
# -f` (fill). Long flags match whole (`--filename` is not `--file`). The value
# may follow a space or the long-option `=` (`--body-file=body.md`).
FILE_FLAGS = re.compile(
    r"(?:(?<=\s)-F"
    r"|(?P<long>(?i:--file|--body-file|--notes-file|--template|--input|--message-file|--field|-InFile))(?![\w-])"
    r"|(?i:Get-Content)(?:\s+(?i:-Raw|-Path|-LiteralPath)(?![\w-]))*"
    r"|(?<=\s)-d\s*@|(?i:--data(?:-binary|-raw)?)\s*@)"
    r"\s*=?\s*(?:\"(?P<dq>[^\"]+)\"|'(?P<sq>[^']+)'"
    r"|(?P<kv>[^\s=\"']+=@(?:\"[^\"]+\"|'[^']+'))|(?P<bare>\S+))"
)
PATH_TOKEN = re.compile(r"(?<!:/)(?<![\w])(?:[A-Za-z]:|~)?(?:[\\/][\w.\-]+)+")

# With the parser: the programs whose words can name a body file, by lowercase
# name without `.exe`, and the flags whose value is one.
GIT_WRITES = {"commit", "commit-tree", "merge", "tag", "notes"}
GIT_FILE_FLAGS = {"-F", "--file", "--template"}
GH_FILE_FLAGS = {"-F", "--body-file", "--notes-file", "--input", "--field"}
CURL_DATA_FLAGS = {"-d", "--data", "--data-binary", "--data-raw", "-F", "--form"}
WEB_CMDLETS = {"invoke-restmethod", "invoke-webrequest", "irm", "iwr"}
READ_CMDLETS = {"get-content", "gc"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--super-prefix", "--attr-source"}
READERS = {"git", "gh", "curl"} | WEB_CMDLETS | READ_CMDLETS
POP_COMMANDS = {"popd", "pop-location"}
CD_COMMANDS = {"cd", "chdir", "pushd", "set-location", "sl", "push-location"} | POP_COMMANDS
UNKNOWN = object()  # a folder the command switches to at run time
STRICT_HINT = (" Without Bindwright's helper (`/bindwright:update` installs it) or Node, the guard cannot"
               " read the command's structure, so it reads every file flag, a text tool's (awk -F,"
               " grep -F) included: run that tool as a command of its own.")


def deny(reason):
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "BLOCKED (no AI attribution): " + reason
                + " Commits, PRs, issues, comments and releases belong to the maintainer; no AI "
                  "Co-Authored-By, no generated-with line, no session link, no robot emoji.",
        }
    }))
    sys.exit(0)


def strip_paths(text):
    """Mask file-system paths so a scratch directory named after a session
    cannot trip the scan. URLs survive (the lookbehind skips the `//` after a
    scheme), so session links are still caught."""
    return PATH_TOKEN.sub("<path>", text)


def helper_dir():
    """Bindwright's helper, which carries the shell parser: setup installs it per computer."""
    return os.environ.get("BINDWRIGHT_HELPER") or os.path.join(
        os.path.expanduser("~"), ".bindwright", "helper", "node_modules", "bindwright")


def parse(cmd, shell):
    """Each simple command's words, as the shell reads them (helper/hooks/shell-words.mjs),
    each paired with whether it runs in a child shell; None when the parser is missing,
    fails or meets syntax it cannot read."""
    script = os.path.join(helper_dir(), "hooks", "shell-words.mjs")
    node = shutil.which("node")
    if not node or not os.path.isfile(script):
        return None
    try:
        # Bytes, not text: a text pipe on Windows would turn each LF into CR LF.
        out = subprocess.run([node, script, shell], input=cmd.encode("utf-8"),
                             capture_output=True, timeout=20)
        data = json.loads(out.stdout.decode("utf-8")) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("commands"), list):
        return None
    scoped = set(data.get("scoped") or ())
    return [(words, i in scoped) for i, words in enumerate(data["commands"])]


def text_of(word):
    """A word's literal value, or the source text of one the shell builds at run time."""
    return word if isinstance(word, str) else str(word.get("dynamic", ""))


def program(words):
    if not words or not isinstance(words[0], str):
        return ""
    name = os.path.basename(words[0].replace("\\", "/")).lower()
    return name[:-4] if name.endswith(".exe") else name


def unwrapped(words):
    """The words from the program a wrapper runs (`env A=1 git ...`, `sudo gh ...`,
    `xargs curl ...`) onward, or the words as they are."""
    for i in range(len(words)):
        if program(words[i:]) in READERS:
            return words[i:]
    return words


def flag_values(words, short=()):
    """(flag, value) for each word that can carry a value: `--flag value`, `--flag=value`,
    and a short flag in `short` written with its value attached (`-Fmsg`, `-d@body`). A
    value attached to its flag in a word built at run time (`--file=$F`) comes back as
    {"dynamic": <its text>}."""
    for i, word in enumerate(words):
        text = text_of(word)
        if not text.startswith("-"):
            continue
        built = isinstance(word, dict)
        if text.startswith("--") and "=" in text:
            flag, value = text.split("=", 1)
        elif text[:2] in short and len(text) > 2:
            flag, value = text[:2], text[2:]
        elif built:
            continue
        else:
            yield word, words[i + 1] if i + 1 < len(words) else None
            continue
        yield flag, {"dynamic": value} if built else value


def git_subcommand(words):
    """(index of git's subcommand, the folder `git -C` points at or None)."""
    folder, i = None, 1
    while i < len(words) and text_of(words[i]).startswith("-"):
        if isinstance(words[i], str) and words[i] in GIT_VALUE_OPTIONS and i + 1 < len(words):
            folder = words[i + 1] if words[i] == "-C" else folder
            i += 1
        i += 1
    return i, folder


def git_files(words):
    """Body files of a git write, and the folder `git -C` points at (or None). When the
    subcommand is built at run time (`git $OPTS commit`), every file flag after it is read."""
    i, folder = git_subcommand(words)
    if i >= len(words) or (isinstance(words[i], str) and words[i] not in GIT_WRITES):
        return folder, []
    return folder, [v for f, v in flag_values(words[i:], ("-F",)) if f in GIT_FILE_FLAGS and v is not None]


def gh_files(words):
    files = []
    for flag, value in flag_values(words, ("-F",)):
        if flag not in GH_FILE_FLAGS or value is None:
            continue
        text = text_of(value)
        if flag in ("-F", "--field") and "=" in text:
            if "=@" in text:  # gh api -F key=@file; key=value is a plain field
                files.append(value if isinstance(value, dict) else text.split("=@", 1)[1])
        elif flag != "--field" or isinstance(value, dict):
            files.append(value)
    return files


def curl_files(words):
    files = []
    for flag, value in flag_values(words, ("-d", "-F")):
        if flag not in CURL_DATA_FLAGS or value is None:
            continue
        text = text_of(value)
        at = text.split("=", 1)[1] if "=" in text and flag in ("-F", "--form") else text
        if at.lstrip("\"'").startswith(("@", "<")):
            files.append(value if isinstance(value, dict) else at[1:])
    return files


def cmdlet_files(name, words):
    if name in WEB_CMDLETS:
        return [v for f, v in flag_values(words) if isinstance(f, str) and f.lower() == "-infile" and v]
    files = [v for f, v in flag_values(words) if isinstance(f, str)
             and f.lower() in ("-path", "-literalpath") and v is not None]
    positional = [w for w in words[1:] if not (isinstance(w, str) and w.startswith("-"))]
    return files or positional[:1]


def resolve(value, folder):
    """The path to read, or an error saying why it cannot be told before the command runs."""
    if isinstance(value, dict):
        return None, f"a body file named by text the shell builds at run time ({value.get('dynamic')})"
    path = os.path.expanduser(value)
    if os.path.isabs(path):
        return path, None
    if folder is UNKNOWN:
        return None, f"a relative body file {value} after a change to a folder named at run time"
    return os.path.join(folder, path), None


def moved_folder(words, folder):
    """The folder after a `cd`-style command: UNKNOWN when the text cannot tell it (a
    target built at run time, `cd -`, no target, or a return to a saved folder)."""
    targets = [w for w in words[1:] if not text_of(w).startswith("-")]
    if program(words) in POP_COMMANDS or not targets or folder is UNKNOWN:
        return UNKNOWN
    if not isinstance(targets[-1], str):
        return UNKNOWN
    return os.path.join(folder, os.path.expanduser(targets[-1]))


def command_files(words):
    """(the folder `git -C` points at or None, body files) for one command."""
    name = program(words)
    if name == "git":
        return git_files(words)
    if name == "gh":
        return None, gh_files(words)
    if name == "curl":
        return None, curl_files(words)
    if name in WEB_CMDLETS or name in READ_CMDLETS:
        return None, cmdlet_files(name, words)
    return None, []


def parsed_files(commands, cwd):
    """(path, error) for every body file the parsed commands name, in order."""
    folder = cwd
    for words, in_child_shell in commands:
        if program(words) in CD_COMMANDS:
            # A child shell's `cd` leaves the outer folder as it was, but its own later
            # commands run in the new one, so neither can be told from here.
            folder = UNKNOWN if in_child_shell else moved_folder(words, folder)
            continue
        git_folder, files = command_files(unwrapped(words))
        here = folder if git_folder is None else moved_folder(["cd", git_folder], folder)
        for value in files:
            if value != "-":
                yield resolve(value, here)


def strict_files(cmd, cwd):
    """Without the parser: every file flag in the command text, a text tool's included."""
    for m in FILE_FLAGS.finditer(cmd):
        path = m.group("dq") or m.group("sq") or m.group("kv") or m.group("bare")
        if not path or path == "-":
            continue
        if "=" in path:            # gh -F key=value / key=@file
            if "=@" not in path:
                continue
            path = path.split("=@", 1)[1]
            if path == "-":        # key=@- reads stdin
                continue
        path = os.path.expanduser(path.strip("\"'"))
        yield (path if os.path.isabs(path) else os.path.join(cwd, path)), None


def scan_text(text, where):
    hit = ATTRIBUTION.search(strip_paths(text))
    if hit:
        deny(f"attribution marker '{hit.group(0).strip()}' found in {where}.")


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except Exception:
        sys.exit(0)
    tool_input = data.get("tool_input") if isinstance(data, dict) else None
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str):
        sys.exit(0)  # not a shell call this guard can read: let it through
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()
    if not cmd or not (GIT_WRITE.search(cmd) or GH_WRITE.search(cmd) or GH_API.search(cmd)
                       or HTTP_GH.search(cmd)):
        sys.exit(0)

    scan_text(cmd, "the command text")
    commands = parse(cmd, "powershell" if data.get("tool_name") == "PowerShell" else "bash")
    hint = "" if commands is not None else STRICT_HINT
    for path, error in (parsed_files(commands, cwd) if commands is not None else strict_files(cmd, cwd)):
        if error:
            deny(f"could not tell which file holds {error}. Use a literal absolute path.")
        try:
            text = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception as e:
            deny(f"could not read message/body file {path}: {e}. Use a literal absolute path.{hint}")
        scan_text(text, f"file {path}")
    sys.exit(0)


if __name__ == "__main__":
    main()
