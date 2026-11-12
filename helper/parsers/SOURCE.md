# Shell parsers

Prebuilt files copied unchanged from three npm packages, so the attribution guard can read a shell command the way the shell does, with no install. `hooks/shell-words.mjs` loads them. Their licenses are in `LICENSES.md`.

| File | Package | Tarball integrity | File SHA-256 |
|---|---|---|---|
| `web-tree-sitter.js` | `web-tree-sitter@0.27.2` | `sha512-ZRo86GKI4aOSBAqOrPmCtriExI3xIzu1sNw/V6v3b4QGxrEmO19FGwbMNdyhw3MJLAZIw0xAV0oSpqX361eAyQ==` | `44626cc32a7b6878a10be084b58b471d9c47c1e2082cd5a5e34c8a41431f0c2d` |
| `web-tree-sitter.wasm` | `web-tree-sitter@0.27.2` | (same) | `488beeff7adb7fd7e21e97cc29a43dc6d031977755eda892d6d96c7f456cfdec` |
| `tree-sitter-bash.wasm` | `tree-sitter-bash@0.25.1` | `sha512-7hMytuYIMoXOq24yRulgIxthE9YmggZIOHCyPTTuJcu6EU54tYD+4G39cUb28kxC6jMf/AbPfWGLQtgPTdh3xw==` | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |
| `tree-sitter-powershell.wasm` | `tree-sitter-powershell@0.26.6` | `sha512-cIM7ltrLqaeCH+yqWQmtDoWASLQqLaDjK8JgZBCACN9qh1o6Blw06pG6ONlyoAWZYGy4Xu2T7PB/il1ZWy2gaQ==` | `9b95cfc95825e2c0a8f764bfeb030318c8a258165f41c413585e29ee3b6c1e19` |

To update one: `npm pack <package>@<version>` (npm checks the tarball against the registry's integrity), copy the file from its `package/` folder, and update this table and `LICENSES.md`. `tools/test_shell_words.py` checks each file against the SHA-256 above.
