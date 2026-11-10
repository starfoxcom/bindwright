# Python twin of propose.js: how each file staged in .bindwright/incoming/ would merge into
# the repo's own copy at the same path. Read only; nothing is written.

import json
import os
import re
import stat

from apply import _code_units, _is_link
from model import JS_WHITESPACE
from setupcode import MAX_DEPTH, _depth
from staging import STAGING_FOLDERS

INCOMING = STAGING_FOLDERS[0]
MAX_SAFE_INTEGER = 2 ** 53 - 1
# An all-digit key, which JavaScript objects move to the front.
INDEX_KEY = re.compile(r"[0-9]+")
# The permissions.<list> arrays merged as unions; hook lists (hooks.<Event>) merge the same way.
UNION_PERMISSIONS = {"allow", "deny", "ask"}
HEADING = re.compile(r"#{1,6} ")
FENCE = re.compile(r"(`{3,}|~{3,})")


def _canonical(value):
    """The JSON of a value with its keys sorted: equal when the JSON is."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _lstat_or_none(path):
    """The lstat of `path`, or None when nothing is there."""
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _read_text(path):
    """The text of the file at `path`, or None when there is no file there."""
    try:
        with open(path, encoding="utf-8", newline="", errors="replace") as fh:
            return fh.read()
    except (FileNotFoundError, NotADirectoryError):
        return None


_UNREADABLE = object()


def _repo_copy(repo_dir, path):
    """The text of the repo's copy of `path`, None when it has none, or _UNREADABLE when it is
    not one file inside the repo: a folder, a link loop, or a link out of the repo, whose target
    must not get printed into the session."""
    file = os.path.join(repo_dir, path)
    try:
        entry = os.stat(file)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:  # a link loop, or a path the system cannot follow
        return _UNREADABLE
    real = os.path.normcase(os.path.realpath(file))
    root = os.path.normcase(os.path.realpath(repo_dir))
    try:
        inside = os.path.commonpath([real, root]) == root
    except ValueError:  # another drive
        inside = False
    return _read_text(real) if inside and stat.S_ISREG(entry.st_mode) else _UNREADABLE


def _is_real_folder(folder):
    """Whether `folder` is a real folder: a link or junction to one is never followed."""
    entry = _lstat_or_none(folder)
    return entry is not None and not _is_link(entry) and stat.S_ISDIR(entry.st_mode)


def _staged_files(folder, prefix=""):
    """Files under `folder`, relative to it with "/" between parts. Links are skipped."""
    found = []
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        entry = os.lstat(path)
        if _is_link(entry):
            continue
        if stat.S_ISDIR(entry.st_mode):
            found += _staged_files(path, prefix + name + "/")
        elif stat.S_ISREG(entry.st_mode):
            found.append(prefix + name)
    return found


def propose_merges(repo_dir):
    """The proposal for each file staged in <repo_dir>/.bindwright/incoming/, by path."""
    incoming = os.path.join(repo_dir, INCOMING)
    if not _is_real_folder(os.path.dirname(incoming)) or not _is_real_folder(incoming):
        return {"proposals": []}
    proposals = []
    for path in sorted(_staged_files(incoming), key=_code_units):
        repo_text = _repo_copy(repo_dir, path)
        if repo_text is _UNREADABLE:
            proposals.append({"path": path, "kind": "unread"})
            continue
        proposals.append(propose_merge(path, repo_text, _read_text(os.path.join(incoming, path))))
    return {"proposals": proposals}


def propose_merge(path, repo_text, incoming_text):
    """The proposal for one file; `repo_text` is None when the repo has no copy of it.

    Both texts are compared with CRLF read as LF.
    """
    if repo_text is None:
        return {"path": path, "kind": "missing"}
    repo = _normalise(repo_text)
    incoming = _normalise(incoming_text)
    if repo == incoming:
        return {"path": path, "kind": "identical"}
    if path.endswith(".md"):
        return {"path": path, "kind": "markdown", **_compare_sections(repo, incoming)}
    json_proposal = _json_proposal(path, repo, incoming) if path.endswith(".json") else None
    return json_proposal if json_proposal is not None else {"path": path, "kind": "text"}


def _normalise(text):
    return text.replace("\r\n", "\n")


def _json_proposal(path, repo, incoming):
    """JSON: both sides parse as objects, merged key by key. None when either side is not one."""
    repo_object = _parse_object(repo)
    incoming_object = _parse_object(incoming)
    if repo_object is None or incoming_object is None:
        return None
    clashes = []
    merged = _merge_objects(repo_object, incoming_object, [], clashes)
    text = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"
    return {"path": path, "kind": "json", "merged": merged, "text": text, "clashes": clashes}


def _refuse_constant(name):
    raise ValueError(name)


def _parse_object(text):
    """The parsed object, or None when the text is not plain JSON: an object both engines read
    and print alike (see _is_plain), nested at most MAX_DEPTH deep."""
    if _depth(text) > MAX_DEPTH:
        return None
    try:
        value = json.loads(text, parse_constant=_refuse_constant,
                           parse_float=_whole_float, parse_int=_whole_int)
    except ValueError:
        return None
    return value if isinstance(value, dict) and _is_plain(value) else None


# A number JSON.parse would read or print differently. It is a value, never an error, so a later
# copy of a repeated key replaces it, as in JSON.parse, and only the values that remain are judged.
_NOT_PLAIN = object()


def _whole_float(text):
    """A number written with a fraction or an exponent, as the whole number JSON.parse reads it
    as (1.0 is 1), or _NOT_PLAIN."""
    value = float(text)
    return int(value) if value.is_integer() and abs(value) <= MAX_SAFE_INTEGER else _NOT_PLAIN


def _whole_int(text):
    """An integer in the safe range, or _NOT_PLAIN (past it, or too long for int())."""
    try:
        value = int(text)
    except ValueError:
        return _NOT_PLAIN
    return value if abs(value) <= MAX_SAFE_INTEGER else _NOT_PLAIN


def _is_plain(value):
    """Whole numbers in the safe range, no all-digit keys and no lone surrogates: past these the
    JS engine would read or print the value differently, so the file is merged by hand instead."""
    if value is _NOT_PLAIN:
        return False
    if isinstance(value, (bool, int)) or value is None:
        return True
    if isinstance(value, str):
        return not _has_lone_surrogate(value)
    if isinstance(value, list):
        return all(_is_plain(item) for item in value)
    return all(not INDEX_KEY.fullmatch(key) and not _has_lone_surrogate(key) and _is_plain(item)
               for key, item in value.items())


def _has_lone_surrogate(text):
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)


def _merge_objects(repo, incoming, path, clashes):
    """The repo's keys in order, each merged with the staged copy's, then the staged-only keys."""
    merged = {}
    for key, value in repo.items():
        if key in incoming:
            merged[key] = _merge_value(value, incoming[key], path + [key], clashes)
        else:
            merged[key] = value
    for key, value in incoming.items():
        if key not in repo:
            merged[key] = value
    return merged


def _merge_value(repo, incoming, path, clashes):
    """The value both sides set at `path`: equal values keep the repo's; differing ones clash."""
    if isinstance(repo, dict) and isinstance(incoming, dict):
        return _merge_objects(repo, incoming, path, clashes)
    if isinstance(repo, list) and isinstance(incoming, list) and _is_list_path(path):
        if path[0] == "hooks":
            return _merge_hook_entries(repo, incoming)
        return _append_missing(repo, incoming)
    if _canonical(repo) != _canonical(incoming):
        clashes.append({"key": ".".join(path), "repo": repo, "incoming": incoming})
    return repo


def _is_list_path(path):
    if len(path) != 2:
        return False
    return path[0] == "hooks" or (path[0] == "permissions" and path[1] in UNION_PERMISSIONS)


def _append_missing(items, extra):
    """`items` plus each item of `extra` not already in it, in order."""
    seen = {_canonical(item) for item in items}
    merged = list(items)
    for item in extra:
        key = _canonical(item)
        if key not in seen:
            seen.add(key)
            merged.append(item)
    return merged


def _has_hooks(entry):
    return isinstance(entry, dict) and isinstance(entry.get("hooks"), list)


def _merge_hook_entries(items, extra):
    """One event's hook entries: a staged entry whose matcher a repo entry already has adds its
    missing hooks to that entry, so no matcher is listed twice; any other new entry is appended."""
    merged = [dict(entry) if isinstance(entry, dict) else entry for entry in items]
    for item in extra:
        same = None
        if _has_hooks(item):
            same = next((entry for entry in merged if _has_hooks(entry)
                         and _canonical(entry.get("matcher")) == _canonical(item.get("matcher"))),
                        None)
        if same is not None:
            same["hooks"] = _append_missing(same["hooks"], item["hooks"])
        elif all(_canonical(entry) != _canonical(item) for entry in merged):
            merged.append(item)
    return merged


def _compare_sections(repo, incoming):
    """Markdown sections matched by heading: add, differ and repoOnly, as in propose.js."""
    repo_sections = _keyed(_sections_of(repo))
    incoming_sections = _keyed(_sections_of(incoming))
    incoming_by_key = {section["key"]: section for section in incoming_sections}
    repo_keys = {section["key"] for section in repo_sections}
    pairs = [(section, incoming_by_key[section["key"]]) for section in repo_sections
             if section["key"] in incoming_by_key]
    return {
        "add": [{"heading": s["heading"], "text": s["text"]} for s in incoming_sections
                if s["key"] not in repo_keys],
        "differ": [{"heading": r["heading"], "repo": r["text"], "incoming": i["text"]}
                   for r, i in pairs if _rstrip(r["text"]) != _rstrip(i["text"])],
        "repoOnly": [s["heading"] for s in repo_sections if s["key"] not in incoming_by_key],
    }


def _rstrip(text):
    return text.rstrip(JS_WHITESPACE)


def _keyed(sections):
    """Each section with a key: its heading and which copy of that heading it is."""
    seen = {}
    keyed = []
    for section in sections:
        nth = seen.get(section["heading"], 0)
        seen[section["heading"]] = nth + 1
        keyed.append({**section, "key": (section["heading"], nth)})
    return keyed


def _sections_of(text):
    """The text before the first heading (heading ""), then one section per heading.

    A section runs from its heading line to just before the next one. Headings inside
    code fences do not count.
    """
    lines = text.split("\n")
    sections = [("", [])]
    for line, in_fence in zip(lines, _fenced_lines(lines)):
        if not in_fence and HEADING.match(line):
            sections.append((line.strip(JS_WHITESPACE), []))
        sections[-1][1].append(line)
    return [{"heading": heading, "text": "\n".join(body)} for heading, body in sections]


def _fenced_lines(lines):
    """For each line, whether it sits in a fenced code block, its fence lines included."""
    fence = None
    found = []
    for line in lines:
        if fence is None:
            match = FENCE.match(line)
            fence = match.group(1) if match else None
            found.append(fence is not None)
        else:
            if _closes_fence(line, fence):
                fence = None
            found.append(True)
    return found


def _closes_fence(line, fence):
    """A closing fence: the opening character, at least as long as the opener, and nothing else."""
    run = line.strip(JS_WHITESPACE)
    return len(run) >= len(fence) and set(run) <= {fence[0]}
