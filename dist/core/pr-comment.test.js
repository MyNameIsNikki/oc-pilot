import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrCommentBody, githubCommentTarget } from "./pr-comment.js";
const SHA = "0123456789abcdef0123456789abcdef01234567";
function finding(severity, index) {
    return { severity, location: `src/file${index}.ts:${index + 1}`, text: `problem number ${index}` };
}
test("an empty findings list produces an LGTM comment", () => {
    const body = buildPrCommentBody([], { sha: SHA });
    assert.ok(body.startsWith("## oc-pilot review"));
    assert.ok(body.includes("No blocking findings. LGTM."));
    assert.match(body, /oc-pilot v\d+\.\d+\.\d+ · commit 0123456789ab/);
});
test("findings are summarized with severity, location and counts", () => {
    const findings = [
        finding("critical", 1),
        finding("critical", 2),
        finding("warning", 3),
    ];
    const body = buildPrCommentBody(findings, { sha: SHA });
    assert.ok(body.includes("Findings: 2 critical · 1 warning · 0 style"));
    assert.ok(body.includes("- [🔴 Critical] `src/file1.ts:2` — problem number 1"));
    assert.ok(body.includes("- [🟡 Warning] `src/file3.ts:4` — problem number 3"));
});
test("long finding lists are capped at 30 bullets", () => {
    const findings = Array.from({ length: 35 }, (_, index) => finding("style", index));
    const body = buildPrCommentBody(findings, { sha: SHA });
    assert.ok(body.includes("…and 5 more"));
    const findingBullets = body.split("\n").filter((line) => line.startsWith("- ["));
    assert.equal(findingBullets.length, 30);
});
test("baseline-hidden findings are mentioned", () => {
    const body = buildPrCommentBody([], { sha: SHA, knownHidden: 2 });
    assert.ok(body.includes("2 finding(s) hidden by the project baseline"));
});
test("githubCommentTarget resolves only inside pull request Actions runs", () => {
    const base = {
        GITHUB_ACTIONS: "true",
        GITHUB_TOKEN: "token-value",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_REF: "refs/pull/42/merge",
        GITHUB_API_URL: "https://api.github.com",
    };
    const target = githubCommentTarget(base);
    assert.ok(target);
    assert.equal(target.repo, "owner/repo");
    assert.equal(target.issue, "42");
    assert.equal(target.apiUrl, "https://api.github.com");
    assert.equal(githubCommentTarget({ ...base, GITHUB_TOKEN: "" }), undefined);
    assert.equal(githubCommentTarget({ ...base, GITHUB_REF: "refs/heads/main" }), undefined);
    assert.equal(githubCommentTarget({ ...base, GITHUB_ACTIONS: "false" }), undefined);
});
//# sourceMappingURL=pr-comment.test.js.map