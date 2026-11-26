"""Fails a change that edits a mod's code without raising the version its manifest names.

    python tools/mod_version_check.py <base ref>

A mod is a folder under _core/global-template/mods/. Its code is every file in it except its tests
(a tests/ folder, *.test.ts, *.test.tsx) and Markdown. For each mod whose code differs between the
merge base of <base ref> and HEAD, .claude-plugin/plugin.json at HEAD must name an x.y.z version
higher than the base's. A mod the base does not have passes, and so does one the change deletes.
Standard library, Python 3.8+.
"""

import json
import re
import subprocess
import sys

MODS = "_core/global-template/mods"
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)")


def _git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def _is_code(rel):
    """Whether a path inside a mod folder is part of what the mod runs."""
    parts = rel.split("/")
    return not ("tests" in parts[:-1] or rel.endswith((".test.ts", ".test.tsx", ".md")))


def changed_mods(base):
    """The mods whose code differs between the merge base of `base` and HEAD, sorted."""
    # Without --no-renames a file moved out of a mod lists only its new path, so the mod it left
    # would go unchecked.
    names = _git("diff", "--name-only", "--no-renames", "%s...HEAD" % base, "--", MODS + "/").splitlines()
    mods = set()
    for name in names:
        mod, _, rel = name[len(MODS) + 1:].partition("/")
        if rel and _is_code(rel):
            mods.add(mod)
    return sorted(mods)


def version_at(rev, mod):
    """The version tuple the mod's manifest names at `rev`: None when the file is missing, and
    "unreadable" when it names no x.y.z version."""
    try:
        text = _git("show", "%s:./%s/%s/.claude-plugin/plugin.json" % (rev, MODS, mod))
    except subprocess.CalledProcessError:
        return None
    try:
        version = json.loads(text).get("version")
    except (ValueError, AttributeError):
        return "unreadable"
    match = VERSION.fullmatch(version) if isinstance(version, str) else None
    return tuple(int(part) for part in match.groups()) if match else "unreadable"


def _exists_at_head(mod):
    return bool(_git("ls-tree", "-d", "HEAD", "--", "%s/%s" % (MODS, mod)).strip())


def problems(base):
    """One line per mod whose code changed without its version moving up. A mod the change
    deletes whole passes, since nothing of it ships."""
    merge_base = _git("merge-base", base, "HEAD").strip()
    found = []
    for mod in changed_mods(base):
        before, after = version_at(merge_base, mod), version_at("HEAD", mod)
        if before is None or before == "unreadable":
            continue
        if after is None and not _exists_at_head(mod):
            continue
        if after is None or after == "unreadable":
            found.append("%s: its manifest names no x.y.z version" % mod)
        elif after <= before:
            found.append("%s: its code changed, so raise its version above %s in .claude-plugin/plugin.json"
                         % (mod, ".".join(map(str, before))))
    return found


def main(argv):
    if len(argv) != 1:
        print("Usage: python tools/mod_version_check.py <base ref>", file=sys.stderr)
        return 2
    found = problems(argv[0])
    for line in found:
        print("::error::" + line)
    if not found:
        print("Every mod whose code changed names a higher version.")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
