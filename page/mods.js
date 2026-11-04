// The mods section: a carousel of the mods on the left and, on the right, a terminal that
// plays the selected mod at work. Each scene moves the carousel to its mod; the arrows and
// the dots jump to another mod and start its scene over.
import { t } from "./i18n/index.js";
import { SCENES } from "./mods-scenes.js";
import { createTerminal } from "./terminal.js";

const cards = [...document.querySelectorAll("#mods-carousel .mod-card")];
const term = createTerminal(document.querySelector("#mods-stage .term"));
const MOD_ID_PREFIX = "m-";

const modOf = (card) => card.id.slice(MOD_ID_PREFIX.length);

const ACTIONS = {
  say: (key) => term.say(t(key)),
  out: (key, tone = "mute") => term.out(`<span class="${tone}">${t(key)}</span>`),
  type: (text) => term.type(text),
  tool: (name, arg, ms) => term.tool(name, arg, ms),
  think: (key, ms, tokens) => term.think(t(key), ms, tokens),
  band: (rows) => term.band(rows.map((row) => row.html)),
  wait: (ms) => term.wait(ms),
};

async function playScene(steps) {
  for (const [action, ...args] of steps) await ACTIONS[action](...args);
}

// The card on screen and the scene that plays it. A jump changes both at once.
let shown = 0;
let upNext = 0;

function show(index) {
  shown = index;
  cards.forEach((card, i) => { card.hidden = i !== index; });
  dots.forEach((dot, i) => dot.setAttribute("aria-current", String(i === index)));
}

// A jump stops the scene in progress: its wait rejects, term.play returns, and the loop
// below starts the mod jumped to.
function jumpTo(index) {
  upNext = index;
  show(index);
  term.reset();
}

const dotList = document.getElementById("mods-dots");
const dots = cards.map((card, index) => {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "mods-dot";
  dot.setAttribute("aria-label", modOf(card));
  dot.addEventListener("click", () => jumpTo(index));
  dotList.append(dot);
  return dot;
});

const step = (delta) => () => jumpTo((shown + delta + cards.length) % cards.length);
document.getElementById("mods-prev").addEventListener("click", step(-1));
document.getElementById("mods-next").addEventListener("click", step(1));

// One scene: its mod comes on screen, the terminal plays it, then the next mod is up.
async function scene() {
  const index = upNext;
  show(index);
  term.reset();
  await playScene(SCENES[modOf(cards[index])]);
  upNext = (index + 1) % cards.length;
}

async function loop() {
  for (;;) await term.play(scene);
}

show(0);
loop();
