// The in-page half of the layout check (layout-check.mjs). The browser runs these
// functions inside the page as source text, so none may use a binding from this
// module: every constant lives inside the function that reads it.

/** The script the CLI evaluates in each loaded page. It resolves to the page's findings. */
export function pageCheckScript() {
  const parts = [
    runLayoutCheck,
    sidewaysFinding,
    candidates,
    isRendered,
    hasDirectText,
    overflowsItsBox,
    measure,
    floats,
    selectorOf,
    overlapFindings,
    overlaps,
  ];
  const sources = parts.map((part) => part.toString()).join("\n");
  return `(async () => {\n${sources}\nreturn runLayoutCheck();\n})()`;
}

async function runLayoutCheck() {
  // Scripts fill in text after the load event (translations, counters), so the page is read
  // once it has stopped changing: 300 ms without a DOM change, 3 s at most.
  await new Promise((done) => {
    let quiet = setTimeout(finish, 300);
    const cap = setTimeout(finish, 3000);
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, 300);
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    function finish() {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      done();
    }
  });
  await document.fonts.ready;
  // Two frames let the layout settle after the fonts swap in, before any box is read.
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const findings = [];
  const sideways = sidewaysFinding();
  if (sideways) findings.push(sideways);
  const boxes = candidates().map(measure);
  for (const box of boxes) {
    if (overflowsItsBox(box.el)) findings.push({ kind: "overflow", selectors: [box.selector] });
  }
  findings.push(...overlapFindings(boxes));
  return findings;
}

function sidewaysFinding() {
  const root = document.documentElement;
  if (root.scrollWidth <= root.clientWidth + 1) return null;
  // The outermost box past the viewport is the one to fix; its parent still fits.
  const wide = [...document.querySelectorAll("body *")].find(
    (el) => el.getBoundingClientRect().right > root.clientWidth + 1,
  );
  return { kind: "sideways scroll", selectors: [wide ? selectorOf(wide) : "html"] };
}

function candidates() {
  const mediaTags = ["img", "svg", "video", "canvas", "input", "button", "select", "textarea"];
  return [...document.querySelectorAll("*")].filter((el) => {
    if (el.closest("[data-layout-ignore]")) return false;
    if (!hasDirectText(el) && !mediaTags.includes(el.localName)) return false;
    return isRendered(el);
  });
}

// checkVisibility also reads the ancestors, so text inside a faded-out or hidden box (a
// card of a slideshow that is not on) is not counted as on screen.
function isRendered(el) {
  const box = el.getBoundingClientRect();
  const isVisible = el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  return isVisible && box.width >= 1 && box.height >= 1;
}

function hasDirectText(el) {
  return [...el.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "",
  );
}

function overflowsItsBox(el) {
  const style = getComputedStyle(el);
  // Clipping or an ellipsis is a deliberate choice, so the text is not a layout miss.
  const deliberate =
    ["auto", "scroll", "hidden"].includes(style.overflowX) || style.textOverflow === "ellipsis";
  if (style.display === "inline" || deliberate || !hasDirectText(el)) return false;
  // The element's own text against its box: scrollWidth would also count decoration, such as a
  // rotated pseudo-element chevron that pokes a pixel past the edge.
  const box = el.getBoundingClientRect();
  const range = document.createRange();
  return [...el.childNodes].some((node) => {
    if (node.nodeType !== Node.TEXT_NODE || node.textContent.trim() === "") return false;
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return text.right > box.right + 1 || text.left < box.left - 1;
  });
}

function measure(el) {
  return {
    el,
    rect: el.getBoundingClientRect(),
    // Headers and floating buttons sit over content on purpose, and so does their text.
    floating: floats(el),
    selector: selectorOf(el),
  };
}

function floats(el) {
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
    const { position } = getComputedStyle(node);
    if (position === "fixed" || position === "sticky") return true;
  }
  return false;
}

function selectorOf(el) {
  const own = el.id
    ? `${el.localName}#${el.id}`
    : el.localName + [...el.classList].slice(0, 2).map((name) => `.${name}`).join("");
  const owner = el.parentElement?.closest("[id]");
  return owner ? `#${owner.id} ${own}` : own;
}

function overlapFindings(boxes) {
  const findings = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i], boxes[j])) {
        findings.push({ kind: "overlap", selectors: [boxes[i].selector, boxes[j].selector] });
      }
    }
  }
  return findings;
}

function overlaps(first, second) {
  // Four pixels: subpixel rounding and touching edges are not overlaps.
  const minimumPx = 4;
  if (first.floating || second.floating) return false;
  if (first.el.contains(second.el) || second.el.contains(first.el)) return false;
  const right = Math.min(first.rect.right, second.rect.right);
  const left = Math.max(first.rect.left, second.rect.left);
  const bottom = Math.min(first.rect.bottom, second.rect.bottom);
  const top = Math.max(first.rect.top, second.rect.top);
  return right - left > minimumPx && bottom - top > minimumPx;
}
