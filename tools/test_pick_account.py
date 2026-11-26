"""Tests for .github/scripts/pick_account.py, which picks the account a review runs on."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, ".github", "scripts", "pick_account.py")
_spec = importlib.util.spec_from_file_location("pick_account", SCRIPT)
pick_account = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pick_account)

OK = {"type": "result", "subtype": "success", "is_error": False, "result": "OK"}


def answer(used=None, result=OK, as_array=True):
    """What `claude -p --output-format json --verbose` prints: the plan-use event, then the result."""
    if not as_array:
        return json.dumps(result)
    events = []
    if used is not None:
        windows = {"five_hour": {"utilization": used / 100, "status": "allowed"},
                   "seven_day": {"utilization": 0.01, "status": "allowed"}}
        events.append({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": windows}})
    return json.dumps(events + [result])


SPENT = (1, json.dumps([{"type": "result", "subtype": "success", "is_error": True, "api_error_status": 429,
                         "result": "You've hit your limit"}]))
REFUSED = (1, json.dumps([{"type": "result", "subtype": "success", "is_error": True, "api_error_status": 401,
                           "result": "Invalid bearer token"}]))
BLIP = (1, "")


def ok(used=None, as_array=True):
    return 0, answer(used, as_array=as_array)


# Each row: what each account answers, the ceiling, and the account picked.
ROWS = [
    ("an account under the ceiling is used", {1: ok(10), 2: ok(5)}, 98, 1),
    ("an account one step under the ceiling is used", {1: ok(97), 2: ok(5)}, 98, 1),
    ("an account at the ceiling is passed over", {1: ok(98), 2: ok(5)}, 98, 2),
    ("an account with no room is passed over", {1: SPENT, 2: ok(5)}, 98, 2),
    ("an account whose token is refused is passed over", {1: REFUSED, 2: ok(5)}, 98, 2),
    ("a blip keeps the account it hit", {1: BLIP, 2: ok(5)}, 98, 1),
    ("an answer that reports no plan use is used", {1: ok(), 2: ok(5)}, 98, 1),
    ("a single result object, without the event list, is read", {1: ok(as_array=False), 2: ok(5)}, 98, 1),
    ("with no ceiling only a spent plan moves on", {1: ok(99), 2: ok(5)}, 100, 1),
    ("every account past the ceiling: the most room left wins", {1: ok(99), 2: ok(98), 3: SPENT}, 98, 2),
    ("every account spent: the first with a token", {2: SPENT, 3: REFUSED}, 98, 2),
    ("only later accounts set: counted from the first set", {2: ok(99), 3: ok(1)}, 98, 3),
]


class PickTest(unittest.TestCase):
    def test_rows(self):
        for name, answers, ceiling, expected in ROWS:
            with self.subTest(name):
                run = lambda cli, model, token: answers[int(token)]
                tokens = {i: str(i) for i in answers}
                index, _ = pick_account.pick("claude", "model", ceiling, tokens, run_probe=run)
                self.assertEqual(index, expected)

    def test_ceiling_values(self):
        for text, expected in [("", 100), ("abc", 100), ("0", 100), ("101", 100), ("1", 1), ("98", 98), (" 98 ", 98)]:
            with self.subTest(text=text):
                self.assertEqual(pick_account.ceiling_of(text), expected)


FAKE_CLI = r'''
import json, os, sys
token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
leaked = [k for k in os.environ if k in ("ANTHROPIC_API_KEY",) or k.startswith("TOKEN_")]
with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"token": token, "leaked": leaked, "verbose": "--verbose" in sys.argv}) + "\n")
windows = {"five_hour": {"utilization": int(token.split("-")[1]) / 100}}
print(json.dumps([{"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": windows}},
                  {"type": "result", "subtype": "success", "is_error": False, "result": "OK"}]))
'''


class MainTest(unittest.TestCase):
    def test_each_account_sees_only_its_own_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "fake_cli.py")
            with open(fake, "w", encoding="utf-8") as fh:
                fh.write(FAKE_CLI)
            if os.name == "nt":
                cli = os.path.join(tmp, "claude.cmd")
                body = '@"%s" "%s" %%*\n' % (sys.executable, fake)
            else:
                cli = os.path.join(tmp, "claude")
                body = '#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, fake)
            with open(cli, "w", encoding="utf-8") as fh:
                fh.write(body)
            os.chmod(cli, 0o755)
            log, out = os.path.join(tmp, "log.jsonl"), os.path.join(tmp, "github_output")
            env = dict(os.environ, FAKE_LOG=log, ANTHROPIC_API_KEY="key", TOKEN_1="acct-99", TOKEN_2="acct-10")
            run = subprocess.run([sys.executable, SCRIPT, cli, "model", "--ceiling", "98", "--output", out],
                                 env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("::notice::Account 1 is at 99% of its plan, past the 98% ceiling", run.stdout)
            self.assertTrue(run.stdout.rstrip().endswith("index=2"))
            with open(out, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "index=2\n")
            with open(log, encoding="utf-8") as fh:
                seen = [json.loads(line) for line in fh]
            self.assertEqual([s["token"] for s in seen], ["acct-99", "acct-10"])
            self.assertEqual([s["leaked"] for s in seen], [[], []])
            self.assertTrue(all(s["verbose"] for s in seen))


if __name__ == "__main__":
    unittest.main()
