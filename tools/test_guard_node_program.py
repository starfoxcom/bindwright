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


class NodeProgramTest(unittest.TestCase):
    """A repo can ship its own node beside its code; the attribution guard never runs that one,
    and a node the user installed outside the repo still runs."""

    def test_a_node_the_repo_ships_is_refused_and_others_run(self):
        name = "node.bat" if os.name == "nt" else "node"
        # `home` is where the mocked home folder sits inside the temp folder; None keeps the real one.
        for label, is_repo, folder, home, refused in (
                ("in the repo's top folder", True, "", None, True),
                ("in a repo subfolder on PATH, as direnv adds", True, "bin", None, True),
                ("in a subfolder of a folder that is no repo", False, "bin", None, False),
                ("in a subfolder of a repo at the home folder", True, "bin", "", False),
                ("in a subfolder of a repo above the home folder", True, "bin", "home", False)):
            with self.subTest(label), tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ):
                if is_repo:
                    os.makedirs(os.path.join(root, ".git"))
                tools = os.path.join(root, folder)
                os.makedirs(tools, exist_ok=True)
                planted = os.path.join(tools, name)
                with open(planted, "w", encoding="utf-8") as script:
                    script.write("exit 0\n")
                os.chmod(planted, 0o755)
                os.environ["PATH"] = tools + os.pathsep + os.environ["PATH"]
                home_folder = os.path.expanduser("~") if home is None else os.path.join(root, home)
                with mock.patch("os.path.expanduser", return_value=home_folder):
                    found = node_program(root)
                self.assertEqual(found is None, refused, found)


if __name__ == "__main__":
    unittest.main()
