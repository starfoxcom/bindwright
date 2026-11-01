// The page's link: the answers in the URL hash read back the same way, and a
// hash that is not a valid setup code is refused rather than trusted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSetupCode } from "../setupcode.js";
import { defaults } from "../model.js";
import { SWITCHES, answersFromHash, hashFor } from "../../page/link.js";

test("the link reads back the answers it was made from", () => {
  const answers = defaults({ team: true });
  answers.advanced.codeSizeCheck = !answers.advanced.codeSizeCheck;
  assert.deepEqual(answersFromHash(hashFor(answers)), answers);
});

test("a hash without a setup code gives no answers", () => {
  assert.equal(answersFromHash(""), null);
  assert.equal(answersFromHash("#x=1"), null);
});

test("a code that fails setup's checks is refused", () => {
  assert.deepEqual(answersFromHash("#s=bw1-garbage"), { error: true });
  const unknown = `#s=${encodeSetupCode({ ...defaults(), bogus: true }, { full: true })}`;
  assert.deepEqual(answersFromHash(unknown), { error: true });
});

test("every switch is a boolean advanced answer, and needs another switch", () => {
  const { advanced } = defaults();
  const keys = new Set(SWITCHES.map(({ key }) => key));
  for (const { key, needs } of SWITCHES) {
    assert.equal(typeof advanced[key], "boolean", key);
    if (needs !== undefined) {
      assert.ok(keys.has(needs), `${key} needs ${needs}`);
      assert.notEqual(needs, key);
    }
  }
});
