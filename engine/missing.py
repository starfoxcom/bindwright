"""The repo paths a file's new text names that the repo lacks, and the section names and links
that go stale, for the `missing`, `unlinked` and `stale` keys of --update.

The Python twin of missing.js; a test runs both engines on the same repos.
"""

import os
import posixpath
import re

from apply import _code_units, _safe

# The characters JavaScript's \s matches: a span with one of them is not a single path.
WHITESPACE = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]")
# Placeholders, URLs and Windows paths (a backslash, a drive or a share).
PLACEHOLDER = re.compile(r"[<{*$~\\:]")
# A file extension starts with a letter, so a version such as 7.19.1 is no path.
EXTENSION = re.compile(r"\.[A-Za-z][A-Za-z0-9]{0,4}\Z")
# A backticked span, then the section text of a `§` reference: the text runs to the line's end
# or to the next backtick.
SPAN = re.compile(r'`([^`\n]+)`(?: *§ *"?([^`\n]*))?')
# A Markdown heading, without its marks and trailing #s.
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$")


def _spans_of(text):
    """The backtick-quoted spans of a text, in order."""
    return [match.group(1) for match in SPAN.finditer(text)]


def _is_path_like(span):
    """A span that may name a repo path: it ends in a file extension or, for a folder, in a slash,
    and is no placeholder, URL, whitespace or absolute path. A branch name such as
    feature/user-auth-flow has neither ending.
    """
    has_shape = span.endswith("/") or EXTENSION.search(span) is not None
    clean = PLACEHOLDER.search(span) is None and WHITESPACE.search(span) is None
    return has_shape and clean and not span.startswith("/")


def _candidates_of(file, span):
    """The repo paths a span can name, counted from the root and then from the naming file's folder.

    Only plain relative segments are kept, or "." for the root: a path that climbs out of the
    repo, or holds a backslash, drive or control character, is left out, and so is an absolute span.
    """
    if span.startswith("/"):
        return []
    folder = posixpath.dirname(file)
    candidates = [posixpath.normpath(span), posixpath.normpath(posixpath.join(folder, span))]
    paths = [path[:-1] if path.endswith("/") else path for path in candidates]
    return [path for path in paths if path == "." or _safe(path)]


def _resolved_path(root, file, span, known=lambda path: False):
    """The first candidate path the repo holds or that `known` accepts, or None."""
    for path in _candidates_of(file, span):
        if known(path) or os.path.exists(os.path.join(root, *path.split("/"))):
            return path
    return None


def _disk_text(root, path):
    """A repo file's text as it is on disk now, or None when it is gone or is no file."""
    target = os.path.join(root, *path.split("/"))
    if not os.path.isfile(target):
        return None
    with open(target, encoding="utf-8", newline="") as fh:
        return fh.read()


def _headings_of(text):
    """The headings of a Markdown text, without their marks and trailing #s."""
    matches = (HEADING.match(line) for line in text.split("\n"))
    return [match.group(1) for match in matches if match is not None]


def _section_heading(section, headings):
    """The longest of `headings` that a section text opens with. The next character must not
    continue a word, so a heading "Use" does not match "Users".
    """
    opened = [
        h for h in headings
        if section.startswith(h) and not section[len(h):len(h) + 1].isalnum()
    ]
    return max(opened, key=len, default=None)


def _section_ref(file, span, section, resolve, headings_for):
    """The section ref that one backticked span with its section text makes: a dict with keys
    target, name and heading, the name being "<span> § <heading>". Only a path-like .md span that
    `resolve` finds, and whose headings from `headings_for` hold the heading, makes one.
    """
    if section is None or not _is_path_like(span) or not span.endswith(".md"):
        return None
    target = resolve(file, span)
    heading = None if target is None else _section_heading(section, headings_for(target))
    if heading is None:
        return None
    return {"target": target, "name": "%s § %s" % (span, heading), "heading": heading}


def _section_refs_of(file, text, resolve, headings_for):
    """The section refs of a text that resolve to a heading, in order."""
    refs = [_section_ref(file, m.group(1), m.group(2), resolve, headings_for)
            for m in SPAN.finditer(text)]
    return [ref for ref in refs if ref is not None]


def _add_name(names, name):
    """Adds a name once, keeping first-seen order."""
    if name not in names:
        names.append(name)


def _unresolved_names(root, path, text, base, templates):
    """The names one written file gives that the repo lacks, in first-seen order without repeats.

    `base` is the file's text before this update, or None for a new file; the spans and section
    refs it already named are not new. A section ref counts when the repo's copy of its file lacks
    the heading.
    """
    base = "" if base is None else base

    def resolve(file, span):
        return _resolved_path(root, file, span)

    def headings_for(target):
        return _headings_of(templates[target]) if target in templates else []

    known = set(_spans_of(base))
    known_refs = {ref["name"] for ref in _section_refs_of(path, base, resolve, headings_for)}
    names = []
    for match in SPAN.finditer(text):
        span, section = match.group(1), match.group(2)
        if _is_path_like(span) and span not in known and _resolved_path(root, path, span) is None:
            _add_name(names, span)
        ref = _section_ref(path, span, section, resolve, headings_for)
        if ref is None or ref["name"] in known_refs:
            continue
        copy = _disk_text(root, ref["target"])
        if copy is not None and ref["heading"] not in _headings_of(copy):
            _add_name(names, ref["name"])
    return names


def missing_report(root, files, templates):
    """The `missing` report for the files an update wrote, as (path, new text, base) triples,
    and `templates` maps each repo path to its rendered text.

    One entry per file with unresolved names, sorted by path.
    """
    named = {}
    for path, text, base in files:
        names = _unresolved_names(root, path, text, base, templates)
        if names:
            named[path] = names
    return [{"file": path, "names": named[path]} for path in sorted(named, key=_code_units)]


def _base_of(base_files, path):
    """The base text of a repo path, or None when the record holds none."""
    return base_files.get(path)


def _points_at(text, owner, file):
    """True when a text has a span that names `file` by path math alone."""
    return text is not None and any(file in _candidates_of(owner, span) for span in _spans_of(text))


def _links_to(root, owner, file, templates, base_files):
    """True when the owner's template points at `file` while neither its base text nor its copy in
    the repo does.
    """
    copy = _disk_text(root, owner)
    if copy is None or not _points_at(templates[owner], owner, file):
        return False
    base_points = _points_at(_base_of(base_files, owner), owner, file)
    return not base_points and not _points_at(copy, owner, file)


def unlinked_report(root, added, templates, base_files):
    """The `unlinked` report: each added file with the repo files whose template points at it but
    whose base text and repo copy do not, sorted by file. `templates` maps each repo path to its
    rendered text; `base_files` is the record's files before the update.
    """
    report = []
    for file in sorted(added, key=_code_units):
        owners = [owner for owner in templates
                  if owner != file and _links_to(root, owner, file, templates, base_files)]
        if owners:
            report.append({"file": file, "from": sorted(owners, key=_code_units)})
    return report


def _stale_names(root, file, gone, resolve, headings_for):
    """The names one kept file still gives that the update removed: a span that names a removed or
    renamed-away path, and a section ref whose heading the base text of its target held and the
    repo's copy no longer does (or the target is gone).
    """
    names = []
    for match in SPAN.finditer(_disk_text(root, file) or ""):
        span, section = match.group(1), match.group(2)
        if _is_path_like(span) and any(path in gone for path in _candidates_of(file, span)):
            _add_name(names, span)
        ref = _section_ref(file, span, section, resolve, headings_for)
        if ref is None:
            continue
        copy = _disk_text(root, ref["target"])
        if copy is None or ref["heading"] not in _headings_of(copy):
            _add_name(names, ref["name"])
    return names


def stale_report(root, plan, base_files):
    """The `stale` report: for each edited file the update kept, the names it gives that the update
    dropped, sorted by file. `plan` is the outcome lists of plan_update; `base_files` is the
    record's files before the update.
    """
    gone = set(plan["removed"]) | {old for old, _new in plan["renamed"]}

    def resolve(file, span):
        return _resolved_path(root, file, span, lambda path: path in base_files)

    def headings_for(target):
        return _headings_of(base_files[target]) if target in base_files else []

    report = []
    for file in sorted(plan["removed_edited"], key=_code_units):
        names = _stale_names(root, file, gone, resolve, headings_for)
        if names:
            report.append({"file": file, "names": names})
    return report
