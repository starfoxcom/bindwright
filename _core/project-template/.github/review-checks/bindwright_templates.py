"""Pre-screen check: which changed files are Bindwright's template text, unedited.

It renders the Bindwright setup the way the pinned release writes it and lists
each changed file whose text equals that render, so the review can send a
finding in such a file upstream instead of blocking this repo on text it does
not own. The render uses:

- the Python helper the head's `.bindwright/helper.json` pins, taken only from a
  starfoxcom/bindwright release download that matches the pinned SHA-256, so
  the pin can name a published release and nothing else;
- the base's `.bindwright/project.json` answers and `.bindwright/pristine.json`
  year, so a PR cannot steer what the render fills in.

The base is the first parent of the merge commit the review checks out. The
check never fails the pre-screen: when anything is missing or refused it says
why and lists nothing, and every file keeps its normal review.

Run by the gate's Project pre-screen job from the base branch:
    bindwright_templates.py FILES DIFF
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

PIN = ".bindwright/helper.json"
ANSWERS = ".bindwright/project.json"
PRISTINE = ".bindwright/pristine.json"
STAGING = ".bindwright/incoming/"
RELEASE = re.compile(
    r"https://github\.com/starfoxcom/bindwright/releases/download/"
    r"v([0-9]+\.[0-9]+\.[0-9]+)/bindwright-\1-py3-none-any\.whl")
DOWNLOAD_SECONDS = 120
RENDER_SECONDS = 120
HEADING = "Bindwright template text, unedited"


class Skip(Exception):
    """A reason the check lists nothing."""


def git_show(rev, path):
    """The bytes of `path` at `rev`, or None when it has no such file."""
    r = subprocess.run(["git", "show", "%s:./%s" % (rev, path)], capture_output=True)
    return r.stdout if r.returncode == 0 else None


def base_commit():
    """The base tip: the first parent of the PR's merge commit."""
    r = subprocess.run(["git", "rev-list", "--parents", "-n", "1", "HEAD"], capture_output=True, text=True)
    parents = r.stdout.split()[1:] if r.returncode == 0 else []
    if len(parents) != 2:
        raise Skip("HEAD is not a pull request's merge commit, so there is no base to read")
    return parents[0]


def read_json(rev, path):
    data = git_show(rev, path)
    if data is None:
        raise Skip("%s has no %s" % ("the base" if rev != "HEAD" else "the head", path))
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Skip("%s is not valid JSON" % path)


def pinned_wheel(pin):
    """The pinned wheel's URL and SHA-256, refused unless it is a Bindwright release."""
    python = pin.get("python") if isinstance(pin, dict) else None
    url = python.get("url") if isinstance(python, dict) else None
    digest = python.get("sha256") if isinstance(python, dict) else None
    if not isinstance(url, str) or not RELEASE.fullmatch(url):
        raise Skip("%s names no Bindwright release wheel" % PIN)
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise Skip("%s gives no SHA-256 for the wheel" % PIN)
    return url, digest


def release_version(url):
    return tuple(int(part) for part in RELEASE.fullmatch(url).group(1).split("."))


def refuse_older_pin(base, url):
    """Refuses a head pin older than the base's, so a PR cannot exempt text it reverts."""
    try:
        base_url, _ = pinned_wheel(json.loads((git_show(base, PIN) or b"").decode("utf-8")))
    except (Skip, UnicodeDecodeError, ValueError):
        return
    if release_version(url) < release_version(base_url):
        raise Skip("the head pins Bindwright %s, older than the base's %s"
                   % (RELEASE.fullmatch(url).group(1), RELEASE.fullmatch(base_url).group(1)))


def download(url):
    with urllib.request.urlopen(url, timeout=DOWNLOAD_SECONDS) as response:
        return response.read()


def unpack(data, digest, folder):
    """Checks the wheel against its pin and unpacks it; returns the engine's bind.py."""
    if hashlib.sha256(data).hexdigest() != digest:
        raise Skip("the downloaded wheel does not match the SHA-256 in %s" % PIN)
    path = os.path.join(folder, "helper.whl")
    with open(path, "wb") as fh:
        fh.write(data)
    target = os.path.join(folder, "helper")
    with zipfile.ZipFile(path) as wheel:
        for name in wheel.namelist():
            if name.startswith(("/", "\\")) or ".." in re.split(r"[\\/]", name):
                raise Skip("the wheel holds a path outside its folder")
        wheel.extractall(target)
    engine = os.path.join(target, "bindwright", "engine", "bind.py")
    if not os.path.isfile(engine):
        raise Skip("the wheel holds no engine")
    return engine


def render(engine, answers, year):
    """The bind's files, as the engine writes them for these answers and year."""
    command = [sys.executable, "-E", "-s", engine]
    if isinstance(year, int):
        command += ["--year", str(year)]
    try:
        r = subprocess.run(command, input=json.dumps(answers).encode("utf-8"),
                           capture_output=True, timeout=RENDER_SECONDS)
        out = json.loads(r.stdout.decode("utf-8"))
    except (subprocess.TimeoutExpired, UnicodeDecodeError, ValueError):
        raise Skip("the pinned engine gave no render")
    if not isinstance(out, dict) or "files" not in out:
        raise Skip("the pinned engine refused the base's answers: %s" % (out or {}).get("error", "no reason"))
    files = {}
    for path, text in out["files"]:
        if path.startswith(STAGING):
            path = path[len(STAGING):]
        if not path.startswith(".bindwright/"):
            files[path] = text
    return files


def lines(text):
    return text.replace("\r\n", "\n")


def unedited(changed, rendered):
    """The changed files whose head text equals the render."""
    found = []
    for path in changed:
        if path not in rendered:
            continue
        data = git_show("HEAD", path)
        if data is None:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if lines(text) == lines(rendered[path]):
            found.append(path)
    return found


def changed_files(path):
    with open(path, encoding="utf-8") as fh:
        return [line for line in fh.read().splitlines() if line]


def run(files_path):
    base = base_commit()
    url, digest = pinned_wheel(read_json("HEAD", PIN))
    refuse_older_pin(base, url)
    answers = read_json(base, ANSWERS)
    year = read_json(base, PRISTINE).get("year")
    with tempfile.TemporaryDirectory() as folder:
        try:
            data = download(url)
        except OSError as e:
            raise Skip("the wheel download failed: %s" % e)
        rendered = render(unpack(data, digest, folder), answers, year)
    release = RELEASE.fullmatch(url).group(1)
    return release, unedited(changed_files(files_path), rendered)


def main(argv):
    try:
        release, found = run(argv[0])
    except Exception as e:
        reason = e if isinstance(e, Skip) else "the check failed (%s: %s)" % (type(e).__name__, e)
        print("%s: none listed, since %s. Every changed file gets the normal review." % (HEADING, reason))
        return 0
    if not found:
        print("%s: no changed file equals the render of Bindwright %s." % (HEADING, release))
        return 0
    print("%s (each equals the render of Bindwright %s from the base's answers):" % (HEADING, release))
    print("\n".join("- " + path for path in found))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
