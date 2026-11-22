"""Keeps the mods setup installed in ~/.claude/mods/ current with the plugin's copies: the install record
of each mod, how its installed files differ from the shipped ones, and the update that keeps the user's
edits. Standard library, Python 3.8+."""

import json
import os
import shutil

from apply import _is_link
from home_files import HomeError, _atomic_write, _claude, _is_str_list, _is_str_map, _json_field, _style_fingerprint


# The install record a mod keeps beside its installed files: per file, the SHA-256 of the shipped text last
# written there, or for an edit kept, of the shipped text last set beside it as .new.
MOD_RECORD = ".bindwright-installed.json"
# A mod's own list of the paths that hold the user's entries (its user-files.json): with no record to tell an
# edit from an older copy, these are kept and the shipped text goes beside them as .new.
MOD_USER_FILES = "user-files.json"


def _check_mod_folder(folder):
    if not os.path.isfile(os.path.join(folder, ".claude-plugin", "plugin.json")):
        raise HomeError("Not a mod folder (no .claude-plugin/plugin.json): " + folder)


def _mod_target(home, folder):
    name = os.path.basename(os.path.normpath(folder))
    return os.path.normpath(os.path.join(_claude(home), "mods", name))


def _shipped_files(folder):
    """Every file of a mod folder as a forward-slash path, except node_modules and the install record."""
    found = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        found += [os.path.relpath(os.path.join(root, f), folder).replace(os.sep, "/") for f in files]
    return sorted(rel for rel in found if rel != MOD_RECORD)


def _shipped_hashes(folder):
    return {rel: _style_fingerprint(os.path.join(folder, rel)) for rel in _shipped_files(folder)}


def _user_paths(folder):
    file = os.path.join(folder, MOD_USER_FILES)
    if not os.path.isfile(file):
        return set()
    return set(_json_field(file, "paths", _is_str_list, 'Not a list of user paths ({"paths": [...]})'))


def _record_of(target):
    """The install record of the installed mod at `target`, or None when it has none."""
    file = os.path.join(target, MOD_RECORD)
    if not os.path.isfile(file):
        return None
    return _json_field(file, "sha256", _is_record, 'Not an install record ({"sha256": {...}})')


def _is_record(value):
    """Hashes keyed by plain relative paths: a key never reaches outside the mod folder."""
    return _is_str_map(value) and all(_is_inside_rel(rel) for rel in value)


def _is_inside_rel(rel):
    return "\\" not in rel and ":" not in rel and all(part not in ("", ".", "..") for part in rel.split("/"))


def _save_record(target, hashes):
    _atomic_write(os.path.join(target, MOD_RECORD), json.dumps({"sha256": hashes}, indent=2) + "\n")


def _file_label(folder, target, rel, record, is_user):
    """How one shipped file differs from its installed copy, or None when they match."""
    installed = os.path.join(target, rel)
    if not os.path.isfile(installed):
        return "add"
    installed_hash = _style_fingerprint(installed)
    shipped_hash = _style_fingerprint(os.path.join(folder, rel))
    if installed_hash == shipped_hash:
        return None
    # Without a record nothing tells an edit from an older copy: a user file is kept, any other is replaced.
    if record is None:
        return "edited" if is_user else "replace"
    if record.get(rel) == installed_hash:
        return "replace"
    # The record holds the shipped text last offered: an edit with nothing newer shipped since is left alone.
    if record.get(rel) == shipped_hash:
        return None
    return "edited"


def _dropped_label(target, rel, record):
    """A recorded file the mod no longer ships: removed while it is as installed, else kept as the user's edit."""
    installed = os.path.join(target, rel)
    if not os.path.isfile(installed):
        return None
    return "remove" if _style_fingerprint(installed) == record[rel] else "edited"


def _differences(folder, target, record):
    """Each file that differs from the shipped mod, labelled add, replace, edited or remove."""
    shipped = set(_shipped_files(folder))
    user = _user_paths(folder)
    files = {}
    for rel in sorted(shipped):
        label = _file_label(folder, target, rel, record, rel in user)
        if label:
            files[rel] = label
    for rel in (record or {}):
        if rel not in shipped:
            label = _dropped_label(target, rel, record)
            if label:
                files[rel] = label
    return files


def _state(record, files):
    # A copy with no record stays unrecorded even when it matches, so --adopt still writes its record.
    if record is None:
        return "unrecorded"
    if "edited" in files.values():
        return "edited"
    return "older" if files else "current"


def mod_status(home, folder):
    _check_mod_folder(folder)
    target = _mod_target(home, folder)
    if not os.path.lexists(target):
        return {"installed": target, "state": "missing", "files": {}}
    if _is_link(os.lstat(target)):
        return {"installed": target, "state": "linked", "files": {}}
    record = _record_of(target)
    files = _differences(folder, target, record)
    return {"installed": target, "state": _state(record, files), "files": files}


def _copy_atomic(source, target):
    """Copies a file byte for byte under a temporary name, then renames it into place."""
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copyfile(source, target + ".tmp")
    os.replace(target + ".tmp", target)


def _apply(folder, target, files, final, progress):
    """Writes, removes and sets aside the files `files` lists; returns the updated, kept and removed paths.

    `progress` is the record as it stands, or None for an adopted copy: it takes each file's `final` entry and is
    saved after every change, so an update stopped part-way leaves a record that is true for each file."""
    updated, kept, removed = [], [], []
    for rel, label in files.items():
        source, installed = os.path.join(folder, rel), os.path.join(target, rel)
        if label in ("add", "replace"):
            _copy_atomic(source, installed)
            updated.append(rel)
        elif label == "remove":
            os.remove(installed)
            removed.append(rel)
        elif label == "edited" and rel in final:
            _copy_atomic(source, installed + ".new")
            kept.append(rel)
        else:
            continue
        if progress is not None:
            _set_entry(progress, rel, final)
            _save_record(target, progress)
    return updated, kept, removed


def _set_entry(record, rel, final):
    if rel in final:
        record[rel] = final[rel]
    else:
        record.pop(rel, None)


def update_mod(home, folder, adopt=False):
    """Brings an installed mod up to the shipped one. The status is the one found before the update."""
    status = mod_status(home, folder)
    state = status["state"]
    if state in ("missing", "linked", "current") or (state == "unrecorded" and not adopt):
        return dict(status, updated=[], kept=[], removed=[])
    target = status["installed"]
    # After the update each shipped file is recorded at its shipped text, which for an edit kept is the text set
    # beside it; a dropped file the user edited stays on disk and leaves the record.
    hashes = _shipped_hashes(folder)
    record = _record_of(target)
    # An adopted copy gets its record only at the end, so one stopped part-way is still unrecorded and adopted again.
    updated, kept, removed = _apply(folder, target, status["files"], hashes, None if record is None else dict(record))
    _save_record(target, hashes)
    return dict(status, updated=updated, kept=kept, removed=removed)
