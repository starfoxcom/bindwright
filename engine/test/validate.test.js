// The free-text project fields that validate refuses, and that both engines
// refuse the same way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults, validate } from "../model.js";
import { python, runPython } from "./python.js";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const noPython = !python && "needs Python 3.8+";
const REFUSED = "Invalid answers: ";
const REPO_MSG = "repoUrl must be empty or an https:// address of plain ASCII without spaces, quotes or angle brackets";
const HOLDER_MSG = "licenseHolder must be empty or up to 100 letters, digits, spaces and . , ' & ( ) -";
const PY_VALIDATE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from model import validate, AnswerError
out = []
for answers in json.loads(sys.stdin.buffer.read().decode("utf-8")):
    try:
        validate(answers)
        out.append(None)
    except AnswerError as e:
        out.append(str(e))
sys.stdout.write(json.dumps(out, ensure_ascii=True))
`;

const withProject = (fields) => {
  const a = defaults();
  return { ...a, project: { ...a.project, ...fields } };
};
const errorOf = (answers) => {
  try {
    validate(answers);
    return null;
  } catch (err) {
    return err.message;
  }
};
const repeat = (text, count) => text.repeat(count);

// [name, project field, value, message]; a null message means the value is accepted.
const ROWS = [
  ["repoUrl empty is accepted", "repoUrl", "", null],
  ["repoUrl https address is accepted", "repoUrl", "https://github.com/acme/shop-front.git", null],
  ["repoUrl of 192 characters after https:// is accepted", "repoUrl", `https://${repeat("a", 192)}`, null],
  ["repoUrl of 193 characters after https:// is refused", "repoUrl", `https://${repeat("a", 193)}`, REPO_MSG],
  ["repoUrl with a newline is refused", "repoUrl", "https://x.io/a\nb", REPO_MSG],
  ["repoUrl with a space is refused", "repoUrl", "https://x.io/a b", REPO_MSG],
  ["repoUrl with a double quote is refused", "repoUrl", 'https://x.io/"a', REPO_MSG],
  ["repoUrl with a backslash is refused", "repoUrl", "https://x.io/a\\b", REPO_MSG],
  ["repoUrl with a backtick is refused", "repoUrl", "https://x.io/a`b", REPO_MSG],
  ["repoUrl with an angle bracket is refused", "repoUrl", "https://x.io/<a>", REPO_MSG],
  ["repoUrl javascript: scheme is refused", "repoUrl", "javascript:alert(1)", REPO_MSG],
  ["repoUrl http address is refused", "repoUrl", "http://x.io/a", REPO_MSG],
  ["licenseHolder empty is accepted", "licenseHolder", "", null],
  ["licenseHolder of 100 characters is accepted", "licenseHolder", repeat("a", 100), null],
  ["licenseHolder of 101 characters is refused", "licenseHolder", repeat("a", 101), HOLDER_MSG],
  ["licenseHolder of 100 astral letters is accepted", "licenseHolder", repeat("\u{10400}", 100), null],
  ["licenseHolder of 101 astral letters is refused", "licenseHolder", repeat("\u{10400}", 101), HOLDER_MSG],
  ["licenseHolder with a newline is refused", "licenseHolder", "Ana\nNúñez", HOLDER_MSG],
  ["licenseHolder with an angle bracket is refused", "licenseHolder", "Ana <ana@x.io>", HOLDER_MSG],
  ["licenseHolder with an emoji is refused", "licenseHolder", "Ana 😀", HOLDER_MSG],
  ["licenseHolder José Pérez & Co. is accepted", "licenseHolder", "José Pérez & Co.", null],
];

for (const [name, field, value, message] of ROWS) {
  test(name, () => {
    const expected = message === null ? null : REFUSED + message;
    assert.equal(errorOf(withProject({ [field]: value })), expected);
  });
}

test("the Python validate refuses every free-text row as the JS validate does", { skip: noPython }, () => {
  const answers = ROWS.map(([, field, value]) => withProject({ [field]: value }));
  assert.deepEqual(runPython(PY_VALIDATE, answers, engine), answers.map(errorOf));
});
