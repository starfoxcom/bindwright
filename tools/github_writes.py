"""What GitHub refuses on the writes the review gate and its setup script make, for test fakes.

A fake that accepts any body hides a write the real API refuses. Each rule here
was read from GitHub's REST reference or seen refused by GitHub itself, and a
write to an endpoint with no rule is refused too, so a new kind of write needs
its rule before its tests can pass.
"""

import re

STATUS_STATES = {"error", "failure", "pending", "success"}
CHECK_STATUSES = {"queued", "in_progress", "completed"}
CHECK_CONCLUSIONS = {"action_required", "cancelled", "failure", "neutral", "success", "skipped", "timed_out"}
# GitHub refuses a status description past 140 characters or holding a
# character above U+FFFF ("doesn't accept 4-byte Unicode").
DESCRIPTION_MAX = 140
# A check run's output summary holds at most 65535 characters.
SUMMARY_MAX = 65535
RULESET_ENFORCEMENTS = {"disabled", "active", "evaluate"}
RULESET_TARGETS = {"branch", "tag", "push", "repository"}
BYPASS_ACTOR_TYPES = {"Integration", "OrganizationAdmin", "RepositoryRole", "Team", "DeployKey"}
BYPASS_MODES = {"always", "pull_request", "exempt"}
RULE_TYPES = {
    "creation", "update", "deletion", "required_linear_history", "merge_queue", "required_deployments",
    "required_signatures", "pull_request", "required_status_checks", "non_fast_forward",
    "commit_message_pattern", "commit_author_email_pattern", "committer_email_pattern",
    "branch_name_pattern", "tag_name_pattern", "file_path_restriction", "max_file_path_length",
    "file_extension_restriction", "max_file_size", "workflows", "code_scanning",
}
PULL_REQUEST_REQUIRED = ("dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval",
                         "required_approving_review_count", "required_review_thread_resolution")
MERGE_METHODS = {"merge", "squash", "rebase"}
REPO_FLAGS = {"allow_merge_commit", "allow_squash_merge", "allow_rebase_merge", "delete_branch_on_merge"}
LABEL_COLOR = re.compile(r"[0-9a-fA-F]{6}")
LABEL_DESCRIPTION_MAX = 100
# Letters, digits and underscores, not starting with a digit or with GITHUB_.
SECRET_NAME = re.compile(r"(?!GITHUB_)[A-Z_][A-Z0-9_]*", re.IGNORECASE)
SECRET_VALUE_MAX = 48 * 1024
# Configuration variables take the secrets' naming rule and hold at most 48 KB each.
VARIABLE_VALUE_MAX = 48 * 1024
REPO = r"repos/[^/]+/[^/]+"


def _status(path, body):
    if body.get("state") not in STATUS_STATES:
        return "state must be one of %s" % sorted(STATUS_STATES)
    description = body.get("description")
    if description is None:
        return None
    if len(description) > DESCRIPTION_MAX:
        return "Description is too long (maximum is %d characters)" % DESCRIPTION_MAX
    if any(ord(c) > 0xFFFF for c in description):
        return "Description doesn't accept 4-byte Unicode"
    return None


def _check_run(body, create):
    if create and not ("name" in body and "head_sha" in body):
        return "name and head_sha are required"
    if body.get("status", "queued") not in CHECK_STATUSES:
        return "status must be one of %s" % sorted(CHECK_STATUSES)
    conclusion = body.get("conclusion")
    if conclusion is not None and conclusion not in CHECK_CONCLUSIONS:
        return "conclusion must be one of %s" % sorted(CHECK_CONCLUSIONS)
    if body.get("status") == "completed" and conclusion is None:
        return "conclusion is required when status is completed"
    output = body.get("output")
    if output is not None:
        if "title" not in output or "summary" not in output:
            return "output needs a title and a summary"
        if len(output["summary"]) > SUMMARY_MAX:
            return "output summary is too long (maximum is %d characters)" % SUMMARY_MAX
    return None


def _ruleset_rule(rule):
    kind = rule.get("type")
    if kind not in RULE_TYPES:
        return "rule type %r is not one GitHub knows" % kind
    parameters = rule.get("parameters") or {}
    if kind == "pull_request":
        missing = [key for key in PULL_REQUEST_REQUIRED if key not in parameters]
        if missing:
            return "a pull_request rule needs %s" % ", ".join(missing)
        methods = parameters.get("allowed_merge_methods")
        if methods is not None and (not methods or not set(methods) <= MERGE_METHODS):
            return "allowed_merge_methods needs at least one of %s" % sorted(MERGE_METHODS)
    if kind == "required_status_checks":
        if "required_status_checks" not in parameters or "strict_required_status_checks_policy" not in parameters:
            return "a required_status_checks rule needs its checks and strict_required_status_checks_policy"
        if any("context" not in check for check in parameters["required_status_checks"]):
            return "every required status check needs a context"
    return None


def _ruleset(body, create):
    if create and not ("name" in body and "enforcement" in body):
        return "name and enforcement are required"
    if body.get("enforcement", "active") not in RULESET_ENFORCEMENTS:
        return "enforcement must be one of %s" % sorted(RULESET_ENFORCEMENTS)
    if body.get("target", "branch") not in RULESET_TARGETS:
        return "target must be one of %s" % sorted(RULESET_TARGETS)
    for actor in body.get("bypass_actors") or []:
        if actor.get("actor_type") not in BYPASS_ACTOR_TYPES or actor.get("bypass_mode", "always") not in BYPASS_MODES:
            return "a bypass actor needs a known actor_type and bypass_mode"
    for rule in body.get("rules") or []:
        reason = _ruleset_rule(rule)
        if reason:
            return reason
    return None


def _repo(path, body):
    wrong = sorted(key for key in REPO_FLAGS & set(body) if not isinstance(body[key], bool))
    return "%s must be true or false" % ", ".join(wrong) if wrong else None


def _label(path, body):
    if not body.get("name"):
        return "name is required"
    if "color" in body and not LABEL_COLOR.fullmatch(body["color"]):
        return "color must be six hexadecimal digits, without a leading #"
    if len(body.get("description") or "") > LABEL_DESCRIPTION_MAX:
        return "description is too long (maximum is %d characters)" % LABEL_DESCRIPTION_MAX
    return None


def _secret(path, body):
    """The body is the plain value under "value": gh encrypts it before the call."""
    if not SECRET_NAME.fullmatch(path.rsplit("/", 1)[1]):
        return "secret names hold letters, digits and underscores, and start with neither a digit nor GITHUB_"
    if len((body.get("value") or "").encode("utf-8")) > SECRET_VALUE_MAX:
        return "a secret holds at most 48 KB"
    return None


def _variable(path, body):
    """A create names the variable in its body; an update names it in its path."""
    name = body.get("name") or path.rsplit("/", 1)[1]
    if not SECRET_NAME.fullmatch(name):
        return "variable names hold letters, digits and underscores, and start with neither a digit nor GITHUB_"
    if not isinstance(body.get("value"), str) or not body["value"]:
        return "value is required"
    if len(body["value"].encode("utf-8")) > VARIABLE_VALUE_MAX:
        return "a variable holds at most 48 KB"
    return None


WRITES = [
    ("POST", REPO + r"/statuses/[0-9a-f]{40}", _status),
    ("POST", REPO + r"/check-runs", lambda path, body: _check_run(body, True)),
    ("PATCH", REPO + r"/check-runs/\d+", lambda path, body: _check_run(body, False)),
    ("PATCH", REPO, _repo),
    ("POST", REPO + r"/rulesets", lambda path, body: _ruleset(body, True)),
    ("PUT", REPO + r"/rulesets/\d+", lambda path, body: _ruleset(body, False)),
    ("POST", REPO + r"/labels", _label),
    ("PUT", REPO + r"/actions/secrets/[^/]+", _secret),
    ("POST", REPO + r"/actions/variables", _variable),
    ("PATCH", REPO + r"/actions/variables/[^/]+", _variable),
]


def refusal(method, path, body):
    """GitHub's reason for refusing this write, or None when it would take it."""
    for verb, pattern, rule in WRITES:
        if method == verb and re.fullmatch(pattern, path):
            return rule(path, body or {})
    return "no rule for %s %s: add GitHub's limits for it to tools/github_writes.py" % (method, path)
