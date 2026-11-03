import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  gitlabTarget,
  mrDiffRefs,
  postMrDiscussion,
  postMrNote,
  postMrReview,
  postMrStatus,
  resolveDiffRefs,
  type GitlabTarget,
} from "./gitlab.js";

const MR_ENV = {
  CI_MERGE_REQUEST_IID: "7",
  CI_PROJECT_ID: "42",
  CI_API_V4_URL: "https://gitlab.example.com/api/v4/",
  GITLAB_TOKEN: "secret-token",
};

interface Captured {
  method?: string;
  path?: string;
  token?: string;
  body: string;
}

type Responder = (request: Captured) => { status: number; body: unknown };

/** Starts a throwaway GitLab stand-in and returns its base URL plus captured requests. */
async function startGitlab(respond: Responder = () => ({ status: 201, body: {} })): Promise<{
  url: string;
  requests: Captured[];
  close: () => Promise<void>;
}> {
  const requests: Captured[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const item: Captured = {
        method: request.method,
        path: request.url,
        token: request.headers["private-token"] as string | undefined,
        body,
      };
      requests.push(item);
      const answer = respond(item);
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
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

test("mrDiffRefs needs all three SHAs", () => {
  const refs = mrDiffRefs({
    CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
    CI_MERGE_REQUEST_TARGET_BRANCH_SHA: "start",
    CI_COMMIT_SHA: "head",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(refs, { baseSha: "base", startSha: "start", headSha: "head" });

  assert.equal(
    mrDiffRefs({
      CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
      CI_COMMIT_SHA: "head",
    } as NodeJS.ProcessEnv),
    undefined,
  );
  assert.equal(mrDiffRefs({} as NodeJS.ProcessEnv), undefined);
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

test("postMrDiscussion anchors the note to a diff line", async () => {
  const server = await startGitlab();
  try {
    await postMrDiscussion(
      { path: "src/wallet.ts", line: 12, body: "**[Critical]** boom" },
      { baseSha: "base", startSha: "start", headSha: "head" },
      targetFor(server.url),
    );
    assert.equal(server.requests.length, 1);
    const request = server.requests[0]!;
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
  } finally {
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
  } finally {
    await server.close();
  }
});

test("postMrReview posts discussions first and the summary note last", async () => {
  const server = await startGitlab((request) =>
    request.method === "GET"
      ? { status: 200, body: { diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } } }
      : { status: 201, body: {} },
  );
  try {
    const posted = await postMrReview(
      "## summary",
      [
        { path: "src/a.ts", line: 3, body: "first" },
        { path: "src/b.ts", line: 9, body: "second" },
      ],
      "repo",
      targetFor(server.url),
    );

    assert.deepEqual(posted, { posted: true, inline: 2, summary: true });
    const paths = server.requests.map((request) => `${request.method} ${request.path}`);
    assert.deepEqual(paths, [
      "GET /projects/42/merge_requests/7",
      "POST /projects/42/merge_requests/7/discussions",
      "POST /projects/42/merge_requests/7/discussions",
      "POST /projects/42/merge_requests/7/notes",
    ]);
  } finally {
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
    const posted = await postMrReview(
      "## summary",
      [
        { path: "src/a.ts", line: 3, body: "first" },
        { path: "src/b.ts", line: 9, body: "second" },
      ],
      "repo",
      targetFor(server.url),
    );

    assert.deepEqual(posted, { posted: true, inline: 1, summary: true });
  } finally {
    await server.close();
  }
});

test("postMrStatus reports the commit status and swallows failures", async () => {
  const server = await startGitlab();
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

  const failing = await startGitlab(() => ({ status: 500, body: {} }));
  try {
    const ok = await postMrStatus("failed", "blocked", "abc123", targetFor(failing.url));
    assert.equal(ok, false);
  } finally {
    await failing.close();
  }

  assert.equal(await postMrStatus("success", "x", ""), false);
});
