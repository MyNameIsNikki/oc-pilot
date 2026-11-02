import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findingsForPrompt, loadSecretIgnore, scanDiff, scanText } from "./secrets.js";
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const OPENAI_KEY = ["sk-proj-", "a".repeat(40)].join("");
function diffWithAdded(lines) {
    return [
        "diff --git a/config.ts b/config.ts",
        "index 1111111..2222222 100644",
        "--- a/config.ts",
        "+++ b/config.ts",
        `@@ -1,2 +1,${lines.length + 2} @@`,
        " const before = true;",
        ...lines.map((line) => `+${line}`),
        " const after = true;",
        "",
    ].join("\n");
}
test("scanDiff detects added secrets with correct line numbers", () => {
    const diff = diffWithAdded([
        `const aws = "${AWS_KEY}";`,
        `const openai = "${OPENAI_KEY}";`,
        'const password = "hunter2hunter2";',
    ]);
    const result = scanDiff(diff);
    assert.equal(result.findings.length, 3);
    assert.deepEqual(result.findings.map((finding) => [finding.line, finding.kind, finding.severity]), [
        [2, "AWS Access Key ID", "critical"],
        [3, "OpenAI API key", "critical"],
        [4, "Generic secret assignment", "warning"],
    ]);
    assert.ok(result.redacted.includes("[REDACTED:AWS Access Key ID]"));
    assert.ok(result.redacted.includes("[REDACTED:OpenAI API key]"));
    assert.ok(result.redacted.includes("[REDACTED:Generic secret assignment]"));
    assert.ok(!result.redacted.includes(AWS_KEY));
    assert.ok(!result.redacted.includes(OPENAI_KEY));
    assert.ok(!result.redacted.includes("hunter2hunter2"));
});
test("scanDiff ignores removed lines and placeholders", () => {
    const diff = [
        "diff --git a/config.ts b/config.ts",
        "--- a/config.ts",
        "+++ b/config.ts",
        "@@ -1,2 +1,3 @@",
        `-const old = "${AWS_KEY}";`,
        ' const password = "${DB_PASSWORD}";',
        ' const token = "changeme";',
        `+const current = "${AWS_KEY}";`,
        "",
    ].join("\n");
    const result = scanDiff(diff);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.line, 3);
    assert.equal(result.findings[0]?.kind, "AWS Access Key ID");
});
test("scanDiff redacts an entire private key block", () => {
    const begin = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
    const end = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
    const diff = [
        "diff --git a/key.pem b/key.pem",
        "--- /dev/null",
        "+++ b/key.pem",
        "@@ -0,0 +1,4 @@",
        `+${begin}`,
        "+MIIEowIBAAKCAQEA...",
        "+...",
        `+${end}`,
        "",
    ].join("\n");
    const result = scanDiff(diff);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.kind, "Private key");
    assert.ok(result.redacted.includes("[REDACTED:Private key block]"));
    assert.ok(!result.redacted.includes("MIIEowIBAAKCAQEA"));
});
test("scanText finds secrets in file content and redacts them", () => {
    const content = [
        "export const config = {",
        `  apiKey: "${AWS_KEY}",`,
        "};",
    ].join("\n");
    const result = scanText(content, "src/config.ts");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.line, 2);
    assert.ok(!result.redacted.includes(AWS_KEY));
});
test("scanText catches dotenv, Discord and Azure credentials", () => {
    const discord = `${"M".repeat(24)}.${"a".repeat(6)}.${"b".repeat(27)}`;
    const accountKey = "A1".repeat(20);
    const content = [
        "DB_PASSWORD=supersecret123",
        `DISCORD_TOKEN=${discord}`,
        `AZURE_STORAGE=DefaultEndpointsProtocol=https;AccountKey=${accountKey};EndpointSuffix=core.windows.net`,
        "TOKEN=${TOKEN}",
        "PASSWORD=changeme",
    ].join("\n");
    const result = scanText(content, ".env");
    assert.deepEqual(result.findings.map((finding) => [finding.line, finding.kind]), [
        [1, "Dotenv secret assignment"],
        [2, "Discord bot token"],
        [3, "Azure Storage account key"],
    ]);
    assert.ok(!result.redacted.includes("supersecret123"));
    assert.ok(!result.redacted.includes(discord));
    assert.ok(!result.redacted.includes(accountKey));
    assert.ok(result.redacted.includes("TOKEN=${TOKEN}"));
});
test("findingsForPrompt describes findings without leaking values", () => {
    const result = scanDiff(diffWithAdded([`const key = "${OPENAI_KEY}";`]));
    const prompt = findingsForPrompt(result.findings, true);
    assert.ok(prompt.includes("SECRET_SCAN"));
    assert.ok(prompt.includes("OpenAI API key"));
    assert.ok(prompt.includes("[CRITICAL]"));
    assert.ok(!prompt.includes(OPENAI_KEY));
    assert.ok(prompt.includes("REDACTED"));
});
test("findingsForPrompt reports a clean scan", () => {
    assert.match(findingsForPrompt([], true), /no secrets/i);
    assert.match(findingsForPrompt([], true, "ru"), /чистых/);
});
test("loadSecretIgnore reads patterns and skips comments and blanks", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-ignore-"));
    try {
        mkdirSync(join(dir, ".oc-pilot"), { recursive: true });
        writeFileSync(join(dir, ".oc-pilot", "ignore"), ["# comment", "", "fixtures/**", "*.snap", "docs/credentials.md"].join("\n"), "utf8");
        assert.deepEqual(loadSecretIgnore(dir), ["fixtures/**", "*.snap", "docs/credentials.md"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("loadSecretIgnore returns empty list without a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-noignore-"));
    try {
        assert.deepEqual(loadSecretIgnore(dir), []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("scanText skips ignored paths but scans the rest", () => {
    const content = `const aws = "${AWS_KEY}";\n`;
    assert.deepEqual(scanText(content, "fixtures/creds.ts", { ignore: ["fixtures/**"] }).findings, []);
    assert.deepEqual(scanText(content, "docs/creds.ts", { ignore: ["docs/**"] }).findings, []);
    assert.notEqual(scanText(content, "src/creds.ts", { ignore: ["fixtures/**"] }).findings.length, 0);
});
test("inline oc-pilot:ignore-secret marker skips a single line", () => {
    const content = [
        `const aws = "${AWS_KEY}"; // oc-pilot:ignore-secret`,
        `const openai = "${OPENAI_KEY}";`,
    ].join("\n");
    const result = scanText(content, "src/config.ts");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.line, 2);
});
test("high-entropy assignments are flagged as critical", () => {
    const token = "f8G2kQ9zL4xW7nR3vB6mD1s";
    const result = scanText(`const apiToken = "${token}";\n`, "src/auth.ts");
    const entropyFinding = result.findings.find((finding) => finding.kind === "High-entropy secret");
    assert.ok(entropyFinding);
    assert.equal(entropyFinding.severity, "critical");
    assert.ok(!result.redacted.includes(token));
});
test("low-entropy long assignments are not flagged as high entropy", () => {
    const result = scanText('const password = "aaaaaaaaaaaaaaaaaaaa";\n', "src/auth.ts");
    assert.ok(!result.findings.some((finding) => finding.kind === "High-entropy secret"));
});
test("entropy check can be disabled", () => {
    const token = "f8G2kQ9zL4xW7nR3vB6mD1s";
    const result = scanText(`const apiToken = "${token}";\n`, "src/auth.ts", { entropy: false });
    assert.ok(!result.findings.some((finding) => finding.kind === "High-entropy secret"));
});
test("scanDiff respects ignore patterns per file header", () => {
    const diff = [
        "diff --git a/vendor/lib.ts b/vendor/lib.ts",
        "index 1111111..2222222 100644",
        "--- a/vendor/lib.ts",
        "+++ b/vendor/lib.ts",
        "@@ -1,2 +1,3 @@",
        " const before = true;",
        `+const aws = "${AWS_KEY}";`,
        " const after = true;",
        "",
    ].join("\n");
    const ignored = scanDiff(diff, { ignore: ["vendor/**"] });
    assert.deepEqual(ignored.findings, []);
    assert.ok(ignored.redacted.includes(AWS_KEY), "ignored files must stay unredacted");
    const scanned = scanDiff(diff, { ignore: ["fixtures/**"] });
    assert.equal(scanned.findings.length, 1);
});
//# sourceMappingURL=secrets.test.js.map