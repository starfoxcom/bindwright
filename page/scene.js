// The hero's drawn terminal scene: a scripted coding session, with a caption per act and
// the cards that pop out beside it. The terminal itself is terminal.js; this file holds
// only the hero's story.
import { t } from "./i18n/index.js";
import { createTerminal } from "./terminal.js";

const $ = (name) => document.getElementById(`scene-${name}`);
const term = createTerminal($("stage"));

// The todo list: one line per item, each with an empty box.
function todos(items) {
  term.say(`<span class="name">Update Todos</span>`);
  return items.map((txt, i) => term.add(
    `<span class="elbow">${i ? " " : "⎿"}</span><span class="box">☐</span>`
      + `<span class="txt">${txt}</span>`,
    "todo",
  ));
}

// Ticks a todo item off.
async function checkOff(el) {
  el.classList.add("done");
  el.querySelector(".box").textContent = "☒";
  await term.wait(350);
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
  await term.wait(500);
}

const card = (name) => $("stage").querySelector(`[data-card="${name}"]`);

// On a phone the cards share one spot, so a new card replaces the last one.
function show(name) {
  if ($("stage").clientWidth <= 640) {
    $("stage").querySelectorAll(".card.on").forEach((c) => c.classList.remove("on"));
  }
  card(name).classList.add("on");
}

// Clears the terminal and the cards for a new run.
function reset() {
  term.reset();
  $("stage").querySelectorAll(".card").forEach((c) => c.classList.remove("on", "green"));
}

// Act 1: the session starts from the board and plans the work.
async function actStart() {
  await caption(1, t("scene.caption.1"));
  await term.type("/session-start");
  await term.think(t("scene.verb.reading"), 1900, 1.2);
  term.say(t("scene.say.next"));
  await term.wait(500);
  const items = todos([t("scene.todo.1"), t("scene.todo.2"), t("scene.todo.3")]);
  term.gap();
  await term.wait(1500);
  return items;
}

// Act 2: the code and its tests.
async function actWrite(first, second) {
  await caption(2, t("scene.caption.2"));
  await term.think(t("scene.verb.thinking"), 1700, 2.6);
  term.add(`<span class="thought">∴ Thought for 2s</span>`);
  await term.tool("Write", "test/cart.test.js", 500);
  term.out(`<span class="mute">Wrote 14 lines</span>`);
  await checkOff(first);
  await term.tool("Update", "src/cart.js", 600);
  term.out(`<span class="mute">Updated src/cart.js with 1 addition and 1 removal</span>`);
  term.add(`<span class="n">18</span>-  total += item.price`, "diff del");
  await term.wait(250);
  term.add(`<span class="n">18</span>+  total += item.price * item.qty`, "diff add");
  await checkOff(second);
  await term.tool("Bash", "npm test", 1300);
  term.out(`<span class="okt">✓ 43 passing</span> <span class="mute">(1.2s)</span>`);
  term.gap();
  await term.wait(1200);
}

// Act 3: a guard stops a risky push, and the blocked lines are highlighted.
async function actGuard() {
  await caption(3, t("scene.caption.3"));
  const push = await term.tool("Bash", "git push --force origin main", 900, "bad");
  const why = term.out(`<span class="badt">${t("scene.blocked")}</span>`);
  const fix = term.out(`<span class="mute">${t("scene.blocked.fix")}</span>`);
  const focused = [push, why, fix];
  focused.forEach((line) => line.classList.add("focus"));
  term.pane.classList.add("spot");
  show("guard");
  await term.wait(2600);
  term.pane.classList.remove("spot");
  focused.forEach((line) => line.classList.remove("focus"));
  term.gap();
}

// Act 4: the pull request gets its AI review, and the gate turns green.
async function actReview(last) {
  await caption(4, t("scene.caption.4"));
  await term.tool("Bash", "gh pr create --base develop", 900);
  term.out(`<span class="mute">github.com/you/shop/pull/13</span>`);
  show("review");
  await term.wait(1700);
  await term.tool("Update", "src/cart.js", 600);
  term.add(`<span class="n">18</span>+  total += item.price * (item.qty ?? 1)`, "diff add");
  await term.wait(1100);
  card("review").classList.add("green");
  await checkOff(last);
  term.gap();
  await term.wait(1500);
}

// Act 5: the session closes with a hand-off note for the next one.
async function actHandoff() {
  await caption(5, t("scene.caption.5"));
  await term.type("/session-close");
  await term.think(t("scene.verb.handoff"), 1500, 0.8);
  await term.tool("Write", ".bindwright/handoff.md", 500);
  term.out(`<span class="mute">${t("scene.next")}</span>`);
  show("handoff");
}

async function story() {
  reset();
  const [first, second, third] = await actStart();
  await actWrite(first, second);
  await actGuard();
  await actReview(third);
  await actHandoff();
  await term.wait(4200);
}

term.play(story);
