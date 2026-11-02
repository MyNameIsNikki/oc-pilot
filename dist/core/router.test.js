import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "./config.js";
import { parseFindings } from "./findings.js";
import { parseTriageDecision } from "./router.js";
import { executeRecipeDetailed } from "./run.js";
const REVIEW_RESPONSE = [
    "### Analysis: Found one issue.",
    "",
    "#### Findings / Actions",
    "- **[🔴 Critical `wallet.go:10`]: nil dereference",
    "",
    "#### Solution",
    "```go",
    "if u == nil {",
    "```",
    "",
].join("\n");
const DIFF = ["diff --git a/wallet.go b/wallet.go", "--- a/wallet.go", "+++ b/wallet.go", "@@ -1 +1 @@", "+u.Balance -= amount", ""].join("\n");
test("parseTriageDecision reads the machine-readable triage line", () => {
    assert.equal(parseTriageDecision("TRIAGE: REVIEW"), "review");
    assert.equal(parseTriageDecision("TRIAGE: LGTM"), "lgtm");
    assert.equal(parseTriageDecision("Sure!\nTRIAGE: lgtm\n"), "lgtm");
    assert.equal(parseTriageDecision("looks good to me"), "unknown");
    assert.equal(parseTriageDecision(""), "unknown");
});
async function startRouterServer(triageText) {
    const models = [];
    let requests = 0;
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            requests += 1;
            const parsed = JSON.parse(body);
            models.push(parsed.model ?? "");
            const isTriage = parsed.model === "triage-model";
            const content = isTriage ? triageText : REVIEW_RESPONSE;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ choices: [{ message: { content } }] }));
        });
    });
    const url = await new Promise((resolvePromise) => {
        server.listen(0, "127.0.0.1", () => {
            resolvePromise(`http://127.0.0.1:${server.address().port}/v1`);
        });
    });
    return {
        url,
        get requests() {
            return requests;
        },
        models,
        close: () => server.close(),
    };
}
function buildCtx(url) {
    return {
        cwd: process.cwd(),
        config: {
            ...DEFAULT_CONFIG,
            engine: "openai",
            baseUrl: url,
            model: "main-model",
            timeoutSeconds: 30,
            repoContext: false,
        },
        flags: { cwd: process.cwd(), json: false, dryRun: false, verbose: false, strict: false, github: false },
    };
}
test("router LGTM skips the main model call", async () => {
    const server = await startRouterServer("TRIAGE: LGTM");
    try {
        const execution = await executeRecipeDetailed({
            recipe: "review",
            projectType: "Go",
            additionalContext: "",
            diff: DIFF,
            secretFindings: [],
            changedFiles: ["wallet.go"],
        }, buildCtx(server.url), { capture: true, router: { enabled: true, model: "triage-model" } });
        assert.equal(server.requests, 1);
        assert.equal(server.models[0], "triage-model");
        assert.equal(execution.analysis, "LGTM: no critical issues found.");
        assert.equal(execution.meta?.router?.decision, "lgtm");
        assert.equal(execution.meta?.router?.model, "triage-model");
        assert.equal(execution.exitCode, 0);
    }
    finally {
        server.close();
    }
});
test("router REVIEW runs the main model after triage", async () => {
    const server = await startRouterServer("TRIAGE: REVIEW");
    try {
        const execution = await executeRecipeDetailed({
            recipe: "review",
            projectType: "Go",
            additionalContext: "",
            diff: DIFF,
            secretFindings: [],
            changedFiles: ["wallet.go"],
        }, buildCtx(server.url), { capture: true, router: { enabled: true, model: "triage-model" } });
        assert.equal(server.requests, 2);
        assert.deepEqual(server.models, ["triage-model", "main-model"]);
        assert.equal(execution.meta?.router?.decision, "review");
        assert.equal(parseFindings(execution.analysis ?? "").length, 1);
        assert.equal(execution.exitCode, 0);
    }
    finally {
        server.close();
    }
});
test("router is off by default and leaves no meta", async () => {
    const server = await startRouterServer("TRIAGE: LGTM");
    try {
        const execution = await executeRecipeDetailed({
            recipe: "review",
            projectType: "Go",
            additionalContext: "",
            diff: DIFF,
            secretFindings: [],
            changedFiles: ["wallet.go"],
        }, buildCtx(server.url), { capture: true });
        assert.equal(server.requests, 1);
        assert.equal(server.models[0], "main-model");
        assert.equal(execution.meta?.router, undefined);
    }
    finally {
        server.close();
    }
});
test("unparsable triage answer falls back to the full review", async () => {
    const server = await startRouterServer("looks fine to me, ship it");
    try {
        const execution = await executeRecipeDetailed({
            recipe: "review",
            projectType: "Go",
            additionalContext: "",
            diff: DIFF,
            secretFindings: [],
            changedFiles: ["wallet.go"],
        }, buildCtx(server.url), { capture: true, router: { enabled: true, model: "triage-model" } });
        assert.equal(server.requests, 2);
        const router = execution.meta?.router;
        assert.equal(router.decision, "review");
        assert.equal(router.fallback, true);
        assert.equal(parseFindings(execution.analysis ?? "").length, 1);
    }
    finally {
        server.close();
    }
});
//# sourceMappingURL=router.test.js.map