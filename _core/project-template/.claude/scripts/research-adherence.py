"""Count this session's code-research calls: {{TOOLS_CODE_RESEARCH_NAME}} versus plain text search.

Reads the newest transcript for the current directory under
~/.claude/projects/, or the transcript given as the first argument.
Run from the repo root at session close.

A plain search counts only when it looks for code inside the repo: a Grep
or Glob call, or a shell command that starts with a recursive search (grep
-r, rg, git grep, or a recursive listing piped into Select-String). Each
search is judged by what it reads: its file filters (globs, types,
-Include) when it has any, otherwise the files and folders it names, and a
folder by the files git tracks in it. A search that reads only docs, logs
or data files, a filter on another command's output (`... | grep x`), and
a search of folders outside the repo (a scratchpad, a package cache),
which the code-research tool has no index for, are not counted. When a
word cannot be read for sure, the search stays counted, the side that
never flatters the figure.
"""
import glob
import json
import os
import re
import shlex
import subprocess
import sys

TOOL = re.compile(r"{{TOOLS_CODE_RESEARCH_MATCH}}")
BYPASS = "{{TOOLS_CODE_RESEARCH_BYPASS_MARKER}}"
NON_CODE_EXTENSIONS = {"md", "mdx", "txt", "log", "json", "jsonl", "yaml", "yml", "csv"}
# ripgrep's and grep's file types for the same files.
NON_CODE_TYPES = {"md", "markdown", "txt", "json", "jsonl", "yaml", "csv", "log"}
SHELL_SEARCH = re.compile(r"^\s*(rg|ag|ack|git\s+grep)\s|^\s*grep\s(.*\s)?(-[a-zA-Z]*[rR]|--recursive)")
PS_LISTING = re.compile(r"^\s*(Get-ChildItem|gci|dir|ls)\s.*-Recurse", re.I)
PS_SEARCH = re.compile(r"^\s*(sls|Select-String)\s", re.I)
# Git Bash spells a Windows drive as /p/...; Python reads it as P:/...
GIT_BASH_DRIVE = re.compile(r"^/([a-zA-Z])/")
CD = re.compile(r"^\s*(cd|Set-Location|sl|pushd|popd)(?:\s+(.+?))?\s*$", re.I)
# Moves whose target the line cannot show: back (cd -, popd) or home (a bare cd).
RETURN_TARGETS = (None, "-")
REDIRECT = re.compile(r"^\d*[<>]")
# A redirect operator written apart from its target (`2> /dev/null`): the next word is the target.
BARE_REDIRECT = re.compile(r"^\d*(?:>>?|<)&?$")
WILDCARD = re.compile(r"[*?\[]")

# Options that take a value, from each tool's --help: the value is neither the pattern nor a path.
RG_SHORT = set("ABCEMTdefgjmrt")
RG_LONG = {
    "after-context", "before-context", "color", "colors", "context", "context-separator",
    "dfa-size-limit", "encoding", "engine", "field-context-separator", "field-match-separator",
    "file", "generate", "glob", "hostname-bin", "hyperlink-format", "iglob", "ignore-file",
    "max-columns", "max-count", "max-depth", "max-filesize", "path-separator", "pre", "pre-glob",
    "regex-size-limit", "regexp", "replace", "sort", "sortr", "threads", "type", "type-add",
    "type-clear", "type-not",
}
GREP_SHORT = set("ABCDdefm")
GREP_LONG = {
    "after-context", "before-context", "binary-files", "context", "devices", "directories",
    "exclude", "exclude-dir", "exclude-from", "file", "include", "label", "max-count",
    "max-depth", "regexp",
}
# ag and ack read -f and -D as switches, so they share only the options all three spell alike.
AG_ACK_SHORT = set("ABCGgm")
AG_ACK_LONG = {"after-context", "before-context", "context", "file-search-regex", "ignore", "ignore-dir",
               "max-count", "type"}
# Which options name the pattern, and which narrow the files read.
PATTERN_OPTIONS = {"e", "f", "regexp", "file"}
GLOB_OPTIONS = {"g", "glob", "iglob", "include"}
TYPE_OPTIONS = {"t", "type"}
PS_VALUE_PARAMETERS = ("path", "literalpath", "include", "exclude", "filter", "depth", "attributes")
# Get-ChildItem's switches and the common parameters that take a value; an exact name wins over a prefix.
PS_SWITCHES = ("recurse", "file", "directory", "force", "name", "hidden", "readonly", "system",
               "followsymlink")
PS_COMMON_VALUES = ("erroraction", "ea", "errorvariable", "ev", "warningaction", "wa",
                    "informationaction", "infa", "outvariable", "ov", "outbuffer", "ob",
                    "pipelinevariable", "pv", "warningvariable", "wv", "informationvariable", "iv")


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


def unquote(word):
    return word.strip("'\"")


def resolve(path, base):
    """The absolute, case-folded form of a path as a shell in `base` reads it."""
    path = os.path.expanduser(unquote(path))
    if os.name == "nt":
        path = GIT_BASH_DRIVE.sub(lambda m: m.group(1) + ":/", path)
    return os.path.normcase(os.path.abspath(os.path.join(base, path)))


def is_outside(path, root):
    """True when `path` is neither the repo root nor anything under it."""
    try:
        return os.path.commonpath([path, root]) != root
    except ValueError:
        return True  # another drive


def is_wide(name):
    """True when a glob names no extension, so it narrows nothing by file kind (`*`, `docs/**`)."""
    return "." not in os.path.basename(unquote(name).rstrip("/\\"))


def is_code_name(name):
    """True when a file name or glob can match a code file, one whose extension is not a doc's."""
    name = unquote(name).rstrip("/\\")
    braces = re.search(r"\{([^}]*)\}$", name)
    endings = [name]
    if braces:
        endings = [name[:braces.start()] + part for part in braces.group(1).split(",")]
    for ending in endings:
        extension = ending.rsplit(".", 1)[-1].lower() if "." in os.path.basename(ending) else ""
        if extension not in NON_CODE_EXTENSIONS:
            return True
    return False


def tracked_files(root):
    """The tracked files, absolute and case-folded; every file there when git cannot list them."""
    try:
        command = ["git", "-C", root, "ls-files", "-z"]
        listed = subprocess.run(command, capture_output=True, check=True).stdout
        names = [n for n in listed.decode("utf-8", "replace").split("\0") if n]
    except (OSError, subprocess.CalledProcessError):
        names = []
        for folder, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d != ".git"]
            names += [os.path.relpath(os.path.join(folder, f), root) for f in files]
    return [os.path.normcase(os.path.abspath(os.path.join(root, n))) for n in names]


class Repo:
    """The repo a search is judged against: its root and, read once when needed, its code files."""

    def __init__(self, root):
        self.root = root
        self._code_files = None

    def code_files(self):
        if self._code_files is None:
            self._code_files = [f for f in tracked_files(self.root) if is_code_name(f)]
        return self._code_files

    def holds_code(self, path):
        """True when an in-repo file or folder is code, or cannot be told apart from code."""
        if WILDCARD.search(os.path.basename(path)):
            return is_code_name(path)
        if os.path.isdir(path):
            prefix = path.rstrip("\\/") + os.sep
            return path == self.root or any(f.startswith(prefix) for f in self.code_files())
        return not os.path.exists(path) or is_code_name(path)


class Search:
    """What one search reads: the paths it names, and the globs and types that narrow its files."""

    def __init__(self, paths=(), globs=(), types=()):
        self.paths = list(paths)
        # A negated glob (`!*.md`) leaves files out; it never says what the search reads.
        globs = [g for g in map(unquote, globs) if g]
        self.globs = [g for g in globs if not g.startswith("!") and not is_wide(g)]
        self.types = [unquote(t).lower() for t in types]

    def reads_code(self, base, repo):
        """True when the search reads code inside the repo, with paths read from `base`."""
        paths = [resolve(p, base) for p in self.paths] or [base]
        inside = [p for p in paths if not is_outside(p, repo.root)]
        if not inside:
            return False
        if self.globs or self.types:
            return (any(is_code_name(g) for g in self.globs)
                    or any(t not in NON_CODE_TYPES for t in self.types))
        return any(repo.holds_code(p) for p in inside)


def split_words(head):
    """The words of one command, with quotes kept; redirects and their targets dropped."""
    # Not POSIX mode, which reads a backslash as an escape and would turn D:\scratch into
    # D:scratch; quotes stay on the words, and resolve() strips them.
    try:
        words = shlex.split(head, posix=False)
    except ValueError:
        words = head.split()
    kept, skip_next = [], False
    for word in words:
        if skip_next:
            skip_next = False
        elif BARE_REDIRECT.match(word):
            skip_next = True
        elif not REDIRECT.match(word):
            kept.append(word)
    return kept


def option_value(word, words, short, long):
    """The (name, value) of the option in `word`; a separate value is taken from `words`."""
    if word.startswith("--"):
        name, joined, value = word[2:].partition("=")
        if joined or name not in long:
            return name, value if joined else None
        return name, words.pop(0) if words else ""
    name = word[1:2]
    for i, flag in enumerate(word[1:]):
        if flag in short:
            rest = word[i + 2:]
            return flag, rest if rest else (words.pop(0) if words else "")
    return name, None


def text_search(words):
    """What grep, rg, ag, ack or git grep reads, from the words after the command name."""
    tables = {"rg": (RG_SHORT, RG_LONG), "ag": (AG_ACK_SHORT, AG_ACK_LONG), "ack": (AG_ACK_SHORT, AG_ACK_LONG)}
    short, long = tables.get(words[0], (GREP_SHORT, GREP_LONG))
    if words[:2] == ["git", "grep"]:
        words = words[1:]
    rest, positional, globs, types, has_pattern = words[1:], [], [], [], False
    while rest:
        word = rest.pop(0)
        if word == "--":
            positional += rest
            break
        if not word.startswith("-") or word == "-":
            positional.append(word)
            continue
        name, value = option_value(word, rest, short, long)
        has_pattern |= name in PATTERN_OPTIONS
        if value is not None and name in GLOB_OPTIONS:
            globs.append(value)
        elif value is not None and name in TYPE_OPTIONS:
            types.append(value)
    paths = positional if has_pattern else positional[1:]
    return Search(paths, globs, types)


def listing_search(words):
    """What a recursive Get-ChildItem reads: -Path or the first word, narrowed by -Include."""
    rest, values, positional = words[1:], {}, []
    while rest:
        word = rest.pop(0)
        if not word.startswith("-"):
            positional.append(word)
            continue
        name, joined, value = word[1:].lower().partition(":")
        parameter = ps_parameter(name)
        given = value if joined or parameter is None else (rest.pop(0) if rest else "")
        if parameter:
            values.setdefault(parameter, []).append(given)

    def listed(key):
        return [v for item in values.get(key, []) for v in item.split(",") if v]

    named = listed("path") + listed("literalpath")
    globs = listed("include") + listed("filter")
    # The first word is the path only when no -Path names one; the second is the filter.
    return Search(named or positional[:1], globs + (positional[1:2] if not named else positional[:1]))


def ps_parameter(name):
    """The value-taking parameter `name` spells, "" for one this count ignores, or None for a switch."""
    if not name or name in PS_SWITCHES:
        return None
    if name in PS_VALUE_PARAMETERS:
        return name
    if name in PS_COMMON_VALUES:
        return ""
    if any(p.startswith(name) for p in PS_SWITCHES):
        return None
    match = [p for p in PS_VALUE_PARAMETERS if p.startswith(name)]
    return match[0] if len(match) == 1 else None


def shell_search(command, repo):
    """True when a command line runs a code search of its own inside the repo."""
    base = repo.root
    for part in re.split(r"&&|\|\||;|\n", unquote_separators(command)):
        stages = part.split("|")
        head = stages[0]
        moved = CD.match(head)
        if moved:
            # The repo root is the folder such a move most likely returns to, and reading it so
            # keeps the search counted, the side that never flatters the figure.
            words = split_words(moved.group(2) or "")
            target = words[0] if words else None
            back = moved.group(1).lower() == "popd" or target in RETURN_TARGETS
            base = repo.root if back else resolve(" ".join(words), base)
            continue
        if SHELL_SEARCH.search(head):
            search = text_search(split_words(head))
        elif PS_LISTING.search(head) and any(PS_SEARCH.search(s) for s in stages[1:]):
            search = listing_search(split_words(head))
        else:
            continue
        if search.reads_code(base, repo):
            return True
    return False


def tool_search(name, args):
    """What a Grep or Glob call reads."""
    path = str(args.get("path") or "")
    if name == "Grep":
        types = [args["type"]] if args.get("type") else []
        return Search([path] if path else [], [str(args.get("glob") or "")], types)
    pattern = str(args.get("pattern") or "")
    # A pattern can carry its own folder: an absolute one, or a relative one under the path.
    static = re.split(r"[*?\[{]", pattern, maxsplit=1)[0]
    folder = os.path.dirname(static) if os.path.dirname(static) else ""
    paths = [os.path.join(path, folder)] if folder else [path] if path else []
    return Search(paths, [pattern])


def classify(name, args, root=None):
    """'research', 'fallback', 'bypass', or None for a call that is not a code search.

    `root` is the repo root as `repo_root()` gives it; by default, the folder this runs from."""
    repo = root if isinstance(root, Repo) else Repo(root or repo_root())
    if TOOL.search(name):
        return "research"
    if name in ("Grep", "Glob"):
        return "fallback" if tool_search(name, args).reads_code(repo.root, repo) else None
    if name in ("Bash", "PowerShell"):
        command = args.get("command", "")
        if shell_search(command, repo):
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
    repo = Repo(repo_root())
    for name, args in tool_calls(transcript()):
        kind = classify(name, args, repo)
        if kind:
            counts[kind] += 1
    total = counts["research"] + counts["fallback"]
    ratio = f"{100 * counts['research'] // total}%" if total else "n/a"
    print(f"{{TOOLS_CODE_RESEARCH_NAME}}: {counts['research']} calls, plain code searches: {counts['fallback']} "
          f"(plus {counts['bypass']} marked bypasses) -> {ratio}")


if __name__ == "__main__":
    main()
