# Python twin of update.js: /bindwright:update's three-way merge of each repo
# file against the last bind's render. Standard library only, Python 3.8+.

import errno
import json
import os
import shutil
import subprocess
import tempfile

from apply import _code_units, _safe, refuse_links
from keep import OWNED, is_owned, kept_sections, owned_patterns
from model import expand_answers

STAGING = ".bindwright/incoming/"
ANSWERS = ".bindwright/project.json"
PRISTINE = ".bindwright/pristine.json"

# What can happen to a file; update.js explains each one.
OUTCOMES = [
    "updated", "merged", "added", "staged", "unchanged", "conflict", "owned", "deleted", "removed", "removed_edited",
]

# Files the templates moved, old path to new; update.js explains the move.
RENAMES = {
    ".claude/skills/session-close/SKILL.md": ".claude/skills/close-session/SKILL.md",
    ".claude/skills/session-start/SKILL.md": ".claude/skills/start-session/SKILL.md",
}


def repo_files(rendered):
    out = {}
    for dest, text in rendered.items():
        if dest.startswith(STAGING):
            out[dest[len(STAGING):]] = text
        elif not dest.startswith(".bindwright/"):
            out[dest] = text
    return out


def _keeps_sections(ours, merged, path):
    lines = ours.split("\n")
    return all("\n".join(lines[first - 1:last]) in merged for first, last in kept_sections(ours, path))


def _decide(path, ours, base, theirs, merge):
    if theirs is None:
        if ours is None:
            return ("deleted",)
        return ("removed",) if ours == base else ("removed_edited",)
    if base is None:
        if ours is None:
            return ("added", theirs)
        return ("unchanged",) if ours == theirs else ("staged", theirs)
    if ours is None:
        return ("deleted",)
    if ours == theirs or base == theirs:
        return ("unchanged",)
    if ours == base:
        return ("updated", theirs)
    text, conflicts = merge(ours, base, theirs)
    if conflicts or not _keeps_sections(ours, text, path):
        return ("conflict", text)
    return ("merged", text)


def _moves_for(theirs_all, pristine, read_repo, owned):
    """The renames this update carries out, new path to old; see movesFor in update.js."""
    moves = {}
    for old, new in RENAMES.items():
        due = new in theirs_all and old not in theirs_all and old in pristine["files"] and new not in pristine["files"]
        if due and not is_owned(old, owned) and not is_owned(new, owned) and read_repo(new) is None:
            moves[new] = old
    return moves


def _owned_old_path(path, owned, read_repo):
    """The old path a renamed file is owned through; see ownedOldPath in update.js."""
    return next((o for o, n in RENAMES.items() if n == path and is_owned(o, owned) and read_repo(path) is None), None)


def plan_update(rendered, pristine, read_repo, owned, merge, version):
    theirs_all = repo_files(rendered)
    paths = sorted(set(pristine["files"]) | set(theirs_all), key=_code_units)
    result = {o: [] for o in OUTCOMES}
    result.update({"write": [], "stage": [], "renamed": [], "remove": []})
    files = {}
    moves = _moves_for(theirs_all, pristine, read_repo, owned)
    moved_from = set(moves.values())
    for path in paths:
        if path in moved_from:
            continue
        old = moves.get(path)
        base, theirs = pristine["files"].get(old or path), theirs_all.get(path)
        owned_old = _owned_old_path(path, owned, read_repo)
        if owned_old is not None or is_owned(path, owned):
            result["owned"].append(path)
            if owned_old is not None:
                if owned_old in pristine["files"]:
                    files[owned_old] = pristine["files"][owned_old]
            elif theirs is not None:
                files[path] = theirs
            continue
        ours = read_repo(old or path)
        decided = _decide(path, ours, base, theirs, merge)
        outcome = decided[0]
        result[outcome].append(path)
        if outcome in ("updated", "merged", "added"):
            result["write"].append((path, decided[1]))
        if outcome in ("staged", "conflict"):
            result["stage"].append((STAGING + path, decided[1]))
        # A moved file the merge leaves as it was, or stages, still lands at its new path.
        if old and outcome in ("unchanged", "conflict"):
            result["write"].append((path, ours))
        if old and ours is not None:
            result["renamed"].append([old, path])
            result["remove"].append(old)
        if theirs is not None:
            files[path] = theirs
    result["pristine"] = {"version": version, "year": pristine["year"], "files": files}
    return result


MERGE_LABELS = ["this repo", "last setup or update", "today's templates"]


def git_merge(ours, base, theirs):
    """A three-way merge by git: its exit status is the number of conflicts."""
    folder = tempfile.mkdtemp(prefix="bindwright-merge-")
    try:
        names = []
        for name, text in (("ours", ours), ("base", base), ("theirs", theirs)):
            names.append(os.path.join(folder, name))
            with open(names[-1], "w", encoding="utf-8", newline="") as f:
                f.write(text)
        labels = [arg for label in MERGE_LABELS for arg in ("-L", label)]
        done = subprocess.run(["git", "merge-file", "-p", "--diff3"] + labels + names, capture_output=True)
        if done.returncode < 0 or done.returncode >= 128:
            raise RuntimeError("git merge-file failed: " + done.stderr.decode("utf-8", "replace").strip())
        return done.stdout.decode("utf-8"), done.returncode
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _unreadable_reason(path, err):
    # Windows opens a folder for reading as a permission error, so a folder is told apart by its path.
    if isinstance(err, IsADirectoryError) or (os.name == "nt" and os.path.isdir(path)):
        return "it is a folder"
    if isinstance(err, NotADirectoryError):
        return "a folder above it is a file"
    if isinstance(err, PermissionError):
        return "permission denied"
    return errno.errorcode.get(err.errno, "unknown error")


def _file_above(path):
    above = os.path.dirname(path)
    while above != os.path.dirname(above):
        if os.path.isfile(above):
            return True
        above = os.path.dirname(above)
    return False


def read_state(path, file):
    """The bytes of a file, or None when it is missing. Any other failure to read
    it is refused with the file's name and the reason, as readState in update.js."""
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        # Windows reports a path under a file as missing, so a missing file with a file above it is unreadable.
        if not _file_above(path):
            return None
        raise ValueError("%s cannot be read (a folder above it is a file)" % file)
    except OSError as err:
        raise ValueError("%s cannot be read (%s)" % (file, _unreadable_reason(path, err)))


def _reader(root):
    def read(path):
        raw = read_state(os.path.join(root, *path.split("/")), path)
        if raw is None:
            return None
        try:
            # Only \r\n becomes \n, as in update.js: a lone \r stays.
            return raw.decode("utf-8").replace("\r\n", "\n")
        except UnicodeDecodeError:
            raise ValueError("%s is not UTF-8 text" % path)
    return read


def _put(root, path, text, exclusive=False):
    target = os.path.join(root, *path.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "x" if exclusive else "w", encoding="utf-8", newline="") as f:
        f.write(text)


def _remove_moved(target):
    """Deletes a moved file's old copy, then its folder once nothing else is in it."""
    if os.path.lexists(target):
        os.remove(target)
    try:
        os.rmdir(os.path.dirname(target))
    except OSError:
        pass  # The folder is gone or still holds the project's own files.


def run_update(root, bind_with, version, state_json):
    """See runUpdate in update.js. `bind_with(answers, year)` returns a bind."""
    read = _reader(root)
    answers, saved = read(ANSWERS), read(PRISTINE)
    if answers is None or saved is None:
        raise ValueError("%s or %s is missing: this repo was not set up with /bindwright:setup" % (ANSWERS, PRISTINE))
    pristine = json.loads(saved)
    bad = [p for p in pristine["files"] if not _safe(p)]
    if bad:
        raise ValueError("Refusing paths outside the repo in %s: %s" % (PRISTINE, ", ".join(bad)))
    rendered = bind_with(expand_answers(json.loads(answers)), pristine["year"])
    owned = owned_patterns(read(OWNED) or "")
    plan = plan_update(rendered, pristine, read, owned, git_merge, version)

    def at(path):
        return os.path.join(root, *path.split("/"))

    # Every check before the first write, so a refusal leaves the repo as it was.
    # A staged copy that already exists is skipped, not written, so it is not checked.
    fresh_staged = [path for path, _ in plan["stage"] if not os.path.lexists(at(path))]
    refuse_links(root, [path for path, _ in plan["write"]] + [PRISTINE] + fresh_staged + plan["remove"])
    skipped = [path[len(STAGING):] for path, _ in plan["stage"] if os.path.lexists(at(path))]
    files = plan["pristine"]["files"]
    renamed_from = {new: old for old, new in RENAMES.items()}
    for path in skipped:
        # The old staged copy is unsettled, so its file keeps the old base and the next update stages it again.
        # A renamed file's base is still under its old name.
        base = path if path in pristine["files"] else renamed_from.get(path)
        if base in pristine["files"]:
            files[path] = pristine["files"][base]
        else:
            files.pop(path, None)
    for path, text in plan["write"]:
        _put(root, path, text)
    for path, text in plan["stage"]:
        if path[len(STAGING):] not in skipped:
            _put(root, path, text, exclusive=True)
    for path in plan["remove"]:
        _remove_moved(at(path))
    _put(root, PRISTINE, state_json(plan["pristine"]))
    out = {o: plan[o] for o in OUTCOMES}
    out["renamed"] = plan["renamed"]
    out["skipped"] = skipped
    return out
