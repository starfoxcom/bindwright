"""Tests for tools/mod_version_check.py, which fails a mod change that keeps the mod's version."""

import importlib.util
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("mod_version_check", os.path.join(ROOT, "tools", "mod_version_check.py"))
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

MOD = "_core/global-template/mods/tasks"
MANIFEST = MOD + "/.claude-plugin/plugin.json"
ODD = "_core/global-template/mods/odd"


def manifest(version):
    return '{"name": "tasks", "version": "%s"}\n' % version


# Each row: the paths the change writes (path inside the repo -> text, or None to delete the file or
# folder) and the mods it reports.
ROWS = [
    ("code changed with a higher version passes", {MOD + "/hooks/register.ts": "b", MANIFEST: manifest("1.5.1")}, []),
    ("code changed with the version kept fails", {MOD + "/hooks/register.ts": "b"}, ["tasks"]),
    ("a lower version fails", {MOD + "/hooks/register.ts": "b", MANIFEST: manifest("1.4.9")}, ["tasks"]),
    ("a version that is not x.y.z fails", {MOD + "/hooks/register.ts": "b", MANIFEST: manifest("next")}, ["tasks"]),
    ("tests alone need no new version", {MOD + "/tests/rules.test.ts": "b", MOD + "/hooks/a.test.ts": "b"}, []),
    ("helper script tests alone need no new version", {MOD + "/test-helper/sweep.spec.cjs": "b"}, []),
    ("a spec file outside a test folder needs no new version", {MOD + "/hooks/sweep.spec.cjs": "b"}, []),
    ("a changed file whose name git quotes still counts", {MOD + "/hooks/café.ts": "b"}, ["tasks"]),
    ("a mod whose base manifest names no version passes", {ODD + "/hooks/register.ts": "b"}, []),
    ("a file named like a test word is still code", {MOD + "/hooks/latest.ts": "b"}, ["tasks"]),
    ("Markdown alone needs no new version", {MOD + "/README.md": "b"}, []),
    ("a mod new since the base passes", {"_core/global-template/mods/fresh/hooks/register.ts": "a"}, []),
    ("a mod deleted since the base passes", {MOD: None}, []),
    ("a file moved to another mod checks the mod it left",
     {MOD + "/hooks/register.ts": None, "_core/global-template/mods/fresh/hooks/register.ts": "a"}, ["tasks"]),
    ("a file outside the mods is not checked", {"engine/home.py": "b"}, []),
]


class ModVersionCheckTest(unittest.TestCase):
    def _git(self, repo, *args):
        subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                       check=True, capture_output=True)

    def _write(self, repo, files):
        for rel, text in files.items():
            if text is None:
                self._git(repo, "rm", "-r", "-q", rel)
                continue
            path = os.path.join(repo, *rel.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)

    def test_rows(self):
        with tempfile.TemporaryDirectory() as repo:
            self._git(repo, "init", "-q", "-b", "base")
            self._write(repo, {MANIFEST: manifest("1.5.0"), MOD + "/hooks/register.ts": "a",
                               MOD + "/README.md": "a", "engine/home.py": "a",
                               ODD + "/.claude-plugin/plugin.json": '{"name": "odd"}\n',
                               ODD + "/hooks/register.ts": "a"})
            self._git(repo, "add", "-A")
            self._git(repo, "commit", "-q", "-m", "base")
            cwd = os.getcwd()
            os.chdir(repo)
            try:
                for index, (name, change, expected) in enumerate(ROWS):
                    with self.subTest(name):
                        self._git(repo, "checkout", "-q", "-b", "work-%d" % index, "base")
                        self._write(repo, change)
                        self._git(repo, "add", "-A")
                        self._git(repo, "commit", "-q", "-m", "change")
                        found = check.problems("base")
                        self.assertEqual([line.split(":")[0] for line in found], expected)
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
