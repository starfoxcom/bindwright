# Bindwright design system

The live page (`page/`) is the reference. This file holds the tokens and the rules that keep the page from reading as a generated template.

## Idea

The main page is a landing page. Most visitors do not know what a rule file or a hook is; they want Claude Code to work better on their project. The first screen has 3 to 5 seconds to say what they get, so it leads with the outcome: a plain promise, one button, and a short scene of a real session. The live page is the source of truth: when it and this file disagree, this file follows the page.

Controls feel physical, like keys on a keyboard or a synth. Color is scarce and every use has a job: the accent marks what is active, three status colors mark removed, warning and info, and the scenes keep a terminal palette of their own.

## Tokens

```css
--canvas:  oklch(0.20 0.006 240);  /* page */
--panel:   oklch(0.245 0.007 240); /* raised surfaces */
--key:     oklch(0.29 0.008 240);  /* unpressed controls */
--rule:    oklch(0.34 0.008 240);  /* dividers */
--text:    oklch(0.97 0 0);
--text-2:  oklch(0.80 0.01 240);   /* secondary text, stays readable */
--hue: 150;                         /* the accent's hue, fixed */
--accent:      oklch(0.80 0.13 var(--hue));
--accent-deep: oklch(0.62 0.13 var(--hue)); /* key underside */
--on-accent:   oklch(0.20 0.03 var(--hue)); /* text on accent */
--del:  oklch(0.72 0.15 25);  /* removed, failed */
--warn: oklch(0.85 0.14 85);  /* warning */
--info: oklch(0.74 0.13 245); /* info */
```

The scenes carry their own terminal palette, defined in the `.stage` block of `scene.css`: text tones for ok, bad, warning, info and magic, the diff backgrounds, and the spinner tones. It colors only the scenes, and that block is its source.

Radii: 12 px for keys and buttons, 18 px for panels. No other values.

## Type

- **Hubot Sans** (OFL, variable width and weight) for all interface text. Headline: weight 700, width 118%, tracking -0.03em.
- **Fragment Mono** (OFL) only inside real file contents. Never for labels.

## Controls

- Keys have a bottom lip (`inset 0 -3px 0`) and press down 2 px on `:active`.
- Switches and the primary button use `--accent` when on.
- The selected file in the tree gets a 2 px accent bar.

## Layout

- First screen (desktop): the promise, one line under it, the primary button and the scene beside them, with a switch between the desktop app and the terminal. Nothing technical: no file names, paths or setting keys.
- Then, in order: what changes, each one outcome in plain words; what a setup writes, as a file tree and preview; what it caught in real projects; the mods; and the install commands last.
- Mobile: one column, the scene right after the headline, before the button. In the file view, folders fold and a tapped file opens full width with a way back to the list.

## Rules that keep it from looking generated

- No tracked all-caps labels, no middle-dot metadata strings, no monospace labels, no arrows appended to links.
- No gradients, glows, glass, or dot-grid backgrounds.
- Motion is quiet: each block below the first screen fades in once as it enters the view, and otherwise motion only confirms a state change (key press, switch, file tree update). With `prefers-reduced-motion`, every block shows at once and nothing animates.
- Copy is plain, sentence case, specific. No em dashes, no "it's not X, it's Y", no aspirational filler.
- Every color has a job. If a color cannot be explained as active, a status, or part of the scenes' terminal palette, remove it.

## Accessibility

- Text contrast at least 4.5:1, control boundaries and focus rings at least 3:1.
- Targets at least 24 by 24 px.
- Visible focus ring in `--accent`.
- Sticky bars use `scroll-padding` so focused controls are never hidden.
- Status changes ("Preview updated: 24 files", "Link copied") go through `role="status"`.
