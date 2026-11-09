# Python twin of exclude.js: keeps the assistant's files out of a clone's git by listing them
# in its .git/info/exclude (never .gitignore), and removes that block again on --undo.

import os
import subprocess

from apply import _code_units

# What is kept out, as repo paths: (path, always) for each folder. The always folders are
# listed on every run; the others only when the plan writes a path under them.
LOCAL_FOLDERS = [
    (".claude/", True),
    (".bindwright/", True),
    ("docs/lazy/", False),
    (".github/size-check/", False),
]
# Files, listed only when the plan writes them.
LOCAL_FILES = [
    "CLAUDE.md", "ROADMAP.md", "docs/comment-audit.md", "docs/docs-audit.md", "docs/test-audit.md",
    "docs/security-posture.md", ".github/scripts/size_check.py", ".github/workflows/size-check.yml",
]

BEGIN = "# Bindwright: the assistant's files, kept on this computer"
# The exclude file is read and written as latin-1, one character per byte, so the user's lines
# come back byte for byte in any encoding; every line the engine writes is ASCII.
EXCLUDE_ENCODING = "latin-1"
# The first line of a block appended to a file whose last line had no line break: the break
# written before the block belongs to it, and leaves with it.
BEGIN_AFTER_BREAK = f"{BEGIN}, after the line break it added"
END = "# End of Bindwright's lines"
INCOMING = ".bindwright/incoming/"
GLOBAL = ".bindwright/global/"


def planned_paths(dests):
    """The repo paths the plan writes.

    A merge target staged under .bindwright/incoming/ is its own path; the ~/.claude files
    under .bindwright/global/ land outside the repo and are dropped.
    """
    kept = [d for d in dests if not d.startswith(GLOBAL)]
    return list(dict.fromkeys(d[len(INCOMING):] if d.startswith(INCOMING) else d for d in kept))


def exclude_lines(paths):
    """The exclude lines for the planned repo paths: folders, then files, each anchored with "/"."""
    folders = ["/" + path for path, always in LOCAL_FOLDERS
               if always or any(p.startswith(path) for p in paths)]
    files = ["/" + name for name in LOCAL_FILES if name in paths]
    return folders + files


def _covers(line, path):
    """True when an exclude line hides `path`: a folder line hides everything under it."""
    target = line[1:]
    return path.startswith(target) if line.endswith("/") else path == target


def _block_text(lines, begin=BEGIN):
    """The block's lines, marker lines included, each ending in LF."""
    return "".join(line + "\n" for line in [begin, *lines, END])


def _block_span(text, file):
    """The block's (start, end, is_after_break) offsets in `text`, the line break it added included.

    None when there is none. A block with no end line is refused: removing it could take the
    user's own lines with it.
    """
    start = -1
    is_after_break = False
    offset = 0
    for raw in text.split("\n"):
        nxt = offset + len(raw) + 1
        line = raw[:-1] if raw.endswith("\r") else raw
        if start == -1 and line in (BEGIN, BEGIN_AFTER_BREAK):
            is_after_break = line == BEGIN_AFTER_BREAK and offset > 0
            start = offset - 1 if is_after_break else offset
        if start != -1 and line == END:
            return start, min(nxt, len(text)), is_after_break
        offset = nxt
    if start == -1:
        return None
    raise ValueError(f"{file} has a Bindwright block with no end line; remove it by hand")


def _with_block(text, lines, file):
    """`text` with the block of `lines` replaced in place, or appended when there is none.

    A file whose last line has no line break gets one before the block, marked so that removal
    takes it too.
    """
    span = _block_span(text, file)
    before = text if span is None else text[:span[0]]
    after = "" if span is None else text[span[1]:]
    needs_break = (before != "" and not before.endswith("\n")) if span is None else span[2]
    block = "\n" + _block_text(lines, BEGIN_AFTER_BREAK) if needs_break else _block_text(lines)
    return before + block + after


def _without_block(text, file):
    """`text` without its block, or None when there is none."""
    span = _block_span(text, file)
    return None if span is None else text[:span[0]] + text[span[1]:]


def _exclude_file(folder):
    """The clone's exclude file. Git prints it relative to the folder it ran in, or absolute."""
    try:
        done = subprocess.run(["git", "-C", folder, "rev-parse", "--git-path", "info/exclude"],
                              capture_output=True, check=True, encoding="utf-8")
    except (OSError, subprocess.CalledProcessError):
        raise ValueError(f"Not a git repository: {folder}")
    return os.path.abspath(os.path.join(folder, done.stdout.strip()))


def _read_exclude_file(file):
    """The text of the exclude file, or "" when it does not exist yet."""
    if not os.path.exists(file):
        return ""
    with open(file, encoding=EXCLUDE_ENCODING, newline="") as fh:
        return fh.read()


def _tracked_under(folder, lines):
    """The clone's tracked files that the lines cover, sorted. An exclude line cannot hide these."""
    pathspecs = [line[1:] for line in lines]
    done = subprocess.run(["git", "-C", folder, "ls-files", "-z", "--"] + pathspecs,
                          capture_output=True, check=True, encoding="utf-8")
    return sorted((path for path in done.stdout.split("\0") if path), key=_code_units)


def local_exclude(folder, dests):
    """Lists the files the bind would write (`dests`, the keys of its plan) in the clone's exclude file.

    Replaces an earlier Bindwright block. Returns {"exclude", "lines", "shared", "tracked"}:
    `shared` are the planned paths that no line covers, `tracked` the covered paths git already
    tracks.
    """
    file = _exclude_file(folder)
    paths = planned_paths(dests)
    lines = exclude_lines(paths)
    updated = _with_block(_read_exclude_file(file), lines, file)
    os.makedirs(os.path.dirname(file), exist_ok=True)
    with open(file, "w", encoding=EXCLUDE_ENCODING, newline="") as fh:
        fh.write(updated)
    return {
        "exclude": file.replace("\\", "/"),
        "lines": lines,
        "shared": sorted((p for p in paths if not any(_covers(line, p) for line in lines)), key=_code_units),
        "tracked": _tracked_under(folder, lines),
    }


def undo_local_exclude(folder):
    """Removes the Bindwright block from the clone's exclude file. Returns {"exclude", "removed"}."""
    file = _exclude_file(folder)
    rest = _without_block(_read_exclude_file(file), file)
    if rest is not None:
        with open(file, "w", encoding=EXCLUDE_ENCODING, newline="") as fh:
            fh.write(rest)
    return {"exclude": file.replace("\\", "/"), "removed": rest is not None}
