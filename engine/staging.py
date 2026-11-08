# Python twin of staging.js: removes setup's staging folders once setup or
# update has used them, .bindwright/incoming/ and .bindwright/global/.

import os
import shutil
import stat

from apply import _code_units, _is_link

# The staging folders, relative to the repo root, in the order they are removed.
STAGING_FOLDERS = [".bindwright/incoming", ".bindwright/global"]


def _entry_at(path):
    """The lstat of `path`, or None when nothing is there."""
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _check_folder(path, relative):
    """False when `path` is missing, True for a real folder; raises for a link or a file.

    A link could point anywhere, such as the home folder, so it is never followed or removed.
    """
    entry = _entry_at(path)
    if entry is None:
        return False
    if _is_link(entry):
        raise ValueError(f"{relative} is a link; remove it by hand")
    if not stat.S_ISDIR(entry.st_mode):
        raise ValueError(f"{relative} is not a folder; remove it by hand")
    return True


def _files_under(path, prefix=""):
    """The files under `path`, relative to it with "/" between parts, sorted as JS sorts.

    Links inside are listed as files, never followed.
    """
    found = []
    for name in os.listdir(path):
        entry = os.lstat(os.path.join(path, name))
        if stat.S_ISDIR(entry.st_mode) and not _is_link(entry):
            found += _files_under(os.path.join(path, name), prefix + name + "/")
        else:
            found.append(prefix + name)
    return sorted(found, key=_code_units)


def clean_staging(folder, discard_incoming=False):
    """Removes the staging folders of the repo at `folder`; returns {"removed", "unsettled"}.

    .bindwright/global/ always goes; .bindwright/incoming/ goes only when no file waits in
    it, or with `discard_incoming`, so a merge the user has not settled is never lost.
    `unsettled` lists the files kept waiting there. A missing folder is skipped; a link or
    a file where a folder should be stops the run before anything is removed. A .bindwright
    folder left empty, as setup's global path leaves one outside a repo, goes too.
    """
    # The repo root itself may be a link to the real folder; only the entries inside are guarded.
    if not os.path.isdir(folder):
        raise ValueError(f"{folder} is not a folder")
    own = os.path.join(folder, ".bindwright")
    if not _check_folder(own, ".bindwright"):
        return {"removed": [], "unsettled": []}
    present = [r for r in STAGING_FOLDERS if _check_folder(os.path.join(folder, r), r)]
    incoming = STAGING_FOLDERS[0]
    keep_waiting = incoming in present and not discard_incoming
    unsettled = _files_under(os.path.join(folder, incoming)) if keep_waiting else []
    removed = [r for r in present if r != incoming or not unsettled]
    for relative in removed:
        shutil.rmtree(os.path.join(folder, relative))
    if os.listdir(own):
        return {"removed": removed, "unsettled": unsettled}
    os.rmdir(own)
    return {"removed": removed + [".bindwright"], "unsettled": unsettled}
