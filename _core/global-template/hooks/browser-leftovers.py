"""SessionStart hook: find the browser profile folders that earlier sessions left in Claude Code's
temp folder, and the headless browsers still using them, and ask the assistant to offer their
cleanup.

A script that drives a browser often gives it a profile folder of its own (`--user-data-dir`)
in the session's scratchpad. When the script dies, or forgets to clean up, each run leaves a
folder that can reach a gigabyte, and a browser whose script was killed keeps running. Claude
Code frees a scratchpad only together with its session's transcript, weeks later.

The hook deletes nothing. It looks at most once a day, at the start of a new session. On the
user's yes, the assistant runs this file with `--clean <session id>`, which picks the same
folders again, stops every browser using one, then deletes them. A folder is picked only when
nothing wrote it for an hour and no browser whose script still runs uses it; when the running
processes cannot be listed, nothing is picked.
"""
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

CHECK_EVERY_SECONDS = 24 * 60 * 60
# A profile written this recently may belong to a run still in progress in another session.
IN_USE_SECONDS = 60 * 60
# How deep below the temp folder a profile is looked for: <project>/<session>/scratchpad/ and
# a few folders more.
MAX_DEPTH = 7
# Claude Code stops the hook at 30 s; these three steps together stay well inside that.
WALK_SECONDS = 5
LIST_SECONDS = 15
SIZE_SECONDS = 5
GIGABYTE = 1024 ** 3
REPARSE_POINT = 0x400  # a Windows junction or link, which a walk must not follow


def temp_roots():
    """Claude Code's temp folders, which hold each session's scratchpad: `claude` in its temp
    folder, or `claude-<user id>` where the system's temp folder is shared between users.
    Spelled as the sessions spell them, so the paths scripts pass their browsers compare equal."""
    base = os.path.abspath(os.environ.get("CLAUDE_CODE_TMPDIR") or tempfile.gettempdir())
    names = ["claude"] + (["claude-{}".format(os.getuid())] if hasattr(os, "getuid") else [])
    return [os.path.join(base, name) for name in names if is_own_folder(os.path.join(base, name))]


def is_own_folder(path):
    """Whether `path` is a real folder, not a link or junction, owned by this user where the
    system has user ids: a shared temp folder lets anyone else create a `claude` there."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    is_link = stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT
    is_mine = not hasattr(os, "getuid") or info.st_uid == os.getuid()
    return stat.S_ISDIR(info.st_mode) and not is_link and is_mine


def is_plain_folder(entry):
    """Whether a scandir entry is a folder of its own, not a link or junction to another."""
    try:
        info = entry.stat(follow_symlinks=False)
    except OSError:
        return False
    is_link = entry.is_symlink() or getattr(info, "st_file_attributes", 0) & REPARSE_POINT
    return entry.is_dir(follow_symlinks=False) and not is_link


def subfolders(folder):
    try:
        return [entry.path for entry in os.scandir(folder) if is_plain_folder(entry)]
    except OSError:
        return []


def is_profile(folder):
    """Whether `folder` is a Chromium-family browser's profile folder."""
    return (os.path.isfile(os.path.join(folder, "Local State"))
            or os.path.isfile(os.path.join(folder, "Default", "Preferences")))


def profile_folders(root, skip, deadline):
    """Every profile folder below `root` found before `deadline`, never looking inside one or
    inside `skip`."""
    found, stack = [], [(root, 0)]
    while stack and time.monotonic() < deadline:
        folder, depth = stack.pop()
        for path in subfolders(folder):
            if path == skip:
                continue
            if is_profile(path):
                found.append(path)
            elif depth + 1 < MAX_DEPTH:
                stack.append((path, depth + 1))
    return sorted(found)


def last_written(folder):
    """When the browser last wrote the profile, as seconds since the epoch."""
    times = []
    for path in (folder, os.path.join(folder, "Local State"), os.path.join(folder, "Default")):
        try:
            times.append(os.stat(path).st_mtime)
        except OSError:
            pass
    return max(times, default=0)


def running_processes():
    """(pid, parent pid, command line) of every running process, or None when they cannot be
    listed, which then picks no folder: a browser that cannot be seen may still be in use."""
    if os.name == "nt":
        command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                   "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process"
                   " | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }"]
    else:
        # `ww`: every command line in full, never cut at the terminal's width.
        command = ["ps", "-axww", "-o", "pid=,ppid=,args="]
    try:
        listed = subprocess.run(command, capture_output=True, timeout=LIST_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return None
    processes = []
    for line in listed.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t", 2) if os.name == "nt" else line.split(None, 2)
        if len(parts) >= 2 and parts[0].strip().isdigit() and parts[1].strip().isdigit():
            processes.append((int(parts[0]), int(parts[1]), parts[2] if len(parts) == 3 else ""))
    return processes if listed.returncode == 0 and processes else None


def comparable(text):
    """A path or command line in the one spelling both are compared in."""
    text = text.replace('"', "")
    return text.replace("\\", "/").lower() if os.name == "nt" else text


def profile_flags(folder):
    """The `--user-data-dir=` texts that pass `folder`: its own spelling and its resolved one."""
    return {"--user-data-dir=" + comparable(spelling).rstrip("/")
            for spelling in (folder, os.path.realpath(folder))}


def uses_profile(line, flags):
    """Whether the comparable command line `line` holds one of `flags` as the whole path, with
    or without a closing slash, not as the start of a longer one."""
    for flag in flags:
        at = line.find(flag)
        while at != -1:
            rest = line[at + len(flag):]
            rest = rest[1:] if rest.startswith("/") else rest
            if rest[:1] in ("", " "):
                return True
            at = line.find(flag, at + 1)
    return False


def has_relative_profile(line):
    """Whether the comparable command line `line` passes a profile path that is not absolute."""
    values = [part.split(" ", 1)[0] for part in line.split("--user-data-dir=")[1:]]
    return any(not os.path.isabs(value) for value in values)


def left_behind(folders, processes, now):
    """{folder: [pids of the browsers using it]} for each folder nothing wrote for
    IN_USE_SECONDS that no browser with a running parent uses. On Linux and macOS a process
    whose parent exits is handed to process 1, so that parent counts as gone."""
    running = {pid for pid, _, _ in (processes or [])} - ({1} if os.name != "nt" else set())
    browsers = [(pid, parent, comparable(line)) for pid, parent, line in (processes or [])
                if "--user-data-dir=" in line]
    # A browser whose profile path is relative, or a list that cannot be read, could be using
    # any of the folders, so none is picked.
    if processes is None or any(has_relative_profile(line) for _, _, line in browsers):
        return {}
    picked = {}
    for folder in folders:
        if now - last_written(folder) <= IN_USE_SECONDS:
            continue
        flags = profile_flags(folder)
        users = [(pid, parent) for pid, parent, line in browsers if uses_profile(line, flags)]
        own = {pid for pid, _ in users}
        # The browser's main process is the one whose parent is not one of its own processes.
        if not any(parent in running for _, parent in users if parent not in own):
            picked[folder] = sorted(own)
    return picked


def total_size(folders, deadline):
    """(bytes held by `folders`, whether all of them were counted before `deadline`)."""
    size, stack = 0, list(folders)
    while stack:
        if time.monotonic() > deadline:
            return size, False
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for entry in entries:
            try:
                if is_plain_folder(entry):
                    stack.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    size += entry.stat(follow_symlinks=False).st_size
            except OSError:
                pass
    return size, True


def session_of(folder, roots):
    """The id of the session whose temp folder holds `folder`: <root>/<project>/<session>/..."""
    for root in roots:
        parts = os.path.relpath(folder, root).split(os.sep)
        if len(parts) > 2 and parts[0] != os.pardir:
            return parts[1]
    return None


def projects_of(folders, roots):
    """The Claude Code projects whose sessions made `folders`, by each session's transcript."""
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    projects_dir = os.path.join(config, "projects")
    sessions = {session_of(folder, roots) for folder in folders} - {None}
    try:
        slugs = os.listdir(projects_dir)
    except OSError:
        return []
    return sorted({slug for slug in slugs for session in sessions
                   if os.path.isfile(os.path.join(projects_dir, slug, session + ".jsonl"))})


def leftovers(session):
    """(temp folders, {folder: [pids]}) for the profiles earlier sessions left behind; the
    session `session` itself is left out."""
    roots, deadline, folders = temp_roots(), time.monotonic() + WALK_SECONDS, []
    for root in roots:
        own = next((os.path.join(project, session) for project in subfolders(root)
                    if session and os.path.isdir(os.path.join(project, session))), None)
        folders += profile_folders(root, own, deadline)
    return roots, left_behind(folders, running_processes() if folders else [], time.time())


def stamp_path():
    return os.path.join(os.path.expanduser("~"), ".bindwright", "browser-leftovers", "last-check")


def is_due(now):
    """Whether a day has passed since the last finished look."""
    try:
        with open(stamp_path(), encoding="utf-8") as stamp:
            return now - float(stamp.read().strip() or 0) >= CHECK_EVERY_SECONDS
    except (OSError, ValueError):
        return True


def mark_checked(now):
    try:
        os.makedirs(os.path.dirname(stamp_path()), exist_ok=True)
        with open(stamp_path(), "w", encoding="utf-8") as stamp:
            stamp.write(str(now))
    except OSError:
        pass


def report(roots, picked, session):
    """The note the assistant reads at session start."""
    size, is_complete = total_size(picked, time.monotonic() + SIZE_SECONDS)
    held = "{} {:.1f} GB".format("about" if is_complete else "at least", size / GIGABYTE)
    lines = ["Earlier sessions left {} browser profile folder(s) in Claude Code's temp folder ({}),"
             " holding {}.".format(len(picked), ", ".join(roots), held)]
    projects = projects_of(picked, roots)
    if projects:
        lines.append("They came from sessions of: {}.".format(", ".join(projects)))
    running = sum(1 for pids in picked.values() if pids)
    if running:
        lines.append("{} of them still have a headless browser running whose script is gone.".format(running))
    lines.append("Nothing was deleted. Tell the user this in a line or two and offer to clean them up."
                 " On a yes, run `\"{}\" \"{}\" --clean {}`, which stops those browsers and deletes the"
                 " folders.".format(sys.executable, os.path.abspath(__file__), session))
    return " ".join(lines)


def stop(pids):
    for pid in pids:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True,
                               timeout=LIST_SECONDS)
            else:
                os.kill(pid, signal.SIGKILL)
        except (OSError, subprocess.TimeoutExpired):
            pass


def clean(session):
    """Stops the browsers of the profiles left behind, all before any folder is deleted, so no
    process id is reused in between, then deletes the folders and prints which were removed and
    which are still there (a file another program holds open)."""
    _, picked = leftovers(session)
    stop(sorted({pid for pids in picked.values() for pid in pids}))
    removed, kept = [], []
    for folder in picked:
        shutil.rmtree(folder, ignore_errors=True)
        (kept if os.path.exists(folder) else removed).append(folder)
    print(json.dumps({"removed": removed, "kept": kept}))


def main():
    if sys.argv[1:2] == ["--clean"]:
        clean(sys.argv[2] if len(sys.argv) > 2 else "")
        return
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return
    now = time.time()
    if event.get("source") not in ("startup", "clear") or not is_due(now):
        return
    session = str(event.get("session_id") or "")
    roots, picked = leftovers(session)
    if picked:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": report(roots, picked, session)}}))
    mark_checked(now)


if __name__ == "__main__":
    main()
