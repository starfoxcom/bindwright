"""SessionStart and UserPromptSubmit hook: title each Claude Code session after
its project, then after its purpose.

The title is the project name at the start, and `<name> - <purpose>` once the
session has written its purpose to `.bindwright/sessions/<session_id>.purpose`.
The purpose is that file's text with whitespace collapsed to single spaces and
cut to its first 10 words.

A title is set once: `<session_id>.title` keeps the last title this hook set,
and the hook prints nothing while the title is unchanged. A name the user picks
with /rename therefore stays until the purpose changes.

The sessions folder gets a `.gitignore` that ignores everything in it, so the
purpose and title files never reach a commit.

The project root is CLAUDE_PROJECT_DIR, else the input's `cwd`, else the current
folder. Every failure prints nothing and exits 0: a title never blocks a session
or a prompt.
"""
import json
import os
import re
import sys

PROJECT_FILE = os.path.join(".bindwright", "project.json")
SESSIONS_FOLDER = os.path.join(".bindwright", "sessions")
# A file-name stem only, so a session id can never leave the sessions folder.
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
PURPOSE_WORDS = 10
# Ignores every file in the sessions folder, the .gitignore included.
GITIGNORE_TEXT = "*\n"


def project_root(event):
    """The folder the project's files are in."""
    root = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd")
    return root if isinstance(root, str) and root else os.getcwd()


def project_name(root):
    """The project's name from `.bindwright/project.json`, or None without one."""
    try:
        with open(os.path.join(root, PROJECT_FILE), encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    project = data.get("project") if isinstance(data, dict) else None
    name = project.get("name") if isinstance(project, dict) else None
    return name if isinstance(name, str) and name.strip() else None


def read_text(path):
    """The text of a file, or None when it cannot be read."""
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def purpose_of(sessions, session_id):
    """The session's purpose in at most PURPOSE_WORDS words, or "" without one."""
    text = read_text(os.path.join(sessions, session_id + ".purpose"))
    return " ".join((text or "").split()[:PURPOSE_WORDS])


def write_gitignore(sessions):
    """Creates the sessions folder's .gitignore unless one is already there."""
    try:
        with open(os.path.join(sessions, ".gitignore"), "x", encoding="utf-8", newline="") as handle:
            handle.write(GITIGNORE_TEXT)
    except FileExistsError:
        pass


def set_title(sessions, session_id, title):
    """Records the title as this session's last one; False when it already was."""
    path = os.path.join(sessions, session_id + ".title")
    if read_text(path) == title:
        return False
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(title)
    return True


def title_session(event):
    """Records the session's title when it changed, and prints it for Claude Code."""
    event_name = event.get("hook_event_name")
    session_id = event.get("session_id")
    if not isinstance(event_name, str) or not isinstance(session_id, str):
        return
    if not SESSION_ID.fullmatch(session_id):
        return
    root = project_root(event)
    name = project_name(root)
    if name is None:
        return
    sessions = os.path.join(root, SESSIONS_FOLDER)
    os.makedirs(sessions, exist_ok=True)
    write_gitignore(sessions)
    purpose = purpose_of(sessions, session_id)
    title = f"{name} - {purpose}" if purpose else name
    if not set_title(sessions, session_id, title):
        return
    output = {"hookSpecificOutput": {"hookEventName": event_name, "sessionTitle": title}}
    print(json.dumps(output))


def main():
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
        if isinstance(event, dict):
            title_session(event)
    except Exception:
        # A title must never block a session or a prompt, so any failure is skipped.
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
