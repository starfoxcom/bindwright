// Copying text for the page's copy buttons. A command box reports the result on
// its icon button; when the clipboard refuses, the text is selected for copying by hand.
import { t } from "./i18n/index.js";
import { restart } from "./dom.js";

const COPY_FEEDBACK_MS = 1500;
const copyResetTimers = new WeakMap();

// Resolves to true when the clipboard took the text, false when it refused.
export async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Shows a copy result on its icon button: a check mark when copied, or a
// hint to copy by hand when the clipboard refused.
function showCopyResult(button, copied) {
  clearTimeout(copyResetTimers.get(button));
  button.classList.toggle("copied", copied);
  button.setAttribute("aria-label", t(copied ? "copy.done" : "copy.manual"));
  if (copied) restart(button, "pulse");
  copyResetTimers.set(button, setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", t("copy.command"));
  }, COPY_FEEDBACK_MS));
}

// Selects the code's text so the reader can copy it by hand.
function selectCodeText(code) {
  const range = document.createRange();
  range.selectNodeContents(code);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Copies text for a command box, then reports the result on its button.
export async function copyBoxText(button, code, text) {
  const copied = await writeClipboard(text);
  if (!copied) selectCodeText(code);
  showCopyResult(button, copied);
}
