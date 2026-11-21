"""Installs the Python helper the plugin pins, the twin of helper/hooks/follow.mjs: the download
is checked against the pin's SHA-256, pip installs it under the helper home, and the install
lock follow.mjs uses keeps two sessions from installing at once.
Standard library, Python 3.8+.
"""

import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

RELEASES = "https://github.com/starfoxcom/bindwright/releases/download/"
# Together under the two minutes a shell call gets by default, so far under the stale-lock age.
DOWNLOAD_TIMEOUT_SECONDS = 30
INSTALL_TIMEOUT_SECONDS = 60
CHUNK_BYTES = 64 * 1024
# A lock older than this belongs to a session that died mid-install.
STALE_LOCK_SECONDS = 5 * 60
LOCK_NAME = "follow.lock"
PIN_ERROR = "the plugin's helper pin is missing or names an unexpected file"


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _plain_version(value):
    return str(value or "").strip().lstrip("v")


def read_pin(plugin_folder):
    """The plugin's Python helper pin, or None when it is missing or names anything unexpected."""
    pin = _read_json(os.path.join(plugin_folder, "helper.json"))
    if not isinstance(pin, dict):
        return None
    version = _plain_version(pin.get("version"))
    python = pin.get("python")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or not isinstance(python, dict):
        return None
    file_name = "bindwright-%s-py3-none-any.whl" % version
    url = RELEASES + "v%s/%s" % (version, file_name)
    sha256 = python.get("sha256")
    if python.get("file") != file_name or python.get("url") != url:
        return None
    if not (isinstance(sha256, str) and re.fullmatch(r"[0-9a-f]{64}", sha256)):
        return None
    return {"version": version, "file": file_name, "url": url, "sha256": sha256}


def _try_create(path):
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        return True
    except OSError:
        return False


def _age(path):
    return time.time() - os.path.getmtime(path)


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _take_lock(path):
    """True when this session now holds the lock. A stale lock is moved aside before it is
    judged, so a fresh lock another session took meanwhile goes back in place, not deleted."""
    if _try_create(path):
        return True
    try:
        if _age(path) < STALE_LOCK_SECONDS:
            return False
        aside = "%s.%d" % (path, os.getpid())
        os.rename(path, aside)
        if _age(aside) < STALE_LOCK_SECONDS:
            try:
                os.link(aside, path)
            finally:
                _remove(aside)
            return False
        _remove(aside)
    except OSError:
        return False
    return _try_create(path)


def _download(url):
    """The file's bytes, read in chunks against one deadline for the whole transfer."""
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
    chunks = []
    with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("the download took longer than %d s" % DOWNLOAD_TIMEOUT_SECONDS)
            chunk = response.read(CHUNK_BYTES)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)


def _pip_install(target, wheel_path):
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--upgrade", "--no-deps", "--no-index",
         "--target", target, wheel_path],
        check=True, timeout=INSTALL_TIMEOUT_SECONDS, capture_output=True,
    )


def _failure_line(error):
    """The first line of what the install printed to stderr, or of the exception itself."""
    if isinstance(error, subprocess.CalledProcessError) and error.stderr:
        stderr = error.stderr
        text = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else str(stderr)
    else:
        text = str(error)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[0] if lines else "the install failed"


def _install_wheel(pin, helper_home, data, run_install):
    folder = tempfile.mkdtemp(dir=helper_home, prefix="download-")
    try:
        wheel_path = os.path.join(folder, pin["file"])
        with open(wheel_path, "wb") as fh:
            fh.write(data)
        run_install(os.path.join(helper_home, "python"), wheel_path)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _installed_version(target):
    try:
        with open(os.path.join(target, "bindwright", "VERSION"), encoding="utf-8") as fh:
            return _plain_version(fh.read()) or None
    except OSError:
        return None


def _install_pin(pin, helper_home, fetch, run_install):
    try:
        data = (fetch or _download)(pin["url"])
    # ValueError covers a malformed proxy or URL (http.client.InvalidURL).
    except (OSError, ValueError, http.client.HTTPException) as error:
        return {"error": _failure_line(error)}
    if hashlib.sha256(data).hexdigest() != pin["sha256"]:
        return {"error": "the download does not match the plugin's pin"}
    try:
        _install_wheel(pin, helper_home, data, run_install or _pip_install)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"error": _failure_line(error)}
    found = _installed_version(os.path.join(helper_home, "python"))
    if found != pin["version"]:
        return {"error": "the helper still reads %s" % (found or "nothing")}
    return {"ready": True}


def helper_install(home, plugin_folder, fetch=None, run_install=None):
    """Installs the helper the plugin pins under the install lock. Returns {"ready": True},
    {"busy": True} while another session holds the lock, or {"error": message}."""
    pin = read_pin(plugin_folder)
    if pin is None:
        return {"error": PIN_ERROR}
    helper_home = os.path.join(home, ".bindwright", "helper")
    os.makedirs(helper_home, exist_ok=True)
    lock_path = os.path.join(helper_home, LOCK_NAME)
    if not _take_lock(lock_path):
        return {"busy": True}
    try:
        return _install_pin(pin, helper_home, fetch, run_install)
    finally:
        _remove(lock_path)
