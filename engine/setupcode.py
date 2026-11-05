# Python twin of setupcode.js: decodes a setup code from an older page, passed to
# /bindwright:setup ("bw1-" + base64url of the answers as UTF-8 JSON, no
# padding) with the same checks and messages. Standard library only.

import base64
import json
import math
import re

from model import CODE_RESEARCH_TOOLS, defaults, quoted

PREFIX = "bw1-"
# Real answers encode to about 1 KB and nest three levels deep. The caps keep
# a huge code from reaching the JSON reader, and a deep one from Python's,
# which gives up near 1000 levels where JSON.parse keeps going.
MAX_BODY = 20000
MAX_DEPTH = 64
TOO_LARGE = "it holds a number too large to read"


class SetupCodeError(ValueError):
    pass


class _NumberTooLarge(ValueError):
    pass


def _fail(msg):
    raise SetupCodeError("Invalid setup code: " + msg)


def _not_json(name):
    raise ValueError(name + " is not JSON")


def _double(text):
    """A number read as a double, as JSON.parse reads it. One past the double
    range is refused, so no number reaches the answers as infinity."""
    value = float(text)
    if math.isinf(value):
        raise _NumberTooLarge(text)
    return value


def _depth(text):
    """The deepest bracket nesting outside JSON strings."""
    depth = deepest = 0
    in_string = escaped = False
    for c in text:
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
        elif c in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif c in "]}":
            depth -= 1
    return deepest


def _refuse_unknown_keys(answers):
    """A page-made answer set holds the same keys at every team, client and
    private combination; any other key is refused. Checked on decode only, so
    saved project.json files that hold keys since dropped still load. The
    first unknown key in UTF-16 order is named, so the JS twin names the same one."""
    known = defaults()
    levels = [("answer", answers, known), ("project answer", answers.get("project"), known["project"]),
              ("advanced answer", answers.get("advanced"), known["advanced"])]
    for label, part, dflt in levels:
        if not isinstance(part, dict):
            continue
        unknown = sorted((key for key in part if key not in dflt),
                         key=lambda key: key.encode("utf-16-be", "surrogatepass"))
        if unknown:
            _fail('unknown %s %s' % (label, quoted(unknown[0])))


def _refuse_unknown_tool(answers):
    """A code names only a tool the page offers. expand_answers maps a removed
    tool only in a saved answers file, so one in a code is refused here."""
    advanced = answers.get("advanced")
    if not isinstance(advanced, dict) or "codeResearch" not in advanced:
        return
    tool = advanced["codeResearch"]
    if not isinstance(tool, str) or tool not in CODE_RESEARCH_TOOLS:
        _fail("codeResearch names a tool the page does not offer")


def _refuse_free_text(answers):
    """The page never sets free text, so a code that carries any was edited: the project
    strings must be empty and the custom tool and path values must be None."""
    project = answers.get("project")
    if isinstance(project, dict) and any(key in project and project[key] != "" for key in ("repoUrl", "licenseHolder")):
        _fail("the setup code carries a repoUrl or licenseHolder, which the page never sets")
    advanced = answers.get("advanced")
    if isinstance(advanced, dict) and any(
            advanced.get(key) is not None for key in ("codeResearchCustom", "shippedTextPaths")):
        _fail("the setup code carries custom tool or path text, which the page never sets")


def decode_setup_code(code):
    if not isinstance(code, str) or not code.startswith(PREFIX):
        _fail("it must start with " + PREFIX)
    body = code[len(PREFIX):]
    if len(body) > MAX_BODY:
        _fail("it is too long")
    if re.fullmatch(r"[A-Za-z0-9_-]+", body) is None or len(body) % 4 == 1:
        _fail("the part after the prefix is not base64url")
    raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    try:
        # utf-8-sig drops one leading byte-order mark, as TextDecoder does.
        text = raw.decode("utf-8-sig")
    except ValueError:
        _fail("it does not hold UTF-8 JSON")
    if _depth(text) > MAX_DEPTH:
        _fail("it nests too deeply")
    try:
        # NaN and Infinity are not JSON, and JSON.parse refuses them.
        answers = json.loads(text, parse_constant=_not_json, parse_int=_double, parse_float=_double)
    except _NumberTooLarge:
        _fail(TOO_LARGE)
    except ValueError:
        _fail("it does not hold UTF-8 JSON")
    if not isinstance(answers, dict):
        _fail("the answers must be an object")
    _refuse_unknown_keys(answers)
    _refuse_unknown_tool(answers)
    _refuse_free_text(answers)
    return answers
