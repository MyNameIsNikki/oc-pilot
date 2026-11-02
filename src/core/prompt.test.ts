import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildInput, buildPrompt, SYSTEM_PROMPT_EN, SYSTEM_PROMPT_RU, systemPromptFor } from "./prompt.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENAI_KEY = ["sk-", "proj-", "A".repeat(40)].join("");

test("buildInput contains the required schema fields", () => {
  const input = buildInput({
    recipe: "review",
    projectType: "Go",
    additionalContext: "type User struct { ID string }",
    diff: "+func f() {}",
    findings: [],
    repoContext: true,
  });

  assert.match(input, /PROJECT_TYPE: Go/);
  assert.match(input, /RECIPE: review/);
  assert.match(input, /REPO_CONTEXT: enabled/);
  assert.match(input, /ADDITIONAL_CONTEXT:/);
  assert.match(input, /GIT_DIFF:/);
  assert.match(input, /OUTPUT SCHEMA/);
  assert.match(input, /response strictly in the OUTPUT SCHEMA/);
});

test("buildInput can mark repo context as disabled", () => {
  const input = buildInput({
    recipe: "review",
    projectType: "Go",
    additionalContext: "",
    diff: "",
    repoContext: false,
  });
  assert.match(input, /REPO_CONTEXT: disabled/);
});

test("buildInput can produce Russian instructions", () => {
  const input = buildInput({
    recipe: "review",
    projectType: "Go",
    additionalContext: "",
    diff: "",
    lang: "ru",
  });
  assert.match(input, /Проанализируй/);
  assert.match(input, /REPO_CONTEXT: enabled/);
});

test("buildInput includes redacted secret findings", () => {
  const input = buildInput({
    recipe: "review",
    projectType: "Go",
    additionalContext: "",
    diff: "",
    findings: [
      {
        file: "wallet.go",
        line: 4,
        kind: "OpenAI API key",
        severity: "critical",
        preview: "sk-p…AAAA",
      },
    ],
  });

  assert.match(input, /SECRET_SCAN/);
  assert.match(input, /OpenAI API key/);
  assert.match(input, /\[CRITICAL\]/);
  assert.ok(!input.includes(OPENAI_KEY));
  assert.match(input, /REDACTED/);
});

test("buildInput places the volatile diff last for provider prefix caching", () => {
  const base = {
    recipe: "review" as const,
    projectType: "Go",
    additionalContext: "type User struct { ID string }",
    findings: [],
  };
  const first = buildInput({ ...base, diff: "+one" });
  const second = buildInput({ ...base, diff: "+two" });

  assert.ok(first.indexOf("GIT_DIFF:") > first.indexOf("SECRET_SCAN"), "diff must come after the secret block");
  const marker = "GIT_DIFF:\n";
  const prefixFirst = first.slice(0, first.indexOf(marker));
  const prefixSecond = second.slice(0, second.indexOf(marker));
  assert.equal(prefixFirst, prefixSecond, "stable prefix must be identical across different diffs");
  assert.ok(prefixFirst.length > 0);
});

test("buildPrompt uses English by default and Russian when requested", () => {
  const base = {
    recipe: "review" as const,
    projectType: "Go",
    additionalContext: "",
    diff: "",
  };

  const english = buildPrompt(base);
  assert.ok(english.startsWith(SYSTEM_PROMPT_EN));
  assert.match(english, /=== INPUT ===/);

  const russian = buildPrompt({ ...base, lang: "ru" });
  assert.ok(russian.startsWith(SYSTEM_PROMPT_RU));
  assert.match(russian, /Проанализируй/);
  assert.equal(systemPromptFor("en"), SYSTEM_PROMPT_EN);
  assert.equal(systemPromptFor("ru"), SYSTEM_PROMPT_RU);
});

test("the English and Russian prompts document all recipes", () => {
  for (const prompt of [SYSTEM_PROMPT_EN, SYSTEM_PROMPT_RU]) {
    for (const recipe of ["review", "test-fix", "docgen", "custom"]) {
      assert.ok(prompt.includes(recipe), `${recipe} missing`);
    }
  }
});

test("prompt files are in sync with the built-in prompts", () => {
  const files = [
    ["en", resolve(ROOT, "prompts", "oc-pilot.en.md")],
    ["ru", resolve(ROOT, "prompts", "oc-pilot.ru.md")],
  ] as const;

  for (const [lang, file] of files) {
    assert.equal(readFileSync(file, "utf8").trim(), systemPromptFor(lang).trim(), `${file} is stale`);
  }
});

test(".opencode agent contains the English prompt", () => {
  const agent = readFileSync(resolve(ROOT, ".opencode", "agents", "oc-pilot.md"), "utf8");
  assert.ok(agent.startsWith("---\n"));
  assert.ok(agent.includes(SYSTEM_PROMPT_EN));
});
