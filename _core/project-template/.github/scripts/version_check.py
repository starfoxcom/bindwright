#!/usr/bin/env python3
"""Refuses a release whose version is smaller than its commits require.

Reads the commits since the newest release tag reachable from --ref, other than
a tag of NEW_VERSION itself, and checks NEW_VERSION against them:

    version_check.py NEW_VERSION [--scheme semver|calver] [--format YYYY.MM.MICRO]
                     [--changelog CHANGELOG.md] [--ref HEAD]

semver reads the commits as Conventional Commits: a `<type>!:` header or a
`BREAKING CHANGE:` body line needs a major, `feat` a minor, `fix` and `perf` a
patch. Before 1.0.0 a major counts as a minor and a minor as a patch. The
release's section in the changelog (Keep a Changelog, `## [vNEW]` or `## [NEW]`)
must hold the headings its size needs. The changelog is CHANGELOG.md when that
file exists, and is not checked when it does not.

calver checks that NEW fits --format (calver.org tokens joined by dots) and
sorts after the last tag, and nothing else.

Prints nothing and exits 0 when the version is allowed. Prints one line per
reason and exits 2 when it is not. Exits 1 on bad arguments or a git or file
error, with the message on stderr. With no earlier tag it says so and exits 0.
"""

import argparse
import os
import re
import subprocess
import sys
from typing import NamedTuple

RANK = {"none": 0, "patch": 1, "minor": 2, "major": 3}
SIZE_NAMES = ("major", "minor", "patch")
TYPE_LEVEL = {"feat": "minor", "fix": "patch", "perf": "patch"}
DEMOTED = {"major": "minor", "minor": "patch"}
HEADER = re.compile(r"^(?P<type>[a-z]+)(?:\([^()]*\))?(?P<bang>!)?: \S")
BREAKING = re.compile(r"^BREAKING[ -]CHANGE:", re.MULTILINE)
SEMVER = re.compile(r"(\d+)\.(\d+)\.(\d+)", re.ASCII)
PATCH_HEADINGS = {"Fixed", "Security"}
MAX_LISTED = 5
# calver.org tokens: the regex each one matches, and its range when it is a date part.
CALVER_TOKENS = {
    "YYYY": (r"\d{4}", None),
    "YY": (r"\d{1,2}", None),
    "0Y": (r"\d{2}", None),
    "MM": (r"\d{1,2}", (1, 12)),
    "0M": (r"\d{2}", (1, 12)),
    "WW": (r"\d{1,2}", (1, 53)),
    "0W": (r"\d{2}", (1, 53)),
    "DD": (r"\d{1,2}", (1, 31)),
    "0D": (r"\d{2}", (1, 31)),
    "MINOR": (r"\d+", None),
    "MICRO": (r"\d+", None),
}


class CheckError(Exception):
    """A bad argument, or a git or file error: exit 1."""


class Commit(NamedTuple):
    short: str
    subject: str
    body: str


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(1, "version_check: %s\n" % message)


def parse_args(argv):
    parser = Parser()
    parser.add_argument("version", metavar="NEW_VERSION")
    parser.add_argument("--scheme", choices=("semver", "calver"), default="semver")
    parser.add_argument("--format", help="calver format, such as YYYY.MM.MICRO")
    parser.add_argument("--changelog", help="default CHANGELOG.md when that file exists")
    parser.add_argument("--ref", default="HEAD")
    return parser.parse_args(argv)


def git(*args):
    done = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8",
                          check=False)
    if done.returncode != 0:
        raise CheckError(done.stderr.strip() or "git %s failed" % args[0])
    return done.stdout


def strip_v(text):
    return text[1:] if text.startswith("v") else text


def calver_tokens(args):
    """The --format tokens for calver, None for semver."""
    if args.scheme == "semver":
        if args.format is not None:
            raise CheckError("--format applies only to --scheme calver")
        return None
    if args.format is None:
        raise CheckError("--scheme calver needs --format")
    tokens = args.format.split(".")
    unknown = [t for t in tokens if t not in CALVER_TOKENS]
    if unknown:
        raise CheckError("unknown calver token(s): %s" % ", ".join(unknown))
    return tokens


def parse(text, scheme, tokens):
    """The version's numbers as a tuple, or None when it does not fit the scheme."""
    if scheme == "semver":
        m = SEMVER.fullmatch(text)
        return tuple(int(n) for n in m.groups()) if m else None
    pattern = r"\.".join("(%s)" % CALVER_TOKENS[t][0] for t in tokens)
    m = re.fullmatch(pattern, text, re.ASCII)
    if not m:
        return None
    numbers = tuple(int(n) for n in m.groups())
    for token, number in zip(tokens, numbers):
        bounds = CALVER_TOKENS[token][1]
        if bounds and not bounds[0] <= number <= bounds[1]:
            return None
    return numbers


def last_release(ref, scheme, tokens, new):
    """(tag, version) of the newest release tag reachable from ref, or None.

    A tag of the new version itself is skipped, so a release made from a tag that
    already exists is checked against the release before it.
    """
    releases = []
    for tag in git("tag", "--merged", ref).split():
        version = parse(strip_v(tag), scheme, tokens)
        if version is not None and version != new:
            releases.append((version, tag))
    if not releases:
        return None
    version, tag = max(releases)
    return tag, version


def read_commits(last_tag, ref):
    """The non-merge commits from last_tag to ref, skipping GitHub's merge lines."""
    out = git("log", "%s..%s" % (last_tag, ref), "--no-merges", "--format=%H%x00%s%x00%b%x1e")
    commits = []
    for record in out.split("\x1e"):
        fields = record.lstrip("\n").split("\x00")
        if len(fields) != 3 or fields[1].startswith("Merge pull request"):
            continue
        commits.append(Commit(fields[0][:7], fields[1], fields[2]))
    return commits


def commit_type(subject):
    header = HEADER.match(subject)
    return header.group("type") if header else None


def commit_level(subject, body, pre_1):
    """The size one commit needs: major, minor, patch or none."""
    header = HEADER.match(subject)
    if (header and header.group("bang")) or BREAKING.search(body):
        level = "major"
    else:
        level = TYPE_LEVEL.get(commit_type(subject), "none")
    return DEMOTED.get(level, level) if pre_1 else level


def size_of(new, last):
    """The part of the version that grew first: major, minor or patch. NEW is after LAST."""
    return SIZE_NAMES[next(i for i, (n, o) in enumerate(zip(new, last)) if n != o)]


def listing(commits):
    shown = ["%s %s" % (c.short, c.subject) for c in commits[:MAX_LISTED]]
    if len(commits) > MAX_LISTED:
        shown.append("and %d more" % (len(commits) - MAX_LISTED))
    return "; ".join(shown)


def find_section(text, bare):
    """The changelog section for the version, or None when there is none."""
    m = re.search(r"^## \[v?%s\].*$" % re.escape(bare), text, re.MULTILINE)
    if not m:
        return None
    nxt = re.search(r"^## ", text[m.end():], re.MULTILINE)
    return text[m.end():m.end() + nxt.start()] if nxt else text[m.end():]


def changelog_reasons(path, bare, size, commits):
    with open(path, encoding="utf-8") as fh:
        section = find_section(fh.read(), bare)
    if section is None:
        return ["%s: no section for %s" % (path, bare)]
    headings = set(re.findall(r"^### ([^\n]+?)[ \t]*$", section, re.MULTILINE))
    reasons = []
    if size == "major" and "Breaking" not in headings:
        reasons.append("a major needs ### Breaking")
    if size == "minor" and "Breaking" in headings:
        reasons.append("a minor must not have ### Breaking")
    if size == "patch" and headings - PATCH_HEADINGS:
        extra = ", ".join("### " + h for h in sorted(headings - PATCH_HEADINGS))
        reasons.append("a patch may hold only ### Fixed and ### Security, not %s" % extra)
    has_feat = any(commit_type(c.subject) == "feat" for c in commits)
    if has_feat and not headings & {"Added", "Changed"}:
        reasons.append("a feat commit needs ### Added or ### Changed")
    return ["%s: %s" % (path, reason) for reason in reasons]


def semver_reasons(args, new, last):
    last_tag, last_version = last
    size = size_of(new, last_version)
    pre_1 = last_version[0] == 0
    commits = read_commits(last_tag, args.ref)
    levels = [commit_level(c.subject, c.body, pre_1) for c in commits]
    required = max(levels, key=RANK.get, default="none")
    reasons = []
    if RANK[size] < RANK[required]:
        needing = [c for c, level in zip(commits, levels) if level == required]
        reasons.append("%s is a %s, but its commits need a %s: %s"
                       % (args.version, size, required, listing(needing)))
    path = changelog_path(args)
    if path is not None:
        reasons += changelog_reasons(path, strip_v(args.version), size, commits)
    return reasons


def changelog_path(args):
    if args.changelog is not None:
        return args.changelog
    return "CHANGELOG.md" if os.path.exists("CHANGELOG.md") else None


def report(reasons):
    for reason in reasons:
        print(reason)
    return 2 if reasons else 0


def check(args):
    tokens = calver_tokens(args)
    new = parse(strip_v(args.version), args.scheme, tokens)
    if new is None:
        expected = args.format or "X.Y.Z"
        return report(["%s does not fit %s %s" % (args.version, args.scheme, expected)])
    last = last_release(args.ref, args.scheme, tokens, new)
    if last is None:
        print("first release: no earlier tag to compare %s with" % args.version)
        return 0
    last_tag, last_version = last
    if new <= last_version:
        return report(["%s is not after %s" % (args.version, last_tag)])
    if args.scheme == "calver":
        return 0
    return report(semver_reasons(args, new, last))


def main(argv):
    try:
        return check(parse_args(argv))
    except (CheckError, OSError) as e:
        print("version_check: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
