"""Installs the extras /bindwright:setup offers into the user's ~/.claude, one
consented step at a time. Python only: every extra it installs is a Python
hook or a mod folder, so a machine without Python has nothing for it to do.
Standard library, Python 3.8+.

    python engine/home.py find-python
    python engine/home.py install-hook FILE --python PATH --matcher "Bash|PowerShell"
    python engine/home.py install-hook FILE --python PATH --events SessionStart,UserPromptSubmit
    python engine/home.py install-hook FILE --python PATH --matcher Bash --block-on-failure
    python engine/home.py remove-hook NAME.py
    python engine/home.py list-hooks
    python engine/home.py hook-status DIR     (each hook DIR ships that settings run from ~/.claude/hooks)
    python engine/home.py adopt-hook FILE     (records an unrecorded hook that matches FILE; settings untouched)
    python engine/home.py allow RULE          /  disallow RULE
    python engine/home.py attribution-off
    python engine/home.py add-mod DIR
    python engine/home.py add-agent FILE
    python engine/home.py add-style FILE      (copies the output style, turns it on)
    python engine/home.py style-status FILE   (missing, linked, current, older or edited)
    python engine/home.py update-style FILE   (replaces an unedited earlier copy)
    python engine/home.py mod-status DIR      (the installed mod: missing, linked, current, older, edited or unrecorded)
    python engine/home.py update-mod DIR [--adopt]   (updates an older or edited mod; --adopt includes unrecorded ones)
    python engine/home.py remove-mod NAME     /  remove-agent NAME.md  /  remove-style NAME.md
    python engine/home.py set-language NAME   (the work language: english or spanish)
    python engine/home.py plugin-auto-update on|off [--repo OWNER/NAME]   (the wrights marketplace's auto-update)
    python engine/home.py project-mods ROOT   (the per-project mods turned off in a repo)
    python engine/home.py project-mod ROOT NAME on|off
    python engine/home.py helper-install PLUGIN
        (installs the plugin's pinned helper under the install lock: ready, busy or error)

project-mod writes the repo's personal .claude/settings.local.json, never
~/.claude, and keeps no .bak there: the repo's ignore list covers that file,
not a backup beside it.

install-hook takes exactly one of --matcher (an entry under PreToolUse) or
--events (one entry per named event, with no matcher). --block-on-failure sets
"onFailure": "block" on the hook, so a hook that crashes, times out or cannot
start (its interpreter removed) blocks the tool call; a removed hook file still
lets it through. Use it for a guard, never for a hook that only adds context.
remove-hook and list-hooks cover every event under hooks.

Each prints one line of JSON, {"error": message} with exit status 1 on
failure. `--home DIR` stands in for the home folder (tests). Every edit of
~/.claude/settings.json keeps the previous file as settings.json.bak, refuses
a file that is not valid JSON, and writes through a temporary file, so a
failed write never leaves half a settings file.
"""

import hashlib
import json
import os
import re
import runpy
import shutil
import subprocess
import sys

from apply import _is_link
from helper_install import helper_install
from home_files import HomeError, _atomic_write, _claude, _is_str_list, _json_field, _style_fingerprint
from mod_update import _check_mod_folder, _mod_target, _save_record, _shipped_hashes, mod_status, update_mod

# Its front-matter reader names an output style here too, so both find the same style.
_REPLY_STYLE_HOOK = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, "_core", "global-template", "hooks", "reply-style.py"
)

# Runs the hook file by path, and exits 0 when the file is gone, so a
# registration whose file was removed lets calls through. A hook that fails
# to run exits 1, which its entry's onFailure blocks. -I keeps the project
# folder off the import path.
LAUNCHER = (
    "import os, runpy, sys; "
    "os.path.isfile(sys.argv[1]) and runpy.run_path(sys.argv[1], run_name='__main__')"
)

# Prints the interpreter only when it is 3.8+ and not inside a virtual or a
# conda environment: the hooks serve every project, so they must not depend
# on one project's environment.
PROBE = (
    "import os, sys; assert sys.version_info >= (3, 8) and sys.prefix == sys.base_prefix; "
    "up = os.path.dirname(sys.prefix); "
    "assert not (os.path.basename(up) == 'envs' and os.path.isdir(os.path.join(os.path.dirname(up), 'conda-meta'))); "
    "print(sys.executable)"
)
CANDIDATES = (
    [["python"], ["python3"], ["py", "-3"]]
    + [["python3.%d" % n] for n in range(13, 7, -1)]
    + [["/usr/bin/python3"], ["/usr/local/bin/python3"], ["/opt/homebrew/bin/python3"]]
)

# The work languages engine/layers.py accepts (its LANGUAGES): keep the two lists alike.
LANGUAGES = ["english", "spanish"]
# The rule file for a work language other than English; %s is the language's name.
WORK_LANGUAGE_RULE = (
    "# Work language\n\n"
    "Write commit messages and code comments in %s, "
    "unless the project's own rules name a language for them.\n"
)


def _run(cmd, code):
    try:
        r = subprocess.run(cmd + ["-c", code], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    out = r.stdout.strip()
    return out if r.returncode == 0 and out else None


def find_python():
    """The first system Python 3.8+, or why there is none."""
    env_only = False
    for cmd in CANDIDATES:
        found = _run(cmd, PROBE)
        if found:
            return {"python": found}
        base = _run(cmd, "import sys; print(sys.base_prefix)")
        if base:
            # Inside an environment: try the interpreter it was made from.
            env_only = True
            for exe in ("bin/python3", "python.exe"):
                found = _run([os.path.join(base, exe)], PROBE)
                if found:
                    return {"python": found}
    reason = "only Python inside a virtual or conda environment" if env_only else "no Python 3.8+"
    raise HomeError("No system Python found: " + reason)


def _read_settings(path):
    """The JSON object in a settings file, {} when the file is missing."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8-sig") as fh:
        try:
            data = json.load(fh)
        except ValueError:
            raise HomeError("%s is not valid JSON; fix it before running setup again" % path)
    if not isinstance(data, dict):
        raise HomeError("%s does not hold a JSON object" % path)
    return data


def _load(home):
    path = os.path.join(_claude(home), "settings.json")
    return path, _read_settings(path)


def _section(data, key, kind, path):
    """data[key] as a dict or list, created when missing or null."""
    if data.get(key) is None:
        data[key] = kind()
    if not isinstance(data[key], kind):
        raise HomeError("%s: %s is not a %s; fix it by hand first" % (path, key, kind.__name__))
    return data[key]


def _save(path, data):
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak")
    _atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _runs(hook, name):
    """True when one hook runs a file called `name`, in the exec or the shell form."""
    if not isinstance(hook, dict):
        return False
    words = [hook.get("command") or ""] + [a for a in hook.get("args") or [] if isinstance(a, str)]
    return any(isinstance(w, str) and w.replace("\\", "/").rstrip("\"'").endswith("/" + name) for w in words)


def _drop(entries, name):
    """Removes every hook that runs `name`, keeping the other hooks of its
    entry; an entry left with no hooks goes too. Returns the hooks removed."""
    removed, kept = 0, []
    for entry in entries:
        hooks = entry.get("hooks") if isinstance(entry, dict) else None
        if not isinstance(hooks, list):
            kept.append(entry)
            continue
        rest = [h for h in hooks if not _runs(h, name)]
        removed += len(hooks) - len(rest)
        if rest or not hooks:
            entry["hooks"] = rest
            kept.append(entry)
    entries[:] = kept
    return removed


def _event_entries(data, event, path):
    """The hook entries under hooks[event], created when missing."""
    return _section(_section(data, "hooks", dict, path), event, list, path)


def _event_lists(data, path):
    """The hook entries of every event under hooks, skipping a null event as _section
    does; an event that is neither null nor a list is refused."""
    hooks = _section(data, "hooks", dict, path)
    for event, entries in hooks.items():
        if entries is not None and not isinstance(entries, list):
            raise HomeError("%s: hooks.%s is not a list; fix it by hand first" % (path, event))
    return [entries for entries in hooks.values() if entries is not None]


def _flag(argv, name):
    """True when the bare flag `name` is in argv; it is removed from argv."""
    if name not in argv:
        return False
    argv.remove(name)
    return True


def _event_names(events):
    """The event names in a comma-separated list, each once and in order."""
    names = [name.strip() for name in events.split(",")]
    if not all(names) or not all(name.isalpha() for name in names):
        raise HomeError("Not a list of event names: " + events)
    return list(dict.fromkeys(names))


def _same_file(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _hook_command(python):
    """The bare name PATH resolves to `python`, else `python` unchanged."""
    if not os.path.isabs(python):
        return python
    for name in ("python3", "python"):
        found = shutil.which(name)
        if found and _same_file(found, python):
            return name
    return python


def _launcher_hook(python, target, block_on_failure=False):
    """The hook that runs `target` through the launcher."""
    # The exec form of the CLI's hooks reference: with `args`, `command` is
    # started directly with them, no shell, so paths with spaces need no quoting.
    # A bare name follows PATH, so the hook survives the install it came from moving.
    # 30 s: the attribution guard's parses may take up to 27 s on a busy computer.
    hook = {
        "type": "command", "command": _hook_command(python),
        "args": ["-I", "-c", LAUNCHER, target.replace("\\", "/")], "timeout": 30,
    }
    if block_on_failure:
        hook["onFailure"] = "block"
    return hook


def _record_hooks(home, name, written):
    """Replaces hook `name`'s entries in ~/.bindwright/hooks.json with the SHA-256 of each file in
    `written`, by its path under ~/.claude/hooks, so the helper can tell a copy still as installed
    from one the user edited, and refresh only the first kind. An empty `written` forgets the hook."""
    path = os.path.join(home, ".bindwright", "hooks.json")
    files = _hook_record(home)
    package = _package_name(name) + "/"
    kept = {rel: sha for rel, sha in files.items() if rel != name and not rel.startswith(package)}
    if kept == files and not written:
        return
    for rel, text in written.items():
        kept[rel] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    _atomic_write(path, json.dumps({"schema": 1, "files": kept}, indent=2, sort_keys=True) + "\n")


def _hook_record(home):
    """The hook files ~/.bindwright/hooks.json records, by path under ~/.claude/hooks; empty without one."""
    try:
        with open(os.path.join(home, ".bindwright", "hooks.json"), encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError):
        return {}
    files = record.get("files") if isinstance(record, dict) else None
    return files if isinstance(files, dict) else {}


def _write_hook_files(home, file):
    """Copies hook `file` and the modules of its package into ~/.claude/hooks and records them."""
    name = os.path.basename(file)
    target = os.path.normpath(os.path.join(_claude(home), "hooks", name))
    written = {}
    with open(file, encoding="utf-8") as fh:
        written[name] = fh.read()
    package = os.path.join(os.path.dirname(os.path.abspath(file)), _package_name(name))
    if os.path.isdir(package):
        for module in sorted(os.listdir(package)):
            if module.endswith(".py"):
                with open(os.path.join(package, module), encoding="utf-8") as fh:
                    written[_package_name(name) + "/" + module] = fh.read()
    for rel, text in written.items():
        _atomic_write(os.path.join(os.path.dirname(target), *rel.split("/")), text)
    _record_hooks(home, name, written)
    return target


def install_hook(home, file, python, matcher=None, events=None, block_on_failure=False):
    name = os.path.basename(file)
    if not name.endswith(".py"):
        raise HomeError("A hook is a .py file: " + file)
    if (matcher is None) == (events is None):
        raise HomeError("install-hook takes exactly one of --matcher or --events")
    if matcher is not None:
        placements = [("PreToolUse", matcher)]
    else:
        placements = [(event, None) for event in _event_names(events)]
    path, data = _load(home)
    sections = [(_event_entries(data, event, path), where) for event, where in placements]
    target = _write_hook_files(home, file)
    for entries, where in sections:
        _drop(entries, name)
        entry = {} if where is None else {"matcher": where}
        entry["hooks"] = [_launcher_hook(python, target, block_on_failure)]
        entries.append(entry)
    _save(path, data)
    return {"installed": target, "settings": path}


def remove_hook(home, name):
    if not re.fullmatch(r"[A-Za-z0-9][\w-]*\.py", name):
        raise HomeError("remove-hook takes a hook's file name, such as push-guard.py: " + name)
    path, data = _load(home)
    removed = sum(_drop(entries, name) for entries in _event_lists(data, path))
    if removed:
        _save(path, data)
    target = os.path.join(_claude(home), "hooks", name)
    deleted = os.path.isfile(target)
    if deleted:
        os.remove(target)
    package = os.path.join(_claude(home), "hooks", _package_name(name))
    if os.path.isdir(package) and not _is_link(os.lstat(package)):
        shutil.rmtree(package)
    _record_hooks(home, name, {})
    return {"removed_hooks": removed, "deleted_file": deleted}


def _package_name(hook):
    """The folder of modules a hook file loads beside it: `no-ai-attribution.py` → `no_ai_attribution`."""
    return hook[:-3].replace("-", "_")


def _hook_files(hook):
    """The .py file names that a hook's command or args run."""
    if not isinstance(hook, dict):
        return []
    words = [hook.get("command") or ""] + list(hook.get("args") or [])
    return [os.path.basename(w.replace("\\", "/").strip("\"'")) for w in words
            if isinstance(w, str) and w.strip("\"'").endswith(".py")]


def list_hooks(home):
    path, data = _load(home)
    names = []
    for entries in _event_lists(data, path):
        for entry in entries:
            for hook in (entry.get("hooks") or []) if isinstance(entry, dict) else []:
                names += _hook_files(hook)
    return {"hooks": list(dict.fromkeys(names))}


def hook_status(home, folder):
    """Each hook `folder` ships that ~/.claude/settings.json runs and ~/.claude/hooks holds: whether
    ~/.bindwright/hooks.json records it, which is what lets the helper keep it current, whether its installed
    files match the shipped ones, and whether any of them is a link. A hook with no copy there is left out."""
    if not os.path.isdir(folder):
        raise HomeError("Not a hooks folder: " + folder)
    recorded = _hook_record(home)
    installed = os.path.join(_claude(home), "hooks")
    run_here = _names_run_from(home, installed)
    found = {}
    for name in list_hooks(home)["hooks"]:
        here = name in run_here and os.path.lexists(os.path.join(installed, name))
        if here and os.path.isfile(os.path.join(folder, name)):
            found[name] = {"recorded": name in recorded, "matches": _hook_matches(folder, installed, name),
                           "linked": _hook_linked(folder, installed, name)}
    return {"hooks": found}


def _names_run_from(home, installed):
    """The hook file names some settings entry runs from the folder `installed`."""
    path, data = _load(home)
    names = set()
    for entries in _event_lists(data, path):
        for entry in entries:
            for hook in (entry.get("hooks") or []) if isinstance(entry, dict) else []:
                names.update(n for n in _hook_files(hook) if _runs_from(hook, os.path.join(installed, n), home))
    return names


def _runs_from(hook, path, home):
    """True when one hook runs the file at `path`, written in full or from `~` or `$HOME`, in the exec or the
    shell form."""
    ends = [path.replace("\\", "/")]
    rel = os.path.relpath(path, home).replace("\\", "/") if _is_under(path, home) else None
    if rel:
        ends += [start + "/" + rel for start in ("~", "$HOME", "${HOME}")]
    ends = [os.path.normcase(end) for end in ends]
    words = [hook.get("command") or ""] + [a for a in hook.get("args") or [] if isinstance(a, str)]
    for word in words:
        word = os.path.normcase(word.replace("\\", "/").rstrip("\"'")) if isinstance(word, str) else ""
        for end in ends:
            before = word[:-len(end)]
            if word.endswith(end) and (not before or before[-1] in " \"'="):
                return True
    return False


def _is_under(path, folder):
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(folder)]) == os.path.abspath(folder)
    except ValueError:
        return False


def _hook_linked(folder, installed, name):
    """True when the hook file, its package folder or one of its shipped modules is installed as a link the
    user keeps, such as into a dotfiles folder."""
    paths = [_package_name(name)] + _hook_rels(folder, name)
    paths = [os.path.join(installed, *rel.split("/")) for rel in paths]
    return any(os.path.lexists(p) and _is_link(os.lstat(p)) for p in paths)


def adopt_hook(home, file):
    """Records a hook installed with the text of `file`, its package included, so the helper keeps it current.
    Its entry in ~/.claude/settings.json stays as it is; a linked or differing copy is refused."""
    name = os.path.basename(file)
    installed = os.path.join(_claude(home), "hooks")
    if not name.endswith(".py") or not os.path.isfile(file):
        raise HomeError("A hook is a .py file: " + file)
    if _hook_linked(os.path.dirname(os.path.abspath(file)), installed, name):
        raise HomeError("The installed hook is a link, which stays as it is: " + name)
    if not _hook_matches(os.path.dirname(os.path.abspath(file)), installed, name):
        raise HomeError("The installed hook differs from the shipped one; install-hook replaces it: " + name)
    return {"recorded": _write_hook_files(home, file)}


def _hook_rels(folder, name):
    """The hook file and the modules of its package that `folder` ships, as paths under the hooks folder."""
    rels = [name]
    package = os.path.join(folder, _package_name(name))
    if os.path.isdir(package):
        rels += [_package_name(name) + "/" + m for m in sorted(os.listdir(package)) if m.endswith(".py")]
    return rels


def _hook_matches(folder, installed, name):
    """True when the hook file and every module of its package are installed with the shipped text."""
    for rel in _hook_rels(folder, name):
        copy = os.path.join(installed, *rel.split("/"))
        shipped = os.path.join(folder, *rel.split("/"))
        if not os.path.isfile(copy) or _style_fingerprint(copy) != _style_fingerprint(shipped):
            return False
    return True


def set_allow(home, rule, on):
    path, data = _load(home)
    allow = _section(_section(data, "permissions", dict, path), "allow", list, path)
    present = rule in allow
    if on and not present:
        allow.append(rule)
    elif not on and present:
        allow[:] = [r for r in allow if r != rule]
    if on != present:
        _save(path, data)
    return {"rule": rule, "allowed": on, "changed": on != present}


def attribution_off(home):
    path, data = _load(home)
    data["attribution"] = {"commit": "", "pr": "", "sessionUrl": False}
    _save(path, data)
    return {"settings": path}


# The marketplace Bindwright and FindWright install from, as `/plugin marketplace add` names it.
WRIGHTS = "wrights"
# Each turns Claude Code's whole plugin auto-update pass off, unless FORCE_AUTOUPDATE_PLUGINS is set.
UPDATE_BLOCKERS = ("DISABLE_UPDATES", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")


def _update_blockers(env):
    if env.get("FORCE_AUTOUPDATE_PLUGINS"):
        return []
    return [name for name in UPDATE_BLOCKERS if env.get(name)]


def set_plugin_auto_update(home, state, repo=None):
    """Turns Claude Code's auto-update for the wrights marketplace on or off. A settings
    entry outranks the /plugin toggle, so off is written as false, not left out. With no
    entry yet, on needs the GitHub repo the marketplace was added from (`claude plugin
    marketplace list --json`), so the entry never points it anywhere else; off has nothing
    to turn off, since auto-update is off by default for that marketplace."""
    if state not in ("on", "off"):
        raise HomeError("Use on or off, not " + state)
    if repo is not None and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise HomeError("--repo takes owner/name, not " + repo)
    path, data = _load(home)
    marketplaces = _section(data, "extraKnownMarketplaces", dict, path)
    entry = marketplaces.get(WRIGHTS)
    if entry is None and state == "off":
        return {"settings": path, "on": False, "changed": False, "blocked_by": []}
    if entry is None and repo is None:
        raise HomeError("No wrights entry in %s yet: pass --repo with the repo the marketplace comes from" % path)
    if entry is None:
        entry = marketplaces[WRIGHTS] = {"source": {"source": "github", "repo": repo}}
    elif not isinstance(entry, dict):
        raise HomeError("%s: extraKnownMarketplaces.%s is not an object; fix it by hand first" % (path, WRIGHTS))
    changed = entry.get("autoUpdate") is not (state == "on")
    if changed:
        entry["autoUpdate"] = state == "on"
        _save(path, data)
    settings_env = data.get("env") if isinstance(data.get("env"), dict) else {}
    # Claude Code sees both sources at once, the settings env over the process's, so judge them merged.
    blocked = _update_blockers({**os.environ, **settings_env})
    return {"settings": path, "on": state == "on", "changed": changed, "blocked_by": blocked}


# The CLI draws the mods' rows above the prompt top-down in folder-list order, so the
# most-read rows go last, nearest the prompt. Mods with no row follow. A mod of the user's own
# keeps its place and a new one of theirs goes last.
MOD_ORDER = ("shared-pc", "runners", "usage-guard", "ci-watch", "tasks", "session-info",
             "session-facts", "compact-handoff", "skill-check", "mods")


def _mod_rank(folder):
    name = os.path.basename(os.path.normpath(os.path.expanduser(folder)))
    return MOD_ORDER.index(name) if name in MOD_ORDER else None


def _with_mod(listed, target):
    rank = _mod_rank(target)
    later = (i for i, d in enumerate(listed)
             if rank is not None and _mod_rank(d) is not None and _mod_rank(d) > rank)
    at = next(later, len(listed))
    return listed[:at] + [target] + listed[at:]


# Settings a mod cannot work without, turned on with it and left on when it is removed, since
# each one only turns on a CLI feature that works without the mod. The tasks mod answers the
# CLI's task tools, which CLI 2.1.233 and later hide on current models unless this is set.
MOD_ENV = {"tasks": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"}}


def _turn_on_env(env, name):
    """Sets what MOD_ENV lists for the mod and returns the keys it changed."""
    needs = MOD_ENV.get(name, {})
    turned_on = sorted(key for key, value in needs.items() if env.get(key) != value)
    for key in turned_on:
        env[key] = needs[key]
    return turned_on


def _listed_mods(env):
    return [d for d in str(env.get("CLAUDE_CODE_PLUGIN_DIRS") or "").split(os.pathsep) if d]


def add_mod(home, folder):
    _check_mod_folder(folder)
    name = os.path.basename(os.path.normpath(folder))
    path, data = _load(home)
    env = _section(data, "env", dict, path)
    target = _mod_target(home, folder)
    # An installed copy may carry the user's own edits (rules.ts lists), so it stays.
    kept = os.path.exists(target)
    if not kept:
        shutil.copytree(folder, target)
        _save_record(target, _shipped_hashes(folder))
    changed = False
    listed = _listed_mods(env)
    same = lambda d: os.path.normcase(os.path.normpath(os.path.expanduser(d))) == os.path.normcase(target)
    if not any(same(d) for d in listed):
        env["CLAUDE_CODE_PLUGIN_DIRS"] = os.pathsep.join(_with_mod(listed, target))
        changed = True
    turned_on = _turn_on_env(env, name)
    if changed or turned_on:
        _save(path, data)
    return {"installed": target, "kept_existing": kept, "env_set": turned_on}


def add_agent(home, file):
    name = os.path.basename(file)
    if not (name.endswith(".md") and os.path.isfile(file)):
        raise HomeError("Not an agent file (an existing .md file): " + file)
    target = os.path.normpath(os.path.join(_claude(home), "agents", name))
    # An installed agent may carry the user's own edits, so it stays.
    kept = os.path.exists(target)
    if not kept:
        with open(file, encoding="utf-8") as fh:
            _atomic_write(target, fh.read())
    return {"installed": target, "kept_existing": kept}


def _style_name(text):
    """The `name:` of an output style's front matter, or None without one.

    Read with the reply-style hook's own reader, so the style turned on here is the one it restates.
    """
    front_matter = runpy.run_path(_REPLY_STYLE_HOOK)["front_matter"]
    return front_matter(text.lstrip("﻿").replace("\r\n", "\n"))[0]


def add_style(home, file):
    name = os.path.basename(file)
    if not (name.endswith(".md") and os.path.isfile(file)):
        raise HomeError("Not an output style file (an existing .md file): " + file)
    with open(file, encoding="utf-8-sig") as fh:
        text = fh.read()
    if _style_name(text) is None:
        raise HomeError("The output style has no name in its front matter: " + file)
    path, data = _load(home)
    target = os.path.normpath(os.path.join(_claude(home), "output-styles", name))
    # An installed style may carry the user's own edits, so it stays, and its own
    # name is the one turned on: the CLI names a style without one after its file.
    kept = os.path.exists(target)
    if kept:
        with open(target, encoding="utf-8-sig") as fh:
            text = fh.read()
    else:
        _atomic_write(target, text)
    style = _style_name(text) or os.path.splitext(name)[0]
    previous = data.get("outputStyle")
    if previous != style:
        data["outputStyle"] = style
        _save(path, data)
    return {"installed": target, "kept_existing": kept, "outputStyle": style, "previous": previous}


def _read_style(file):
    with open(file, encoding="utf-8-sig") as fh:
        return fh.read()


def _retired_fingerprints(file):
    """The SHA-256 of each earlier shipped copy of the style `file`, kept beside it in <name>.retired.json."""
    sidecar = os.path.splitext(file)[0] + ".retired.json"
    if not os.path.isfile(sidecar):
        return set()
    return set(_json_field(sidecar, "sha256", _is_str_list, 'Not a list of earlier copies ({"sha256": [...]})'))


def style_status(home, file):
    """Whether the installed copy of the style `file` is missing, current, an earlier shipped copy, edited,
    or a link, which stays the user's: replacing it would cut it off from the file it points to."""
    name = os.path.basename(file)
    if not (name.endswith(".md") and os.path.isfile(file)):
        raise HomeError("Not an output style file (an existing .md file): " + file)
    target = os.path.normpath(os.path.join(_claude(home), "output-styles", name))
    if not os.path.exists(target):
        return {"installed": target, "state": "missing"}
    if os.path.islink(target):
        return {"installed": target, "state": "linked"}
    installed = _style_fingerprint(target)
    if installed == _style_fingerprint(file):
        state = "current"
    elif installed in _retired_fingerprints(file):
        state = "older"
    else:
        state = "edited"
    return {"installed": target, "state": state}


def update_style(home, file):
    """Replaces an earlier shipped copy of the style `file` with it; an edited or linked copy stays."""
    status = style_status(home, file)
    replaced = status["state"] == "older"
    if replaced:
        _atomic_write(status["installed"], _read_style(file))
    return dict(status, replaced=replaced)


def _plain_name(name, kind):
    """`name` when it is one file or folder name, never a path; refused otherwise."""
    if not name or name in (".", "..") or "/" in name or "\\" in name or ":" in name:
        raise HomeError(f"Not {kind} name: {name}")
    return name


def remove_mod(home, name):
    """Takes a mod out of CLAUDE_CODE_PLUGIN_DIRS and deletes its folder under mods/."""
    target = os.path.normpath(os.path.join(_claude(home), "mods", _plain_name(name, "a mod")))
    try:
        is_link = _is_link(os.lstat(target))
    except FileNotFoundError:
        is_link = False
    if is_link:
        raise HomeError("The mod folder is a link; remove it by hand: " + target)
    path, data = _load(home)
    env = _section(data, "env", dict, path)
    listed = _listed_mods(env)
    same = lambda d: os.path.normcase(os.path.normpath(os.path.expanduser(d))) == os.path.normcase(target)
    kept = [d for d in listed if not same(d)]
    unlisted = len(kept) != len(listed)
    if unlisted:
        if kept:
            env["CLAUDE_CODE_PLUGIN_DIRS"] = os.pathsep.join(kept)
        else:
            del env["CLAUDE_CODE_PLUGIN_DIRS"]
        _save(path, data)
    deleted = os.path.isdir(target)
    if deleted:
        shutil.rmtree(target)
    return {"removed": target, "unlisted": unlisted, "deleted_folder": deleted}


def remove_agent(home, name):
    """Deletes an agent file under agents/, such as builder.md."""
    target = os.path.normpath(os.path.join(_claude(home), "agents", _plain_name(name, "an agent file")))
    deleted = os.path.isfile(target) and not os.path.islink(target)
    if deleted:
        os.remove(target)
    return {"removed": target, "deleted_file": deleted}


def remove_style(home, name):
    """Deletes an output style file and turns it off when outputStyle names it."""
    target = os.path.normpath(os.path.join(_claude(home), "output-styles", _plain_name(name, "a style file")))
    style = os.path.splitext(name)[0]
    deleted = os.path.isfile(target) and not os.path.islink(target)
    if deleted:
        with open(target, encoding="utf-8-sig") as fh:
            style = _style_name(fh.read()) or style
    path, data = _load(home)
    turned_off = data.get("outputStyle") == style
    if turned_off:
        del data["outputStyle"]
        _save(path, data)
    if deleted:
        os.remove(target)
    return {"removed": target, "deleted_file": deleted, "turned_off": turned_off, "outputStyle": style}


# The mods a project may turn off for itself alone. The others act for the whole computer
# (shared-pc's line for heavy work, usage-guard's pause, the session-facts line), so one
# project turning them off would break them for every other.
PROJECT_MODS = ("ci-watch", "tasks", "skill-check")
# The engine names a mod loaded from CLAUDE_CODE_PLUGIN_DIRS `<name>@inline`.
INLINE = "@inline"


def _repo_folder(root):
    if not os.path.isdir(root):
        raise HomeError("Not a folder: " + root)
    return root


def project_mods(root):
    """The per-project mods turned off in `root`, merged as the engine merges the shared
    .claude/settings.json and then the personal .claude/settings.local.json."""
    is_on = {}
    for name in ("settings.json", "settings.local.json"):
        path = os.path.join(_repo_folder(root), ".claude", name)
        plugins = _read_settings(path).get("enabledPlugins")
        if not isinstance(plugins, dict):
            continue
        for key, value in plugins.items():
            if key.endswith(INLINE) and isinstance(value, bool):
                is_on[key[:-len(INLINE)]] = value
    return {"off": [name for name in PROJECT_MODS if is_on.get(name) is False]}


def set_project_mod(root, name, state):
    """Turns a per-project mod off (or back on) in `root`'s personal .claude/settings.local.json."""
    if name not in PROJECT_MODS:
        raise HomeError("%s is not a per-project mod; those are %s" % (name, ", ".join(PROJECT_MODS)))
    if state not in ("on", "off"):
        raise HomeError("Use on or off, not " + state)
    path = os.path.join(_repo_folder(root), ".claude", "settings.local.json")
    data = _read_settings(path)
    plugins = _section(data, "enabledPlugins", dict, path)
    key = name + INLINE
    before = plugins.get(key)
    shared = _read_settings(os.path.join(root, ".claude", "settings.json")).get("enabledPlugins")
    is_off_for_team = isinstance(shared, dict) and shared.get(key) is False
    # On is the mod's own default, so it writes true only to outrank the shared file's false.
    if state == "off":
        plugins[key] = False
    elif is_off_for_team:
        plugins[key] = True
    else:
        plugins.pop(key, None)
    if not plugins:
        del data["enabledPlugins"]
    changed = plugins.get(key) != before
    if changed:
        _atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return {"settings": path, "mod": name, "on": state == "on", "changed": changed}


def _work_language_rule(home):
    return os.path.abspath(os.path.join(_claude(home), "rules", "work-language.md"))


def set_language(home, name):
    if name not in LANGUAGES:
        raise HomeError("Unknown work language: %s; use %s" % (name, " or ".join(LANGUAGES)))
    path, data = _load(home)
    previous = data.get("language")
    rule = _work_language_rule(home)
    if name == "english":
        # A language the person set by hand, such as "japanese", is theirs to keep.
        if previous in LANGUAGES:
            del data["language"]
            _save(path, data)
        if os.path.exists(rule):
            os.remove(rule)
        return {"language": name, "previous": previous, "rule": None}
    if previous != name:
        data["language"] = name
        _save(path, data)
    _atomic_write(rule, WORK_LANGUAGE_RULE % name.capitalize())
    return {"language": name, "previous": previous, "rule": rule}


def _option(argv, name):
    if name not in argv:
        return None
    i = argv.index(name) + 1
    if i == len(argv) or argv[i].startswith("--"):
        raise HomeError(name + " needs a value")
    value = argv[i]
    del argv[i - 1:i + 1]
    return value


# The commands that take one name, each run as command(home, name).
NAMED_COMMANDS = {
    "remove-hook": remove_hook,
    "hook-status": hook_status,
    "adopt-hook": adopt_hook,
    "allow": lambda home, rule: set_allow(home, rule, True),
    "disallow": lambda home, rule: set_allow(home, rule, False),
    "add-mod": add_mod,
    "add-agent": add_agent,
    "add-style": add_style,
    "style-status": style_status,
    "update-style": update_style,
    "mod-status": mod_status,
    "remove-mod": remove_mod,
    "remove-agent": remove_agent,
    "remove-style": remove_style,
    "set-language": set_language,
    "helper-install": helper_install,
}


def run(argv):
    argv = list(argv)
    home = _option(argv, "--home") or os.path.expanduser("~")
    python, matcher = _option(argv, "--python"), _option(argv, "--matcher")
    events, repo = _option(argv, "--events"), _option(argv, "--repo")
    block_on_failure = _flag(argv, "--block-on-failure")
    adopt = _flag(argv, "--adopt")
    cmd, args = (argv[0], argv[1:]) if argv else (None, [])
    one = args[0] if len(args) == 1 else None
    if cmd == "find-python" and not args:
        return find_python()
    if cmd == "install-hook" and one and python:
        return install_hook(home, one, python, matcher or None, events or None, block_on_failure)
    if cmd == "list-hooks" and not args:
        return list_hooks(home)
    if cmd == "attribution-off" and not args:
        return attribution_off(home)
    if cmd == "plugin-auto-update" and one:
        return set_plugin_auto_update(home, one, repo)
    if cmd == "update-mod" and one:
        return update_mod(home, one, adopt)
    if cmd in NAMED_COMMANDS and one:
        return NAMED_COMMANDS[cmd](home, one)
    if cmd == "project-mods" and one:
        return project_mods(one)
    if cmd == "project-mod" and len(args) == 3:
        return set_project_mod(*args)
    raise HomeError("Usage: see the top of engine/home.py")


def main(argv):
    try:
        result = run(argv)
    except (HomeError, OSError) as e:
        result = {"error": str(e)}
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
