"""SessionStart hook: find the browser profile folders, and the headless browsers still using
them, that earlier sessions left in Claude Code's temp folder, and ask the assistant to offer
their cleanup.

A script that drives a browser often gives it a profile folder of its own (`--user-data-dir`)
in the session's scratchpad. When the script dies, or forgets to clean up, each run leaves a
folder that can reach a gigabyte, and a browser whose script was killed keeps running. Claude
Code frees a scratchpad only together with its session's transcript, weeks later.

The hook deletes nothing. It looks at most once a day, at the start of a new session. On the
user's yes, the assistant runs this file with `--clean <session id>`, which picks the same
folders again, stops every browser using one, then deletes it.
"""
import json
import os
import shutil
import signal
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
SIZE_SECONDS = 5
# The Windows process query can pass 15 s on a busy machine.
LIST_SECONDS = 60
GIGABYTE = 1024 ** 3
REPARSE_POINT = 0x400  # a Windows junction or link, which a walk must not follow


def temp_root():
    """Claude Code's temp folder, which holds each session's scratchpad, spelled as the
    sessions spell it, so the paths scripts pass their browsers compare equal."""
    base = os.environ.get("CLAUDE_CODE_TMPDIR") or tempfile.gettempdir()
    return os.path.abspath(os.path.join(base, "claude"))


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


def profile_folders(root, skip):
    """Every profile folder below `root`, never looking inside one or inside `skip`."""
    found, stack = [], [(root, 0)]
    while stack:
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
    """(pid, parent pid, command line) of every running process; [] when unreadable."""
    if os.name == "nt":
        command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                   "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process"
                   " | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }"]
    else:
        command = ["ps", "-axo", "pid=,ppid=,args="]
    try:
        listed = subprocess.run(command, capture_output=True, timeout=LIST_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return []
    processes = []
    for line in listed.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split("\t", 2) if os.name == "nt" else line.split(None, 2)
        if len(parts) >= 2 and parts[0].strip().isdigit() and parts[1].strip().isdigit():
            processes.append((int(parts[0]), int(parts[1]), parts[2] if len(parts) == 3 else ""))
    return processes


def comparable(text):
    """A path or command line in the one spelling both are compared in."""
    text = text.replace('"', "")
    return text.replace("\\", "/").lower() if os.name == "nt" else text


def uses_profile(command_line, folder):
    """Whether `command_line` passes `folder` as the browser profile, not a longer path."""
    line, flag = comparable(command_line), "--user-data-dir=" + comparable(folder)
    at = line.find(flag)
    while at != -1:
        if line[at + len(flag):at + len(flag) + 1] in ("", " "):
            return True
        at = line.find(flag, at + 1)
    return False


def left_behind(folders, processes, now):
    """{folder: [pids]} for the profiles no live script runs: each one no browser uses that
    went unwritten for IN_USE_SECONDS, and each one whose browser's own parent is gone. On Linux
    and macOS a process whose parent exits is handed to process 1, so that parent counts as gone."""
    running = {pid for pid, _, _ in processes} - ({1} if os.name != "nt" else set())
    picked = {}
    for folder in folders:
        users = [(pid, parent) for pid, parent, line in processes if uses_profile(line, folder)]
        own = {pid for pid, _ in users}
        # The browser's main process is the one whose parent is not one of its own processes.
        if any(parent in running for _, parent in users if parent not in own):
            continue
        if users or now - last_written(folder) > IN_USE_SECONDS:
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


def session_folder(root, session):
    """The temp folder of the session `session`: <root>/<project>/<session>."""
    if not session:
        return None
    return next((path for path in subfolders(root) if os.path.isdir(os.path.join(path, session))), None)


def projects_of(folders, root):
    """The Claude Code projects whose sessions made `folders`, by each session's transcript."""
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    projects_dir = os.path.join(config, "projects")
    parts = [os.path.relpath(folder, root).split(os.sep) for folder in folders]
    sessions = {each[1] for each in parts if len(each) > 2}
    try:
        slugs = os.listdir(projects_dir)
    except OSError:
        return []
    return sorted({slug for slug in slugs for session in sessions
                   if os.path.isfile(os.path.join(projects_dir, slug, session + ".jsonl"))})


def leftovers(session):
    """(temp folder, {folder: [pids]}) for the profiles earlier sessions left behind; the
    session `session` itself is left out."""
    root = temp_root()
    own = session_folder(root, session)
    folders = profile_folders(root, own and os.path.join(own, session))
    return root, left_behind(folders, running_processes() if folders else [], time.time())


def stamp_path():
    return os.path.join(os.path.expanduser("~"), ".bindwright", "browser-leftovers", "last-check")


def is_due(now):
    """Whether a day has passed since the last look, recording this one when it has."""
    path = stamp_path()
    try:
        with open(path, encoding="utf-8") as stamp:
            if now - float(stamp.read().strip() or 0) < CHECK_EVERY_SECONDS:
                return False
    except (OSError, ValueError):
        pass
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as stamp:
            stamp.write(str(now))
    except OSError:
        pass
    return True


def report(root, picked, session):
    """The note the assistant reads at session start."""
    size, is_complete = total_size(picked, time.monotonic() + SIZE_SECONDS)
    held = "{} {:.1f} GB".format("about" if is_complete else "at least", size / GIGABYTE)
    lines = ["Earlier sessions left {} browser profile folder(s) in Claude Code's temp folder ({}),"
             " holding {}.".format(len(picked), root, held)]
    projects = projects_of(picked, root)
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
    """Stops the browsers of the profiles left behind, deletes the folders and prints which
    were removed and which are still there (a file another program holds open)."""
    _, picked = leftovers(session)
    removed, kept = [], []
    for folder, pids in picked.items():
        stop(pids)
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
    if event.get("source") not in ("startup", "clear") or not is_due(time.time()):
        return
    session = str(event.get("session_id") or "")
    root, picked = leftovers(session)
    if picked:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": report(root, picked, session)}}))


if __name__ == "__main__":
    main()
