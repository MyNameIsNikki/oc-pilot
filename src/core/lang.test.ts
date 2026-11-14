import assert from "node:assert/strict";
import { test } from "node:test";
import { isPromptLang, parsePromptLang, PROMPT_LANGS } from "./lang.js";

test("parsePromptLang accepts canonical values and aliases", () => {
  assert.deepEqual(PROMPT_LANGS, ["en", "ru"]);
  assert.equal(isPromptLang("en"), true);
  assert.equal(isPromptLang("de"), false);
  assert.equal(parsePromptLang("EN"), "en");
  assert.equal(parsePromptLang("english"), "en");
  assert.equal(parsePromptLang("ru"), "ru");
  assert.equal(parsePromptLang("Russian"), "ru");
  assert.equal(parsePromptLang("рус"), "ru");
});

test("parsePromptLang rejects an unknown value and lists the allowed languages", () => {
  assert.throws(
    () => parsePromptLang("de", "OC_PILOT_LANG"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /OC_PILOT_LANG/);
      assert.match((error as { hint?: string }).hint ?? "", /en, ru/);
      return true;
    },
  );
});
