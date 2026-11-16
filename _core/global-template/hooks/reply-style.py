"""UserPromptSubmit and PostToolUse hook: restate the active reply style at the end of the context.

The CLI puts the output style at the top of the system prompt, and a long session buries it under
everything read since, so replies drift from it. This hook adds the style's own text as context
right where the model reads last: with every prompt, and after every TOOL_CALLS_PER_REMINDER tool
calls within one prompt's turn, so a long run of tool calls still ends near it.

The active style is `outputStyle` from the project's `.claude/settings.local.json`, then its
`.claude/settings.json`, then `settings.json` in the user's config folder (CLAUDE_CONFIG_DIR, else
~/.claude). It is the file in the project's `.claude/output-styles/` or the config folder's
`output-styles/` whose front matter `name` (or file name) matches it, case aside; the built-in
styles have no file, so they get nothing. The count of tool calls per session lives in
~/.bindwright/reply-style/, outside any `.claude` folder. Every failure prints nothing and exits 0:
a reminder never blocks a prompt or a tool call.
"""
import json
import os
import re
import sys

TOOL_CALLS_PER_REMINDER = 25
# A file-name stem only, so a session id can never leave the counts folder.
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)
INTRO = ("The reply style in use, {name}, restated here so it is the last thing read before the"
         " reply. Every reply follows it:\n\n")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def active_style(project):
    """The `outputStyle` setting the CLI would use, or None."""
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
                with open(os.path.join(folder, file_name), encoding="utf-8") as fh:
                    text = fh.read().replace("\r\n", "\n")
            except (OSError, UnicodeDecodeError):
                continue
            head = FRONT_MATTER.match(text)
            found = re.search(r"^name:\s*(.+?)\s*$", head.group(1), re.M) if head else None
            name = found.group(1).strip("\"'") if found else file_name[:-3]
            if wanted.lower() in (name.lower(), file_name[:-3].lower()):
                body = text[head.end():] if head else text
                return name, body.strip()
    return None


def due_after_tool_call(session):
    """Count one tool call for the session; True on every TOOL_CALLS_PER_REMINDER-th."""
    if not SESSION_ID.fullmatch(session or ""):
        return False
    folder = os.path.join(os.path.expanduser("~"), ".bindwright", "reply-style")
    path = os.path.join(folder, session + ".count")
    try:
        with open(path, encoding="utf-8") as fh:
            count = int(fh.read().strip() or 0) + 1
    except (OSError, ValueError):
        count = 1
    try:
        os.makedirs(folder, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(str(count))
    except OSError:
        return False
    return count % TOOL_CALLS_PER_REMINDER == 0


def reset_count(session):
    if SESSION_ID.fullmatch(session or ""):
        try:
            os.remove(os.path.join(os.path.expanduser("~"), ".bindwright", "reply-style", session + ".count"))
        except OSError:
            pass


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return
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
