import assert from "node:assert/strict";
import test from "node:test";
import { buildInlineComments, commentedDiffLines, postPrStatus } from "./pr-review.js";
const DIFF = [
    "diff --git a/src/wallet.ts b/src/wallet.ts",
    "index 1111111..2222222 100644",
    "--- a/src/wallet.ts",
    "+++ b/src/wallet.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const old = 2;",
    "+const next = 3;",
    "+const extra = 4;",
    " export {};",
].join("\n");
function finding(location, severity = "critical") {
    return { severity, text: "problem here", ...(location ? { location } : {}) };
}
test("commentedDiffLines keeps added and context lines only", () => {
    const lines = commentedDiffLines(DIFF);
    assert.deepEqual([...lines.keys()], ["src/wallet.ts"]);
    assert.deepEqual([...lines.get("src/wallet.ts")].sort((a, b) => a - b), [1, 2, 3, 4]);
});
test("buildInlineComments pins findings to diff lines", () => {
    const comments = buildInlineComments([
        finding("src/wallet.ts:2"),
        finding("src/wallet.ts:3:7"),
        finding("src/wallet.ts:9"),
        finding("src/other.ts:1"),
        finding(undefined),
    ], DIFF);
    assert.equal(comments.length, 2);
    assert.deepEqual(comments.map((comment) => `${comment.path}:${comment.line}`), ["src/wallet.ts:2", "src/wallet.ts:3"]);
    assert.match(comments[0].body, /Critical/);
    assert.match(comments[0].body, /problem here/);
});
test("buildInlineComments normalizes windows separators and leading ./ in paths", () => {
    const windows = buildInlineComments([finding(".\\src\\wallet.ts:2")], DIFF);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].path, "src/wallet.ts");
    const dotted = buildInlineComments([finding("./src/wallet.ts:2")], DIFF);
    assert.equal(dotted.length, 1);
    assert.equal(dotted[0].path, "src/wallet.ts");
});
test("buildInlineComments caps the number of comments", () => {
    const many = Array.from({ length: 40 }, () => finding("src/wallet.ts:2"));
    assert.equal(buildInlineComments(many, DIFF).length, 25);
});
test("postPrStatus reports nothing outside a pull-request Actions job", async () => {
    const previous = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;
    try {
        assert.equal(await postPrStatus("success", "looks good", "abc123"), false);
    }
    finally {
        if (previous === undefined)
            delete process.env.GITHUB_ACTIONS;
        else
            process.env.GITHUB_ACTIONS = previous;
    }
});
//# sourceMappingURL=pr-review.test.js.map