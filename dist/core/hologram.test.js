import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildHologram, zoomSymbol } from "./hologram.js";
function git(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-hologram-"));
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@example.com"], dir);
    git(["config", "user.name", "Test"], dir);
    git(["config", "core.autocrlf", "false"], dir);
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    return dir;
}
const CHANGED = [
    'import { helper } from "./b";',
    "",
    "export function run(input: string): number {",
    "  return helper(input);",
    "}",
    "",
].join("\n");
const HELPER = [
    "/** Returns one when the fetch succeeds. */",
    "export function helper(input: string): number {",
    "  const response = fetch(input);",
    "  return response ? 1 : 0;",
    "}",
    "",
    "export function clean(): number {",
    "  return 42;",
    "}",
    "",
].join("\n");
test("buildHologram assigns LOD 0, 1 and 2 and cuts bodies", () => {
    const dir = makeRepo({
        "src/a.ts": CHANGED,
        "src/b.ts": HELPER,
        "src/b.test.ts": 'it("helper handles input", () => {\n  expect(helper("x")).toBe(1);\n});\n',
        "src/c.ts": "export const far = 1;\nexport function never() {\n  return 2;\n}\n",
    });
    try {
        const report = buildHologram(dir, { diff: "", changedFiles: ["src/a.ts"], maxTokens: 30_000 });
        const byFile = new Map(report.files.map((file) => [file.file, file]));
        assert.equal(byFile.get("src/a.ts")?.lod, 0);
        assert.equal(byFile.get("src/b.ts")?.lod, 1);
        assert.equal(byFile.get("src/c.ts")?.lod, 2);
        assert.match(report.content, /return helper\(input\)/);
        assert.match(report.content, /body hidden \(LOD 1\)/);
        assert.match(report.content, /EFFECTS\(fetch\)/);
        assert.match(report.content, /Returns one when the fetch succeeds/);
        assert.ok(!report.content.includes("const response = fetch(input)"));
        assert.match(report.content, /#### Тесты: helper/);
        assert.match(report.content, /helper handles input/);
        assert.match(report.content, /LOD 2: только имена экспортов/);
        assert.match(report.content, /- far/);
        assert.ok(!report.content.includes("return 2"));
        assert.ok(report.zoom.some((entry) => entry.file === "src/b.ts" && entry.symbol === "helper"));
        assert.match(report.content, /zoom_symbol\(filePath, symbolName\)/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildHologram bails out to full text when braces do not match", () => {
    const dir = makeRepo({
        "src/a.ts": 'import { broken } from "./broken";\n\nexport const run = broken;\n',
        "src/broken.ts": "export function broken(): number {\n  if (true) {\n    return 1;\n",
        "src/c.ts": "export const far = 1;\n",
    });
    try {
        const report = buildHologram(dir, { diff: "", changedFiles: ["src/a.ts"] });
        assert.match(report.content, /\[Hologram: parse bailout\]/);
        assert.match(report.content, /return 1/);
        assert.equal(report.files.find((file) => file.file === "src/broken.ts")?.bailout, true);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("buildHologram redacts secrets found in the final context", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const dir = makeRepo({
        "src/a.ts": `// ${token}\nexport const run = 1;\n`,
        "src/c.ts": "export const far = 1;\n",
    });
    try {
        const report = buildHologram(dir, { diff: "", changedFiles: ["src/a.ts"] });
        assert.ok(report.secretFindings > 0);
        assert.ok(!report.content.includes(token));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("zoomSymbol returns one full body and rejects unknown symbols", () => {
    const dir = makeRepo({ "src/b.ts": HELPER });
    try {
        const result = zoomSymbol(dir, "src/b.ts", "helper");
        assert.equal(result.symbol, "helper");
        assert.equal(result.kind, "function");
        assert.equal(result.line, 2);
        assert.match(result.body, /const response = fetch\(input\)/);
        assert.throws(() => zoomSymbol(dir, "src/b.ts", "missing"), /Символ не найден/);
        assert.throws(() => zoomSymbol(dir, "../outside.ts", "helper"), /за пределы проекта/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=hologram.test.js.map