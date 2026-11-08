# Python twin of staging.js: removes setup's staging folders once setup or
# update has used them, .bindwright/incoming/ and .bindwright/global/.

import os
import shutil
import stat

# The staging folders, relative to the repo root, in the order they are removed.
STAGING_FOLDERS = [".bindwright/incoming", ".bindwright/global"]


def _entry_at(path):
    """The lstat of `path`, or None when nothing is there."""
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _is_link(entry):
    # A junction on Windows is a reparse point that os.path.islink misses before Python 3.12.
    reparse = getattr(entry, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISLNK(entry.st_mode) or bool(reparse)


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


def clean_staging(folder):
    """Removes the staging folders of the repo at `folder`; returns {"removed": [...]}.

    A folder that is missing is skipped. A link or a file where a folder should be
    stops the run before anything is removed.
    """
    repo = _entry_at(folder)
    if repo is None or not stat.S_ISDIR(repo.st_mode):
        raise ValueError(f"{folder} is not a folder")
    if not _check_folder(os.path.join(folder, ".bindwright"), ".bindwright"):
        return {"removed": []}
    present = [r for r in STAGING_FOLDERS if _check_folder(os.path.join(folder, r), r)]
    for relative in present:
        shutil.rmtree(os.path.join(folder, relative))
    return {"removed": present}
