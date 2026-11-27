"""In-process tests of the tool-rules guard: each rule's mode, the rows that ship in observe mode,
and a seeded sweep of mentions against calls. The tests that run it as a hook process live in
test_guard_hooks.py."""
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import unittest.mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_tool_rules():
    import importlib.util
    path = os.path.join(REPO, "_core", "global-template", "hooks", "tool-rules.py")
    spec = importlib.util.spec_from_file_location("tool_rules", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Outside any repo, so a row that reads the repo never reads the checkout the tests run from.
    module.CWD = tempfile.gettempdir()
    return module


def plant_git(folder):
    """A stand-in git in `folder`, found by name on PATH."""
    os.makedirs(folder, exist_ok=True)
    planted = os.path.join(folder, "git.bat" if os.name == "nt" else "git")
    with open(planted, "w", encoding="utf-8") as script:
        script.write("exit 0\n")
    os.chmod(planted, 0o755)
    return planted


def observed(hook):
    if not os.path.exists(hook.OBSERVED_LOG):
        return []
    with open(hook.OBSERVED_LOG, encoding="utf-8") as log:
        return [json.loads(line) for line in log]


class ToolRulesModeTest(unittest.TestCase):
    """Observe mode runs the command and logs it without tokens; enforce refuses; a mention breaks neither."""

    def setUp(self):
        self.hook = load_tool_rules()
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        self.hook.OBSERVED_LOG = os.path.join(folder, "tool-rules", "observed.jsonl")

    def test_observe_logs_and_passes_and_enforce_refuses(self):
        watch = self.hook.both(r"\bgh\s+run\s+watch\b")
        token = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        self.hook.RULES = [("watch", watch, "why", self.hook.OBSERVE)]
        self.assertIsNone(self.hook.refusal('git commit -m "gh run watch 1"', "bash"))
        self.assertEqual(observed(self.hook), [])
        self.assertIsNone(self.hook.refusal(f"gh run watch 1 --token {token}", "powershell"))
        entries = observed(self.hook)
        self.assertEqual([(entry["rule"], entry["shell"]) for entry in entries], [("watch", "powershell")])
        self.assertNotIn(token, entries[0]["command"])
        self.hook.RULES = [("watch", watch, "why", self.hook.ENFORCE)]
        self.assertEqual(self.hook.refusal("gh run watch 1", "bash"), ("watch", "why"))
        self.assertEqual(len(observed(self.hook)), 1)


class ToolRulesObserveRowsTest(unittest.TestCase):
    """Each row that ships in observe mode lets its command run and logs it under its own name,
    and a command or a message that only looks like it logs nothing."""

    RERUN = "`gh run rerun --failed` or `--job`"
    INTERACTIVE = "an interactive git command (`-i`, `-p`)"
    BODY = "an inline body for `gh pr` or `gh issue`"
    SCRATCH = "a scratch file in a fixed folder (`/tmp`, `C:/tmp`)"
    JQ = "`jq` in Git Bash"
    SWITCH = "a branch switch chained with other commands"
    ROWS = (("git checkout develop && git pull", "bash", SWITCH),
            ("git switch -c x; ls", "powershell", SWITCH),
            ("git checkout develop", "bash", None), ("git checkout -- a.txt && git status", "bash", None),
            ('git commit -m "then git checkout x && go"', "bash", None),
            ("gh run rerun 5 --failed", "bash", RERUN), ("gh run rerun 5 --job 7", "powershell", RERUN),
            ("gh run rerun 5", "bash", None), ("gh run rerun 5 --failed=false", "bash", None),
            ("gh run rerun 5 --failed;gh run view 5", "bash", RERUN),
            ("gh run rerun 5 --failed|tee log", "bash", RERUN),
            ("(cd ci; gh run rerun 5 --failed)", "bash", RERUN),
            ("git rebase -i HEAD~3", "bash", INTERACTIVE), ("git add -p src", "powershell", INTERACTIVE),
            ("git commit -i -m x", "bash", None), ("git stash show -p", "bash", None),
            ('GIT_SEQUENCE_EDITOR="sed -i s/pick/fixup/" git rebase -i HEAD~3', "bash", None),
            ("gh pr create --title t --body b", "bash", BODY), ("gh issue comment 5 -b hi", "powershell", BODY),
            ("gh pr create -B develop --body-file x.md", "bash", None),
            ("echo hi > /tmp/x", "bash", SCRATCH), ("ls C:/tmp", "powershell", SCRATCH),
            ("ls /var/tmp/x", "bash", None), ("cat > /tmp/claude-1000/-home-x/abc/scratchpad/x", "bash", None),
            ("ls C:/tmpfiles", "powershell", None),
            ("gh pr list | jq .", "bash", JQ), ("gh pr list --jq .", "bash", None),
            ("gh pr list | jq .", "powershell", None),
            ('git commit -m "gh run rerun 5 --failed; echo > /tmp/x"', "bash", None))

    def setUp(self):
        self.hook = load_tool_rules()
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        self.hook.OBSERVED_LOG = os.path.join(folder, "tool-rules", "observed.jsonl")
        self.hook.GIT_BASH = True

    def test_a_powershell_command_after_a_here_string_is_read(self):
        # A cast, an empty here-string, `@'` inside a bareword and a word operator before `@'`.
        for before in ("$x = [string]@'\nit's done\n'@", "$m = @'\n'@", "Write-Output a.b@'\nx'",
                       "\"{0}\" -f@'\nit's\n'@"):
            with self.subTest(before=before):
                merge = before + "; gh pr merge 5 --admin"
                self.assertEqual(self.hook.refusal(merge, "powershell")[0], "`gh pr merge --admin`")
        self.assertIsNone(self.hook.refusal("$doc = [xml]@'\n<note>Don't use gh run watch</note>\n'@", "powershell"))

    def test_a_here_string_header_may_end_in_blanks_and_its_body_may_be_empty(self):
        # Each reading is the one PowerShell's own parser gives.
        script = "@'  \nprint('C:\\x')\n'@ | python -"
        self.assertEqual(self.hook.refusal(script, "powershell")[0], "an inline script holding a backslash")
        merge = "$m = @'\n'@\ngh pr merge 5 --admin\n'@"
        self.assertEqual(self.hook.refusal(merge, "powershell")[0], "`gh pr merge --admin`")
        self.assertIsNone(self.hook.refusal("$m = @'\n'@\n'@ gh pr merge 5 --admin\n'@", "powershell"))

    def test_each_row_lets_its_command_run_and_logs_its_own_name(self):
        for command, shell, want in self.ROWS:
            with self.subTest(command=command, shell=shell):
                before = len(observed(self.hook))
                self.assertIsNone(self.hook.refusal(command, shell))
                self.assertEqual([entry["rule"] for entry in observed(self.hook)[before:]], [want] if want else [])


class SecretWriteRowTest(unittest.TestCase):
    """A `gh secret` write is refused; listing a secret or naming one in a message never is."""

    NAME = "a repo secret write (`gh secret set` or `delete`)"

    def test_a_write_is_refused_and_a_read_passes(self):
        hook = load_tool_rules()
        for command in ("gh secret set CLAUDE_CODE_OAUTH_TOKEN -R o/r", "gh secret delete X -R o/r",
                        "cd x; gh secret set T < t.txt"):
            with self.subTest(command=command):
                self.assertEqual(hook.refusal(command, "bash")[0], self.NAME)
                self.assertEqual(hook.refusal(command, "powershell")[0], self.NAME)
        for command in ("gh secret list -R o/r", 'git commit -m "docs: say gh secret set needs admin"',
                        "cmp .github/scripts/set-review-tokens.sh _core/x/set-review-tokens.sh"):
            with self.subTest(command=command):
                self.assertIsNone(hook.refusal(command, "bash"))


class LengthRowsTest(unittest.TestCase):
    """After a commit or PR command, a commit subject over 72 characters, and a PR title over 64 where PRs
    squash-merge, get a note from what git and gh hold; the rows that read the repo's saved answers and
    its changelog are logged before the command runs."""

    LONG = "docs(changelog): say the four file types are now measured wherever their row stays"  # 82
    TITLE_LONG = "fix(size-check): measure .mts, .cts, .hxx and .inl with their language"  # 70

    def setUp(self):
        self.hook = load_tool_rules()
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        self.hook.OBSERVED_LOG = os.path.join(self.folder, "tool-rules", "observed.jsonl")

    def project(self, merge_style):
        os.makedirs(os.path.join(self.folder, ".git"), exist_ok=True)
        os.makedirs(os.path.join(self.folder, ".bindwright"), exist_ok=True)
        with open(os.path.join(self.folder, ".bindwright", "project.json"), "w", encoding="utf-8") as answers:
            json.dump({"advanced": {"mergeStyle": merge_style}}, answers)
        self.hook.CWD = os.path.join(self.folder, "sub")

    def logged(self, command, shell):
        before = len(observed(self.hook))
        self.assertIsNone(self.hook.refusal(command, shell))
        return [entry["rule"] for entry in observed(self.hook)[before:]]

    def git(self, *args):
        subprocess.run(["git", "-C", self.folder, "-c", "user.name=t", "-c", "user.email=t@example.com",
                        "-c", "commit.gpgsign=false", *args], check=True, capture_output=True)

    def test_a_subject_that_landed_over_72_gets_a_note(self):
        self.git("init", "-q")
        self.hook.CWD = self.folder
        for name, subject, command, want in (
                ("over 72", self.LONG, "git commit -m x", True),
                ("exactly 72", "x" * 72, "git commit -F msg.txt", False),
                ("git's own options first", self.LONG, "git -c core.editor=true commit --amend", True),
                ("a PowerShell call", self.LONG, "git commit -m $msg; git log -1", True),
                ("no commit in the command", self.LONG, "git status", False)):
            with self.subTest(name):
                self.git("commit", "-q", "--allow-empty", "-m", subject)
                notes = self.hook.length_notes(command)
                self.assertEqual(bool(notes), want)
                if want:
                    self.assertIn(f"is {len(subject)} characters", notes[0])

    def test_no_repo_gives_no_note(self):
        self.hook.CWD = self.folder
        self.assertEqual(self.hook.length_notes("git commit -m x"), [])

    def test_a_long_title_gets_a_note_only_where_prs_squash_merge(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 600))
        ahead = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 30))
        for name, style, command, line, want in (
                ("squash", "squash", "gh pr create --base develop --body-file b.md", f"{now}\t{self.TITLE_LONG}",
                 True),
                ("an edit", "squash", "gh pr edit --title x", f"{now}\t{self.TITLE_LONG}", True),
                ("GitHub's clock ahead of this one", "squash", "gh pr create", f"{ahead}\t{self.TITLE_LONG}", True),
                ("a PR the command did not change", "squash", "gh pr edit 5 --title x", f"{old}\t{self.TITLE_LONG}",
                 False),
                ("exactly 64", "squash", "gh pr create", f"{now}\t{self.TITLE_LONG[:64]}", False),
                ("merge commits", "merge", "gh pr create", f"{now}\t{self.TITLE_LONG}", False),
                ("no saved style", None, "gh pr create", f"{now}\t{self.TITLE_LONG}", False),
                ("no PR command", "squash", "gh pr view 5", f"{now}\t{self.TITLE_LONG}", False)):
            with self.subTest(name):
                self.project(style)
                with unittest.mock.patch.object(self.hook, "landed", return_value=line) as landed:
                    notes = self.hook.length_notes(command)
                self.assertEqual(bool(notes), want)
                if want:
                    landed.assert_called_once_with("gh", "pr", "view", "--json", "title,updatedAt", "-q",
                                                   '.updatedAt + "\\t" + .title')

    def test_only_a_commit_written_just_now_and_not_a_merge_counts(self):
        now = int(time.time())
        for name, line, want in (
                ("one parent, just written", f"{now} ab12\t{self.LONG}", self.LONG),
                ("a first commit", f"{now} \t{self.LONG}", self.LONG),
                ("a commit from ten minutes ago", f"{now - 600} ab12\t{self.LONG}", None),
                ("a merge commit, whose subject git writes", f"{now} ab12 cd34\t{self.LONG}", None),
                ("nothing read", None, None)):
            with self.subTest(name):
                with unittest.mock.patch.object(self.hook, "landed", return_value=line):
                    self.assertEqual(self.hook.fresh_subject(), want)

    def test_a_merge_flag_other_than_the_saved_style_is_logged(self):
        other = "a `gh pr merge` style other than the repo's"
        for name, style, command, shell, want in (
                ("--squash where PRs merge", "merge", "gh pr merge 5 --squash --delete-branch", "bash", True),
                ("-r where PRs merge", "merge", "gh pr merge 5 -r", "powershell", True),
                ("--rebase where PRs squash", "squash", "gh pr merge 5 --rebase", "bash", True),
                ("--merge where PRs squash, as gitflow releases do", "squash", "gh pr merge 5 --merge", "bash", False),
                ("--squash where PRs squash", "squash",
                 "gh pr merge 5 --squash --delete-branch --match-head-commit ab12", "bash", False),
                ("-r where PRs rebase", "rebase", "gh pr merge 5 -r --delete-branch", "powershell", False),
                ("-m where PRs merge", "merge", "gh pr merge 5 -m", "bash", False),
                ("--squash=false where PRs merge", "merge", "gh pr merge 5 --merge --squash=false", "bash", False),
                ("--squash before a ; where PRs merge", "merge", "gh pr merge 5 --squash;echo done", "bash", True),
                ("-r=false where PRs squash", "squash", "gh pr merge 5 --squash -r=false", "powershell", False),
                ("no style flag", "merge", "gh pr merge 5 --auto", "bash", False),
                ("a mention in a message", "merge", 'git commit -m "gh pr merge 5 --squash"', "bash", False),
                ("no saved style", None, "gh pr merge 5 --squash", "bash", False),
                ("a saved style that is a list", ["merge"], "gh pr merge 5 --squash", "bash", False),
                ("a saved style that is an object", {}, "gh pr merge 5 --squash", "bash", False)):
            with self.subTest(name):
                self.project(style)
                self.assertEqual(self.logged(command, shell), [other] if want else [])

    CHANGELOG = ("# Changelog\n\n## [Unreleased]\n\n### Fixed\n- a\n\n"
                 "## [1.1.0] - 2026-11-20\n\n### Added\n- b\n\n## [1.0.0] - 2026-11-01\n\n### Added\n- c\n\n"
                 "[unreleased]: https://x/compare/v1.1.0...HEAD\n[1.1.0]: https://x/compare/v1.0.0...v1.1.0\n"
                 "[1.0.0]: https://x/releases/tag/v1.0.0\n")

    def test_a_commit_that_edits_a_dated_changelog_section_is_logged(self):
        dated = "a commit that edits a released CHANGELOG.md section"
        git = ["git", "-C", self.folder, "-c", "user.name=t", "-c", "user.email=t@example.com",
               "-c", "commit.gpgsign=false"]
        subprocess.run(git[:3] + ["init", "-q"], check=True)
        path = os.path.join(self.folder, "CHANGELOG.md")

        def write(text):
            with open(path, "w", encoding="utf-8", newline="\n") as changelog:
                changelog.write(text)
            subprocess.run(git + ["add", "CHANGELOG.md"], check=True)

        def commit(text):
            write(text)
            subprocess.run(git + ["add", "CHANGELOG.md"], check=True)
            subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "docs: start"], check=True)

        commit(self.CHANGELOG)
        os.makedirs(os.path.join(self.folder, "sub"), exist_ok=True)
        self.hook.CWD = os.path.join(self.folder, "sub")
        released = "## [1.2.0] - 2026-11-24\n\n### Fixed\n- a\n\n"
        cut = self.CHANGELOG.replace("## [Unreleased]\n\n### Fixed\n- a\n\n", "## [Unreleased]\n\n" + released).replace(
            "[unreleased]: https://x/compare/v1.1.0...HEAD\n",
            "[unreleased]: https://x/compare/v1.2.0...HEAD\n[1.2.0]: https://x/compare/v1.1.0...v1.2.0\n")
        for name, text, command, want in (
                ("a line changed in a dated section", self.CHANGELOG.replace("- b", "- B"), "git commit -am x", True),
                ("a line added to the end of a dated section", self.CHANGELOG.replace("- b\n", "- b\n- d\n"),
                 "git add -u && git commit -m x", True),
                ("the newest dated heading changed", self.CHANGELOG.replace("2026-11-20", "2026-11-21"),
                 "git commit -m x", True),
                ("a line added under [Unreleased]", self.CHANGELOG.replace("- a\n", "- a\n- e\n"),
                 "git commit -am x", False),
                ("a release cut from [Unreleased], its links bumped", cut, "git commit -am x", False),
                ("a link added for an [Unreleased] entry", self.CHANGELOG + "[#42]: https://x/issues/42\n",
                 "git commit -am x", False),
                ("a line changed in the oldest section, above the links", self.CHANGELOG.replace("- c", "- C"),
                 "git commit -am x", True),
                ("a dated section edited, with no commit", self.CHANGELOG.replace("- b", "- B"), "git status", False),
                ("a dated section edited, a commit only mentioned", self.CHANGELOG.replace("- b", "- B"),
                 'echo "git commit"', False)):
            with self.subTest(name):
                write(text)
                self.assertEqual(self.logged(command, "bash"), [dated] if want else [])
        # Links that name only the releases: the cut adds its own above them, after the oldest section's end.
        released_only = self.CHANGELOG.replace("[unreleased]: https://x/compare/v1.1.0...HEAD\n", "")
        commit(released_only)
        write(released_only.replace("## [Unreleased]\n\n### Fixed\n- a\n\n", "## [Unreleased]\n\n" + released)
              .replace("[1.1.0]: ", "[1.2.0]: https://x/compare/v1.1.0...v1.2.0\n[1.1.0]: ", 1))
        self.assertEqual(self.logged("git commit -am x", "bash"), [])
        # A `git` the repo ships, first on PATH, never runs: the row reads the edit with the user's own git.
        write(released_only.replace("- b", "- B"))
        tools = os.path.join(self.folder, "bin")
        os.makedirs(tools)
        planted, marker = os.path.join(tools, "git.bat" if os.name == "nt" else "git"), "ran.txt"
        leaves_marker = f'@echo x> "%~dp0{marker}"\n' if os.name == "nt" else f'#!/bin/sh\ntouch "${{0%/*}}/{marker}"\n'
        with open(planted, "w", encoding="utf-8", newline="\n") as script:
            script.write(leaves_marker)
        os.chmod(planted, 0o755)
        with unittest.mock.patch.dict(os.environ, {"PATH": tools + os.pathsep + os.environ.get("PATH", "")}):
            self.assertEqual(self.logged("git commit -am x", "bash"), [dated])
        self.assertFalse(os.path.exists(os.path.join(tools, marker)))
        # Nor from a session in a submodule, where the nearest `.git` is the submodule's own.
        submodule = os.path.join(self.folder, "lib")
        os.makedirs(os.path.join(submodule, ".git"))
        outer, self.hook.CWD = self.hook.CWD, submodule
        with unittest.mock.patch.dict(os.environ, {"PATH": tools + os.pathsep + os.environ.get("PATH", "")}):
            self.logged("git commit -am x", "bash")
        self.hook.CWD = outer
        self.assertFalse(os.path.exists(os.path.join(tools, marker)))
        # A git whose own child holds the output open past the deadline, as a launcher's does, is not waited on.
        slow = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, slow, ignore_errors=True)
        stall = "@ping -n 11 127.0.0.1 >nul\n" if os.name == "nt" else "#!/bin/sh\nsleep 10\n"
        slow_git = os.path.join(slow, "git.bat" if os.name == "nt" else "git")
        with open(slow_git, "w", encoding="utf-8", newline="\n") as script:
            script.write(stall)
        os.chmod(slow_git, 0o755)
        started = time.monotonic()
        with unittest.mock.patch.dict(os.environ, {"PATH": slow + os.pathsep + os.environ.get("PATH", "")}), \
                unittest.mock.patch.object(self.hook, "GIT_SECONDS", 1):
            self.assertEqual(self.logged("git commit -m x", "bash"), [])
        self.assertLess(time.monotonic() - started, 4)
        # A staged changelog past the size limit is not read: no edit.
        write(released_only.replace("- b", "- B").replace("- a\n", "- a\n" + "- x\n" * 500))
        with unittest.mock.patch.object(self.hook, "CHANGELOG_LIMIT", len(released_only) + 10):
            self.assertEqual(self.logged("git commit -am x", "bash"), [])
        # A link staged in its place is read as git stores it, the target's name: its released sections are gone.
        # It goes straight into the index, so the file on disk stays a plain file for the checks after it.
        link = subprocess.run(git + ["hash-object", "-w", "--stdin"], input="/dev/zero", capture_output=True,
                              text=True, check=True).stdout.strip()
        subprocess.run(git + ["update-index", "--cacheinfo", f"120000,{link},CHANGELOG.md"], check=True)
        self.assertEqual(self.logged("git commit -m x", "bash"), [dated])
        # An edit on disk that is not staged is not part of the commit.
        commit(released_only)
        with open(path, "w", encoding="utf-8", newline="\n") as changelog:
            changelog.write(released_only.replace("- b", "- B"))
        self.assertEqual(self.logged("git commit -m x", "bash"), [])
        # Outside a repo, git fails, and the row reads it as no edit.
        self.hook.CWD = tempfile.gettempdir()
        self.assertEqual(self.logged("git commit -am x", "bash"), [])


class TrustedGitTest(unittest.TestCase):
    def test_a_path_folder_that_cannot_be_resolved_is_skipped(self):
        # Windows raises for a share that refuses the sign-in; the guard skips that folder and goes on.
        hook = load_tool_rules()
        share, real = os.path.join(tempfile.gettempdir(), "unreachable-share"), hook.real_path

        def refusing(path):
            if path == share:
                raise OSError(1326, "The user name or password is incorrect")
            return real(path)

        with unittest.mock.patch.dict(os.environ, {"PATH": share + os.pathsep + os.environ.get("PATH", "")}), \
                unittest.mock.patch.object(hook, "real_path", refusing):
            self.assertIsNotNone(hook.trusted_program("git"))

    def test_a_session_at_the_home_folder_keeps_the_path_folders_under_home(self):
        # A dotfiles repo at home holds the user's own installs (~/.local/bin, nvm), not programs a repo ships.
        hook = load_tool_rules()
        with tempfile.TemporaryDirectory() as home:
            home = hook.real_path(home)
            os.mkdir(os.path.join(home, ".git"))
            installs, work = os.path.join(home, "bin"), os.path.join(home, "work")
            os.mkdir(installs)
            os.mkdir(work)
            with unittest.mock.patch.dict(os.environ, {"PATH": installs, "HOME": home, "USERPROFILE": home}), \
                    unittest.mock.patch.object(hook, "CWD", work):
                self.assertEqual(hook.trusted_folders(home), [installs])
                self.assertEqual(hook.trusted_folders(installs), [])

    def test_a_session_reached_through_a_link_runs_no_git_of_the_repo(self):
        # The session folder is a link in the repo to a folder outside it: no repo holds the resolved
        # folder, so the guard reads no repo and never runs the git the repo ships.
        hook = load_tool_rules()
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as outside:
            os.mkdir(os.path.join(repo, ".git"))
            planted, link = plant_git(os.path.join(repo, "bin")), os.path.join(repo, "out")
            try:
                os.symlink(outside, link, target_is_directory=True)
            except OSError:
                self.skipTest("this system makes no folder links")
            with unittest.mock.patch.dict(os.environ, {"PATH": os.path.dirname(planted)}), \
                    unittest.mock.patch.object(hook, "CWD", link), \
                    unittest.mock.patch.object(hook.subprocess, "Popen") as popen:
                self.assertIsNone(hook.landed("git", "log", "-1"))
            popen.assert_not_called()

    def test_a_session_below_a_repo_at_home_skips_its_own_folders(self):
        # The session folder is no repo, but the home folder above it is one; a program inside the
        # session folder is the folder's own, so the git the guard runs is the user's install.
        hook = load_tool_rules()
        with tempfile.TemporaryDirectory() as home:
            home = hook.real_path(home)
            os.mkdir(os.path.join(home, ".git"))
            session = os.path.join(home, "Downloads", "tool")
            shipped, installs = os.path.join(session, "bin"), os.path.join(home, "bin")
            planted, own = plant_git(shipped), plant_git(installs)
            with unittest.mock.patch.dict(os.environ, {"PATH": os.pathsep.join([shipped, installs]),
                                                       "HOME": home, "USERPROFILE": home}), \
                    unittest.mock.patch.object(hook, "CWD", session):
                self.assertEqual(hook.real_path(hook.trusted_program("git") or ""), hook.real_path(own), planted)


class ToolRulesSweepTest(unittest.TestCase):
    """A seeded sweep of the tool-rules guard: each rule's trigger, written inside a quoted message,
    a comment or a here-document body, always passes, and the same trigger run as a command is
    always refused. GUARD_SWEEP_SEED replays a failing run."""

    TRIGGERS = (("gh run watch 1", "both"), ("python .github/scripts/size_check.py && git commit -m x", "both"),
                ("git push && gh pr create", "both"), ("git checkout dev -- .", "both"),
                ("gh pr merge 5 --admin", "both"), ("gh run rerun 5 --failed", "both"),
                ("gh secret set TOKEN -R o/r", "both"),
                ("git rebase -i HEAD~3", "both"), ("gh pr create --body x", "both"),
                ("node -e \"console.log('a\\\\b')\"", "both"),
                ("@'\nprint('C:\\\\x')\n'@ | python -", "powershell"),
                ("cat <<'EOF' | python -\nprint('C:\\\\x')\nEOF", "bash"))
    # Each shape lists the text that would end it early: a trigger holding one would run, not be mentioned.
    MENTIONS = {"bash": (("git commit -m \"docs: {t}\"", ('"',)), ("echo ok # {t}", ("\n",)),
                         ("git commit -F - <<'EOF'\ndocs: {t}\nEOF", ("\nEOF",)),
                         ("git commit -m \"$(cat <<'EOF'\n{t}\nEOF\n)\"", ("\nEOF",)),
                         ("git commit -m \"one\n{t}\nthree\"", ('"',))),
                "powershell": (("git commit -m \"docs: {t}\"", ('"',)), ("<# {t} #>\nls", ("#>",)),
                               ("ls # {t}", ("\n",)), ("@'\ndocs: {t}\n'@ | git commit -F -", ("\n'@",)),
                               ("<#\n{t}\n#>\nls", ("#>",)))}
    SAMPLES = 200

    def setUp(self):
        import random
        self.seed = int(os.environ.get("GUARD_SWEEP_SEED") or random.randrange(2 ** 32))
        self.rng = random.Random(self.seed)
        self.hook = load_tool_rules()

    def refused(self, text, shell):
        """Every rule the text breaks, in either mode: an observe rule's hit is a refusal to come."""
        return [name for name, test, *_ in self.hook.RULES if test(text, shell)]

    def test_a_mention_always_passes_and_a_call_is_always_refused(self):
        for _ in range(self.SAMPLES):
            trigger, shells = self.rng.choice(self.TRIGGERS)
            shell = self.rng.choice(("bash", "powershell") if shells == "both" else (shells,))
            shapes = [shape for shape, enders in self.MENTIONS[shell] if not any(end in trigger for end in enders)]
            text = self.rng.choice(shapes).format(t=trigger)
            replay = f"(replay with GUARD_SWEEP_SEED={self.seed})"
            self.assertEqual(self.refused(text, shell), [], f"{shell} {text!r} {replay}")
            self.assertNotEqual(self.refused(trigger, shell), [], f"{shell} {trigger!r} {replay}")


if __name__ == "__main__":
    unittest.main()
