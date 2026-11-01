// The answers kept in the page's URL: a setup code after "#s=", read back with
// the same checks setup runs. Pure, so the page's scripts and the tests share it.
import { expandAnswers, validate } from "../engine/model.js";
import { decodeSetupCode, encodeSetupCode } from "../engine/setupcode.js";

// The advanced switches the drawer shows, in order. `needs` names the switch
// that must be on for this one to be changed.
export const SWITCHES = [
  { key: "aiReview" },
  { key: "deepEscalation", needs: "aiReview" },
  { key: "attributionGuard" },
  { key: "plainWriting" },
  { key: "uiRule" },
  { key: "codeSizeCheck" },
  { key: "handoffFile" },
];

// The hash that holds these answers.
export function hashFor(answers) {
  return `#s=${encodeSetupCode(answers)}`;
}

// The answers a hash holds, null when it has no setup code, or { error: true }
// when the code fails setup's checks.
export function answersFromHash(hash) {
  const code = new URLSearchParams(hash.slice(1)).get("s");
  if (code === null) return null;
  try {
    const answers = expandAnswers(decodeSetupCode(code));
    validate(answers);
    return answers;
  } catch {
    return { error: true };
  }
}
