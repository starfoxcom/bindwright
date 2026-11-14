"""Rebuilds the bash parser and checks it matches the shipped helper/parsers/shell-words-bash.wasm.

Run from the repo root with Go 1.27.4 on PATH, the only Go release that gives the same bytes:
python tools/shell-words-bash/check_build.py
Exits 1 when the bytes differ or the Go release is another.
"""
import os
import shutil
import subprocess
import sys
import tempfile

GO_RELEASE = "go1.27.4"
HERE = os.path.dirname(os.path.abspath(__file__))
SHIPPED = os.path.join(HERE, "..", "..", "helper", "parsers", "shell-words-bash.wasm")


def main():
    go = shutil.which("go")
    version = subprocess.run([go, "version"], capture_output=True, text=True).stdout if go else ""
    if f"{GO_RELEASE} " not in version:
        sys.exit(f"needs {GO_RELEASE} on PATH, found: {version.strip() or 'no Go'}")
    with tempfile.TemporaryDirectory() as folder:
        built = os.path.join(folder, "shell-words-bash.wasm")
        subprocess.run([go, "build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w -buildid=", "-o", built, "."],
                       check=True, cwd=HERE, env=dict(os.environ, GOOS="js", GOARCH="wasm", GOFLAGS="-mod=readonly"))
        with open(built, "rb") as fresh, open(SHIPPED, "rb") as shipped:
            if fresh.read() != shipped.read():
                sys.exit("the rebuilt parser differs from helper/parsers/shell-words-bash.wasm")
    print("shell-words-bash.wasm matches its source")


if __name__ == "__main__":
    main()
