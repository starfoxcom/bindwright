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
    (`hooks/shell-words.mjs`), so each flag belongs to one
    command. Every command's flags are read, a wrapper's (`env`, `sudo`,
    `xargs`) included, except a text tool's (`awk -F,`, `grep -F word`),
    git's in a read (`git log -F`), and gh's `--template`. A flag inside
    quoted text, a here-doc, a here-string or the value of -m / --body /
    --title is text, not a body file. A relative path is read in the start
    folder and in every folder a `cd`, `pushd`, `Set-Location` or `git -C`
    in the command names, each reached from the folders named before it in
    the text, since one may run in a child shell or fail. A `cd` a loop or
    a function runs again, or before one written earlier, is not followed
    further. One after a folder change it cannot place (`cd -`, a
    target built at run time, a folder this computer cannot find) is
    denied. A file it cannot read, or one named by text built at run time,
    is denied, so a typo cannot slip a body through unread. A program built
    at run time has every file flag of its command read.

The parser is required: it runs on Node 18 or later from Bindwright's
helper, which setup installs with this guard. A command this hook reads is
denied when either is missing, when the helper is older than this hook, or
when the parser cannot read the command (an array built at run time,
PowerShell's `--%`, syntax it rejects), with a reason that names the fix.

Also denied, since the hook cannot see past them, for a git program (a
word built at run time that names git, such as `$GIT`, counts as one): a
write that skips git's own hooks (`--no-verify`, `-n` on commit or am),
setting or unsetting `core.hooksPath` or a `hook.` setting (`git config`,
`-c`, `--config-env`; reading one passes), `--trailer`, a commit that
reuses another commit's message (`-C`, `-c`, `--reuse-message`,
`--reedit-message`), and turning lefthook off (`LEFTHOOK=0` or `false` set
by the command, `lefthook uninstall`). Options are read as git reads them,
bundled (`-nm x`) or shortened (`--no-veri`), so a message that names one
passes.

It is a safety net for attribution written the ordinary way, not a sandbox
against a command built to slip past it. No text check can be one. These
pass unread: message text the shell builds at run time ($VAR, $(...),
backticks, eval), a body file the command itself writes, a body piped in
on stdin, a git alias or a git program built at run time whose text does
not name git (their options are not read as git's), and text a program
started by the command writes on its own. The repo's `attribution` settings
switch off the harness's own trailers; this hook catches the ones written
by hand.

The repo registers this file through run-hook.sh, which skips it when
~/.claude/hooks/no-ai-attribution.py exists and ~/.claude/settings.json
names it outside a permission rule.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent
exit 0 otherwise. A read-only command is blocked only for the routes above,
or when the parser it needs is missing or cannot read it.
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
# Commands that may change which hooks run without writing anything.
GIT_CONFIG_HOOKS = re.compile(r"\bgit\b[^|;&\n]*?\bconfig\b[^|;&\n]*hook", re.I)
LEFTHOOK_OFF = re.compile(r"\blefthook\b\W*=|\blefthook\b[^|;&\n]*\buninstall\b", re.I)
# A line end the shell joins to the next: `\` (an even run of `\` escapes itself) or
# PowerShell's backtick after a blank.
CONTINUED_LINE = re.compile(r"(?<!\\)((?:\\\\)*)\\\r?\n|(?<=[ \t])`\r?\n")

PATH_TOKEN = re.compile(r"(?<!:/)(?<![\w])(?:[A-Za-z]:|~)?(?:[\\/][\w.\-]+)+")

# With the parser: every command's file flags are read, except a text tool's, git's
# in a read (where -F or --file means something else) and gh's `--template` (a template
# name). Any other git subcommand, an alias included, is read as a write. A wrapper (`env`,
# `sudo`, `xargs`) or any other program has its flags read.
GIT_READS = {"grep", "log", "show", "whatchanged", "rev-list", "shortlog", "reflog", "diff", "blame",
             "status", "config", "clone", "init", "ls-files", "for-each-ref", "cat-file", "check-ignore"}
GIT_FILE_FLAGS = {"-F", "--file", "--template"}
GIT_WORD = re.compile(r"\bgit\b", re.I)  # `$GIT`, `$(command -v git)`
FORM_FLAGS = {"-F", "--field", "--form"}  # key=value is a field; key=@file reads a file
DATA_FLAGS = {"-d", "--data", "--data-binary", "--data-raw"}  # only @file reads a file
BODY_FLAGS = {"--file", "--body-file", "--notes-file", "--input", "--message-file", "--template",
              "-infile"} | FORM_FLAGS | DATA_FLAGS
# The word after one of these is message text, even when it starts with a dash. Each
# program has its own: `-m` is git's message but gh's `--merge` switch.
GIT_MESSAGE_FLAGS = {"-m", "--message"}
MESSAGE_FLAGS = {"-b", "--body", "-t", "--title", "--notes", "--subject", "--message"}
GH_MESSAGE_FLAGS = MESSAGE_FLAGS | {"-n"}  # gh's -n is --notes; git's is a switch
# `-am msg`: git's switches, then -m takes the next word. The first letter that takes a value
# takes the rest of the word instead (`-mcalm` is the message "calm"). Besides m, these
# lowercase letters take one in each git write that has -m (`git <subcommand> -h`); an alias
# or a subcommand built at run time may be any of them.
GIT_VALUE_LETTERS = {"commit": "ctu", "tag": "u", "notes": "c", "merge": "s", "commit-tree": "p"}
ANY_VALUE_LETTERS = "cpstu"
ATTACHED = ("-F", "-d")  # short flags read with a value written onto them (`-Fmsg`, `-d@body`)
TEXT_TOOLS = {"awk", "gawk", "mawk", "grep", "egrep", "fgrep", "rg", "sed", "sort", "cut", "tr", "uniq",
              "head", "tail", "wc", "jq", "column", "paste", "join", "select-string", "sls", "findstr"}
READ_CMDLETS = {"get-content", "gc"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--super-prefix", "--attr-source"}
HOME_COMMANDS = {"cd", "chdir", "set-location", "sl"}  # alone, each goes home
CD_COMMANDS = HOME_COMMANDS | {"pushd", "popd", "push-location", "pop-location"}
PARSE_SECONDS = 6  # the hook itself is stopped at 10 s
NO_NODE = ("this computer has no Node 18 or later, which the guard's parser needs to read the"
           " command. Install Node, then run /bindwright:update.")
NO_HELPER = "Bindwright's helper, which holds the guard's parser, is missing. Run /bindwright:update to install it."
OLD_HELPER = "Bindwright's helper is older than this guard. Run /bindwright:update to update it."
UNREAD = ("the guard's parser could not read this command (an array built at run time, PowerShell's"
          " `--%`, or syntax it rejects). Write it as plain commands.")
SLOW = (f"the guard's parser did not answer within {PARSE_SECONDS} s, so the command was not read."
        " Run it again once the computer is less busy.")
BROKEN = ("the guard's parser failed to run, so the command was not read. Run /bindwright:update to"
          " reinstall Bindwright's helper.")
LEFTHOOK_OFF_VALUES = {"0", "false"}
BYPASS_REASONS = {
    "hooks": "git hook bypass (--no-verify / -n) is not allowed.",
    "setting": ("setting core.hooksPath or a hook. setting changes which hooks git runs;"
                " ask the user to run it."),
    "trailer": "--trailer is not allowed; write the message body directly.",
    "reuse": "reusing another commit's message (-C / -c / --reuse-message) cannot be scanned.",
    "lefthook": "turning lefthook off removes the commit-msg attribution check.",
}
# Subcommands whose --no-verify skips a hook, and the options of each that take a value, so a
# value (`-m -n`) is never read as an option. A long option may be shortened to any unique
# prefix of at least the length given.
NO_VERIFY_SUBCOMMANDS = {"commit", "am", "merge", "push", "rebase"}
SHORT_VALUES = {"commit": "cCFmt", "am": "C", "merge": "mFsX", "push": "o", "rebase": "sXx"}
# Letters whose value is optional and only ever written onto them (`-uno`, `-S<keyid>`).
ATTACHED_VALUES = {"commit": "uS", "am": "S", "merge": "S", "rebase": "S"}
LONG_VALUES = {
    "commit": {"--author", "--date", "--file", "--message", "--reedit-message", "--reuse-message",
               "--fixup", "--squash", "--template", "--trailer", "--cleanup", "--pathspec-from-file"},
    "am": {"--directory", "--exclude", "--include", "--patch-format", "--resolvemsg", "--whitespace"},
    "merge": {"--strategy", "--strategy-option", "--message", "--file", "--into-name", "--cleanup"},
    "push": {"--push-option", "--repo", "--receive-pack", "--exec"},
    "rebase": {"--strategy", "--strategy-option", "--exec", "--onto"},
}
ENV_VALUE_OPTIONS = {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}
CONFIG_VALUE_OPTIONS = {"-f", "--file", "--blob", "-t", "--type", "--default", "--comment", "--value"}
CONFIG_READS = {"get", "list", "edit", "get-regexp", "get-all", "get-urlmatch", "get-color",
                "get-colorbool"}


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


def node_program(cwd):
    """The `node` on PATH, or None when the only one is the session folder's own. On Windows a
    bare name is looked up in the current folder first, so a repo could ship its own
    `node.exe`: that search is switched off, and a match that is relative (a `.` on PATH) or
    sits in the session folder is refused."""
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    found = shutil.which("node")
    if not found or not os.path.isabs(found):
        return None
    here = {os.path.normcase(os.path.realpath(folder)) for folder in (cwd, os.getcwd())}
    return None if os.path.normcase(os.path.realpath(os.path.dirname(found))) in here else found


def parse(cmd, shell, cwd):
    """(each simple command's words, the variables the command sets, "") as the shell reads
    them (helper/hooks/shell-words.mjs); (None, None, why) when the parser is missing, older
    than this guard, fails or cannot read the command."""
    node, script = node_program(cwd), parser_script()
    if not node:
        return None, None, NO_NODE
    if not script:
        return None, None, NO_HELPER
    try:
        # Bytes, not text: a text pipe on Windows would turn each LF into CR LF.
        out = subprocess.run([node, script, shell], input=cmd.encode("utf-8"),
                             capture_output=True, timeout=PARSE_SECONDS)
        data = json.loads(out.stdout.decode("utf-8")) if out.returncode == 0 else None
    except subprocess.TimeoutExpired:
        return None, None, SLOW
    except (OSError, ValueError):
        return None, None, BROKEN
    if not isinstance(data, dict) or not isinstance(data.get("commands"), list):
        return None, None, BROKEN
    if not isinstance(data.get("assignments"), list):
        return None, None, OLD_HELPER
    if data.get("error"):
        return None, None, UNREAD
    return data["commands"], data["assignments"], ""


def text_of(word):
    """A word's literal value, or the source text of one the shell builds at run time."""
    return word if isinstance(word, str) else str(word.get("dynamic", ""))


def program(words):
    if not words or not isinstance(words[0], str):
        return ""
    name = os.path.basename(words[0].replace("\\", "/")).lower()
    return name[:-4] if name.endswith(".exe") else name


def flag_values(words, short=(), message_flags=MESSAGE_FLAGS, value_letters=None):
    """(flag, value) for each word that can carry a value: `--flag value`, `--flag=value`,
    and a short flag in `short` written with its value attached (`-Fmsg`, `-d@body`). A
    value attached to its flag in a word built at run time (`--file=$F`) comes back as
    {"dynamic": <its text>}. The word after one of `message_flags` is that message's text,
    never a flag. With `value_letters`, so is the word after a git cluster ending in -m whose
    earlier letters take no value."""
    cluster = re.compile(r"-(?:(?![m%s])[a-z])*m" % value_letters) if value_letters is not None else None
    message = False
    for i, word in enumerate(words):
        text = text_of(word)
        if message or not text.startswith("-"):
            message = False
            continue
        built = isinstance(word, dict)
        message = (text in message_flags or text.lower() == "-body"  # PowerShell names are any case
                   or (cluster is not None and cluster.fullmatch(text) is not None))
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


def body_files(words, flags=BODY_FLAGS, message_flags=MESSAGE_FLAGS, readers="@<", value_letters=None):
    """Every file the words' flags in `flags` name as a body."""
    files = []
    for flag, value in flag_values(words, ATTACHED, message_flags, value_letters):
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
    """The body files of any git subcommand but a read. When the subcommand is built at run
    time (`git $OPTS commit`), every file flag after it is read."""
    i = git_subcommand(words)[0]
    if i >= len(words) or (isinstance(words[i], str) and words[i] in GIT_READS):
        return []
    return body_files(words[i:], GIT_FILE_FLAGS, GIT_MESSAGE_FLAGS, value_letters=git_value_letters(words))


def git_value_letters(words):
    """The lowercase letters other than m that take a value in this git command's subcommand."""
    i = git_subcommand(words)[0]
    subcommand = words[i] if i < len(words) and isinstance(words[i], str) else None
    return GIT_VALUE_LETTERS.get(subcommand, ANY_VALUE_LETTERS)


def get_content_files(words):
    files = [v for f, v in flag_values(words) if isinstance(f, str)
             and f.lower() in ("-path", "-literalpath") and v is not None]
    positional = [w for w in words[1:] if not (isinstance(w, str) and w.startswith("-"))]
    return files or positional[:1]


def resolve(value, places):
    """(path, error) for each file a body flag's value may name, or an error saying why it
    cannot be told before the command runs. A relative file is read in each of `places`
    that holds it, or in the first when none does; `places` is None after a folder change
    the command text cannot place."""
    if isinstance(value, dict):
        yield None, f"a body file named by text the shell builds at run time ({value.get('dynamic')})"
        return
    path = os.path.expanduser(value)
    if os.path.isabs(path):
        yield path, None
    elif places is None:
        yield None, (f"a relative body file {value} after a folder change the command text cannot tell"
                     " (such as `cd -`, a target built at run time or a folder this computer cannot find)")
    else:
        paths = [os.path.join(place, path) for place in places]
        yield from ((found, None) for found in [p for p in paths if os.path.isfile(p)] or paths[:1])


def command_files(words):
    """The body files one command names."""
    name = program(words)
    if name in TEXT_TOOLS:
        return []
    if name == "git":
        return git_files(words)
    if name == "gh":
        return body_files(words, BODY_FLAGS - {"--template"}, GH_MESSAGE_FLAGS, "@")
    if name in READ_CMDLETS:
        return get_content_files(words)
    # Every flag is read. A word naming git, gh or Get-Content may be a wrapped program (`env
    # A=1 git commit`, `sudo gh ...`, `pwsh -Command Get-Content x`) or just an argument
    # (`sudo -u git`, a URL ending in /gh), so each is also read with its own rules, and only
    # its own exceptions (gh's --template, git's -m) are taken off the outer read.
    inner = [words[i:] for i in range(1, len(words)) if program(words[i:]) in {"git", "gh"} | READ_CMDLETS]
    names = {program(run) for run in inner}
    # git's own reads take its --template; elsewhere it names one, unless a word built at run
    # time names git (`timeout 5 $GIT commit`). Then git's -m is a message too.
    built_git = any(is_run_time_git(w) for w in words)
    flags = BODY_FLAGS if built_git else BODY_FLAGS - {"--template"}
    message = MESSAGE_FLAGS | (GIT_MESSAGE_FLAGS if "git" in names or built_git else set())
    letters = None if "git" not in names and not built_git else "".join(
        [ANY_VALUE_LETTERS] * built_git + [git_value_letters(run) for run in inner if program(run) == "git"])
    readers = "@" if "gh" in names else "@<"  # gh reads a form field's file only after =@
    return (body_files(words, flags, message, readers, letters)
            + [f for run in inner for f in command_files(run)])


def folder_targets(words):
    """The folders one command names to move to: a `cd`-style command's targets (home for a
    bare `cd`, none for `popd` or a bare `pushd`), or the `-C` folders of a git it runs."""
    name = program(words)
    if name in CD_COMMANDS:
        targets = [w for w in words[1:] if text_of(w) == "-" or not text_of(w).startswith("-")]
        return targets or (["~"] if name in HOME_COMMANDS else [])
    return [folder for i in range(len(words)) if program(words[i:]) == "git" or is_run_time_git(words[i])
            for folder in git_subcommand(words[i:])[1]]


def is_run_time_git(word):
    """Whether a word built at run time names git (`$GIT`, `$(command -v git)`)."""
    return isinstance(word, dict) and GIT_WORD.search(text_of(word)) is not None


def folder_places(commands, cwd):
    """Every folder a command may run in: the start folder, and each folder a folder change
    in the command names, reached from any folder found before it in the text, since a `cd`
    may run in a child shell or fail, so the shell may be in any of them. None when a target
    cannot be placed: one built at run time, or one this computer cannot find, such as a
    saved folder (`cd -`, `~-`), a Git Bash path (`/c/...`) or a folder made later."""
    places = [cwd]
    for words in commands:
        for target in folder_targets(words):
            if not isinstance(target, str):
                return None
            path = os.path.expanduser(target)
            reached = [path] if os.path.isabs(path) else [os.path.join(place, path) for place in places]
            found = [place for place in reached if os.path.isdir(place)]
            if not found:
                return None
            places += [place for place in found if place not in places]
    return places


def parsed_files(commands, cwd):
    """(path, error) for every body file the parsed commands name, in order, a relative one
    read in every folder the command may run in."""
    places = folder_places(commands, cwd)
    for words in commands:
        for value in command_files(words):
            if value != "-":
                yield from resolve(value, places)


def abbreviates(word, option, shortest):
    """Whether git reads `word` as the long option `option` (any prefix from `shortest` on)."""
    name = word.split("=", 1)[0]
    return len(name) >= len(shortest) and option.startswith(name)


def option_words(subcommand, rest):
    """The options of one git subcommand, one per letter of a bundle (`-nm` is `-n`, `-m`), with
    every option's value skipped, up to `--`."""
    options, skip, letters = [], False, SHORT_VALUES.get(subcommand, "")
    for word in (text_of(w) for w in rest):
        if skip:
            skip = False
        elif word == "--":
            break
        elif word.startswith("--"):
            options.append(word.split("=", 1)[0])
            skip = "=" not in word and any(abbreviates(word, o, o[:5]) for o in LONG_VALUES.get(subcommand, ()))
        elif word.startswith("-") and len(word) > 1:
            for k, letter in enumerate(word[1:], 1):
                options.append("-" + letter)
                if letter in letters:
                    skip = k == len(word) - 1
                    break
                if letter in ATTACHED_VALUES.get(subcommand, ""):  # `-uno`: the rest is its value
                    break
    return options


def names_hooks(setting):
    setting = setting.lower()
    return "hookspath" in setting or setting.startswith("hook.")


def config_sets_hooks(rest):
    """Whether `git config` sets or unsets a hook setting; a read passes."""
    names, skip, unsets = [], False, False
    for word in (text_of(w) for w in rest):
        # The old form (`git config <name> <value>`) stops reading options at the first name, so a
        # later `--get` is the value it stores.
        legacy = names and names[0] not in ("set", "unset") and names[0] not in CONFIG_READS
        if skip:
            skip = False
        elif word.startswith("-") and not legacy:
            if word.startswith("--get") or word in ("-l", "--list"):
                return False
            unsets = unsets or abbreviates(word, "--unset-all", "--uns")
            skip = word in CONFIG_VALUE_OPTIONS
        else:
            names.append(word)
    if names[:1] in (["set"], ["unset"]):
        unsets, names = unsets or names[0] == "unset", names[1:]
    elif names[:1] and names[0] in CONFIG_READS:
        return False
    return len(names) >= (1 if unsets else 2) and names_hooks(names[0])


def git_route(words):
    """The kind of route past the hooks one git call takes, or None."""
    i = git_subcommand(words)[0]
    before = [text_of(w) for w in words[1:i]]
    settings = [v for k, v in zip(before, before[1:]) if k in ("-c", "--config-env")]
    settings += [w.split("=", 1)[1] for w in before if w.startswith("--config-env=")]
    if any(names_hooks(s) for s in settings):
        return "setting"
    if i >= len(words) or not isinstance(words[i], str):
        return None
    subcommand, rest = words[i], words[i + 1:]
    if subcommand == "config":
        return "setting" if config_sets_hooks(rest) else None
    options = option_words(subcommand, rest)
    if subcommand in NO_VERIFY_SUBCOMMANDS and any(abbreviates(o, "--no-verify", "--no-v") for o in options):
        return "hooks"
    if subcommand in ("commit", "am") and "-n" in options:
        return "hooks"
    if subcommand != "commit":
        return None
    if any(abbreviates(o, "--trailer", "--tr") for o in options):
        return "trailer"
    reuses = ("--reuse-message", "--reedit-message")
    if any(o in ("-C", "-c") or any(abbreviates(o, r, r[:5]) for r in reuses) for o in options):
        return "reuse"
    return None


def env_assignments(words):
    """The `NAME=value` words an `env` in this command sets for the program it runs."""
    found = []
    for i in range(len(words)):
        if program(words[i:]) != "env":
            continue
        skip = False
        for text in (text_of(w) for w in words[i + 1:]):
            if skip:
                skip = False
            elif text.startswith("-"):
                skip = text in ENV_VALUE_OPTIONS
            elif re.match(r"\w+=", text):
                found.append(text)
            else:
                break
    return found


def turns_lefthook_off(commands, assignments):
    """Whether the command sets LEFTHOOK to 0, false or a value built at run time (by
    assignment, `export`, `env` or PowerShell's `$env:`), or runs `lefthook uninstall`."""
    settings = [(s.get("name"), s.get("value")) for s in assignments if isinstance(s, dict)]
    settings += [tuple(text.split("=", 1)) for words in commands for text in env_assignments(words)]
    for name, value in settings:
        name = re.sub(r"^\$\{?(?:env:)?|\}$", "", str(name), flags=re.I).lower()
        if name == "lefthook" and (not isinstance(value, str) or value.strip("'\"").lower() in LEFTHOOK_OFF_VALUES):
            return True
    for words in commands:
        for i in range(len(words)):
            if program(words[i:]) == "lefthook":
                rest = [text_of(w) for w in words[i + 1:] if not text_of(w).startswith("-")]
                if rest[:1] == ["uninstall"]:
                    return True
    return False


def hook_route(commands, assignments):
    """The kind of route past git's hooks the parsed command takes, or None. A git run through
    a wrapper (`env A=1 git`, `sudo git`) counts, as does a word built at run time that names
    git (`$GIT`)."""
    if turns_lefthook_off(commands, assignments):
        return "lefthook"
    for words in commands:
        for i, word in enumerate(words):
            if program(words[i:]) == "git" or is_run_time_git(word):
                route = git_route(words[i:])
                if route:
                    return route
    return None


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
    joined = CONTINUED_LINE.sub(r"\1", cmd)
    texts = (cmd, joined)  # joining lines can also hide a match, so both are checked
    writes = any(p.search(t) for p in (GIT_WRITE, GH_WRITE, GH_API, HTTP_GH) for t in texts)
    if not (writes or any(p.search(t) for p in (GIT_CONFIG_HOOKS, LEFTHOOK_OFF) for t in texts)):
        sys.exit(0)

    if writes:
        scan_text(cmd, "the command text")
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    parsed, assignments, problem = parse(cmd, shell, cwd)
    if problem:
        deny(problem)
    # A command that writes nothing is checked only for the routes past the hooks.
    for path, error in (parsed_files(parsed, cwd) if writes else ()):
        if error:
            deny(f"could not tell which file holds {error}. Use a literal absolute path.")
        try:
            text = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception as e:
            deny(f"could not read message/body file {path}: {e}. Use a literal absolute path.")
        scan_text(text, f"file {path}")
    route = hook_route(parsed, assignments)
    if route:
        deny(BYPASS_REASONS[route])
    sys.exit(0)

if __name__ == "__main__":
    main()
