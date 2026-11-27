"""Tests for the release version check: .github/scripts/version_check.py and the
.claude/hooks/version-check.py hook that runs it before a release command.

Each case builds a throwaway git repo with one `git fast-import` call (no hooks
run, so the machine's own git hooks cannot slow or change it), then runs the
script or the hook on it the way a session does.
"""

import importlib.util
import itertools
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, ".github", "scripts", "version_check.py")
HOOK = os.path.join(ROOT, "_core", "project-template", ".claude", "hooks", "version-check.py")
HELPER = os.path.join(ROOT, "helper")
QUIET_GIT = ["git", "-c", "core.hooksPath="]


def in_parallel(run, rows):
    """run(row) for every row at once, in row order: each waits on its own processes."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(run, rows))


def commit_block(mark, message, branch, parents=()):
    """One fast-import commit; the first parent continues the branch, the rest merge in."""
    data = message.encode("utf-8")
    lines = [b"commit refs/heads/" + branch.encode(), b"mark :%d" % mark,
             b"committer Test <test@example.invalid> %d +0000" % (1700000000 + mark),
             b"data %d" % len(data), data]
    if parents:
        lines.append(b"from :%d" % parents[0])
        lines += [b"merge :%d" % parent for parent in parents[1:]]
    return b"\n".join(lines) + b"\n\n"


def tag_block(name, mark):
    return b"reset refs/tags/%s\nfrom :%d\n\n" % (name.encode(), mark)


def import_repo(stream, branch="main"):
    """A new repo holding the fast-import stream, with `branch` checked out; returns its folder."""
    folder = tempfile.TemporaryDirectory()
    init = QUIET_GIT + ["-c", "init.defaultBranch=" + branch, "init", "-q", "--template="]
    subprocess.run(init, cwd=folder.name, check=True)
    subprocess.run(QUIET_GIT + ["fast-import", "--quiet"], cwd=folder.name, check=True,
                   input=stream, capture_output=True)
    return folder


def make_repo(tag, commits, changelog=None, end_tags=(), branch="main"):
    """`tag` on a first commit, one commit per message after it, then `end_tags` on the last."""
    messages = ["chore: start"] + list(commits)
    stream = b"".join(commit_block(mark, message, branch)
                      for mark, message in enumerate(messages, 1))
    if tag:
        stream += tag_block(tag, 1)
    stream += b"".join(tag_block(name, len(messages)) for name in end_tags)
    folder = import_repo(stream, branch)
    if changelog is not None:
        with open(os.path.join(folder.name, "CHANGELOG.md"), "w", encoding="utf-8") as fh:
            fh.write(changelog)
    return folder


def check(repo, *args):
    done = subprocess.run([sys.executable, "-I", SCRIPT, *args], cwd=repo, capture_output=True,
                          text=True, encoding="utf-8")
    return done.returncode, done.stdout


def section(heading, *headings):
    body = "".join("\n### %s\n\n- change\n" % h for h in headings)
    return "## [%s]\n%s" % (heading, body)


class SemverRules(unittest.TestCase):
    # name, tag, commits after it, NEW version, changelog or None, exit code, texts in the output
    ROWS = [
        ("feat needs minor and a changelog Added or Changed; the v5.2.2 case",
         "v5.2.1", ["feat(mods): add the task panel", "chore(release): v5.2.2"], "v5.2.2",
         section("v5.2.2", "Fixed"), 2,
         ["patch, but its commits need a minor", "feat(mods): add the task panel",
          "### Added or ### Changed"]),
        ("feat with Added is allowed as a minor",
         "v5.2.2", ["feat(mods): add the task panel", "chore(release): v5.3.0"], "v5.3.0",
         section("v5.3.0", "Added"), 0, []),
        ("fix alone is allowed as a patch with Fixed",
         "v5.2.1", ["fix(tasks): keep the queue"], "v5.2.2", section("v5.2.2", "Fixed"), 0, []),
        ("a fix! needs a major, so a minor is refused",
         "v5.2.1", ["fix!: drop the old flag"], "v5.3.0", None, 2,
         ["need a major", "fix!: drop the old flag"]),
        ("a BREAKING CHANGE body needs a major, which takes Breaking",
         "v5.2.1", ["chore(api): rename the flag\n\nBREAKING CHANGE: the old flag is gone"],
         "v6.0.0", section("v6.0.0", "Breaking"), 0, []),
        ("a major without a Breaking heading is refused",
         "v5.2.1", ["fix!: drop the old flag"], "v6.0.0", section("v6.0.0", "Fixed"), 2,
         ["a breaking change needs ### Breaking"]),
        ("a major needs Breaking even with no breaking commit",
         "v5.2.1", ["feat: add a flag"], "v6.0.0", section("v6.0.0", "Added"), 2,
         ["a major needs ### Breaking"]),
        ("a minor may not hold Breaking",
         "v5.2.1", ["feat: add a flag"], "v5.3.0", section("v5.3.0", "Added", "Breaking"), 2,
         ["a minor must not have ### Breaking"]),
        ("a patch may hold only Fixed and Security",
         "v5.2.1", ["fix: keep the queue"], "v5.2.2", section("v5.2.2", "Added"), 2,
         ["a patch may hold only ### Fixed and ### Security, not ### Added"]),
        ("a patch with Security is allowed",
         "v5.2.1", ["fix: close a hole"], "v5.2.2", section("v5.2.2", "Fixed", "Security"), 0, []),
        ("before 1.0.0 a feat! is a minor",
         "v0.4.0", ["feat!: replace the parser"], "v0.5.0", None, 0, []),
        ("before 1.0.0 a feat needs only a patch",
         "v0.4.0", ["feat: add a flag"], "v0.4.1", None, 0, []),
        ("before 1.0.0 a patch that adds takes Added",
         "v0.4.0", ["feat: add a flag"], "v0.4.1", section("v0.4.1", "Added"), 0, []),
        ("before 1.0.0 a minor that breaks takes Breaking",
         "v0.4.0", ["feat!: replace the parser"], "v0.5.0", section("v0.5.0", "Added", "Breaking"),
         0, []),
        ("before 1.0.0 a breaking change still needs Breaking",
         "v0.4.0", ["feat!: replace the parser"], "v0.5.0", section("v0.5.0", "Added"), 2,
         ["a breaking change needs ### Breaking"]),
        ("before 1.0.0 a patch may not hold Breaking",
         "v0.4.0", ["fix: keep the queue"], "v0.4.1", section("v0.4.1", "Fixed", "Breaking"), 2,
         ["a patch must not have ### Breaking"]),
        ("1.0.0 needs no Breaking when nothing breaks",
         "v0.9.0", ["feat: add a flag"], "v1.0.0", section("v1.0.0", "Added"), 0, []),
        ("a changelog section is required when the file exists",
         "v5.2.1", ["fix: keep the queue"], "v5.2.2", "## [v5.2.1]\n", 2, ["no section for 5.2.2"]),
        ("the section may be named without v",
         "v5.2.1", ["fix: keep the queue"], "5.2.2", section("5.2.2", "Fixed"), 0, []),
        ("a version before the last tag is refused",
         "v5.2.1", [], "v5.2.0", None, 2, ["v5.2.0 is not after v5.2.1"]),
        ("a version that does not fit semver is refused",
         "v5.2.1", [], "v5.2", None, 2, ["does not fit semver X.Y.Z"]),
        ("merge lines and GitHub merge messages are ignored",
         "v5.2.1", ["Merge pull request #9 from a/b\n\nBREAKING CHANGE: none"], "v5.2.2",
         None, 0, []),
    ]

    @staticmethod
    def run_row(row):
        _, tag, commits, new, changelog, _, _ = row
        with make_repo(tag, commits, changelog) as repo:
            return check(repo, new)

    def test_rows(self):
        results = in_parallel(self.run_row, self.ROWS)
        for (name, _, _, _, _, code, texts), (got_code, out) in zip(self.ROWS, results):
            with self.subTest(name):
                self.assertEqual(got_code, code, out)
                for text in texts:
                    self.assertIn(text, out)
                if code == 0:
                    self.assertEqual(out, "", "an allowed version prints nothing")

    def test_no_tag_is_the_first_release(self):
        with make_repo(None, ["feat!: anything"]) as repo:
            self.assertEqual(check(repo, "v1.0.0"),
                             (0, "first release: no earlier tag to compare v1.0.0 with\n"))

    def test_the_newest_tag_by_version_is_the_last_release(self):
        # By name v5.10.0 sorts before v5.9.0; by version it is the newer release.
        with make_repo("v5.9.0", ["feat: b"], end_tags=["v5.10.0"]) as repo:
            self.assertEqual(check(repo, "v5.10.1"), (0, ""))

    def test_a_tag_of_the_new_version_is_checked_against_the_one_before(self):
        # A release published from a tag that already exists, as `gh release create` does.
        with make_repo("v5.2.1", ["feat: add a flag"], end_tags=["v5.2.2"]) as repo:
            code, out = check(repo, "v5.2.2")
            self.assertEqual(code, 2)
            self.assertIn("patch, but its commits need a minor", out)

    def test_merge_commits_are_skipped(self):
        stream = (commit_block(1, "chore: start", "main") + tag_block("v5.2.1", 1)
                  + commit_block(2, "docs: notes", "side", parents=(1,))
                  + commit_block(3, "feat!: merged work", "main", parents=(1, 2)))
        with import_repo(stream) as repo:
            self.assertEqual(check(repo, "v5.2.2"), (0, ""))

    def test_more_than_five_commits_are_cut_short(self):
        with make_repo("v5.2.1", ["feat: %d" % i for i in range(7)]) as repo:
            code, out = check(repo, "v5.2.2")
            self.assertEqual(code, 2)
            self.assertIn("and 2 more", out)

    def test_a_commit_message_that_is_not_utf8_is_read(self):
        stream = (commit_block(1, "chore: start", "main") + tag_block("v5.2.1", 1)
                  + commit_block(2, "feat: cafe", "main", parents=(1,)).replace(b"cafe", b"caf\xe9"))
        with import_repo(stream) as repo:
            code, out = check(repo, "v5.2.2")
            self.assertEqual(code, 2, out)
            self.assertIn("feat: caf\ufffd", out)

    def test_a_subfolder_reads_the_root_changelog(self):
        with make_repo("v5.2.1", ["fix: keep the queue"], "## [v5.2.1]\n") as repo:
            subfolder = os.path.join(repo, "src")
            os.makedirs(subfolder)
            code, out = check(subfolder, "v5.2.2")
            self.assertEqual(code, 2, out)
            self.assertIn("no section for 5.2.2", out)

    def test_a_bare_repo_is_checked_as_semver(self):
        with make_repo("v5.2.1", ["feat: add a flag"]) as repo, \
                tempfile.TemporaryDirectory() as bare:
            subprocess.run(QUIET_GIT + ["clone", "-q", "--bare", repo, bare],
                           check=True, capture_output=True)
            code, out = check(bare, "v5.2.2", "--ref", "main")
            self.assertEqual(code, 2, out)
            self.assertIn("need a minor", out)

    def test_a_shallow_clone_is_exit_1(self):
        with make_repo("v5.2.1", ["feat: add a flag"]) as repo,                 tempfile.TemporaryDirectory() as clone:
            subprocess.run(QUIET_GIT + ["clone", "-q", "--depth", "1", pathlib.Path(repo).as_uri(), clone],
                           check=True, capture_output=True)
            self.assertEqual(check(clone, "v5.2.2"), (1, ""))

    def test_a_bad_argument_or_a_missing_changelog_is_exit_1(self):
        with make_repo("v5.2.1", []) as repo:
            self.assertEqual(check(repo, "v5.2.2", "--changelog", "NOPE.md")[0], 1)
            self.assertEqual(check(repo, "v5.2.2", "--format", "YYYY")[0], 1)
            self.assertEqual(check(repo)[0], 1)


class PreReleaseRules(unittest.TestCase):
    # name, tag, commits after it, tags on the last commit, NEW version, changelog or None,
    # exit code, texts in the output
    ROWS = [
        ("a beta after a stable release and a feat needs only a minor",
         "v1.2.0", ["feat: add a flag"], [], "v1.3.0-beta.1", None, 0, []),
        ("a pre-release of a patch is refused when its commits need a minor",
         "v1.2.0", ["feat: add a flag"], [], "v1.2.1-beta.1", None, 2, ["need a minor"]),
        ("a pre-release of a released version is not after it",
         "v1.2.0", [], [], "v1.2.0-rc.1", None, 2, ["v1.2.0-rc.1 is not after v1.2.0"]),
        ("a pre-release sorts after the earlier pre-releases of its version",
         "v1.2.0", ["feat: add a flag"], ["v1.3.0-alpha.2"], "v1.3.0-beta.1", None, 0, []),
        ("an earlier pre-release is not after the newest one",
         "v1.2.0", ["feat: add a flag"], ["v1.3.0-alpha.2"], "v1.3.0-alpha.1", None, 2,
         ["v1.3.0-alpha.1 is not after v1.3.0-alpha.2"]),
        ("numeric pre-release identifiers compare as numbers",
         "v1.2.0", ["feat: add a flag"], ["v1.3.0-beta.2"], "v1.3.0-beta.11", None, 0, []),
        ("beta.11 sorts before rc.1: the first identifiers differ by name",
         "v1.2.0", ["feat: add a flag"], ["v1.3.0-beta.11"], "v1.3.0-rc.1", None, 0, []),
        ("the release sorts after its rc and takes an Added heading",
         "v1.2.0", ["feat: add a flag"], ["v1.3.0-rc.1"], "v1.3.0", section("v1.3.0", "Added"),
         0, []),
        ("the release is checked for its Added or Changed heading",
         "v1.2.0", ["feat: add a flag"], ["v1.3.0-rc.1"], "v1.3.0", section("v1.3.0", "Fixed"),
         2, ["### Added or ### Changed"]),
        ("a pre-release needs no changelog section",
         "v1.2.0", ["feat: add a flag"], [], "v1.3.0-beta.1", "## [v1.2.0]\n", 0, []),
        ("a build suffix is ignored, and the changelog heading has no suffix",
         "v1.2.0", ["feat: add a flag"], [], "v1.3.0+build.5", section("v1.3.0", "Added"), 0, []),
        ("a leading zero in a numeric pre-release identifier does not fit",
         "v1.2.0", [], [], "v1.3.0-01", None, 2, ["does not fit semver X.Y.Z[-pre][+build]"]),
        ("an empty pre-release does not fit",
         "v1.2.0", [], [], "v1.3.0-", None, 2, ["does not fit semver X.Y.Z[-pre][+build]"]),
        ("with no stable tag, a pre-release that sorts after the tag passes silently",
         "v0.1.0-alpha.1", ["fix: keep the queue"], [], "v0.1.0-alpha.2", None, 0, []),
        ("with no stable tag, a pre-release is still checked for its order",
         "v0.1.0-alpha.2", [], [], "v0.1.0-alpha.1", None, 2,
         ["v0.1.0-alpha.1 is not after v0.1.0-alpha.2"]),
    ]

    @staticmethod
    def run_row(row):
        _, tag, commits, end_tags, new, changelog, _, _ = row
        with make_repo(tag, commits, changelog, end_tags) as repo:
            return check(repo, new)

    def test_rows(self):
        results = in_parallel(self.run_row, self.ROWS)
        for (name, _, _, _, _, _, code, texts), (got_code, out) in zip(self.ROWS, results):
            with self.subTest(name):
                self.assertEqual(got_code, code, out)
                for text in texts:
                    self.assertIn(text, out)
                if code == 0:
                    self.assertEqual(out, "", "an allowed version prints nothing")


class CalverRules(unittest.TestCase):
    FORMAT =["--scheme", "calver", "--format", "YYYY.MM.MICRO"]
    # name, tag, NEW version, exit code, text in the output
    ROWS = [
        ("a later month is allowed", "2026.10.3", "2026.11.0", 0, ""),
        ("a month above 12 does not fit the format", "2026.10.3", "2026.13.0", 2,
         "does not fit calver"),
        ("a micro not after the tag is refused", "2026.10.3", "2026.10.2", 2,
         "not after 2026.10.3"),
    ]

    @classmethod
    def run_row(cls, row):
        _, tag, new, _, _ = row
        with make_repo(tag, []) as repo:
            return check(repo, new, *cls.FORMAT)

    def test_rows(self):
        results = in_parallel(self.run_row, self.ROWS)
        for (name, _, _, code, text), (got_code, out) in zip(self.ROWS, results):
            with self.subTest(name):
                self.assertEqual(got_code, code, out)
                if text:
                    self.assertIn(text, out)
                else:
                    self.assertEqual(out, "")

    def test_without_a_scheme_the_saved_answers_pick_it(self):
        # A feat! would need a major under semver; calver only checks the format and the order.
        rows = [("YYYY.MM.MICRO", "2026.10.3", "2026.11.0"), ("YYYY.MM", "2026.10", "2026.11")]
        for fmt, tag, new in rows:
            with self.subTest(fmt), make_repo(tag, ["feat!: drop the flag"]) as repo:
                as_project(repo, "calver", fmt)
                self.assertEqual(check(repo, new), (0, ""))
                subfolder = os.path.join(repo, "src")
                os.makedirs(subfolder)
                self.assertEqual(check(subfolder, new), (0, ""), "run from a subfolder")

    def test_a_bad_format_is_exit_1(self):
        with make_repo("2026.10.3", []) as repo:
            bad_format = ["--scheme", "calver", "--format", "YYYY.XX"]
            self.assertEqual(check(repo, "2026.11.0", *bad_format)[0], 1)


def as_project(repo, versioning, fmt=None):
    """Makes the repo a bound project: saved answers and the check script."""
    os.makedirs(os.path.join(repo, ".bindwright"))
    answers = {"advanced": {"versioning": versioning, "versionFormat": fmt}}
    with open(os.path.join(repo, ".bindwright", "project.json"), "w", encoding="utf-8") as fh:
        json.dump(answers, fh)
    os.makedirs(os.path.join(repo, ".github", "scripts"))
    shutil.copy(SCRIPT, os.path.join(repo, ".github", "scripts"))


def local_env(**extra):
    """A local session's environment, also when the suite itself runs in GitHub Actions."""
    env = {key: value for key, value in os.environ.items() if key != "GITHUB_ACTIONS"}
    env.update(extra)
    return env


def run_hook(repo, command, tool="Bash", helper=HELPER, **extra_env):
    event = json.dumps({"tool_name": tool, "tool_input": {"command": command}, "cwd": repo})
    # The hook reads commands with the helper's shell parser; here, the repo's own copy.
    env = local_env(CLAUDE_PROJECT_DIR=repo, BINDWRIGHT_HELPER=helper, **extra_env)
    done = subprocess.run([sys.executable, "-I", HOOK], input=event, capture_output=True,
                          text=True, encoding="utf-8", env=env)
    return done.returncode, done.stderr


class Hook(unittest.TestCase):
    # The v5.2.2 case: a feat since v5.2.1, so a patch is refused and a minor allowed.
    COMMITS = ["feat(mods): add the task panel"]
    CHANGELOG = section("v5.2.2", "Fixed") + section("v5.3.0", "Added")
    # name, command, exit code
    ROWS = [
        ("a tag too small for its commits", "git tag v5.2.2", 2),
        ("an annotated tag of the right size", "git tag -a v5.3.0 -m 'Release v5.3.0'", 0),
        ("a release created from a tag too small", "gh release create v5.2.2 --notes-file n.md", 2),
        ("a release PR from a release branch named by --head",
         "gh pr create --base main --head release/v5.2.2 --title x", 2),
        ("a refused tag after another statement", "git push -q && git tag v5.2.2", 2),
        ("a tag after git's own options", "git -C . tag v5.2.2", 2),
        ("a tag whose options are clustered, message first", 'git tag -am "v5.2.2" v5.2.2', 2),
        ("a release PR whose head is attached with =", "gh pr create --head=release/v5.2.2", 2),
        ("a clustered list of tags", "git tag -ln v5.2.2", 0),
        ("a list with an attached line count", "git tag -n9 v5.2.2", 0),
        ("a list filtered by a commit", "git tag --merged main v5.2.2", 0),
        ("a release with the repo option before its group", "gh -R o/r release create v5.2.2", 2),
        ("a release PR with the repo option before its group",
         "gh --repo o/r pr create --head release/v5.2.2", 2),
        ("a list filtered by a prefix of a filter option", "git tag --cont HEAD v5.2.2", 0),
        ("a release command inside a quoted message",
         'git commit -m "docs: release steps\ngit tag v5.2.2\nthen push"', 0),
        ("a release command inside a here-document", "cat > notes.md <<EOF\ngit tag v5.2.2\nEOF", 0),
        ("an annotated tag with a message of two words", 'git tag -a v5.3.0 -m "Release v5.3.0"', 0),
        ("a release command inside a commit message", 'git commit -m "docs: run git tag v5.2.2 first"', 0),
        ("a release command inside a PR body", 'gh pr create --body "After merge: git tag v5.2.2"', 0),
        ("a tag after a message holding a bracket", 'git tag -m "notes (final)" v5.2.2', 2),
        ("a tag after a message holding a pipe", 'git tag -am "a | b" v5.2.2', 2),
        ("a tag after a message holding a hash", "git tag -m x#y v5.2.2", 2),
        ("a tag with its errors redirected", "git tag v5.2.2 2>&1 | tail -1", 2),
        ("a release command in a comment", "# then: git tag v5.2.2", 0),
        ("a release command after a comment's line", "echo hi # note\ngit tag v5.2.2", 2),
        ("a version built at run time", "git tag $NEXT", 0),
        ("a commit held in a variable", "git tag v5.2.2 $SHA", 0),
        ("a commit from a quoted substitution", 'git tag v5.2.2 "$(git rev-parse origin/main)"', 0),
        ("a commit from a bare substitution", "git tag v5.2.2 $(git rev-parse origin/main)", 0),
        ("a commit from backticks", "git tag v5.2.2 `git rev-parse origin/main`", 0),
        ("a substitution with quotes of its own in the message",
         'git tag -a v5.2.2 -m "notes: $(git log -1 --format="%s %b")"', 2),
        ("a target held in a variable", "gh release create v5.2.2 --target $BRANCH", 0),
        ("a release PR head held in a variable", "gh pr create --base main --head $BRANCH", 0),
        ("a release that uploads its assets by a glob", "gh release create v5.2.2 dist/*.zip", 2),
        ("a release whose asset path is built at run time",
         'gh release create v5.2.2 "build/app-$ARCH.zip"', 2),
        ("a release whose notes are built at run time", 'gh release create v5.2.2 --notes="$NOTES"', 2),
        ("a tag whose message is built at run time, attached with =", 'git tag v5.2.2 --message="$MSG"', 2),
        ("a tag whose message is built at run time, attached to -m", 'git tag v5.2.2 -m"$MSG"', 2),
        ("a release with an option built at run time", "gh release create v5.2.2 $FLAGS", 0),
        ("a tag with an option built at run time", "git tag $FLAG v5.2.2", 0),
        ("a target attached with = and held in a variable",
         "gh release create v5.2.2 --target=$BRANCH", 0),
        ("a release PR head attached with = and held in a variable", "gh pr create --head=$BRANCH", 0),
        ("a tag whose here-document body holds an apostrophe",
         "git tag -a v5.2.2 -F - <<'EOF'\nIt's the release\nEOF", 2),
        ("a tag after a here-document whose body holds an apostrophe",
         "cat > notes.md <<-EOF\n\tit's done\n\tEOF\ngit tag v5.2.2", 2),
        ("a statement starting with an assignment", "A=1 git tag v5.2.2", 2),
        ("a release made with gh's new alias", "gh release new v5.2.2", 2),
        ("a release PR made with gh's new alias", "gh pr new --head release/v5.2.2", 2),
        ("a release with the repo option before its action", "gh release -R o/r create v5.2.2", 2),
        ("git spelled in capitals", "GIT tag v5.2.2", 2),
        ("git quoted", '"git" tag v5.2.2', 2),
        ("an option whose value is optional, before the version", "git tag --color v5.2.2", 2),
        ("a quoted global option value with a space", 'git -c user.name="A B" tag v5.2.2', 2),
        ("a line continuation before tag", "git \\\n  tag v5.2.2", 2),
        ("a long option given by a unique prefix", "git tag --mes 'Release' v5.2.2", 2),
        ("a global option that takes a value", "git --attr-source HEAD tag v5.2.2", 2),
        ("a tag behind env", "env A=1 git tag v5.2.2", 2),
        ("a release behind sudo", "sudo gh release create v5.2.2", 2),
        ("a release command only printed", "echo git tag v5.2.2", 0),
        ("a pre-release tag too small for its commits", "git tag v5.2.2-beta.1", 2),
        ("a tag that is not a version", "git tag backup", 0),
        ("a tag being deleted", "git tag -d v5.2.2", 0),
        ("a PR from a work branch", "gh pr create --base develop --head feature/x", 0),
        ("an ordinary command", "git log --oneline", 0),
    ]

    def test_rows(self):
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "semver")
            results = in_parallel(lambda row: run_hook(repo, row[1]), self.ROWS)
            for (name, _, code), (got_code, err) in zip(self.ROWS, results):
                with self.subTest(name):
                    self.assertEqual(got_code, code, err)
                    if code == 2:
                        self.assertIn("Blocked release v5.2.2", err)
                        self.assertIn("feat(mods): add the task panel", err)

    def test_without_the_parser_a_command_that_may_release_is_blocked(self):
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "semver")
            rows = [("a tag of the right size", "git tag v5.3.0", 2),
                    ("a message that names a tag", 'git commit -m "fix: tag sorting"', 2),
                    ("an ordinary command", "git log --oneline", 0)]
            for (name, command, code), (got, err) in zip(
                    rows, in_parallel(lambda row: run_hook(repo, row[1], helper=repo), rows)):
                with self.subTest(name):
                    self.assertEqual(got, code, err)
                    if code == 2:
                        self.assertIn("/bindwright:setup", err)

    def test_a_release_PR_from_the_current_branch(self):
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG, branch="release/v5.2.2") as repo:
            as_project(repo, "semver")
            self.assertEqual(run_hook(repo, "gh pr create --base main", "PowerShell")[0], 2)

    def test_a_release_is_measured_at_its_tag_or_target(self):
        # v5.2.2 tags a fix; main has a feat after it, and side holds only the fix.
        stream = (commit_block(1, "chore: start", "main") + tag_block("v5.2.1", 1)
                  + commit_block(2, "fix: keep the queue", "main", parents=(1,))
                  + tag_block("v5.2.2", 2)
                  + commit_block(3, "feat: add a flag", "main", parents=(2,))
                  + commit_block(4, "fix: close a hole", "side", parents=(1,)))
        with import_repo(stream) as repo:
            as_project(repo, "semver")
            rows = [("the existing tag, with HEAD past it", "gh release create v5.2.2", 0),
                    ("a target branch without the feat", "gh release create v5.2.3 --target side", 0),
                    ("no tag and no target: HEAD", "gh release create v5.2.3", 2)]
            for (name, command, code), (got, err) in zip(
                    rows, in_parallel(lambda row: run_hook(repo, row[1]), rows)):
                with self.subTest(name):
                    self.assertEqual(got, code, err)

    def test_malformed_answers_or_input_let_every_command_run(self):
        answers = [{"advanced": "x"}, {"advanced": [1]},
                   {"advanced": {"versioning": "calver", "versionFormat": 5}}]
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "semver")
            for saved in answers:
                with open(os.path.join(repo, ".bindwright", "project.json"), "w",
                          encoding="utf-8") as fh:
                    json.dump(saved, fh)
                with self.subTest(saved=saved):
                    self.assertEqual(run_hook(repo, "git tag v5.2.2"), (0, ""))
            event = json.dumps({"tool_name": "Bash", "tool_input": ["git tag v5.2.2"], "cwd": repo})
            done = subprocess.run([sys.executable, "-I", HOOK], input=event, capture_output=True,
                                  text=True, encoding="utf-8", env=local_env())
            self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_cwd_that_is_not_text_falls_back_to_the_working_folder(self):
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "semver")
            env = local_env(BINDWRIGHT_HELPER=HELPER)
            env.pop("CLAUDE_PROJECT_DIR", None)
            for command, code in (("git log --oneline", 0), ("git tag v5.2.2", 2)):
                event = json.dumps({"tool_name": "Bash", "tool_input": {"command": command},
                                    "cwd": 5})
                done = subprocess.run([sys.executable, "-I", HOOK], input=event, cwd=repo, env=env,
                                      capture_output=True, text=True, encoding="utf-8")
                with self.subTest(command):
                    self.assertEqual(done.returncode, code, done.stderr)

    def test_a_project_without_versioning_checks_nothing(self):
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "none")
            self.assertEqual(run_hook(repo, "git tag v5.2.2"), (0, ""))

    def test_without_the_check_script_nothing_is_checked_or_needed(self):
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "semver")
            os.remove(os.path.join(repo, ".github", "scripts", "version_check.py"))
            self.assertEqual(run_hook(repo, "git tag v5.2.2", helper=repo), (0, ""))

    def test_a_ci_run_never_runs_the_checkouts_own_script(self):
        # In a CI review the checkout is the pull request's, so its script is untrusted.
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "semver")
            marker = os.path.join(repo, "ran")
            with open(os.path.join(repo, ".github", "scripts", "version_check.py"), "w",
                      encoding="utf-8") as fh:
                fh.write(f"open({marker!r}, 'w').close()\nraise SystemExit(2)\n")
            self.assertEqual(run_hook(repo, "git tag v5.2.2", GITHUB_ACTIONS="true"), (0, ""))
            self.assertFalse(os.path.exists(marker))

    def test_a_parser_reply_of_another_shape_is_unread(self):
        replies = {"an entry that is not a list": '{"commands": [null]}',
                   "a word that is a number": '{"commands": [["git", "tag", 5]]}',
                   "a word that is an object without its run-time text":
                       '{"commands": [["git", "tag", {"prefix": ""}]]}'}
        with make_repo("v5.2.1", self.COMMITS, self.CHANGELOG) as repo:
            as_project(repo, "semver")
            for name, reply in replies.items():
                stub = os.path.join(repo, "stub", name.replace(" ", "-"))
                os.makedirs(os.path.join(stub, "hooks"))
                with open(os.path.join(stub, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as fh:
                    fh.write(f"process.stdout.write({json.dumps(reply)});\n")
                with self.subTest(name):
                    code, err = run_hook(repo, "git tag v5.2.2", helper=stub)
                    self.assertEqual(code, 2, err)
                    self.assertIn("/bindwright:setup", err)

    def test_calver_reads_its_format(self):
        with make_repo("2026.10.3", []) as repo:
            as_project(repo, "calver", "YYYY.MM.MICRO")
            self.assertEqual(run_hook(repo, "git tag 2026.11.0")[0], 0)
            self.assertEqual(run_hook(repo, "git tag 2026.10.2")[0], 2)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # No __pycache__ beside the template, which the template file list would then hold.
    with mock.patch.object(sys, "dont_write_bytecode", True):
        spec.loader.exec_module(module)
    return module


def plant_git(folder):
    os.makedirs(folder, exist_ok=True)
    planted = os.path.join(folder, "git.bat" if os.name == "nt" else "git")
    pathlib.Path(planted).write_text("exit 0\n")
    os.chmod(planted, 0o755)
    return planted


def session_program(hook, session):
    """The git the hook finds for a command run in `session`."""
    with mock.patch.object(hook, "SESSION_FOLDER", session):
        return hook.trusted_program("git")


class TrustedProgram(unittest.TestCase):
    def test_a_session_below_a_repo_at_home_skips_its_own_folders(self):
        # The session folder is no repo, but the home folder above it is one: the hook keeps
        # finding programs from the session folder even after it reads the repo root at home.
        hook = load("version_check_hook", HOOK)
        with tempfile.TemporaryDirectory() as home:
            home = hook.real_path(home)
            os.makedirs(os.path.join(home, ".git"))
            session = os.path.join(home, "Downloads", "tool")
            planted, own = plant_git(os.path.join(session, "bin")), plant_git(os.path.join(home, "bin"))
            path = os.pathsep.join([os.path.dirname(planted), os.path.dirname(own)])
            with mock.patch.dict(os.environ, {"PATH": path, "HOME": home, "USERPROFILE": home}):
                found = session_program(hook, session)
            self.assertEqual(hook.real_path(found or ""), hook.real_path(own), planted)

    # A repo can ship its own git beside its code, first on PATH; the hook and the check script it
    # starts skip it and run the next git on PATH, the user's own.
    def test_a_program_anywhere_in_the_project_is_skipped_for_the_next_on_path(self):
        hook, script = load("version_check_hook", HOOK), load("version_check_script", SCRIPT)
        finders = {"the hook": lambda project: session_program(hook, project),
                   "the check script": lambda project: script.git_program.__wrapped__()}
        here = os.getcwd()
        for (name, folder, cwd), (finder, find) in itertools.product((
                ("the top folder", "", ""),
                ("a subfolder on PATH, as direnv adds", "bin", ""),
                ("a subfolder on PATH, from a session in another subfolder", "bin", "src"),
                ("the outer repo's subfolder on PATH, from a session in a submodule", "bin", "lib")),
                finders.items()):
            with self.subTest(f"{finder}: {name}"), tempfile.TemporaryDirectory() as repo, \
                    tempfile.TemporaryDirectory() as elsewhere, mock.patch.dict(os.environ):
                os.makedirs(os.path.join(repo, ".git"))
                tools, project = os.path.join(repo, folder), os.path.join(repo, cwd)
                plant_git(tools)
                own = plant_git(elsewhere)
                os.makedirs(os.path.join(project, ".git") if cwd == "lib" else project, exist_ok=True)
                os.environ["PATH"] = os.pathsep.join([tools, elsewhere, os.environ["PATH"]])
                os.chdir(project)
                try:
                    found = find(project)
                finally:
                    os.chdir(here)
                same = os.path.normcase(os.path.realpath(found or "")) == os.path.normcase(os.path.realpath(own))
                self.assertTrue(same, found)


if __name__ == "__main__":
    unittest.main()
