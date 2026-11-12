# Python twin of model.js: the answer model and everything derived from it.
# Keep the two in step; test/golden.test.js fails when their binds differ.
# Standard library only, Python 3.8+.

import datetime
import re

# The pins this repo's own review workflows run on. The routine and deep
# models must be ones the pinned claude-code-action accepts; the backup runs
# on the CLI_VERSION the workflow templates install, so it must be one that
# version accepts. Change them together with those pins, never on their own.
REVIEW_MODELS = {"routine": "claude-fable-5-2", "deep": "claude-fable-5-2", "backup": "claude-opus-5-5"}
REVIEW_EFFORTS = {"routine": "low", "deep": "medium", "backup": "high"}

CODE_RESEARCH_TOOLS = {
    # match: regex over tool-call names, used by the close-session adherence count.
    "findwright": {
        "name": "FindWright",
        "url": "https://github.com/starfoxcom/findwright",
        "bypass": "FINDWRIGHT_BYPASS:",
        "match": "findwright",
    },
    "none": {"name": "none", "url": "(no homepage)", "bypass": None, "match": None},
    # A tool the person names: values_for fills all four from codeResearchCustom.
    "custom": {"name": None, "url": None, "bypass": None, "match": None},
}
# Tools no longer offered. An answers file saved while one was offered is read
# as a custom tool with its old name and homepage (expand_answers).
REMOVED_CODE_RESEARCH_TOOLS = {
    "tokensave": {"name": "tokensave", "url": "https://github.com/aovestdipaperino/tokensave"},
    "lsp-plugins": {"name": "Claude Code LSP plugins", "url": "https://code.claude.com/docs/en/discover-plugins"},
    "codegraph": {"name": "CodeGraph", "url": "https://github.com/colbymchenry/codegraph"},
    "serena": {"name": "Serena", "url": "https://github.com/oraios/serena"},
    "codebase-memory": {"name": "codebase-memory-mcp", "url": "https://github.com/DeusData/codebase-memory-mcp"},
}
# How setup installs each tool lives in _core/global-template/hooks/code-research-profiles.json.

# The custom tool's name lands in Markdown, a Python string and a regex; its
# URL in Markdown and a hook comment. Both are plain ASCII, so the two twins
# count the same length; quotes, backslashes, spaces and control characters
# in the URL are refused rather than escaped.
CUSTOM_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._+-]{0,38}[A-Za-z0-9._+-])?")
CUSTOM_URL = re.compile(r"https://[^\x00-\x20\x7f-\U0010ffff\"'`<>\\]{1,200}")

PRECOMMIT_MANAGERS = ["lefthook", "husky", "pre-commit", "simple-git-hooks"]
# Merge commits by default: every branch stays visible in the history graph.
MERGE_STYLES = ["merge", "squash", "rebase"]
ARCHITECTURES = ["none", "clean", "ddd", "ecs", "feature-based", "hexagonal", "layered", "mvc"]
# Where the guard hooks live: shipped in the repo (teammates and cloud
# sessions get them), or only in each person's ~/.claude (global-template).
HOOK_LOCATIONS = ["repo", "home"]
# How much the committed deny list blocks. "standard" stops force pushes,
# direct pushes to the protected branches, interactive rebase and admin
# merges; "strict" also stops local history wipes and destructive gh calls.
DENY_PROFILES = ["standard", "strict"]
# Where the work state lives between sessions: GitHub issues (with a Projects
# board when trackerProject names one), or the repo's hand-off file and
# ROADMAP.md.
TRACKERS = ["github", "file"]
# Where the code lives: on GitHub, only on this computer (no account), or on
# another host. "local" and "other" leave out every GitHub-only file.
CODE_HOSTS = ["github", "local", "other"]
# "<owner>/<number>" of a GitHub Projects board. The owner lands in gh
# command lines, so it is held to GitHub's own name rule.
TRACKER_PROJECT = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[1-9][0-9]{0,5}")
# "<owner>/<repo>" of a GitHub repo, such as the public roadmap or the private
# tracker repo; the repo part follows GitHub's rule.
GITHUB_REPO = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/(?!\.+$)[A-Za-z0-9._-]{1,100}")
# A GitHub user, or "<org>/<team>" for a team.
PR_REVIEWER = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}(/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})?")
LICENSES = {
    "MIT": "MIT.txt",
    "Apache-2.0": "Apache-2.0.txt",
    "BSD-3-Clause": "BSD-3-Clause.txt",
    "Proprietary": "Proprietary.txt",
}

# Filled later by the tailoring step, which reads the user's repo.
DEFERRED = {
    "ONE_LINE_DESCRIPTION", "LANGUAGE_AND_FRAMEWORK", "CONVERSATION_LANGUAGE", "CODE_LANGUAGE",
    "LINT_COMMAND", "TYPECHECK_COMMAND", "TEST_COMMAND", "STACK_COMMANDS_ALLOWLIST",
    "LEAD_USER", "TEAM_OR_USER",
}

# What JavaScript's trim() and trimEnd() remove. str.strip() alone differs
# (it keeps U+FEFF and removes U+0085 and U+001C-U+001F).
JS_WHITESPACE = (
    "\t\n\v\f\r           "
    "       　﻿"
)

# Stands in for JavaScript's undefined when an answer is missing.
UNDEFINED = object()


def js_str(v):
    """String(v) as JavaScript writes it, for error messages that match model.js."""
    if v is UNDEFINED:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)
    if isinstance(v, list):
        return ",".join("" if e is None or e is UNDEFINED else js_str(e) for e in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)

QUOTE_MAX = 40


def quoted(value):
    """An untrusted value as a message quotes it, the same text as model.js quoted:
    at most QUOTE_MAX code points, then an ellipsis, with quotes, backslashes,
    control characters, line separators and lone surrogates escaped."""
    points = js_str(value)

    def shown(ch):
        code = ord(ch)
        if ch in '"\\':
            return "\\" + ch
        unsafe = code < 0x20 or 0x7f <= code <= 0x9f or code in (0x2028, 0x2029) or 0xd800 <= code <= 0xdfff
        return "\\u%04x" % code if unsafe else ch

    return '"%s%s"' % ("".join(shown(ch) for ch in points[:QUOTE_MAX]), "…" if len(points) > QUOTE_MAX else "")


def utf16_len(s):
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def defaults(team=False, client=False, private=None):
    # None means the same as client, as answers saved before the question read.
    if private is None:
        private = client
    return {
        "team": team, "client": client, "private": private,
        "project": {
            "name": "my-project", "repoUrl": "", "licenseHolder": "",
            "license": "Proprietary" if client or private else "MIT",
        },
        "advanced": {
            "aiReview": True,
            "deepEscalation": True,
            "precommit": "lefthook" if team else "none",
            "uiRule": True,
            "confidentiality": client and private,
            "cleanRoom": False,
            "plainWriting": True,
            "codeResearch": "none",
            # {"name", "url"} when codeResearch is "custom"; None otherwise.
            "codeResearchCustom": None,
            "branching": "gitflow",
            "devIsDefault": False,
            "mergeStyle": "merge",
            "architecture": "none",
            "hookLocation": "repo",
            "attributionGuard": True,
            "denyProfile": "standard",
            # Files the writing rule checks. None keeps the rule's own list.
            "shippedTextPaths": None,
            # Add-on: a CI check that fails on any new code-size breach.
            "codeSizeCheck": True,
            # "github" keeps the GitHub parts; "local" and "other" have no GitHub, so no
            # Actions, no board and no GitHub-hosted tracker (_check_code_host).
            "codeHost": "github",
            # False: the code is on GitHub, but its organization blocks GitHub apps, Actions
            # and project boards, so no AI review, no workflow and no board (_check_code_host).
            "githubApps": True,
            # True: the assistant's files (CLAUDE.md, .claude/, .bindwright/ and the like) stay on
            # this computer, listed in the clone's .git/info/exclude, and never reach a commit.
            "localOnly": False,
            "tracker": "github",
            # "<owner>/<number>" when tracker is "github" and the project has a
            # board; None keeps project status in a pinned issue instead.
            "trackerProject": None,
            # "<owner>/<repo>" of a private repo that holds the issues when they should not
            # live in the code repo (github tracker only); None keeps them in this repo.
            "trackerRepo": None,
            "publicRoadmap": None,
            "handoffFile": True,
            # GitHub names (user or org/team) asked on each PR that needs approval; null if none.
            "prReviewers": None,
            # True runs two local reviewer subagents before each merge, for a project
            # with no AI review in CI, and posts nothing to the host.
            "localReview": False,
        },
    }


class AnswerError(ValueError):
    pass


def _check(cond, msg):
    if not cond:
        raise AnswerError("Invalid answers: " + msg)


def _is_bool(v):
    return type(v) is bool


def _own(obj, key):
    return isinstance(key, str) and key in obj


def _glob_ok(g):
    return (isinstance(g, str) and 1 <= utf16_len(g) <= 200
            and not any(c in '"\\' or ord(c) <= 0x1F or ord(c) == 0x7F for c in g)
            and g.strip(JS_WHITESPACE) == g)


def _check_custom_tool(tool, custom):
    if tool == "custom":
        name = custom.get("name", UNDEFINED) if isinstance(custom, dict) else UNDEFINED
        url = custom.get("url", UNDEFINED) if isinstance(custom, dict) else UNDEFINED
        _check(isinstance(name, str) and CUSTOM_NAME.fullmatch(name) is not None
               and len(re.sub(r"[^A-Za-z0-9]", "", name)) >= 3
               and isinstance(url, str) and CUSTOM_URL.fullmatch(url) is not None,
               "codeResearchCustom needs a name (up to 40 letters, digits, spaces, dot, plus, dash or underscore, "
               "with at least three letters or digits, starting with a letter or digit, not ending in a space) "
               "and an https:// url of plain ASCII without spaces or quotes")
    else:
        _check(custom is None or custom is UNDEFINED, 'codeResearchCustom is only for codeResearch "custom"')


def validate(saved):
    # Setup codes carry answers from outside the page, so the shape comes first.
    has_parts = (isinstance(saved, dict) and isinstance(saved.get("project"), dict)
                 and isinstance(saved.get("advanced"), dict))
    _check(has_parts, "the answers must hold project and advanced objects")
    # Answers saved before the private question existed count as private = client.
    a = dict(saved)
    if "private" not in a:
        a["private"] = a.get("client", UNDEFINED)
    adv = a["advanced"]
    project = a["project"]
    get = lambda d, k: d.get(k, UNDEFINED)
    _check(_is_bool(get(a, "team")) and _is_bool(get(a, "client")), "team and client must be true or false")
    _check(_is_bool(get(a, "private")), "private must be true or false")
    switches = ["aiReview", "deepEscalation", "uiRule", "confidentiality", "cleanRoom",
                "plainWriting", "codeSizeCheck", "handoffFile", "githubApps", "localReview", "localOnly"]
    for key in switches:
        _check(_is_bool(get(adv, key)), key + " must be true or false")
    name = get(project, "name")
    _check(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) is not None,
           "project name must be 1-64 letters, digits, dot, dash or underscore")
    _check(isinstance(get(project, "repoUrl"), str) and isinstance(get(project, "licenseHolder"), str),
           "repoUrl and licenseHolder must be text")
    _check(_own(LICENSES, get(project, "license")), 'unknown license %s' % quoted(get(project, "license")))
    _check(_own(CODE_RESEARCH_TOOLS, get(adv, "codeResearch")),
           'unknown code-research tool %s' % quoted(get(adv, "codeResearch")))
    _check_custom_tool(adv["codeResearch"], get(adv, "codeResearchCustom"))
    precommit = get(adv, "precommit")
    _check(precommit == "none" or (isinstance(precommit, str) and precommit in PRECOMMIT_MANAGERS),
           'unknown pre-commit manager %s' % quoted(precommit))
    _check(isinstance(get(adv, "architecture"), str) and adv["architecture"] in ARCHITECTURES,
           'unknown architecture %s' % quoted(get(adv, "architecture")))
    _check(isinstance(get(adv, "branching"), str) and adv["branching"] in ["gitflow", "trunk"],
           'unknown branching model %s' % quoted(get(adv, "branching")))
    _check(isinstance(get(adv, "mergeStyle"), str) and adv["mergeStyle"] in MERGE_STYLES,
           'unknown merge style %s' % quoted(get(adv, "mergeStyle")))
    _check(_is_bool(get(adv, "devIsDefault")), "devIsDefault must be true or false")
    _check(isinstance(get(adv, "hookLocation"), str) and adv["hookLocation"] in HOOK_LOCATIONS,
           'unknown hook location %s' % quoted(get(adv, "hookLocation")))
    _check(_is_bool(get(adv, "attributionGuard")), "attributionGuard must be true or false")
    _check(isinstance(get(adv, "denyProfile"), str) and adv["denyProfile"] in DENY_PROFILES,
           'unknown deny profile %s' % quoted(get(adv, "denyProfile")))
    # Each glob lands in a double-quoted YAML string, so quotes, backslashes
    # and control characters are refused rather than escaped.
    paths = get(adv, "shippedTextPaths")
    _check(paths is None or (isinstance(paths, list) and len(paths) > 0 and all(_glob_ok(g) for g in paths)),
           "shippedTextPaths must be null or a non-empty list of globs "
           "without quotes, backslashes, line breaks or outer spaces")
    _check_code_host(adv)
    _check_local_review(adv)
    _check(not (a["team"] and adv["codeHost"] == "local"),
           'codeHost "local" is one person on one computer: team must be false')
    _check_pr_reviewers(adv)
    _check_tracker(get(adv, "tracker"), get(adv, "trackerProject"))
    _check_repos(get(adv, "tracker"), get(adv, "publicRoadmap"), get(adv, "trackerRepo"))
    return a


def _check_repos(tracker, public, tracker_repo):
    if tracker != "github":
        _check(public is None or public is UNDEFINED, 'publicRoadmap is only for tracker "github"')
        _check(tracker_repo is None or tracker_repo is UNDEFINED, 'trackerRepo is only for tracker "github"')
        return
    _check(public is None or (isinstance(public, str) and GITHUB_REPO.fullmatch(public) is not None),
           'publicRoadmap must be null or "<owner>/<repo>": the public repo that mirrors the roadmap')
    _check(tracker_repo is None
           or (isinstance(tracker_repo, str) and GITHUB_REPO.fullmatch(tracker_repo) is not None),
           'trackerRepo must be null or "<owner>/<repo>": the private repo that holds the issues')
    same_as_public = (isinstance(tracker_repo, str) and isinstance(public, str)
                      and tracker_repo.lower() == public.lower())
    _check(not same_as_public,
           "trackerRepo must not name the publicRoadmap repo: private items would reach the public mirror")


def _check_tracker(tracker, board):
    _check(isinstance(tracker, str) and tracker in TRACKERS, 'unknown tracker %s' % quoted(tracker))
    if tracker == "github":
        _check(board is None or (isinstance(board, str) and TRACKER_PROJECT.fullmatch(board) is not None),
               'trackerProject must be null or "<owner>/<number>": '
               'a GitHub user or organization name and the board\'s number')
    else:
        _check(board is None or board is UNDEFINED, 'trackerProject is only for tracker "github"')


def _unset(value):
    return value is None or value is UNDEFINED


def _check_code_host(adv):
    host = adv.get("codeHost", UNDEFINED)
    _check(isinstance(host, str) and host in CODE_HOSTS, 'unknown code host %s' % quoted(host))
    if host == "github":
        if adv["githubApps"]:
            return
        blocked = "githubApps false blocks GitHub apps, Actions and boards"
        _check(adv["aiReview"] is False, blocked + ": aiReview must be false")
        _check(adv["deepEscalation"] is False, blocked + ": deepEscalation must be false")
        _check(_unset(adv.get("trackerProject", UNDEFINED)), blocked + ": trackerProject must be null")
        return
    _check(adv["githubApps"] is True, 'githubApps is only for codeHost "github": it must be true')
    label = 'codeHost "%s"' % host
    _check(adv["aiReview"] is False, label + " has no GitHub Actions: aiReview must be false")
    _check(adv["deepEscalation"] is False, label + " has no GitHub Actions: deepEscalation must be false")
    _check(adv.get("tracker", UNDEFINED) == "file", label + ' keeps the work state in files: tracker must be "file"')
    _check(_unset(adv.get("trackerProject", UNDEFINED)),
           label + " has no GitHub Projects board: trackerProject must be null")
    _check(_unset(adv.get("trackerRepo", UNDEFINED)), label + " has no GitHub issues repo: trackerRepo must be null")
    _check(_unset(adv.get("publicRoadmap", UNDEFINED)),
           label + " has no GitHub public roadmap: publicRoadmap must be null")


def _check_pr_reviewers(adv):
    reviewers = adv.get("prReviewers", UNDEFINED)
    if reviewers is None:
        return
    _check(isinstance(reviewers, list) and 1 <= len(reviewers) <= 10
           and all(isinstance(name, str) and PR_REVIEWER.fullmatch(name) is not None
                   for name in reviewers)
           and len(set(reviewers)) == len(reviewers),
           'prReviewers must be null or 1-10 GitHub names ("user" or "org/team")')
    _check(adv.get("codeHost") == "github", 'prReviewers is for codeHost "github"')


def _check_local_review(adv):
    if not adv.get("localReview"):
        return
    _check(adv.get("aiReview") is False, "localReview is for projects without CI reviews: aiReview must be false")
    host = adv.get("codeHost")
    without_actions = host == "other" or (host == "github" and adv.get("githubApps") is False)
    _check(without_actions, 'localReview needs codeHost "other", or "github" with githubApps false')


def _given(d, key):
    """d[key] as JavaScript reads it: a missing key counts as its default."""
    return False if d.get(key, UNDEFINED) is UNDEFINED else d[key]


def _fill_keys(part, dflt):
    """The keys of part plus each default key it lacks. A part that is not an
    object is returned as it is, so validate reports it."""
    if part is UNDEFINED:
        return dflt
    if not isinstance(part, dict) or all(key in part for key in dflt):
        return part
    keys = list(dflt) + [key for key in part if key not in dflt]
    return {key: part[key] if key in part else dflt[key] for key in keys}


def expand_answers(saved):
    """Fills the project and advanced keys a setup code leaves out with the
    defaults for its three answers. Full answers come back unchanged."""
    if not isinstance(saved, dict):
        return saved
    a = dict(saved)
    if "private" not in a:
        a["private"] = a.get("client", UNDEFINED)
    base = defaults(team=_given(a, "team"), client=_given(a, "client"),
                    private=_given(a, "private"))
    project, advanced = a.pop("project", UNDEFINED), a.pop("advanced", UNDEFINED)
    return dict(a, project=_fill_keys(project, base["project"]),
                advanced=map_removed_tool(_fill_keys(advanced, base["advanced"])))


# Removed tools that installed a search hook of their own: one kept as a custom tool gets no Bindwright hook beside it.
REMOVED_TOOLS_WITH_OWN_HOOK = ["tokensave"]


def brings_own_hook(advanced):
    """Whether the answers keep a removed tool that brings its own search hook."""
    custom = advanced.get("codeResearchCustom") if isinstance(advanced, dict) else None
    name = custom.get("name") if isinstance(custom, dict) else None
    return (isinstance(advanced, dict) and advanced.get("codeResearch") == "custom"
            and any(REMOVED_CODE_RESEARCH_TOOLS[k]["name"] == name for k in REMOVED_TOOLS_WITH_OWN_HOOK))


def map_removed_tool(advanced):
    """An answers file saved while a tool was offered reads as a custom tool
    with that tool's old name and homepage."""
    code_research = advanced.get("codeResearch") if isinstance(advanced, dict) else None
    if not isinstance(code_research, str) or code_research not in REMOVED_CODE_RESEARCH_TOOLS:
        return advanced
    return dict(advanced, codeResearch="custom",
                codeResearchCustom=dict(REMOVED_CODE_RESEARCH_TOOLS[code_research]))


# Every toggle name the templates use must resolve here to True or False.
def flags_for(a):
    adv = a["advanced"]
    solo_own = not a["team"] and not a["client"]
    return {
        "github_actions_routine_review": adv["aiReview"],
        "github_actions_deep_review": adv["aiReview"],
        "github_actions_deep_review_auto_fire": adv["aiReview"] and adv["deepEscalation"],
        "github_actions_paths_ignore_auto_merge": adv["aiReview"] and solo_own,
        "code_research_first": adv["codeResearch"] != "none",
        "precommit_hooks_scaffold": adv["precommit"] != "none",
        "branching_model_gitflow": adv["branching"] == "gitflow",
        "branching_model_trunk": adv["branching"] == "trunk",
        "default_branch_is_dev": adv["branching"] == "gitflow" and adv["devIsDefault"],
        "code_host_github": adv["codeHost"] == "github",
        "code_host_local": adv["codeHost"] == "local",
        "code_host_other": adv["codeHost"] == "other",
        "github_actions": adv["codeHost"] == "github" and adv["githubApps"],
        "github_no_actions": adv["codeHost"] == "github" and not adv["githubApps"],
        # A host that runs checks on each PR: GitHub Actions, or another site's pipeline.
        "ci_checks": adv["codeHost"] == "other" or (adv["codeHost"] == "github" and adv["githubApps"]),
        "guard_hooks_repo": adv["hookLocation"] == "repo",
        "attribution_guard": adv["attributionGuard"],
        "deny_list_strict": adv["denyProfile"] == "strict",
        "code_size_check": adv["codeSizeCheck"],
        "public_roadmap": adv["tracker"] == "github" and adv.get("publicRoadmap") is not None,
        "handoff_file": adv["tracker"] == "github" and adv["handoffFile"],
        "pr_reviewers": isinstance(adv["prReviewers"], list),
        "local_review": adv["localReview"],
        "assistant_files_local": adv["localOnly"],
        "contributing_md": a["team"],
        "license_file": not a["client"],
        "audit_trail_commits": a["client"] and a["private"],
        "definition_of_done_verification": True,
        "lazy_rules_folder": True,
        "memory_system": True,
    }


# Every value a template may name in a choice block. An unlisted value fails
# the render, so retired options cannot linger as dead blocks.
CHOICE_OPTIONS = {
    "code_research": list(CODE_RESEARCH_TOOLS),
    "precommit": ["none"] + PRECOMMIT_MANAGERS,
    "merge_style": MERGE_STYLES,
    "tracker": TRACKERS,
}


def choices_for(a):
    adv = a["advanced"]
    return {"code_research": adv["codeResearch"], "precommit": adv["precommit"], "merge_style": adv["mergeStyle"],
            "tracker": adv["tracker"]}


def _upper_snake(s):
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").upper()


# The custom tool's four fields, derived from the name the person gave. The
# adherence pattern matches only MCP tool calls (mcp__<server>__<tool>), so a
# name like "Grep" never counts the built-in tools, and lets each dash in the
# name also match an underscore or nothing, as servers spell names either way.
def _custom_tool(custom):
    name = custom["name"]
    kebab = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return {"name": name, "url": custom["url"], "kebab": kebab,
            "bypass": _upper_snake(name) + "_BYPASS:", "match": "^mcp__.*" + "[-_]?".join(kebab.split("-"))}


def _research_tool(adv):
    if adv["codeResearch"] == "custom":
        return _custom_tool(adv["codeResearchCustom"])
    return dict(CODE_RESEARCH_TOOLS[adv["codeResearch"]], kebab=adv["codeResearch"])


def values_for(a, year=None):
    if year is None:
        year = datetime.date.today().year
    adv = a["advanced"]
    tool = _research_tool(adv)
    gitflow = adv["branching"] == "gitflow"
    return {
        "PROJECT_NAME": a["project"]["name"],
        "PROJECT_NAME_UPPER": _upper_snake(a["project"]["name"]),
        "REPO_URL": a["project"]["repoUrl"] or "(repository URL)",
        "LICENSE_HOLDER": a["project"]["licenseHolder"] or a["project"]["name"],
        "YEAR": year,
        "MAIN_BRANCH": "main",
        "DEV_BRANCH": "develop" if gitflow else "main",
        "DEFAULT_BRANCH": "develop" if gitflow and adv["devIsDefault"] else "main",
        "GITFLOW_OR_TRUNK": "gitflow" if gitflow else "trunk",
        "REVIEW_ROUTINE_MODEL": REVIEW_MODELS["routine"],
        "REVIEW_DEEP_MODEL": REVIEW_MODELS["deep"],
        "REVIEW_BACKUP_MODEL": REVIEW_MODELS["backup"],
        "REVIEW_ROUTINE_EFFORT": REVIEW_EFFORTS["routine"],
        "REVIEW_DEEP_EFFORT": REVIEW_EFFORTS["deep"],
        "REVIEW_BACKUP_EFFORT": REVIEW_EFFORTS["backup"],
        "TOOLS_CODE_RESEARCH_NAME": tool["name"],
        "TOOLS_CODE_RESEARCH_URL": tool["url"],
        "TOOLS_CODE_RESEARCH_NAME_KEBAB": tool["kebab"],
        "TOOLS_CODE_RESEARCH_NAME_UPPER_SNAKE": _upper_snake(tool["kebab"]),
        "TOOLS_CODE_RESEARCH_BYPASS_MARKER": tool["bypass"] or "RESEARCH_BYPASS:",
        "TOOLS_CODE_RESEARCH_MATCH": tool["match"] or "(?!)",
    }
