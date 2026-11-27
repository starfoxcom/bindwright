"""Tests for which `node` the attribution guard runs to read a command.

Run from the repo root: python -m unittest tools/test_guard_node_program.py
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "_core", "global-template", "hooks"))
from no_ai_attribution.shell import node_program  # noqa: E402

NAME = "node.bat" if os.name == "nt" else "node"


def plant(folder):
    os.makedirs(folder, exist_ok=True)
    planted = os.path.join(folder, NAME)
    with open(planted, "w", encoding="utf-8") as script:
        script.write("exit 0\n")
    os.chmod(planted, 0o755)
    return planted


def same_file(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


class NodeProgramTest(unittest.TestCase):
    """A repo can ship its own node beside its code, first on PATH; the attribution guard skips it
    and runs the next node on PATH, the user's own. Outside a repo, the session folder counts as
    the repo; a repo at the home folder or above it does not count."""

    def test_a_node_the_repo_ships_is_skipped_for_the_users_own(self):
        # `home` is where the mocked home folder sits inside the temp folder, "~" one that cannot be
        # found, and None the real one; `submodule` is a repo inside it the session sits in.
        here = os.getcwd()
        for label, is_repo, folder, home, submodule, is_skipped in (
                ("in the repo's top folder", True, "", None, "", True),
                ("in a repo subfolder on PATH, as direnv adds", True, "bin", None, "", True),
                ("in the outer repo's subfolder, from a session in a submodule", True, "bin", None, "lib", True),
                ("in a repo subfolder, with no home folder to be found", True, "bin", "~", "", True),
                ("in a subfolder of a session folder that is no repo", False, "bin", None, "", True),
                ("in a subfolder of a repo at the home folder", True, "bin", "", "", False),
                ("in a subfolder of a repo above the home folder", True, "bin", "home", "", False)):
            with self.subTest(label), tempfile.TemporaryDirectory() as root, \
                    tempfile.TemporaryDirectory() as elsewhere, mock.patch.dict(os.environ):
                if is_repo:
                    os.makedirs(os.path.join(root, ".git"))
                session = os.path.join(root, submodule)
                if submodule:
                    os.makedirs(os.path.join(session, ".git"))
                tools = os.path.join(root, folder)
                first, own = plant(tools), plant(elsewhere)
                os.environ["PATH"] = os.pathsep.join([tools, elsewhere, os.environ["PATH"]])
                home_folder = {None: os.path.expanduser("~"), "~": "~"}.get(home, os.path.join(root, home or ""))
                os.chdir(session)
                try:
                    with mock.patch("os.path.expanduser", return_value=home_folder):
                        found = node_program(session)
                finally:
                    os.chdir(here)
                self.assertTrue(same_file(found or "", own if is_skipped else first), found)

    def test_no_node_outside_the_repo_finds_none(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ):
            os.makedirs(os.path.join(root, ".git"))
            tools = os.path.join(root, "bin")
            plant(tools)
            os.environ["PATH"] = tools
            self.assertIsNone(node_program(root))


if __name__ == "__main__":
    unittest.main()
