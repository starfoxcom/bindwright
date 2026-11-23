"""Builds a project's skill-check contracts from the template's example file, for the project's
answers in .bindwright/project.json, and settles them against the copy kept per project in
skill-contracts.json under the Claude config folder. Standard library, Python 3.8+.

Every refusal is a HomeError. Writes go through _atomic_write, and only when the content changes.
"""

import json
import os
import re

from home_files import HomeError, _atomic_write, _claude
from model import expand_answers

EXAMPLE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, "_core", "global-template", "mods",
    "skill-check", "skill-contracts.example.json")
OFFERED = "_offered"
ACTIONS = ("accept", "decline")
# The answer name is everything before the first "=" or "!=", the value everything after it.
WHEN_ENTRY = re.compile(r"^([^=!]+)(!?=)(.*)$")


def _read_json_object(file, what):
    try:
        with open(file, encoding="utf-8") as handle:
            data = json.load(handle)
    except ValueError:
        raise HomeError(what + " is not valid JSON: " + file)
    if not isinstance(data, dict):
        raise HomeError(what + " is not a JSON object: " + file)
    return data


def _project_answers(root):
    file = os.path.join(root, ".bindwright", "project.json")
    if not os.path.isfile(file):
        raise HomeError("No project answers file: " + file)
    # Read as the engine binds it: defaults filled in, and a removed tool read as custom.
    advanced = expand_answers(_read_json_object(file, "The project answers file")).get("advanced")
    if not isinstance(advanced, dict):
        raise HomeError("No advanced object in " + file)
    return advanced


def _answer_text(advanced, answer):
    value = advanced.get(answer)
    if value is None:
        # A project with no code host set is on GitHub, which is what the example assumes.
        return "github" if answer == "codeHost" else ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _when_holds(entry, advanced):
    match = WHEN_ENTRY.match(entry) if isinstance(entry, str) else None
    if match is None:
        raise HomeError("Bad when entry: " + str(entry))
    answer, operator, value = match.groups()
    equal = _answer_text(advanced, answer) == value
    return equal if operator == "=" else not equal


def _step_holds(step, advanced):
    return all(_when_holds(entry, advanced) for entry in step.get("when", []))


def _without_when(step):
    return {name: value for name, value in step.items() if name != "when"}


def _steps_for(advanced):
    example = _read_json_object(EXAMPLE_FILE, "The skill contracts example")
    skills = example.get("*")
    if not isinstance(skills, dict):
        raise HomeError("No \"*\" entry in " + EXAMPLE_FILE)
    built = {}
    for skill, steps in skills.items():
        kept = [_without_when(step) for step in steps if _step_holds(step, advanced)]
        if kept:
            built[skill] = kept
    return built


def _contracts_file(home):
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or _claude(home)
    return os.path.join(config_dir, "skill-contracts.json")


def _load_contracts(file):
    if not os.path.isfile(file):
        return {}
    return _read_json_object(file, "The skill contracts file")


def _entry(data, key):
    if key not in data:
        return None
    if not isinstance(data[key], dict):
        raise HomeError("The skill contracts entry for " + key + " is not an object")
    return data[key]


def _own_steps(entry):
    return {name: steps for name, steps in entry.items() if name != OFFERED}


def _case(entry, built):
    if entry is None:
        return "missing"
    if _own_steps(entry) == built:
        return "same"
    if entry.get(OFFERED) == built:
        return "declined"
    return "differs"


def _settled(data, key, built, action):
    if action == "accept":
        return {**data, key: built}
    entry = _entry(data, key)
    own = {} if entry is None else _own_steps(entry)
    return {**data, key: {**own, OFFERED: built}}


def skill_contracts(home, root, action=None):
    if action not in (None,) + ACTIONS:
        raise HomeError("Usage: skill-contracts ROOT [accept|decline]")
    if not os.path.isdir(root):
        raise HomeError("Not a folder: " + root)
    key = os.path.basename(os.path.normpath(os.path.abspath(root))).lower()
    built = _steps_for(_project_answers(root))
    file = _contracts_file(home)
    data = _load_contracts(file)
    entry = _entry(data, key)
    case = _case(entry, built)
    if action is None:
        current = None if entry is None else _own_steps(entry)
        return {"file": file, "key": key, "case": case, "steps": built, "current": current}
    updated = _settled(data, key, built, action)
    changed = updated != data
    if changed:
        _atomic_write(file, json.dumps(updated, indent=2, ensure_ascii=False) + "\n")
    return {"file": file, "key": key, "case": case, "changed": changed}
