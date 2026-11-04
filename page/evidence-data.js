// The evidence counts per project, read by the evidence chart and checked against the
// section's totals by engine/test/page-evidence.test.js.
// reviewed: pull requests the AI reviewer checked. fixed: reviewed ones that got a red
// verdict and were fixed before they merged. Passed the first time is reviewed minus
// fixed. Each name is evidence.project.<name> in the i18n dictionaries.
export const projects = [
  { name: "game", reviewed: 629, fixed: 189 },
  { name: "this", reviewed: 277, fixed: 114 },
  { name: "business", reviewed: 87, fixed: 16 },
];
