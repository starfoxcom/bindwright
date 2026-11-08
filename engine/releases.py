# Python twin of releases.js: the plugin's releases newer than the version a repo
# was bound with, for /bindwright:update to summarize (--releases-since DIR).

import json
import os
import re

from model import JS_WHITESPACE

PRISTINE = ".bindwright/pristine.json"
CHANGELOG = "CHANGELOG.md"
SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
# "## [v2.4.0] — 2026-11-08": the version, then a date after a dash (em, en or hyphen).
HEADING = re.compile(
    r"## \[v?([0-9]+\.[0-9]+\.[0-9]+)\](?:[ \t]*[—–-][ \t]*([0-9]{4}-[0-9]{2}-[0-9]{2}))?")
SECTION_START = re.compile(r"(?m)^(?=## )")

NO_PRISTINE = "The repo has no .bindwright/pristine.json, so there is no bound version to list releases from."
NO_VERSION = ".bindwright/pristine.json names no version Bindwright can read."
NO_CHANGELOG = "The plugin has no CHANGELOG.md to list its releases from."


def _not_in_changelog(from_version):
    return f"CHANGELOG.md has no release {from_version}, so the releases since it cannot be listed."


def _key(version):
    """A version as a tuple of numbers, so 2.10.0 sorts after 2.9.0."""
    return tuple(int(part) for part in version.split("."))


def parse_changelog(text):
    """The releases in a CHANGELOG.md text, in file order: {"version", "date", "text"}. Unreleased is skipped."""
    found = []
    for section in SECTION_START.split(text.replace("\r\n", "\n")):
        heading = HEADING.match(section)
        if heading is None:
            continue
        newline = section.find("\n")
        body = "" if newline == -1 else section[newline + 1:]
        found.append({"version": heading.group(1), "date": heading.group(2), "text": body.strip(JS_WHITESPACE)})
    return found


def _bound_version(pristine_text):
    """The version pristine.json names, with a leading "v" stripped; None when it names none."""
    try:
        pristine = json.loads(pristine_text)
    except ValueError:  # not JSON: names no version
        return None
    version = pristine.get("version") if isinstance(pristine, dict) else None
    return version.lstrip("v") if isinstance(version, str) else None


def _unavailable(from_version, to, reason):
    return {"from": from_version, "to": to, "releases": [], "unavailable": reason}


def releases_since(pristine_text, changelog_text, to):
    """The releases a repo bound at the version its pristine.json names has not seen, up to `to`.

    `pristine_text` and `changelog_text` are the files' text, or None when a file is missing.
    Nothing here is an error: a repo that cannot be placed gets "unavailable" instead.
    """
    if pristine_text is None:
        return _unavailable(None, to, NO_PRISTINE)
    from_version = _bound_version(pristine_text)
    if from_version is None or not SEMVER.fullmatch(from_version):
        return _unavailable(from_version, to, NO_VERSION)
    if changelog_text is None:
        return _unavailable(from_version, to, NO_CHANGELOG)
    releases = parse_changelog(changelog_text)
    if not any(release["version"] == from_version for release in releases):
        return _unavailable(from_version, to, _not_in_changelog(from_version))
    newer = [r for r in releases if _key(from_version) < _key(r["version"]) <= _key(to)]
    return {"from": from_version, "to": to, "releases": sorted(newer, key=lambda r: _key(r["version"]), reverse=True)}


def _read_text(path):
    """The text of a file, or None when it does not exist."""
    try:
        with open(path, encoding="utf-8", newline="") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def releases_for_repo(folder, root):
    """The plugin's releases since the version `folder` was bound with; `root` is the plugin folder."""
    with open(os.path.join(root, "VERSION"), encoding="utf-8", newline="") as fh:
        to = fh.read().strip(JS_WHITESPACE).lstrip("v")
    if not SEMVER.fullmatch(to):
        raise ValueError("the plugin's VERSION file names no x.y.z version")
    return releases_since(
        _read_text(os.path.join(folder, PRISTINE)),
        _read_text(os.path.join(root, CHANGELOG)),
        to,
    )
