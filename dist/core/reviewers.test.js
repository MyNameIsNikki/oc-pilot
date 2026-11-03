import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runGit } from "../core/git.js";
import { codeownersFor, codeownersPattern, describeReviewers, parseCodeowners, suggestReviewers, } from "./reviewers.js";
function initRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-reviewers-"));
    runGit(["init"], dir);
    return dir;
}
function commit(dir, file, name, email, message = "change") {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${message}\n${Date.now()}${Math.random()}\n`, "utf8");
    runGit(["add", "--", file], dir);
    runGit(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", message, "-q"], dir);
}
test("codeownersPattern anchors patterns with a slash and matches the rest at any depth", () => {
    assert.ok(codeownersPattern("*.ts")?.test("src/deep/a.ts"));
    assert.ok(codeownersPattern("/src/*.ts")?.test("src/a.ts"));
    assert.equal(codeownersPattern("/src/*.ts")?.test("src/deep/a.ts"), false);
    assert.ok(codeownersPattern("/docs/")?.test("docs/guide/a.md"));
    assert.equal(codeownersPattern("/docs/")?.test("src/docs/a.md"), false);
    assert.ok(codeownersPattern("**/*.go")?.test("internal/app/main.go"));
    assert.equal(codeownersPattern("!vendor/**"), undefined);
    assert.equal(codeownersPattern("   "), undefined);
});
test("parseCodeowners skips comments, blank lines and lines without owners", () => {
    const rules = parseCodeowners(["# top comment", "", "* @fallback", "src/** @backend @alice # inline", "/docs/", "/infra/ @ops"].join("\n"));
    assert.deepEqual(rules, [
        { pattern: "*", owners: ["@fallback"] },
        { pattern: "src/**", owners: ["@backend", "@alice"] },
        { pattern: "/infra/", owners: ["@ops"] },
    ]);
});
test("codeownersFor uses the last matching rule and keeps file order", () => {
    const rules = parseCodeowners(["* @fallback", "src/** @backend", "src/api/** @alice"].join("\n"));
    assert.deepEqual(codeownersFor(["src/api/users.ts", "docs/readme.md"], rules), ["@alice", "@fallback"]);
});
test("suggestReviewers ranks authors by commits, files and excludes bots", () => {
    const dir = initRepo();
    try {
        commit(dir, "src/a.ts", "Alice", "alice@example.com", "a1");
        commit(dir, "src/a.ts", "Alice", "alice@example.com", "a2");
        commit(dir, "src/a.ts", "Alice", "alice@example.com", "a3");
        commit(dir, "src/b.ts", "Bob", "bob@example.com", "b1");
        commit(dir, "src/b.ts", "dependabot[bot]", "bot@example.com", "bump");
        const report = suggestReviewers(dir, ["src/a.ts", "src/b.ts"], { limit: 5 });
        assert.deepEqual(report.candidates.map((candidate) => candidate.name), ["Alice", "Bob"]);
        assert.equal(report.candidates[0]?.commits, 3);
        assert.equal(report.candidates[0]?.files, 1);
        assert.equal(report.candidates[1]?.commits, 1);
        assert.equal(report.commitsScanned, 4);
        assert.ok((report.candidates[0]?.share ?? 0) > (report.candidates[1]?.share ?? 0));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("suggestReviewers honours limit, exclude and CODEOWNERS", () => {
    const dir = initRepo();
    try {
        commit(dir, "src/a.ts", "Alice", "alice@example.com", "a1");
        commit(dir, "src/b.ts", "Bob", "bob@example.com", "b1");
        writeFileSync(join(dir, "CODEOWNERS"), "src/** @team/core\n", "utf8");
        const limited = suggestReviewers(dir, ["src/a.ts", "src/b.ts"], { limit: 1 });
        assert.equal(limited.candidates.length, 1);
        assert.deepEqual(limited.codeowners, ["@team/core"]);
        const excluded = suggestReviewers(dir, ["src/a.ts", "src/b.ts"], { exclude: ["bob"] });
        assert.deepEqual(excluded.candidates.map((candidate) => candidate.name), ["Alice"]);
        const text = describeReviewers(limited);
        assert.match(text, /CODEOWNERS: @team\/core/);
        assert.match(text, /Кандидаты в ревьюеры/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("suggestReviewers survives files without history", () => {
    const dir = initRepo();
    try {
        const report = suggestReviewers(dir, ["src/brand-new.ts"]);
        assert.deepEqual(report.candidates, []);
        assert.equal(report.files.length, 1);
        assert.match(describeReviewers(report), /Недостаточно истории/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("suggestReviewers ignores files that are not tracked", () => {
    const dir = initRepo();
    try {
        commit(dir, "src/a.ts", "Alice", "alice@example.com");
        const report = suggestReviewers(dir, ["src/a.ts", join("nested", "ghost.ts")]);
        assert.equal(report.candidates.length, 1);
        assert.equal(report.candidates[0]?.files, 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=reviewers.test.js.map