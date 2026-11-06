"""Counts the lines a person wrote by hand in some repos, from git history, so
the code-style profile can point at that person's own code. It runs `git log`
and `git cat-file` only, never anything from the repos. Standard library,
Python 3.8+.

    python engine/authored.py --before YYYY-MM-DD [--email ADDRESS ...] [--top N] REPO...

Counts non-merge commits dated before the cutoff (the author's date, in the
author's own time zone) by the given emails, case-insensitive, or by every
author when no --email is given. Prints one line of JSON: the languages by
lines added, each with its top files and the commit that still holds each
file, for `git show <commit>:<path>`. {"error": message} with exit status 1
on failure.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
from collections import Counter

LANGUAGES = {
    "dart": "Dart", "cs": "C#", "c": "C", "h": "C",
    "cpp": "C++", "cc": "C++", "hpp": "C++", "hh": "C++", "inl": "C++",
    "js": "JavaScript", "mjs": "JavaScript", "jsx": "JavaScript",
    "ts": "TypeScript", "tsx": "TypeScript", "py": "Python",
    "kt": "Kotlin", "swift": "Swift", "java": "Java",
    "go": "Go", "rs": "Rust", "rb": "Ruby", "php": "PHP", "lua": "Lua", "gd": "GDScript",
}
# A path with any of these as a whole segment holds vendored or generated code.
IGNORED_SEGMENTS = frozenset([
    "vendor", "third_party", "ThirdParty", "external", "dependences", "dependencies",
    "node_modules", "Packages", "Plugins", "build", "dist", "generated",
])
# App scaffolding a framework generates for each platform (Flutter, React Native).
SCAFFOLD_FOLDERS = ("windows/runner/", "linux/runner/", "linux/flutter/", "macos/Runner/",
                    "ios/Runner/", "android/app/src/")
IGNORED_ENDINGS = (".g.dart", ".freezed.dart", ".gr.dart", ".min.js", ".designer.cs")
DEFAULT_TOP = 6
# At most this many files per repo and language, while another repo has candidates.
PER_REPO_CAP = 2


class AuthoredError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    """Raises instead of printing usage and exiting, so a bad call prints JSON."""

    def error(self, message):
        raise AuthoredError(message)


def _date(text):
    try:
        return datetime.datetime.strptime(text, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise argparse.ArgumentTypeError("--before needs a date as YYYY-MM-DD: " + text)


def _count(text):
    if not text.isdigit() or int(text) < 1:
        raise argparse.ArgumentTypeError("--top needs a whole number of 1 or more: " + text)
    return int(text)


def _parse(argv):
    parser = _Parser(description="Count the lines a person wrote by hand, per language.")
    parser.add_argument("--before", required=True, type=_date, metavar="YYYY-MM-DD")
    parser.add_argument("--email", action="append", default=[])
    parser.add_argument("--top", type=_count, default=DEFAULT_TOP)
    parser.add_argument("repos", nargs="+", metavar="REPO")
    return parser.parse_args(argv)


def language_of(path):
    """The language a file's added lines count for, or None when they do not count."""
    if IGNORED_SEGMENTS.intersection(path.split("/")) or path.endswith(IGNORED_ENDINGS):
        return None
    if any("/" + folder in "/" + path for folder in SCAFFOLD_FOLDERS):
        return None
    return LANGUAGES.get(os.path.splitext(path)[1][1:].lower())


def _git(repo, *args):
    cmd = ["git", "-C", repo, "-c", "core.quotePath=false", *args]
    try:
        done = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
    except OSError as e:
        raise AuthoredError("cannot run git: %s" % e)
    if done.returncode != 0:
        raise AuthoredError("git %s failed in %s: %s" % (args[0], repo, done.stderr.strip()))
    return done.stdout


def _holds(repo, commit, path):
    done = subprocess.run(["git", "-C", repo, "cat-file", "-e", commit + ":" + path],
                          capture_output=True)
    return done.returncode == 0


def _header(line, before, emails):
    """A commit that counts as a dict, or None for one that does not."""
    fields = line.split("\t")
    if len(fields) != 4:
        return None
    _, commit, email, date = fields
    if date >= before or (emails and email.lower() not in emails):
        return None
    return {"hash": commit, "files": []}


def _add_numstat(commit, line):
    # Binary files show "-" instead of counts, so only numeric rows count.
    fields = line.split("\t", 2)
    if len(fields) == 3 and fields[0].isdigit():
        commit["files"].append((fields[2], int(fields[0])))


def _commits(repo, before, emails):
    """The commits that count, newest first, each with its (path, added lines) pairs."""
    text = _git(repo, "log", "--all", "--no-merges", "--no-renames", "--no-ext-diff",
                "--numstat", "--date=short", "--format=C%x09%H%x09%ae%x09%ad")
    commits, current = [], None
    for line in text.splitlines():
        if line.startswith("C\t"):
            current = _header(line, before, emails)
            if current is not None:
                commits.append(current)
        elif current is not None:
            _add_numstat(current, line)
    return commits


def _tally(repo, commits, totals):
    """Adds each commit's added lines to totals, keyed by language."""
    for commit in commits:
        for path, added in commit["files"]:
            name = language_of(path)
            if name is None:
                continue
            total = totals.setdefault(name, {"lines": 0, "repos": set(), "files": {}})
            total["lines"] += added
            total["repos"].add(repo)
            entry = total["files"].setdefault(
                (repo, path), {"repo": repo, "path": path, "lines": 0, "hashes": []})
            entry["lines"] += added
            entry["hashes"].append(commit["hash"])


def _newest_commit(entry):
    """The newest commit of the entry that still holds its file, or None."""
    for commit in entry["hashes"]:
        if _holds(entry["repo"], commit, entry["path"]):
            return commit
    return None


def pick_files(entries, top):
    """The top entries by lines, each given its commit. At most PER_REPO_CAP per repo
    while another repo has candidates left. An entry no commit still holds is skipped."""
    picked, considered, per_repo = [], set(), Counter()
    for capped in (True, False):
        for index, entry in enumerate(entries):
            if len(picked) == top:
                break
            if index in considered or (capped and per_repo[entry["repo"]] >= PER_REPO_CAP):
                continue
            considered.add(index)
            commit = _newest_commit(entry)
            if commit is not None:
                entry["commit"] = commit
                picked.append(entry)
                per_repo[entry["repo"]] += 1
    return sorted(picked, key=lambda e: -e["lines"])


def _row(entry):
    return {"repo": entry["repo"], "path": entry["path"],
            "lines": entry["lines"], "commit": entry["commit"]}


def _languages(totals, top):
    rows = []
    for name, total in totals.items():
        entries = sorted(total["files"].values(),
                         key=lambda e: (-e["lines"], e["repo"], e["path"]))
        rows.append({
            "language": name,
            "lines": total["lines"],
            "repos": len(total["repos"]),
            "files": [_row(e) for e in pick_files(entries, top)],
        })
    return sorted(rows, key=lambda r: (-r["lines"], r["language"]))


def _root(repo):
    if not os.path.isdir(repo):
        raise AuthoredError("not a folder: " + repo)
    return os.path.abspath(repo)


def survey(before, emails, top, repos):
    totals, commit_count = {}, 0
    for root in dict.fromkeys(_root(repo) for repo in repos):
        commits = _commits(root, before, emails)
        commit_count += len(commits)
        _tally(root, commits, totals)
    return {"before": before, "languages": _languages(totals, top), "commits": commit_count}


def run(argv):
    args = _parse(argv)
    emails = {address.lower() for address in args.email}
    return survey(args.before, emails, args.top, args.repos)


def main(argv):
    try:
        result = run(argv)
    except (AuthoredError, OSError) as e:
        result = {"error": str(e)}
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
