"""Replays the plugin directory's rules for organizations that are not Verified.

The directory refuses such a plugin when it ships anything other than
Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image; a text file
that is not UTF-8, holds a NUL byte or starts with `#!`; a package manager's
configuration; command hooks, mods or local MCP servers; or a skill whose
frontmatter carries keys outside the allowed list (`allowed-tools` among them).
It also refuses what the directory's policy scan holds for a reviewer as a
credential forward: a line that names an environment variable or a credential
word (token, secret, password, credential, API key) beside a network call.
The packer runs this on every pack, so a release never meets a refusal or a hold.

    python tools/directory_check.py DIR      -> lists each problem, exits 1 on any

Standard library only.
"""

import json
import os
import re
import sys

TEXT_EXTENSIONS = {".md", ".txt", ".json", ".yaml", ".yml"}
# Extensionless files the directory reads as text.
TEXT_NAMES = {"LICENSE", ".gitignore"}
IMAGE_MAGIC = {
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".ico": [b"\x00\x00\x01\x00"],
}
PACKAGE_FILES = {
    "package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc", "yarn.lock", ".yarnrc.yml",
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "bun.lockb", "requirements.txt", "pyproject.toml",
    "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "setup.py", "setup.cfg", "Gemfile", "Cargo.toml",
}
# What hooks, mods and local servers are declared with.
DECLARATION_FILES = {"hooks/hooks.json", ".mcp.json"}
MANIFEST_CODE_KEYS = {"hooks", "mcpServers", "modules", "lspServers"}
# The frontmatter keys this plugin's skills use; all are core skill keys.
SKILL_KEYS = {"name", "description", "disable-model-invocation", "argument-hint"}
# The one frontmatter line form the check reads: `key: plain text` or `key: "JSON string"`.
# A plain value holds no `: ` or ` #`, which YAML reads as a nested map or a comment,
# and starts with none of YAML's indicator characters.
FRONTMATTER_LINE = re.compile(r"([a-z][a-z-]*): (.+)")
YAML_INDICATORS = "-?:,[]{}#&*!|>'\"%@`"
# What the policy scan reads as a call over the network, and as a credential beside one.
NETWORK_CALL = re.compile(r"https?://|\b(?:curl|wget|Invoke-WebRequest|iwr)\b|\bgh api\b|--url\b", re.I)
CREDENTIAL = re.compile(
    r"\$\{?[A-Za-z_]\w*|\$env:\w+|%[A-Za-z_]\w*%"
    r"|token|secret|passw(?:or)?d|credential|api[ _-]?key|bearer|authorization",
    re.I,
)


def _is_webp(data):
    return data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def _frontmatter_value_ok(value):
    if value.startswith('"'):
        try:
            return isinstance(json.loads(value), str)
        except ValueError:
            return False
    return value[0] not in YAML_INDICATORS and ": " not in value and " #" not in value and not value.endswith(":")


def _frontmatter_problems(rel, text):
    """The skill's frontmatter lines the check cannot read, else its keys the directory refuses."""
    lines = text.split("\n")
    if lines[0] != "---":
        return []
    if "---" not in lines[1:]:
        return ["%s has unclosed frontmatter" % rel]
    body = lines[1:lines.index("---", 1)]
    matches = [FRONTMATTER_LINE.fullmatch(line) for line in body]
    unread = [line for line, m in zip(body, matches) if not (m and _frontmatter_value_ok(m.group(2)))]
    if unread:
        return ['%s has frontmatter lines outside `key: text` or `key: "JSON string"`: %s' % (rel, " | ".join(unread))]
    extra = [m.group(1) for m in matches if m.group(1) not in SKILL_KEYS]
    return ["%s has frontmatter keys the directory refuses: %s" % (rel, ", ".join(extra))] if extra else []


def _credential_forwards(rel, text):
    """Each line that names a credential or an environment variable beside a network call."""
    return [
        "%s:%d names %s beside a network call, which the directory holds as a credential forward"
        % (rel, number, CREDENTIAL.search(line).group(0))
        for number, line in enumerate(text.split("\n"), 1)
        if NETWORK_CALL.search(line) and CREDENTIAL.search(line)
    ]


def _text_problems(rel, data):
    if b"\0" in data:
        return ["%s holds a NUL byte" % rel]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return ["%s is not UTF-8" % rel]
    if text.lstrip("﻿").startswith("#!"):
        return ["%s starts with #!" % rel]
    text = text.replace("\r\n", "\n")
    problems = _credential_forwards(rel, text)
    if rel.endswith("SKILL.md") or rel.startswith(("agents/", "commands/")):
        problems += _frontmatter_problems(rel, text)
    if rel == ".claude-plugin/plugin.json":
        code = sorted(MANIFEST_CODE_KEYS & set(json.loads(text)))
        problems += ["plugin.json declares %s" % ", ".join(code)] if code else []
    return problems


def problems_in(files):
    """Every rule `files` ({path in the plugin: bytes}) breaks, as plain lines."""
    out = []
    for rel in sorted(files):
        data = files[rel]
        name = rel.rsplit("/", 1)[-1]
        ext = os.path.splitext(name)[1].lower()
        if name in PACKAGE_FILES:
            out.append("%s is a package manager's file" % rel)
        elif rel in DECLARATION_FILES:
            out.append("%s declares hooks or a local server" % rel)
        elif ext in IMAGE_MAGIC:
            if not any(data.startswith(m) for m in IMAGE_MAGIC[ext]):
                out.append("%s is not the image its name says" % rel)
        elif ext == ".webp":
            if not _is_webp(data):
                out.append("%s is not the image its name says" % rel)
        elif ext in TEXT_EXTENSIONS or name in TEXT_NAMES:
            out += _text_problems(rel, data)
        else:
            out.append("%s is not Markdown, text, JSON, YAML or an allowed image" % rel)
    return out


def read_folder(root):
    files = {}
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            path = os.path.join(dirpath, name)
            with open(path, "rb") as fh:
                files[os.path.relpath(path, root).replace(os.sep, "/")] = fh.read()
    return files


def main(argv):
    if len(argv) != 1:
        raise SystemExit("usage: directory_check.py DIR")
    found = problems_in(read_folder(argv[0]))
    for line in found:
        print(line)
    if found:
        sys.exit(1)
    print("Meets the directory's rules for organizations that are not Verified")


if __name__ == "__main__":
    main(sys.argv[1:])
