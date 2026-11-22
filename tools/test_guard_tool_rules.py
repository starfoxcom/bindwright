"""In-process tests of the tool-rules guard: each rule's mode, the rows that ship in observe mode,
and a seeded sweep of mentions against calls. The tests that run it as a hook process live in
test_guard_hooks.py."""
import json
import os
import shutil
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_tool_rules():
    import importlib.util
    path = os.path.join(REPO, "_core", "global-template", "hooks", "tool-rules.py")
    spec = importlib.util.spec_from_file_location("tool_rules", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
    ROWS = (("gh run rerun 5 --failed", "bash", RERUN), ("gh run rerun 5 --job 7", "powershell", RERUN),
            ("gh run rerun 5", "bash", None),
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
