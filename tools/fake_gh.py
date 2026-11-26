"""A stand-in for the gh CLI that keeps a pretend repository in a JSON file,
logs every call, runs --jq filters through the real jq, and refuses every
write GitHub would refuse, any write with no rule included.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.environ["FAKE_GH_TOOLS"])
import github_writes

STATE, LOG = os.environ["FAKE_GH_STATE"], os.environ["FAKE_GH_LOG"]
VALUED = {"-X", "--jq", "--input", "-F", "-f", "-H", "-R", "--json", "--color",
          "--description", "--body", "--limit"}


def parse(argv):
    pos, opts = [], {}
    it = iter(argv)
    for arg in it:
        if arg in VALUED:
            opts.setdefault(arg, []).append(next(it))
        elif arg.startswith("-"):
            opts[arg] = [True]
        else:
            pos.append(arg)
    return pos, opts


def out(data, opts):
    if "--silent" in opts:
        return 0
    if isinstance(data, str) and "--jq" not in opts:
        sys.stdout.write(data)
        return 0
    if "--jq" in opts:
        run = subprocess.run(["jq", "-r", "-c", opts["--jq"][0]], input=json.dumps(data),
                             capture_output=True, text=True)
        sys.stdout.write(run.stdout)
        sys.stderr.write(run.stderr)
        return run.returncode
    sys.stdout.write(json.dumps(data))
    return 0


class Refused(str):
    """GitHub's reason for refusing a write."""


def not_found():
    sys.stderr.write("gh: Not Found (HTTP 404)\n")
    return 1


def write_body(opts):
    """The body a write sends: --input from stdin, else its -F and -f fields, typed as gh types them."""
    if "--input" in opts:
        return json.load(sys.stdin)
    body = {}
    for field in opts.get("-F", []):
        key, value = field.split("=", 1)
        body[key] = {"true": True, "false": False}.get(value, value)
    for field in opts.get("-f", []):
        key, value = field.split("=", 1)
        body[key] = value
    return body


def api(path, opts, st):
    method = opts.get("-X", ["GET"])[0]
    path = path.split("?")[0]
    if method == "GET":
        return read(path, st)
    body = write_body(opts)
    reason = github_writes.refusal(method, path, body)
    return Refused(reason) if reason else write(method, path, body, st)


def write(method, path, body, st):
    """A write GitHub takes, applied to the pretend repository."""
    repo = "repos/" + st["name"]
    sets = st["rulesets"]
    if method == "PATCH" and path == repo:
        st["repo"].update(body)
        return None
    if method == "POST" and path == repo + "/rulesets":
        body["id"] = 100 + len(sets)
        body["source_type"] = "Repository"
        sets.append(body)
        return None
    if method == "PUT" and path.startswith(repo + "/rulesets/"):
        rid = int(path.rsplit("/", 1)[1])
        body.update(id=rid, source_type="Repository")
        sets[:] = [body if r["id"] == rid else r for r in sets]
        return None
    return KeyError


def read(path, st):
    """What a GET of this path returns from the pretend repository, or KeyError for GitHub's 404."""
    repo = "repos/" + st["name"]
    sets = st["rulesets"]
    if path.endswith("/contents/.github/workflows/claude-code-review.yml"):
        return {} if "/".join(path.split("/")[1:3]) in st.get("with_workflow", []) else KeyError
    if path == repo:
        return dict(st["repo"], full_name=st["name"])
    if path == repo + "/rulesets":
        return [{k: r[k] for k in ("id", "name", "target", "source_type")} for r in sets]
    if path.startswith(repo + "/rulesets/"):
        return next((r for r in sets if str(r["id"]) == path.rsplit("/", 1)[1]), KeyError)
    if path.startswith(repo + "/labels/"):
        name = path.rsplit("/", 1)[1]
        return {"name": name} if name in st["labels"] else KeyError
    if path.startswith(repo + "/branches/"):
        name = path.split("/branches/", 1)[1]
        return {"name": name} if name in st["branches"] else KeyError
    if path == repo + "/issues/comments":
        return st.get("comments", [])
    if path == repo + "/contents/.github/review-gate.yml":
        return st["gate_yml"] if "gate_yml" in st else KeyError
    if path == repo + "/contents/.github/scripts/review_gate.py":
        return {"forbidden": PermissionError, "absent": KeyError}.get(st.get("gate_script"), {})
    if path.startswith("orgs/"):
        return {"installations": st.get("installations", [])}
    if path == "user/memberships/orgs":
        memberships = st.get("memberships", [])
        return PermissionError if memberships == "forbidden" else memberships
    return KeyError


def repo_path(opts, st):
    """The API path of the repo a gh command names with -R, else of the pretend one."""
    return "repos/" + opts.get("-R", [st["name"]])[0]


def main():
    sys.stdout.reconfigure(newline="\n")  # Windows would end lines with CRLF
    pos, opts = parse(sys.argv[1:])
    with open(STATE) as f:
        st = json.load(f)
    before = json.dumps(st)
    with open(LOG, "a") as f:
        f.write(json.dumps(sys.argv[1:]) + "\n")
    cmd = pos[:2]
    data = None
    if pos[0] == "api":
        data = api(pos[1], opts, st)
    elif cmd == ["repo", "view"]:
        data = {"nameWithOwner": st["name"]}
    elif cmd == ["label", "create"]:
        label = {"name": pos[2], "color": opts.get("--color", ["ededed"])[0],
                 "description": opts.get("--description", [""])[0]}
        data = Refused(github_writes.refusal("POST", repo_path(opts, st) + "/labels", label) or "")
        if not data:
            st["labels"].append(pos[2])
            data = None
    elif cmd == ["secret", "list"]:
        data = [{"name": n} for n in st["secrets"]]
    elif cmd == ["repo", "list"]:
        names = st.get("org_repos", {}).get(pos[2], []) if len(pos) > 2 else st.get("owned", [])
        data = [{"nameWithOwner": n} for n in names]
    elif cmd == ["secret", "set"]:
        value = "" if sys.stdin.isatty() else sys.stdin.read()
        path = repo_path(opts, st) + "/actions/secrets/" + pos[2]
        data = Refused(github_writes.refusal("PUT", path, {"value": value}) or "")
        if not data:
            st["secrets"].append(pos[2])
            st.setdefault("written", []).append([opts.get("-R", [""])[0], pos[2], value])
            data = None
    elif cmd == ["variable", "set"]:
        value = opts["--body"][0] if "--body" in opts else sys.stdin.read()
        path = repo_path(opts, st) + "/actions/variables"
        data = Refused(github_writes.refusal("POST", path, {"name": pos[2], "value": value}) or "")
        if not data:
            st.setdefault("variables", []).append([opts.get("-R", [""])[0], pos[2], value])
            data = None
    if data is KeyError:
        return not_found()
    if isinstance(data, Refused):
        sys.stderr.write("gh: Validation Failed: %s (HTTP 422)\n" % data)
        return 1
    if data is PermissionError:
        sys.stderr.write("gh: Resource not accessible by integration (HTTP 403)\n")
        return 1
    # The script pipes one call into another (read a ruleset, write it back),
    # so two fakes run at once: only a call that changed the state writes it,
    # and the file is swapped whole, never seen half written.
    if json.dumps(st) != before:
        with open(STATE + ".new", "w") as f:
            json.dump(st, f)
        os.replace(STATE + ".new", STATE)
    return out(data, opts) if data is not None else 0


sys.exit(main())
