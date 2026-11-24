# Python twin of doctor.js: the same checks, in the same order and words.
# Standard library only.

import os
import re

from model import JS_WHITESPACE, expand_answers, validate
from layers import MODS, _command_hooks, _is_missing, _program, _read_layer_file, run_settings
from update import ANSWERS, PRISTINE, STAGING, _code_units

# What to do about each finding, in plain words.
FIX = {
    "restore": "Restore it from git with `git checkout -- .bindwright/`, or set the repo up again.",
    "update": "Run /bindwright:update: it keeps the repo's own edits.",
    "plugin": "Update the Bindwright plugin from /plugin first. Until then, do not run /bindwright:update: "
              "it would write this older plugin's files.",
    "reinstall": "Reinstall the Bindwright plugin from /plugin.",
    "guards": "Restore them from git with `git checkout -- .claude/hooks/`; "
              "an update does not bring back deleted files.",
    "settings": "Fix or remove those values in the files named.",
    "join": "Run /bindwright:join: it installs each one on a yes and remembers a no.",
    "cli": "Update the CLI. In Claude Desktop, update the app: it ships its own copy of the CLI.",
    "staged": "Run /bindwright:update, which walks through each one, or delete the ones you do not want.",
    "unreadable": "Fix or remove the file it names.",
    "roadmap": "Fix those lines: each item is one line that starts with its id (R4), at most five sit under Now, "
               "and the Next id line is above every id in use.",
    "hooks": "Run /bindwright:setup again to reinstall them, "
             "or fix the paths in the settings file named.",
    "instructions": "Move what a session needs only for some files into rules with a `paths:` line, which load "
                    "only when Claude reads a matching file, or into the skill that uses it. Past the limit "
                    "Claude Code warns at every session start.",
}

INSTRUCTIONS_LIMIT = 150000
INSTRUCTIONS_WARN_AT = 120000


MODS_SINCE = [2, 1, 287]
GUARDS_SINCE = [2, 1, 295]


def cli_version_from(agent):
    m = re.match(r"claude-code_(\d+)-(\d+)-(\d+)_", agent if isinstance(agent, str) else "")
    return [int(n) for n in m.groups()] if m else None


def _before(a, b):
    for x, y in zip(a, b):
        if x != y:
            return x < y
    return False


def _parts(v):
    return [int(n) for n in v.split(".")] if isinstance(v, str) and re.fullmatch(r"\d+\.\d+\.\d+", v) else None


def _staged(root):
    base = os.path.join(root, *STAGING.strip("/").split("/"))
    out = []

    def walk(folder, prefix):
        for name in sorted(os.listdir(folder), key=_code_units):
            path = os.path.join(folder, name)
            # A linked folder counts as one file, as Node's directory entries see it.
            if os.path.isdir(path) and not os.path.islink(path):
                walk(path, prefix + name + "/")
            else:
                out.append(prefix + name)
    if os.path.exists(base):
        walk(base, "")
    return out


def _check(id_, ok, say, fix=None):
    return {"id": id_, "ok": ok, "say": say, "fix": fix}


def _staged_check(root):
    try:
        files = _staged(root)
    except OSError:
        return _check("staged", False, "%s cannot be read as a folder." % STAGING, FIX["unreadable"])
    if files:
        return _check("staged", False, "%d staged file(s) wait under %s: %s." % (len(files), STAGING, ", ".join(files)),
                      FIX["staged"])
    return _check("staged", True, "No staged files are waiting.")


def roadmap_problems(text):
    """See roadmapProblems in doctor.js."""
    problems, ids, section, now, nxt = [], [], None, 0, None
    for line in re.split(r"\r\n|\r|\n", text):
        if line.startswith("## "):
            section = line[3:].strip(JS_WHITESPACE)
        counter = re.fullmatch(r"Next id: R([0-9]{1,9}) *", line)
        if counter:
            nxt = int(counter.group(1))
        if not line.startswith("- ") or section not in ("Now", "Next", "Later"):
            continue
        found = re.match(r"- R([0-9]{1,9}) ", line)
        item = found if found and line[found.end():].strip(JS_WHITESPACE) else None
        if not item:
            problems.append('"%s" has no id' % line[:60])
        elif item.group(1) in ids:
            problems.append("R%s is used twice" % item.group(1))
        else:
            ids.append(item.group(1))
        if section == "Now":
            now += 1
    if now > 5:
        problems.append("%d items sit under Now, more than five" % now)
    if nxt is None:
        problems.append("the Next id line is missing")
    elif any(int(i) >= nxt for i in ids):
        problems.append("Next id R%d is not above every id in use" % nxt)
    return problems


def _roadmap_check(root):
    path = os.path.join(root, "ROADMAP.md")
    if not os.path.exists(path):
        return _check("roadmap", True, "No ROADMAP.md yet; the next /close-session writes it.")
    try:
        # newline="" hands every line end through as written, as doctor.js reads it.
        with open(path, encoding="utf-8", newline="") as f:
            problems = roadmap_problems(f.read())
    except (OSError, UnicodeDecodeError):
        return _check("roadmap", False, "ROADMAP.md cannot be read.", FIX["unreadable"])
    if problems:
        return _check("roadmap", False, "ROADMAP.md is out of shape: %s." % "; ".join(problems), FIX["roadmap"])
    return _check("roadmap", True, "ROADMAP.md is in shape.")


def _state_checks(root):
    def at(path):
        return os.path.join(root, *path.split("/"))
    try:
        answers = _read_layer_file(at(ANSWERS), ANSWERS)
        pristine = _read_layer_file(at(PRISTINE), PRISTINE)
    except Exception as e:
        return {"checks": [_check("state", False, "A Bindwright state file cannot be read: %s." % e,
                                  FIX["restore"])]}
    if answers is None or pristine is None:
        say = "This repo is not set up with Bindwright."
        return {"checks": [_check("state", False, say, "Run /bindwright:setup.")]}
    try:
        validate(expand_answers(answers))
    except Exception as e:
        return {"checks": [_check("state", False, "The saved answers in %s are broken: %s." % (ANSWERS, e),
                                  "Restore the file from git with `git checkout -- %s`." % ANSWERS)]}
    if not isinstance(pristine, dict) or not isinstance(pristine.get("files"), dict):
        return {"checks": [_check("state", False, "%s does not hold the files setup wrote." % PRISTINE,
                                  "Restore the file from git with `git checkout -- %s`." % PRISTINE)]}
    return {"checks": [_check("state", True, "The setup files are present and readable.")],
            "answers": answers, "pristine": pristine}


def _version_check(pristine, plugin_version):
    repo, plugin = _parts(pristine.get("version")), _parts(plugin_version)
    if not repo:
        return _check("version", False, "%s names no version Bindwright can read." % PRISTINE, FIX["restore"])
    if not plugin:
        return _check("version", False, "The plugin's own version cannot be read.", FIX["reinstall"])
    say = "The repo's Bindwright files come from %s; the plugin is %s." % (pristine["version"], plugin_version)
    if _before(repo, plugin):
        return _check("version", False, say, FIX["update"])
    if _before(plugin, repo):
        return _check("version", False, say, FIX["plugin"])
    return _check("version", True, "The repo's files match the plugin's version.")


def _guard_check(root, answers, pristine):
    guards = [".claude/hooks/push-guard.py", ".claude/hooks/run-hook.sh"]
    missing = []
    if answers["advanced"]["hookLocation"] == "repo":
        missing = [p for p in guards
                   if p in pristine["files"] and not os.path.exists(os.path.join(root, *p.split("/")))]
    if missing:
        return _check("guards", False,
                      "The repo's guard hooks are missing: %s. Force pushes are not blocked here." % ", ".join(missing),
                      FIX["guards"])
    return _check("guards", True, "The guard hooks are in place.")


def _settings_checks(root, config):
    try:
        settings = run_settings(root, config)
    except Exception as e:
        return {"checks": [_check("settings", False, "The settings cannot be read: %s." % e, FIX["unreadable"])],
                "installed": {}}
    if settings["ignored"]:
        first = _check("settings", False, "Some settings are not used: %s." % "; ".join(settings["ignored"]),
                       FIX["settings"])
    else:
        first = _check("settings", True, "Every setting is in use.")
    if settings["drift"]:
        lacks = "The project expects extras this machine lacks: %s." % ", ".join(settings["drift"])
        second = _check("extras", False, lacks,
                        FIX["join"])
    else:
        second = _check("extras", True, "This machine has the extras the project expects.")
    return {"checks": [first, second], "installed": settings["installed"]}


def _has_guards(answers, pristine, installed):
    in_repo = answers["advanced"]["hookLocation"] == "repo" and ".claude/hooks/run-hook.sh" in pristine["files"]
    return in_repo or bool(installed.get("push-guard") or installed.get("attribution-guard"))


def _cli_check(installed, cli_version, guards):
    mods = any(has and name in MODS for name, has in installed.items())
    old_for_mods = mods and _before(cli_version or MODS_SINCE, MODS_SINCE)
    old_for_guards = guards and _before(cli_version or GUARDS_SINCE, GUARDS_SINCE)
    if not old_for_mods and not old_for_guards:
        return _check("cli", True, "The CLI runs the guard hooks and the installed mods.")
    needs = [text for old, text in (
        (old_for_guards, "the %s the guard hooks need, so a guard that crashes or runs out of time lets the "
                         "command through" % ".".join(map(str, GUARDS_SINCE))),
        (old_for_mods, "the %s the mods need, so none of them load" % ".".join(map(str, MODS_SINCE)))) if old]
    return _check("cli", False,
                  "This session runs CLI %s, older than %s." % (".".join(map(str, cli_version)), ", and ".join(needs)),
                  FIX["cli"])


def _hooks_check(config):
    try:
        settings = _read_layer_file(os.path.join(config, "settings.json"), "settings.json")
    except Exception:
        return _check("hooks", True, "Every hook's program is on this computer.")
    missing = []
    for hook in _command_hooks(settings):
        program = _program(hook)
        if program is not None and program not in missing and _is_missing(program):
            missing.append(program)
    if missing:
        return _check("hooks", False,
                      "Some hooks start a program this computer does not have: %s. "
                      "Those hooks fail on every call." % ", ".join(missing),
                      FIX["hooks"])
    return _check("hooks", True, "Every hook's program is on this computer.")


# An empty list, an empty string and YAML's null forms list no path.
_EMPTY_YAML = re.compile(r"\[[ \t]*\]|\"\"|''|~|null|Null|NULL")


def _is_path_scoped(text):
    lines = re.split(r"\r\n|\r|\n", text[1:] if text.startswith("﻿") else text)
    # Front matter that never closes is no front matter, so the whole file loads.
    if lines[0] != "---" or "---" not in lines[1:]:
        return False
    for i in range(1, len(lines)):
        if lines[i] == "---":
            return False
        if not lines[i].startswith("paths:"):
            continue
        rest = lines[i][len("paths:"):]
        comment = re.search(r"(^|[ \t])#", rest)
        inline = (rest[:comment.start()] if comment else rest).strip(JS_WHITESPACE)
        if inline:
            return not _EMPTY_YAML.fullmatch(inline)
        following = [line for line in lines[i + 1:]
                     if line.strip(JS_WHITESPACE) and not line.strip(JS_WHITESPACE).startswith("#")]
        return (following[0] if following else "").strip(JS_WHITESPACE).startswith("- ")
    return False


def _file_id(path):
    try:
        stat = os.stat(path)
        # A disk that numbers no files reports inode 0, so there its canonical path stands in.
        if stat.st_ino == 0:
            return "path:" + os.path.realpath(path)
        return "%d:%d" % (stat.st_dev, stat.st_ino)
    except OSError:
        return None


def _read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as handle:
            return handle.read()
    except OSError:
        return None


def _markdown_files(folder, prefix="", seen=None):
    seen = set() if seen is None else seen
    id_ = _file_id(folder)
    if id_ is None or id_ in seen:
        return []
    seen.add(id_)
    try:
        names = sorted(os.listdir(folder), key=_code_units)
    except OSError:
        return []
    out = []
    for name in names:
        path = os.path.join(folder, name)
        if os.path.isdir(path):
            out += _markdown_files(path, prefix + name + "/", seen)
        elif os.path.isfile(path) and name.endswith(".md"):
            out.append((prefix + name, path))
    return out


def _units(text):
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _start_files(root, config):
    out = []

    counted = set()

    def add(name, path, rule=None, personal=False):
        id_ = _file_id(path)
        text = None if id_ is None or id_ in counted else _read_text(path)
        if text is None or (rule and _is_path_scoped(text)):
            return
        counted.add(id_)
        out.append(("a rule in ~/.claude/rules" if rule == "personal" else name,
                    _units(text), personal))
    for name in ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"):
        add(name, os.path.join(root, *name.split("/")))
    add("~/.claude/CLAUDE.md", os.path.join(config, "CLAUDE.md"), personal=True)
    for name, path in _markdown_files(os.path.join(config, "rules")):
        add(name, path, "personal", personal=True)
    for name, path in _markdown_files(os.path.join(root, ".claude", "rules")):
        add(".claude/rules/" + name, path, "repo")
    return out


def _kilo(n):
    return "%d.%dk" % (n // 1000, n % 1000 // 100)


def _instructions_check(root, config):
    files = _start_files(root, config)
    total = sum(size for _, size, _ in files)
    personal = sum(size for _, size, from_personal in files if from_personal)
    largest = sorted(files, key=lambda item: (-item[1], _code_units(item[0])))[:3]
    listed = ", ".join("%s (%s)" % (name, _kilo(size)) for name, size, _ in largest) or "none"
    say = ("Claude Code loads %d instruction files at session start, %s characters of its %s limit. "
           "%s of it from this repo and %s from ~/.claude. The largest: %s."
           % (len(files), _kilo(total), _kilo(INSTRUCTIONS_LIMIT),
              _kilo(total - personal), _kilo(personal), listed))
    if total < INSTRUCTIONS_WARN_AT:
        return _check("instructions", True, say)
    return _check("instructions", False, say, FIX["instructions"])


def run_doctor(root, config, plugin_version, cli_version):
    """See runDoctor in doctor.js."""
    state = _state_checks(root)
    checks = list(state["checks"]) + [_hooks_check(config)]
    if "answers" in state:
        checks += [_version_check(state["pristine"], plugin_version),
                   _guard_check(root, state["answers"], state["pristine"])]
        checks += [_staged_check(root), _instructions_check(root, config)]
        if state["answers"]["advanced"]["tracker"] == "file":
            checks.append(_roadmap_check(root))
        settings = _settings_checks(root, config)
        guards = _has_guards(state["answers"], state["pristine"], settings["installed"])
        checks += settings["checks"] + [_cli_check(settings["installed"], cli_version, guards)]
    return {"problems": sum(1 for c in checks if not c["ok"]), "checks": checks}
