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
    for a git write, -F at the end of a cluster (-aF), and -t for git
    commit; --body-file / --notes-file / --input / -F and
    --field key=@file; -d @file and -F key=@file; -InFile; Get-Content's
    path). Bindwright's helper parses the command the way the shell does
    (`hooks/shell-words.mjs`), so each flag belongs to one
    command. Every command's flags are read, a wrapper's (`env`, `sudo`,
    `xargs`) included, except a text tool's (`awk -F,`, `grep -F word`),
    git's in a read (`git log -F`), and gh's `--template`. A flag inside
    quoted text, a here-doc, a here-string or the value of -m / --body /
    --title is text, not a body file. A relative path is read in the start
    folder and in every folder a `cd` (`builtin cd` and `command cd` too),
    `pushd`, `Set-Location`, `git -C` or `env -C` / `--chdir` in the
    command names, each reached from the folders named before it in
    the text, since one may run in a child shell or fail, then again until
    no folder is added, since a loop or a function may run one again. One
    after a folder change it cannot place (`cd -`, a
    target built at run time, a folder this computer cannot find) is
    denied. A file it cannot read, or one named by text built at run time,
    is denied, so a typo cannot slip a body through unread. A program built
    at run time has every file flag of its command read. A shell's options
    are never read: each argument of `bash`, `sh`, `zsh` and the like whose
    text names a write or a hook change is parsed and read like the command,
    up to three shells deep; one built at run time or nested deeper is
    denied, as is a nested `pwsh` or `powershell` whose text arguments name
    one, since PowerShell joins them into a script (but a script block
    after options alone is read with the command, and words after a `.ps1`
    file are its parameters). A shell named at run time, or a word after
    git, gh or a text tool first or after `sudo`-like wrappers, is not read.

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
passes. A word built at run time counts for the literal text around its
run-time parts (`--trailer=$WHO`, `"-C$SHA"`, `"$S.hooksPath"`), and one
that can expand to no word (`$OPTS`, `"$@"`) is also read as absent.

It is a safety net for attribution written the ordinary way, not a sandbox
against a command built to slip past it. No text check can be one. These
pass unread: message text the shell builds at run time ($VAR, $(...),
backticks, eval), a body file the command itself writes, a body piped in
on stdin, a git alias or a git program built at run time whose text does
not name git (their options are not read as git's), an option, setting or
`git config` name whose text the shell builds at run time (`${X:+-n}`,
`$(echo --no-verify)`, `"$KEY"`, `core.ho$'o'ksPath`), and text a program
started by the command writes on its own. The repo's `attribution` settings
switch off the harness's own trailers; this hook catches the ones written
by hand.

Its reading lives in the no_ai_attribution/ folder beside it, which ships
and installs with it. The repo registers this file through run-hook.sh, which skips it when
~/.claude/hooks/no-ai-attribution.py exists and ~/.claude/settings.json
names it outside a permission rule.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent
exit 0 otherwise. A read-only command is blocked only for the routes above,
or when the parser it needs is missing or cannot read it.
"""
import json
import os
import re
import sys
import time


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
    ]), re.I | re.M)
# Text bash rewrites before a program sees it: a backslash escape or an ANSI-C or locale
# string can spell any word, so the text checks cannot rule such a command out.
SHELL_ESCAPES = re.compile(r"\\|\$['\"]")

PATH_TOKEN = re.compile(r"(?<!:/)(?<![\w])(?:[A-Za-z]:|~)?(?:[\\/][\w.\-]+)+")
ALL_PARSES_SECONDS = 9  # every parse of one command, nested strings included: the hook is stopped at 10 s
BYPASS_REASONS = {
    "hooks": "git hook bypass (--no-verify / -n) is not allowed.",
    "setting": ("setting core.hooksPath or a hook. setting changes which hooks git runs;"
                " ask the user to run it."),
    "trailer": "--trailer is not allowed; write the message body directly.",
    "reuse": "reusing another commit's message (-C / -c / --reuse-message) cannot be scanned.",
    "lefthook": "turning lefthook off removes the commit-msg attribution check.",
    "unread": ("this git call has more words built at run time than the guard reads every way;"
               " split it, or write some of them out."),
}


def deny(reason):
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
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


def scan_text(text, where):
    hit = ATTRIBUTION.search(strip_paths(text))
    if hit:
        deny(f"attribution marker '{hit.group(0).strip()}' found in {where}.")


def readers(cmd):
    """The package's readers, loaded only here so the Attribution workflow can import this file
    alone; without the package, a command that may write is refused with the fix."""
    sys.dont_write_bytecode = True  # no __pycache__ beside a hook a repo may commit
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from no_ai_attribution.files import parsed_files
        from no_ai_attribution.routes import hook_route
        from no_ai_attribution.shell import parse, routes_in, with_nested
    except ImportError:
        if re.search(r"git|gh|lefthook|api\.github", cmd, re.I):
            deny("the folder no_ai_attribution/ next to this guard, which holds its parser code, is"
                 " missing. Run /bindwright:update to restore it.")
        sys.exit(0)
    return parse, routes_in, with_nested, parsed_files, hook_route


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
    parse, routes_in, with_nested, parsed_files, hook_route = readers(cmd)
    writes, named = routes_in(cmd)
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    # An escaped bash command goes to the parser even when its text names no route, but only
    # the parser's words can refuse it then: a parser that cannot read it refuses nothing new.
    if not (named or shell == "bash" and SHELL_ESCAPES.search(cmd)):
        sys.exit(0)

    if writes:
        scan_text(cmd, "the command text")
    deadline = time.monotonic() + ALL_PARSES_SECONDS
    parsed, assignments, problem = parse(cmd, shell, cwd, deadline)
    found = []  # A nested string is read only when it names a route, so its problems all refuse.
    if not problem:
        groups, assignments, problem = with_nested(parsed, assignments, shell, cwd, deadline, found)
    if problem:
        if named or found:
            deny(problem)
        sys.exit(0)
    for text in (t for t in found if routes_in(t)[0]):
        writes = True
        scan_text(text, "a command string a shell runs")
    # A command that writes nothing is checked only for the routes past the hooks.
    for path, error in (parsed_files(groups, cwd) if writes else ()):
        if error:
            deny(f"could not tell which file holds {error}. Use a literal absolute path.")
        try:
            text = open(path, encoding="utf-8-sig", errors="replace").read()
        except Exception as e:
            deny(f"could not read message/body file {path}: {e}. Use a literal absolute path.")
        scan_text(text, f"file {path}")
    route = hook_route(groups, assignments)
    if route:
        deny(BYPASS_REASONS[route])
    sys.exit(0)

if __name__ == "__main__":
    main()
