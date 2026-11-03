import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildInput, buildPrompt, SYSTEM_PROMPT_EN } from "./prompt.js";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN = join(ROOT, "test", "golden");
const UPDATE = process.env.OC_PILOT_UPDATE_GOLDEN === "1";
const DIFF = [
    "diff --git a/wallet.go b/wallet.go",
    "@@ -10,3 +10,4 @@ func DeductBalance(u *User, amount int) {",
    "-\tu.Balance -= amount",
    "+\tu.Balance -= amount",
    "+\tlog.Info(\"deduct\", amount)",
    " }",
].join("\n");
const BASE = {
    recipe: "review",
    projectType: "Go",
    additionalContext: "type User struct { ID string; Balance int }",
    diff: DIFF,
};
/**
 * The prompt is the CLI contract with every model: section order, empty-value
 * handling and secret redaction must only change on purpose. These snapshots
 * pin the input half of the prompt; the system half is checked against
 * prompts/*.md by prompt.test.ts.
 */
const CASES = [
    { name: "input-review-en.txt", input: { ...BASE, lang: "en", repoContext: true } },
    { name: "input-review-ru.txt", input: { ...BASE, lang: "ru", repoContext: false } },
    {
        name: "input-review-secrets.txt",
        input: {
            ...BASE,
            findings: [
                {
                    file: "wallet.go",
                    line: 4,
                    kind: "OpenAI API key",
                    severity: "critical",
                    preview: "sk-p…AAAA",
                },
            ],
        },
    },
    {
        name: "input-empty-commit.txt",
        input: { recipe: "commit", projectType: "Go", additionalContext: "", diff: "" },
    },
];
for (const item of CASES) {
    test(`golden ${item.name} matches the built input`, () => {
        const path = join(GOLDEN, item.name);
        const actual = `${buildInput(item.input)}\n`;
        if (UPDATE) {
            mkdirSync(GOLDEN, { recursive: true });
            writeFileSync(path, actual, "utf8");
            return;
        }
        assert.ok(existsSync(path), `${item.name} is missing; run OC_PILOT_UPDATE_GOLDEN=1 npm test`);
        const expected = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
        assert.equal(actual, expected, `${item.name} drifted; regenerate with OC_PILOT_UPDATE_GOLDEN=1 when the change is intended`);
    });
}
test("every recipe reaches the model with its own RECIPE line", () => {
    for (const recipe of ["review", "test-fix", "docgen", "custom", "commit"]) {
        const text = buildPrompt({ ...BASE, recipe });
        assert.ok(text.includes(`RECIPE: ${recipe}\n`), `${recipe} is not named in the input`);
        assert.ok(text.startsWith(SYSTEM_PROMPT_EN), `${recipe} lost the system prompt`);
    }
});
//# sourceMappingURL=prompt.golden.test.js.map