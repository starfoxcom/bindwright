// The page's languages. English is the hand-written page/index.html; every
// other language is generated into its folder by tools/page_languages.mjs.
export const LANGUAGES = [
  { code: "en", name: "English", folder: "" },
  { code: "es", name: "Español", folder: "es/" },
];

// The page's public address, for the hreflang links search engines read.
export const SITE = "https://starfoxcom.github.io/bindwright/page/";

// The English pages every language has: the file, and the folder it sits in
// under the site root (the path a language folder adds its own prefix to).
export const PAGES = [
  { file: "index.html", path: "" },
  { file: "settings/index.html", path: "settings/" },
  { file: "compare/index.html", path: "compare/" },
];
