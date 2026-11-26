"""The files a written file's new text names that this update's bind ships but the repo does not
have, for the `missing` key of --update.

A name counts only when it names a file the bind ships, or a folder holding one, so a setting
key, a code name or an example layout never does. The Python twin of missing.js; a test runs
both engines on the same repos.
"""

import os
import posixpath
import re

from apply import _code_units, _safe

# The characters JavaScript's \s matches: a span with one of them is not a single path.
WHITESPACE = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]")
# Placeholders, URLs and Windows paths (a backslash, a drive or a share).
PLACEHOLDER = re.compile(r"[<{*$~\\:]")
BACKTICKED = re.compile(r"`([^`\n]+)`")
# The folder the templates name a rule from by its bare file name, wherever they point at it.
RULES = ".claude/rules"


def _spans_of(text):
    """The backtick-quoted spans of a text, in order."""
    return BACKTICKED.findall(text)


def _candidates_of(file, span):
    """The repo paths a span can name: from the root, from the naming file's folder and, for a
    bare file name, from the rules folder.

    Only plain relative segments are kept, so no path climbs out of the repo or holds a
    backslash, drive or control character.
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


def _unresolved_names(root, path, text, priors, shipped):
    """The names one written file gives that the bind ships and the repo lacks, in first-seen order
    without repeats.

    `priors` are the texts the file had before this update (its base and the repo's own copy);
    the spans they already named are not new.
    """
    known = {span for prior in priors for span in _spans_of(prior)}
    names = []
    for span in _spans_of(text):
        if span in names or span in known:
            continue
        candidates = _candidates_of(path, span)
        if not any(candidate in shipped for candidate in candidates):
            continue
        if not any(os.path.exists(os.path.join(root, *c.split("/"))) for c in candidates):
            names.append(span)
    return names


def missing_report(root, files, bound):
    """The `missing` report for the files an update wrote: `files` holds (path, new text, priors)
    triples, the priors being the texts the file had before the update, and `bound` lists the
    repo paths the bind ships.

    One entry per file with unresolved names, sorted by path.
    """
    shipped = _shipped_paths(bound)
    named = {}
    for path, text, priors in files:
        names = _unresolved_names(root, path, text, priors, shipped)
        if names:
            named[path] = names
    return [{"file": path, "names": named[path]} for path in sorted(named, key=_code_units)]
