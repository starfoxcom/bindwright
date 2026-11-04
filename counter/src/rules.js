// What the counter accepts. Kept apart from the request handling so the
// limits read in one place and the tests can import them.

/** The project kinds a user can pick at opt-in. Anything else is refused. */
export const KINDS = Object.freeze([
  "game",
  "business-app",
  "developer-tool",
  "mobile-app",
  "website",
  "other",
]);

/** The four counts a send carries, in the order the page shows them. */
export const FIELDS = Object.freeze(["checked", "caught", "deep", "merged"]);

/** Upper bound for one field in one send. A send covers the days since the last one. */
export const MAX_PER_SEND = 1000;

/** A project may send again only this long after its last accepted send. */
export const MIN_SEND_GAP_IN_MILLISECONDS = 20 * 60 * 60 * 1000;

/** New project ids accepted per UTC day, across all senders. */
export const MAX_NEW_PROJECTS_PER_DAY = 200;

/** Request bodies above this size are refused before parsing. */
export const MAX_BODY_IN_BYTES = 1024;

/** How many projects `GET /total` lists. */
export const TOP_PROJECTS = 10;

const PROJECT_ID = /^[0-9a-f]{32}$/;
/** The window a send covers: pull requests merged from `from` up to `to`, in epoch milliseconds. */
export const WINDOW = Object.freeze(["from", "to"]);

const ALLOWED_KEYS = new Set(["project", "kind", ...FIELDS, ...WINDOW]);

/**
 * Checks a parsed send and returns either `{ ok: true, send }` with the
 * clean values or `{ ok: false, reason }`. Unknown keys are refused rather
 * than dropped, so a client that starts sending more data fails loudly.
 *
 * ```js
 * checkSend({ project: "0f…", kind: "game", checked: 3, caught: 1, deep: 0, merged: 2,
 *   from: 1793750400000, to: 1793836800000 });
 * ```
 */
export function checkSend(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return refuse("body must be a JSON object");
  }
  const extra = Object.keys(body).find((key) => !ALLOWED_KEYS.has(key));
  if (extra !== undefined) return refuse(`unknown field: ${extra}`);
  if (typeof body.project !== "string" || !PROJECT_ID.test(body.project)) {
    return refuse("project must be 32 lowercase hex characters");
  }
  if (!KINDS.includes(body.kind)) return refuse("kind is not one of the listed kinds");
  const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!isTime(body.from) || !isTime(body.to) || body.from > body.to) {
    return refuse("from and to must be times in milliseconds, from not after to");
  }

  const counts = {};
  for (const field of FIELDS) {
    const value = body[field];
    if (!Number.isInteger(value) || value < 0 || value > MAX_PER_SEND) {
      return refuse(`${field} must be a whole number from 0 to ${MAX_PER_SEND}`);
    }
    counts[field] = value;
  }
  if (counts.caught > counts.checked || counts.deep > counts.checked) {
    return refuse("caught and deep cannot exceed checked");
  }
  if (FIELDS.every((field) => counts[field] === 0)) return refuse("nothing to add");
  const { project, kind, from, to } = body;
  return { ok: true, send: { project, kind, ...counts, from, to } };
}

/** The country code Cloudflare derived from the request, or "XX" when unknown. */
export function countryOf(request) {
  const country = request.cf?.country;
  return typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : "XX";
}

/** The UTC day of a timestamp, as `YYYY-MM-DD`. */
export function dayOf(timeInMilliseconds) {
  return new Date(timeInMilliseconds).toISOString().slice(0, 10);
}

function refuse(reason) {
  return { ok: false, reason };
}
