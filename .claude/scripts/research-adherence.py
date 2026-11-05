"""Count this session's code-research calls: tokensave versus plain text search.

Reads the newest transcript for the current directory under
~/.claude/projects/, or the transcript given as the first argument.
Run from the repo root at session close.

A plain search counts only when it looks for code: a Grep or Glob call,
or a shell command that starts with a recursive search (grep -r, rg,
git grep, or a recursive listing piped into Select-String). Searches of
docs, logs or data files, filters on another command's output
(`... | grep x`), and searches of folders outside the repo (a scratchpad,
a downloaded copy), which the code-research tool has no index for, are
not code research and are not counted.
"""
import glob
import json
import os
import re
import shlex
import sys

TOOL = re.compile(r"tokensave")
BYPASS = "TOKENSAVE_BYPASS:"
NON_CODE = re.compile(r"\.(md|mdx|txt|log|json|jsonl|ya?ml|csv)\b|\b(md|json|yaml|txt)$", re.I)
SHELL_SEARCH = re.compile(r"^\s*(rg|ag|ack|git\s+grep)\s|^\s*grep\s(.*\s)?(-[a-zA-Z]*[rR]|--recursive)")
PS_LISTING = re.compile(r"^\s*(Get-ChildItem|gci|dir|ls)\s.*-Recurse", re.I)
PS_SEARCH = re.compile(r"^\s*(sls|Select-String)\s", re.I)
# Git Bash spells a Windows drive as /p/...; Python reads it as P:/...
GIT_BASH_DRIVE = re.compile(r"^/([a-zA-Z])/")
CD = re.compile(r"^\s*(cd|Set-Location|sl|pushd)\s+(.+?)\s*$", re.I)


def unquote_separators(command):
    """Blank out | ; & and newlines inside quotes, so a search pattern like "a|b" does not split the command."""
    out, quote = [], None
    for ch in command:
        if quote:
            quote = None if ch == quote else quote
            ch = " " if ch in "|;&\n" else ch
        elif ch in "'\"":
            quote = ch
        out.append(ch)
    return "".join(out)


def resolve(path, base):
    """The absolute, case-folded form of a path as a shell in `base` reads it."""
    path = os.path.expanduser(path.strip("'\""))
    if os.name == "nt":
        path = GIT_BASH_DRIVE.sub(lambda m: m.group(1) + ":/", path)
    return os.path.normcase(os.path.abspath(os.path.join(base, path)))


def is_outside(path, root):
    """True when `path` is neither the repo root nor anything under it."""
    try:
        return os.path.commonpath([path, root]) != root
    except ValueError:
        return True  # another drive


def path_arguments(head):
    """The words of a search command that name a file or folder."""
    try:
        words = shlex.split(head, posix=True)
    except ValueError:
        words = head.split()
    if words[:2] == ["git", "grep"]:
        words = words[1:]
    positional = [w for w in words[1:] if not w.startswith("-")]
    # grep, rg, ag and ack take the pattern first; a pattern is not a path, even with a slash.
    if words and not PS_LISTING.search(head):
        positional = positional[1:]
    return [w for w in positional if re.search(r"[/\\~]", w)]


def searches_outside(head, base, root):
    """True when every path the search names, read from `base`, lies outside the repo."""
    paths = path_arguments(head)
    if not paths:
        return is_outside(base, root)
    return all(is_outside(resolve(p, base), root) for p in paths)


def shell_search(command, root):
    """True when a command line runs a code search of its own inside the repo at `root`."""
    base = root
    for part in re.split(r"&&|\|\||;|\n", unquote_separators(command)):
        stages = part.split("|")
        head = stages[0]
        moved = CD.match(head)
        if moved:
            base = resolve(moved.group(2), base)
            continue
        if NON_CODE.search(head):
            continue
        is_search = SHELL_SEARCH.search(head) or (
            PS_LISTING.search(head) and any(PS_SEARCH.search(s) for s in stages[1:]))
        if is_search and not searches_outside(head, base, root):
            return True
    return False


def classify(name, args, root=None):
    """'research', 'fallback', 'bypass', or None for a call that is not a search.

    `root` is the repo root as `repo_root()` gives it; by default, the folder this runs from."""
    root = root or repo_root()
    if TOOL.search(name):
        return "research"
    if name in ("Grep", "Glob"):
        if args.get("path") and is_outside(resolve(str(args["path"]), root), root):
            return None
        # Grep's pattern is the search text, Glob's is the file pattern.
        keys = ("pattern", "path") if name == "Glob" else ("path", "glob", "type")
        target = " ".join(str(args.get(k, "")) for k in keys)
        return None if NON_CODE.search(target) else "fallback"
    if name in ("Bash", "PowerShell"):
        command = args.get("command", "")
        if shell_search(command, root):
            return "bypass" if BYPASS in command else "fallback"
    return None


def transcript():
    if len(sys.argv) > 1:
        return sys.argv[1]
    slug = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
    files = glob.glob(os.path.join(os.path.expanduser("~"), ".claude", "projects", slug, "*.jsonl"))
    if not files:
        sys.exit(f"No transcript found for {os.getcwd()}; run this from the repo root.")
    return max(files, key=os.path.getmtime)


def tool_calls(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            content = (entry.get("message") or {}).get("content")
            if entry.get("type") != "assistant" or not isinstance(content, list):
                continue
            for part in content:
                if isinstance(part, dict) and part.get("type") == "tool_use":
                    yield part.get("name", ""), part.get("input") or {}


def repo_root():
    """The folder this runs from, the repo root, in the form `classify` compares."""
    return os.path.normcase(os.path.abspath(os.getcwd()))


def main():
    counts = {"research": 0, "fallback": 0, "bypass": 0}
    root = repo_root()
    for name, args in tool_calls(transcript()):
        kind = classify(name, args, root)
        if kind:
            counts[kind] += 1
    total = counts["research"] + counts["fallback"]
    ratio = f"{100 * counts['research'] // total}%" if total else "n/a"
    print(f"tokensave: {counts['research']} calls, plain code searches: {counts['fallback']} "
          f"(plus {counts['bypass']} marked bypasses) -> {ratio}")


if __name__ == "__main__":
    main()
