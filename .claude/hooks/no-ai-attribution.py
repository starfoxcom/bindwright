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
    or the value of -m / --body / --title is text, not a body file. After a
    `cd`, `pushd` or `Set-Location`, which may run in a child shell or fail,
    a relative path is read in every folder the command may be in, each
    folder its `git -C` names included. One after a `cd -`, a `cd` to a folder this
    computer cannot find, or a `cd` beside a loop or a function, is denied.
    A file it cannot read, or one named by text built at run time,
    is denied, so a typo cannot slip a body through unread. Without the
    helper or Node it reads every file flag in the command text instead,
    a text tool's and one inside quoted text included, and denies a
    relative body file after any `cd`, `pushd`, `Set-Location` or `git -C`.

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
# The word after one of these is message text, even when it starts with a dash. Each
# program has its own: `-m` is git's message but gh's `--merge` switch.
GIT_MESSAGE_FLAGS = {"-m", "--message"}
MESSAGE_FLAGS = {"-b", "--body", "-t", "--title", "--notes", "--subject", "--message"}
GH_MESSAGE_FLAGS = MESSAGE_FLAGS | {"-n"}  # gh's -n is --notes; git's is a switch
# Git reads a short-flag cluster letter by letter: switches, then the first -m or -F takes
# the rest of the word, or the next word (`-am msg`, `-aF msg.txt`, `-aFmsg.txt`).
GIT_CLUSTER = re.compile(r"-(?:(?![CcStu])[A-Za-z])*?([mF])(.*)", re.S)
ATTACHED = ("-F", "-d")  # short flags read with a value written onto them (`-Fmsg`, `-d@body`)
# A PowerShell word shaped like an identifier (`-Filter`, `-Force:$true`) can be a cmdlet's
# parameter name; any other dash word (`-Fbody=@x`, `-d@body`) only a native program's flags.
PARAMETER_NAME = re.compile(r"-[A-Za-z_]\w*:?")
TEXT_TOOLS = {"awk", "gawk", "mawk", "grep", "egrep", "fgrep", "rg", "sed", "sort", "cut", "tr", "uniq",
              "head", "tail", "wc", "jq", "column", "paste", "join", "select-string", "sls", "findstr"}
READ_CMDLETS = {"get-content", "gc"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--super-prefix", "--attr-source"}
POP_COMMANDS = {"popd", "pop-location"}
PUSH_COMMANDS = {"pushd", "push-location"}
SAVED_FOLDER = re.compile(r"~[+-]|~\d")  # bash's previous, current or stacked folder
CD_COMMANDS = {"cd", "chdir", "set-location", "sl"} | PUSH_COMMANDS | POP_COMMANDS
UNKNOWN = object()  # a folder the command text cannot tell
PARSE_SECONDS = 6  # the hook itself is stopped at 10 s
STRICT_READ = (" so it read every file flag, a text tool's (awk -F, grep -F) included: run that tool"
               " as a command of its own.")
NO_HELPER_HINT = (" Without Bindwright's helper (`/bindwright:update` installs it), the guard cannot"
                  " read the command's structure," + STRICT_READ)
NO_NODE_HINT = (" The guard reads a command's structure with a parser that runs on Node 18 or later,"
                " which this computer lacks (install it to stop these refusals)," + STRICT_READ)
UNREAD_HINT = " The guard could not read this command's structure," + STRICT_READ
MOVES_FOLDER = re.compile(r"(?<![\w-])(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)"
                          r"(?![\w-])|\bgit\b[^|;&\n]*?\s(?-i:-C)(?![\w-])", re.I)  # -c sets config


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


def parser_script():
    """The shell parser in Bindwright's helper, which setup installs per computer with npm
    or pip; None when neither copy is there."""
    helper = os.path.join(os.path.expanduser("~"), ".bindwright", "helper")
    folders = [os.environ.get("BINDWRIGHT_HELPER")] if os.environ.get("BINDWRIGHT_HELPER") else [
        os.path.join(helper, "node_modules", "bindwright"), os.path.join(helper, "python", "bindwright")]
    scripts = [os.path.join(folder, "hooks", "shell-words.mjs") for folder in folders]
    return next((script for script in scripts if os.path.isfile(script)), None)


def parse(cmd, shell):
    """(each simple command's words, as the shell reads them (helper/hooks/shell-words.mjs),
    whether a loop or a function may run them out of source order), and "". When the parser
    is missing, fails or meets syntax it cannot read: None, and the hint that says which."""
    node, script = shutil.which("node"), parser_script()
    if not node:
        return None, NO_NODE_HINT
    if not script:
        return None, NO_HELPER_HINT
    try:
        # Bytes, not text: a text pipe on Windows would turn each LF into CR LF.
        out = subprocess.run([node, script, shell], input=cmd.encode("utf-8"),
                             capture_output=True, timeout=PARSE_SECONDS)
        data = json.loads(out.stdout.decode("utf-8")) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None, UNREAD_HINT
    if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("commands"), list):
        return None, UNREAD_HINT
    return (data["commands"], bool(data.get("repeats"))), ""


def text_of(word):
    """A word's literal value, or the source text of one the shell builds at run time."""
    return word if isinstance(word, str) else str(word.get("dynamic", ""))


def program(words):
    if not words or not isinstance(words[0], str):
        return ""
    name = os.path.basename(words[0].replace("\\", "/")).lower()
    return name[:-4] if name.endswith(".exe") else name


def flag_values(words, short=(), message_flags=MESSAGE_FLAGS, parameter_names=False):
    """(flag, value) for each word that can carry a value: `--flag value`, `--flag=value`,
    and a short flag in `short` written with its value attached (`-Fmsg`, `-d@body`). A
    value attached to its flag in a word built at run time (`--file=$F`) comes back as
    {"dynamic": <its text>}. The word after one of `message_flags` is that message's text,
    never a flag. With `parameter_names`, a word shaped like a PowerShell parameter name
    never carries an attached value or a git cluster's -F."""
    message = False
    for i, word in enumerate(words):
        text = text_of(word)
        if message or not text.startswith("-"):
            message = False
            continue
        built = isinstance(word, dict)
        named = parameter_names and PARAMETER_NAME.fullmatch(text) is not None
        cluster = None if "-m" not in message_flags or text.startswith("--") else GIT_CLUSTER.fullmatch(text)
        message = (text in message_flags or text.lower() == "-body"  # PowerShell names are any case
                   or (cluster is not None and cluster.groups() == ("m", "")))
        if cluster is not None and cluster.group(1) == "F" and not named:
            flag, value = "-F", cluster.group(2)
            if not value:
                yield flag, words[i + 1] if i + 1 < len(words) else None
                continue
        elif text.startswith("--") and "=" in text:
            flag, value = text.split("=", 1)
        elif text[:2] in short and len(text) > 2 and not named:
            flag, value = text[:2], text[2:]
        elif built:
            continue
        else:
            yield word, words[i + 1] if i + 1 < len(words) else None
            continue
        yield flag, {"dynamic": value} if built else value


def body_file(flag, value, readers="@<"):
    """The file a body flag's value names, a run-time word whose file cannot be told, or None.
    A form field reads a file when its value, after the first `=`, starts with one of
    `readers`: `@` for gh, `@` or `<` for curl."""
    text = text_of(value)
    if flag in FORM_FLAGS and "=" in text:
        field = text.split("=", 1)[1]
        if not field.lstrip("\"'")[:1] or field.lstrip("\"'")[:1] not in readers:
            return None
        return value if isinstance(value, dict) else field[1:]
    if flag in DATA_FLAGS:
        if not text.lstrip("\"'").startswith("@"):  # curl -d reads a file only after @
            return None
        return value if isinstance(value, dict) else text[1:]
    return value


def body_files(words, flags=BODY_FLAGS, message_flags=MESSAGE_FLAGS, readers="@<", parameter_names=False):
    """Every file the words' flags in `flags` name as a body."""
    files = []
    for flag, value in flag_values(words, ATTACHED, message_flags, parameter_names):
        name = flag.lower() if isinstance(flag, str) and flag.lower() == "-infile" else flag
        if isinstance(name, str) and name in flags and value is not None:
            found = body_file(name, value, readers)
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
    return folders, body_files(words[i:], GIT_FILE_FLAGS, GIT_MESSAGE_FLAGS)


def git_reads(words):
    """([the folders its `git -C` options name], body files) for a git command."""
    folders, files = git_files(words)
    return [folders] if folders else [], files


def get_content_files(words):
    files = [v for f, v in flag_values(words) if isinstance(f, str)
             and f.lower() in ("-path", "-literalpath") and v is not None]
    positional = [w for w in words[1:] if not (isinstance(w, str) and w.startswith("-"))]
    return files or positional[:1]


def resolve(value, places):
    """(path, error) for each file a body flag's value may name, or an error saying why it
    cannot be told before the command runs. A relative file is read in each of `places`
    that holds it, or in the first when none does."""
    if isinstance(value, dict):
        yield None, f"a body file named by text the shell builds at run time ({value.get('dynamic')})"
        return
    path = os.path.expanduser(value)
    if os.path.isabs(path):
        yield path, None
    elif not places or UNKNOWN in places:
        yield None, (f"a relative body file {value} after a folder change the command text cannot tell"
                     " (such as `cd -`, a target built at run time or a folder this computer cannot find,"
                     " or a `cd` beside a loop or a function)")
    else:
        paths = [os.path.join(place, path) for place in places]
        yield from ((found, None) for found in [p for p in paths if os.path.isfile(p)] or paths[:1])


def joined(target, places):
    """The folders a folder name reaches from any of `places`; UNKNOWN for one built at run time."""
    if not isinstance(target, str):
        return [UNKNOWN]
    path = os.path.expanduser(target)
    if os.path.isabs(path):
        return [path]
    return [UNKNOWN if place is UNKNOWN else os.path.join(place, path) for place in places]


def cd_places(words, places):
    """The folders a `cd`-style command may move to from any of `places`: none for a return
    to a folder this command pushed (`popd`, a bare `pushd`), home for a bare `cd`, and
    UNKNOWN for a saved folder the command text does not hold (`cd -`, `~-`, `~+`, `~2`) or
    for more than one target word (`cd sub -ErrorAction Stop`)."""
    targets = [w for w in words[1:] if not text_of(w).startswith("-")]
    if program(words) in POP_COMMANDS:
        return []
    saved = any(SAVED_FOLDER.match(text_of(w)) for w in targets)
    if saved or len(targets) > 1 or "-" in [text_of(w) for w in words[1:]]:
        return [UNKNOWN]
    if not targets:
        return [] if program(words) in PUSH_COMMANDS else [os.path.expanduser("~")]
    return joined(targets[-1], places)


def command_files(words, shell="bash"):
    """(the `git -C` folder chains its reads name, body files) for one command, which may
    run in any folder those chains reach. In PowerShell, outside
    git's and gh's own words, a word such as `-Force` or `-FilePath` is a parameter name,
    unless the program is built at run time and may be git."""
    name = program(words)
    if name in TEXT_TOOLS:
        return [], []
    if name == "git":
        return git_reads(words)
    if name == "gh":
        return [], body_files(words, BODY_FLAGS - {"--template"}, GH_MESSAGE_FLAGS, "@")
    if name in READ_CMDLETS:
        return [], get_content_files(words)
    # Every flag is read. A word naming git or gh may be a wrapped program (`env A=1 git -C
    # sub commit`, `sudo gh ...`) or just an argument (`sudo -u git`, a URL ending in /gh),
    # so each is also read with its own rules, and only its own exceptions (gh's
    # --template, git's -m) are taken off the outer read.
    inner = [words[i:] for i in range(1, len(words)) if program(words[i:]) in ("git", "gh")]
    names = {program(run) for run in inner}
    found = [command_files(run, shell) for run in inner]
    # A program built at run time, or an array's words, may be git's: they are read with git's
    # rules too (`-aF msg`), and git's -m stays off the outer read, where gh's -m is a switch.
    if words and not isinstance(words[0], str):
        found.append(git_reads(["git", "commit", *words[1:]] if is_array(words) else ["git", *words[1:]]))
    flags = BODY_FLAGS - {"--template"} if "gh" in names else BODY_FLAGS
    message = MESSAGE_FLAGS | (GIT_MESSAGE_FLAGS if "git" in names else set())
    readers = "@" if "gh" in names else "@<"  # gh reads a form field's file only after =@
    named = shell == "powershell" and bool(words) and isinstance(words[0], str)
    files = body_files(words, flags, message, readers, named) + [f for _, run_files in found for f in run_files]
    return [chain for chains, _ in found for chain in chains], files


def reachable(named):
    """The folders in `named` this computer can find; UNKNOWN when it finds none of them, as
    for a Git Bash path (`/c/...`) or a folder made later, which cannot be checked."""
    found = [place for place in named if place is UNKNOWN or os.path.isdir(place)]
    return found if found or not named else [UNKNOWN]


def command_places(chains, places):
    """Every folder one command may run in: each folder its `git -C` chains reach from
    `places`, first, then each of `places`."""
    here = []
    for chain in chains:
        reached = places
        for target in chain:
            reached = reachable(joined(target, reached))
        here += [place for place in reached if place not in here]
    return here + [place for place in places if place not in here]


def is_array(words):
    """Whether these words are a bash array's, which a later command uses wherever it runs."""
    return bool(words) and isinstance(words[0], dict) and words[0].get("array") is True


def parsed_files(commands, repeats, cwd, shell):
    """(path, error) for every body file the parsed commands name, in order. A `cd` may run
    in a child shell (a subshell, a pipeline, a background job) or fail, so the shell may be
    in any folder one named so far, and each command also in any folder its `git -C` reaches.
    A loop or a function can run a later `cd` before an earlier write, so beside one any `cd`
    makes the folder unknown."""
    places = [UNKNOWN] if repeats and any(program(words) in CD_COMMANDS for words in commands) else [cwd]
    # An array's words run where the command that uses them runs, after any folder change.
    moves = any(program(words) in CD_COMMANDS or command_files(words, shell)[0] for words in commands)
    for words in commands:
        if program(words) in CD_COMMANDS:
            # A `cd` that fails from one place leaves the shell where it was, so a missing
            # folder is dropped.
            places += [place for place in reachable(cd_places(words, places)) if place not in places]
            continue
        chains, files = command_files(words, shell)
        here = [UNKNOWN] if moves and is_array(words) else command_places(chains, places)
        for value in files:
            if value != "-":
                yield from resolve(value, here)


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
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    parsed, hint = parse(cmd, shell)
    for path, error in (parsed_files(*parsed, cwd, shell) if parsed is not None else strict_files(cmd, cwd)):
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
