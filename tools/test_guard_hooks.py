"""Tests for the repo's guard hooks as Claude Code starts them.

Each test runs the hook's command string from the committed
.claude/settings.json through `sh -c`, with a tool call on stdin, under a
throwaway HOME so the maintainer's own ~/.claude hooks never decide the
result.

Run from the repo root: python -m unittest tools/test_guard_hooks.py
"""
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import warnings

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(REPO, "helper")
LAUNCHER = os.path.join(REPO, ".claude", "hooks", "run-hook.sh")
SETTINGS = os.path.join(REPO, ".claude", "settings.json")
# Built from pieces so this file's text never reads as a force push to the
# guard that watches the commands run in this repo.
FORCE_PUSH = "git push -" + "f origin feature/x"
# Same for attribution samples and the guard that scans this repo's commands.
AI_TRAILER = "Co-" + "Authored-By: Cla" + "ude <noreply@anthro" + "pic.com>"
HUMAN_TRAILER = "Co-" + "Authored-By: Jane Doe <12345+jane@users.noreply.github.com>"
GENERATED_LINE = "Gener" + "ated with [Cla" + "ude Code](https://cla" + "ude.com/claude-code)"
SESSION_LINK = "https://cla" + "ude.ai/code/session_" + "01V8SAUxUZBbVPekZUHDL9FZ"
# The deep-review trigger, split so a review that quotes this file cannot
# carry the whole phrase into a PR comment and start a deep review.
DEEP_TRIGGER = "@cla" + "ude rev" + "iew this PR"


def find_sh():
    """A POSIX sh: on PATH, or Git for Windows' copy next to git.exe."""
    sh = shutil.which("sh")
    if sh or os.name != "nt":
        return sh
    git = shutil.which("git")
    if git:
        for rel in (r"..\bin\sh.exe", r"..\usr\bin\sh.exe", r"..\..\bin\sh.exe"):
            path = os.path.normpath(os.path.join(os.path.dirname(git), rel))
            if os.path.exists(path):
                return path
    return None


SH = find_sh()


def pre_tool_hooks():
    """Every PreToolUse command hook in the committed .claude/settings.json."""
    with open(SETTINGS, encoding="utf-8") as f:
        groups = json.load(f)["hooks"]["PreToolUse"]
    return [h for g in groups for h in g["hooks"]]


def settings_command(name):
    """The committed PreToolUse command string that starts hook <name>."""
    return next(h["command"] for h in pre_tool_hooks() if f" {name}" in h["command"])


@unittest.skipIf(SH is None, "needs a POSIX sh on PATH (Git Bash on Windows)")
class GuardHookTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def run_hook(self, name, command, project=REPO, tool="Bash", path=None, helper=HELPER):
        # The guard parses commands with the helper setup installs; here, the repo's own copy.
        env = dict(os.environ, HOME=self.home, CLAUDE_PROJECT_DIR=project, BINDWRIGHT_HELPER=helper)
        env.pop("USERPROFILE", None)
        if path is not None:
            env["PATH"] = path
        payload = {"tool_name": tool, "tool_input": {"command": command}, "cwd": project}
        return subprocess.run(
            [SH, "-c", settings_command(name)], input=json.dumps(payload).encode("utf-8"),
            capture_output=True, env=env, timeout=60)

    def each(self, rows, run):
        """Runs `run` on every row side by side, since each run is a hook process, and pairs the
        rows with their results in order. A tuple row is passed as separate arguments."""
        rows = list(rows)
        # One run per usable core: more makes runs queue past the guard's parse time limit.
        cores = getattr(os, "process_cpu_count", os.cpu_count)() or 1
        with concurrent.futures.ThreadPoolExecutor(max(1, min(cores, len(rows)))) as pool:
            results = pool.map(lambda row: run(*row) if isinstance(row, tuple) else run(row), rows)
            return list(zip(rows, results))

    def temp_project(self, files=()):
        """A throwaway project dir holding the named files from .claude/hooks/."""
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        os.makedirs(os.path.join(root, ".claude", "hooks"))
        for name in files:
            shutil.copy(os.path.join(REPO, ".claude", "hooks", name), os.path.join(root, ".claude", "hooks"))
        return root

    def home_settings(self, text, hook_files=()):
        """Write ~/.claude/settings.json and create the named ~/.claude/hooks files."""
        os.makedirs(os.path.join(self.home, ".claude", "hooks"))
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            f.write(text)
        for name in hook_files:
            open(os.path.join(self.home, ".claude", "hooks", name), "w").close()

    def assert_blocked(self, result):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(b"force push", result.stderr)

    def assert_passes(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), b"")

    def test_force_push_is_blocked(self):
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH))

    def test_powershell_force_push_is_blocked(self):
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH, tool="PowerShell"))

    def test_force_with_lease_passes(self):
        self.assert_passes(self.run_hook("push-guard", "git push --force-with-lease origin feature/x"))

    def test_plain_push_passes(self):
        self.assert_passes(self.run_hook("push-guard", "git push origin feature/x"))

    def test_skipped_when_home_registers_a_working_copy(self):
        self.home_settings('{"command": "python \\"C:/Users/me/.claude/hooks/push-guard.py\\""}',
                           hook_files=["push-guard.py"])
        self.assert_passes(self.run_hook("push-guard", FORCE_PUSH))

    def test_skipped_when_home_copy_uses_backslashes(self):
        self.home_settings('{"args": ["C:\\\\Users\\\\me\\\\.claude\\\\hooks\\\\push-guard.py"]}',
                           hook_files=["push-guard.py"])
        self.assert_passes(self.run_hook("push-guard", FORCE_PUSH))

    def test_runs_when_home_registration_has_no_file(self):
        self.home_settings('{"command": "python ~/.claude/hooks/push-guard.py"}')
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH))

    def test_runs_when_home_only_names_it_in_a_permission_rule(self):
        self.home_settings('{"permissions": {"allow": [\n    "Bash(python ~/.claude/hooks/push-guard.py:*)"\n]}}',
                           hook_files=["push-guard.py"])
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH))

    def test_runs_when_permission_rule_sits_in_a_compact_array(self):
        self.home_settings('{"permissions": {"allow": ["Bash(python3 ~/.claude/hooks/push-guard.py:*)"]}}',
                           hook_files=["push-guard.py"])
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH))

    def test_runs_when_permission_rule_quotes_the_path(self):
        self.home_settings('{"permissions":{"allow":["Bash(python \\"C:/u/.claude/hooks/push-guard.py\\":*)"]}}',
                           hook_files=["push-guard.py"])
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH))

    def test_skipped_when_minified_file_registers_a_working_copy(self):
        self.home_settings('{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command",'
                           '"command":"python \\"C:/u/.claude/hooks/push-guard.py\\""}]}]}}',
                           hook_files=["push-guard.py"])
        self.assert_passes(self.run_hook("push-guard", FORCE_PUSH))

    def test_home_copy_of_another_hook_does_not_skip(self):
        self.home_settings('{"command": "python ~/.claude/hooks/other-guard.py"}',
                           hook_files=["other-guard.py"])
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH))

    def test_missing_hook_file_lets_the_call_through(self):
        project = self.temp_project(files=["run-hook.sh"])
        result = self.run_hook("push-guard", FORCE_PUSH, project=project)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_launcher_lets_the_call_through(self):
        # dash exits 2 when it cannot open a script; the entry must test first.
        result = self.run_hook("push-guard", FORCE_PUSH, project=self.temp_project())
        self.assertEqual(result.returncode, 0, result.stderr)

    def sh_only_path(self):
        """A PATH that finds sh but no Python."""
        if os.name == "nt":
            # Git for Windows' sh.exe needs the DLLs in its own folder, which holds no Python.
            return os.path.dirname(SH)
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        os.symlink(SH, os.path.join(folder, "sh"))
        return folder

    def test_no_python_on_path_lets_the_call_through(self):
        path = self.sh_only_path()
        self.assertFalse([n for n in ("python3", "python", "py") if shutil.which(n, path=path)])
        self.assert_passes(self.run_hook("push-guard", FORCE_PUSH, path=path))

    def test_crashing_guard_exits_one_so_on_failure_blocks_it(self):
        # Claude Code blocks a command hook that exits with a code other than 0 or 2
        # when its entry sets onFailure; a Python crash exits 1.
        project = self.temp_project(files=["run-hook.sh"])
        with open(os.path.join(project, ".claude", "hooks", "push-guard.py"), "w", encoding="utf-8") as f:
            f.write("raise RuntimeError('crash')\n")
        result = self.run_hook("push-guard", FORCE_PUSH, project=project)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(b"RuntimeError", result.stderr)

    def test_every_guard_entry_blocks_on_failure(self):
        guards = [h for h in pre_tool_hooks() if "run-hook.sh" in h["command"]]
        self.assertGreaterEqual(len(guards), 2)
        for hook in guards:
            with self.subTest(command=hook["command"]):
                self.assertEqual(hook.get("onFailure"), "block")

    def test_launcher_is_the_one_the_settings_start(self):
        self.assertIn("/.claude/hooks/run-hook.sh", settings_command("push-guard"))
        self.assertTrue(os.path.exists(LAUNCHER))

    # --- no-ai-attribution: attribution is denied, mentions pass ---

    def assert_denied(self, result, because=None):
        """A deny; with `because`, one whose reason holds that text (the file it read)."""
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip(), "expected a deny, got silence")
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["permissionDecision"], "deny")
        if because is not None:
            self.assertIn(because, output["permissionDecisionReason"])

    def attr(self, command, **kw):
        return self.run_hook("no-ai-attribution", command, **kw)

    def test_malformed_payload_lets_the_call_through(self):
        # onFailure blocks a crash, so input the guard cannot read must exit 0, not 1.
        env = dict(os.environ, HOME=self.home, CLAUDE_PROJECT_DIR=REPO, BINDWRIGHT_HELPER=HELPER)
        env.pop("USERPROFILE", None)
        with open(os.path.join(self.home, "body.md"), "w", encoding="utf-8") as f:
            f.write("A plain body.")
        bad_cwd = '{"cwd": 5, "tool_input": {"command": "gh pr create --body-file body.md"}}'
        for payload in ("[]", '{"tool_input": "x"}', '{"tool_input": {"command": 5}}', bad_cwd):
            with self.subTest(payload=payload):
                result = subprocess.run(
                    [SH, "-c", settings_command("no-ai-attribution")], input=payload.encode(),
                    capture_output=True, env=env, cwd=self.home, timeout=60)
                self.assert_passes(result)

    def test_ai_co_author_is_denied(self):
        self.assert_denied(self.attr(f"git commit -m 'docs: x' -m '{AI_TRAILER}'"))

    def test_human_co_author_passes(self):
        self.assert_passes(self.attr(f"git commit -m 'docs: x' -m '{HUMAN_TRAILER}'"))

    def test_generated_with_line_is_denied(self):
        for line, result in self.each(
                (GENERATED_LINE, "Written by an AI assistant", "docs: x via " + "Cla" + "ude Code"),
                lambda line: self.attr(f"git commit -m 'docs: x' -m '{line}'")):
            with self.subTest(line=line):
                self.assert_denied(result)
        self.assert_denied(self.attr(f"git commit-tree HEAD^{{tree}} -p HEAD -m '{GENERATED_LINE}'"))

    def test_session_link_and_robot_are_denied(self):
        for body, result in self.each((SESSION_LINK, "Done \U0001F916", "Cla" + "ude-Session: abc"),
                lambda body: self.attr(f"gh pr comment 5 --body '{body}'")):
            with self.subTest(body=body):
                self.assert_denied(result)

    def test_plain_mentions_pass(self):
        for command, result in self.each((
            "git commit -m 'fix(hooks): block force pushes in " + "Cla" + "ude Code sessions'",
            "git commit -m 'docs: update CLAUDE.md and .claude/rules/git.md'",
            "gh pr comment 1 --repo starfoxcom/claude-code-templates --body 'docs: x'",
            "gh pr create --title 't' --body 'See https://github.com/starfoxcom/claude-code-templates/issues/3 "
            "and https://starfoxcom.github.io/claude-code-templates/'",
            "gh pr create --head hotfix/drop-admin-text-claude-yml --title 'fix(ci): x' --body 'y'",
            f"gh pr comment 5 --body '{DEEP_TRIGGER} - re-check on the parser'",
            "git commit -m 'fix(ui): show pointer with cursor on toggle rows'",
            "git commit -m 'docs: add guide for using " + "Cla" + "ude Code'",
            "git commit -m 'feat(bind): generate settings compatible with " + "Cla" + "ude Code'",
            "git commit -m 'docs(rules): clarify what counts as a commit with AI trailers'",
            "git commit -m 'feat: add integration with LLM providers'",
        ), lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_cursor_tool_name_is_denied(self):
        self.assert_denied(self.attr("git commit -m 'feat: x' -m 'Written with Cursor AI'"))

    def test_colon_trailer_forms_are_denied(self):
        for line, result in self.each(("Assisted-by: " + "Cla" + "ude:opus", "Generated-by: " + "Cla" + "ude",
                     "Generated by: an AI assistant", "Generated with: " + "Cla" + "ude Code",
                     "Made-with: Cursor", "Co-written-by: Cursor"),
                             lambda line: self.attr(f"git commit -m 'docs: x' -m '{line}'")):
            with self.subTest(line=line):
                self.assert_denied(result)

    def test_colon_after_a_plain_phrase_passes(self):
        for line, result in self.each(("Made with: love", "Generated files: see below", "Created by: Jane Doe",
                     "Generated: AI model card", "Made: cursor hover state"),
                             lambda line: self.attr(f"git commit -m 'docs: x' -m '{line}'")):
            with self.subTest(line=line):
                self.assert_passes(result)

    def test_the_ci_check_can_import_the_hook(self):
        # The Attribution workflow loads develop's copy as a module and reads
        # these two names; importing it must not run main() or read stdin. A
        # main() call at import exits through SystemExit, which prints here.
        import sys
        path = os.path.join(REPO, "_core", "global-template", "hooks", "no-ai-attribution.py")
        code = ("import importlib.util, sys\n"
                "spec = importlib.util.spec_from_file_location('attribution_hook', sys.argv[1])\n"
                "hook = importlib.util.module_from_spec(spec)\n"
                "try:\n"
                "    spec.loader.exec_module(hook)\n"
                "except SystemExit:\n"
                "    print('exited')\n"
                "assert hook.ATTRIBUTION.search and callable(hook.strip_paths)\n")
        result = subprocess.run([sys.executable, "-c", code, path], input="", capture_output=True,
                                text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_attribution_next_to_repo_name_is_denied(self):
        self.assert_denied(self.attr(
            f"gh pr comment 1 --repo starfoxcom/claude-code-templates --body '{AI_TRAILER}'"))


    def test_everyday_commands_pass(self):
        for command, result in self.each(("git cherry-pick -n abc123", "git revert -n abc123", "git tag -n",
                        "git merge -n feature/x", "git commit -m 'docs(hooks): explain core.hooksPath and -n'",
                        "gh pr comment 5 --body 'Run `npm test` first'",
                        'git commit -m "feat(hooks): add eval fixture"',
                        "gh api graphql -f query='query($owner: String!) { repository(owner: $owner) { id } }' "
                        "-F owner=o",
                        "gh gist create --filename notes.txt -",
                        "gh api repos/o/r/issues/5/comments -F body=@-",
                        'gh issue create --template "Bug report"',
                        "gh pr create --template default.md --base develop",
                        "gh repo create x --template o/r",
                        "gh pr create --title t --body-file - <<'EOF'\n## What\n| a | b |\n|---|---|\nEOF"),
                                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_file_flags_mentioned_in_message_text_pass(self):
        for command, result in self.each(("git commit -m 'fix(hooks): honor --file=path form'",
                        'git commit -m "docs(hooks): add Get-Content example"',
                        "gh pr comment 5 --body 'the -F flag is case-sensitive'",
                        "gh pr create --title t --body-file - <<'EOF'\nUse --body-file notes.md here\nEOF",
                        "gh pr create --title t --body @'\nthe -F flag reads a file\n'@"),
                                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_lowercase_f_is_not_a_message_file(self):
        for command, result in self.each(("git tag -f v1.0.0", "gh pr create -f --base develop"),
                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_attribution_inside_a_heredoc_is_denied(self):
        self.assert_denied(self.attr(f"gh pr create --title t --body-file - <<'EOF'\n{AI_TRAILER}\nEOF"))

    def body_file(self, text):
        fd, path = tempfile.mkstemp(suffix=".md")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        self.addCleanup(os.remove, path)
        return path

    def test_stop_parsing_is_refused_as_unreadable(self):
        # After `--%` the program splits the raw text by its own rules, which the parser cannot follow.
        self.assert_denied(self.attr('gh pr create --% --title t --body-file "x.md"', tool="PowerShell"),
                           "Write it as plain commands")

    def test_attribution_in_a_body_file_is_denied(self):
        path = self.body_file(f"## What\n- x\n\n{GENERATED_LINE}\n")
        for command, result in self.each((f'gh pr create --title t --body-file "{path}"', f'git commit -F "{path}"',
                        f'git commit -F"{path}"', f'gh pr create --title t --body-file="{path}"',
                        f'git commit --file="{path}"', f"git commit --template='{path}'"),
                                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_denied(result)

    def test_backticks_in_a_message_do_not_hide_a_body_file(self):
        # In bash a backtick is not an escape inside double quotes; in
        # PowerShell it is, and a doubled backtick is a literal one.
        path = self.body_file(f"## What\n- x\n\n{GENERATED_LINE}\n")
        self.assert_denied(self.attr(f'git commit -m "docs: run `make`" -F "{path}"'))
        self.assert_denied(self.attr(f'git commit -m "docs: run ``make``" -F "{path}"', tool="PowerShell"))

    def test_clean_body_file_passes(self):
        path = self.body_file("## What\n- Ships the guard\n\n## Why\nFewer surprises.\n")
        for command, result in self.each((f'gh pr create --title t --body-file "{path}"',
                        f'gh pr create --title t --body-file="{path}"'), lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_unreadable_body_file_is_denied(self):
        for command, result in self.each(("gh pr create --title t --body-file /no/such/body.md",
                        "gh pr create --title t --body-file=/no/such/body.md"), lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_denied(result)

    def test_field_body_file_is_read(self):
        path = self.body_file(f"{GENERATED_LINE}\n")
        for command, result in self.each((f'gh api repos/o/r/issues/5/comments --field body=@"{path}"',
                        f'gh api repos/o/r/issues/5/comments --field=body=@{path}'),
                                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_denied(result)
        # A quoted path with a space is read whole: a clean file there passes, not "could not read".
        spaced = os.path.join(os.path.dirname(self.body_file("Plain body.\n")), "body with space.md")
        with open(spaced, "w", encoding="utf-8") as f:
            f.write("Plain body.\n")
        self.addCleanup(os.remove, spaced)
        for command, result in self.each((f'gh api repos/o/r/issues/5/comments -F body=@"{spaced}"',
                        f"gh api repos/o/r/issues/5/comments --field body=@'{spaced}'"),
                                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_file_flags_of_other_stages_are_not_read(self):
        # Every file flag of a writing command is read, except one in a text tool's own stage.
        path = self.body_file(f"{GENERATED_LINE}\n")
        for command, result in self.each(("git show HEAD:.claude/hooks/push-guard.py | grep -F word",
                        "git show HEAD:.git/hooks/commit-msg | grep -F word",
                        "git tag --list | awk -F. '{print $1}'",
                        "gh api repos/o/r/pulls | awk -F'\\t' '{print $1}'",
                        "gh pr create --title 'a && b; c' --body x | awk -F, '{print}'"),
                                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)
        for (command, tool), result in self.each((
                (f'Get-Content "{path}" | gh issue create --title t --body-file -', "PowerShell"),
                (f'$body = Get-Content "{path}" -Raw\ngh pr create --title t --body $body', "PowerShell"),
                (f"gh pr create --title 'a && b' --body-file \"{path}\"", "Bash"),
                (f'gh pr create --title x \\\n  --body-file "{path}"', "Bash"),
                (f'gh pr create --title x `\n  --body-file "{path}"', "PowerShell"),
                (f'git commit -m x \\\n  -F "{path}"', "Bash"),
                (f'(git commit -F "{path}")', "Bash"),
                (f'echo $(git tag -a v1 -F "{path}")', "Bash"),
                (f'gh pr create --title "$(git log -1 | cut -c1-9)" -F "{path}"', "Bash"),
                (f'gh pr create --title $(git log -1 | cut -c1-9) -F "{path}"', "Bash"),
                (f'git commit\\\n  -F "{path}"', "Bash"),
                (f'gh release create v1 --title t \\\n  join.zip --notes-file "{path}"', "Bash"),
                (f'gh release create v1 --title t `\r\n  sort.txt --notes-file "{path}"', "PowerShell"),
                (f'grep -q x f; case $y in a) git commit -F "{path}";; esac', "Bash"),
                (f'git commit-tree HEAD^{{tree}} -p HEAD -F "{path}"', "Bash"),
                (f"gh pr create --title 'it'\\''s done' --body-file \"{path}\"", "Bash"),
                (f"gh pr create --title $'a\\'b' --body-file \"{path}\"", "Bash"),
                (f"gh pr create --title $'a\\'b\\'c' --body-file \"{path}\"", "Bash"),
                (f"gh pr create --title $$'a\\' --body-file \"{path}\"", "Bash"),
                (f"gh pr create --title \\$$'a\\'b' --body-file \"{path}\"", "Bash"),
                (f'sort `git commit -F "{path}"`', "Bash"),
                (f'grep -rn foo C:\\\\repo\\\\\ngit commit -F "{path}"', "Bash"),
                (f'grep x f \\\r\ngit commit -F "{path}"', "Bash"),
                (f'grep -q a\\(b f && case $y in y) git commit -F "{path}";; esac', "Bash"),
                (f'git commit -m x >& sort.log -F "{path}"', "Bash"),
                (f'git commit -m x >| sort.log -F "{path}"', "Bash"),
                (f'grep x f # ends in a backslash \\\ngit commit -F "{path}"', "Bash")),
                        lambda command, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_denied(result)

    def test_parser_reads_each_command_as_the_shell_does(self):
        path = self.body_file(f"{GENERATED_LINE}\n")
        for (command, tool), result in self.each((
                ("gh api repos/o/r/pulls --jq '.[].title' | grep -F word", "Bash"),
                ("git tag --list 'v*' | grep -F v3", "Bash"),
                ('git commit -m "$(cat msg.txt)" && git log | grep -F needle', "Bash"),
                ("git tag --list | cut -d@ -f1", "Bash"),
                ("git commit -m x && grep -rn -- --body-file .github/", "Bash"),
                ('git commit -m "see --body-file nowhere.md"', "Bash"),
                ("git commit -m x 2>&1 | grep -F x", "Bash"),
                ("git tag --list | Select-String -Pattern v3; sort -F x", "PowerShell"),
                ('git --git-dir="$D" commit -m x', "Bash"),
                ('gh api repos/o/r/issues -F "title=$T"', "Bash"),
                ("gh api repos/o/r/issues/5/comments -F body='<details>x</details>'", "Bash"),
                ("gh api repos/o/r/issues/5/comments -F 'body=see x=@y'", "Bash"),
                ("env GH_TOKEN=x gh api repos/o/r/issues/5/comments -F body='<b>x</b>'", "Bash"),
                ("curl -d '<b>x</b>' https://api.github.com/repos/o/r/issues", "Bash"),
                ('git commit -m "-F is now parsed"', "Bash"),
                ('git commit -am "-F is now parsed"', "Bash"),
                # `[` is the test command, not a pattern, so the command is read as written.
                ('[ -n "$X" ] && git commit -m "--file=x is gone"', "Bash"),
                ('git commit -vm "--file=x is gone"', "Bash"),
                ('git merge -nm "--file=x is gone" feature', "Bash"),
                ('env A=1 git commit -sm "--file=x is gone"', "Bash"),
                ('env A=1 git commit -m "--file=x is gone"', "Bash"),
                ('gh release create v1 -n "--notes-file x is gone"', "Bash"),
                ('gh pr comment 5 --body "--body-file=x was ignored"', "Bash"),
                ("git grep -F needle && git commit -m x", "Bash"),
                ("npm create vite@latest app -- --template react && git commit -m init", "Bash"),
                ('npm create "$PKG" app --template react && git commit -m init', "Bash"),
                ('env A=1 gh issue create --title "$T" --label bug --template bug.md', "Bash"),
                ('sudo git commit -am "-From now on x"', "PowerShell"),
                ('timeout 5 $GIT commit -m "--file=x" && powershell -Command "Stop-Process -Force"', "Bash"),
                ('python - <<\'EOF\' 2>/dev/null || true\nrun(["gh", "api", "--input", "-"])\nEOF\ngit commit -m x',
                 "Bash")), lambda command, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_passes(result)
        for (command, tool), result in self.each((
                (f'gh pr create --title "$(echo "x; sort y")" --body-file "{path}"', "Bash"),
                (f'gh pr create --title "`echo "x; sort y"`" --body-file "{path}"', "Bash"),
                (f'gh pr create --title "${{T:-"x; sort y"}}" --body-file "{path}"', "Bash"),
                (f'sort=1 git commit -F "{path}"', "Bash"),
                (f"gh pr create --title “a; sort b” --body-file {path}", "PowerShell"),
                ("gh pr create --title t --body-file \"$HOME/body.md\"", "Bash"),
                ('cd "$(git rev-parse --show-toplevel)"; git commit -F msg.txt', "Bash"),
                (f'git --git-dir .git commit -F "{path}"', "Bash"),
                (f'git $OPTS commit -F "{path}"', "Bash"),
                ('gh pr create --title t --body-file="$HOME/body.md"', "Bash"),
                ('curl -d @"$f" https://api.github.com/repos/o/r/issues', "Bash"),
                (f'env A=1 git commit -F "{path}"', "Bash"),
                (f'sudo gh pr create --title t --body-file "{path}"', "Bash"),
                (f'& "C:\\Program Files\\Git\\cmd\\git.exe" commit -F "{path}"', "PowerShell"),
                (f'sudo -u git gh pr create --title t --body-file "{path}"', "Bash"),
                (f'Invoke-RestMethod -Uri https://api.github.com/x -InFile:"{path}"', "PowerShell"),
                (f'$GIT commit -F "{path}"', "Bash"),
                (f'"$(command -v gh)" pr create --title t --body-file "{path}"', "Bash"),
                (f'& $git commit -F "{path}"', "PowerShell"),
                (f'gh pr merge 5 -m -F "{path}"', "Bash"),
                ('gh pr merge 5 -m --body-file="my notes/body.md"', "Bash"),
                (f'curl -X PATCH https://api.github.com/repos/git/git -d @"{path}"', "Bash"),
                (f'sudo -u git curl -d @"{path}" https://api.github.com/repos/o/r/issues', "Bash"),
                (f'Get-Content -Path:"{path}" | gh issue create --title t --body-file -', "PowerShell"),
                ("gh api repos/o/r/issues -F 'body='\"@$f\"", "Bash"),
                (f'git ci -F "{path}" && git push', "Bash"),
                (f'env A=1 git commit --template "{path}"', "Bash"),
                (f'$GIT commit --template "{path}"', "Bash"),
                (f'timeout 5 $GIT commit --template "{path}"', "Bash"),
                (f'nice -n 5 $GIT commit --template "{path}"', "Bash"),
                (f'gh pr create --title "$T" --body "$B" --body-file "{path}"', "Bash"),
                (f"curl.exe https://api.github.com/repos/o/r/issues -Fbody=@{path}", "PowerShell"),
                ("& $git commit -Fmsg", "PowerShell"),
                (f'flock lock $GIT commit --template "{path}"', "Bash"),
                (f'git notes add -mcalm -F "{path}"', "Bash"),
                (f'git commit -cm -F "{path}"', "Bash"),
                (f'git merge -sm -F "{path}" feature', "Bash"),
                (f'git commit-tree -pm -F "{path}" HEAD^{{tree}}', "Bash"),
                (f'pwsh -Command Get-Content "{path}" | gh pr comment 5 --body-file -', "Bash"),
                (f'powershell -NoProfile -Command gc "{path}" | gh pr comment 5 --body-file -', "PowerShell"),
                (f'gh pr create --title t <<EOF --body-file "{path}"\nx\nEOF', "Bash"),
                (f'gh pr create --title t <<EOF 2>/dev/null --body-file "{path}"\nx\nEOF', "Bash"),
                (f'gh pr create --title t 2>&- --body-file="{path}"', "Bash"),
                (f'! git commit > log -F "{path}"', "Bash"),
                (f'git log | gh pr comment 5 > out --body-file "{path}"', "Bash"),
                (f'gh release create v1 --title $ --notes-file "{path}"', "Bash"),
                (f"cat <<'EOF'; gh pr comment 5 \\\n  --body-file \"{path}\"\nhello\nEOF\necho done", "Bash"),
                (f"cat <<'EOF' > a.md; cat <<'EOF2' > b.md\na\nEOF\nb\nEOF2\ngit commit -F \"{path}\"", "Bash")),
                        lambda command, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_denied(result, f"found in file {path}" if path in command else None)

    def test_shapes_the_parser_cannot_read_are_refused_with_the_way_out(self):
        # An array, `--%` and a comment ending in a backslash are never guessed at.
        path = self.body_file(f"{GENERATED_LINE}\n")
        for (command, tool), result in self.each((
                ('args=(--title t --template bug.md); gh issue create "${args[@]}"', "Bash"),
                (f"git commit --% --date=now; sort -F {path}", "PowerShell"),
                (f'gh pr create --% --title t --body-file "{path}"', "PowerShell"),
                (f'grep x f # ends in a backslash \\\ngit commit -F "{path}"', "Bash"),
                (f"curl.exe https://api.github.com/repos/o/r/issues -d@{path}", "PowerShell"),
                (f'args=(\n  --title "feat: x"\n  --body-file "{path}"\n)\ngh pr create "${{args[@]}}"', "Bash")),
                        lambda command, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_denied(result, "Write it as plain commands")

    def test_brace_and_pattern_words_are_read_as_built_at_run_time(self):
        # The file such a word names is never read as a literal, quotes inside it included
        # (`ms["g"]` is the pattern `ms[g]`).
        for command, result in self.each(("gh pr create --body-file={a,b}", "git commit -F msg{1..3}.txt",
                                          'git commit -F ms["g"]', "gh pr create --body-file=[a\"b\"]"),
                                         lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_denied(result, "text the shell builds at run time")

    def project_with(self, files):
        """A throwaway project with the guard and the given {relative path: text} files."""
        root = self.temp_project(("run-hook.sh", "no-ai-attribution.py"))
        for name, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(root, name)), exist_ok=True)
            with open(os.path.join(root, name), "w", encoding="utf-8") as fh:
                fh.write(text)
        return root

    def test_body_file_is_read_in_the_folder_the_command_runs_in(self):
        # Each commit reads a flagged msg.txt; a wrong folder would scan a clean copy. A `cd` in a
        # child shell, or one that fails, leaves git in the first folder, so it is read there too.
        root = self.project_with({"msg.txt": f"{GENERATED_LINE}\n", "sub/msg.txt": "x\n",
                                  "sub/sub/msg.txt": f"{GENERATED_LINE}\n"})
        outer = os.path.join(root, "msg.txt")
        for command, result in self.each(
                ("(cd sub; true); git commit -F msg.txt", "cd sub | true; git commit -F msg.txt",
                        "pushd sub; popd; git commit -F msg.txt", "{ cd sub; true; } & git commit -F msg.txt",
                        "cd sub && true & git commit -F msg.txt", "cd sub; git commit -F msg.txt"),
                                lambda command: self.attr(command, project=root)):
            with self.subTest(command=command):
                self.assert_denied(result, f"found in file {outer}")
        clean = self.project_with({"msg.txt": "x\n", "sub/other.txt": "x\n"})
        for command, result in self.each(
                ("(cd sub && true); git commit -F msg.txt", "pushd sub; popd; git commit -F msg.txt",
                        "cd; git commit -F msg.txt"), lambda command: self.attr(command, project=clean)):
            with self.subTest(command=command):
                self.assert_passes(result)
        # `cd -` goes to a folder the text does not hold; a loop or a function can run a later
        # `cd` first; git takes `-C -` as a folder named `-`.
        hidden = "the command text cannot tell"
        for (command, tool, reason), result in self.each((
                ("cd -; git commit -F msg.txt", "Bash", hidden),
                ("cd ~-; git commit -F msg.txt", "Bash", hidden),
                ("cd /no/such/folder && git commit -F msg.txt", "Bash", hidden),
                ("cd sub -ErrorAction Stop; git commit -F msg.txt", "PowerShell", hidden),
                ("git -C - commit -F msg.txt", "Bash", hidden)),
                        lambda command, tool, reason: self.attr(command, tool=tool, project=clean)):
            with self.subTest(command=command):
                self.assert_denied(result, reason)
        # An absolute target names the folder again, whatever came before it.
        absolute = root.replace("\\", "/")
        for command, result in self.each((f'(cd sub; true); cd "{absolute}"; git commit -F msg.txt',
                        f'pushd sub; popd; git -C "{absolute}" commit -F msg.txt'),
                                lambda command: self.attr(command, project=root)):
            with self.subTest(command=command):
                self.assert_denied(result, "found in file")
        moved = self.project_with({"msg.txt": "x\n", "sub/msg.txt": f"{GENERATED_LINE}\n"})
        # A loop, a function or a trap can run a later `cd` before an earlier write.
        for (command, tool), result in self.each((("f() { git commit -F msg.txt; }; cd sub; f", "Bash"),
                              ("for i in 1 2; do git commit -F msg.txt; cd sub; done", "Bash"),
                              ("switch (1,2) { default { git commit -F msg.txt; Set-Location sub } }", "PowerShell"),
                              ("class A { static [void] M() { git commit -F msg.txt } }; cd sub; [A]::M()",
                               "PowerShell"),
                              ("Get-Item x -ErrorAction Stop; git commit -F msg.txt; trap { cd sub; continue }",
                               "PowerShell")), lambda command, tool: self.attr(command, tool=tool, project=moved)):
            with self.subTest(command=command):
                self.assert_denied(result, "found in file")
        for command, result in self.each(("env A=1 git -C sub commit -F msg.txt",
                        "env A=1 git -C sub merge feature/gh -F msg.txt"),
                                lambda command: self.attr(command, project=moved)):
            with self.subTest(command=command):
                self.assert_denied(result, "found in file")
        # A command held in an array runs wherever it is used, and a `-C` git cannot see (in an
        # array, behind a run-time word) moves it to a folder the text cannot place.
        for command, result in self.each(('cmd=(git -C sub commit -F msg.txt); "${cmd[@]}"',
                        '"$WRAP" "$ARG" git -C sub commit -F msg.txt',
                        "$GIT -C sub commit -F msg.txt", "env $GIT -C sub commit -F msg.txt"),
                                lambda command: self.attr(command, project=moved)):
            with self.subTest(command=command):
                self.assert_denied(result)
        # A second relative `cd` that fails from the first folder leaves the shell where it was.
        nested = self.project_with({"msg.txt": "x\n", "a/msg.txt": "x\n", "a/b/msg.txt": f"{GENERATED_LINE}\n"})
        for command, result in self.each(("cd a && cd b && git commit -F msg.txt", "git -C a -C b commit -F msg.txt"),
                lambda command: self.attr(command, project=nested)):
            with self.subTest(command=command):
                self.assert_denied(result,
                                   f"found in file {os.path.join(nested, 'a', 'b', 'msg.txt')}")

    def test_a_node_inside_the_project_is_never_run(self):
        # A repo could ship its own `node` (Windows also finds one in the current folder by itself).
        root = self.project_with({})
        marker = os.path.join(root, "ran.txt")
        for name, text in (("node", f"#!/bin/sh\necho x > '{marker}'\n"), ("node.cmd", f"@echo x > \"{marker}\"\r\n")):
            with open(os.path.join(root, name), "w", newline="") as f:
                f.write(text)
            os.chmod(os.path.join(root, name), 0o755)
        # With the project's own `node` first on PATH, the guard has no parser and refuses.
        self.assert_denied(self.attr("git commit -m x", project=root,
                                     path=root + os.pathsep + os.environ.get("PATH", "")), "Install Node")
        self.assertFalse(os.path.exists(marker))

    def test_without_its_parser_the_guard_refuses_what_it_reads(self):
        old = os.path.join(self.home, "old-helper")
        os.makedirs(os.path.join(old, "hooks"))
        with open(os.path.join(old, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as f:
            f.write('process.stdout.write(JSON.stringify({error: false, commands: [["git", "commit"]]}));\n')
        broken = os.path.join(self.home, "broken-helper")
        os.makedirs(os.path.join(broken, "hooks"))
        with open(os.path.join(broken, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as f:
            f.write("process.exit(1);\n")
        for helper, because in ((os.path.join(self.home, "none"), "Run /bindwright:update to install it"),
                                (old, "older than this guard"), (broken, "reinstall Bindwright's helper")):
            for command, result in self.each(("git commit -m x", "gh issue create --title t --template bug.md",
                            "git config core.hooksPath /x"), lambda command: self.attr(command, helper=helper)):
                with self.subTest(helper=helper, command=command):
                    self.assert_denied(result, because)
            self.assert_passes(self.attr("ls -la", helper=helper))
        # A Node older than 18 cannot run the parser, so the reason names Node, not the helper.
        old_node = os.path.join(self.home, "old-node")
        os.makedirs(old_node)
        for name, text in (("node", '#!/bin/sh\n[ "$1" = --version ] && echo v12.22.9 || exit 1\n'),
                           ("node.cmd", '@if "%~1"=="--version" (echo v12.22.9) else (exit /b 1)\r\n')):
            with open(os.path.join(old_node, name), "w", newline="") as f:
                f.write(text)
            os.chmod(os.path.join(old_node, name), 0o755)
        self.assert_denied(self.attr("git commit -m x", path=old_node + os.pathsep + os.environ.get("PATH", "")),
                           "Install Node")

    def test_a_wrapped_gh_keeps_its_template_name(self):
        self.assert_passes(self.attr("env GH_TOKEN=x gh issue create --title t --template bug.md"))

    def test_parser_runs_from_a_helper_reached_through_a_symlink(self):
        link = os.path.join(self.home, "helper-link")
        try:
            os.symlink(HELPER, link, target_is_directory=True)
        except OSError:
            # Windows without the symlink right: a junction needs none, and Node resolves it too.
            subprocess.run(["cmd", "/c", "mklink", "/J", link, HELPER], check=True, capture_output=True)
        # Without its parser the guard refuses, so a pass means the parser ran.
        self.assert_passes(self.attr("git tag --list | awk -F. '{print $1}'", helper=link))

    def test_unreadable_command_names_the_cause(self):
        result = self.attr("git commit -m x \\\r\n -F missing.md")
        self.assert_denied(result)
        reason = json.loads(result.stdout)["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("could not read this command", reason)
        self.assertNotIn("/bindwright:update", reason)

    def test_routes_past_the_hooks_are_refused(self):
        hooks, setting, trailer, reuse, lefthook = ("git hook bypass", "changes which hooks git runs",
                                                    "--trailer is not allowed", "reusing another",
                                                    "turning lefthook off")
        for (command, because, tool), result in self.each((
                ("git commit -n -m x", hooks, "Bash"), ("git commit -nm x", hooks, "Bash"),
                ("git commit --no-veri -m x", hooks, "Bash"), ("git am -n mail.patch", hooks, "Bash"),
                ("git push --no-verify", hooks, "Bash"), ("env A=1 git commit -n -m x", hooks, "Bash"),
                ("git commit -u --no-verify -m x", hooks, "Bash"),
                ("git commit --include --no-verify -m x f", hooks, "Bash"),
                ("git commit --patch -n -m x", hooks, "Bash"),
                ("$GIT commit -n -m x", hooks, "Bash"),
                ("git -c core.hooksPath=/dev/null commit -m x", setting, "Bash"),
                ("git --config-env=core.hooksPath=H commit -m x", setting, "Bash"),
                ("git config core.hooksPath /dev/null", setting, "Bash"),
                ("git config set --global hook.lint.enabled false", setting, "Bash"),
                ("git config --unset core.hooksPath", setting, "Bash"),
                ("git config --global \\\n  core.hooksPath /dev/null", setting, "Bash"),
                ("git config core.hooksPath --get", setting, "Bash"),
                ("git config --remove-section hook.lint", setting, "Bash"),
                ("git config --typ path core.hooksPath /dev/null", setting, "Bash"),
                ("env --uns X LEFTHOOK=0 git commit -m x", lefthook, "Bash"),
                ("git config set --typ path core.hooksPath /x", setting, "Bash"),
                ("git config --co --get core.hooksPath /x", setting, "Bash"),
                ("git config remove-section --global hook.lint", setting, "Bash"),
                ("git config --rename-section core old", setting, "Bash"),
                ("cat <<'EOF' > notes.txt; git commit -m x \\\n  --no-verify\nbody\nEOF", hooks, "Bash"),
                ('git commit --trailer "a: b" -m x', trailer, "Bash"), ("git commit --tr=a:b -m x", trailer, "Bash"),
                ("git commit -C HEAD", reuse, "Bash"), ("git commit --reuse-mes HEAD", reuse, "Bash"),
                ("LEFTHOOK=0 git push", lefthook, "Bash"), ("env LEFTHOOK=false git commit -m x", lefthook, "Bash"),
                ("export LEFTHOOK=0", lefthook, "Bash"), ("npx lefthook uninstall", lefthook, "Bash"),
                ('$env:LEFTHOOK = "0"; git commit -m x', lefthook, "PowerShell")),
                        lambda command, because, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_denied(result, because)
        # Each option keeps git's own meaning, a value is never an option, and a read passes.
        for command, result in self.each(
                ("git commit -m -n", 'git commit -m "say --no-verify"', "git commit -m x -- -n",
                        "git push -n", "git merge -n feature", "git tag -n", "git am -c mail.patch",
                        "git commit --amend --no-edit", "git config core.hooksPath",
                        "git config --remove-section alias", "git config --type=path --get core.hooksPath",
                        "git config get core.hooksPath && git commit -m x", '$GIT commit -m "--file=x"',
                        '"$S/bin/actionlint.exe" x && git commit -m x',
                        'git commit -m "LEFTHOOK=0 skips it"', "LEFTHOOK=1 git push",
                        'git commit -m "LEFTHOOK=0"', 'grep -rn "LEFTHOOK=0" docs/', "echo LEFTHOOK=0",
                        "git commit -uno -m x", "git commit -Sn0key -m x"), lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_shapes_the_grammars_reject_are_read_as_the_shell_reads_them(self):
        # A here-doc with a redirect or a command on its first line, a redirect target in several
        # pieces, and PowerShell's `name='value'` with brackets in the value.
        for (command, tool), result in self.each((("git commit -F - <<'EOF' >/dev/null; git log -1\nmsg\nEOF", "Bash"),
                              ("for id in 1 2; do gh api r/$id > $K/r-$id.json; done && git commit -m x", "Bash"),
                              ("gh api graphql -f query='query{user(login:\"x\"){id}}'", "PowerShell")),
                                      lambda command, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_passes(result)
        # A here-doc with more on its line, an arithmetic `<<` and a quoted redirect target.
        for command, result in self.each(("git commit -F - <<'EOF' >/dev/null && git push --no-verify\nmsg\nEOF",
                        "echo $((1<<true >1))\ncat <<'E' >/dev/null; git commit --no-verify -m x\nhi\nE",
                        'cat <<EOF >"a b"; git commit -n -m x\nx\nEOF'), lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_denied(result, "git hook bypass")

    def test_shipped_bash_parser_reads_escapes_as_bash_does(self):
        # Runs helper/parsers/shell-words-bash.wasm itself, so the rows prove the shipped bytes.
        script = os.path.join(HELPER, "hooks", "shell-words.mjs")
        for (command, words), result in self.each((
                ('git commit -m "a\\\\\nb"', ["git", "commit", "-m", "a\\\nb"]),
                ('git commit -m "a\\\nb"', ["git", "commit", "-m", "ab"]),
                ("git commit -m a\\\\\\\nb", ["git", "commit", "-m", "a\\b"])),
                lambda command, words: subprocess.run(["node", script, "bash"], input=command.encode("utf-8"),
                                                      capture_output=True, timeout=60)):
            with self.subTest(command=command):
                self.assertEqual(json.loads(result.stdout)["commands"], [words], result.stderr)

    def test_vendored_parsers_match_their_recorded_hashes(self):
        with open(os.path.join(HELPER, "parsers", "SOURCE.md"), encoding="utf-8") as fh:
            rows = re.findall(r"^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|$", fh.read(), re.M)
        self.assertEqual(len(rows), 5)
        for name, digest in rows:
            with self.subTest(name), open(os.path.join(HELPER, "parsers", name), "rb") as fh:
                self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), digest)

    def test_read_only_commands_pass(self):
        for command, result in self.each(("git log -5", "gh pr view 5 --json body", "git config --get core.hooksPath"),
                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)


class HookSourceTest(unittest.TestCase):
    """Every shipped hook and script compiles without a warning.

    Python compiles a hook on each call, so a warning such as an invalid
    escape (a DeprecationWarning before 3.12, a SyntaxWarning from 3.12)
    reaches stderr on every tool call."""

    DIRS = (".claude/hooks", "_core/global-template/hooks",
            "_core/project-template/.claude/hooks", "_core/project-template/.claude/scripts")

    def test_compiles_without_warnings(self):
        files = [os.path.join(d, name) for d in self.DIRS
                 for name in sorted(os.listdir(os.path.join(REPO, d))) if name.endswith(".py")]
        self.assertGreaterEqual(len(files), 7)
        for rel in files:
            with self.subTest(file=rel):
                with open(os.path.join(REPO, rel), encoding="utf-8") as f:
                    source = f.read()
                with warnings.catch_warnings():
                    warnings.simplefilter("error")
                    compile(source, rel, "exec")


if __name__ == "__main__":
    unittest.main()
