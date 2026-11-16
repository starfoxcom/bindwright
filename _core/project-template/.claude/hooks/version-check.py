r"""PreToolUse hook: check a release's version before it is tagged or proposed.

A release's size is easy to misjudge by hand: a new feature filed as a fix
ships as a patch. This hook reads every Bash and PowerShell command and, before
any of these runs, checks the version it names against the commits since the
last release with `.github/scripts/version_check.py`:

- `git tag <version>` (the version and an optional commit);
- `gh release create <version>`;
- `gh pr create` on a `release/<version>` branch, or with `--head` naming one.

The numbering comes from `advanced.versioning` in `.bindwright/project.json`:
`semver`, or `calver` with its `versionFormat`. With `none`, no saved answers
or no check script, every command runs. A tag that is not shaped like a version
of the scheme (`git tag backup`) is not a release, so it runs too.

The command is cut into statements at newlines, `;`, `&` and `|`, and each one
is split into words the way the shell would. It reads the commands a release
is made with; a version built at run time (`git tag $NEXT`) is out of reach.
The check refusing, or failing to run, blocks the command with its reasons.
"""

import json
import os
import re
import shlex
import subprocess
import sys

SEMVER_TAG = re.compile(r"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
CALVER_TAG = re.compile(r"v?\d+(?:\.\d+)*")
STATEMENT_END = re.compile(r"\r?\n|&&|\|\||[;&|]")
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
RELEASE_BRANCH = re.compile(r"release/(.+)")

# Options that take the next word as their value, so it is never the version.
GIT_GLOBAL_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
TAG_VALUE = {"-m", "--message", "-F", "--file", "-u", "--local-user", "--cleanup", "--color",
             "--sort", "--format", "--contains", "--no-contains", "--merged", "--no-merged",
             "--points-at", "--trailer"}
TAG_NOT_CREATING = {"-d", "--delete", "-l", "--list", "-v", "--verify", "-n"}
RELEASE_VALUE = {"-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "-R",
                 "--repo", "--discussion-category", "--notes-start-tag"}
PR_VALUE = {"-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-R",
            "--repo", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p",
            "--project", "-r", "--reviewer", "-T", "--template", "--recover"}
TIMEOUT_SECONDS = 25


def words_of(statement):
    """The statement's words as the shell splits them, or plain words when it cannot."""
    try:
        return shlex.split(statement, posix=True)
    except ValueError:
        return statement.split()


def positionals(args, value_options):
    """The arguments that are neither options nor an option's value."""
    found, skip = [], False
    for word in args:
        if skip:
            skip = False
        elif word == "--":
            continue
        elif word.startswith("-"):
            skip = word in value_options
        else:
            found.append(word)
    return found


def option_value(args, names):
    """The value given to any of `names`, as `--name value` or `--name=value`."""
    for index, word in enumerate(args):
        if word in names and index + 1 < len(args):
            return args[index + 1]
        for name in names:
            if name.startswith("--") and word.startswith(name + "="):
                return word[len(name) + 1:]
    return None


def git_subcommand(words):
    """The words after `git` and its global options, or None when this is not git."""
    if not words or os.path.basename(words[0]).lower() not in ("git", "git.exe"):
        return None
    rest = words[1:]
    while rest and rest[0].startswith("-"):
        rest = rest[2:] if rest[0] in GIT_GLOBAL_VALUE else rest[1:]
    return rest


def release_from_git(words):
    """(version, ref) when the words create a git tag, else None."""
    rest = git_subcommand(words)
    if not rest or rest[0] != "tag":
        return None
    args = rest[1:]
    if any(word in TAG_NOT_CREATING for word in args):
        return None
    found = positionals(args, TAG_VALUE)
    if not found:
        return None
    return found[0], (found[1] if len(found) > 1 else "HEAD")


def git_output(project, *args):
    """What git prints, or "" when it fails."""
    try:
        out = subprocess.run(["git", *args], cwd=project, capture_output=True, text=True,
                             timeout=TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def branch_ref(project, branch):
    """The branch as a ref git can read here: local, then on origin, else the current commit."""
    for ref in (branch, "origin/" + branch):
        if git_output(project, "rev-parse", "--verify", "--quiet", ref + "^{commit}"):
            return ref
    return "HEAD"


def release_from_gh(words, project):
    """(version, ref) when the words create a release or a release branch's PR, else None."""
    if len(words) < 3 or os.path.basename(words[0]).lower() not in ("gh", "gh.exe"):
        return None
    group, action, args = words[1], words[2], words[3:]
    if (group, action) == ("release", "create"):
        found = positionals(args, RELEASE_VALUE)
        return (found[0], "HEAD") if found else None
    if (group, action) == ("pr", "create"):
        head = option_value(args, ("-H", "--head"))
        branch = head.split(":")[-1] if head else git_output(project, "branch", "--show-current")
        match = RELEASE_BRANCH.fullmatch(branch)
        if not match:
            return None
        return match.group(1), (branch_ref(project, branch) if head else "HEAD")
    return None


def releases_in(command, project):
    """Every (version, ref) the command would tag or propose."""
    found = []
    for statement in STATEMENT_END.split(command):
        words = words_of(statement)
        while words and ASSIGNMENT.match(words[0]):
            words = words[1:]
        release = release_from_git(words) or release_from_gh(words, project)
        if release:
            found.append(release)
    return found


def load_scheme(project):
    """(scheme, format) from the saved answers, or None when nothing is checked."""
    try:
        with open(os.path.join(project, ".bindwright", "project.json"), encoding="utf-8") as handle:
            advanced = json.load(handle).get("advanced") or {}
    except (OSError, ValueError, AttributeError):
        return None
    scheme = advanced.get("versioning")
    if scheme not in ("semver", "calver"):
        return None
    return scheme, advanced.get("versionFormat")


def check_release(project, scheme, fmt, version, ref):
    """The reasons the release is refused, or None when it may go ahead."""
    script = os.path.join(project, ".github", "scripts", "version_check.py")
    if not os.path.isfile(script):
        return None
    argv = [sys.executable, "-I", script, version, "--scheme", scheme, "--ref", ref]
    if scheme == "calver" and fmt:
        argv += ["--format", fmt]
    try:
        out = subprocess.run(argv, cwd=project, capture_output=True, text=True,
                             timeout=TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError) as error:
        return f"the version check could not run: {error}"
    if out.returncode == 0:
        return None
    if out.returncode == 2:
        return out.stdout.strip()
    return f"the version check could not run: {(out.stderr or out.stdout).strip()}"


def refusal(command, project):
    """Why the command's release is refused, or None."""
    scheme_and_format = load_scheme(project)
    if not scheme_and_format:
        return None
    scheme, fmt = scheme_and_format
    shape = SEMVER_TAG if scheme == "semver" else CALVER_TAG
    for version, ref in releases_in(command, project):
        if not shape.fullmatch(version):
            continue
        reasons = check_release(project, scheme, fmt, version, ref)
        if reasons:
            return version, reasons
    return None


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        return 0
    if not isinstance(data, dict) or data.get("tool_name") not in ("Bash", "PowerShell"):
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    project = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    found = refusal(command, project)
    if not found:
        return 0
    version, reasons = found
    print(f"Blocked release {version}: its version does not fit the commits since the last "
          f"release.\n{reasons}\nPick the version the commits need, or fix the changelog, "
          "then run the command again.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
