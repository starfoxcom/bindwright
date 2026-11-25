"""What GitHub refuses on the writes the review gate makes, for test fakes.

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


def _status(body):
    if body.get("state") not in STATUS_STATES:
        return "state must be one of %s" % sorted(STATUS_STATES)
    if not isinstance(body.get("context"), str) or not body["context"]:
        return "context is required"
    description = body.get("description")
    if description is None:
        return None
    if len(description) > DESCRIPTION_MAX:
        return "Description is too long (maximum is %d characters)" % DESCRIPTION_MAX
    if any(ord(c) > 0xFFFF for c in description):
        return "Description doesn't accept 4-byte Unicode"
    return None


def _check_run(body, create):
    if create and (not body.get("name") or not re.fullmatch(r"[0-9a-f]{40}", body.get("head_sha", ""))):
        return "name and a 40-character head_sha are required"
    if body.get("status", "queued") not in CHECK_STATUSES:
        return "status must be one of %s" % sorted(CHECK_STATUSES)
    conclusion = body.get("conclusion")
    if conclusion is not None and conclusion not in CHECK_CONCLUSIONS:
        return "conclusion must be one of %s" % sorted(CHECK_CONCLUSIONS)
    if body.get("status") == "completed" and conclusion is None:
        return "conclusion is required when status is completed"
    output = body.get("output")
    if output is not None:
        if not output.get("title") or not output.get("summary"):
            return "output needs a title and a summary"
        if len(output["summary"]) > SUMMARY_MAX:
            return "output summary is too long (maximum is %d characters)" % SUMMARY_MAX
    return None


WRITES = [
    ("POST", r"repos/[^/]+/[^/]+/statuses/[0-9a-f]{40}", _status),
    ("POST", r"repos/[^/]+/[^/]+/check-runs", lambda body: _check_run(body, True)),
    ("PATCH", r"repos/[^/]+/[^/]+/check-runs/\d+", lambda body: _check_run(body, False)),
]


def refusal(method, path, body):
    """GitHub's reason for refusing this write, or None when it would take it."""
    for verb, pattern, rule in WRITES:
        if method == verb and re.fullmatch(pattern, path):
            return rule(body or {})
    return "no rule for %s %s: add GitHub's limits for it to tools/github_writes.py" % (method, path)
