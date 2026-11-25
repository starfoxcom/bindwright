"""SessionStart hook: find the browser profile folders that earlier sessions left in Claude Code's
temp folder, and ask the assistant to offer their cleanup.

A script that drives a browser often gives it a profile folder of its own (`--user-data-dir`)
in the session's scratchpad. When the script dies, or forgets to clean up, each run leaves a
folder that can reach a gigabyte. Claude Code frees a scratchpad only together with its
session's transcript, weeks later.

The hook deletes nothing. It looks at most once a day, at the start of a new session. On the
user's yes, the assistant runs this file with `--clean <session id>`, which picks the same
folders again and deletes them. A folder is picked by age, as the system temp cleaners pick
files: nothing anywhere inside it changed for IDLE_SECONDS, and no browser holds the profile
lock Chromium keeps in it. Like those cleaners, it cannot see a program that keeps no lock and
has written nothing in that time.
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
# How long nothing in a profile may have changed before it counts as left behind: the three
# days macOS gives its own temp files.
IDLE_SECONDS = 3 * 24 * 60 * 60
# How deep below the temp folder a profile is looked for: <project>/<session>/scratchpad/ and
# a few folders more.
MAX_DEPTH = 7
# Claude Code stops the hook at 30 s; the walk and the reading of the profiles stay inside that.
# A profile not read in full in time is left out.
WALK_SECONDS = 5
READ_SECONDS = 15
# `--clean` runs outside the hook's limit, as a command the assistant starts.
CLEAN_READ_SECONDS = 60
GIGABYTE = 1024 ** 3
REPARSE_POINT = 0x400  # a Windows junction or link, which a walk must not follow


def temp_roots():
    """Claude Code's temp folders, which hold each session's scratchpad: `claude` in its temp
    folder, or `claude-<user id>` where the system's temp folder is shared between users."""
    base = os.path.abspath(os.environ.get("CLAUDE_CODE_TMPDIR") or tempfile.gettempdir())
    names = ["claude"] + (["claude-{}".format(os.getuid())] if hasattr(os, "getuid") else [])
    return [os.path.join(base, name) for name in names if is_own_folder(os.path.join(base, name))]


def is_own_folder(path):
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return is_safe_folder(info)


def is_plain_folder(entry):
    try:
        info = entry.stat(follow_symlinks=False)
    except OSError:
        return False
    return is_safe_folder(info)


def is_safe_folder(info):
    """Whether `info`, read without following links, is a real folder, not a link or junction,
    that only this user can change where the system has user ids: this user's, with no write
    access for its group or others. A shared temp folder lets anyone create a `claude` there,
    and a folder others can write in lets them swap a link in while the folders below it are
    deleted."""
    is_link = stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT
    is_mine = not hasattr(os, "getuid") or (
        info.st_uid == os.getuid() and not info.st_mode & (stat.S_IWGRP | stat.S_IWOTH))
    return stat.S_ISDIR(info.st_mode) and not is_link and is_mine


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


def read_profile(folder, deadline):
    """(bytes, newest change) of everything inside `folder`, as seconds since the epoch, or None
    when it could not all be read before `deadline`. The folder's own time is left out, since
    renaming it aside changes that."""
    size, newest, stack = 0, 0.0, [folder]
    while stack:
        if time.monotonic() > deadline:
            return None
        try:
            entries = list(os.scandir(stack.pop()))
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                newest = max(newest, info.st_mtime)
                if is_plain_folder(entry):
                    stack.append(entry.path)
                elif stat.S_ISREG(info.st_mode):
                    size += info.st_size
        except OSError:
            return None
    return size, newest


def is_locked(folder):
    """Whether a running browser holds the profile, by the lock Chromium keeps in it while it
    runs: on Windows a `lockfile` it holds open for writing, elsewhere a `SingletonLock` link
    that names `<host>-<pid>`. A lock that cannot be read counts as held."""
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


def left_behind(folders, now, deadline):
    """{folder: bytes} for the folders nothing inside changed for IDLE_SECONDS that no browser
    holds, of those read in full before `deadline`."""
    picked = {}
    for folder in folders:
        read = read_profile(folder, deadline)
        if read and now - read[1] > IDLE_SECONDS and not is_locked(folder):
            picked[folder] = read[0]
    return picked


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


def leftovers(session, read_seconds):
    """(temp folders, {folder: bytes}) for the profiles earlier sessions left behind; the
    session `session` itself is left out."""
    roots, deadline, folders = temp_roots(), time.monotonic() + WALK_SECONDS, []
    for root in roots:
        own = next((os.path.join(project, session) for project in subfolders(root)
                    if session and os.path.isdir(os.path.join(project, session))), None)
        folders += profile_folders(root, own, deadline)
    return roots, left_behind(folders, time.time(), time.monotonic() + read_seconds)


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
    lines = ["Earlier sessions left {} browser profile folder(s) in Claude Code's temp folder ({}),"
             " unchanged for three days and holding {:.1f} GB.".format(
                 len(picked), ", ".join(roots), sum(picked.values()) / GIGABYTE)]
    projects = projects_of(picked, roots)
    if projects:
        lines.append("They came from sessions of: {}.".format(", ".join(projects)))
    lines.append("Nothing was deleted. Tell the user this in a line or two and offer to clean them up."
                 " On a yes, run `\"{}\" \"{}\" --clean {}`, which deletes them.".format(
                     sys.executable, os.path.abspath(__file__), session))
    return " ".join(lines)


def set_aside(picked):
    """Renames each picked folder aside, so a script that starts a browser on its path from now
    on gets a new folder. {original: aside} for each renamed; Windows refuses the rename while a
    program holds a file inside open."""
    aside = {}
    for folder in picked:
        try:
            os.rename(folder, folder + ".deleting")
            aside[folder] = folder + ".deleting"
        except OSError:
            pass
    return aside


def clean(session):
    """Deletes the profiles left behind and prints which were removed and which are still there.
    Every folder is set aside first and read again after, so one a browser started using since
    it was picked is put back."""
    _, picked = leftovers(session, CLEAN_READ_SECONDS)
    aside = set_aside(picked)
    still = left_behind(list(aside.values()), time.time(), time.monotonic() + CLEAN_READ_SECONDS)
    removed, kept = [], [folder for folder in picked if folder not in aside]
    for folder, doomed in aside.items():
        if doomed not in still:
            try:
                os.rename(doomed, folder)
                kept.append(folder)
            except OSError:
                kept.append(doomed)
            continue
        shutil.rmtree(doomed, ignore_errors=True)
        if os.path.exists(doomed):
            kept.append(doomed)
        else:
            removed.append(folder)
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
    roots, picked = leftovers(session, READ_SECONDS)
    if picked:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": report(roots, picked, session)}}))
    mark_checked(now)


if __name__ == "__main__":
    main()
