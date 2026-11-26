# Python twin of update.js: /bindwright:update's three-way merge of each repo
# file against the last bind's render. Standard library only, Python 3.8+.

import errno
import json
import os
import re
import shutil
import subprocess
import tempfile

from apply import _code_units, _safe, refuse_links
from keep import OWNED, is_owned, kept_sections, owned_patterns
from missing import missing_report
from model import expand_answers
from propose import parse_plain_object

STAGING = ".bindwright/incoming/"
ANSWERS = ".bindwright/project.json"
PRISTINE = ".bindwright/pristine.json"
BEFORE = "bindwright-pristine-before.json"  # in git's folder: the record the last update replaced

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
    # Git's line merge cannot place a key the repo moved; a key-by-key merge can.
    if conflicts and path.endswith(".json"):
        merged = _merge_json(ours, base, theirs)
        if merged is not None and _keeps_sections(ours, merged, path):
            return ("merged", merged)
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


def _owned_old_path(path, pristine, owned, read_repo):
    """The old path a renamed file is owned through; see ownedOldPath in update.js."""
    return next((o for o, n in RENAMES.items() if n == path and is_owned(o, owned)
                 and (o in pristine["files"] or read_repo(o) is not None) and read_repo(path) is None), None)


def _base_for(pristine, path, ours):
    """The base a file is decided against; see baseFor in update.js."""
    held = pristine.get("held")
    held_text = held.get(path) if isinstance(held, dict) else None
    if isinstance(held_text, str) and held_text == ours:
        return held_text
    return pristine["files"].get(path)


def plan_update(rendered, pristine, read_repo, owned, merge, version):
    theirs_all = repo_files(rendered)
    paths = sorted(set(pristine["files"]) | set(theirs_all), key=_code_units)
    result = {o: [] for o in OUTCOMES}
    result.update({"write": [], "stage": [], "renamed": [], "remove": [], "owned_changed": [], "priors": {}})
    files = {}
    moves = _moves_for(theirs_all, pristine, read_repo, owned)
    moved_from = set(moves.values())
    for path in paths:
        if path in moved_from:
            continue
        old = moves.get(path)
        theirs = theirs_all.get(path)
        owned_old = _owned_old_path(path, pristine, owned, read_repo)
        if owned_old is not None or is_owned(path, owned):
            result["owned"].append(path)
            if owned_old is not None:
                if owned_old in pristine["files"]:
                    files[owned_old] = pristine["files"][owned_old]
            elif theirs is not None:
                files[path] = theirs
                # The templates changed a file the project owns: the project's copy never gets it by itself,
                # so the new text waits in the staging folder until someone settles it.
                if pristine["files"].get(path) != theirs:
                    result["owned_changed"].append(path)
                    result["stage"].append((STAGING + path, theirs))
            continue
        ours = read_repo(old or path)
        base = _base_for(pristine, old or path, ours)
        decided = _decide(path, ours, base, theirs, merge)
        outcome = decided[0]
        result[outcome].append(path)
        if outcome in ("updated", "merged", "added"):
            result["write"].append((path, decided[1]))
            result["priors"][path] = [t for t in (base, ours) if isinstance(t, str)]
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

BOM = "\ufeff"
_ABSENT = object()  # a key a version does not have
_CLASH = object()  # a value every version changed differently
# The first indented line's indent, found after a \n only, as the JS twin finds it.
_INDENT = re.compile(r"\n([ \t]+)\S")
_MAX_INDENT = 10  # JSON.stringify uses at most 10 characters of an indent string


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


def _merge_json(ours, base, theirs):
    """A key-by-key three-way merge of three JSON objects; None on a clash or a text that is not one."""
    parsed = [_parse_object(text) for text in (ours, base, theirs)]
    if any(part is None for part in parsed):
        return None
    merged = _merge_value(*parsed)
    if merged is _CLASH:
        return None
    indent = _indent_of(ours)
    if len(indent) > _MAX_INDENT:
        return None
    body = json.dumps(merged, indent=indent, ensure_ascii=False)
    return (BOM if ours.startswith(BOM) else "") + body + ("\n" if ours.endswith("\n") else "")


def _parse_object(text):
    """The object of a text the twins both read and reprint alike (propose.py holds those
    rules), with no key repeated."""
    plain = text[1:] if text.startswith(BOM) else text
    value = parse_plain_object(plain)
    if value is None:
        return None
    try:
        json.loads(plain, object_pairs_hook=_unique_keys)
    except ValueError:
        return None
    return value


def _unique_keys(pairs):
    """An object with no key repeated: json.loads keeps only the last copy, so the reprint would
    drop the others."""
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ValueError("a repeated key")
    return dict(pairs)


def _indent_of(text):
    match = _INDENT.search(text)
    return match.group(1) if match else "  "


def _merge_value(o, b, t):
    """Objects merge key by key first, so the repo's key order holds even where it changed nothing else."""
    if isinstance(o, dict) and isinstance(b, dict) and isinstance(t, dict):
        return _merge_object(o, b, t)
    if _same(o, t):
        return o
    if _same(o, b):
        return t
    if _same(t, b):
        return o
    return _CLASH


def _merge_object(o, b, t):
    merged = {}
    for key in list(o) + [key for key in t if key not in o]:
        value = _merge_value(o.get(key, _ABSENT), b.get(key, _ABSENT), t.get(key, _ABSENT))
        if value is _CLASH:
            return _CLASH
        if value is not _ABSENT:
            merged[key] = value
    return merged


def _same(a, b):
    """Deep equality: objects regardless of key order, arrays in order, and true apart from 1."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[key], b[key]) for key in a)
    return a == b


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
    # The replaced record is saved first, so a failure to save it stops the update before any repo write.
    before = _before_path(root)
    if before is not None:
        with open(before, "w", encoding="utf-8", newline="") as fh:
            fh.write(saved)
    for path, text in plan["write"]:
        _put(root, path, text)
    for path, text in plan["stage"]:
        if path[len(STAGING):] not in skipped:
            _put(root, path, text, exclusive=True)
    for path in plan["remove"]:
        _remove_moved(at(path))
    _put(root, PRISTINE, state_json(plan["pristine"]))
    out = {o: plan[o] for o in OUTCOMES}
    out.update(renamed=plan["renamed"], owned_changed=plan["owned_changed"], skipped=skipped,
               missing=missing_report(root, _written_files(plan)))
    return out


def _written_files(plan):
    """The files this update wrote with a new text, as (path, new text, priors) triples; the priors
    are the base the update decided the file against and the repo's copy before it.
    """
    written = dict(plan["write"])
    paths = [path for outcome in ("added", "merged", "updated") for path in plan[outcome]]
    return [(path, written[path], plan["priors"][path]) for path in paths]


def _record_of(text, what):
    """See recordOf in update.js: a pristine record with a files object, or refused naming `what`."""
    try:
        record = json.loads(text)
    except ValueError:
        record = None
    if not (isinstance(record, dict) and isinstance(record.get("files"), dict)):
        raise ValueError("%s holds no record of the files setup wrote" % what)
    return record


def _before_path(root):
    """See beforePath in update.js: the file in git's folder holding the record the last update replaced."""
    try:
        out = subprocess.run(["git", "-C", root, "rev-parse", "--git-path", BEFORE],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        return None
    if out.returncode != 0:
        return None
    try:
        path = out.stdout.decode("utf-8").strip()
    except UnicodeDecodeError:
        return None
    return path if os.path.isabs(path) else os.path.join(root, path)


def keep_base(root, paths, state_json):
    """See keepBase in update.js: bases go back to the ones the last update used, and the text they replace is held."""
    bad = [p for p in paths if not _safe(p)]
    if bad:
        raise ValueError("Refusing paths outside the repo: %s" % ", ".join(bad))
    current = _reader(root)(PRISTINE)
    if current is None:
        raise ValueError("%s is missing: this repo was not set up with /bindwright:setup" % PRISTINE)
    what = "the record the last update replaced"
    saved = _before_path(root)
    previous = None if saved is None else read_state(saved, what)
    if previous is None:
        raise ValueError("No record from before the last update: run /bindwright:update first")
    try:
        text = previous.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("%s is not UTF-8 text" % what)
    before = _record_of(text.replace("\r\n", "\n"), what)
    read = _reader(root)
    state = _record_of(current, PRISTINE)
    held = state.get("held")
    held = dict(held) if isinstance(held, dict) else {}
    result = {"kept": [], "dropped": []}
    for path in paths:
        # Only the first hold counts: a repeat would read the base already put back.
        if path in state["files"] and path not in held:
            held[path] = state["files"][path]
        # The base the last update decided against; see keepBase in update.js.
        ours = read(path)
        if ours == held.get(path):
            prior = before["files"].get(path)
        else:
            prior = _base_for(before, path, ours)
        if isinstance(prior, str) and (prior == ours or path in before["files"]):
            state["files"][path] = prior
            result["kept"].append(path)
        else:
            state["files"].pop(path, None)
            result["dropped"].append(path)
    # Sorted as plan_update writes them, so a base put back lands at its place, not at the end.
    state["files"] = {p: state["files"][p] for p in sorted(state["files"], key=_code_units)}
    if held:
        state["held"] = {p: held[p] for p in sorted(held, key=_code_units)}
    else:
        state.pop("held", None)
    refuse_links(root, [PRISTINE])
    _put(root, PRISTINE, state_json(state))
    return result
