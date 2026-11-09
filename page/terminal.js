// The drawn window the page's scenes play on: a timed transcript, a spinner row and a
// typed prompt, looped while its stage is on screen. Every line holds both looks, Claude
// Code's desktop app and its terminal, and the page's view (view.js) picks which one shows,
// so a change of view reskins the scene without stopping it.
// Each stage gets its own window, so two scenes on one page run and pause independently.
// With reduced motion it plays as a slideshow: short beats happen at once and every longer
// pause holds as a slide.
import { t } from "./i18n/index.js";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STOP = Symbol("stop");
// U+FE0E asks for the text form, so phones do not swap in emoji.
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
  .map((g) => `${g}︎`);
// The clock ticks in steps and stops while paused, so every wait and loop pauses with it.
const STEP = 40;
// Under reduced motion, a wait this long or longer holds as a slide; shorter ones skip.
const SLIDE_MS = 1000;
// Every story pause runs this many times its scripted length: at 1, a line is gone before
// most people finish reading it. Typing keeps its own speed.
const PACE = 1.7;

// The spinner's status text: seconds so far and thousands of tokens received. A compaction
// cannot be interrupted, so its spinner leaves the escape hint out.
const spinnerMeta = (ms, tokens, interrupt = true) =>
  `(${Math.ceil(ms / 1000)}s · ↓ ${tokens.toFixed(1)}k tokens${interrupt ? " · esc to interrupt" : ""})`;

// A terminal drawn inside `stage`. It finds its parts there by class.
export function createTerminal(stage) {
  return new Terminal(stage);
}

// The desktop app's other sessions, listed under the scene's own in the sidebar.
const RECENT_SESSIONS = ["desk.recent.1", "desk.recent.2", "desk.recent.3"];

function part(tag, cls, text = "") {
  return Object.assign(document.createElement(tag), { className: cls, textContent: text });
}

// The desktop app's parts, which the terminal view hides: the sessions sidebar, the session
// title in the title bar, and the folder and mode under the message box. `win` names its session
// with a dictionary key in data-desk.
function addDesktopParts(win) {
  const title = t(win.dataset.desk);
  const side = part("div", "desk-side");
  side.setAttribute("aria-hidden", "true");
  side.append(part("div", "desk-new", t("desk.new")), part("div", "desk-label", t("desk.recents")));
  for (const name of [title, ...RECENT_SESSIONS.map((key) => t(key))]) {
    side.append(part("div", name === title ? "desk-session on" : "desk-session", name));
  }
  win.prepend(side);
  win.querySelector(".bar").append(part("b", "desk-title", title));
  win.querySelector(".input").append(part("span", "desk-placeholder", t("desk.placeholder")));
  const modes = part("div", "desk-modes");
  modes.append(part("span", "desk-folder", "shop"), part("span", "", t("desk.mode")));
  win.querySelector(".hint").after(modes);
}

class Terminal {
  constructor(stage) {
    this.run = 0;
    this.paused = false;
    // Whether the stage is on screen.
    this.seen = true;
    this.pane = stage.querySelector(".pane");
    this.lines = stage.querySelector(".lines");
    this.spinrow = stage.querySelector(".spinrow");
    // The band of status rows above the input box. Only some terminals have one.
    this.bandBox = stage.querySelector(".band");
    this.glyph = stage.querySelector(".glyph");
    this.verb = stage.querySelector(".verb");
    this.meta = stage.querySelector(".meta");
    this.typed = stage.querySelector(".typed");
    addDesktopParts(stage.matches(".term") ? stage : stage.querySelector(".term"));
    // The two looks set lines at different heights, so the newest line moves back into view.
    document.addEventListener("viewchange", () => requestAnimationFrame(() => this.follow()));
    new IntersectionObserver(([entry]) => {
      this.seen = entry.isIntersecting;
      this.sync();
    }).observe(stage);
    document.addEventListener("visibilitychange", () => this.sync());
  }

  // The scene plays only while it is on screen and the tab is open.
  sync() {
    this.paused = !this.seen || document.hidden;
  }

  // Calls fn every ms of unpaused time, until fn returns false or the run ends.
  every(ms, fn) {
    const id = this.run;
    let acc = 0;
    let last = performance.now();
    const beat = () => {
      if (id !== this.run) return;
      const now = performance.now();
      if (!this.paused) acc += now - last;
      last = now;
      while (acc >= ms) {
        acc -= ms;
        if (fn() === false) return;
      }
      setTimeout(beat, STEP);
    };
    beat();
  }

  // Resolves after a story pause of ms, stretched by PACE so each line stays up long
  // enough to read. Rejects with STOP when a replay starts.
  wait(ms) {
    if (reduce && ms < SLIDE_MS) return Promise.resolve();
    return this.hold(ms * PACE);
  }

  // Resolves after ms of unpaused time, unstretched. Rejects with STOP when a replay starts.
  hold(ms) {
    if (reduce && ms < SLIDE_MS) return Promise.resolve();
    const id = this.run;
    return new Promise((resolve, reject) => {
      let left = ms;
      let last = performance.now();
      const beat = () => {
        if (id !== this.run) return reject(STOP);
        const now = performance.now();
        if (!this.paused) left -= now - last;
        last = now;
        if (left <= 0) return resolve();
        setTimeout(beat, Math.min(STEP, left));
      };
      beat();
    });
  }

  // Scrolls the transcript so its newest line sits at the bottom of the pane.
  follow() {
    const over = this.lines.scrollHeight - this.pane.clientHeight + 24;
    this.lines.style.transform = `translateY(${-Math.max(0, over)}px)`;
  }

  add(html, cls = "") {
    const el = document.createElement("div");
    el.className = `line ${cls}`;
    el.innerHTML = html;
    this.lines.append(el);
    this.follow();
    return el;
  }

  gap() {
    return this.add("", "gap");
  }

  // Replaces the status rows above the input box with one row per HTML string.
  band(rows) {
    if (!this.bandBox) return;
    this.bandBox.replaceChildren(...rows.map((html) => {
      const el = document.createElement("div");
      el.className = "band-row";
      el.innerHTML = html;
      return el;
    }));
    // The band takes its room from the pane, so the newest line moves back into view.
    this.follow();
  }

  out(html, cls = "") {
    return this.add(`<span class="elbow">⎿</span>${html}`, `out ${cls}`);
  }

  // How long the model thought, as the folded line both views show above its answer.
  thought(seconds) {
    return this.add(`<span class="thought"><span class="term-only">∴ Thought for ${seconds}s</span>`
      + `<span class="desk-only">${t("desk.thought", { seconds })}</span></span>`);
  }

  say(html) {
    return this.add(`<span class="dot"></span>${html}`);
  }

  // Types the prompt into the input box, then sends it into the transcript.
  async type(text) {
    for (const ch of text) {
      this.typed.textContent += ch;
      await this.hold(45 + Math.random() * 70);
    }
    await this.hold(350);
    this.typed.textContent = "";
    this.add(`<span class="echo term-only">&gt; ${text}</span><span class="bubble desk-only">${text}</span>`, "user");
    this.gap();
  }

  // The spinner row: a cycling glyph, a shimmering verb, and a live seconds and token count.
  // A tone (such as "compact") recolours the glyph and the verb as the CLI does for that state.
  async think(verb, ms, tokens, { interrupt = true, tone = "" } = {}) {
    const row = this.spinrow;
    row.dataset.tone = tone;
    row.hidden = false;
    this.verb.textContent = `${verb}…`;
    if (reduce) {
      this.meta.textContent = spinnerMeta(ms * PACE, tokens, interrupt);
      await this.wait(ms);
      row.hidden = true;
      return;
    }
    const id = this.run;
    let frame = 0;
    let elapsed = 0;
    this.every(110, () => {
      if (row.hidden || id !== this.run) return false;
      this.glyph.textContent = GLYPHS[frame++ % GLYPHS.length];
    });
    this.every(100, () => {
      if (row.hidden || id !== this.run) return false;
      elapsed += 100;
      this.meta.textContent = spinnerMeta(elapsed, tokens * Math.min(1, elapsed / (ms * PACE)), interrupt);
    });
    await this.wait(ms);
    row.hidden = true;
  }

  // A tool call: its dot runs, then turns to its result after ms. The terminal shows the
  // tool's name and argument; the desktop app names the action in words ("Ran", "Edited")
  // and marks a failure beside it.
  async tool(name, arg, ms, result = "ok") {
    const el = this.add(`<span class="dot run"></span>`
      + `<span class="name term-only">${name}</span><span class="arg term-only">(${arg})</span>`
      + `<span class="act desk-only">${t(`desk.tool.${name}`)}</span><span class="target desk-only">${arg}</span>`
      + `<span class="fail desk-only">${t("desk.failed")}</span>`, "tool");
    await this.wait(ms);
    el.firstChild.className = `dot ${result}`;
    el.classList.toggle("failed", result === "bad");
    return el;
  }

  // Clears the transcript for a new run, and any run still going stops at its next tick.
  reset() {
    this.run++;
    this.lines.replaceChildren();
    this.lines.style.transition = "none";
    this.lines.style.transform = "";
    void this.lines.offsetWidth;
    this.lines.style.transition = "";
    this.typed.textContent = "";
    this.spinrow.hidden = true;
    this.band([]);
    this.pane.classList.remove("spot");
  }

  // Plays story again and again, each time from its first line.
  async play(story) {
    try {
      for (;;) await story();
    } catch (err) {
      if (err !== STOP) throw err;
    }
  }
}
