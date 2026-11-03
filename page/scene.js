// The hero's drawn terminal scene: a scripted coding session that loops while it is on
// screen. With reduced motion it plays as a slideshow: short beats happen at once and
// every longer pause holds its frame as a slide.
import { t } from "./i18n/index.js";

const $ = (name) => document.getElementById(`scene-${name}`);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STOP = Symbol("stop");
// U+FE0E asks for the text form, so phones do not swap in emoji.
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"].map((g) => `${g}︎`);
// The clock ticks in steps and stops while paused, so every wait and loop pauses with it.
const STEP = 40;
// Under reduced motion, a wait this long or longer holds as a slide; shorter ones skip.
const SLIDE_MS = 1000;
let run = 0;
let paused = false;
// Whether the scene is on screen.
let seen = true;

// Calls fn every ms of unpaused time, until fn returns false or the run ends.
function every(ms, fn) {
  const id = run;
  let acc = 0;
  let last = performance.now();
  (function beat() {
    if (id !== run) return;
    const now = performance.now();
    if (!paused) acc += now - last;
    last = now;
    while (acc >= ms) {
      acc -= ms;
      if (fn() === false) return;
    }
    setTimeout(beat, STEP);
  })();
}

// Resolves after ms of unpaused time. Rejects with STOP when a replay starts.
function wait(ms) {
  if (reduce && ms < SLIDE_MS) return Promise.resolve();
  const id = run;
  return new Promise((resolve, reject) => {
    let left = ms;
    let last = performance.now();
    (function beat() {
      if (id !== run) return reject(STOP);
      const now = performance.now();
      if (!paused) left -= now - last;
      last = now;
      if (left <= 0) return resolve();
      setTimeout(beat, Math.min(STEP, left));
    })();
  });
}

// Scrolls the transcript so its newest line sits at the bottom of the pane.
function follow() {
  const lines = $("lines");
  const over = lines.scrollHeight - $("pane").clientHeight + 24;
  lines.style.transform = `translateY(${-Math.max(0, over)}px)`;
}

function add(html, cls = "") {
  const el = document.createElement("div");
  el.className = `line ${cls}`;
  el.innerHTML = html;
  $("lines").append(el);
  follow();
  return el;
}
const gap = () => add("", "gap");
const out = (html, cls = "") => add(`<span class="elbow">⎿</span>${html}`, cls);
const say = (html) => add(`<span class="dot"></span>${html}`);

// Types the prompt into the input box, then sends it into the transcript.
async function type(text) {
  for (const ch of text) {
    $("typed").textContent += ch;
    await wait(45 + Math.random() * 70);
  }
  await wait(350);
  $("typed").textContent = "";
  add(`<span class="echo">&gt; ${text}</span>`);
  gap();
}

// The spinner's status text: seconds so far and thousands of tokens received.
const meta = (ms, tokens) =>
  `(${Math.ceil(ms / 1000)}s · ↓ ${tokens.toFixed(1)}k tokens · esc to interrupt)`;

// The spinner row: a cycling glyph, a shimmering verb, and a live seconds and token count.
async function think(verb, ms, tokens) {
  const row = $("spinrow");
  row.hidden = false;
  $("verb").textContent = `${verb}…`;
  let frame = 0;
  let elapsed = 0;
  const id = run;
  if (reduce) {
    $("meta").textContent = meta(ms, tokens);
    await wait(ms);
    row.hidden = true;
    return;
  }
  every(110, () => {
    if (row.hidden || id !== run) return false;
    $("glyph").textContent = GLYPHS[frame++ % GLYPHS.length];
  });
  every(100, () => {
    if (row.hidden || id !== run) return false;
    elapsed += 100;
    $("meta").textContent = meta(elapsed, tokens * Math.min(1, elapsed / ms));
  });
  await wait(ms);
  row.hidden = true;
}

// A tool call: its dot runs, then turns to its result after ms.
async function tool(name, arg, ms, result = "ok") {
  const el = add(`<span class="dot run"></span><span class="name">${name}</span>`
    + `<span class="arg">(${arg})</span>`);
  await wait(ms);
  el.firstChild.className = `dot ${result}`;
  return el;
}

// The todo list: one line per item, each with an empty box.
function todos(items) {
  say(`<span class="name">Update Todos</span>`);
  return items.map((txt, i) => add(
    `<span class="elbow">${i ? " " : "⎿"}</span><span class="box">☐</span>`
      + `<span class="txt">${txt}</span>`,
    "todo",
  ));
}

// Ticks a todo item off.
async function checkOff(el) {
  el.classList.add("done");
  el.querySelector(".box").textContent = "☒";
  await wait(350);
}

// The caption line at the top of the scene, numbered, with its own rise.
async function caption(n, text) {
  const c = $("caption");
  const number = Object.assign(document.createElement("b"), { textContent: `${n}.` });
  // One wrapper, so the number flows with the text when the caption wraps.
  const line = document.createElement("span");
  line.append(number, text);
  c.replaceChildren(line);
  c.classList.remove("in");
  void c.offsetWidth;
  c.classList.add("in");
  await wait(500);
}

const card = (name) => $("stage").querySelector(`[data-card="${name}"]`);

// On a phone the cards share one spot, so a new card replaces the last one.
function show(name) {
  if ($("stage").clientWidth <= 640) {
    $("stage").querySelectorAll(".card.on").forEach((c) => c.classList.remove("on"));
  }
  card(name).classList.add("on");
}

// Clears the scene for a new run, and any run still going stops at its next tick.
function reset() {
  run++;
  const lines = $("lines");
  lines.replaceChildren();
  lines.style.transition = "none";
  lines.style.transform = "";
  void lines.offsetWidth;
  lines.style.transition = "";
  $("typed").textContent = "";
  $("spinrow").hidden = true;
  $("pane").classList.remove("spot");
  $("stage").querySelectorAll(".card").forEach((c) => c.classList.remove("on", "green"));
}

// Act 1: the session starts from the board and plans the work.
async function actStart() {
  await caption(1, t("scene.caption.1"));
  await type("/session-start");
  await think(t("scene.verb.reading"), 1900, 1.2);
  say(t("scene.say.next"));
  await wait(500);
  const items = todos([t("scene.todo.1"), t("scene.todo.2"), t("scene.todo.3")]);
  gap();
  await wait(1500);
  return items;
}

// Act 2: the code and its tests.
async function actWrite(first, second) {
  await caption(2, t("scene.caption.2"));
  await think(t("scene.verb.thinking"), 1700, 2.6);
  add(`<span class="thought">∴ Thought for 2s</span>`);
  await tool("Write", "test/cart.test.js", 500);
  out(`<span class="mute">Wrote 14 lines</span>`);
  await checkOff(first);
  await tool("Update", "src/cart.js", 600);
  out(`<span class="mute">Updated src/cart.js with 1 addition and 1 removal</span>`);
  add(`<span class="n">18</span>-  total += item.price`, "diff del");
  await wait(250);
  add(`<span class="n">18</span>+  total += item.price * item.qty`, "diff add");
  await checkOff(second);
  await tool("Bash", "npm test", 1300);
  out(`<span class="okt">✓ 43 passing</span> <span class="mute">(1.2s)</span>`);
  gap();
  await wait(1200);
}

// Act 3: a guard stops a risky push, and the blocked lines are highlighted.
async function actGuard() {
  await caption(3, t("scene.caption.3"));
  const push = await tool("Bash", "git push --force origin main", 900, "bad");
  const why = out(`<span class="badt">${t("scene.blocked")}</span>`);
  const fix = out(`<span class="mute">${t("scene.blocked.fix")}</span>`);
  const focused = [push, why, fix];
  focused.forEach((line) => line.classList.add("focus"));
  $("pane").classList.add("spot");
  show("guard");
  await wait(2600);
  $("pane").classList.remove("spot");
  focused.forEach((line) => line.classList.remove("focus"));
  gap();
}

// Act 4: the pull request gets its AI review, and the gate turns green.
async function actReview(last) {
  await caption(4, t("scene.caption.4"));
  await tool("Bash", "gh pr create --base develop", 900);
  out(`<span class="mute">github.com/you/shop/pull/13</span>`);
  show("review");
  await wait(1700);
  await tool("Update", "src/cart.js", 600);
  add(`<span class="n">18</span>+  total += item.price * (item.qty ?? 1)`, "diff add");
  await wait(1100);
  card("review").classList.add("green");
  await checkOff(last);
  gap();
  await wait(1500);
}

// Act 5: the session closes with a hand-off note for the next one.
async function actHandoff() {
  await caption(5, t("scene.caption.5"));
  await type("/session-close");
  await think(t("scene.verb.handoff"), 1500, 0.8);
  await tool("Write", ".bindwright/handoff.md", 500);
  out(`<span class="mute">${t("scene.next")}</span>`);
  show("handoff");
}

async function story() {
  reset();
  const [first, second, third] = await actStart();
  await actWrite(first, second);
  await actGuard();
  await actReview(third);
  await actHandoff();
  await wait(4200);
}

async function loop() {
  try {
    for (;;) await story();
  } catch (err) {
    if (err !== STOP) throw err;
  }
}

// The scene plays only while it is on screen and the tab is open.
function sync() {
  paused = !seen || document.hidden;
}

new IntersectionObserver(([entry]) => {
  seen = entry.isIntersecting;
  sync();
}).observe($("stage"));
document.addEventListener("visibilitychange", sync);
loop();
