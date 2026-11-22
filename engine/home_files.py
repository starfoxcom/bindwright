"""File helpers home.py and mod_update.py share: the error they report, atomic writes, the hash that
tells an edited copy from a shipped one, and checked reads of small JSON files. Standard library,
Python 3.8+."""

import hashlib
import json
import os


class HomeError(Exception):
    pass


def _claude(home):
    return os.path.join(home, ".claude")


def _atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _style_fingerprint(file):
    """The SHA-256 of a style file's bytes with a UTF-8 BOM and CRLF line endings taken out. The bytes are
    never decoded, so a copy in any other encoding reads as edited instead of failing."""
    with open(file, "rb") as fh:
        data = fh.read()
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def _is_str_list(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_str_map(value):
    return isinstance(value, dict) and all(isinstance(item, str) for item in value.values())


def _json_field(file, key, is_valid, message):
    """The `key` of the JSON object in `file`, which must pass `is_valid`; otherwise HomeError with `message`."""
    try:
        with open(file, encoding="utf-8") as fh:
            listed = json.load(fh)
    except ValueError:
        listed = None
    value = listed.get(key) if isinstance(listed, dict) else None
    if not is_valid(value):
        raise HomeError("%s: %s" % (message, file))
    return value
