# Python twin of propose.js: how each file staged in .bindwright/incoming/ would merge into
# the repo's own copy at the same path. Read only; nothing is written.

import json
import os
import re
import stat

from apply import _code_units, _is_link
from model import JS_WHITESPACE
from staging import STAGING_FOLDERS

INCOMING = STAGING_FOLDERS[0]
# Arrays merged as unions, by dotted key path. Hook lists (hooks.<Event>) merge the same way.
UNION_PATHS = {"permissions.allow", "permissions.deny", "permissions.ask"}
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


_OUTSIDE = object()


def _repo_copy(repo_dir, path):
    """The text of the repo's copy of `path`, None when it has none, or _OUTSIDE when a link in
    its path leads out of the repo: a repo must not get a file elsewhere printed into the session."""
    file = os.path.join(repo_dir, path)
    if not os.path.exists(file):
        return None
    real = os.path.normcase(os.path.realpath(file))
    root = os.path.normcase(os.path.realpath(repo_dir))
    try:
        inside = os.path.commonpath([real, root]) == root
    except ValueError:  # another drive
        inside = False
    return _read_text(real) if inside else _OUTSIDE


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
    entry = _lstat_or_none(incoming)
    if entry is None or _is_link(entry) or not stat.S_ISDIR(entry.st_mode):
        return {"proposals": []}
    proposals = []
    for path in sorted(_staged_files(incoming), key=_code_units):
        repo_text = _repo_copy(repo_dir, path)
        if repo_text is _OUTSIDE:
            proposals.append({"path": path, "kind": "text"})
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
    """The parsed object, or None when the text is not JSON or not an object."""
    try:
        value = json.loads(text, parse_constant=_refuse_constant)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


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
        return _append_missing(repo, incoming)
    if _canonical(repo) != _canonical(incoming):
        clashes.append({"key": ".".join(path), "repo": repo, "incoming": incoming})
    return repo


def _is_list_path(path):
    return ".".join(path) in UNION_PATHS or (len(path) == 2 and path[0] == "hooks")


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
