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
