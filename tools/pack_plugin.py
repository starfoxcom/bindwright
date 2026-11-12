"""Assembles the Bindwright plugin and its helper package.

The plugin holds only what the plugin directory accepts from an organization
that is not Verified: `plugin/` (manifest, icon, README, skills) and helper.json.
Everything that runs on the user's computer ships as the helper
package, attached to each GitHub release as `bindwright-X.Y.Z.tgz` (npm
installs it) and `bindwright-X.Y.Z-py3-none-any.whl` (pip installs it): both
engines, the templates the engine reads, the extras for the user's config
folder, the scripts in `helper/hooks/`, and the changelog. helper.json names
both files with their SHA-256, so setup installs into `~/.bindwright/helper`
only the exact helper the plugin was packed with.

    python tools/pack_plugin.py                   -> dist/bindwright/ (the plugin)
    python tools/pack_plugin.py --out DIR         -> DIR (replaced if it holds an earlier pack)
    python tools/pack_plugin.py --zip FILE        -> the plugin's release zip, built from git at HEAD
    python tools/pack_plugin.py --helper-out DIR  -> the helper's npm package folder
    python tools/pack_plugin.py --tgz DIR         -> the helper's npm tarball, built from git at HEAD
    python tools/pack_plugin.py --wheel DIR       -> the helper's wheel, built from git at HEAD
    ... --zip, --helper-out, --tgz or --wheel with --ref REF  -> the same, from REF
    python tools/pack_plugin.py --marketplace     -> .claude-plugin/marketplace.json for HEAD's zip

The zip, the tarball and the wheel are read from git, not from the working
tree, so every machine builds the same bytes whatever its line endings; the
release workflow rebuilds them and refuses to publish a zip whose SHA-256
differs from the marketplace file. Every plugin pack is checked against the
directory's rules (tools/directory_check.py). Try a pack with
`claude --plugin-dir dist/bindwright`. Standard library only.
"""

import base64
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tarfile
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import directory_check  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# What setup runs: both engine twins, their command entry points, and
# package.json, which tells Node the .js files are ES modules.
ENGINE_FILES = [
    "package.json", "core-files.json", "cli.js",
    "bind.js", "model.js", "render.js", "setupcode.js", "apply.js", "keep.js", "update.js",
    "layers.js", "share.js", "doctor.js", "report.js", "audit.js", "remove.js", "staging.js", "releases.js",
    "exclude.js", "propose.js",
    "bind.py", "model.py", "render.py", "setupcode.py", "apply.py", "keep.py", "update.py",
    "layers.py", "share.py", "doctor.py", "report.py", "audit.py", "remove.py", "staging.py", "releases.py",
    "exclude.py", "propose.py",
    "home.py", "authored.py",
]
# The ~/.claude templates bind.js and bind.py read (globalFiles).
GLOBAL_FILES = [
    "CLAUDE.md.additions", "memory-template/MEMORY.md",
    "hooks/push-guard.py", "hooks/no-ai-attribution.py", "hooks/session-title.py",
    "hooks/code-research-profiles.json", "hooks/code-research-first.py.template",
    "agents/builder.md", "output-styles/straight-talk.md",
]
# Marks a folder as a pack, so --out never replaces anything else.
MARKER = ".bindwright-pack.txt"

# Where releases are published, and the marketplace file that lists them.
REPO = "starfoxcom/bindwright"
MARKETPLACE = ".claude-plugin/marketplace.json"
DESCRIPTION = "The Bindwright plugin, from its GitHub releases."
HELPER_DESCRIPTION = "The files the Bindwright plugin runs on your computer: its setup engine, templates and scripts."
HOMEPAGE = "https://starfoxcom.github.io/bindwright/"
# What npm installs from the helper folder, beside package.json, README.md and LICENSE.
HELPER_FILES = ["engine", "_core", "hooks", "parsers", "findwright", "workflows", "VERSION", "CHANGELOG.md"]
# A fixed date for every zip entry, the earliest a zip can hold.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)
# The largest stored deflate block.
DEFLATE_BLOCK = 65535


def _skipped(parent, name):
    # Caches, tests, and the editor typings the CLI writes beside a loaded mod.
    if name in ("__pycache__", "node_modules", "tests", "test-helper"):
        return True
    return name == "types" and parent == ".claude-plugin"


class WorkTree:
    """The files as they are in the repo folder."""

    def files_under(self, rel):
        base = os.path.join(ROOT, *rel.split("/"))
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if not _skipped(os.path.basename(dirpath), d))
            for name in sorted(filenames):
                yield os.path.relpath(os.path.join(dirpath, name), ROOT).replace(os.sep, "/")

    def read(self, rel):
        with open(os.path.join(ROOT, *rel.split("/")), "rb") as fh:
            return fh.read()


class GitTree:
    """The files as git stores them at `ref`: the bytes are the same on every machine."""

    def __init__(self, ref):
        out = _git("ls-tree", "-r", "-z", "--full-tree", ref)
        self.blobs = {}
        for line in out.split(b"\0"):
            if not line:
                continue
            meta, path = line.split(b"\t", 1)
            mode, kind, sha = meta.decode("ascii").split(" ")
            # A link or a submodule has no file to pack; neither may reach the plugin.
            self.blobs[path.decode("utf-8")] = sha if kind == "blob" and mode in ("100644", "100755") else None

    def files_under(self, rel):
        for path in sorted(p for p in self.blobs if p.startswith(rel + "/")):
            parts = path.split("/")
            if not any(_skipped(parts[i - 1] if i else "", parts[i]) for i in range(len(parts) - 1)):
                yield path

    def read(self, rel):
        sha = self.blobs.get(rel)
        if sha is None:
            raise SystemExit("%s is not a plain file in git" % rel)
        return _git("cat-file", "blob", sha)


def _git(*args):
    result = subprocess.run(["git", "-C", ROOT] + list(args), capture_output=True)
    if result.returncode != 0:
        raise SystemExit("git %s failed: %s" % (" ".join(args), result.stderr.decode("utf-8", "replace").strip()))
    return result.stdout


def version_of(source):
    return source.read("VERSION").decode("utf-8").strip().lstrip("v")


def _json_bytes(data):
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def contents(source):
    """Every file of the plugin as {path in the plugin: bytes}; refuses what the directory would."""
    out = {rel[len("plugin/"):]: source.read(rel) for rel in source.files_under("plugin")}
    # The manifest's version is the one the skills ask the helper to match; helper.json says
    # where to get it. A VERSION file would be refused: it has no allowed extension.
    out["helper.json"] = helper_pins(source)
    manifest = json.loads(out[".claude-plugin/plugin.json"])
    manifest["version"] = version_of(source)
    out[".claude-plugin/plugin.json"] = _json_bytes(manifest)
    problems = directory_check.problems_in(out)
    if problems:
        raise SystemExit("The plugin breaks the directory's rules:\n  " + "\n  ".join(problems))
    return out


def helper_contents(source):
    """Every file of the helper as {path in the helper: bytes}, package.json excepted."""
    out = {rel[len("helper/"):]: source.read(rel) for rel in source.files_under("helper")}
    for name in ENGINE_FILES:
        out["engine/" + name] = source.read("engine/" + name)
    core = ["_core/project-template/" + p for p in json.loads(source.read("engine/core-files.json"))]
    licenses = list(source.files_under("_core/licenses"))
    global_files = ["_core/global-template/" + p for p in GLOBAL_FILES]
    # Mods are copied whole into ~/.claude/mods/, so the helper carries them as they ship.
    global_files += list(source.files_under("_core/global-template/mods"))
    # VERSION records the version in the pristine render; CHANGELOG.md lists the releases since it.
    for rel in core + licenses + global_files + ["VERSION", "CHANGELOG.md", "LICENSE"]:
        out[rel] = source.read(rel)
    return out


def helper_package_json(version):
    return _json_bytes({
        "name": "bindwright",
        "version": version,
        "description": HELPER_DESCRIPTION,
        "homepage": HOMEPAGE,
        "repository": {"type": "git", "url": "git+https://github.com/%s.git" % REPO},
        "bugs": "https://github.com/%s/issues" % REPO,
        "license": "MIT",
        "engines": {"node": ">=18"},
        "files": HELPER_FILES,
    })


def _clear(out):
    if not os.path.exists(out):
        return
    if not os.path.isfile(os.path.join(out, MARKER)):
        raise SystemExit("Refusing to replace %s: it is not an earlier pack" % out)
    shutil.rmtree(out)


def _write_folder(out, files):
    _clear(out)
    for rel, data in files.items():
        dest = os.path.join(out, *rel.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)
    with open(os.path.join(out, MARKER), "w", encoding="utf-8") as fh:
        fh.write("Built by tools/pack_plugin.py; safe to delete.\n")
    return len(files) + 1


def pack(out, source=None):
    """Writes the plugin to the folder `out` and returns the number of files."""
    return _write_folder(out, contents(source or WorkTree()))


def _helper_package(source):
    files = helper_contents(source)
    files["package.json"] = helper_package_json(version_of(source))
    return files


def pack_helper(out, source=None):
    """Writes the helper's npm package folder to `out` and returns the number of files."""
    return _write_folder(out, _helper_package(source or WorkTree()))


def _zip_bytes(files):
    # Stored, not deflated: zlib builds differ between machines, and the bytes must not.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as zf:
        for rel in files:
            info = zipfile.ZipInfo(rel, ZIP_DATE)
            info.create_system = 3
            info.external_attr = 0o644 << 16
            zf.writestr(info, files[rel])
    return buffer.getvalue()


def _write_file(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    return hashlib.sha256(data).hexdigest()


def pack_zip(path, ref="HEAD"):
    """Writes the plugin's release zip for `ref` to `path` and returns (its manifest, SHA-256)."""
    files = contents(GitTree(ref))
    sha = _write_file(path, _zip_bytes({rel: files[rel] for rel in sorted(files)}))
    return json.loads(files[".claude-plugin/plugin.json"]), sha


def _gzip_stored(data):
    # Stored deflate blocks, written by hand: no compressor runs, so every machine writes the same bytes.
    out = bytearray(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff")
    for start in range(0, max(len(data), 1), DEFLATE_BLOCK):
        block = data[start:start + DEFLATE_BLOCK]
        is_last = start + DEFLATE_BLOCK >= len(data)
        out += bytes([1 if is_last else 0]) + struct.pack("<HH", len(block), len(block) ^ 0xFFFF) + block
    out += struct.pack("<II", zlib.crc32(data) & 0xFFFFFFFF, len(data) & 0xFFFFFFFF)
    return bytes(out)


def tgz_bytes(source):
    """The helper's npm tarball: its package folder under `package/`, as `npm pack` lays it out."""
    files = _helper_package(source)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for rel in sorted(files):
            info = tarfile.TarInfo("package/" + rel)
            info.size, info.mode, info.mtime = len(files[rel]), 0o644, 0
            tar.addfile(info, io.BytesIO(files[rel]))
    return _gzip_stored(buffer.getvalue())


def _record_hash(data):
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
    return "sha256=%s,%d" % (digest, len(data))


def tgz_name(version):
    return "bindwright-%s.tgz" % version


def wheel_name(version):
    return "bindwright-%s-py3-none-any.whl" % version


def helper_pins(source):
    """helper.json: where the helper this plugin runs is attached, with each file's SHA-256."""
    version = version_of(source)
    base = "https://github.com/%s/releases/download/v%s/" % (REPO, version)
    pins = {"version": version}
    for kind, name, data in (("node", tgz_name(version), tgz_bytes(source)),
                             ("python", wheel_name(version), wheel_bytes(source))):
        pins[kind] = {"file": name, "url": base + name, "sha256": hashlib.sha256(data).hexdigest()}
    return _json_bytes(pins)


def wheel_bytes(source):
    """The helper's wheel; pip installs it with `--target`, which puts the helper at `<target>/bindwright/`."""
    version = version_of(source)
    files = {"bindwright/" + rel: data for rel, data in helper_contents(source).items()}
    files["bindwright/__init__.py"] = ('"""The Bindwright helper: run its engine from engine/bind.py."""\n'
                                       '__version__ = "%s"\n' % version).encode("utf-8")
    info = "bindwright-%s.dist-info/" % version
    readme = source.read("helper/README.md").decode("utf-8")
    files[info + "METADATA"] = "\n".join([
        "Metadata-Version: 2.1", "Name: bindwright", "Version: " + version, "Summary: " + HELPER_DESCRIPTION,
        "Home-page: " + HOMEPAGE, "License: MIT", "Requires-Python: >=3.8",
        "Project-URL: Source, https://github.com/" + REPO, "Description-Content-Type: text/markdown", "", readme,
    ]).encode("utf-8")
    files[info + "WHEEL"] = ("Wheel-Version: 1.0\nGenerator: bindwright-pack\n"
                             "Root-Is-Purelib: true\nTag: py3-none-any\n").encode("utf-8")
    ordered = {rel: files[rel] for rel in sorted(files)}
    record = "".join("%s,%s\n" % (rel, _record_hash(data)) for rel, data in ordered.items())
    ordered[info + "RECORD"] = (record + info + "RECORD,,\n").encode("utf-8")
    return _zip_bytes(ordered)


def write_helper_file(kind, folder, ref="HEAD"):
    """Writes the helper's tarball (`kind` "node") or wheel ("python") for `ref` into `folder`; returns its path."""
    source = GitTree(ref)
    version = version_of(source)
    if kind == "node":
        name, data = tgz_name(version), tgz_bytes(source)
    else:
        name, data = wheel_name(version), wheel_bytes(source)
    path = os.path.join(folder, name)
    _write_file(path, data)
    return path


def marketplace(manifest, sha256):
    """The marketplace file that lists the release zip of the plugin `manifest` describes."""
    version = manifest["version"]
    url = "https://github.com/%s/releases/download/v%s/bindwright-%s.zip" % (REPO, version, version)
    entry = {
        "name": "bindwright",
        "description": manifest["description"],
        "version": version,
        "source": {"source": "archive", "url": url, "sha256": sha256},
    }
    owner = {"name": REPO.split("/")[0], "url": "https://github.com/" + REPO.split("/")[0]}
    data = {"name": "bindwright", "description": DESCRIPTION, "owner": owner, "plugins": [entry]}
    return json.dumps(data, indent=2) + "\n"


def _value(argv, flag):
    if flag not in argv:
        return None
    i = argv.index(flag) + 1
    if i == len(argv) or argv[i].startswith("--"):
        raise SystemExit("%s needs a value" % flag)
    return argv[i]


def _write_marketplace(argv, ref):
    tmp = os.path.join(ROOT, "dist", "marketplace-check.zip")
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    manifest, sha = pack_zip(tmp, ref)
    os.remove(tmp)
    # An optional path after the flag, for tests; the repo's own file otherwise.
    i = argv.index("--marketplace") + 1
    target = os.path.join(ROOT, *MARKETPLACE.split("/"))
    if i < len(argv) and not argv[i].startswith("--"):
        target = argv[i]
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(marketplace(manifest, sha))
    print("Wrote %s for %s (sha256 %s)" % (MARKETPLACE, manifest["version"], sha))


def main(argv):
    ref = _value(argv, "--ref")
    if "--marketplace" in argv:
        _write_marketplace(argv, ref or "HEAD")
        return
    zip_path = _value(argv, "--zip")
    if zip_path is not None:
        manifest, sha = pack_zip(os.path.abspath(zip_path), ref or "HEAD")
        print("Zipped %s %s (sha256 %s)" % (zip_path, manifest["version"], sha))
        return
    for flag, kind in (("--tgz", "node"), ("--wheel", "python")):
        folder = _value(argv, flag)
        if folder is not None:
            print("Built %s" % write_helper_file(kind, os.path.abspath(folder), ref or "HEAD"))
            return
    helper_dir = _value(argv, "--helper-out")
    if helper_dir is not None:
        count = pack_helper(os.path.abspath(helper_dir), GitTree(ref) if ref else None)
        print("Packed the helper, %d files, into %s" % (count, helper_dir))
        return
    out = os.path.abspath(_value(argv, "--out") or os.path.join(ROOT, "dist", "bindwright"))
    count = pack(out)
    print("Packed %d files into %s" % (count, out))


if __name__ == "__main__":
    main(sys.argv[1:])
