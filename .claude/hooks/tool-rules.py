#!/usr/bin/env python3
"""PreToolUse guard: refuse the shell patterns a session was told to stop using.

Each rule in RULES names a pattern that keeps failing, why, and what to use
instead. A correction of the kind "never use X, use Y" lands here as a new rule,
so the session cannot drift back to X: a note in memory alone does not hold.

Rules other than the inline-script one read the command with quoted strings
and PowerShell here-string bodies taken out, and a bash command only as far as
its first here-document, so a commit message or a PR body that only mentions a
pattern passes. The inline-script rule reads only a bash command's first
here-document, and only when its `<<` stands outside quotes. Where the reading
is unsure (a quote that never closes, a `<<` inside `"$(...)"`), the text is
left unread: a missed pattern costs less than a refused command. It is
a safety net for the ordinary spelling, not a sandbox against a command built
to slip past it.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent exit 0
otherwise, and for any input it cannot read.
"""
import json
import os
import re
import sys

INTERPRETER = r"(?:python3?|py|node|deno|bun|perl|ruby|php|bash|sh|zsh|pwsh|powershell)(?:\.exe)?"
INTERPRETER_WORD = re.compile(r"(?:^|[\s;&|(])" + INTERPRETER + r"(?=[\s;&|)]|$)", re.I)
# A here-document opener, its word quoted (`<<'EOF'`, `<<"EOF"`), escaped (`<<\EOF`) or bare.
HEREDOC = re.compile(r"<<(-?)[ \t]*\\?(['\"]?)([A-Za-z_][\w-]*)\2")
# A `<<` that is not part of a here-string (`<<<`), and arithmetic, where a `<<` opens nothing.
HEREDOC_OPERATOR = re.compile(r"(?<!<)<<(?!<)")
NOT_AN_OPENER = re.compile(r"\$?\(\([^)]*\)\)")
HERE_STRING = re.compile(r"@(['\"])\r?\n(.*?)\r?\n\1@([^\n]*)", re.S)
# The separators between the commands of one line, a lone `&` (run in the background) among them
# but not a redirection (`2>&1`, `&>f`) or `|&`; a pipe joins two parts of one command.
LIST_SEPARATOR = re.compile(r"&&|\|\||;|(?<![>&|])&(?![>&])")
# `python -c '...'`, `node -e "..."`: the script text, as far as its closing quote.
INLINE = re.compile(r"(?:^|[\s;&|(])(?:python3?|py)(?:\.exe)?(?:[ \t]+-\w+)*[ \t]+-c[ \t]+(['\"])(.*?)\1"
                    r"|(?:^|[\s;&|(])node(?:\.exe)?(?:[ \t]+-\S+)*?[ \t]+(?:-e|-p|--eval|--print)[ \t]+(['\"])(.*?)\3",
                    re.I | re.S)
# `origin/develop:.claude/x`: a git object path that starts with a dot.
REV_DOT_PATH = re.compile(r"\bgit\s+(?:show|cat-file|ls-tree|diff)\b[^\n|;&]*?\s[\w./@~^-]+:\.[^/\s.]", re.I)
# Comments, quoted strings and escapes as each shell reads them, in one pass across lines, so
# whichever starts first wins: a `#` that starts a word outside quotes comments out the rest of
# its line, and a quote character in a comment opens nothing. Bash escapes with a backslash,
# PowerShell with a backtick and by doubling the quote, and a PowerShell backslash is plain text
# (`"C:\"`). A PowerShell block comment runs from `<#` to the first `#>`. A quote or block
# comment that never closes runs to the end of the command.
COMMENT = r"(?:^|(?<=[\s;&|(]))#[^\n]*"
QUOTED = {"bash": re.compile(COMMENT + r"|\\.|'[^']*(?:'|\Z)|\"(?:[^\"\\]|\\.)*(?:\"|\Z)", re.S),
          "powershell": re.compile(r"<#.*?(?:#>|\Z)|" + COMMENT
                                   + r"|`.|'(?:[^']|'')*(?:'|\Z)|\"(?:[^\"`]|`.|\"\")*(?:\"|\Z)", re.S)}
# Git Bash's path conversion is what mangles a dot-led rev path; other shells pass it as written.
GIT_BASH = os.name == "nt"

WRITE_THE_FILE = "its backslashes get eaten. Write the script with the Write tool, then run the file."


def blanked(match):
    """The matched text as spaces, line ends kept, so the positions around it stay put."""
    return re.sub(r"[^\n]", " ", match.group())


def first_opener(text):
    """(line number, match) of the first line that may open a here-document, quoted or not, or
    None: a `<<` that is not part of a here-string (`<<<`) followed by a word."""
    for number, line in enumerate(text.split("\n")):
        for operator in HEREDOC_OPERATOR.finditer(line):
            match = HEREDOC.match(line, operator.start())
            if match:
                return number, match
    return None


def heredoc(text):
    """(command, body) of a bash command's first here-document, or None when it has none or its
    `<<` stands inside quotes, a comment or arithmetic, where the reading is unsure
    (`"$(cat <<'EOF'`). The command is the part of its line between the separators around the
    `<<`, pipes included, with quoted strings blanked."""
    first = first_opener(text)
    if not first:
        return None
    number, match = first
    masked = NOT_AN_OPENER.sub(blanked, QUOTED["bash"].sub(blanked, text)).split("\n")[number]
    if not HEREDOC_OPERATOR.match(masked, match.start()):
        return None
    command = (LIST_SEPARATOR.split(masked[:match.start()])[-1]
               + LIST_SEPARATOR.split(masked[match.end():])[0])
    body = []
    for line in text.split("\n")[number + 1:]:
        if ends_heredoc(line, match):
            break
        body.append(line)
    return command, "\n".join(body)


def ends_heredoc(line, match):
    """Whether a line is the terminator of the here-document `match` opened."""
    line = line.rstrip("\r")
    return (line.lstrip("\t") if match.group(1) else line) == match.group(3)


def inline_script(text, shell):
    """Whether an interpreter is handed a script holding a backslash."""
    found = heredoc(text) if shell == "bash" else None
    if found and INTERPRETER_WORD.search(found[0]) and "\\" in found[1]:
        return True
    if shell == "powershell" and any("\\" in m.group(2) and INTERPRETER_WORD.search(m.group(3))
                                     for m in HERE_STRING.finditer(text)):
        return True
    return any("\\" in (m.group(2) or m.group(4) or "") for m in INLINE.finditer(text))


def bare(text, shell):
    """The command with quoted strings taken out, and PowerShell here-string bodies; a bash
    command only up to the end of the first line that may open a here-document, quoted or not
    (`"$(cat <<'EOF'`), since reading too little only misses a pattern."""
    if shell == "powershell":
        text = HERE_STRING.sub(r"''\3", text)
    else:
        first = first_opener(text)
        if first:
            text = "\n".join(text.split("\n")[:first[0] + 1])
    return QUOTED[shell].sub("''", text)


def both(*patterns):
    """A test that holds when every pattern is found in the bare command."""
    compiled = [re.compile(p, re.I) for p in patterns]
    return lambda text, shell: all(p.search(bare(text, shell)) for p in compiled)


RULES = [
    ("an inline script holding a backslash", inline_script, WRITE_THE_FILE),
    ("`gh run watch`", both(r"\bgh\s+run\s+watch\b"),
     "it blocks the session. ci-watch (or a bounded watcher, token-efficiency.md) watches checks."),
    ("the size check chained with a commit or push",
     both(r"\b(?:python3?|py)(?:\.exe)?\s+(?:-\S+\s+)*\S*size_check\.py", r"\bgit\s+(?:commit|push)\b"),
     "the commit runs past its breaches. Run size_check.py in its own call first."),
    ("`git push` and `gh pr create` in one command", both(r"\bgit\s+push\b", r"\bgh\s+pr\s+create\b"),
     "the chain gets refused. Push, then open the PR in a separate call."),
    ("`git checkout <rev> -- <path>`", both(r"\bgit\s+checkout\s+(?!-)\S+\s+--\s+\S"),
     "it overwrites and stages those files. Peek with `git show <rev>:./<path>`; restore with `git restore`."),
    ("`gh pr merge --admin`", both(r"\bgh\s+pr\s+merge\b.*\s--admin\b"),
     "it skips the required checks. Fix what blocks the merge."),
    ("`<rev>:.<path>` in Git Bash",
     lambda text, shell: GIT_BASH and shell == "bash" and REV_DOT_PATH.search(bare(text, shell)),
     "Git Bash rewrites it, so the file looks missing. Write `<rev>:./<path>` from the repo root."),
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
