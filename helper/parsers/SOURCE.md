# Shell parsers

Prebuilt files, so the attribution guard can read a shell command the way the shell does, with no install. `hooks/shell-words.mjs` loads them. Their licenses are in `LICENSES.md`.

| File | Package | Tarball integrity | File SHA-256 |
|---|---|---|---|
| `web-tree-sitter.mjs` | `web-tree-sitter@0.27.2` | `sha512-ZRo86GKI4aOSBAqOrPmCtriExI3xIzu1sNw/V6v3b4QGxrEmO19FGwbMNdyhw3MJLAZIw0xAV0oSpqX361eAyQ==` | `44626cc32a7b6878a10be084b58b471d9c47c1e2082cd5a5e34c8a41431f0c2d` |
| `web-tree-sitter.wasm` | `web-tree-sitter@0.27.2` | (same) | `488beeff7adb7fd7e21e97cc29a43dc6d031977755eda892d6d96c7f456cfdec` |
| `tree-sitter-powershell.wasm` | `tree-sitter-powershell@0.26.6` | `sha512-cIM7ltrLqaeCH+yqWQmtDoWASLQqLaDjK8JgZBCACN9qh1o6Blw06pG6ONlyoAWZYGy4Xu2T7PB/il1ZWy2gaQ==` | `9b95cfc95825e2c0a8f764bfeb030318c8a258165f41c413585e29ee3b6c1e19` |
| `shell-words-bash.wasm` | built from `tools/shell-words-bash` with `mvdan.cc/sh/v3@v3.14.1` | (see below) | `4ea51e26b3f67b0c2c8a8475650d898a38e92659c3680be292bc67a8c2a82254` |
| `go-wasm-exec.mjs` | `lib/wasm/wasm_exec.js` from Go 1.27.4 | (see below) | `0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14` |

Bash is read by mvdan.cc/sh, the parser shfmt uses. `shell-words-bash.wasm` is built with Go 1.27.4 from `tools/shell-words-bash`, whose `go.sum` pins the module: `GOOS=js GOARCH=wasm go build -buildvcs=false -trimpath -ldflags="-s -w -buildid=" -o ../../helper/parsers/shell-words-bash.wasm .` there gives the same bytes. `python tools/shell-words-bash/check_build.py` rebuilds it and compares. `go-wasm-exec.mjs` is Go's own loader for it, copied unchanged.

To update a tree-sitter file: `npm pack <package>@<version>` (npm checks the tarball against the registry's integrity), copy the file from its `package/` folder (`web-tree-sitter.js` is saved as `web-tree-sitter.mjs`, an ES module, so every Node version loads it as one), and update this table and `LICENSES.md`. `test_vendored_parsers_match_their_recorded_hashes` in `tools/test_guard_hooks.py` checks each file against the SHA-256 above.
