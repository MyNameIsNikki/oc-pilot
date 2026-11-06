import assert from "node:assert/strict";
import test from "node:test";
import { buildRoastContext, parsePersona } from "./roast.js";

test("parsePersona accepts known personas and falls back to linus", () => {
  assert.equal(parsePersona("ramsay"), "ramsay");
  assert.equal(parsePersona("CORPORATE"), "corporate");
  assert.equal(parsePersona("default"), "default");
  assert.equal(parsePersona("unknown"), "linus");
  assert.equal(parsePersona(undefined), "linus");
});

test("buildRoastContext pins the persona and safety rules", () => {
  const context = buildRoastContext("ramsay", "the retry loop ignores backoff");
  assert.match(context, /ROAST_MODE/);
  assert.match(context, /ROAST_PERSONA: ramsay/);
  assert.match(context, /file:line/);
  assert.match(context, /never use slurs/i);
  assert.match(context, /the retry loop ignores backoff/);
});
