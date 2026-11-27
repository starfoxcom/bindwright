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
import shlex
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
# Brace forms checked against real bash: lists, ranges, steps, padding, escapes, quotes, nesting,
# empties, dots in a list, and the forms that must get no reading (a `$`, a range across cases).
BRACE_ROWS = (
    "{{a,b}", "{a,b}}", r"\{a,b}", r"{a\,b}", '{a","b}', '{a,b"}"}', "{a..3}", "{1..10..0}", "{01..03}",
    "{a..e..2}", "{1..5..-2}", "{5..1}", "{a,{b,c}d}", "{,}", "{a,}{b,}", "-{F,}m.txt", "{-03..2}",
    r"{a,b\}}", '{"a,b"}', "{a..c}{1..2}", 'a{b,c}"d"', "{1..3..2}", "{z..x}", "{A..c}", "'{a,b}'",
    r"{a,b}\ ", "{,a}", "{}", "{a}", "{1..}", "{a,b}{}", "{$,x}HOME", r"{\$,x}H", "{O..a..12}-]n",
    "-{V..a..6}-x", "{a..c}{X..Z}", "{1..a}", "{-1..1}", "{-F,../msg.txt}", "{1..2,3}", "{-n,-m..}",
    '{a,""}', "''{,}", "x{,}")
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
    @classmethod
    def setUpClass(cls):
        # The first Node start on a Windows runner (cold disk cache, the virus scanner reading
        # node.exe) can pass the guard's parse time limit; one start here keeps it out of the rows.
        node = shutil.which("node")
        for shell in ("bash", "powershell") if node else ():
            subprocess.run([node, os.path.join(HELPER, "hooks", "shell-words.mjs"), shell],
                           input=b"true", capture_output=True, timeout=60)

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def run_hook(self, name, command, project=REPO, tool="Bash", path=None, helper=HELPER):
        # The guard parses commands with the helper setup installs; here, the repo's own copy.
        env = dict(os.environ, HOME=self.home, CLAUDE_PROJECT_DIR=project, BINDWRIGHT_HELPER=helper)
        env["USERPROFILE"] = self.home  # where Python on Windows looks for the home folder
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
            package = name[:-3].replace("-", "_")  # a hook's package, as an install copies it
            if name.endswith(".py") and os.path.isdir(os.path.join(REPO, ".claude", "hooks", package)):
                shutil.copytree(os.path.join(REPO, ".claude", "hooks", package),
                                os.path.join(root, ".claude", "hooks", package),
                                ignore=shutil.ignore_patterns("__pycache__"))
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
        # The whole answer, since a refusal's reason comes after the cut of a long bytes diff.
        self.assertEqual(result.stdout.strip(), b"", result.stdout.decode("utf-8", "replace"))

    def test_force_push_is_blocked(self):
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH))

    def test_powershell_force_push_is_blocked(self):
        self.assert_blocked(self.run_hook("push-guard", FORCE_PUSH, tool="PowerShell"))

    def test_force_with_lease_passes(self):
        self.assert_passes(self.run_hook("push-guard", "git push --force-with-lease origin feature/x"))

    def test_plain_push_passes(self):
        self.assert_passes(self.run_hook("push-guard", "git push origin feature/x"))

    def test_tool_rules_refuse_each_pattern_and_pass_mentions(self):
        refused = (("python - <<'EOF'\nprint('C:\\\\x')\nEOF", "Bash"),
                   ("cat <<EOF | python -\nre.compile('\\\\d')\nEOF", "Bash"),
                   ("python -c \"print('a\\\\b')\"", "Bash"), ("node -e \"console.log('a\\\\b')\"", "Bash"),
                   ("python3 -c \"\nimport re\nprint(re.sub(r'\\\\s', '', x))\n\"", "Bash"),
                   ("node -e \"\nconsole.log('a\\\\b')\n\"", "Bash"),
                   ("@'\nprint('C:\\\\x')\n'@ | python -", "PowerShell"), ("gh run watch 123", "Bash"),
                   ("python .github/scripts/size_check.py && git commit -qm x", "Bash"),
                   ("git push -u origin x && gh pr create --base develop", "Bash"),
                   ("git checkout develop -- .", "Bash"), ("gh pr merge 5 --merge --admin", "Bash"),
                   ("# it's fine\ngh run watch 1", "Bash"), ("<# note #> gh run watch 1", "PowerShell"),
                   ("sleep 1 & python - <<'EOF'\nprint('C:\\\\x')\nEOF", "Bash"),
                   ("python - 2>&1 <<'EOF'\nprint('C:\\\\x')\nEOF", "Bash"),
                   ("cat <<'EOF' | python3\nprint('C:\\\\x')\nEOF", "Bash"),
                   ("bash -s arg <<'EOF'\necho C:\\\\x\nEOF", "Bash"),
                   ("@'\nprint('C:\\\\x')\n'@ | node", "PowerShell"),
                   ("@'\nWrite-Host C:\\\\x\n'@ | pwsh -Command -", "PowerShell"),
                   ("cat <<'EOF' | sed s/a/b/ | python3\nprint('C:\\\\x')\nEOF", "Bash"))
        passing = (("python - <<'EOF'\nprint('hi')\nEOF", "Bash"),
                   ("git commit -F - <<'EOF'\nfix: C:\\\\path\nEOF", "Bash"),
                   ("python3 tools/x.py && git commit -F - <<'EOF'\nfix: C:\\\\path\nEOF", "Bash"),
                   ("@'\nfix: it's why gh run watch is refused\n'@ | git commit -F -", "PowerShell"),
                   ("cat <<'EOF' > notes.md\nC:\\\\x\nEOF", "Bash"), ('python -c "print(1)"', "Bash"),
                   ('git commit -m "never use gh run watch"', "Bash"),
                   ('git commit -m "size_check.py before git push"', "Bash"),
                   ("git add .github/scripts/size_check.py && git commit -m x", "Bash"),
                   ("git checkout -q -b feature/x", "Bash"), ("git checkout -- file.txt", "Bash"),
                   ("gh pr merge 5 --merge", "Bash"), ("node script.mjs C:\\\\x", "Bash"),
                   ("git show origin/develop:./.claude/settings.json", "Bash"),
                   ('git commit -m "read it with git show HEAD:.claude/x"', "Bash"),
                   ('gh pr create --title "Bump Node to 22" --body "$(cat <<\'EOF\'\nC:\\\\Users\nEOF\n)"', "Bash"),
                   ("git commit -F - <<'EOF'\r\ndocs: stop using gh run watch\r\n\r\nWhy: x\r\nEOF", "Bash"),
                   ("git commit -m 'docs: don'\\''t chain git push and gh pr create'", "Bash"),
                   ('git commit -m "docs: never `"gh run watch`" here"', "PowerShell"),
                   ('Copy-Item a "dist\\"; git commit -m "docs: never gh run watch"', "PowerShell"),
                   ("python3 tools/confirm.py <<< yes\nprintf 'done\\n'", "Bash"),
                   ('python3 tools/confirm.py <<<"yes"\nprintf \'done\\n\'', "Bash"),
                   ('python3 x.py "$((1 << n))"\nprintf \'a\\n\'', "Bash"),
                   ('python3 x.py "a << b"\nprintf \'a\\n\'', "Bash"),
                   ("python3 x.py # feeds << EOF\nprintf 'a\\n'", "Bash"),
                   ('python3 -c "\nmask = 1 << bit | 1 << other\nprint(mask)\n"', "Bash"),
                   ("echo x\nprintf a << b << c", "Bash"),
                   ('git commit -m "docs: never use gh run watch\n\nfeed cat <<EOF lines to it\nmore\n"', "Bash"),
                   ("git commit -m \"docs: x\nA script fed to python <<EOF loses them:\nprint('C:\\\\x')\n\"", "Bash"),
                   ("git commit -F - <<\\EOF\ndocs: never use gh run watch\nEOF", "Bash"),
                   ('git commit -m "$(cat <<\'EOF\'\nfix: never "gh run watch" here\nEOF\n)"', "Bash"),
                   ('git commit -m "docs: a << b\nnever gh run watch\n"', "PowerShell"),
                   ("git commit -m \"$(cat <<'EOF'\ndocs: fed with \"python <<EOF\" it loses\n"
                    "print('C:\\\\x')\nEOF\n)\"", "Bash"),
                   ("gh pr create --body \"$(cat <<'EOF'\nfed with \"node <<JS\" it breaks\n"
                    "C:\\\\x\nEOF\n)\"", "Bash"),
                   ("# Commit the fix; it can't wait\ngit commit -m \"docs: don't use gh run watch\"", "Bash"),
                   ("# don't amend\ngit commit -m \"docs: it's why python <<EOF eats\nC:\\\\x paths\"", "Bash"),
                   ("<# Don't chain these #>\ngit commit -m 'docs: never use gh run watch'", "PowerShell"),
                   ("<#\nNever use gh run watch here.\n#>\nls", "PowerShell"),
                   ("git commit -m \"docs: pipe the script in as\n@'\nprint('C:\\\\x')\n'@ | python -\n\"",
                    "PowerShell"),
                   ("<#\n@'\nprint('C:\\\\x')\n'@ | python -\n#>\nls", "PowerShell"),
                   ("python3 -m http.server 8000 & cat <<'EOF' > notes.md\nC:\\\\x\nEOF", "Bash"),
                   ("python3 tools/check.py <<'EOF'\n{\"path\": \"C:\\\\x\"}\nEOF", "Bash"),
                   ("cat <<'EOF' | node x.mjs\nC:\\\\x\nEOF", "Bash"),
                   ("cat <<'EOF' | grep -c node\nC:\\\\x\nEOF", "Bash"),
                   ("@'\nC:\\\\x\n'@ | node x.mjs", "PowerShell"),
                   ("@'\nC:\\\\x\n'@ | Set-Content run.txt; python x.py", "PowerShell"),
                   ("perl -pe 's/a/b/' <<'EOF'\nC:\\\\x\nEOF", "Bash"),
                   ("bash -ec 'cat' <<'EOF'\nC:\\\\x\nEOF", "Bash"),
                   ("python3 -Ic 'import sys' <<'EOF'\nC:\\\\x\nEOF", "Bash"),
                   ("node --eval='process.stdin.pipe(process.stdout)' <<'EOF'\nC:\\\\x\nEOF", "Bash"),
                   ("bash -sc 'cat' <<'EOF'\nC:\\\\x\nEOF", "Bash"),
                   ("php -r 'echo 1;' <<'EOF'\nC:\\\\x\nEOF", "Bash"),
                   ("python3 gen.py <<'EOF' | sh\nC:\\\\x\nEOF", "Bash"),
                   ("cat <<'EOF' | python3 tool.py | bash\nC:\\\\x\nEOF", "Bash"),
                   ("git commit -m \"docs: python -c 'print(\\\\x)' eats it\"", "Bash"),
                   ("git commit -F - <<'EOF'\nfix: python -c 'print(\\\\x)' ate it\nEOF", "Bash"),
                   ("git add engine/bind.py .github/scripts/size_check.py && git commit -m x", "Bash"),
                   ("python3 \"$HOOK\" <<'EOF'\n{\"p\": \"C:\\\\x\"}\nEOF", "Bash"),
                   ("python3 -c \"import sys\" && git commit -m \"docs: python -c 'print(\\\\x)' eats it\"", "Bash"),
                   ("python3 -c 'print(1)'; git commit -F - <<'EOF'\n"
                    "fix: python -c 'print(\\\\x)' ate it\nEOF", "Bash"),
                   ("python3 -c \"print(1)\"  # unlike python -c 'C:\\\\x'", "Bash"),
                   ("git commit -m $'docs: don\\'t use gh run watch'", "Bash"),
                   ('git commit -m "$(printf "never gh run watch")"', "Bash"))
        # Only Git Bash rewrites a dot-led rev path; elsewhere it is read as written.
        rev_dot_path = (("git show origin/develop:.claude/settings.json", "Bash"),)
        refused += rev_dot_path if os.name == "nt" else ()
        passing += () if os.name == "nt" else rev_dot_path
        run = lambda command, tool: self.run_hook("tool-rules", command, tool=tool)  # noqa: E731
        for (command, _), result in self.each(refused, run):
            with self.subTest(command=command):
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(b"BLOCKED (tool rule)", result.stdout)
        for (command, _), result in self.each(passing, run):
            with self.subTest(command=command):
                self.assert_passes(result)

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
        env["USERPROFILE"] = self.home  # where Python on Windows looks for the home folder
        with open(os.path.join(self.home, "body.md"), "w", encoding="utf-8") as f:
            f.write("A plain body.")
        bad_cwd = '{"cwd": 5, "tool_input": {"command": "gh pr create --body-file body.md"}}'
        bash_payloads = ('{"tool_name": "Bash", "tool_input": "x"}',
                         '{"tool_name": "Bash", "tool_input": {"command": 5}}')
        for guard in ("no-ai-attribution", "push-guard"):
            for payload in ("[]", '{"tool_input": "x"}', '{"tool_input": {"command": 5}}', bad_cwd, *bash_payloads):
                with self.subTest(guard=guard, payload=payload):
                    result = subprocess.run(
                        [SH, "-c", settings_command(guard)], input=payload.encode(),
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

    def test_a_guard_without_its_package_refuses_only_what_names_a_route(self):
        # A copy of the hook file alone cannot read a command, so it refuses as without the parser.
        root = self.temp_project(("run-hook.sh",))
        hooks = os.path.join(root, ".claude", "hooks")
        shutil.copy(os.path.join(REPO, ".claude", "hooks", "no-ai-attribution.py"), hooks)
        for command in ("git commit -m x", "g\\it commit -m x", "git config core.hooksPath x"):
            with self.subTest(command=command):
                self.assert_denied(self.attr(command, project=root), "global-template/hooks/no_ai_attribution")
        # The two restores the refusal names pass, and so does a read.
        restore = f"cp -r {os.path.join(REPO, '_core', 'global-template', 'hooks', 'no_ai_attribution')} {hooks}"
        for command in ("git status --porcelain", "git checkout -- .claude/hooks/no_ai_attribution", restore):
            with self.subTest(command=command):
                self.assert_passes(self.attr(command, project=root))
        shutil.copytree(os.path.join(REPO, "_core", "global-template", "hooks", "no_ai_attribution"),
                        os.path.join(hooks, "no_ai_attribution"))  # what the cp line does
        # A file beside the hook never stands in for a module the guard imports.
        with open(os.path.join(hooks, "subprocess.py"), "w", encoding="utf-8") as f:
            f.write("raise SystemExit(3)\n")
        self.assert_denied(self.attr("git commit --no-verify -m x", project=root), "--no-verify")

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
                # The guard cannot tell a file the command writes from one it looks for elsewhere.
                self.assert_denied(result, "write it in an earlier call; otherwise use a literal absolute path")

    def unconverted_twin(self, path, text):
        """Writes `text` where `path` in Git Bash form lands when nothing converts it: the
        `\\<drive letter>\\<rest>` on the drive the command runs on. Removes every folder it made."""
        twin = os.path.splitdrive(REPO)[0] + "\\" + path[0].lower() + path[2:]
        top = os.path.dirname(twin)
        while not os.path.isdir(os.path.dirname(top)):
            top = os.path.dirname(top)
        if not os.path.isdir(top):
            self.addCleanup(shutil.rmtree, top, ignore_errors=True)
        os.makedirs(os.path.dirname(twin), exist_ok=True)
        with open(twin, "w", encoding="utf-8") as f:
            f.write(text)
        self.addCleanup(lambda: os.path.exists(twin) and os.remove(twin))

    def test_git_bash_drive_paths_name_the_drive(self):
        """On Windows, `/c/x` is drive C when Git Bash converts it and `\\c\\x` on the command's
        own drive when nothing does, so the guard reads both; elsewhere it is a plain path."""
        if os.name != "nt":
            rows = [("plain path", "gh pr create --title t --body-file /c/no-such/body.md", "Bash",
                     "message/body file /c/no-such/body.md was not found where the guard reads it")]
        else:
            def git_bash(path):
                return "/" + path[0].lower() + path[2:].replace("\\", "/")
            marking = f"## What\n- x\n\n{GENERATED_LINE}\n"
            marked = self.body_file(marking)
            clean = self.body_file("## What\n- Ships the guard\n")
            covered = self.body_file("## What\n- Ships the guard\n")
            self.unconverted_twin(covered, marking)  # a clean file where conversion points
            folder, name = os.path.split(marked)
            rows = [
                ("body file", f'gh pr create --title t --body-file "{git_bash(marked)}"', "Bash"),
                ("body file after cd", f'cd "{git_bash(folder)}"; git commit -F "{name}"', "Bash"),
                ("PowerShell", f'gh pr create --title t --body-file "{git_bash(marked)}"', "PowerShell"),
                ("bash inside PowerShell", f'Set-Location "{git_bash(folder)}"; bash -c "git commit -F {name}"',
                 "PowerShell"),
                ("conversion off", f'MSYS_NO_PATHCONV=1 git commit -F "{git_bash(covered)}"', "Bash"),
                ("spelling left alone", f'git commit -aF"{git_bash(covered)}"', "Bash"),
                ("WSL path", f'bash -c "git commit -F /mnt{git_bash(marked)}"', "PowerShell"),
            ]
            rows = [row + ("attribution marker",) for row in rows]
            rows.append(("clean body file", f'gh pr create --title t --body-file "{git_bash(clean)}"', "Bash", None))
            rows.append(("clean WSL path", f'bash -c "git commit -F /mnt{git_bash(clean)}"', "PowerShell", None))
        for (label, command, tool, because), result in self.each(
                rows, lambda label, command, tool, because: self.attr(command, tool=tool)):
            with self.subTest(label):
                if because is None:
                    self.assert_passes(result)
                else:
                    self.assert_denied(result, because)

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

    def test_pattern_and_mixed_brace_words_are_read_as_built_at_run_time(self):
        # The file such a word names is never read as a literal, quotes inside it included
        # (`ms["g"]` is the pattern `ms[g]`), nor a brace holding a part built at run time.
        for command, result in self.each(('git commit -F ms["g"]', "gh pr create --body-file=[a\"b\"]",
                                          "git commit -F {a,$B}", "git commit -F msg{1..3}*.txt",
                                          "git commit -F {A..c}"),
                                         lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_denied(result, "text the shell builds at run time")

    def test_plain_text_braces_are_read_as_the_words_bash_makes(self):
        # Bash expands `{-F,msg.txt}` to `-F msg.txt` before it runs git, so the file is read.
        flagged = self.body_file(f"{GENERATED_LINE}\n").replace("\\", "/")
        clean = self.body_file("Plain body.\n").replace("\\", "/")
        for (command, flags), result in self.each((
                (f"git commit {{-F,{flagged}}}", True), (f"gh pr create --title t {{--body-file,{flagged}}}", True),
                (f"gh pr create --title {{,}} --title --body-file {flagged}", True),
                (f"git commit {{-F,{clean}}}", False)),
                lambda command, flags: self.attr(command)):
            with self.subTest(command=command):
                if flags:
                    self.assert_denied(result, "attribution marker")
                else:
                    self.assert_passes(result)

    def test_a_brace_is_read_both_as_written_and_as_bash_expands_it(self):
        # A shell that does not expand braces (dash, `set +B`) gives git `-m '{,}' -n`, which skips
        # the hooks; bash gives `{-n,-m} x` as `-n -m x`. Either reading is refused.
        for (command, refused), result in self.each((
                ("git commit -m {,} -n", True), ("sh -c 'git commit -m {,} -n'", True),
                ("shopt -u -o braceexpand; git commit -m {,} -n", True), ("git commit {-n,-m} x", True),
                ("bash -c 'git commit {-n,-m} x'", True), ("git commit -m {,} -m -n", True),
                ("git commit -m x " + "{,}" * 30, False),
                ("git commit -m {a,b}", False)),
                lambda command, refused: self.attr(command)):
            with self.subTest(command=command):
                if refused:
                    self.assert_denied(result, "git hook bypass")
                else:
                    self.assert_passes(result)

    def project_with(self, files):
        """A throwaway project with the guard and the given {relative path: text} files."""
        root = self.temp_project(("run-hook.sh", "no-ai-attribution.py"))
        for name, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(root, name)), exist_ok=True)
            with open(os.path.join(root, name), "w", encoding="utf-8") as fh:
                fh.write(text)
        return root

    def test_a_git_cluster_ending_in_F_reads_its_file(self):
        root = self.project_with({"msg.txt": f"{GENERATED_LINE}\n"})
        path = os.path.join(root, "msg.txt")
        for command, result in self.each(
                ("git commit -aF msg.txt", "git commit -aFmsg.txt", "git commit -vaF msg.txt"),
                lambda command: self.attr(command, project=root)):
            with self.subTest(command=command):
                self.assert_denied(result, f"found in file {path}")
        # -S takes its key attached, so `F` is the key and msg.txt a path to commit; on other
        # subcommands a capital F is another option's value (`-bFeature-x` names a branch).
        for command, result in self.each(
                ("git commit -SF msg.txt", "git checkout -bFeature-x origin/develop && git push -u origin x"),
                lambda command: self.attr(command, project=root)):
            with self.subTest(command=command):
                self.assert_passes(result)
        # A cmdlet's whole-name -InFile keeps reading its file when the command names git.
        self.assert_denied(self.attr("Invoke-WebRequest https://api.github.com/repos/o/r/issues -Method Post "
                                     "-UserAgent git -inFile msg.txt", tool="PowerShell", project=root),
                           f"found in file {path}")

    def test_a_command_string_a_shell_runs_is_read_like_the_command(self):
        root = self.project_with({"msg.txt": f"{GENERATED_LINE}\n", "clean.txt": "x\n", "inner.txt": "x\n",
                                  "sub/msg.txt": "x\n", "sub/inner.txt": f"{GENERATED_LINE}\n"})
        deep = "git commit -m x"
        for _ in range(4):
            deep = f"bash -c {shlex.quote(deep)}"
        for (command, tool, reason), result in self.each((
                ("pwsh -co 'git commit --no-verify -m x'", "Bash", "nested PowerShell"),
                ("pwsh -c 'git' 'commit --no-verify -m \"see git push\"'", "Bash", "nested PowerShell"),
                ('powershell "git commit --no-verify -m x"', "PowerShell", "nested PowerShell"),
                ("pwsh -NoProfile -Command \"git commit -m 'fix: y'\"", "PowerShell", "nested PowerShell"),
                ("pwsh -Command { git commit --no-verify -m x }", "PowerShell", "--no-verify"),
                # A script file counts only first, and `powershell` reads a first plain word as a command.
                ('pwsh -Command "git commit --no-verify -m x; ./x.ps1"', "Bash", "nested PowerShell"),
                ("powershell ./x.ps1 ';' 'git commit --no-verify -m x'", "Bash", "nested PowerShell"),
                # From bash a word starting with `{` is text or a brace expansion, never a script block.
                ("pwsh -c {git,true}' commit --no-verify -m x'", "Bash", "nested PowerShell"),
                # A block followed by text words is part of the joined script.
                ("sudo pwsh -c {git commit} --no-verify -m x", "PowerShell", "nested PowerShell"),
                ("sudo pwsh -c git { commit --no-verify -m x }", "PowerShell", "nested PowerShell"),
                ("sudo pwsh -c '-not $x; git' { commit --no-verify -m x }", "PowerShell", "nested PowerShell"),
                # An assignment or an option value named like git is not the program.
                ("env HOME=/home/git bash -c 'git commit --no-verify -m x'", "Bash", "--no-verify"),
                ("sudo -u git bash -c 'git commit --no-verify -m x'", "Bash", "--no-verify"),
                ("flock sort bash -c 'git commit --no-verify -m x'", "Bash", "--no-verify"),
                ("bash -oe pipefail -c 'git commit --no-verify -m x'", "Bash", "--no-verify"),
                ("bash $OPTS -c 'git commit --no-verify -m x'", "Bash", "--no-verify"),
                ("bash -c 'git commit -F inner.txt'; bash -c 'cd sub; bash -c \"git commit -F inner.txt\"'",
                 "Bash", "found in file"),
                ("bash -c 'g\"i\"t commit --no-verify -m x'", "Bash", "--no-verify"),
                (deep, "Bash", "nested more than"),
                ("bash -c 'git commit --no-verify -m x'", "Bash", "--no-verify"),
                ("sh -ec 'git commit -n -m x'", "Bash", "--no-verify"),
                ("bash -euo pipefail -c 'git commit --no-verify -m x'", "Bash", "--no-verify"),
                ("bash -ceo pipefail 'git commit -n -m x'", "Bash", "--no-verify"),
                ("bash -c 'cd sub && git commit -F inner.txt'", "Bash", "found in file"),
                ("bash --norc -o pipefail -c -- 'git -c core.hooksPath=x commit -m x'", "Bash", "core.hooksPath"),
                ("bash -c \"bash -c 'git commit --trailer a=b -m x'\"", "Bash", "--trailer"),
                ("sudo zsh -c 'LEFTHOOK=0 git commit -m x'", "Bash", "lefthook"),
                ('bash -c "g\\it commit --no-verify $FLAGS"', "Bash", "built at run time"),
                # The inner shell joins a line its own quoting ends in `\`, which the outer text hides.
                ('bash -c "git \\\\\ncommit -F msg.txt -m x"', "Bash", "found in file"),
                (f"bash -c 'git \\'\"\ncommit -m x -m '{GENERATED_LINE}'\"", "Bash", "a shell runs"),
                ('bash -c "git \\\\\ncommit --no-verify $FLAGS"', "Bash", "built at run time"),
                ('bash -c "git commit $FLAGS -m x"', "Bash", "built at run time")),
                lambda command, tool, reason: self.attr(command, tool=tool, project=root)):
            with self.subTest(command=command):
                self.assert_denied(result, reason)
        for (command, tool), result in self.each((
                ("bash -c 'git commit -F clean.txt'", "Bash"), ("bash -c 'git status --no-verify'", "Bash"),
                ("bash ./build.sh; git commit -m x", "Bash"), ("pwsh ./x.ps1; git commit -m x", "PowerShell"),
                ("pwsh ./build.ps1 -c $cfg; git commit -m x", "Bash"),
                ('gh issue create --label bash --body "git push fails on $BRANCH"', "Bash"),
                ('sudo gh issue create --label bash --body "use git commit --no-verify to skip"', "Bash"),
                ("pwsh -NoProfile -Command { git commit -m 'fix: y' }", "PowerShell"),
                # A child shell's `cd` never moves the commands around it.
                ("sh -c 'cd /no/such/folder && git commit -m x' && git commit -F clean.txt", "Bash"),
                ('pwsh ./build.ps1 -Message "git push done"', "Bash"),
                ('pwsh -NoProfile ./build.ps1 -Message "git push done"', "PowerShell")),
                lambda command, tool: self.attr(command, tool=tool, project=root)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_a_cd_run_again_moves_on_from_its_last_folder(self):
        # A loop or a function runs a `cd` again from the folder its last run reached.
        nested = self.project_with({"msg.txt": "x\n", "sub/msg.txt": "x\n", "sub/sub/msg.txt": f"{GENERATED_LINE}\n"})
        moved = os.path.join(nested, "sub", "sub", "msg.txt")
        for command, result in self.each(("for i in 1 2; do cd sub; done; git commit -F msg.txt",
                                          "f() { cd sub; }; f; f; git commit -F msg.txt"),
                                         lambda command: self.attr(command, project=nested)):
            with self.subTest(command=command):
                self.assert_denied(result, f"found in file {moved}")
        # Windows reads `link\..` by name, so a link to a folder already placed keeps its own parent.
        if os.name == "nt":
            import _winapi
            linked = self.project_with({"msg.txt": "x\n", "real/msg.txt": "x\n", "w/msg.txt": f"{GENERATED_LINE}\n"})
            _winapi.CreateJunction(os.path.join(linked, "real"), os.path.join(linked, "w", "link"))
            self.assert_denied(self.attr("cd real; cd w/link; cd ..; git commit -F msg.txt", project=linked),
                               "found in file")
        # The first run still needs its folder to exist then: a later `cd` cannot place a folder made first.
        made = self.project_with({"msg.txt": "x\n", "other/x/msg.txt": "x\n"})
        self.assert_denied(self.attr('mkdir x; cd x; git commit -F msg.txt; cd other', project=made),
                           "the command text cannot tell")

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
        # A wrapped `cd` and env's own folder option move git too; `command -v cd` only prints.
        inner = self.project_with({"msg.txt": "x\n", "sub/msg.txt": f"{GENERATED_LINE}\n"})
        moved = os.path.join(inner, "sub", "msg.txt")
        for command, result in self.each(
                ("builtin cd sub && git commit -F msg.txt", "command cd sub; git commit -F msg.txt",
                 "command -p cd sub; git commit -F msg.txt", "env -C sub git commit -F msg.txt",
                 "env -Csub git commit -F msg.txt", "env --chdir=sub git commit -F msg.txt",
                 "env --ch sub git commit -F msg.txt", "env -i -C sub git commit -F msg.txt",
                 "env -iC sub git commit -F msg.txt"),
                lambda command: self.attr(command, project=inner)):
            with self.subTest(command=command):
                self.assert_denied(result, f"found in file {moved}")
        self.assert_denied(self.attr("git commit -t sub/msg.txt", project=inner),
                           f"found in file {os.path.join(inner, 'sub/msg.txt')}")
        # A folder built at run time cannot be placed, however env's option is spelled.
        for command, result in self.each(
                ('env --chdir="$ROOT" git commit -F msg.txt', "env -C$ROOT git commit -F msg.txt",
                 "env $OPTS -C sub git commit -F msg.txt"), lambda command: self.attr(command, project=inner)):
            with self.subTest(command=command):
                self.assert_denied(result)
        for command, result in self.each(
                ("command -v cd sub; git commit -F msg.txt", "env -u sub git commit -F msg.txt",
                 "env -uC sub git commit -F msg.txt", "env A=$B git commit -F msg.txt",
                 "rg TODO env -C 3; git commit -F msg.txt", "git checkout -t sub/msg.txt"),
                lambda command: self.attr(command, project=inner)):
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
        # With the project's own `node` first on PATH, the guard skips it and reads with the next one.
        self.assert_passes(self.attr("git commit -m x", project=root,
                                     path=root + os.pathsep + os.environ.get("PATH", "")))
        self.assertFalse(os.path.exists(marker))

    def test_without_its_parser_the_guard_refuses_what_it_reads(self):
        old = os.path.join(self.home, "old-helper")
        os.makedirs(os.path.join(old, "hooks"))
        with open(os.path.join(old, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as f:
            f.write('process.stdout.write(JSON.stringify({error: false, commands: [["git", "commit"]]}));\n')
        # One that reads run-time words without saying which can expand to nothing is too old too.
        older = os.path.join(self.home, "older-helper")
        os.makedirs(os.path.join(older, "hooks"))
        with open(os.path.join(older, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as f:
            f.write('process.stdout.write(JSON.stringify({error: false, assignments: [],'
                    ' commands: [["git", "commit", {dynamic: "$X"}]]}));\n')
        shaped = os.path.join(self.home, "shaped-helper")
        os.makedirs(os.path.join(shaped, "hooks"))
        with open(os.path.join(shaped, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as f:
            f.write('process.stdout.write(JSON.stringify({error: false, assignments: [],'
                    ' commands: [["git", "commit", {dynamic: "$X", shape: "x"}]]}));\n')
        broken = os.path.join(self.home, "broken-helper")
        os.makedirs(os.path.join(broken, "hooks"))
        with open(os.path.join(broken, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as f:
            f.write("process.exit(1);\n")
        # Replies of the wrong shape: a command that is not a list, a word neither text nor an object,
        # a brace reading that is not a list of strings.
        built = ('[["git", "commit", {dynamic: "{a,b}", shape: "{a,b}", canBeEmpty: false, canBeMany: false,'
                 ' braces: %s}]]')
        malformed = []
        for name, commands in (("listless", '["git commit"]'), ("numbered", '[["git", "commit", 5]]'),
                               ("null-braces", built % "null"), ("number-braces", built % "5"),
                               ("text-braces", built % '"ab"')):
            folder = os.path.join(self.home, name + "-helper")
            os.makedirs(os.path.join(folder, "hooks"))
            with open(os.path.join(folder, "hooks", "shell-words.mjs"), "w", encoding="utf-8") as f:
                f.write('process.stdout.write(JSON.stringify({error: false, assignments: [], commands: %s}));\n'
                        % commands)
            malformed.append((folder, "reinstall Bindwright's helper"))
        for helper, because in ((os.path.join(self.home, "none"), "Run /bindwright:update to install it"),
                                (old, "older than this guard"), (older, "older than this guard"),
                                (shaped, "older than this guard"), (broken, "reinstall Bindwright's helper"),
                                *malformed):
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

    def test_a_subcommand_built_at_run_time_is_refused(self):
        # A word built at run time in git's subcommand place, with no subcommand written after it,
        # may hold a commit and its options, so the call is refused; one that names its subcommand passes.
        for (command, tool), result in self.each(
                (('git "$@"', "Bash"), ('g() { git "$@"; }; g commit -m x', "Bash"),
                 ('git -C sub "${a[@]}"', "Bash"), ("git $SUB", "Bash"), ("git @a", "PowerShell"),
                 ("git $a", "PowerShell"), ("& git @a", "PowerShell"), ('git.exe "$@"', "Bash"),
                 ('git -C "my dir" "$@"', "Bash"), ('git -c user.name="A B" "$@"', "Bash"),
                 ('git 2>/dev/null "$@"', "Bash"), ('git > out.txt "$@"', "Bash"),
                 ('git "$@" -m x', "Bash"), ('g() { git "$@" --no-verify -m x; }; g commit', "Bash"),
                 ('env A=1 git "$@"', "Bash"), ("sudo git $S", "Bash"), ('sudo -u root git "$@"', "Bash"),
                 ('sudo -nu root git "$@"', "Bash"), ('exec -a name git "$@"', "Bash"),
                 ('git "$@" -m merge', "Bash"), ('git "$@" -- config', "Bash"),
                 ('"git" -C "my dir" "$@"', "Bash"), ('git -q 2>a "$@"', "Bash"),
                 ("g'i't \"$@\"", "Bash"), ('gi""t "${a[@]}"', "Bash"), ("git `cat sub` -m x", "Bash"),
                 ("g`it @a", "PowerShell"), ("git `\n@a", "PowerShell"), ('sudo -uroot git "$@"', "Bash"),
                 ('git "$@" -sm "msg"', "Bash"), ('g() { git "$@" --mess x; }; g commit --no-verify', "Bash"),
                 ('sudo --us root git "$@"', "Bash"), ('nice --adj 5 git "$@"', "Bash"),
                 ('/usr/bin/time -o t.log git "$@"', "Bash"), ('command env -v git "$@"', "Bash"),
                 ("$a = 'commit','-m','x'; git ($a)", "PowerShell"), ('timeout 30 git "$@"', "Bash"),
                 ('timeout -s KILL 30 stdbuf -oL git "$@"', "Bash"),
                 ('f() { timeout 60 git "$@"; }; f commit --no-verify -m x', "Bash"),
                 ('git "-C$d" "$@"', "Bash"), ('git -C "$@"', "Bash"), ('git -c "$@"', "Bash"),
                 ('gin() { git -C "$@"; }; gin . commit -m x', "Bash"),
                 ('g() { git -C "$@" --no-verify -m x; }; g . commit', "Bash"),
                 ('env "${vars[@]}" git "$@"', "Bash"), ('sudo $SUDO_FLAGS git "$@"', "Bash"),
                 ('sudo -E timeout 30 git "$@"', "Bash"), ('env "${v[@]}" timeout 30 sudo -u r git "$@"', "Bash"),
                 ('f() { sudo -E timeout 30 git "$@"; }; f commit --no-verify -m x', "Bash"),
                 ('env -i timeout 30 git "$@"', "Bash"), ('sudo -n chrt 99 git "$@"', "Bash"),
                 ('chrt -f 99 timeout 30 git "$@"', "Bash"), ('taskset -c 0 timeout 30 git "$@"', "Bash"),
                 ('timeout --foreground 30 chrt 99 git "$@"', "Bash"), ('timeout -- 30 chrt 99 git "$@"', "Bash"),
                 ('timeout -v 30 taskset 0x1 git "$@"', "Bash"), ('taskset $OPTS 0 timeout 30 git "$@"', "Bash"),
                 ('f() { chrt -f 99 timeout 30 git "$@"; }; f commit --no-verify -m x', "Bash"),
                 ('sudo "$flag" git "$@"', "Bash"), ('chrt "$policy" 99 git "$@"', "Bash"),
                 ('nice "$NICE_ARG" git "$@"', "Bash"), ('timeout "$killopt" 30 git "$@"', "Bash"),
                 ('env "$assign" git "$@"', "Bash"),
                 ('f() { sudo "$flag" git "$@"; }; f commit --no-verify -m x', "Bash"),
                 ("sudo " * 1500 + 'git "$@"', "Bash"),
                 ('g() { git --namespace="$@"; }; g x commit --no-verify -m y', "Bash"),
                 ("git --git-dir=$ARGS", "Bash"), ('git --work-tree="${a[@]}" -m x', "Bash"),
                 ('git -C"$@"', "Bash")),
                lambda command, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_denied(result, "takes its subcommand from a word built at run time")
        # A git only named as an argument, or inside a word built at run time, runs nothing.
        for command, result in self.each(
                ('git log "$range"', 'git config "$@" user.name x', 'grep git "$file"', "echo git $x",
                 "apt-get install -y git $EXTRA_PKGS", 'cp -r "$src/.git" "$dst"',
                 'gh pr create --title "$(git log -1 --format=%s)" --body "$body"',
                 'git tag "v$(git describe)" "$sha"', 'git -C "$dir" log', "sudo git $OPTS status",
                 'repos=(a b); for r in "${repos[@]}"; do git -C "$r" status; done', 'command -v git "$x"',
                 '"$(git rev-parse --show-toplevel)/run.sh" "$1"', "git $OPTS rerere", 'git "$@" .',
                 'command -pv git "$x"', "git add $f1 $f2 $f3 $f4 $f5 $f6 $f7 $f8 $f9 $f10 $f11",
                 "apt-get install -y git $p1 $p2 $p3 $p4 $p5 $p6 $p7 $p8 $p9 $p10 $p11",
                 'timeout 30 git log "$range"', 'git "-C$repo" --no-pager log "$range"',
                 "sudo -E " * 40 + 'flock f git "$@"', "sudo -E " * 300 + "flock f" + " git" * 300 + ' "$@"',
                 'git "--git-dir=$d" -c user.name=x commit -m "fix: y"', "git --git-dir=$d log",
                 'git "--namespace=$ns" log'),
                lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)
        # Only git's own options between a list and a subcommand written out: git reads them itself.
        for (command, tool), result in self.each(
                (('git -C $repo -c user.name=x commit -m "fix: y"', "PowerShell"),
                 ("git -C $repo --no-pager log", "PowerShell"),
                 ('git -C $repo --exec-path=/opt/git-core commit -m "fix: y"', "Bash"),
                 ("for d in */; do git -C $d --no-pager log -1; done", "Bash")),
                lambda command, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_passes(result)

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
                ("git config set -- core.hooksPath --list", setting, "Bash"),
                ("git config set core.hooksPath -- --get", setting, "Bash"),
                ("git config core.hooksPath --", setting, "Bash"),
                (r"git config core.ho\oksPath /dev/null", setting, "Bash"),
                (r"git com\mit -n -m x", hooks, "Bash"),
                ("env -iu FOO LEFTHOOK=0 git commit -m x", lefthook, "Bash"),
                ("env -iuFOO LEFTHOOK=0 git commit -m x", lefthook, "Bash"),
                ("git config -zt path core.hooksPath /x", setting, "Bash"),
                ("git config -zf .git/config core.hooksPath /x", setting, "Bash"),
                ('export "LEFTHOOK=0"', lefthook, "Bash"), ("declare -x LEFT'HOOK'=0", lefthook, "Bash"),
                ("git com'mit' --no-verify -m x", hooks, "Bash"),
                ("git con'fig' core.hooksPath /x", setting, "Bash"),
                ("git config $SCOPE core.hooksPath /x", setting, "Bash"),
                ("git config unset $SCOPE core.hooksPath", setting, "Bash"),
                ("git $OPTS commit --no-verify -m x", hooks, "Bash"),
                ("git config $X set core.hooksPath /x", setting, "Bash"),
                ("git config $X unset core.hooksPath", setting, "Bash"),
                ("git config $X remove-section hook", setting, "Bash"),
                ("git config $X rename-section core other", setting, "Bash"),
                ("git $OPTS commit -m \"$MSG\" --no-verify", hooks, "Bash"),
                ("git config $SCOPE core.hooksPath \"$DIR\"", setting, "Bash"),
                ("git config \"$@\" core.hooksPath /x", setting, "Bash"),
                ("git -c core.hooksPath=\"$DIR\" commit -m x", setting, "Bash"),
                ("git --config-env=core.hooksPath=$NAME commit -m x", setting, "Bash"),
                ("git commit --reuse-message=\"$SHA\"", reuse, "Bash"), ('git commit -C"$SHA"', reuse, "Bash"),
                ('git commit --trailer="Reviewed-by: $WHO" -m x', trailer, "Bash"),
                ('git commit -nm"$MSG"', hooks, "Bash"),
                ('git config $(scope_for "$repo") core.hooksPath /x', setting, "Bash"),
                ('git ${OPTS:+"$OPTS"} commit --no-verify', hooks, "Bash"),
                ('git config "${scope[@]}" core.hooksPath /x', setting, "Bash"),
                ('git -c core.hooksPath=$dir commit -m x', setting, "PowerShell"),
                ('git -c "core.hooksPath=$HOME/none" commit -m x', setting, "Bash"),
                ('git "--config-env=core.hooksPath=$NAME" commit -m x', setting, "Bash"),
                ('git commit "--trailer=Co-authored-by: $WHO" -m x', trailer, "Bash"),
                ('git commit "--reuse-message=$SHA"', reuse, "Bash"), ('git commit "-C$SHA"', reuse, "Bash"),
                ('git "${!nope@}" -c core.hooksPath=/x commit -m x', setting, "Bash"),
                ('git config "$SECTION.hooksPath" /x', setting, "Bash"),
                ('git -c "$S.hooksPath=/x" commit -m x', setting, "Bash"),
                ("git --config-env=$S.hooksPath=NAME commit -m x", setting, "Bash"),
                ("git commit -${Q}n -m x", hooks, "Bash"), ("git commit -{n,q} -m x", hooks, "Bash"),
                ('git config "$s.hooksPath" /x', setting, "PowerShell"),
                ('git -c "$s.hooksPath=/x" commit -m x', setting, "PowerShell"),
                ('export "LEFTHOOK=$X" && git commit -m x', lefthook, "Bash"),
                ("git commit -${Q}m -n", hooks, "Bash"), ("git push -${Q}o --no-verify", hooks, "Bash"),
                ('export "LEFTHOOK+=$Z" && git commit -m x', lefthook, "Bash"),
                ("cat <<'EOF' > notes.txt; git commit -m x \\\n  --no-verify\nbody\nEOF", hooks, "Bash"),
                ('git commit --trailer "a: b" -m x', trailer, "Bash"), ("git commit --tr=a:b -m x", trailer, "Bash"),
                ("git commit -C HEAD", reuse, "Bash"), ("git commit --reuse-mes HEAD", reuse, "Bash"),
                ("LEFTHOOK=0 git push", lefthook, "Bash"), ("env LEFTHOOK=false git commit -m x", lefthook, "Bash"),
                ("export LEFTHOOK=0", lefthook, "Bash"), ("npx lefthook uninstall", lefthook, "Bash"),
                ('$env:LEFTHOOK = "0"; git commit -m x', lefthook, "PowerShell")),
                        lambda command, because, tool: self.attr(command, tool=tool)):
            with self.subTest(command=command):
                self.assert_denied(result, because)
        # Past ten words that can expand to nothing, a git call is refused rather than read part way.
        self.assert_denied(self.attr("git commit -m x $a $b $c $d $e $f $g $h $i $j $k"), "built at run time")
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
                        "git commit -uno -m x", "git commit -Sn0key -m x", 'git config "$KEY" v',
                        'git config user.name "$N"', "git $OPTS log -n 5",
                        "git config $X get core.hooksPath", 'git commit -m "$MSG" -- -n',
                        "git commit -m x $a $b $c $d $e $f $g $h $i $j", 'git commit -m"$MSG"',
                        'git push origin "$BRANCH"', 'export "PATH=$HOME/bin:$PATH" && git push',
                        'local "x=$1"; git push'), lambda command: self.attr(command)):
            with self.subTest(command=command):
                self.assert_passes(result)

    def test_cmdlet_parameters_stay_whole_and_unknown_names_stay_unread(self):
        ps, sh = "PowerShell", "Bash"
        # Rows of (command, tool, refusal text it names, or None when it passes).
        rows = (
            # A PowerShell parameter (`-Force`, `-Format`) is a whole name, never `-F` with a file.
            ('Stop-Process -Name app -Force; gh api repos/o/r/actions/runners', ps, None),
            ('Get-Date -Format "dddd"; gh issue list --repo o/r --json number', ps, None),
            # A program a cmdlet runs still reads a file through a flag written onto its value, and
            # a declaration whose name is built at run time stays unreadable.
            ('Start-Process curl.exe -ArgumentList "-Fbody=@notes.md" https://api.github.com/x', ps, "notes.md"),
            *((command, sh, "could not read this command") for command in (
                'export "$KV" && git push', 'export "A"=$X && git commit -m x',
                'export "A=$@" && git commit -m x', 'export "A=${U:-$@}" && git commit -m x')),
            # An `env` bundle whose letters are built at run time may take the next word or not,
            # each bundle on its own.
            *((command, sh, "lefthook") for command in (
                "env -${Q}u FOO LEFTHOOK=0 git commit -m x",
                "env --unset=${V} -${Q}u FOO LEFTHOOK=0 git commit -m x",
                "env -${A}u FOO -${B}i LEFTHOOK=0 git commit -m x", "env -$Qu LEFTHOOK=0 git commit -m x",
                'env -"$Q"u LEFTHOOK=0 git commit -m x', "env -$(echo u) FOO LEFTHOOK=0 git commit -m x",
                "env -`echo u` FOO LEFTHOOK=0 git commit -m x")),
            # Any PowerShell variable makes a bundle's letters unknown, so none takes the next word.
            *((command, ps, "no-verify") for command in (
                'git commit "-$^m" -n', 'git commit "-$$n" -m x', 'git commit "-$éam" -n')),
            # A hyphenated native program (no approved verb) keeps getopt's attached read, and git
            # run through a cmdlet under a Windows wrapper name is still git.
            ('ssh-agent $GIT commit "-Fnotes.txt"', ps, "notes.txt"),
            ('Start-Process git.cmd commit "-Fnotes.txt"', ps, "notes.txt"),
        )
        run = lambda command, tool, _: self.attr(command, tool=tool)  # noqa: E731
        for (command, _, names), result in self.each(rows, run):
            with self.subTest(command=command):
                if names is None:
                    self.assert_passes(result)
                else:
                    self.assert_denied(result, names)

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

    def test_shipped_bash_parser_reads_words_as_bash_does(self):
        # Runs helper/parsers/shell-words-bash.wasm itself, so the rows prove the shipped bytes.
        script = os.path.join(HELPER, "hooks", "shell-words.mjs")
        for (command, words), result in self.each((
                ('git commit -m "a\\\\\nb"', ["git", "commit", "-m", "a\\\nb"]),
                ('git commit -m "a\\\nb"', ["git", "commit", "-m", "ab"]),
                ("git commit -m a\\\\\\\nb", ["git", "commit", "-m", "a\\b"]),
                ("git commit {-F,/m.txt} -{n,q}", ["git", "commit", "-F", "/m.txt", "-n", "-q"]),
                ('echo {a,} {a,""} x{1..2} stash@{0} "{c,d}"',
                 ["echo", "a", "a", "", "x1", "x2", "stash@{0}", "{c,d}"]),
                ("echo {01..03} {1..5..-2} {a\\,b,c} {a..e..2} {X..Z} {-1..1}",
                 ["echo", "01", "02", "03", "1", "3", "5", "a,b", "c", "a", "c", "e", "X", "Y", "Z", "-1", "0", "1"])),
                lambda command, words: subprocess.run(["node", script, "bash"], input=command.encode("utf-8"),
                                                      capture_output=True, timeout=60)):
            with self.subTest(command=command):
                # A brace keeps its run-time word and carries bash's reading in `braces`.
                read = [each for word in json.loads(result.stdout)["commands"][0]
                        for each in (word.get("braces", [word]) if isinstance(word, dict) else [word])]
                self.assertEqual(read, words, result.stderr)
        # Bash expands `$HOME` again after `{$,x}HOME`, and a letter range across the cases makes `[`,
        # `\` or the backtick, which bash reads again: no reading.
        unread = b"echo {$,x}HOME {A..c} {O..a..12}-]n -{V..a..6}-x {1..a} {1..999999999}"
        out = subprocess.run(["node", script, "bash"], input=unread, capture_output=True, timeout=60)
        self.assertFalse([w for w in json.loads(out.stdout)["commands"][0][1:] if "braces" in w], out.stderr)

    def test_brace_readings_match_real_bash(self):
        # Bash is the oracle: every brace reading the shipped parser gives is the words bash makes.
        found = (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash"))
        bash = next((path for path in found if path and os.path.isfile(path)), None)
        if not bash:
            self.skipTest("no bash on this computer")
        script = os.path.join(HELPER, "hooks", "shell-words.mjs")
        source = "\n".join(f"x {row}" for row in BRACE_ROWS).encode("utf-8")
        parsed = json.loads(subprocess.run(["node", script, "bash"], input=source, capture_output=True,
                                           timeout=60).stdout)["commands"]
        program = "\n".join(f"printf '%s\\0' x {row}; printf '\\1'" for row in BRACE_ROWS)
        real = subprocess.run([bash, "--norc", "--noprofile", "-c", program], capture_output=True, timeout=60).stdout
        made = [chunk.decode("utf-8").split("\0")[:-1] for chunk in real.split(b"\1")[:-1]]
        self.assertEqual((len(parsed), len(made)), (len(BRACE_ROWS), len(BRACE_ROWS)))
        read = 0
        for row, words, bash_words in zip(BRACE_ROWS, parsed, made):
            if any(isinstance(word, dict) and "braces" in word for word in words):
                read += 1
                with self.subTest(row=row):
                    self.assertEqual([each for word in words for each in (
                        word.get("braces", [word]) if isinstance(word, dict) else [word])], bash_words)
        self.assertGreaterEqual(read, 25)

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

    DIRS = (".claude/hooks", "_core/global-template/hooks", "_core/project-template/.claude/hooks",
            "_core/project-template/.claude/scripts", ".claude/hooks/no_ai_attribution",
            "_core/global-template/hooks/no_ai_attribution", "_core/project-template/.claude/hooks/no_ai_attribution")

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


class RunnerChainSweepTest(unittest.TestCase):
    """A seeded sweep of the spellings a git call can take behind runners, read by the real parser
    and the attribution guard's routes: a subcommand from a list is always refused, a written one
    and a git only named as an argument always pass. GUARD_SWEEP_SEED replays a failing run."""

    RUNNERS = ("sudo", "sudo -E", "sudo -u root", "sudo -nu root", "sudo --preserve-env", 'sudo "$flag"',
               "sudo $SUDO_FLAGS", "env", "env A=1", "env -i", "env -u X", 'env "${vars[@]}"', 'env "$assign"',
               "timeout 30", "timeout -s KILL 30", "timeout --foreground 30", "timeout -- 30",
               'timeout "$killopt" 30', "nice", "nice -n 5", "nice --adj 5", 'nice "$NICE_ARG"', "chrt 99",
               "chrt -f 99", 'chrt "$policy" 99', "taskset 0x1", "taskset -c 0", "taskset $OPTS 0", "stdbuf -oL",
               "setsid", "ionice -c 2", "nohup", "exec", "exec -a name", "command", "time", "noglob", "xargs")
    GITS = ("git", "git.exe", '"git"', "g'i't", "/usr/bin/git")
    GIT_OPTIONS = ("", "-C sub", '-C "my dir"', "-c user.name=x", "--no-pager", '-C "$d"', "--git-dir=$d",
                   "-q 2>/dev/null")
    LISTS = ('"$@"', '"${args[@]}"', "$SUB", '"${a[@]}"')
    TAILS = ("", "-m x", "--no-verify -m x", '-sm "msg"', "-- config")
    SUBCOMMANDS = ("log", "status", "diff --stat", "show", "rev-parse HEAD")
    NAMERS = ("echo", "grep", "printf %s", "cp -r")
    SAMPLES = 300

    def setUp(self):
        import random
        import sys
        self.seed = int(os.environ.get("GUARD_SWEEP_SEED") or random.randrange(2 ** 32))
        self.rng = random.Random(self.seed)
        sys.path.insert(0, os.path.join(REPO, "_core", "global-template", "hooks"))
        from no_ai_attribution.routes import hook_route
        self.hook_route = hook_route

    def chain(self):
        return [self.rng.choice(self.RUNNERS) for _ in range(self.rng.randrange(4))]

    def git(self):
        return [self.rng.choice(self.GITS), self.rng.choice(self.GIT_OPTIONS)]

    def routes(self, commands):
        """The guard's route for each command, all read in one parser call. The input goes as bytes,
        as the guard sends it: a text pipe on Windows would turn each LF into CR LF."""
        if not shutil.which("node"):
            self.skipTest("the parser needs Node")
        result = subprocess.run(["node", os.path.join(HELPER, "hooks", "shell-words.mjs"), "bash"],
                                input="\n".join(commands).encode("utf-8"), capture_output=True, timeout=60)
        parsed = json.loads(result.stdout)
        self.assertFalse(parsed["error"], f"seed {self.seed}")
        self.assertEqual(len(parsed["commands"]), len(commands), f"seed {self.seed}")
        return [self.hook_route([([words], None, None)], [], only_built=True) for words in parsed["commands"]]

    def check(self, commands, expected):
        for command, route in zip(commands, self.routes(commands)):
            self.assertEqual(route, expected, f"{command!r} (replay with GUARD_SWEEP_SEED={self.seed})")

    def test_a_subcommand_from_a_list_is_always_refused(self):
        self.check([" ".join(filter(None, self.chain() + self.git()
                                    + [self.rng.choice(self.LISTS), self.rng.choice(self.TAILS)]))
                    for _ in range(self.SAMPLES)], "built")

    def test_a_written_subcommand_and_a_named_git_always_pass(self):
        written = [" ".join(filter(None, self.chain() + self.git()
                                   + [self.rng.choice(self.SUBCOMMANDS), self.rng.choice(self.LISTS)]))
                   for _ in range(self.SAMPLES)]
        named = [" ".join(filter(None, [self.rng.choice(self.NAMERS)] + self.chain() + self.git()
                                 + [self.rng.choice(self.LISTS)]))
                 for _ in range(self.SAMPLES)]
        self.check(written + named, None)


if __name__ == "__main__":
    unittest.main()
