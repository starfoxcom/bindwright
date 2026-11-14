import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RENAME_TRIES, writeFileAtomic } from "../../helper/hooks/write-file.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "write-file-"));
const refusing = (code, times) => {
  let calls = 0;
  const rename = (from, to) => {
    calls++;
    if (calls <= times) throw Object.assign(new Error(code), { code });
    renameSync(from, to);
  };
  return { rename, calls: () => calls };
};

const CASES = [
  ["a busy swap is tried again and lands", "EPERM", 3, true, 4],
  ["EBUSY counts as busy too", "EBUSY", 1, true, 2],
  ["a file that stays busy gives up after the last try", "EPERM", RENAME_TRIES, false, RENAME_TRIES],
  ["any other failure throws at once", "ENOSPC", 1, false, 1],
];

for (const [name, code, refusals, isWritten, calls] of CASES) {
  test(`writeFileAtomic: ${name}`, () => {
    const dir = scratch();
    const file = join(dir, "state.json");
    const fake = refusing(code, refusals);
    if (isWritten) writeFileAtomic(file, "{}\n", { rename: fake.rename });
    else assert.throws(() => writeFileAtomic(file, "{}\n", { rename: fake.rename }), { code });
    assert.equal(fake.calls(), calls);
    assert.deepEqual(readdirSync(dir), isWritten ? ["state.json"] : []);
    if (isWritten) assert.equal(readFileSync(file, "utf8"), "{}\n");
  });
}

test("writeFileAtomic: two writers never share a temporary file", () => {
  const dir = scratch();
  const seen = new Set();
  const rename = (from, to) => {
    seen.add(from);
    renameSync(from, to);
  };
  writeFileAtomic(join(dir, "state.json"), "a", { rename });
  writeFileAtomic(join(dir, "state.json"), "b", { rename });
  assert.equal(seen.size, 2);
});
