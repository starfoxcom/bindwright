// The evidence section: each count climbs once, and the split bar grows with
// it, when the section first scrolls into view. Reduced motion shows the final state.
const section = document.getElementById("evidence");
const DURATION_MS = 1200;
const STEP_MS = 30;
const steps = DURATION_MS / STEP_MS;
const locale = document.documentElement.lang;

// Ease-out: quick at first, then slowing into the final number.
const easeOut = (p) => 1 - (1 - p) ** 3;

// Counts one number from zero up to its data-count target.
function countUp(node) {
  const target = Number(node.dataset.count);
  let step = 0;
  const tick = () => {
    step += 1;
    node.textContent = Math.round(target * easeOut(step / steps)).toLocaleString(locale);
    if (step < steps) setTimeout(tick, STEP_MS);
  };
  node.textContent = "0";
  setTimeout(tick, STEP_MS);
}

function reveal() {
  section.classList.add("counted");
  section.querySelectorAll("[data-count]").forEach(countUp);
}

if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  section.classList.add("counted");
} else {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    reveal();
  }, { threshold: 0.35 });
  observer.observe(section);
}
