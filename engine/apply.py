# Python twin of apply.js. Writes a bind's files into a repo, never over an
# existing file. When the repo already has a file, the new text goes to
# STAGING under the same path instead, for setup to merge. A file whose staged
# copy exists too, or one in .bindwright/ (setup's own working files), is
# skipped. Standard library only.

import os
import re
import stat

# The folder bind.py stages merge targets in; a test keeps the two in step.
STAGING = ".bindwright/incoming/"

# Relative paths of plain segments only: no drive, root, backslash, "." or "..".
_SEGMENT = re.compile(r"[^/\\:\x00-\x1f]+")

# IO_REPARSE_TAG_MOUNT_POINT, the tag of a Windows junction.
_JUNCTION_TAG = 0xA0000003


class ApplyError(ValueError):
    pass


def _safe(path):
    parts = path.split("/")
    return all(_SEGMENT.fullmatch(p) is not None and p not in (".", "..") for p in parts)


def _code_units(s):
    # JavaScript compares strings by UTF-16 code unit, which big-endian bytes order alike.
    return s.encode("utf-16-be", "surrogatepass")


def _is_link(info):
    """A symbolic link, or a Windows junction, which os.path.islink does not report."""
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) == _JUNCTION_TAG


def linked_path(root, path):
    """The first symbolic link on the way to `path`, from the repo root down, as a
    repo-relative path with forward slashes; None when there is none. A part that
    does not exist ends the walk, since nothing below it can exist either."""
    parts = path.split("/")
    for depth in range(1, len(parts) + 1):
        try:
            info = os.lstat(os.path.join(root, *parts[:depth]))
        except (FileNotFoundError, NotADirectoryError):
            return None
        if _is_link(info):
            return "/".join(parts[:depth])
    return None


def refuse_links(root, paths):
    """Raises ApplyError when any of `paths`, or a part of one, is a symbolic link.
    Each linked part is named once, sorted by UTF-16 code unit as the JS engine sorts."""
    linked = {link for link in (linked_path(root, path) for path in paths) if link is not None}
    if linked:
        names = sorted(linked, key=_code_units)
        raise ApplyError("Refusing to write through a symbolic link: " + ", ".join(names))


def _write(target, text):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "x", encoding="utf-8", newline="") as fh:
        fh.write(text)


def apply_files(files, root, adopt=False):
    """files: [[path, text], ...]. Returns {"written", "staged", "skipped"}, each a
    list of the given paths; a staged file sits at STAGING + path. With
    `adopt` (a repo that has its own setup), every file outside .bindwright/
    is staged, new or not, so setup can offer each one before it lands."""
    bad = [path for path, _ in files if not _safe(path)]
    if bad:
        raise ApplyError("Refusing to write outside the repo: " + ", ".join(bad))
    refuse_links(root, [p for path, _ in files for p in (path, STAGING + path)])
    result = {"written": [], "staged": [], "skipped": []}

    def at(path):
        return os.path.join(root, *path.split("/"))

    for path, text in files:
        own = path.startswith(".bindwright/")
        if (own or not adopt) and not os.path.lexists(at(path)):
            _write(at(path), text)
            result["written"].append(path)
        elif not own and not os.path.lexists(at(STAGING + path)):
            _write(at(STAGING + path), text)
            result["staged"].append(path)
        else:
            result["skipped"].append(path)
    return result
