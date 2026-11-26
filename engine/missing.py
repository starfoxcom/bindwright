"""The repo paths a file's new text names that the repo does not have, for the `missing` key of --update.

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
BACKTICKED = re.compile(r"`([^`\n]+)`")
# The folder the templates name a rule from by its bare file name, wherever they point at it.
RULES = ".claude/rules"


def _spans_of(text):
    """The backtick-quoted spans of a text, in order."""
    return BACKTICKED.findall(text)


def _is_path_like(span):
    """A span that may name a repo path: it ends in a file extension or, for a folder, in a slash,
    and is no placeholder, URL, whitespace or absolute path. A branch name such as
    feature/user-auth-flow has neither ending.
    """
    has_shape = span.endswith("/") or EXTENSION.search(span) is not None
    clean = PLACEHOLDER.search(span) is None and WHITESPACE.search(span) is None
    return has_shape and clean and not span.startswith("/")


def _resolves(root, file, span):
    """True when the repo holds the span, counted from its root, from the naming file's folder or,
    for a bare file name, from the rules folder.

    Only plain relative segments are looked up: a path that climbs out of the repo, or holds a
    backslash, drive or control character, is never found.
    """
    tries = [span, posixpath.join(posixpath.dirname(file), span)]
    if "/" not in span:
        tries.append(posixpath.join(RULES, span))
    for candidate in tries:
        path = posixpath.normpath(candidate)
        if path == "." or (_safe(path) and os.path.exists(os.path.join(root, *path.split("/")))):
            return True
    return False


def _unresolved_names(root, path, text, priors):
    """The names one written file gives that the repo lacks, in first-seen order without repeats.

    `priors` are the texts the file had before this update (its base and the repo's own copy);
    the spans they already named are not new.
    """
    known = {span for prior in priors for span in _spans_of(prior)}
    names = []
    for span in _spans_of(text):
        if span in names or span in known or not _is_path_like(span):
            continue
        if not _resolves(root, path, span):
            names.append(span)
    return names


def missing_report(root, files):
    """The `missing` report for the files an update wrote: `files` holds (path, new text, priors)
    triples, the priors being the texts the file had before the update.

    One entry per file with unresolved names, sorted by path.
    """
    named = {}
    for path, text, priors in files:
        names = _unresolved_names(root, path, text, priors)
        if names:
            named[path] = names
    return [{"file": path, "names": named[path]} for path in sorted(named, key=_code_units)]
