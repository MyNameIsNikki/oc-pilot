import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gitlabTarget, mrDiffRefs, postMrDiscussion, postMrNote, postMrReview, postMrStatus, resolveDiffRefs, } from "./gitlab.js";
const MR_ENV = {
    CI_MERGE_REQUEST_IID: "7",
    CI_PROJECT_ID: "42",
    CI_API_V4_URL: "https://gitlab.example.com/api/v4/",
    GITLAB_TOKEN: "secret-token",
};
/** Starts a throwaway GitLab stand-in and returns its base URL plus captured requests. */
async function startGitlab(respond = () => ({ status: 201, body: {} })) {
    const requests = [];
    const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            const item = {
                method: request.method,
                path: request.url,
                token: request.headers["private-token"],
                body,
            };
            requests.push(item);
            const answer = respond(item);
            response.writeHead(answer.status, { "content-type": "application/json" });
            response.end(JSON.stringify(answer.body));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
function targetFor(url) {
    return { projectId: "42", iid: "7", token: "secret-token", apiUrl: url };
}
test("gitlabTarget reads the merge request environment", () => {
    const target = gitlabTarget({ ...MR_ENV });
    assert.deepEqual(target, {
        projectId: "42",
        iid: "7",
        token: "secret-token",
        apiUrl: "https://gitlab.example.com/api/v4",
    });
    assert.equal(gitlabTarget({ ...MR_ENV, GITLAB_TOKEN: undefined }), undefined);
    assert.equal(gitlabTarget({ ...MR_ENV, CI_MERGE_REQUEST_IID: "" }), undefined);
    assert.equal(gitlabTarget({}), undefined);
    const jobToken = gitlabTarget({
        ...MR_ENV,
        GITLAB_TOKEN: undefined,
        CI_JOB_TOKEN: "job-token",
    });
    assert.equal(jobToken?.token, "job-token");
});
test("mrDiffRefs needs all three SHAs", () => {
    const refs = mrDiffRefs({
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
        CI_MERGE_REQUEST_TARGET_BRANCH_SHA: "start",
        CI_COMMIT_SHA: "head",
    });
    assert.deepEqual(refs, { baseSha: "base", startSha: "start", headSha: "head" });
    assert.equal(mrDiffRefs({
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
        CI_COMMIT_SHA: "head",
    }), undefined);
    assert.equal(mrDiffRefs({}), undefined);
});
test("postMrNote posts a merge request note with the private token", async () => {
    const server = await startGitlab();
    try {
        await postMrNote("## oc-pilot review", targetFor(server.url));
        assert.equal(server.requests.length, 1);
        const request = server.requests[0];
        assert.equal(request.method, "POST");
        assert.equal(request.path, "/projects/42/merge_requests/7/notes");
        assert.equal(request.token, "secret-token");
        assert.deepEqual(JSON.parse(request.body), { body: "## oc-pilot review" });
    }
    finally {
        await server.close();
    }
});
test("postMrDiscussion anchors the note to a diff line", async () => {
    const server = await startGitlab();
    try {
        await postMrDiscussion({ path: "src/wallet.ts", line: 12, body: "**[Critical]** boom" }, { baseSha: "base", startSha: "start", headSha: "head" }, targetFor(server.url));
        assert.equal(server.requests.length, 1);
        const request = server.requests[0];
        assert.equal(request.method, "POST");
        assert.equal(request.path, "/projects/42/merge_requests/7/discussions");
        assert.deepEqual(JSON.parse(request.body), {
            body: "**[Critical]** boom",
            position: {
                position_type: "text",
                base_sha: "base",
                start_sha: "start",
                head_sha: "head",
                new_path: "src/wallet.ts",
                new_line: 12,
            },
        });
    }
    finally {
        await server.close();
    }
});
test("resolveDiffRefs falls back to the merge request diff_refs", async () => {
    const server = await startGitlab(() => ({
        status: 200,
        body: { diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } },
    }));
    try {
        const refs = await resolveDiffRefs(targetFor(server.url));
        assert.deepEqual(refs, { baseSha: "b", startSha: "s", headSha: "h" });
        assert.equal(server.requests[0]?.method, "GET");
        assert.equal(server.requests[0]?.path, "/projects/42/merge_requests/7");
    }
    finally {
        await server.close();
    }
});
test("postMrReview posts discussions first and the summary note last", async () => {
    const server = await startGitlab((request) => request.method === "GET"
        ? { status: 200, body: { diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } } }
        : { status: 201, body: {} });
    try {
        const posted = await postMrReview("## summary", [
            { path: "src/a.ts", line: 3, body: "first" },
            { path: "src/b.ts", line: 9, body: "second" },
        ], "repo", targetFor(server.url));
        assert.deepEqual(posted, { posted: true, inline: 2, summary: true });
        const paths = server.requests.map((request) => `${request.method} ${request.path}`);
        assert.deepEqual(paths, [
            "GET /projects/42/merge_requests/7",
            "POST /projects/42/merge_requests/7/discussions",
            "POST /projects/42/merge_requests/7/discussions",
            "POST /projects/42/merge_requests/7/notes",
        ]);
    }
    finally {
        await server.close();
    }
});
test("postMrReview keeps going when one discussion is rejected", async () => {
    let discussions = 0;
    const server = await startGitlab((request) => {
        if (request.method === "GET") {
            return { status: 200, body: { diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } } };
        }
        if (request.path?.endsWith("/discussions")) {
            discussions += 1;
            return discussions === 1 ? { status: 400, body: { message: "position is invalid" } } : { status: 201, body: {} };
        }
        return { status: 201, body: {} };
    });
    try {
        const posted = await postMrReview("## summary", [
            { path: "src/a.ts", line: 3, body: "first" },
            { path: "src/b.ts", line: 9, body: "second" },
        ], "repo", targetFor(server.url));
        assert.deepEqual(posted, { posted: true, inline: 1, summary: true });
    }
    finally {
        await server.close();
    }
});
test("postMrStatus reports the commit status and swallows failures", async () => {
    const server = await startGitlab();
    try {
        const ok = await postMrStatus("success", "all clear", "abc123", targetFor(server.url));
        assert.equal(ok, true);
        const request = server.requests[0];
        assert.equal(request.path, "/projects/42/statuses/abc123");
        const payload = JSON.parse(request.body);
        assert.equal(payload.state, "success");
        assert.equal(payload.name, "oc-pilot");
        assert.equal(payload.description, "all clear");
    }
    finally {
        await server.close();
    }
    const failing = await startGitlab(() => ({ status: 500, body: {} }));
    try {
        const ok = await postMrStatus("failed", "blocked", "abc123", targetFor(failing.url));
        assert.equal(ok, false);
    }
    finally {
        await failing.close();
    }
    assert.equal(await postMrStatus("success", "x", ""), false);
});
//# sourceMappingURL=gitlab.test.js.map