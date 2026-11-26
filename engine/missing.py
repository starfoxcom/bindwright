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
# A backticked span, then the section text of a `§` reference: the text runs to the line's end
# or to the next backtick.
SPAN = re.compile(r'`([^`\n]+)`(?: *§ *"?([^`\n]*))?')
# A Markdown heading, without its marks and trailing #s.
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$")
# The folder the templates name a rule from by its bare file name, wherever they point at it.
RULES = ".claude/rules"


def _spans_of(text):
    """The backtick-quoted spans of a text, in order."""
    return [match.group(1) for match in SPAN.finditer(text)]


def _candidates_of(file, span):
    """The repo paths a span can name: from the root, from the naming file's folder and, for a
    bare file name, from the rules folder.

    Only plain relative segments are kept, so no path climbs out of the repo or holds a
    backslash, drive or control character, and a placeholder, URL or absolute span names none.
    """
    if span.startswith("/") or PLACEHOLDER.search(span) or WHITESPACE.search(span):
        return []
    tries = [span, posixpath.join(posixpath.dirname(file), span)]
    if "/" not in span:
        tries.append(posixpath.join(RULES, span))
    paths = [posixpath.normpath(candidate) for candidate in tries]
    return [path for path in paths if path != "." and _safe(path)]


def _shipped_paths(files):
    """Every path the bind ships, and every folder above one."""
    paths = set()
    for file in files:
        parts = file.split("/")
        for end in range(1, len(parts) + 1):
            paths.add("/".join(parts[:end]))
    return paths


def _is_missing(root, file, span, shipped):
    """True when a span names a path the bind ships and the repo has it at none of the span's places."""
    candidates = _candidates_of(file, span)
    if not any(candidate in shipped for candidate in candidates):
        return False
    return not any(os.path.exists(os.path.join(root, *c.split("/"))) for c in candidates)


def _resolved_path(root, file, span, known=lambda path: False):
    """The first candidate path the repo holds or that `known` accepts, or None."""
    for path in _candidates_of(file, span):
        if known(path) or os.path.exists(os.path.join(root, *path.split("/"))):
            return path
    return None


def _disk_text(root, path):
    """A repo file's text as it is on disk now, or None when it is gone, is no file or cannot be
    read. The reports run after the update's writes, so a read that fails counts as no copy, and
    bytes that are not UTF-8 read as U+FFFD, as the JS engine reads them.
    """
    target = os.path.join(root, *path.split("/"))
    try:
        if not os.path.isfile(target):
            return None
        with open(target, encoding="utf-8", errors="replace", newline="") as fh:
            return fh.read()
    except OSError:
        return None


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
    if section is None or not span.endswith(".md"):
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


def _unresolved_names(root, path, text, priors, templates, shipped):
    """The names one written file gives that the repo lacks, in first-seen order without repeats.

    `priors` are the texts the file had before this update (its base and the repo's own copy);
    the spans and section refs they already named are not new. A section ref counts when the
    repo's copy of its file lacks the heading.
    """

    def resolve(file, span):
        return _resolved_path(root, file, span)

    def headings_for(target):
        return _headings_of(templates[target]) if target in templates else []

    known = {span for prior in priors for span in _spans_of(prior)}
    known_refs = {ref["name"] for prior in priors
                  for ref in _section_refs_of(path, prior, resolve, headings_for)}
    names = []
    for match in SPAN.finditer(text):
        span, section = match.group(1), match.group(2)
        if span not in known and _is_missing(root, path, span, shipped):
            _add_name(names, span)
        ref = _section_ref(path, span, section, resolve, headings_for)
        if ref is None or ref["name"] in known_refs:
            continue
        copy = _disk_text(root, ref["target"])
        if copy is not None and ref["heading"] not in _headings_of(copy):
            _add_name(names, ref["name"])
    return names


def missing_report(root, files, templates):
    """The `missing` report for the files an update wrote, as (path, new text, priors) triples,
    the priors being the texts the file had before the update, and `templates` maps each repo
    path to its rendered text.

    One entry per file with unresolved names, sorted by path.
    """
    shipped = _shipped_paths(templates)
    named = {}
    for path, text, priors in files:
        names = _unresolved_names(root, path, text, priors, templates, shipped)
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
    if not _points_at(templates[owner], owner, file):
        return False
    copy = _disk_text(root, owner)
    if copy is None:
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


def _is_section_gone(root, ref, gone, templates):
    """True when the update took a section out: its target was removed or renamed away, or today's
    template of the target lacks the heading and so does the repo's copy.
    """
    target = ref["target"]
    if target in gone:
        return True
    if target not in templates or ref["heading"] in _headings_of(templates[target]):
        return False
    copy = _disk_text(root, target)
    return copy is None or ref["heading"] not in _headings_of(copy)


def _stale_names(root, file, gone, templates, resolve, headings_for):
    """The names one kept file still gives that the update removed: a span that names a removed or
    renamed-away path, and a section ref whose heading the base text of its target held and the
    update took out.
    """
    names = []
    for match in SPAN.finditer(_disk_text(root, file) or ""):
        span, section = match.group(1), match.group(2)
        if any(path in gone for path in _candidates_of(file, span)):
            _add_name(names, span)
        ref = _section_ref(file, span, section, resolve, headings_for)
        if ref is not None and _is_section_gone(root, ref, gone, templates):
            _add_name(names, ref["name"])
    return names


def stale_report(root, plan, templates, base_files):
    """The `stale` report: for each edited file the update kept, the names it gives that the update
    dropped, sorted by file. `plan` is the outcome lists of plan_update; `templates` maps each repo
    path to its rendered text; `base_files` is the record's files before the update.
    """
    gone = set(plan["removed"]) | {old for old, _new in plan["renamed"]}

    def resolve(file, span):
        return _resolved_path(root, file, span, lambda path: path in base_files)

    def headings_for(target):
        return _headings_of(base_files[target]) if target in base_files else []

    report = []
    for file in sorted(plan["removed_edited"], key=_code_units):
        names = _stale_names(root, file, gone, templates, resolve, headings_for)
        if names:
            report.append({"file": file, "names": names})
    return report
