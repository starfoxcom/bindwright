"""SessionStart hook: find the browser profile folders that earlier sessions left in Claude Code's
temp folder, and ask the assistant to offer their cleanup.

A script that drives a browser often gives it a profile folder of its own (`--user-data-dir`)
in the session's scratchpad. When the script dies, or forgets to clean up, each run leaves a
folder that can reach a gigabyte. Claude Code frees a scratchpad only together with its
session's transcript, weeks later.

The hook deletes nothing. It looks at most once a day, at the start of a new session. On the
user's yes, the assistant runs this file with `--clean <session id>`, which picks the same
folders again and deletes them. A folder is picked only when nothing in it changed for an hour
and no running program uses it: no browser holds Chromium's profile lock in it, and no program
holds a file inside it open.
"""
import json
import os
import shutil
import socket
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
    that only this user can change where the system has user ids: a shared temp folder lets
    anyone else create a `claude` there, and a folder others can write in lets them swap a
    link in while the folders below it are deleted."""
    is_link = stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT
    is_mine = not hasattr(os, "getuid") or only_mine(info)
    return stat.S_ISDIR(info.st_mode) and not is_link and is_mine


def only_mine(info):
    """Whether a folder is this user's and no one else can write in it. Write access for its
    group is the user's alone only when the group is theirs: named after them, no members."""
    if info.st_uid != os.getuid() or info.st_mode & stat.S_IWOTH:
        return False
    return not info.st_mode & stat.S_IWGRP or is_own_group(info.st_gid)


def is_own_group(gid):
    import grp  # POSIX only, as is every caller
    import pwd
    try:
        group = grp.getgrgid(gid)
        return group.gr_name == pwd.getpwuid(os.getuid()).pw_name and not group.gr_mem
    except KeyError:
        return False


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


def is_in_use(folder, open_paths):
    """Whether a running program may still use the profile. Chromium's own lock covers a full
    browser: on Windows a `lockfile` it holds open for writing, elsewhere a `SingletonLock`
    link that names `<host>-<pid>`. A headless shell keeps no lock, so a file held open inside
    the folder counts too: Windows refuses to rename a folder then, and elsewhere `open_paths`
    lists every file this user's programs hold open. A lock that cannot be read counts as held."""
    if os.name == "nt":
        return is_held_open(os.path.join(folder, "lockfile")) or not can_rename(folder)
    real = os.path.realpath(folder)
    return (names_live_browser(os.path.join(folder, "SingletonLock"))
            or any(path == real or path.startswith(real + os.sep) for path in open_paths))


def can_rename(folder):
    """Whether `folder` can be renamed and put back, which Windows refuses while any program
    holds a file inside it open."""
    aside = folder + ".in-use-check"
    try:
        os.rename(folder, aside)
    except OSError:
        return False
    try:
        os.rename(aside, folder)
    except OSError:
        return False
    return True


def open_paths():
    """The real paths of the files and folders this user's programs hold open, from /proc on
    Linux and from lsof elsewhere, or None when they cannot be listed. Windows needs none."""
    if os.name == "nt":
        return []
    if os.path.isdir("/proc/self/fd"):
        return proc_open_paths()
    try:
        listed = subprocess.run(["lsof", "-n", "-P", "-w", "-F", "n", "-u", str(os.getuid())],
                                capture_output=True, timeout=LIST_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = listed.stdout.decode("utf-8", "replace").splitlines()
    names = [line[1:] for line in lines if line.startswith("n/")]
    return names if listed.returncode == 0 and names else None


def proc_open_paths():
    """Every working folder and open file of the processes /proc lets this user read."""
    paths = []
    for pid in (name for name in os.listdir("/proc") if name.isdigit()):
        base = os.path.join("/proc", pid)
        try:
            links = ["cwd"] + [os.path.join("fd", fd) for fd in os.listdir(os.path.join(base, "fd"))]
        except OSError:
            continue  # another user's process, or one that just ended
        for link in links:
            try:
                paths.append(os.readlink(os.path.join(base, link)))
            except OSError:
                pass
    return paths


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


def left_behind(folders, now, held):
    """The folders nothing changed for IN_USE_SECONDS that no running program uses, given the
    open paths `held`; when those could not be listed, none."""
    if held is None:
        return []
    return [folder for folder in folders
            if now - last_written(folder) > IN_USE_SECONDS and not is_in_use(folder, held)]


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
    return roots, left_behind(folders, time.time(), open_paths() if folders else [])


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
                 " program uses.".format(sys.executable, os.path.abspath(__file__), session))
    return " ".join(lines)


def clean(session):
    """Deletes the profiles left behind and prints which were removed and which are still there
    (a file another program holds open)."""
    _, picked = leftovers(session)
    removed, kept = [], []
    for folder in picked:
        # Renamed aside first, so a script that starts a browser on the folder meanwhile gets a
        # new one; on Windows the rename also fails while a program still holds a file inside.
        doomed = folder + ".deleting"
        try:
            os.rename(folder, doomed)
        except OSError:
            kept.append(folder)
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
    roots, picked = leftovers(session)
    if picked:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": report(roots, picked, session)}}))
    mark_checked(now)


if __name__ == "__main__":
    main()
