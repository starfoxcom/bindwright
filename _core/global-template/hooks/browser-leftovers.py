"""SessionStart hook: find the browser profile folders that earlier sessions left in Claude Code's
temp folder, and ask the assistant to offer their cleanup.

A script that drives a browser often gives it a profile folder of its own (`--user-data-dir`)
in the session's scratchpad. When the script dies, or forgets to clean up, each run leaves a
folder that can reach a gigabyte. Claude Code frees a scratchpad only together with its
session's transcript, weeks later.

The hook deletes nothing. It looks at most once a day, at the start of a new session. On the
user's yes, the assistant runs this file with `--clean <session id>`, which picks the same
folders again and deletes them. A folder is picked only when nothing in it changed for an hour
and no running browser holds its lock, the one Chromium keeps in every profile it has open.
"""
import json
import os
import shutil
import socket
import stat
import sys
import tempfile
import time

CHECK_EVERY_SECONDS = 24 * 60 * 60
# A profile written this recently may belong to a run still in progress in another session.
IN_USE_SECONDS = 60 * 60
# How deep below the temp folder a profile is looked for: <project>/<session>/scratchpad/ and
# a few folders more.
MAX_DEPTH = 7
# Claude Code stops the hook at 30 s; these two steps together stay well inside that.
WALK_SECONDS = 5
SIZE_SECONDS = 5
GIGABYTE = 1024 ** 3
REPARSE_POINT = 0x400  # a Windows junction or link, which a walk must not follow


def temp_roots():
    """Claude Code's temp folders, which hold each session's scratchpad: `claude` in its temp
    folder, or `claude-<user id>` where the system's temp folder is shared between users."""
    base = os.path.abspath(os.environ.get("CLAUDE_CODE_TMPDIR") or tempfile.gettempdir())
    names = ["claude"] + (["claude-{}".format(os.getuid())] if hasattr(os, "getuid") else [])
    return [os.path.join(base, name) for name in names if is_own_folder(os.path.join(base, name))]


def is_own_folder(path):
    """Whether `path` is a real folder, not a link or junction, that only this user can change
    where the system has user ids: a shared temp folder lets anyone else create a `claude`
    there, and a folder others can write to lets them swap a link in while it is deleted."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    is_link = stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT
    is_mine = not hasattr(os, "getuid") or only_mine(info)
    return stat.S_ISDIR(info.st_mode) and not is_link and is_mine


def only_mine(info):
    """Whether a folder is this user's and no one else can write in it. A group's write access
    counts only when the group is not the user's own, as Linux gives each user a group."""
    is_group_shared = info.st_mode & stat.S_IWGRP and info.st_gid != os.getgid()
    is_shared = info.st_mode & stat.S_IWOTH or is_group_shared
    return info.st_uid == os.getuid() and not is_shared


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
    """When anything in the profile or its Default folder last changed, as seconds since the
    epoch; a profile that cannot be read counts as changed now."""
    times = []
    for place in (folder, os.path.join(folder, "Default")):
        if not os.path.isdir(place):
            continue
        try:
            times.append(os.stat(place).st_mtime)
            times += [entry.stat(follow_symlinks=False).st_mtime for entry in os.scandir(place)]
        except OSError:
            return time.time()
    return max(times, default=0)


def is_locked(folder):
    """Whether a running browser holds the profile, by the lock Chromium keeps in it while it
    runs: on Windows a `lockfile` the browser holds open for writing, elsewhere a
    `SingletonLock` link that names `<host>-<pid>`. A lock that cannot be read counts as held."""
    if os.name == "nt":
        return is_held_open(os.path.join(folder, "lockfile"))
    return names_live_browser(os.path.join(folder, "SingletonLock"))


def is_held_open(path):
    """Whether another program holds `path` open against writing, as a running browser does."""
    if not os.path.lexists(path):
        return False
    try:
        handle = os.open(path, os.O_WRONLY)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    os.close(handle)
    return False


def names_live_browser(path):
    """Whether the lock link at `path` names a process that may still run: one on another
    host cannot be checked from here, so it counts as running."""
    if not os.path.lexists(path):
        return False
    try:
        host, _, pid = os.readlink(path).rpartition("-")
    except OSError:
        return True
    if host != socket.gethostname() or not pid.isdigit():
        return True
    try:
        os.kill(int(pid), 0)  # signal 0 only asks whether the process exists
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def left_behind(folders, now):
    """The folders nothing changed for IN_USE_SECONDS that no running browser holds."""
    return [folder for folder in folders
            if now - last_written(folder) > IN_USE_SECONDS and not is_locked(folder)]


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
    """(temp folders, [folders]) for the profiles earlier sessions left behind; the session
    `session` itself is left out."""
    roots, deadline, folders = temp_roots(), time.monotonic() + WALK_SECONDS, []
    for root in roots:
        own = next((os.path.join(project, session) for project in subfolders(root)
                    if session and os.path.isdir(os.path.join(project, session))), None)
        folders += profile_folders(root, own, deadline)
    return roots, left_behind(folders, time.time())


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
    lines.append("Nothing was deleted. Tell the user this in a line or two and offer to clean them up."
                 " On a yes, run `\"{}\" \"{}\" --clean {}`, which deletes the folders no running"
                 " browser holds.".format(sys.executable, os.path.abspath(__file__), session))
    return " ".join(lines)


def clean(session):
    """Deletes the profiles left behind and prints which were removed and which are still there
    (a file another program holds open)."""
    _, picked = leftovers(session)
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
