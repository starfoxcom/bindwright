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
  * Every file a command names with a body flag (-F / --file / --template
    for a git write; --body-file / --notes-file / --input / -F and
    --field key=@file; -d @file and -F key=@file; -InFile; Get-Content's
    path). Bindwright's helper parses the command the way the shell does
    (tree-sitter, `hooks/shell-words.mjs`), so each flag belongs to one
    command. Every command's flags are read, a wrapper's (`env`, `sudo`,
    `xargs`) and one whose program is built at run time included, except
    a text tool's (`awk -F,`, `grep -F word`), git's outside a write, and
    gh's `--template`. A flag inside quoted text, a here-doc, a here-string
    or the value of -m / --body / --title is text, not a body file. `cd`,
    `Set-Location` and `git -C` set the folder a relative path resolves
    from. A file it cannot read, or one named by text built at run time,
    is denied, so a typo cannot slip a body through unread. Without the
    helper or Node it reads every file flag in the command text instead,
    a text tool's included.

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

# With the parser: every command's file flags are read, except a text tool's, git's
# outside a write and gh's `--template` (a template name). A program built at run time,
# a wrapper (`env`, `sudo`, `xargs`) or any other program has its flags read.
GIT_WRITES = {"commit", "commit-tree", "merge", "tag", "notes"}
GIT_FILE_FLAGS = {"-F", "--file", "--template"}
FORM_FLAGS = {"-F", "--field", "--form"}  # key=value is a field; key=@file reads a file
DATA_FLAGS = {"-d", "--data", "--data-binary", "--data-raw"}  # only @file reads a file
BODY_FLAGS = {"--file", "--body-file", "--notes-file", "--input", "--message-file", "--template",
              "-infile"} | FORM_FLAGS | DATA_FLAGS
# The word after one of these is message text, even when it starts with a dash.
MESSAGE_FLAGS = {"-m", "--message", "-b", "--body", "-t", "--title", "--notes", "--subject"}
TEXT_TOOLS = {"awk", "gawk", "mawk", "grep", "egrep", "fgrep", "rg", "sed", "sort", "cut", "tr", "uniq",
              "head", "tail", "wc", "jq", "column", "paste", "join", "select-string", "sls", "findstr"}
READ_CMDLETS = {"get-content", "gc"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--super-prefix", "--attr-source"}
POP_COMMANDS = {"popd", "pop-location"}
CD_COMMANDS = {"cd", "chdir", "pushd", "set-location", "sl", "push-location"} | POP_COMMANDS
UNKNOWN = object()  # a folder the command switches to at run time
PARSE_SECONDS = 6  # the hook itself is stopped at 10 s
STRICT_READ = (" so it read every file flag, a text tool's (awk -F, grep -F) included: run that tool"
               " as a command of its own.")
NO_PARSER_HINT = (" Without Bindwright's helper (`/bindwright:update` installs it) or Node, the guard"
                  " cannot read the command's structure," + STRICT_READ)
UNREAD_HINT = " The guard could not read this command's structure," + STRICT_READ
MOVES_FOLDER = re.compile(r"(?<![\w-])(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)"
                          r"(?![\w-])|\bgit\b[^|;&\n]*?\s-C(?![\w-])", re.I)


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
    each paired with whether it runs in a child shell, and "". When the parser is missing,
    fails or meets syntax it cannot read: None, and the hint that says which."""
    script = os.path.join(helper_dir(), "hooks", "shell-words.mjs")
    node = shutil.which("node")
    if not node or not os.path.isfile(script):
        return None, NO_PARSER_HINT
    try:
        # Bytes, not text: a text pipe on Windows would turn each LF into CR LF.
        out = subprocess.run([node, script, shell], input=cmd.encode("utf-8"),
                             capture_output=True, timeout=PARSE_SECONDS)
        data = json.loads(out.stdout.decode("utf-8")) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None, UNREAD_HINT
    if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("commands"), list):
        return None, UNREAD_HINT
    scoped = set(data.get("scoped") or ())
    return [(words, i in scoped) for i, words in enumerate(data["commands"])], ""


def text_of(word):
    """A word's literal value, or the source text of one the shell builds at run time."""
    return word if isinstance(word, str) else str(word.get("dynamic", ""))


def program(words):
    if not words or not isinstance(words[0], str):
        return ""
    name = os.path.basename(words[0].replace("\\", "/")).lower()
    return name[:-4] if name.endswith(".exe") else name


def flag_values(words, short=()):
    """(flag, value) for each word that can carry a value: `--flag value`, `--flag=value`,
    and a short flag in `short` written with its value attached (`-Fmsg`, `-d@body`). A
    value attached to its flag in a word built at run time (`--file=$F`) comes back as
    {"dynamic": <its text>}. A word with a space after a message flag is that message's text,
    never a flag; a bare flag there is still one, since `-m` is also a switch (`gh pr merge -m`)."""
    message = False
    for i, word in enumerate(words):
        text = text_of(word)
        if (message and any(c.isspace() for c in text)) or not text.startswith("-"):
            message = False
            continue
        message = text in MESSAGE_FLAGS or text.lower() == "-body"  # PowerShell names are any case
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


def body_file(flag, value):
    """The file a body flag's value names, a run-time word whose file cannot be told, or None."""
    text = text_of(value)
    if flag in FORM_FLAGS and "=" in text:
        at = re.search(r"=[@<]", text)
        if not at:
            return None
        return value if isinstance(value, dict) else text[at.end():]
    if flag in DATA_FLAGS:
        if not text.lstrip("\"'").startswith(("@", "<")):
            return None
        return value if isinstance(value, dict) else text[1:]
    return value


def body_files(words, flags=BODY_FLAGS):
    """Every file the words' flags in `flags` name as a body."""
    files = []
    for flag, value in flag_values(words, ("-F", "-d")):
        name = flag.lower() if isinstance(flag, str) and flag.lower() == "-infile" else flag
        if isinstance(name, str) and name in flags and value is not None:
            found = body_file(name, value)
            if found is not None:
                files.append(found)
    return files


def git_subcommand(words):
    """(index of git's subcommand, the folders its `-C` options name, in order)."""
    folders, i = [], 1
    while i < len(words) and text_of(words[i]).startswith("-"):
        if isinstance(words[i], str) and words[i] in GIT_VALUE_OPTIONS and i + 1 < len(words):
            if words[i] == "-C":
                folders.append(words[i + 1])
            i += 1
        i += 1
    return i, folders


def git_files(words):
    """The folders `git -C` names, and the body files of a git write. When the subcommand
    is built at run time (`git $OPTS commit`), every file flag after it is read."""
    i, folders = git_subcommand(words)
    if i >= len(words) or (isinstance(words[i], str) and words[i] not in GIT_WRITES):
        return folders, []
    return folders, body_files(words[i:], GIT_FILE_FLAGS)


def get_content_files(words):
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
    """(the folders `git -C` names, body files) for one command."""
    name = program(words)
    if name in TEXT_TOOLS:
        return [], []
    if name == "git":
        return git_files(words)
    if name == "gh":
        return [], body_files(words, BODY_FLAGS - {"--template"})
    if name in READ_CMDLETS:
        return [], get_content_files(words)
    # A wrapped git (`env A=1 git -C sub commit ...`) still runs in the folders it names.
    wrapped = next((words[i:] for i in range(1, len(words)) if program(words[i:]) == "git"), None)
    return (git_subcommand(wrapped)[1] if wrapped else []), body_files(words)


def parsed_files(commands, cwd):
    """(path, error) for every body file the parsed commands name, in order."""
    folder = cwd
    for words, in_child_shell in commands:
        if program(words) in CD_COMMANDS:
            # A child shell's `cd` leaves the outer folder as it was, but its own later
            # commands run in the new one, so neither can be told from here.
            folder = UNKNOWN if in_child_shell else moved_folder(words, folder)
            continue
        folders, files = command_files(words)
        here = folder
        for target in folders:
            here = moved_folder(["cd", target], here)
        for value in files:
            if value != "-":
                yield resolve(value, here)


def strict_files(cmd, cwd):
    """Without the parser: every file flag in the command text, a text tool's included. A
    relative file after a folder change (`cd`, `git -C`) cannot be placed, so it is refused."""
    moved = MOVES_FOLDER.search(cmd) is not None
    for m in FILE_FLAGS.finditer(cmd):
        path = m.group("dq") or m.group("sq") or m.group("kv") or m.group("bare")
        if not path or path == "-":
            continue
        if (m.group("long") or "").lower() == "--template":
            # A file for `git commit`; a template name or repository for gh.
            stage = cmd[max(cmd.rfind(c, 0, m.start()) for c in ";&|\n") + 1:m.start()]
            if not re.search(r"\bgit\b", stage, re.I):
                continue
        if "=" in path:            # gh -F key=value / key=@file
            if "=@" not in path:
                continue
            path = path.split("=@", 1)[1]
            if path == "-":        # key=@- reads stdin
                continue
        path = os.path.expanduser(path.strip("\"'"))
        if os.path.isabs(path):
            yield path, None
        elif moved:
            yield None, f"a relative body file {path} after a change of folder"
        else:
            yield os.path.join(cwd, path), None


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
    commands, hint = parse(cmd, "powershell" if data.get("tool_name") == "PowerShell" else "bash")
    for path, error in (parsed_files(commands, cwd) if commands is not None else strict_files(cmd, cwd)):
        if error:
            deny(f"could not tell which file holds {error}. Use a literal absolute path.{hint}")
        try:
            text = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception as e:
            deny(f"could not read message/body file {path}: {e}. Use a literal absolute path.{hint}")
        scan_text(text, f"file {path}")
    sys.exit(0)


if __name__ == "__main__":
    main()
