// The evidence counts per project, read by the evidence chart and checked against the
// section's totals by engine/test/page-evidence.test.js.
// merged: merged pull requests. reviewed: those the AI reviewed. fixed: reviewed ones
// that got a red verdict and were fixed before they merged. Passed the first time is
// reviewed minus fixed. Each name is evidence.project.<name> in the i18n dictionaries.
export const projects = [
  { name: "game", merged: 1152, reviewed: 629, fixed: 189 },
  { name: "this", merged: 447, reviewed: 277, fixed: 114 },
  { name: "business", merged: 174, reviewed: 87, fixed: 16 },
  { name: "language", merged: 36, reviewed: 14, fixed: 8 },
  { name: "community", merged: 26, reviewed: 3, fixed: 1 },
  { name: "trading", merged: 21, reviewed: 0, fixed: 0 },
  { name: "card", merged: 2, reviewed: 0, fixed: 0 },
];
