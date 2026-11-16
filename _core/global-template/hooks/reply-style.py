"""UserPromptSubmit and PostToolUse hook: restate the active reply style at the end of the context.

The CLI puts the output style at the top of the system prompt, and a long session buries it under
everything read since, so replies drift from it. This hook adds the style's own text as context
right where the model reads last: with every prompt, and after every TOOL_CALLS_PER_REMINDER tool
calls within one prompt's turn, so a long run of tool calls still ends near it.

The active style is `outputStyle` from the project's `.claude/settings.local.json`, then its
`.claude/settings.json`, then `settings.json` in the user's config folder (CLAUDE_CONFIG_DIR, else
~/.claude). It is the file in the project's `.claude/output-styles/` or the config folder's
`output-styles/` whose front matter `name` (or file name) matches it, case aside; the built-in
styles have no file, so they get nothing. A subagent's tool calls are not counted.
The count of tool calls per session lives in
~/.bindwright/reply-style/, outside any `.claude` folder. Every failure prints nothing and exits 0:
a reminder never blocks a prompt or a tool call.
"""
import contextlib
import json
import os
import re
import sys
import time

TOOL_CALLS_PER_REMINDER = 25
# Past this, a call goes uncounted rather than hold up the tool call it follows.
LOCK_WAIT_SECONDS = 5
# A file-name stem only, so a session id can never leave the counts folder.
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
INTRO = ("The reply style in use, {name}, restated here so it is the last thing read before the"
         " reply. Every reply follows it:\n\n")


def read_json(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def active_style(project):
    """The `outputStyle` from the first of the three settings files that sets one, or None.

    Managed policy settings and a `--settings` file rank above these and are not read.
    """
    files = [os.path.join(project, ".claude", "settings.local.json"),
             os.path.join(project, ".claude", "settings.json"),
             os.path.join(config_dir(), "settings.json")]
    for path in files:
        name = read_json(path).get("outputStyle")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return None


def style_text(project, wanted):
    """(name, body) of the style file named `wanted`, or None."""
    folders = [os.path.join(project, ".claude", "output-styles"), os.path.join(config_dir(), "output-styles")]
    for folder in folders:
        try:
            names = sorted(n for n in os.listdir(folder) if n.endswith(".md"))
        except OSError:
            continue
        for file_name in names:
            try:
                with open(os.path.join(folder, file_name), encoding="utf-8-sig") as fh:
                    text = fh.read().replace("\r\n", "\n")
            except (OSError, UnicodeDecodeError):
                continue
            found, body = front_matter(text)
            # Named by its `name`, and by its file only when it has none, as the CLI names it.
            name = found or file_name[:-3]
            if wanted.lower() == name.lower():
                return name, body.strip()
    return None


def front_matter(text):
    """(name, body): the front matter's `name:` (None without one) and the text after it.

    Read line by line as `home.py` reads a style's name, so both find the same style.
    """
    lines = text.split("\n")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if lines[0].strip() != "---" or end is None:
        return None, text
    for line in lines[1:end]:
        key, sep, value = line.partition(":")
        value = value.strip()
        # YAML may quote the value: one matching pair of quotes is not part of the name.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1].strip()
        if sep and key.strip() == "name" and value:
            return value, "\n".join(lines[end + 1:])
    return None, "\n".join(lines[end + 1:])


def due_after_tool_call(session):
    """Count one tool call for the session; True on every TOOL_CALLS_PER_REMINDER-th."""
    if not SESSION_ID.fullmatch(session or ""):
        return False
    folder = os.path.join(os.path.expanduser("~"), ".bindwright", "reply-style")
    # One byte appended per call, under the file's lock: its size is the count, and parallel tool
    # calls, each its own process, take turns, so none is lost or counted twice.
    try:
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, session + ".count"), "ab", buffering=0) as fh, locked(fh):
            fh.write(b".")
            count = os.fstat(fh.fileno()).st_size
    except OSError:
        return False
    return count % TOOL_CALLS_PER_REMINDER == 0


@contextlib.contextmanager
def locked(fh):
    """Hold an exclusive lock on the open file until the block ends; waits for another holder."""
    if os.name == "nt":
        import msvcrt
        fh.seek(0)  # locks the first byte, which may lie past the end of an empty file
        # LK_LOCK retries only once a second, ten times, so a burst of calls times out: poll instead.
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.005)
        try:
            yield
        finally:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def reset_count(session):
    if SESSION_ID.fullmatch(session or ""):
        try:
            os.remove(os.path.join(os.path.expanduser("~"), ".bindwright", "reply-style", session + ".count"))
        except OSError:
            pass


def main():
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        return
    if not isinstance(event, dict) or event.get("agent_id"):
        return  # a subagent's call: its replies do not follow the user's style
    kind, session = event.get("hook_event_name"), event.get("session_id")
    if kind == "UserPromptSubmit":
        reset_count(session)
    elif kind != "PostToolUse" or not due_after_tool_call(session):
        return
    project = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()
    wanted = active_style(project)
    style = style_text(project, wanted) if wanted else None
    if not style or not style[1]:
        return
    name, body = style
    print(json.dumps({"hookSpecificOutput": {"hookEventName": kind,
                                             "additionalContext": INTRO.format(name=name) + body}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
