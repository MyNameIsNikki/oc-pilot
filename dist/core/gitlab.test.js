import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gitlabTarget, postMrNote, postMrStatus } from "./gitlab.js";
const MR_ENV = {
    CI_MERGE_REQUEST_IID: "7",
    CI_PROJECT_ID: "42",
    CI_API_V4_URL: "https://gitlab.example.com/api/v4/",
    GITLAB_TOKEN: "secret-token",
};
/** Starts a throwaway GitLab stand-in and returns its base URL plus captured requests. */
async function startGitlab(status = 201) {
    const requests = [];
    const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            requests.push({
                method: request.method,
                path: request.url,
                token: request.headers["private-token"],
                body,
            });
            response.writeHead(status, { "content-type": "application/json" });
            response.end("{}");
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
test("postMrStatus reports the commit status and swallows failures", async () => {
    const server = await startGitlab(201);
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
    const failing = await startGitlab(500);
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