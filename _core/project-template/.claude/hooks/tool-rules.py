#!/usr/bin/env python3
"""PreToolUse guard: refuse the shell patterns a session was told to stop using.

Each rule in RULES names a pattern that keeps failing, why, and what to use
instead. A correction of the kind "never use X, use Y" lands here as a new rule,
so the session cannot drift back to X: a note in memory alone does not hold.

Rules read the command's text. A rule marked `bare` reads it with quoted
strings and here-document bodies taken out, so a commit message or a PR body
that only mentions the pattern passes. It is a safety net for the ordinary
spelling, not a sandbox against a command built to slip past it.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent exit 0
otherwise, and for any input it cannot read.
"""
import json
import re
import sys

INTERPRETER = r"(?:python3?|py|node|deno|bun|perl|ruby|php|bash|sh|zsh|pwsh|powershell)(?:\.exe)?"
INTERPRETER_WORD = re.compile(r"(?:^|[\s;&|(])" + INTERPRETER + r"(?=[\s;&|)]|$)", re.I)
HEREDOC = re.compile(r"<<(-?)[ \t]*(['\"]?)([A-Za-z_][\w-]*)\2")
HERE_STRING = re.compile(r"@(['\"])\r?\n(.*?)\r?\n\1@([^\n]*)", re.S)
# `python -c '...'`, `node -e "..."`: the script text, as far as its closing quote.
INLINE = re.compile(r"(?:^|[\s;&|(])(?:python3?|py)(?:\.exe)?(?:[ \t]+-\w+)*[ \t]+-c[ \t]+(['\"])(.*?)\1"
                    r"|(?:^|[\s;&|(])node(?:\.exe)?(?:[ \t]+-\S+)*?[ \t]+(?:-e|-p|--eval|--print)[ \t]+(['\"])(.*?)\3",
                    re.I | re.S)
# `origin/develop:.claude/x`: a git object path that starts with a dot.
REV_DOT_PATH = re.compile(r"\bgit\s+(?:show|cat-file|ls-tree|diff)\b[^\n|;&]*?[\s\"'][\w./@~^-]+:\.[^/\s.]", re.I)
QUOTED = re.compile(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"")

WRITE_THE_FILE = "its backslashes get eaten. Write the script with the Write tool, then run the file."


def heredoc_bodies(text):
    """(line holding the `<<`, body) for each here-document in the text."""
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        found = list(HEREDOC.finditer(lines[i]))
        start, i = i, i + 1
        for match in found:
            body = []
            while i < len(lines):
                line = lines[i].rstrip("\r")
                i += 1
                if (line.lstrip("\t") if match.group(1) else line) == match.group(3):
                    break
                body.append(line)
            yield lines[start], "\n".join(body)


def inline_script(text, shell):
    """Whether an interpreter is handed a script holding a backslash."""
    if any(INTERPRETER_WORD.search(line) and "\\" in body for line, body in heredoc_bodies(text)):
        return True
    if shell == "powershell" and any("\\" in m.group(2) and INTERPRETER_WORD.search(m.group(3))
                                     for m in HERE_STRING.finditer(text)):
        return True
    return any("\\" in (m.group(2) or m.group(4) or "") for m in INLINE.finditer(text))


def bare(text):
    """The command with quoted strings and here-document bodies taken out."""
    for _, body in heredoc_bodies(text):
        if body:
            text = text.replace(body, "")
    return QUOTED.sub("''", text)


def both(*patterns):
    """A test that holds when every pattern is found in the bare command."""
    compiled = [re.compile(p, re.I) for p in patterns]
    return lambda text, shell: all(p.search(bare(text)) for p in compiled)


RULES = [
    ("an inline script holding a backslash", inline_script, WRITE_THE_FILE),
    ("`gh run watch`", both(r"\bgh\s+run\s+watch\b"),
     "it blocks the session. ci-watch (or a bounded watcher, token-efficiency.md) watches checks."),
    ("the size check chained with a commit or push", both(r"size_check\.py", r"\bgit\s+(?:commit|push)\b"),
     "the commit runs past its breaches. Run size_check.py in its own call first."),
    ("`git push` and `gh pr create` in one command", both(r"\bgit\s+push\b", r"\bgh\s+pr\s+create\b"),
     "the chain gets refused. Push, then open the PR in a separate call."),
    ("`git checkout <rev> -- <path>`", both(r"\bgit\s+checkout\s+(?!-)\S+\s+--\s+\S"),
     "it overwrites and stages those files. Peek with `git show <rev>:./<path>`; restore with `git restore`."),
    ("`gh pr merge --admin`", both(r"\bgh\s+pr\s+merge\b.*\s--admin\b"),
     "it skips the required checks. Fix what blocks the merge."),
    ("`<rev>:.<path>` in Git Bash", lambda text, shell: shell == "bash" and REV_DOT_PATH.search(text),
     "Git Bash rewrites it, so the file looks missing. Write `<rev>:./<path>`."),
]


def deny(name, why):
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": f"BLOCKED (tool rule): {name}: {why}",
    }}))
    sys.exit(0)


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        text = data["tool_input"]["command"]
    except Exception:
        sys.exit(0)
    if not isinstance(text, str):
        sys.exit(0)
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    for name, test, why in RULES:
        if test(text, shell):
            deny(name, why)
    sys.exit(0)


if __name__ == "__main__":
    main()
