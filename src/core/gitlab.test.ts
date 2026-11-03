import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { gitlabTarget, postMrNote, postMrStatus, type GitlabTarget } from "./gitlab.js";

const MR_ENV = {
  CI_MERGE_REQUEST_IID: "7",
  CI_PROJECT_ID: "42",
  CI_API_V4_URL: "https://gitlab.example.com/api/v4/",
  GITLAB_TOKEN: "secret-token",
};

/** Starts a throwaway GitLab stand-in and returns its base URL plus captured requests. */
async function startGitlab(status = 201): Promise<{
  url: string;
  requests: Array<{ method?: string; path?: string; token?: string; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method?: string; path?: string; token?: string; body: string }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        token: request.headers["private-token"] as string | undefined,
        body,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function targetFor(url: string): GitlabTarget {
  return { projectId: "42", iid: "7", token: "secret-token", apiUrl: url };
}

test("gitlabTarget reads the merge request environment", () => {
  const target = gitlabTarget({ ...MR_ENV } as NodeJS.ProcessEnv);
  assert.deepEqual(target, {
    projectId: "42",
    iid: "7",
    token: "secret-token",
    apiUrl: "https://gitlab.example.com/api/v4",
  });

  assert.equal(gitlabTarget({ ...MR_ENV, GITLAB_TOKEN: undefined } as NodeJS.ProcessEnv), undefined);
  assert.equal(gitlabTarget({ ...MR_ENV, CI_MERGE_REQUEST_IID: "" } as NodeJS.ProcessEnv), undefined);
  assert.equal(gitlabTarget({} as NodeJS.ProcessEnv), undefined);

  const jobToken = gitlabTarget({
    ...MR_ENV,
    GITLAB_TOKEN: undefined,
    CI_JOB_TOKEN: "job-token",
  } as NodeJS.ProcessEnv);
  assert.equal(jobToken?.token, "job-token");
});

test("postMrNote posts a merge request note with the private token", async () => {
  const server = await startGitlab();
  try {
    await postMrNote("## oc-pilot review", targetFor(server.url));
    assert.equal(server.requests.length, 1);
    const request = server.requests[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/projects/42/merge_requests/7/notes");
    assert.equal(request.token, "secret-token");
    assert.deepEqual(JSON.parse(request.body), { body: "## oc-pilot review" });
  } finally {
    await server.close();
  }
});

test("postMrStatus reports the commit status and swallows failures", async () => {
  const server = await startGitlab(201);
  try {
    const ok = await postMrStatus("success", "all clear", "abc123", targetFor(server.url));
    assert.equal(ok, true);
    const request = server.requests[0]!;
    assert.equal(request.path, "/projects/42/statuses/abc123");
    const payload = JSON.parse(request.body) as { state: string; name: string; description: string };
    assert.equal(payload.state, "success");
    assert.equal(payload.name, "oc-pilot");
    assert.equal(payload.description, "all clear");
  } finally {
    await server.close();
  }

  const failing = await startGitlab(500);
  try {
    const ok = await postMrStatus("failed", "blocked", "abc123", targetFor(failing.url));
    assert.equal(ok, false);
  } finally {
    await failing.close();
  }

  assert.equal(await postMrStatus("success", "x", ""), false);
});
