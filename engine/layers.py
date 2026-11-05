# Python twin of layers.js: the three settings layers, resolved the same way
# and reported in the same words and order. Standard library only.

import json
import os
import re

from model import CODE_RESEARCH_TOOLS, TRACKERS, map_removed_tool
from setupcode import MAX_DEPTH, _depth, _not_json
from update import ANSWERS, _code_units

SCHEMA = 1
LOCAL = ".bindwright/local.json"
PERSONAL = "bindwright/settings.json"

# The extras setup offers for ~/.claude, each with the file under the config
# folder that shows it is installed. A mod's file is its folder under mods/.
EXTRA_FILES = {
    "attribution-guard": "hooks/no-ai-attribution.py",
    "builder": "agents/builder.md",
    "code-style": "rules/code-style.md",
    "global-instructions": "CLAUDE.md",
    "push-guard": "hooks/push-guard.py",
}
# An extra whose file is the person's own (CLAUDE.md) counts as installed only
# when that file holds its marker on a line of its own, spaces and tabs aside.
MARKERS = {
    "global-instructions": "<!-- bindwright:global-instructions -->",
}
MODS = [
    "ci-watch", "compact-handoff", "mods", "runners", "session-facts",
    "session-info", "shared-pc", "skill-check", "tasks", "usage-guard",
]
EXTRAS = sorted(list(EXTRA_FILES) + MODS, key=_code_units)
LEVELS = ["required", "recommended"]


def _text(v):
    return isinstance(v, str)


SETTINGS = {
    "codeResearch": lambda v: _text(v) and v in CODE_RESEARCH_TOOLS,
    "tracker": lambda v: _text(v) and v in TRACKERS,
}


def _personal_only_bad(key, value):
    # The custom tool needs the name and URL only the project's answers carry.
    return key == "codeResearch" and value == "custom"


def _sorted_keys(obj):
    return sorted(obj, key=_code_units)


def _check_schema(schema, file):
    # Only called when the key is there: an absent schema means the first one.
    number = isinstance(schema, (int, float)) and not isinstance(schema, bool)
    if not number or schema != schema or schema in (float("inf"), float("-inf")) or schema != int(schema) or schema < 1:
        raise ValueError("%s has no valid schema number" % file)
    if schema > SCHEMA:
        raise ValueError("%s was written by a newer Bindwright: update the plugin" % file)


def _read_extras(extras, name, is_valid, ignored):
    out = {}
    if not isinstance(extras, dict):
        ignored.append("%s: extras" % name)
        return out
    for extra in _sorted_keys(extras):
        if extra in EXTRAS and is_valid(extras[extra]):
            out[extra] = extras[extra]
        else:
            ignored.append("%s: extras.%s" % (name, extra))
    return out


def _layer():
    return {"settings": {}, "extras": {}, "required": [], "ignored": []}


def _read_personal(raw, name, file):
    layer = _layer()
    if raw is None:
        return layer
    if not isinstance(raw, dict):
        raise ValueError("%s must hold a JSON object" % file)
    if "schema" in raw:
        _check_schema(raw["schema"], file)
    for key in _sorted_keys(raw):
        value = raw[key]
        if key == "schema":
            continue
        if key == "extras":
            layer["extras"] = _read_extras(value, name, lambda v: isinstance(v, bool), layer["ignored"])
        elif key in SETTINGS and SETTINGS[key](value) and not _personal_only_bad(key, value):
            layer["settings"][key] = value
        else:
            layer["ignored"].append("%s: %s" % (name, key))
    return layer


def _read_project(answers):
    layer = _layer()
    if answers is None:
        return layer
    if not isinstance(answers, dict):
        raise ValueError("%s must hold a JSON object" % ANSWERS)
    # A removed tool reads as custom, as expand_answers reads a saved answers file.
    advanced = answers.get("advanced")
    advanced = map_removed_tool(advanced if isinstance(advanced, dict) else {})
    for key in SETTINGS:
        if key in advanced and SETTINGS[key](advanced[key]):
            layer["settings"][key] = advanced[key]
    if "setup" not in answers:
        return layer
    setup = answers["setup"]
    if not isinstance(setup, dict):
        layer["ignored"].append("project: setup")
        return layer
    if "schema" in setup:
        _check_schema(setup["schema"], "%s (setup)" % ANSWERS)
    for key in _sorted_keys(setup):
        value = setup[key]
        if key == "schema":
            continue
        if key == "extras":
            layer["extras"] = _read_extras(value, "project", lambda v: _text(v) and v in LEVELS, layer["ignored"])
        elif key == "required" and isinstance(value, list):
            for item in value:
                if _text(item) and item in SETTINGS and item in layer["settings"]:
                    layer["required"].append(item)
                else:
                    layer["ignored"].append("project: required.%s" % item if _text(item) else "project: required")
        else:
            layer["ignored"].append("project: setup.%s" % key)
    return layer


def _resolve_setting(key, layers, ignored):
    project = layers["project"]
    required = key in project["required"]
    if required:
        for name in ("personal", "local"):
            value = layers[name]["settings"].get(key)
            if key in layers[name]["settings"] and value != project["settings"][key]:
                ignored.append("%s: %s (the project requires it)" % (name, key))
        return {"value": project["settings"][key], "from": "project", "required": required}
    for name in ("local", "project", "personal"):
        if key in layers[name]["settings"]:
            return {"value": layers[name]["settings"][key], "from": name, "required": required}
    return None


def _resolve_extra(extra, layers, ignored):
    level = layers["project"]["extras"].get(extra)
    if level == "required":
        for name in ("personal", "local"):
            if layers[name]["extras"].get(extra) is False:
                ignored.append("%s: extras.%s (the project requires it)" % (name, extra))
        return {"project": level, "want": True, "from": "project"}
    for name in ("local", "personal"):
        if extra in layers[name]["extras"]:
            return {"project": level, "want": layers[name]["extras"][extra], "from": name}
    return None if level is None else {"project": level, "want": None, "from": None}


def resolve_layers(personal=None, project=None, local=None):
    """See resolveLayers in layers.js."""
    layers = {
        "personal": _read_personal(personal, "personal", PERSONAL),
        "project": _read_project(project),
        "local": _read_personal(local, "local", LOCAL),
    }
    ignored = layers["personal"]["ignored"] + layers["project"]["ignored"] + layers["local"]["ignored"]
    settings = {}
    for key in SETTINGS:
        resolved = _resolve_setting(key, layers, ignored)
        if resolved:
            settings[key] = resolved
    extras = {}
    for extra in EXTRAS:
        resolved = _resolve_extra(extra, layers, ignored)
        if resolved:
            extras[extra] = resolved
    return {"settings": settings, "extras": extras, "ignored": ignored}


def _has_marker(path, marker):
    # Whether the file holds the marker on a line of its own. A file that cannot
    # be read as UTF-8, or cannot be read at all, does not hold it.
    try:
        with open(path, "rb") as f:
            text = f.read().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return any(line.strip(" \t\r") == marker for line in text.split("\n"))


def installed_extras(config):
    def at(extra):
        return EXTRA_FILES.get(extra, "mods/" + extra)

    def present(extra):
        path = os.path.join(config, *at(extra).split("/"))
        if extra in MARKERS:
            return _has_marker(path, MARKERS[extra])
        return os.path.exists(path)
    return {extra: present(extra) for extra in EXTRAS}


def _read_layer_text(path, file):
    # A settings file's text, or None when it is missing.
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("%s is not UTF-8 text" % file)


def _parse_layer_text(text, file, keep_ints=False):
    # keep_ints: for a file written back, where 5 must stay 5, as JSON.stringify writes it.
    if _depth(text) > MAX_DEPTH:
        raise ValueError("%s nests too deeply" % file)
    try:
        # NaN and Infinity are not JSON, and JSON.parse refuses them. Whole numbers
        # are read as doubles, as JSON.parse reads them: past the double range they
        # become infinite, with no digit limit, in both engines.
        return json.loads(text, parse_constant=_not_json, parse_int=None if keep_ints else float)
    except ValueError:
        raise ValueError("%s is not valid JSON" % file)


def _read_layer_file(path, file, keep_ints=False):
    text = _read_layer_text(path, file)
    return None if text is None else _parse_layer_text(text, file, keep_ints)


# Refuses a project.json that the two engines would rewrite differently; layers.js says why.
_JSON_TOKEN = re.compile(r'("(?:[^"\\]|\\.)*")(\s*:)?|(-?[0-9][-+.eE0-9]*)')
_PLAIN_INTEGER = re.compile(r"0|-?[1-9][0-9]{0,14}")
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")


def _unstable(what):
    return ValueError("%s holds %s that the two engines would write differently; "
                      "edit it by hand first" % (ANSWERS, what))


def refuse_unstable_json(text):
    for match in _JSON_TOKEN.finditer(text):
        quoted, colon, number = match.group(1), match.group(2), match.group(3)
        if number is not None and not _PLAIN_INTEGER.fullmatch(number):
            raise _unstable("the number %s" % number)
        if colon is None:
            continue
        key = json.loads(quoted)
        if _ARRAY_INDEX.fullmatch(key):
            raise _unstable('the key "%s"' % key)


def run_settings(root, config):
    """See runSettings in layers.js."""
    def at(path):
        return os.path.join(root, *path.split("/"))
    resolved = resolve_layers(
        personal=_read_layer_file(os.path.join(config, *PERSONAL.split("/")), PERSONAL),
        project=_read_layer_file(at(ANSWERS), ANSWERS),
        local=_read_layer_file(at(LOCAL), LOCAL),
    )
    installed = installed_extras(config)
    drift = [extra for extra, e in resolved["extras"].items()
             if e["project"] is not None and e["want"] is not False and not installed[extra]]
    resolved.update({"installed": installed, "drift": drift})
    return resolved
