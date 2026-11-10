"""SessionStart and UserPromptSubmit hook: title each Claude Code session after
its project, then after its purpose.

The title starts with the project's name: `project.name` in
`.bindwright/project.json`, else the folder name of the nearest folder at or
above the project root that holds `.git`, else the root's folder name. Once the
session has a purpose, the title is `<name> - <purpose>`. The purpose is the text
of the session's purpose file with whitespace collapsed to single spaces and cut
to its first 10 words.

The hook keeps its files in `~/.bindwright/session-titles/`, never in the
project, and outside any `.claude` folder, whose writes always ask for permission.
Each session's `.title` file keeps the last title the hook set, and its `.purpose`
file is written by the assistant. A repo set up earlier also has purpose files
in `.bindwright/sessions/`; the newer of the two purposes wins.

A title is set once: the hook prints nothing while the title is unchanged, so a
name the user picks with /rename stays until the purpose changes. On SessionStart
the hook also asks the assistant to write the session's focus to its purpose file.

The project root is CLAUDE_PROJECT_DIR, else the input's `cwd`, else the current
folder. Every failure prints nothing and exits 0: a title never blocks a session
or a prompt.
"""
import json
import os
import re
import sys

PROJECT_FILE = os.path.join(".bindwright", "project.json")
REPO_SESSIONS = os.path.join(".bindwright", "sessions")
TITLES_FOLDER = os.path.join(".bindwright", "session-titles")
# A file-name stem only, so a session id can never leave the titles folder.
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
PURPOSE_WORDS = 10
PURPOSE_REQUEST = (
    "Once the session's focus is clear, write it in 10 words or fewer, without the "
    "project's name, to {path}, and rewrite that file whenever the focus changes."
)


def titles_folder():
    """The folder that holds every session's title and purpose files."""
    return os.path.join(os.path.expanduser("~"), TITLES_FOLDER)


def project_root(event):
    """The folder the project's files are in."""
    root = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd")
    return root if isinstance(root, str) and root else os.getcwd()


def folder_name(folder):
    """The last part of an absolute folder path, or the path itself for a drive root."""
    return os.path.basename(folder) or folder


def read_text(path):
    """The text of a file, or None when it cannot be read."""
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def project_file_name(root):
    """The name in `.bindwright/project.json`, or None without one."""
    text = read_text(os.path.join(root, PROJECT_FILE))
    try:
        data = json.loads(text) if text is not None else None
    except ValueError:
        return None
    project = data.get("project") if isinstance(data, dict) else None
    name = project.get("name") if isinstance(project, dict) else None
    return name if isinstance(name, str) and name.strip() else None


def git_folder_name(root):
    """The name of the nearest folder at or above root that holds `.git`, or None."""
    folder = os.path.abspath(root)
    while not os.path.exists(os.path.join(folder, ".git")):
        parent = os.path.dirname(folder)
        if parent == folder:
            return None
        folder = parent
    return folder_name(folder)


def project_name(root):
    """The name the session's title starts with."""
    return project_file_name(root) or git_folder_name(root) or folder_name(os.path.abspath(root))


def purpose_file(root, session_id, titles):
    """The newer of the session's purpose files (titles folder, repo sessions), or None."""
    candidates = [
        os.path.join(titles, session_id + ".purpose"),
        os.path.join(root, REPO_SESSIONS, session_id + ".purpose"),
    ]
    found = [path for path in candidates if os.path.isfile(path)]
    return max(found, key=os.path.getmtime) if found else None


def purpose_of(path):
    """The purpose at `path` in at most PURPOSE_WORDS words, or "" without a file."""
    text = read_text(path) if path else None
    return " ".join((text or "").split()[:PURPOSE_WORDS])


def set_title(titles, session_id, title):
    """Records the title as this session's last one; False when it already was."""
    path = os.path.join(titles, session_id + ".title")
    if read_text(path) == title:
        return False
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(title)
    return True


def purpose_path(titles, session_id):
    """The absolute path of the session's purpose file, with forward slashes."""
    return os.path.abspath(os.path.join(titles, session_id + ".purpose")).replace(os.sep, "/")


def hook_output(event_name, title, request):
    """The hookSpecificOutput object, or None when there is nothing to tell Claude Code."""
    output = {"hookEventName": event_name}
    if title is not None:
        output["sessionTitle"] = title
    if request is not None:
        output["additionalContext"] = request
    return {"hookSpecificOutput": output} if len(output) > 1 else None


def title_session(event, titles):
    """Records the title, prints it when it changed, and on SessionStart asks for the purpose."""
    event_name = event.get("hook_event_name")
    session_id = event.get("session_id")
    if not isinstance(event_name, str) or not isinstance(session_id, str):
        return
    if not SESSION_ID.fullmatch(session_id):
        return
    root = project_root(event)
    purpose = purpose_of(purpose_file(root, session_id, titles))
    name = project_name(root)
    title = f"{name} - {purpose}" if purpose else name
    os.makedirs(titles, exist_ok=True)
    changed = set_title(titles, session_id, title)
    request = None
    if event_name == "SessionStart":
        request = PURPOSE_REQUEST.format(path=purpose_path(titles, session_id))
    output = hook_output(event_name, title if changed else None, request)
    if output:
        print(json.dumps(output))


def main():
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
        if isinstance(event, dict):
            title_session(event, titles_folder())
    except Exception:
        # A title must never block a session or a prompt, so any failure is skipped.
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
