// The answers of a code host without GitHub: no Actions, a file tracker and no
// GitHub repo or board, and one person for "local". Shared by the tests that bind such a project.

export function withoutGithub(answers, codeHost) {
  Object.assign(answers.advanced, {
    codeHost, aiReview: false, deepEscalation: false, tracker: "file",
    trackerProject: null, trackerRepo: null, publicRoadmap: null,
  });
  if (codeHost === "local") answers.team = false;
  return answers;
}

// The answers of a project on GitHub whose organization blocks apps, Actions and
// boards: no AI review and no board, while the issues may stay on GitHub.
export function withoutActions(answers, tracker = answers.advanced.tracker) {
  Object.assign(answers.advanced, {
    githubApps: false, aiReview: false, deepEscalation: false, trackerProject: null, tracker,
  });
  return answers;
}

// Each code host a test binds besides plain GitHub, applied to a fresh copy of the answers.
export const HOST_VARIANTS = [
  (a) => withoutGithub(a, "local"),
  (a) => withoutGithub(a, "other"),
  (a) => withoutActions(a),
  (a) => withoutActions(a, "file"),
];
