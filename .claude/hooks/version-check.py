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

A command whose text names a tag, a release or a PR is read the way the shell
reads it, by the shell parser in Bindwright's helper (`hooks/shell-words.mjs`),
so quoted text and here-documents are never taken for commands, and a git or gh
command behind a wrapper (`env`, `sudo`, `xargs`) is checked too. Options are
read as getopt reads them (`-am <message>`, `--head=<branch>`). `gh release
create` is measured at the version's tag when it exists, else at `--target`. A
version, commit or branch built at run time (`git tag $NEXT`) is out of reach. The check refusing, failing to
run, or the parser missing blocks such a command with the reason.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time

SEMVER_TAG = re.compile(r"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
CALVER_TAG = re.compile(r"v?\d+(?:\.\d+)*")
# The first pass over a command's text: it may match commands that make no release, never
# miss one that does; only a match is read by the shell parser.
MAY_BE_RELEASE = re.compile(r"\bgit\b.*\btag\b|\bgh\b.*\b(?:release|pr)\b.*\b(?:create|new)\b",
                            re.DOTALL | re.IGNORECASE)
# A rough cut of a command into statements, for when the shell parser cannot run.
ROUGH_STATEMENT = re.compile(r"[;&|\n()]+")
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
GH_CREATE = ("create", "new")
RELEASE_BRANCH = re.compile(r"release/(.+)")

# Options that take a value, so it is never the version.
GIT_GLOBAL_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
                    "--config-env", "--attr-source", "--super-prefix"}
GH_GROUP_VALUE = {"-R", "--repo"}
TAG_VALUE = {"-m", "--message", "-F", "--file", "-u", "--local-user", "--cleanup",
             "--sort", "--format", "--contains", "--no-contains", "--merged", "--no-merged",
             "--points-at", "--trailer"}
# The modes that make no tag: git tag lists whenever it is given -n or a filter option.
TAG_NOT_CREATING = {"-d", "--delete", "-l", "--list", "-v", "--verify", "-n", "--contains",
                    "--no-contains", "--merged", "--no-merged", "--points-at"}
RELEASE_VALUE = {"-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "-R",
                 "--repo", "--discussion-category", "--notes-start-tag"}
PR_VALUE = {"-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-R",
            "--repo", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p",
            "--project", "-r", "--reviewer", "-T", "--template", "--recover", "-H", "--head"}
TEXT_TOOLS = {"echo", "printf", "write-output", "write-host", "awk", "gawk", "mawk", "grep", "egrep",
              "fgrep", "rg", "sed", "sort", "cut", "tr", "uniq", "head", "tail", "wc", "jq", "column",
              "paste", "join", "select-string", "sls", "findstr"}
# The hook's entry in .claude/settings.json stops it at 30 s; every step shares what is left of
# this budget, so the hook gives its own reason before that.
HOOK_SECONDS = 27
STARTED = time.monotonic()
PARSE_SECONDS = 6
NO_PARSER = ("the shell parser in Bindwright's helper could not run, so the command was not read. "
             "Run /bindwright:update to install the helper; it needs Node 18 or later.")
UNREAD = "the shell parser could not read this command. Write the release command plainly."
SLOW = (f"the shell parser did not answer within {PARSE_SECONDS} s, so the command was not read. "
        "Run it again once the computer is less busy.")
OUT_OF_TIME = (f"the version check did not finish within {HOOK_SECONDS} s. Run the command again "
               "once the computer is less busy.")


def seconds_left():
    """What is left of the hook's time budget."""
    return max(0.0, STARTED + HOOK_SECONDS - time.monotonic())


def parser_script():
    """The helper's shell parser, or None when no copy is installed."""
    helper = os.path.join(os.path.expanduser("~"), ".bindwright", "helper")
    folders = [os.environ["BINDWRIGHT_HELPER"]] if os.environ.get("BINDWRIGHT_HELPER") else [
        os.path.join(helper, "node_modules", "bindwright"), os.path.join(helper, "python", "bindwright")]
    scripts = [os.path.join(folder, "hooks", "shell-words.mjs") for folder in folders]
    return next((script for script in scripts if os.path.isfile(script)), None)


def node_program(project):
    """The `node` on PATH, or None when the only one is the project's own. Windows looks a bare
    name up in the current folder first, so a repo could ship its own `node.exe`: that search
    is switched off, and a relative match or one inside the project is refused."""
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    found = shutil.which("node")
    if not found or not os.path.isabs(found):
        return None
    here = {os.path.normcase(os.path.realpath(folder)) for folder in (project, os.getcwd())}
    return None if os.path.normcase(os.path.realpath(os.path.dirname(found))) in here else found


def shell_commands(command, shell, project):
    """(each simple command's words, "") as the shell reads them, or (None, why) when the
    parser cannot run or read the command. A word built at run time is None."""
    node, script = node_program(project), parser_script()
    if not node or not script:
        return None, NO_PARSER
    try:
        # Bytes, not text: a text pipe on Windows would turn each LF into CR LF.
        out = subprocess.run([node, script, shell], input=command.encode("utf-8"),
                             capture_output=True, timeout=min(PARSE_SECONDS, seconds_left()))
        data = json.loads(out.stdout.decode("utf-8")) if out.returncode == 0 else None
    except subprocess.TimeoutExpired:
        return None, SLOW
    except (OSError, subprocess.SubprocessError, ValueError):
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("commands"), list):
        return None, NO_PARSER
    if data.get("error"):
        return None, UNREAD
    return [[word if isinstance(word, str) else None for word in words]
            for words in data["commands"] if isinstance(words, list)], ""


def long_name(name, names):
    """The long option a unique prefix stands for (`--mes` for `--message`), else the name."""
    matches = [option for option in names if option.startswith("--") and option.startswith(name)]
    return matches[0] if len(name) > 2 and name not in names and len(matches) == 1 else name


def read_options(args, takes_value):
    """(positionals, {option: value}) as getopt reads them: `-abc` is three options, a short
    option that takes a value takes the rest of its word or the next one, `--name=value`
    or `--name value` for a long one, and `--` ends the options."""
    found, options, index = [], {}, 0
    while index < len(args):
        word, index = args[index], index + 1
        if word == "--":
            found += args[index:]
            break
        if word is None or not word.startswith("-") or word == "-":
            found.append(word)
        elif word.startswith("--"):
            name, has_value, value = word.partition("=")
            name = long_name(name, takes_value)
            if not has_value and name in takes_value and index < len(args):
                value, index = args[index], index + 1
            options[name] = value
        else:
            for at in range(1, len(word)):
                name = "-" + word[at]
                if name not in takes_value:
                    options[name] = ""
                    continue
                value = word[at + 1:]
                if not value and index < len(args):
                    value, index = args[index], index + 1
                options[name] = value
                break
    return found, options


def program(words):
    """The command's program name, without a Windows extension, or "" when unknown."""
    if not words or not isinstance(words[0], str):
        return ""
    name = os.path.basename(words[0].replace("\\", "/")).lower()
    return re.sub(r"\.(exe|cmd|bat|com)$", "", name)


def runs_in(words):
    """The command, and each git or gh command a wrapper in it may run (`env A=1 git tag`,
    `sudo gh release create`); a tool that only reads or prints text runs none."""
    if program(words) in TEXT_TOOLS:
        return [words]
    return [words] + [words[i:] for i in range(1, len(words)) if program(words[i:]) in ("git", "gh")]


def git_subcommand(words):
    """The words after `git` and its global options, or None when this is not git."""
    if program(words) != "git":
        return None
    rest = words[1:]
    while rest and isinstance(rest[0], str) and rest[0].startswith("-"):
        rest = rest[2:] if rest[0] in GIT_GLOBAL_VALUE else rest[1:]
    return rest


def release_from_git(words):
    """(version, ref) when the words create a git tag, else None."""
    rest = git_subcommand(words)
    if not rest or rest[0] != "tag":
        return None
    found, options = read_options(rest[1:], TAG_VALUE)
    named = {long_name(option, TAG_NOT_CREATING) for option in options}
    if not found or TAG_NOT_CREATING & named:
        return None
    return found[0], (found[1] if len(found) > 1 else "HEAD")


class OutOfTime(Exception):
    """The hook's time budget ran out before the release could be checked."""


def git_output(project, *args):
    """What git prints, or "" when it fails. Running out of time is not an answer: it raises."""
    try:
        out = subprocess.run(["git", *args], cwd=project, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=seconds_left())
    except subprocess.TimeoutExpired:
        raise OutOfTime() from None
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def branch_ref(project, branch):
    """The branch as a ref git can read here: local, then on origin, else the current commit."""
    for ref in (branch, "origin/" + branch):
        if git_output(project, "rev-parse", "--verify", "--quiet", ref + "^{commit}"):
            return ref
    return "HEAD"


def release_ref(project, version, options):
    """The commit `gh release create` releases: the version's tag when it exists, else the
    `--target` branch or commit, else the current one; None when the target is built at run time."""
    tag = "refs/tags/" + version
    if git_output(project, "rev-parse", "--verify", "--quiet", tag + "^{commit}"):
        return tag
    if "--target" not in options:
        return "HEAD"
    target = options["--target"]
    return branch_ref(project, target) if target else None


def gh_action(words):
    """(group, action, the action's arguments) of a gh command, skipping the group's options
    before the action (`gh release -R owner/repo create`); None when this is not gh."""
    if program(words) != "gh" or len(words) < 3:
        return None
    index = 2
    while index < len(words) and isinstance(words[index], str) and words[index].startswith("-"):
        index += 2 if words[index] in GH_GROUP_VALUE else 1
    if index >= len(words):
        return None
    return words[1], words[index], words[index + 1:]


def may_release(command):
    """Whether a rough reading of the command finds a release: a tag that git would create, or
    a gh release or PR being created. It decides only whether the command is read in full."""
    for statement in ROUGH_STATEMENT.split(command):
        words = statement.split()
        while words and ASSIGNMENT.match(words[0]):
            words = words[1:]
        for run in runs_in(words):
            gh = gh_action(run)
            if release_from_git(run) or (gh and gh[0] in ("release", "pr") and gh[1] in GH_CREATE):
                return True
    return False


def release_from_gh(words, project):
    """(version, ref) when the words create a release or a release branch's PR, else None."""
    parts = gh_action(words)
    if not parts:
        return None
    group, action, args = parts
    if group == "release" and action in GH_CREATE:
        found, options = read_options(args, RELEASE_VALUE)
        if not found or found[0] is None:
            return None
        return found[0], release_ref(project, found[0], options)
    if group == "pr" and action in GH_CREATE:
        _, options = read_options(args, PR_VALUE)
        named = "--head" if "--head" in options else "-H"
        head = options.get(named)
        if named in options and head is None:
            return None
        branch = head.split(":")[-1] if head else git_output(project, "branch", "--show-current")
        match = RELEASE_BRANCH.fullmatch(branch)
        if not match:
            return None
        return match.group(1), (branch_ref(project, branch) if head else "HEAD")
    return None


def load_scheme(project):
    """(scheme, format) from the saved answers, or None when nothing is checked."""
    try:
        with open(os.path.join(project, ".bindwright", "project.json"), encoding="utf-8") as handle:
            advanced = json.load(handle).get("advanced")
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(advanced, dict) or advanced.get("versioning") not in ("semver", "calver"):
        return None
    fmt = advanced.get("versionFormat")
    if advanced["versioning"] == "calver" and not isinstance(fmt, str):
        return None
    return advanced["versioning"], fmt


def check_release(project, scheme, fmt, version, ref):
    """The reasons the release is refused, or None when it may go ahead."""
    script = os.path.join(project, ".github", "scripts", "version_check.py")
    if not os.path.isfile(script):
        return None
    argv = [sys.executable, "-I", script, version, "--scheme", scheme, "--ref", ref]
    if scheme == "calver" and fmt:
        argv += ["--format", fmt]
    try:
        out = subprocess.run(argv, cwd=project, capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=seconds_left())
    except subprocess.TimeoutExpired:
        return OUT_OF_TIME
    except (OSError, subprocess.SubprocessError) as error:
        return f"the version check could not run: {error}"
    if out.returncode == 0:
        return None
    if out.returncode == 2 and out.stdout.strip():
        return out.stdout.strip()
    return f"the version check could not run: {(out.stderr or out.stdout).strip()}"


def refusal(command, shell, project):
    """Why the command's release is blocked, or None. A command that cannot make a release
    returns before anything that can fail; past that, a failure blocks with its reason."""
    if not MAY_BE_RELEASE.search(command):
        return None
    try:
        return read_and_check(command, shell, project)
    except OutOfTime:
        return f"Blocked: this command may make a release, and {OUT_OF_TIME}"


def read_and_check(command, shell, project):
    """The block message for a command that may make a release, or None; raises OutOfTime."""
    project = git_output(project, "rev-parse", "--show-toplevel") or project
    scheme_and_format = load_scheme(project)
    if not scheme_and_format:
        return None
    scheme, fmt = scheme_and_format
    commands, problem = shell_commands(command, shell, project)
    if problem:
        # Without the parser only a command the rough reading finds a release in is blocked.
        return f"Blocked: this command may make a release, and {problem}" if may_release(command) else None
    return first_refusal(commands, project, scheme, fmt)


def first_refusal(commands, project, scheme, fmt):
    """The block message for the first release in the commands the check refuses, or None."""
    shape = SEMVER_TAG if scheme == "semver" else CALVER_TAG
    for words in (run for words in commands for run in runs_in(words)):
        release = release_from_git(words) or release_from_gh(words, project)
        if not release or None in release or not shape.fullmatch(release[0]):
            continue
        reasons = check_release(project, scheme, fmt, *release)
        if reasons:
            return (f"Blocked release {release[0]}: its version does not fit the commits since "
                    f"the last release.\n{reasons}\nPick the version the commits need, or fix "
                    "the changelog, then run the command again.")
    return None


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        return 0
    if not isinstance(data, dict) or data.get("tool_name") not in ("Bash", "PowerShell"):
        return 0
    tool_input = data.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str):
        return 0
    # The folder the command runs in; refusal reads the repo it belongs to.
    places = (data.get("cwd"), os.environ.get("CLAUDE_PROJECT_DIR"))
    project = next((place for place in places if isinstance(place, str) and place), os.getcwd())
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    reason = refusal(command, shell, project)
    if not reason:
        return 0
    print(reason, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
