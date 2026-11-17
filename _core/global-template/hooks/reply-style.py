"""UserPromptSubmit, PostToolUse and Stop hook: restate the active reply style at the end of the context.

The CLI puts the output style at the top of the system prompt, and a long session buries it under
everything read since, so replies drift from it. This hook adds the style's own text as context
right where the model reads last: with every prompt, and after every TOOL_CALLS_PER_REMINDER tool
calls within one prompt's turn, so a long run of tool calls still ends near it.

The active style is `outputStyle` from the project's `.claude/settings.local.json`, then its
`.claude/settings.json`, then `settings.json` in the user's config folder (CLAUDE_CONFIG_DIR, else
~/.claude). It is the file in the project's `.claude/output-styles/` or the config folder's
`output-styles/` whose front matter `name` (or file name) matches it, case aside; the built-in
styles have no file, so they get nothing. A subagent's tool calls are not counted.

Under the style Bindwright ships (CHECKED_STYLE), each finished reply (Stop) is measured against
the rules a pattern can see, such as bold labels and em dashes, and the next prompt's restatement
names what it broke. Tone, rhythm and word choice are left to the restated text.
The count of tool calls and the last reply's slips, per session, live in
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
# The style the checks below measure: the one Bindwright ships. Other styles get no checks.
CHECKED_STYLE = "straight talk"
SLIPS_INTRO = "\n\nThe last reply broke these of its rules, so this one avoids them: "
# Code is left out the way prose checkers that parse Markdown leave it out, without a parser: a line
# that may be code is dropped, so a check can miss a slip but never report one made in code.
# A run of three or more backticks or tildes, anywhere on a line.
FENCE_RUN = re.compile(r"`{3,}|~{3,}")
# A line of fence marks alone (any indent or quote marks before them): the only line that closes a fence.
FENCE_CLOSER = re.compile(r"[ \t>]*(`{3,}|~{3,})[ \t]*")
# An inline span closes on a backtick run of the same length as the one that opened it.
INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`)[^\n]+?(?<!`)\1(?!`)")
# (what the reminder names, pattern): each counts its matches in a reply, code taken out first.
CHECKS = (
    # A label, not emphasis: a colon or a dash right after the bold.
    ("a bold label at the start of a line or list item",
     re.compile("^[ \\t]*(?:[-*+][ \\t]+|\\d+[.)][ \\t]+)?\\*\\*[^*\\n]+"
                "(?::\\*\\*|\\*\\*[ \\t]*[:\u2014\u2013-])", re.M)),
    ("an em dash", re.compile("—")),
    ('"essentially"', re.compile(r"\bessentially\b", re.I)),
    ('"basically"', re.compile(r"\bbasically\b", re.I)),
    ("\"here's the thing\"", re.compile(r"\bhere['’]s the thing\b", re.I)),
    # One clause: a "but" past a full stop, colon, semicolon, question or exclamation mark is another's.
    ('"not just X but Y"', re.compile(r"\bnot just\b[^.;:?!\n]*\bbut\b", re.I)),
)


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

    A header with no closing `---` is no header, as most front-matter readers take it, so the whole
    file is the body. `engine/home.py` names a style with this same function, so both find the same
    style.
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
    path = session_file(session, ".count")
    if not path:
        return False
    # One byte appended per call, under the file's lock: its size is the count, and parallel tool
    # calls, each its own process, take turns, so none is lost or counted twice.
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "ab", buffering=0) as fh, locked(fh):
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


def session_file(session, suffix):
    """The session's file in the counts folder, or None for an id that could leave it."""
    if not SESSION_ID.fullmatch(session or ""):
        return None
    return os.path.join(os.path.expanduser("~"), ".bindwright", "reply-style", session + suffix)


def reset_count(session):
    path = session_file(session, ".count")
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def prose_of(reply):
    """The reply's lines that are surely prose.

    A line with one fence run opens a fence wherever the run sits (after a list marker, an indent or a
    quote), and a line of the same marks, at least as long, closes it; an unclosed fence runs to the end.
    A line with two or more runs is inline code. Inline spans come out, and a line still holding a
    backtick, which may be code the spans did not pair, is dropped whole.
    """
    kept, fence = [], None
    for line in reply.split("\n"):
        runs = FENCE_RUN.findall(line)
        if fence is not None:
            closer = FENCE_CLOSER.fullmatch(line)
            if closer and closer.group(1)[0] == fence[0] and len(closer.group(1)) >= len(fence):
                fence = None
        elif len(runs) == 1:
            fence = runs[0]
        elif not runs:
            prose = INLINE_CODE.sub("", line)
            if "`" not in prose:
                kept.append(prose)
    return "\n".join(kept)


def slips_in(reply):
    """What the reply broke of the checked style's measurable rules, each with its count."""
    prose = prose_of(reply)
    found = [(label, len(pattern.findall(prose))) for label, pattern in CHECKS]
    return ["{} ({})".format(label, count) if count > 1 else label for label, count in found if count]


def record_slips(session, reply):
    """Keep the slips of a finished reply for the next prompt; a clean reply clears them."""
    path = session_file(session, ".slips")
    if not path:
        return
    slips = slips_in(reply)
    try:
        if not slips:
            os.remove(path)
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("; ".join(slips) + ".")
    except OSError:
        pass


def take_slips(session):
    """The slips the last reply left, read once: the file goes with the reading."""
    path = session_file(session, ".slips")
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8") as fh:
            slips = fh.read().strip()
        os.remove(path)
    except (OSError, UnicodeDecodeError):
        return ""
    return slips


def main():
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        return
    if not isinstance(event, dict) or event.get("agent_id"):
        return  # a subagent's call: its replies do not follow the user's style
    kind, session = event.get("hook_event_name"), event.get("session_id")
    slips = ""
    if kind == "UserPromptSubmit":
        reset_count(session)
        slips = take_slips(session)
    elif kind == "PostToolUse" and not due_after_tool_call(session):
        return
    elif kind not in ("PostToolUse", "Stop"):
        return
    project = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()
    wanted = active_style(project)
    style = style_text(project, wanted) if wanted else None
    if not style or not style[1]:
        return
    name, body = style
    if kind == "Stop":
        # The finished reply is measured now and named with the next prompt, so a clean reply
        # costs nothing and a broken one costs one line, never an extra turn.
        reply = event.get("last_assistant_message")
        if name.lower() == CHECKED_STYLE and isinstance(reply, str):
            record_slips(session, reply)
        return
    # Slips are named only under the style they were measured against: another style may allow them.
    if slips and name.lower() == CHECKED_STYLE:
        body += SLIPS_INTRO + slips
    context = INTRO.format(name=name) + body
    print(json.dumps({"hookSpecificOutput": {"hookEventName": kind, "additionalContext": context}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
