# Python twin of remove.js: /bindwright:remove's engine steps. It sorts what setup wrote
# into a repo by what removing it takes, and removes the files the user agreed to.
# bind.py's --remove-plan and --remove-files commands call it.

import json
import os
import shutil
import stat

from apply import _code_units, _is_link, _safe, refuse_links
from bind import MERGE_TARGETS, PRISTINE
from keep import OWNED, is_owned, owned_patterns
from update import _reader

# Setup's own folder, removed last.
STATE_FOLDER = ".bindwright"


def _pristine_files(read):
    saved = read(PRISTINE)
    if saved is None:
        raise ValueError(
            "%s is missing: this repo was not set up with /bindwright:setup" % PRISTINE)
    files = json.loads(saved)["files"]
    bad = [path for path in files if not _safe(path)]
    if bad:
        raise ValueError("Refusing paths outside the repo in %s: %s" % (PRISTINE, ", ".join(bad)))
    return files


def _sort_one(path, rendered, ours, owned):
    # A merge target the repo kept unchanged is setup's whole file.
    if is_owned(path, owned):
        return "owned"
    if ours is None:
        return "missing"
    if ours == rendered.replace("\r\n", "\n"):
        return "delete"
    return "merged" if path in MERGE_TARGETS else "edited"


def plan_removal(root):
    """Sorts every file setup wrote into the repo at `root`, read-only. Returns a dict of
    sorted repo-path lists: `delete` still matches what setup wrote (line endings aside),
    `edited` was changed since, `merged` is a shared file such as CLAUDE.md whose setup parts
    come out by hand, `missing` is gone already, and `owned` is listed in .bindwright/owned
    and stays."""
    read = _reader(root)
    files = _pristine_files(read)
    owned = owned_patterns(read(OWNED) or "")
    plan = {"delete": [], "edited": [], "merged": [], "missing": [], "owned": []}
    for path in sorted(files, key=_code_units):
        plan[_sort_one(path, files[path], read(path), owned)].append(path)
    return plan


def _at(root, path):
    return os.path.join(root, *path.split("/"))


def _lstat(target):
    """The lstat of `target`, a link reported as itself; None when nothing is there."""
    try:
        return os.lstat(target)
    except FileNotFoundError:
        return None


def _is_empty_folder(target):
    info = _lstat(target)
    if info is None or _is_link(info) or not stat.S_ISDIR(info.st_mode):
        return False
    return not os.listdir(target)


# Removes the folders above `path` that the removal left empty, up to the repo root.
def _prune_above(root, path, pruned):
    parts = path.split("/")[:-1]
    for depth in range(len(parts), 0, -1):
        target = os.path.join(root, *parts[:depth])
        if not _is_empty_folder(target):
            return
        os.rmdir(target)
        pruned.add("/".join(parts[:depth]))


def _remove_state(root):
    target = _at(root, STATE_FOLDER)
    info = _lstat(target)
    if info is None:
        return
    if stat.S_ISDIR(info.st_mode):
        shutil.rmtree(target)
    else:
        os.unlink(target)


def _is_plain_file(target):
    info = _lstat(target)
    return stat.S_ISREG(info.st_mode) and not _is_link(info)


def remove_files(root, paths, state):
    """Removes `paths` from the repo at `root`, each one a file setup wrote (listed in its
    pristine.json), then the folders that left empty, then, when `state` is true, the
    .bindwright folder. Every path is checked before the first removal: a path setup did not
    write, one reached through a link, or one that is not a plain file stops the run. A path
    already gone is skipped. Returns { removed, folders, state }."""
    # A path named twice is removed once, so the second unlink cannot fail after the first.
    paths = list(dict.fromkeys(paths))
    files = _pristine_files(_reader(root))
    unknown = [path for path in paths if path not in files]
    if unknown:
        raise ValueError("Not a file setup wrote: " + ", ".join(unknown))
    refuse_links(root, paths + ([STATE_FOLDER] if state else []))
    present = [path for path in paths if _lstat(_at(root, path)) is not None]
    not_files = [path for path in present if not _is_plain_file(_at(root, path))]
    if not_files:
        raise ValueError("Not a plain file: " + ", ".join(not_files))
    for path in present:
        os.unlink(_at(root, path))
    pruned = set()
    for path in present:
        _prune_above(root, path, pruned)
    if state:
        _remove_state(root)
    return {"removed": present, "folders": sorted(pruned, key=_code_units), "state": bool(state)}
