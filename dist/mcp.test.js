import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { applyResultOptions, patchSummary } from "./mcp.js";
const MCP = resolve("dist/mcp.js");
const CLI = resolve("dist/cli.js");
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
function runServer(dir, requests, args = []) {
    const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
    const result = spawnSync(process.execPath, [MCP, "--cwd", dir, ...args], {
        input,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
    });
    const responses = (result.stdout ?? "")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return { status: result.status, responses, stderr: result.stderr ?? "" };
}
test("MCP initialize, tools/list and tools/call work over stdio", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-"));
    try {
        const diffPath = join(dir, "changes.diff");
        writeFileSync(diffPath, [
            "diff --git a/wallet.go b/wallet.go",
            "--- a/wallet.go",
            "+++ b/wallet.go",
            "@@ -1,1 +1,2 @@",
            " package wallet",
            `+const apiKey = "${AWS_KEY}"`,
            "",
        ].join("\n"));
        const { status, responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "scan", arguments: { diff: readFileSync(diffPath, "utf8") } },
            },
            { jsonrpc: "2.0", id: 4, method: "does/not/exist" },
        ]);
        assert.equal(status, 0, stderr);
        const byId = new Map(responses.map((response) => [response.id, response]));
        const init = byId.get(1)?.result;
        assert.equal(init?.serverInfo?.name, "oc-pilot");
        assert.equal(init?.protocolVersion, "2025-06-18");
        const list = byId.get(2)?.result;
        const names = new Set(list?.tools?.map((tool) => tool.name));
        for (const name of ["review", "test_fix", "fix", "docgen", "custom", "scan"])
            assert.ok(names.has(name), name);
        const scan = byId.get(3)?.result;
        assert.equal(scan?.isError, false);
        assert.ok(scan?.structuredContent?.findings?.some((finding) => finding.kind === "AWS Access Key ID"));
        assert.ok(scan?.content?.some((part) => part.type === "text" && part.text.includes("AWS Access Key ID")));
        assert.ok(!(scan?.content?.[0]?.text ?? "").includes(AWS_KEY));
        assert.equal(byId.get(4)?.error?.code, -32601);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP is read-only by default and rejects paths outside the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-policy-"));
    try {
        const { status, responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "review", arguments: { diff: "diff --git a/a b/a\n", paths: ["../outside"] } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "fix", arguments: { diff: "diff --git a/a b/a\n", apply: true } },
            },
            {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "test_fix", arguments: { diff: "diff --git a/a b/a\n" } },
            },
            {
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: { name: "sast", arguments: { paths: ["app.js"], update_baseline: true } },
            },
            {
                jsonrpc: "2.0",
                id: 5,
                method: "tools/call",
                params: { name: "mutate", arguments: { max_mutants: 1 } },
            },
            {
                jsonrpc: "2.0",
                id: 6,
                method: "tools/call",
                params: { name: "deps", arguments: { fix: true } },
            },
            {
                jsonrpc: "2.0",
                id: 7,
                method: "tools/call",
                params: { name: "test_gen", arguments: { apply: true } },
            },
        ], []);
        assert.equal(status, 0, stderr);
        const byId = new Map(responses.map((response) => [response.id, response]));
        const pathResult = byId.get(1)?.result;
        assert.equal(pathResult?.isError, true);
        assert.match(pathResult?.content?.[0]?.text ?? "", /inside the project/);
        const fixResult = byId.get(2)?.result;
        assert.equal(fixResult?.isError, true);
        assert.match(fixResult?.content?.[0]?.text ?? "", /read-only/);
        const testResult = byId.get(3)?.result;
        assert.equal(testResult?.isError, true);
        assert.match(testResult?.content?.[0]?.text ?? "", /read-only/);
        const baselineResult = byId.get(4)?.result;
        assert.equal(baselineResult?.isError, true);
        assert.match(baselineResult?.content?.[0]?.text ?? "", /read-only/);
        const mutateResult = byId.get(5)?.result;
        assert.equal(mutateResult?.isError, true);
        assert.match(mutateResult?.content?.[0]?.text ?? "", /read-only/);
        const depsResult = byId.get(6)?.result;
        assert.equal(depsResult?.isError, true);
        assert.match(depsResult?.content?.[0]?.text ?? "", /read-only/);
        const testGenResult = byId.get(7)?.result;
        assert.equal(testGenResult?.isError, true);
        assert.match(testGenResult?.content?.[0]?.text ?? "", /read-only/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP rejects malformed JSON without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-"));
    try {
        const result = spawnSync(process.execPath, [MCP, "--cwd", dir], {
            input: "{not json\n",
            encoding: "utf8",
            timeout: 30_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const response = JSON.parse(result.stdout.trim());
        assert.equal(response.error?.code, -32700);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP exposes resources and resource templates", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-res-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "core.autocrlf", "false"]);
        writeFileSync(join(dir, "a.txt"), "v1\n");
        writeFileSync(join(dir, "sample.txt"), `const key = "${AWS_KEY}"\n`);
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        writeFileSync(join(dir, "a.txt"), `v2\nconst key = "${AWS_KEY}"\n`);
        git(["add", "a.txt"]);
        const { status, responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            { jsonrpc: "2.0", id: 2, method: "resources/list" },
            { jsonrpc: "2.0", id: 3, method: "resources/templates/list" },
            { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "oc-pilot://config" } },
            { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "oc-pilot://prompt/en" } },
            { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "oc-pilot://diff/staged" } },
            { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "oc-pilot://scan/staged" } },
            { jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "oc-pilot://file/sample.txt" } },
            { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "oc-pilot://file/..%2Fescape.txt" } },
            { jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "oc-pilot://unknown" } },
        ]);
        assert.equal(status, 0, stderr);
        const byId = new Map(responses.map((response) => [response.id, response]));
        const init = byId.get(1)?.result;
        assert.ok(init?.capabilities?.resources, "resources capability missing");
        assert.ok(init?.capabilities?.resourceTemplates, "resourceTemplates capability missing");
        const list = byId.get(2)?.result;
        const uris = new Set(list?.resources?.map((resource) => resource.uri));
        for (const uri of ["oc-pilot://config", "oc-pilot://rules", "oc-pilot://version", "oc-pilot://prompt/en", "oc-pilot://prompt/ru"]) {
            assert.ok(uris.has(uri), uri);
        }
        const templates = byId.get(3)?.result;
        const templateIds = new Set(templates?.resourceTemplates?.map((template) => template.uriTemplate));
        for (const template of ["oc-pilot://diff/{mode}", "oc-pilot://scan/{mode}", "oc-pilot://file/{+path}"]) {
            assert.ok(templateIds.has(template), template);
        }
        const config = byId.get(4)?.result;
        const configJson = JSON.parse(config?.contents?.[0]?.text ?? "{}");
        assert.equal(configJson.config?.engine, "opencode");
        const prompt = byId.get(5)?.result;
        assert.match(prompt?.contents?.[0]?.text ?? "", /ROLE AND GOAL/);
        const diff = byId.get(6)?.result;
        const diffText = diff?.contents?.[0]?.text ?? "";
        assert.match(diffText, /\+v2/);
        assert.ok(!diffText.includes(AWS_KEY), "diff resource must redact secrets");
        const scan = byId.get(7)?.result;
        const scanText = scan?.contents?.[0]?.text ?? "";
        assert.match(scanText, /AWS Access Key ID/);
        assert.ok(!scanText.includes(AWS_KEY), "scan resource must not leak the raw secret");
        const file = byId.get(8)?.result;
        const fileText = file?.contents?.[0]?.text ?? "";
        assert.match(fileText, /REDACTED/);
        assert.ok(!fileText.includes(AWS_KEY), "file resource must redact secrets");
        assert.equal(byId.get(9)?.error?.code, -32002);
        assert.match(byId.get(9)?.error?.message ?? "", /inside the project/);
        assert.equal(byId.get(10)?.error?.code, -32002);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP advertises slop and result caps in tools/list", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-tools-"));
    try {
        const { responses } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ]);
        const tools = responses.find((response) => response.id === 2)?.result?.tools ?? [];
        const slop = tools.find((tool) => tool.name === "slop");
        assert.ok(slop, "slop tool missing");
        assert.ok(slop.inputSchema.properties.max_findings, "max_findings missing on slop");
        assert.ok(slop.inputSchema.properties.verbosity, "verbosity missing on slop");
        const review = tools.find((tool) => tool.name === "review");
        assert.ok(review?.inputSchema.properties.max_findings, "max_findings missing on review");
        const preflight = tools.find((tool) => tool.name === "preflight");
        assert.ok(preflight, "preflight tool missing");
        assert.ok(preflight.inputSchema.properties.max_delta, "max_delta missing on preflight");
        assert.ok(preflight.inputSchema.properties.fail_on_issue, "fail_on_issue missing on preflight");
        assert.ok(preflight.inputSchema.properties.no_sast, "no_sast missing on preflight");
        assert.ok(preflight.inputSchema.properties.no_authz, "no_authz missing on preflight");
        const mutate = tools.find((tool) => tool.name === "mutate");
        assert.ok(mutate, "mutate tool missing");
        assert.ok(mutate.inputSchema.properties.max_mutants, "max_mutants missing on mutate");
        assert.ok(mutate.inputSchema.properties.min_score, "min_score missing on mutate");
        const flaky = tools.find((tool) => tool.name === "flaky");
        assert.ok(flaky, "flaky tool missing");
        assert.ok(flaky.inputSchema.properties.runs, "runs missing on flaky");
        assert.ok(flaky.inputSchema.properties.fail_on_flaky, "fail_on_flaky missing on flaky");
        assert.ok(flaky.inputSchema.properties.shuffle, "shuffle missing on flaky");
        assert.ok(flaky.inputSchema.properties.seed, "seed missing on flaky");
        const impact = tools.find((tool) => tool.name === "impact");
        assert.ok(impact, "impact tool missing");
        assert.ok(impact.inputSchema.properties.base, "base missing on impact");
        assert.ok(impact.inputSchema.properties.staged, "staged missing on impact");
        assert.ok(impact.inputSchema.properties.paths, "paths missing on impact");
        const deps = tools.find((tool) => tool.name === "deps");
        assert.ok(deps, "deps tool missing");
        assert.ok(deps.inputSchema.properties.fail_on_issue, "fail_on_issue missing on deps");
        assert.ok(deps.inputSchema.properties.fix, "fix missing on deps");
        assert.ok(deps.inputSchema.properties.sbom, "sbom missing on deps");
        const coverage = tools.find((tool) => tool.name === "coverage");
        assert.ok(coverage, "coverage tool missing");
        assert.ok(coverage.inputSchema.properties.coverage_file, "coverage_file missing on coverage");
        assert.ok(coverage.inputSchema.properties.fail_under, "fail_under missing on coverage");
        assert.ok(coverage.inputSchema.properties.max_uncovered, "max_uncovered missing on coverage");
        const testGen = tools.find((tool) => tool.name === "test_gen");
        assert.ok(testGen, "test_gen tool missing");
        assert.ok(testGen.inputSchema.properties.apply, "apply missing on test_gen");
        assert.ok(testGen.inputSchema.properties.no_run, "no_run missing on test_gen");
        assert.ok(testGen.inputSchema.properties.coverage, "coverage missing on test_gen");
        assert.ok(testGen.inputSchema.properties.from_slop, "from_slop missing on test_gen");
        assert.ok(testGen.inputSchema.properties.rounds, "rounds missing on test_gen");
        const reviewers = tools.find((tool) => tool.name === "reviewers");
        assert.ok(reviewers, "reviewers tool missing");
        assert.ok(reviewers.inputSchema.properties.limit, "limit missing on reviewers");
        assert.ok(reviewers.inputSchema.properties.depth, "depth missing on reviewers");
        assert.ok(reviewers.inputSchema.properties.exclude, "exclude missing on reviewers");
        const testGuard = tools.find((tool) => tool.name === "test_guard");
        assert.ok(testGuard, "test_guard tool missing");
        assert.ok(testGuard.inputSchema.properties.fail_on_weakening, "fail_on_weakening missing on test_guard");
        assert.ok(testGuard.inputSchema.properties.staged, "staged missing on test_guard");
        const sast = tools.find((tool) => tool.name === "sast");
        assert.ok(sast, "sast tool missing");
        assert.ok(sast.inputSchema.properties.fail_on_issue, "fail_on_issue missing on sast");
        assert.ok(sast.inputSchema.properties.ignore, "ignore missing on sast");
        assert.ok(sast.inputSchema.properties.baseline, "baseline missing on sast");
        assert.ok(sast.inputSchema.properties.update_baseline, "update_baseline missing on sast");
        const authz = tools.find((tool) => tool.name === "authz");
        assert.ok(authz, "authz tool missing");
        assert.ok(authz.inputSchema.properties.public, "public missing on authz");
        assert.ok(authz.inputSchema.properties.fail_on_issue, "fail_on_issue missing on authz");
        assert.ok(authz.inputSchema.properties.baseline, "baseline missing on authz");
        assert.ok(authz.inputSchema.properties.update_baseline, "update_baseline missing on authz");
        const fix = tools.find((tool) => tool.name === "fix");
        assert.ok(fix, "fix tool missing");
        assert.ok(fix.inputSchema.properties.from_sast, "from_sast missing on fix");
        assert.ok(fix.inputSchema.properties.from_authz, "from_authz missing on fix");
        const ready = tools.find((tool) => tool.name === "ready");
        assert.ok(ready, "ready tool missing");
        assert.ok(ready.inputSchema.properties.fail_under, "fail_under missing on ready");
        const receiptVerify = tools.find((tool) => tool.name === "receipt_verify");
        assert.ok(receiptVerify, "receipt_verify tool missing");
        assert.ok(receiptVerify.inputSchema.properties.receipt, "receipt missing on receipt_verify");
        assert.ok(receiptVerify.inputSchema.properties.public_key, "public_key missing on receipt_verify");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP slop tool returns the Slop Index offline", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-slop-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "core.autocrlf", "false"]);
        writeFileSync(join(dir, "wallet.go"), "package main\n\nfunc main() {}\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "slop", arguments: { verbosity: "compact", no_blame: true } },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.match(result?.content?.[0]?.text ?? "", /Slop Index/);
        assert.equal(typeof result?.structuredContent?.index, "number");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP preflight returns a failing verdict without a tool error", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-preflight-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "core.autocrlf", "false"]);
        writeFileSync(join(dir, "wallet.go"), "package main\n\nfunc main() {}\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        const diff = [
            "diff --git a/src/app.ts b/src/app.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/app.ts",
            "@@ -0,0 +1 @@",
            '+const key = "AKIAIOSFODNN7EXAMPLE";',
            "",
        ].join("\n");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "preflight", arguments: { diff, no_slop: true } },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 1);
        assert.equal(result?.structuredContent?.status, "fail");
        const secrets = result?.structuredContent?.checks?.find((check) => check.id === "secrets");
        assert.equal(secrets?.status, "fail");
        assert.match(result?.content?.[0]?.text ?? "", /"status": "fail"/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP ready returns the readiness score without a tool error", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-ready-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "core.autocrlf", "false"]);
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", private: true, scripts: { test: 'node -e "process.exit(0)"' } }), "utf8");
        writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, packages: { "": { name: "demo" } } }), "utf8");
        writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "ready", arguments: { fail_under: 85 } },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 1);
        assert.equal(typeof result?.structuredContent?.score, "number");
        assert.equal(result?.structuredContent?.checks?.find((check) => check.id === "tests")?.status, "pass");
        assert.match(result?.content?.[0]?.text ?? "", /"grade"/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP receipt_verify rejects a missing and a tampered receipt", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-receipt-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "core.autocrlf", "false"]);
        writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        const call = () => {
            const { responses, stderr } = runServer(dir, [
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
                },
                {
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: { name: "receipt_verify", arguments: {} },
                },
            ]);
            const result = responses.find((response) => response.id === 2)?.result;
            return { result, stderr };
        };
        const missing = call();
        assert.notEqual(missing.result?.isError, true, missing.stderr);
        assert.equal(missing.result?._meta?.exitCode, 1);
        assert.equal(missing.result?.structuredContent?.ok, false);
        const created = spawnSync(process.execPath, [CLI, "receipt", "--cwd", dir, "--no-run", "--json"], {
            cwd: dir,
            encoding: "utf8",
            timeout: 60_000,
        });
        assert.equal(created.status, 0, created.stderr);
        const valid = call();
        assert.notEqual(valid.result?.isError, true, valid.stderr);
        assert.equal(valid.result?._meta?.exitCode, 0);
        assert.equal(valid.result?.structuredContent?.ok, true);
        assert.equal(valid.result?.structuredContent?.hashOk, true);
        assert.equal(valid.result?.structuredContent?.stale, false);
        const path = join(dir, ".git", "oc-pilot", "receipt.json");
        const receipt = JSON.parse(readFileSync(path, "utf8"));
        receipt.createdAt = "2020-01-01T00:00:00.000Z";
        writeFileSync(path, JSON.stringify(receipt, null, 2), "utf8");
        const tampered = call();
        assert.equal(tampered.result?._meta?.exitCode, 1);
        assert.equal(tampered.result?.structuredContent?.ok, false);
        assert.equal(tampered.result?.structuredContent?.hashOk, false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP sast returns findings without a tool error", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-sast-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        writeFileSync(join(dir, "base.txt"), "x\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        writeFileSync(join(dir, "app.js"), 'const { exec } = require("child_process");\nexec(`rm -rf ${req.query.dir}`);\n', "utf8");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "sast", arguments: { paths: ["app.js"], fail_on_issue: "high" } },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 1);
        assert.equal(result?.structuredContent?.findings?.[0]?.rule, "command-injection");
        assert.equal(result?.structuredContent?.findings?.[0]?.severity, "high");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP authz returns route findings without a tool error", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-authz-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        writeFileSync(join(dir, "base.txt"), "x\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        writeFileSync(join(dir, "app.js"), 'router.get("/users/:id", async (req, res) => { const user = await db.user.findUnique({ where: { id: req.params.id } }); res.json(user); });\n', "utf8");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "authz", arguments: { paths: ["app.js"], fail_on_issue: "high" } },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 1);
        assert.equal(result?.structuredContent?.routes?.length, 1);
        const rules = (result?.structuredContent?.findings ?? []).map((finding) => finding.rule);
        assert.ok(rules.includes("route-no-auth"), `rules: ${rules.join(",")}`);
        assert.ok(rules.includes("idor"), `rules: ${rules.join(",")}`);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP mutate reports surviving mutants and restores the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-mutate-"));
    try {
        const source = "export function same(a, b) {\n  return a === b;\n}\n";
        writeFileSync(join(dir, "app.js"), source, "utf8");
        const diff = [
            "diff --git a/app.js b/app.js",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/app.js",
            "@@ -0,0 +1,3 @@",
            "+export function same(a, b) {",
            "+  return a === b;",
            "+}",
            "",
        ].join("\n");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "mutate",
                    arguments: {
                        diff,
                        command: 'node -e "process.exit(0)"',
                        max_mutants: 2,
                        min_score: 100,
                        verbosity: "compact",
                    },
                },
            },
        ], ["--allow-write"]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 1);
        assert.equal(result?.structuredContent?.survived, 1);
        assert.equal(result?.structuredContent?.score, 0);
        assert.equal(result?.structuredContent?.mutants?.length, 1);
        assert.match(result?.content?.[0]?.text ?? "", /mutation score 0\/100, 1 survived/);
        assert.equal(readFileSync(join(dir, "app.js"), "utf8"), source);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP deps --why explains the lockfile chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-deps-"));
    try {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { express: "^4.18.0" } }, null, 2), "utf8");
        writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
            name: "demo",
            version: "1.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: {
                "": { name: "demo", version: "1.0.0", dependencies: { express: "^4.18.0" } },
                "node_modules/express": { version: "4.18.2", dependencies: { "body-parser": "1.20.1" } },
                "node_modules/body-parser": { version: "1.20.1", dependencies: { qs: "6.11.0" } },
                "node_modules/qs": { version: "6.11.0" },
            },
        }, null, 2), "utf8");
        writeFileSync(join(dir, "app.ts"), 'import express from "express";\n\nexport const app = express();\n', "utf8");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "deps", arguments: { why: "qs" } },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 0);
        assert.equal(result?.structuredContent?.name, "qs");
        assert.deepEqual(result?.structuredContent?.versions, ["6.11.0"]);
        assert.deepEqual(result?.structuredContent?.dependents, ["body-parser"]);
        assert.deepEqual(result?.structuredContent?.chains, [["express", "body-parser", "qs"]]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP coverage gates uncovered changed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-coverage-"));
    try {
        mkdirSync(join(dir, "coverage"), { recursive: true });
        writeFileSync(join(dir, "coverage", "lcov.info"), ["SF:src/app.ts", "DA:1,1", "DA:2,0", "end_of_record", ""].join("\n"), "utf8");
        const diff = [
            "diff --git a/src/app.ts b/src/app.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/app.ts",
            "@@ -0,0 +1,3 @@",
            "+export function add(a: number, b: number) {",
            "+  return a + b;",
            "+}",
            "",
        ].join("\n");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "coverage",
                    arguments: {
                        diff,
                        coverage_file: "coverage/lcov.info",
                        fail_under: 80,
                        verbosity: "compact",
                    },
                },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 1);
        assert.equal(result?.structuredContent?.coveragePercent, 50);
        assert.equal(result?.structuredContent?.uncoveredLines, 1);
        assert.deepEqual(result?.structuredContent?.gaps, [{ file: "src/app.ts", uncovered: [2] }]);
        assert.equal(result?.structuredContent?.gate?.passed, false);
        assert.match(result?.content?.[0]?.text ?? "", /1 uncovered changed line in 1 file \(50%\)/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP reviewers ranks authors from git history", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-reviewers-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init", "-q"]);
        git(["config", "user.email", "alice@example.com"]);
        git(["config", "user.name", "Alice"]);
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "app.ts"), "export function a() {}\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        const diff = [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1,2 @@",
            " export function a() {}",
            "+export function b() {}",
            "",
        ].join("\n");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "reviewers", arguments: { diff, verbosity: "compact" } },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 0);
        assert.deepEqual(result?.structuredContent?.files, ["src/app.ts"]);
        assert.equal(result?.structuredContent?.candidates?.length, 1);
        assert.equal(result?.structuredContent?.candidates?.[0]?.name, "Alice");
        assert.equal(result?.structuredContent?.candidates?.[0]?.files, 1);
        assert.equal(result?.structuredContent?.candidates?.[0]?.commits, 1);
        assert.match(result?.content?.[0]?.text ?? "", /1 reviewer candidate, 0 CODEOWNERS owners for 1 file/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP test_guard flags a weakened matcher", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-guard-"));
    try {
        const diff = [
            "diff --git a/src/app.test.ts b/src/app.test.ts",
            "--- a/src/app.test.ts",
            "+++ b/src/app.test.ts",
            "@@ -1,3 +1,3 @@",
            ' test("adds", () => {',
            "-  expect(add(1, 2)).toBe(3);",
            "+  expect(add(1, 2)).toBeDefined();",
            " });",
            "",
        ].join("\n");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "test_guard",
                    arguments: { diff, fail_on_weakening: true, verbosity: "compact" },
                },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 1);
        assert.equal(result?.structuredContent?.status, "fail");
        assert.equal(result?.structuredContent?.counts?.total, 1);
        assert.equal(result?.structuredContent?.findings?.[0]?.kind, "weakened-matcher");
        assert.equal(result?.structuredContent?.findings?.[0]?.file, "src/app.test.ts");
        assert.match(result?.content?.[0]?.text ?? "", /1 test weakening finding, status fail/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP impact finds references to changed symbols", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-impact-"));
    try {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "checkout.ts"), 'import { charge } from "./wallet";\n\nexport function pay() {\n  return charge(10);\n}\n', "utf8");
        const diff = [
            "diff --git a/src/wallet.ts b/src/wallet.ts",
            "--- a/src/wallet.ts",
            "+++ b/src/wallet.ts",
            "@@ -1,3 +1,3 @@",
            "-export function charge(amount: number) {",
            "+export function chargeCard(amount: number) {",
            "   return amount;",
            " }",
            "",
        ].join("\n");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "impact",
                    arguments: { diff, verbosity: "compact" },
                },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        const names = result?.structuredContent?.symbols?.map((symbol) => symbol.name) ?? [];
        assert.ok(names.includes("charge"), `symbols: ${names.join(", ")}`);
        assert.ok(names.includes("chargeCard"), `symbols: ${names.join(", ")}`);
        const reference = result?.structuredContent?.references?.find((item) => item.symbol === "charge");
        assert.ok(reference, "charge reference missing");
        assert.equal(reference.file, "src/checkout.ts");
        assert.match(result?.content?.[0]?.text ?? "", /2 changed symbols, \d+ references? in \d+ scanned files?/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP flaky reports a test that passes and fails across runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-flaky-"));
    try {
        writeFileSync(join(dir, "flaky.cjs"), [
            'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
            'const count = existsSync("runs.txt") ? Number(readFileSync("runs.txt", "utf8")) : 0;',
            'writeFileSync("runs.txt", String(count + 1));',
            "if (count === 0) {",
            '  console.log("✔ alpha");',
            "} else {",
            '  console.log("✖ alpha");',
            "  process.exit(1);",
            "}",
            "",
        ].join("\n"), "utf8");
        const { responses, stderr } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "flaky",
                    arguments: { runs: 2, command: "node flaky.cjs", verbosity: "compact" },
                },
            },
        ]);
        const result = responses.find((response) => response.id === 2)?.result;
        assert.notEqual(result?.isError, true, stderr);
        assert.equal(result?._meta?.exitCode, 0);
        assert.equal(result?.structuredContent?.runs, 2);
        assert.equal(result?.structuredContent?.parsed, true);
        assert.equal(result?.structuredContent?.flaky?.length, 1);
        assert.equal(result?.structuredContent?.flaky?.[0]?.name, "alpha");
        assert.equal(result?.structuredContent?.flaky?.[0]?.passes, 1);
        assert.equal(result?.structuredContent?.flaky?.[0]?.failures, 1);
        assert.match(result?.content?.[0]?.text ?? "", /1 flaky, 0 failing across 2 runs/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("applyResultOptions caps findings and summarizes compactly", () => {
    const findings = [1, 2, 3, 4, 5].map((n) => ({
        severity: n === 1 ? "critical" : "warning",
        location: `src/a.ts:${n}`,
        text: `issue ${n}`,
    }));
    const base = {
        content: [{ type: "text", text: "payload" }],
        structuredContent: { findings },
    };
    const capped = applyResultOptions(base, { max_findings: 2 });
    const payload = capped.structuredContent;
    assert.equal(payload.findings.length, 2);
    assert.equal(payload.truncated, true);
    assert.equal(payload.totalFindings, 5);
    assert.match(capped.content[0].text, /totalFindings/);
    const compact = applyResultOptions(base, { verbosity: "compact" });
    assert.match(compact.content[0].text, /5 findings/);
    assert.equal(compact.structuredContent.findings.length, 5);
});
test("MCP handles logging/setLevel and advertises the capability", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-logging-"));
    try {
        const { responses } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            { jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "info" } },
        ]);
        const init = responses.find((response) => response.id === 1)?.result;
        assert.deepEqual(init?.capabilities?.logging, {});
        assert.deepEqual(responses.find((response) => response.id === 2)?.result, {});
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("MCP stops model-backed tools after the call budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-mcp-budget-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        git(["init"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        git(["config", "core.autocrlf", "false"]);
        writeFileSync(join(dir, ".oc-pilot.json"), JSON.stringify({ engine: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "test-model" }), "utf8");
        writeFileSync(join(dir, "wallet.go"), "package main\n\nfunc main() {}\n", "utf8");
        git(["add", "."]);
        git(["commit", "-m", "init"]);
        const { responses } = runServer(dir, [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            },
            { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "review", arguments: {} } },
            { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "review", arguments: {} } },
            { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stats", arguments: {} } },
        ], ["--max-calls", "1"]);
        const blocked = responses.find((response) => response.id === 3)?.result;
        assert.equal(blocked?.isError, true);
        assert.match(blocked?.content?.[0]?.text ?? "", /budget/i);
        const offline = responses.find((response) => response.id === 4)?.result;
        assert.doesNotMatch(offline?.content?.[0]?.text ?? "", /budget/i);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("patchSummary describes a patch and applyResultOptions caps its size", () => {
    const patch = [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,4 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
    ].join("\n");
    const summary = patchSummary(patch);
    assert.equal(summary.files.length, 2);
    assert.equal(summary.additions, 3);
    assert.equal(summary.deletions, 2);
    assert.equal(summary.hunks, 2);
    assert.equal(summary.bytes, patch.length);
    const result = applyResultOptions({ content: [], structuredContent: { applied: false, patch } }, { verbosity: "compact" });
    const structured = result.structuredContent;
    assert.equal(structured.files.length, 2);
    assert.equal(structured.patchStats.additions, 3);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /fix 2 files/);
    assert.match(text, /not applied/);
    const huge = "x".repeat(200_001);
    const capped = applyResultOptions({ content: [], structuredContent: { applied: true, patch: huge } }, {});
    const payload = capped.structuredContent;
    assert.equal(payload.patchTruncated, true);
    assert.equal(payload.patchBytes, 200_001);
    assert.equal(payload.patch.length, 200_000);
});
//# sourceMappingURL=mcp.test.js.map