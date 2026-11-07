import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

const CLI = resolve("dist/cli.js");
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd?: string, extraEnv: Record<string, string> = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function installFakeOpenCode(dir: string): Record<string, string> {
  const script = join(dir, "fake-opencode.js");
  writeFileSync(
    script,
    [
      'let data = "";',
      'process.stdin.on("data", (chunk) => { data += chunk; });',
      'process.stdin.on("end", () => {',
      '  if (process.env.FAKE_FAIL === "1") {',
      '    console.log(JSON.stringify({ type: "error", error: "fake provider failure" }));',
      "    process.exit(1);",
      "  }",
      '  if (process.env.FAKE_REQUIRE_CONFIG === "1") {',
      '    const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");',
      '    const def = cfg.agents && cfg.agents["oc-pilot"];',
      '    if (!def || def.steps !== 8 || !def.permissions.some((p) => p.action === "read" && p.effect === "allow")) {',
      '      console.log(JSON.stringify({ type: "error", error: "missing repo agent config" }));',
      "      process.exit(1);",
      "    }",
      "  }",
      '  if (process.env.FAKE_REQUIRE_ISOLATED === "1") {',
      '    if (process.env.OPENCODE_CONFIG_CONTENT || !process.cwd().includes("oc-pilot-")) {',
      '      console.log(JSON.stringify({ type: "error", error: "expected isolated temp project" }));',
      "      process.exit(1);",
      "    }",
      "  }",
      '  console.log(JSON.stringify({ type: "step_start", sessionID: "ses_fake" }));',
      '  const lang = process.env.FAKE_LANG === "ru" ? "ru" : "en";',
      '  let body = process.env.FAKE_CRITICAL === "1"',
      '    ? (lang === "ru" ? "### Анализ: Критическая проблема.\\n\\n#### Замечания / Действия\\n- **🔴 Critical `wallet.go:10`**: nil pointer.\\n\\n#### Решение\\n```go\\nfix\\n```" : "### Analysis: Critical issue.\\n\\n#### Findings / Actions\\n- **🔴 Critical `wallet.go:10`**: nil pointer.\\n\\n#### Solution\\n```go\\nfix\\n```")',
      '    : (lang === "ru" ? "### Анализ: OK\\n\\n#### Замечания / Действия\\n- **🔵 Note**: test\\n\\n#### Решение\\n```go\\nfunc f() {}\\n```" : "### Analysis: OK\\n\\n#### Findings / Actions\\n- **🔵 Note**: test\\n\\n#### Solution\\n```go\\nfunc f() {}\\n```");',
      '  if (process.env.FAKE_PATCH_TEXT) {',
      '    const fence = String.fromCharCode(96, 96, 96);',
      '    body = ["### Analysis: patch.", "", "#### Findings / Actions", "- **🔵 Note**: test", "", "#### Solution", fence + "diff", process.env.FAKE_PATCH_TEXT, fence].join("\\n");',
      "  }",
      '  console.log(JSON.stringify({ type: "text", part: { text: body } }));',
      '  console.log(JSON.stringify({ type: "step_finish", part: { cost: 0 } }));',
      "});",
      "",
    ].join("\n"),
  );

  const cli = join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  const content =
    process.platform === "win32"
      ? `@echo off\r\nnode "${script}"\r\n`
      : `#!/bin/sh\nexec node "${script}"\n`;
  writeFileSync(cli, content);
  if (process.platform !== "win32") chmodSync(cli, 0o755);

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return {
    [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}`,
  };
}

function fixtureDiff(): string {
  return [
    "diff --git a/wallet.go b/wallet.go",
    "--- a/wallet.go",
    "+++ b/wallet.go",
    "@@ -10,2 +10,3 @@ func DeductBalance(u *User, amount int) error {",
    "     }",
    `+    apiKey := "${AWS_KEY}"`,
    "     return nil",
    "",
  ].join("\n");
}

test("review --dry-run composes the prompt without calling the model", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());

    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("PROJECT_TYPE: Go"));
    assert.ok(result.stdout.includes("RECIPE: review"));
    assert.ok(result.stdout.includes("[REDACTED:AWS Access Key ID]"));
    assert.ok(!result.stdout.includes(AWS_KEY));
    assert.match(result.stderr, /Найдено потенциальных секретов: 1/);
    assert.match(result.stderr, /AWS Access Key ID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review --engine openai dry-run uses full-file context without OpenCode", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    writeFileSync(join(dir, "wallet.go"), "package wallet\n\nfunc DeductBalance() {}\n");

    const result = runCli([
      "review",
      "--diff",
      diffPath,
      "--cwd",
      dir,
      "--dry-run",
      "--json",
      "--engine",
      "openai",
      "--model",
      "test-model",
      "--base-url",
      "https://api.example.com/v1",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      engine: string;
      baseUrl: string;
      repoContext: boolean;
      fileContext: number;
      input: string;
    };
    assert.equal(payload.engine, "openai");
    assert.equal(payload.baseUrl, "https://api.example.com/v1");
    assert.equal(payload.repoContext, false);
    assert.equal(payload.fileContext, 1);
    assert.match(payload.input, /REPO_CONTEXT: disabled/);
    assert.match(payload.input, /FULL_FILE_CONTEXT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review --dry-run includes project rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    mkdirSync(join(dir, ".oc-pilot"));
    writeFileSync(join(dir, ".oc-pilot", "rules.md"), "Always mention the retry policy.");

    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("PROJECT_RULES"));
    assert.ok(result.stdout.includes("Always mention the retry policy."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review fails when an explicit rules file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--rules", "missing.md"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Файл правил не найден/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review --dry-run --fail-on-secrets exits 3 and explains why", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());

    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--dry-run", "--fail-on-secrets"]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /--fail-on-secrets: обнаружено critical-секретов: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review parses OpenCode JSON events and returns structured output", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    writeFileSync(join(dir, ".oc-pilot.json"), "{}");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(
      diffPath,
      [
        "diff --git a/wallet.go b/wallet.go",
        "--- a/wallet.go",
        "+++ b/wallet.go",
        "@@ -1,1 +1,2 @@",
        " package wallet",
        "+func f() {}",
        "",
      ].join("\n"),
    );

    const env = installFakeOpenCode(dir);
    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--json"], dir, env);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      analysis: string;
      projectType: string;
      meta: { sessionID: string; formatValid: boolean; agent: string; cost: number };
    };
    assert.equal(payload.projectType, "Go");
    assert.match(payload.analysis, /### Analysis:/);
    assert.equal(payload.meta.sessionID, "ses_fake");
    assert.equal(payload.meta.agent, "oc-pilot");
    assert.equal(payload.meta.formatValid, true);
    assert.equal(payload.meta.cost, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--lang ru uses the Russian prompt and accepts Russian output", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    writeFileSync(join(dir, ".oc-pilot.json"), "{}");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(
      diffPath,
      [
        "diff --git a/wallet.go b/wallet.go",
        "--- a/wallet.go",
        "+++ b/wallet.go",
        "@@ -1,1 +1,2 @@",
        " package wallet",
        "+func f() {}",
        "",
      ].join("\n"),
    );

    const env = installFakeOpenCode(dir);
    const result = runCli(
      ["review", "--diff", diffPath, "--cwd", dir, "--lang", "ru", "--json"],
      dir,
      { ...env, FAKE_LANG: "ru" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { analysis: string };
    assert.match(payload.analysis, /### Анализ:/);
    assert.doesNotMatch(payload.analysis, /### Analysis:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review propagates OpenCode error events", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    writeFileSync(join(dir, ".oc-pilot.json"), "{}");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(
      diffPath,
      [
        "diff --git a/wallet.go b/wallet.go",
        "--- a/wallet.go",
        "+++ b/wallet.go",
        "@@ -1,1 +1,2 @@",
        " package wallet",
        "+func f() {}",
        "",
      ].join("\n"),
    );

    const env = installFakeOpenCode(dir);
    const result = runCli(
      ["review", "--diff", diffPath, "--cwd", dir, "--json"],
      dir,
      { ...env, FAKE_FAIL: "1" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fake provider failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review passes a read-only repo agent config to OpenCode", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    const env = installFakeOpenCode(dir);

    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--json"], dir, {
      ...env,
      FAKE_REQUIRE_CONFIG: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { meta: { repoContext: boolean } };
    assert.equal(payload.meta.repoContext, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-repo-context includes full changed files in the prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    writeFileSync(join(dir, "wallet.go"), "package wallet\n\nfunc helper() {}\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());

    const result = runCli([
      "review",
      "--diff",
      diffPath,
      "--cwd",
      dir,
      "--dry-run",
      "--no-repo-context",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("FULL_FILE_CONTEXT"));
    assert.ok(result.stdout.includes("func helper() {}"));
    assert.ok(result.stdout.includes("REPO_CONTEXT: disabled"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-repo-context uses the isolated diff-only agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    const env = installFakeOpenCode(dir);

    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--json", "--no-repo-context"], dir, {
      ...env,
      FAKE_REQUIRE_ISOLATED: "1",
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { meta: { repoContext: boolean } };
    assert.equal(payload.meta.repoContext, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fail-on critical exits 3 and exposes structured findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    const env = installFakeOpenCode(dir);

    const result = runCli(
      ["review", "--diff", diffPath, "--cwd", dir, "--json", "--fail-on", "critical"],
      dir,
      { ...env, FAKE_CRITICAL: "1" },
    );
    assert.equal(result.status, 3, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      findings: Array<{ severity: string; location?: string }>;
      meta: { findings: { critical: number } };
    };
    assert.equal(payload.findings.length, 1);
    assert.equal(payload.findings[0]?.severity, "critical");
    assert.equal(payload.findings[0]?.location, "wallet.go:10");
    assert.equal(payload.meta.findings.critical, 1);
    assert.match(result.stderr, /--fail-on critical/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an inline oc-pilot:ignore marker removes the finding from exit code and meta", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    const lines = Array.from({ length: 12 }, (_, index) => `// line ${index + 1}`);
    lines[9] = "func pay() {} // oc-pilot:ignore: nil is impossible for a legacy wallet";
    writeFileSync(join(dir, "wallet.go"), `${lines.join("\n")}\n`);
    const env = installFakeOpenCode(dir);

    const result = runCli(
      ["review", "--diff", diffPath, "--cwd", dir, "--json", "--fail-on", "critical"],
      dir,
      { ...env, FAKE_CRITICAL: "1" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      findings: unknown[];
      meta: { findings: { critical: number }; suppressed?: { count: number; entries: Array<{ reason: string }> } };
    };
    assert.equal(payload.findings.length, 0);
    assert.equal(payload.meta.findings.critical, 0);
    assert.equal(payload.meta.suppressed?.count, 1);
    assert.equal(payload.meta.suppressed?.entries[0]?.reason, "nil is impossible for a legacy wallet");
    assert.match(result.stderr, /oc-pilot:ignore: подавлено находок: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fail-on warning does not fail on style-only output", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());
    const env = installFakeOpenCode(dir);

    const result = runCli(
      ["review", "--diff", diffPath, "--cwd", dir, "--json", "--fail-on", "warning"],
      dir,
      env,
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan --json finds secrets, redacts them and exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, fixtureDiff());

    const result = runCli(["scan", "--diff", diffPath, "--cwd", dir, "--json"]);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      findings: Array<{ kind: string; line: number; preview: string }>;
      meta: { critical: number };
    };
    assert.equal(payload.findings.length, 1);
    assert.equal(payload.findings[0]?.kind, "AWS Access Key ID");
    assert.equal(payload.findings[0]?.line, 11);
    assert.equal(payload.meta.critical, 1);
    assert.ok(!result.stdout.includes(AWS_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review with an empty diff is a successful no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const diffPath = join(dir, "empty.diff");
    writeFileSync(diffPath, "");

    const result = runCli(["review", "--diff", diffPath, "--cwd", dir, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Изменений нет/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help and version work", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /oc-pilot/);
  assert.match(help.stdout, /scan/);
  assert.match(help.stdout, /mcp/);
  assert.match(help.stdout, /doctor/);

  const mcpHelp = runCli(["mcp", "--help"]);
  assert.equal(mcpHelp.status, 0);
  assert.match(mcpHelp.stdout, /--read-only/);

  const version = runCli(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^oc-pilot \d+\.\d+\.\d+/);
});

test("init writes a config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-"));
  try {
    const result = runCli(["init", "--cwd", dir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const path = join(dir, ".oc-pilot.json");
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf8"), /"agent": "oc-pilot"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix --keep-on-test-failure keeps a failing patch", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-fix-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "a\n", "utf8");
    spawnSync("git", ["add", "file.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const patch = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch);

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      [
        "fix",
        "--diff",
        diffPath,
        "--apply",
        "--command",
        "node -e \"process.exit(1)\"",
        "--keep-on-test-failure",
        "--rounds",
        "1",
        "--cwd",
        dir,
        "--json",
      ],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      tests: { exitCode: number };
      error: string;
    };
    assert.equal(payload.applied, true);
    assert.equal(payload.tests.exitCode, 1);
    assert.match(payload.error, /patch kept/);
    assert.equal(readFileSync(join(dir, "file.txt"), "utf8").replace(/\r\n/g, "\n"), "b\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix rejects a patch that touches files outside the diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-fix-scope-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "a\n", "utf8");
    writeFileSync(join(dir, "other.txt"), "keep\n", "utf8");
    spawnSync("git", ["add", "file.txt", "other.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const patch = [
      "diff --git a/other.txt b/other.txt",
      "--- a/other.txt",
      "+++ b/other.txt",
      "@@ -1 +1 @@",
      "-keep",
      "+changed",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, diff);

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["fix", "--diff", diffPath, "--apply", "--no-tests", "--cwd", dir, "--json"],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /вне diff/);
    assert.equal(readFileSync(join(dir, "other.txt"), "utf8").replace(/\r\n/g, "\n"), "keep\n");
    assert.equal(readFileSync(join(dir, "file.txt"), "utf8").replace(/\r\n/g, "\n"), "a\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix allows a patch that only removes a secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-fix-secret-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), `token = "${AWS_KEY}"\na\n`, "utf8");
    spawnSync("git", ["add", "file.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -2 +2 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const patch = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1 @@",
      `-token = "${AWS_KEY}"`,
      "-a",
      "+b",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, diff);

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["fix", "--diff", diffPath, "--cwd", dir, "--json"],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { applied: boolean; patch: string };
    assert.equal(payload.applied, false);
    assert.match(payload.patch, /AKIA/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports a local OpenAI-compatible setup", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-doctor-"));
  try {
    const result = runCli([
      "doctor",
      "--cwd",
      dir,
      "--json",
      "--engine",
      "openai",
      "--model",
      "test-model",
      "--base-url",
      "http://localhost:9/v1",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      engine: string;
      checks: Array<{ id: string; status: string }>;
      summary: { error: number };
    };
    assert.equal(report.engine, "openai");
    assert.equal(report.summary.error, 0);
    assert.equal(report.checks.find((check) => check.id === "model")?.status, "ok");
    assert.equal(report.checks.find((check) => check.id === "credentials")?.status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown commands return a usage error", () => {
  const result = runCli(["nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Неизвестная команда/);
});

test("test-gen applies a generated test file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-test-gen-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "wallet.go"), "package wallet\n", "utf8");
    spawnSync("git", ["add", "wallet.go"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { cwd: dir });

    const patch = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/a.test.ts",
      "@@ -0,0 +1,2 @@",
      "+test(\"a\", () => {});",
      "+",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch);

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["test-gen", "--diff", diffPath, "--apply", "--no-run", "--rounds", "1", "--cwd", dir, "--json"],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      status: string;
      files: string[];
    };
    assert.equal(payload.applied, true);
    assert.equal(payload.status, "not-run");
    assert.deepEqual(payload.files, ["src/a.test.ts"]);
    assert.match(readFileSync(join(dir, "src", "a.test.ts"), "utf8"), /test\("a"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-gen refuses a patch that changes production code", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-test-gen-skip-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "wallet.go"), "package wallet\n", "utf8");
    spawnSync("git", ["add", "wallet.go"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { cwd: dir });

    const patch = [
      "diff --git a/wallet.go b/wallet.go",
      "--- a/wallet.go",
      "+++ b/wallet.go",
      "@@ -1 +1,2 @@",
      " package wallet",
      "+// sneaky production change",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch);

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["test-gen", "--diff", diffPath, "--apply", "--no-run", "--rounds", "1", "--cwd", dir, "--json"],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as { applied: boolean; patch: string | null; status: string };
    assert.equal(payload.applied, false);
    assert.equal(payload.patch, null);
    assert.equal(payload.status, "fail");
    assert.equal(readFileSync(join(dir, "wallet.go"), "utf8").replace(/\r\n/g, "\n"), "package wallet\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-gen coverage narrows the request to uncovered lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-test-gen-cov-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n", "utf8");
    spawnSync("git", ["add", "a.ts"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { cwd: dir });

    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " one",
      "+added",
      " two",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch);
    const lcovPath = join(dir, "lcov.info");
    writeFileSync(lcovPath, ["SF:a.ts", "DA:2,0", "end_of_record", ""].join("\n"));

    const testPatch = [
      "diff --git a/a.test.ts b/a.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/a.test.ts",
      "@@ -0,0 +1 @@",
      "+test(\"added\", () => {});",
      "",
    ].join("\n");
    const fake = installFakeOpenCode(dir);
    const result = runCli(
      [
        "test-gen",
        "--diff",
        diffPath,
        "--coverage-file",
        lcovPath,
        "--apply",
        "--no-run",
        "--rounds",
        "1",
        "--cwd",
        dir,
        "--json",
      ],
      dir,
      { ...fake, FAKE_PATCH_TEXT: testPatch },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      files: string[];
      coverage: { format: string; uncoveredLines: number; gaps: { file: string; uncovered: number[] }[] };
    };
    assert.equal(payload.applied, true);
    assert.deepEqual(payload.files, ["a.test.ts"]);
    assert.equal(payload.coverage.format, "lcov");
    assert.equal(payload.coverage.uncoveredLines, 1);
    assert.deepEqual(payload.coverage.gaps, [{ file: "a.ts", uncovered: [2] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-gen coverage skips generation when changed lines are covered", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-test-gen-covered-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n", "utf8");
    spawnSync("git", ["add", "a.ts"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { cwd: dir });

    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " one",
      "+added",
      " two",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch);
    const lcovPath = join(dir, "lcov.info");
    writeFileSync(lcovPath, ["SF:a.ts", "DA:2,1", "end_of_record", ""].join("\n"));

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["test-gen", "--diff", diffPath, "--coverage-file", lcovPath, "--json"],
      dir,
      fake,
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      status: string;
      coverage: { uncoveredLines: number };
    };
    assert.equal(payload.applied, false);
    assert.equal(payload.status, "not-run");
    assert.equal(payload.coverage.uncoveredLines, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-gen --from-slop picks an untested file and writes its test", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-test-gen-slop-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const source = Array.from({ length: 120 }, (_, index) => `export const value${String(index)} = ${String(index)};`);
    writeFileSync(join(dir, "calc.ts"), `${source.join("\n")}\n`, "utf8");
    spawnSync("git", ["add", "calc.ts"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { cwd: dir });

    const patch = [
      "diff --git a/calc.test.ts b/calc.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/calc.test.ts",
      "@@ -0,0 +1,2 @@",
      "+test(\"value0\", () => {});",
      "+",
      "",
    ].join("\n");

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["test-gen", "--from-slop", "--slop-files", "1", "--apply", "--no-run", "--cwd", dir, "--json"],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      files: string[];
      targets: Array<{ file: string }>;
    };
    assert.equal(payload.applied, true);
    assert.deepEqual(payload.files, ["calc.test.ts"]);
    assert.deepEqual(payload.targets.map((target) => target.file), ["calc.ts"]);
    assert.match(readFileSync(join(dir, "calc.test.ts"), "utf8"), /test\("value0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-gen --from-slop rejects diff sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-test-gen-slop-cx-"));
  try {
    const result = runCli(["test-gen", "--from-slop", "--diff", "x.diff", "--cwd", dir, "--json"], dir);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /не сочетается/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test-gen --from-slop exits early when every file has a test", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-test-gen-slop-none-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(dir, "a.test.ts"), "test(\"a\", () => {});\n", "utf8");
    spawnSync("git", ["add", "a.ts", "a.test.ts"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { cwd: dir });

    const result = runCli(["test-gen", "--from-slop", "--cwd", dir, "--json"], dir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      status: string;
      targets: unknown[];
    };
    assert.equal(payload.applied, false);
    assert.equal(payload.status, "not-run");
    assert.deepEqual(payload.targets, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps fails the gate on a phantom import", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-deps-phantom-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { "left-pad": "^1.3.0" } }, null, 2),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), 'import axios from "axios";\n', "utf8");
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": {} } }),
      "utf8",
    );

    const result = runCli(["deps", "--cwd", dir, "--json", "--fail-on-issue", "high"], dir);

    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      packageName: string;
      issues: { kind: string; severity: string; name: string }[];
    };
    assert.equal(payload.packageName, "demo");
    const phantom = payload.issues.find((issue) => issue.kind === "phantom");
    assert.equal(phantom?.name, "axios");
    assert.equal(phantom?.severity, "high");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps reports a clean project", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-deps-clean-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }, null, 2), "utf8");
    writeFileSync(join(dir, "local.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(join(dir, "app.ts"), 'import { value } from "./local";\n', "utf8");

    const result = runCli(["deps", "--cwd", dir, "--json"], dir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { issues: unknown[] };
    assert.deepEqual(payload.issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps --fix writes a phantom import from the lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-deps-fix-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { "left-pad": "^1.3.0" } }, null, 2),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), 'import axios from "axios";\n', "utf8");
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/left-pad": { version: "1.3.0" },
          "node_modules/axios": { version: "1.7.2" },
        },
      }),
      "utf8",
    );

    const result = runCli(["deps", "--cwd", dir, "--fix", "--json", "--fail-on-issue", "high"], dir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      issues: { kind: string }[];
      fix: { applied: boolean; fixes: { name: string; action: string }[] };
    };
    assert.equal(payload.fix.applied, true);
    assert.deepEqual(payload.fix.fixes.map((item) => [item.name, item.action]), [["axios", "add-prod"]]);
    assert.equal(payload.issues.some((issue) => issue.kind === "phantom"), false);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.dependencies.axios, "^1.7.2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps --fix --dry-run leaves package.json untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-deps-plan-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const original = JSON.stringify({ name: "demo", dependencies: { zod: "^3.23.0" } }, null, 2);
    writeFileSync(join(dir, "package.json"), original, "utf8");
    writeFileSync(join(dir, "app.test.ts"), 'import { z } from "zod";\n', "utf8");

    const result = runCli(["deps", "--cwd", dir, "--fix", "--dry-run", "--json"], dir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      fix: { applied: boolean; dryRun: boolean; fixes: { name: string; action: string }[] };
    };
    assert.equal(payload.fix.applied, false);
    assert.equal(payload.fix.dryRun, true);
    assert.deepEqual(payload.fix.fixes.map((item) => item.action), ["move-to-dev"]);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps --why shows the transitive chain from the lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-deps-why-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { express: "^4.18.0" } }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        name: "demo",
        lockfileVersion: 3,
        packages: {
          "": { name: "demo", dependencies: { express: "^4.18.0" } },
          "node_modules/express": { version: "4.18.2", dependencies: { "body-parser": "1.20.1" } },
          "node_modules/body-parser": { version: "1.20.1", dependencies: { qs: "6.11.0" } },
          "node_modules/qs": { version: "6.11.0" },
        },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), 'import express from "express";\n', "utf8");

    const result = runCli(["deps", "--cwd", dir, "--why", "qs", "--json"], dir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      name: string;
      versions: string[];
      dependents: string[];
      chains: string[][];
    };
    assert.equal(payload.name, "qs");
    assert.deepEqual(payload.versions, ["6.11.0"]);
    assert.deepEqual(payload.dependents, ["body-parser"]);
    assert.deepEqual(payload.chains, [["express", "body-parser", "qs"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps --why fails cleanly for an unknown package", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-deps-why-missing-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }, null, 2), "utf8");

    const result = runCli(["deps", "--cwd", dir, "--why", "left-pad", "--json"], dir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /не найден/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight fails on a critical secret in the diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-preflight-secret-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/app.ts",
      "@@ -0,0 +1,2 @@",
      '+const key = "AKIAIOSFODNN7EXAMPLE";',
      "+",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, diff);

    const result = runCli(
      ["preflight", "--diff", diffPath, "--no-deps", "--no-slop", "--cwd", dir, "--json"],
      dir,
    );

    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      checks: { id: string; status: string }[];
    };
    assert.equal(payload.status, "fail");
    assert.equal(payload.checks.find((check) => check.id === "secrets")?.status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight passes on an empty diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-preflight-clean-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
    spawnSync("git", ["add", "app.ts"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], {
      cwd: dir,
    });

    const result = runCli(["preflight", "--cwd", dir, "--json", "--no-deps", "--no-slop"], dir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { status: string };
    assert.equal(payload.status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight fails when the diff weakens tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-preflight-tests-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const diff = [
      "diff --git a/src/app.test.ts b/src/app.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/app.test.ts",
      "@@ -0,0 +1,2 @@",
      '+it.skip("works", () => {});',
      "+",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, diff);

    const result = runCli(
      ["preflight", "--diff", diffPath, "--no-deps", "--no-slop", "--cwd", dir, "--json"],
      dir,
    );

    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as { checks: { id: string; status: string }[] };
    assert.equal(payload.checks.find((check) => check.id === "tests")?.status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight can skip every check", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-preflight-skip-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/app.ts",
      "@@ -0,0 +1,2 @@",
      '+const key = "AKIAIOSFODNN7EXAMPLE";',
      "+",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, diff);

    const result = runCli(
      [
        "preflight",
        "--diff",
        diffPath,
        "--no-secret-scan",
        "--no-deps",
        "--no-tests",
        "--no-slop",
        "--cwd",
        dir,
        "--json",
      ],
      dir,
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { status: string; checks: { status: string }[] };
    assert.equal(payload.status, "pass");
    assert.deepEqual(
      payload.checks.map((check) => check.status),
      ["skip", "skip", "skip", "skip", "skip", "skip", "skip"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alien-dna blocks a pattern absent from HEAD", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-alien-dna-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init", "-q"], { cwd: dir });

    const diffPath = join(dir, "changes.diff");
    writeFileSync(
      diffPath,
      [
        "diff --git a/app.ts b/app.ts",
        "--- a/app.ts",
        "+++ b/app.ts",
        "@@ -1 +1,2 @@",
        " export const value = 1;",
        "+class Store { private static instance: Store; }",
        "",
      ].join("\n"),
    );

    const result = runCli(["alien-dna", "--diff", diffPath, "--cwd", dir, "--json"], dir);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as { summary: string; triggers: { id: string }[] };
    assert.match(payload.summary, /\[ALIEN DNA DETECTED\]/);
    assert.equal(payload.triggers[0]?.id, "singleton");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hyper-chamber reports a retained cache as a leak", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-hyper-chamber-"));
  try {
    writeFileSync(
      join(dir, "leak.mjs"),
      [
        "const cache = [];",
        "export function run() {",
        "  cache.push({ payload: 'x'.repeat(512) });",
        "  return cache.length;",
        "}",
        "",
      ].join("\n"),
    );
    const result = runCli(
      ["hyper-chamber", "run", "leak.mjs", "--days", "365", "--budget", "400ms", "--memory-limit", "256MB", "--json"],
      dir,
    );
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as { status: string; summary: string };
    assert.equal(payload.status, "leak");
    assert.match(payload.summary, /\[MEMORY LEAK DETECTED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt records a run and verifies against HEAD", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-receipt-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n", "utf8");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], {
      cwd: dir,
    });

    const created = runCli(["receipt", "--cwd", dir, "--json", "--no-slop"], dir);
    assert.equal(created.status, 0, created.stderr);
    const receipt = JSON.parse(created.stdout) as {
      commit: string;
      tests: { passed: boolean } | null;
      preflight: { status: string };
      hash: string;
    };
    assert.equal(receipt.tests?.passed, true);
    assert.equal(receipt.preflight.status, "pass");
    assert.match(receipt.hash, /^[a-f0-9]{64}$/);
    const saved = join(dir, ".git", "oc-pilot", "receipt.json");
    assert.equal(existsSync(saved), true);

    const verified = runCli(["receipt", "--verify", "--cwd", dir, "--json"], dir);
    assert.equal(verified.status, 0, verified.stderr);
    const verification = JSON.parse(verified.stdout) as { ok: boolean; hashOk: boolean; stale: boolean };
    assert.equal(verification.ok, true);
    assert.equal(verification.hashOk, true);
    assert.equal(verification.stale, false);

    const tampered = { ...receipt, tests: { ...receipt.tests, passed: false } };
    writeFileSync(saved, JSON.stringify(tampered, null, 2), "utf8");
    const rejected = runCli(["receipt", "--verify", "--cwd", dir, "--json"], dir);
    assert.equal(rejected.status, 1, rejected.stderr);
    const rejection = JSON.parse(rejected.stdout) as { ok: boolean; hashOk: boolean };
    assert.equal(rejection.ok, false);
    assert.equal(rejection.hashOk, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt --sign produces a verifiable Ed25519 signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-receipt-sign-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
    spawnSync("git", ["add", "app.ts"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const key = join(dir, "receipt.key");
    const keygen = runCli(["receipt", "--cwd", dir, "--keygen", key], dir);
    assert.equal(keygen.status, 0, keygen.stderr);
    assert.equal(existsSync(`${key}.pub`), true);

    const signed = runCli(["receipt", "--cwd", dir, "--sign", "--key", key, "--no-run", "--json"], dir);
    assert.equal(signed.status, 0, signed.stderr);
    const payload = JSON.parse(signed.stdout) as { signature?: string };
    assert.equal(typeof payload.signature, "string");

    const valid = runCli(
      ["receipt", "--cwd", dir, "--verify", "--public-key", `${key}.pub`, "--json"],
      dir,
    );
    assert.equal(valid.status, 0, valid.stderr);
    const verdict = JSON.parse(valid.stdout) as { ok: boolean; signature: string };
    assert.equal(verdict.ok, true);
    assert.equal(verdict.signature, "valid");

    const otherKey = join(dir, "other.key");
    assert.equal(runCli(["receipt", "--cwd", dir, "--keygen", otherKey], dir).status, 0);
    const rejected = runCli(
      ["receipt", "--cwd", dir, "--verify", "--public-key", `${otherKey}.pub`, "--json"],
      dir,
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    const failed = JSON.parse(rejected.stdout) as { ok: boolean; signature: string };
    assert.equal(failed.ok, false);
    assert.equal(failed.signature, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt reports failing tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-receipt-fail-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: 'node -e "process.exit(1)"' } }, null, 2),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n", "utf8");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], {
      cwd: dir,
    });

    const result = runCli(["receipt", "--cwd", dir, "--json", "--no-slop"], dir);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as { tests: { passed: boolean; exitCode: number } | null };
    assert.equal(payload.tests?.passed, false);
    assert.equal(payload.tests?.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps reads a pnpm lockfile and fixes a phantom import", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-pnpm-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { "left-pad": "^1.3.0" } }, null, 2),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), 'import axios from "axios";\n', "utf8");
    writeFileSync(
      join(dir, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '6.0'",
        "",
        "packages:",
        "",
        "  /axios@1.7.2:",
        "    resolution: {integrity: sha512-x}",
        "",
        "  /left-pad@1.3.0:",
        "    resolution: {integrity: sha512-y}",
        "",
      ].join("\n"),
      "utf8",
    );

    const audit = runCli(["deps", "--cwd", dir, "--json", "--fail-on-issue", "high"], dir);
    assert.equal(audit.status, 1, audit.stderr);
    const report = JSON.parse(audit.stdout) as {
      lockfile: string | null;
      issues: { kind: string; name: string }[];
    };
    assert.equal(report.lockfile, "pnpm-lock.yaml");
    assert.ok(report.issues.some((issue) => issue.kind === "phantom" && issue.name === "axios"));

    const fixed = runCli(["deps", "--cwd", dir, "--fix", "--json"], dir);
    assert.equal(fixed.status, 0, fixed.stderr);
    const payload = JSON.parse(fixed.stdout) as {
      fix: { applied: boolean; fixes: { name: string; action: string }[] };
    };
    assert.equal(payload.fix.applied, true);
    assert.deepEqual(
      payload.fix.fixes.map((fix) => [fix.name, fix.action]),
      [["axios", "add-prod"]],
    );
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.dependencies.axios, "^1.7.2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flaky finds a test that flips between runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-flaky-"));
  try {
    writeFileSync(
      join(dir, "check.js"),
      [
        'const fs = require("node:fs");',
        'const count = fs.existsSync("count.txt") ? Number(fs.readFileSync("count.txt", "utf8")) : 0;',
        'fs.writeFileSync("count.txt", String(count + 1));',
        'if (count % 2 === 0) { console.log("\\u2714 flaky test"); process.exit(0); }',
        'console.log("\\u2716 flaky test"); process.exit(1);',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runCli(["flaky", "--cwd", dir, "--command", "node check.js", "--runs", "3", "--json"], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      runs: number;
      parsed: boolean;
      flaky: { name: string; status: string; passes: number; failures: number }[];
    };
    assert.equal(payload.runs, 3);
    assert.equal(payload.parsed, true);
    assert.equal(payload.flaky[0]?.name, "flaky test");
    assert.equal(payload.flaky[0]?.status, "flaky");

    const gated = runCli(
      ["flaky", "--cwd", dir, "--command", "node check.js", "--runs", "3", "--json", "--fail-on-flaky"],
      dir,
    );
    assert.equal(gated.status, 1, gated.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flaky --shuffle runs test files in a seeded order", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-flaky-shuffle-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "a.test.js"), "// a\n", "utf8");
    writeFileSync(join(dir, "b.test.js"), "// b\n", "utf8");
    writeFileSync(
      join(dir, "runner.js"),
      'for (const file of process.argv.slice(2)) console.log("\\u2714 " + file.replace(/\\.test\\.js$/, ""));\n',
      "utf8",
    );

    const result = runCli(
      [
        "flaky",
        "--cwd",
        dir,
        "--shuffle",
        "--seed",
        "demo",
        "--command",
        "node runner.js {files}",
        "--runs",
        "2",
        "--json",
      ],
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      shuffle: { seed: string; files: number };
      parsed: boolean;
      tests: { name: string; status: string }[];
    };
    assert.deepEqual(payload.shuffle, { seed: "demo", files: 2 });
    assert.equal(payload.parsed, true);
    assert.deepEqual(
      payload.tests.map((test) => test.name).sort(),
      ["a", "b"],
    );

    const missingPlaceholder = runCli(
      ["flaky", "--cwd", dir, "--shuffle", "--command", "node runner.js a.test.js", "--runs", "1", "--json"],
      dir,
    );
    assert.equal(missingPlaceholder.status, 2);
    assert.match(missingPlaceholder.stderr, /\{files\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ready --fix installs the hook, config and instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-ready-fix-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
      "utf8",
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ name: "demo", lockfileVersion: 3, packages: { "": { name: "demo" } } }),
      "utf8",
    );

    const before = runCli(["ready", "--cwd", dir, "--json"], dir);
    assert.equal(before.status, 0, before.stderr);
    const baseline = JSON.parse(before.stdout) as { score: number };

    const fixed = runCli(["ready", "--cwd", dir, "--fix", "--json"], dir);
    assert.equal(fixed.status, 0, fixed.stderr);
    const payload = JSON.parse(fixed.stdout) as {
      score: number;
      fix: { applied: boolean; dryRun: boolean; fixes: Array<{ action: string }> };
    };
    assert.equal(payload.fix.applied, true);
    assert.equal(payload.fix.dryRun, false);
    assert.deepEqual(
      payload.fix.fixes.map((fix) => fix.action).sort(),
      ["install-hook", "write-agents", "write-config"],
    );
    assert.ok(payload.score > baseline.score);
    assert.ok(existsSync(join(dir, ".git", "hooks", "pre-commit")));
    assert.ok(existsSync(join(dir, ".oc-pilot.json")));
    assert.ok(existsSync(join(dir, "AGENTS.md")));

    const after = runCli(["ready", "--cwd", dir, "--json"], dir);
    const checks = (JSON.parse(after.stdout) as { checks: Array<{ id: string; status: string }> }).checks;
    const status = new Map(checks.map((check) => [check.id, check.status]));
    assert.equal(status.get("hooks"), "pass");
    assert.equal(status.get("docs"), "pass");
    assert.equal(status.get("config"), "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ready --fix --dry-run leaves the repository untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-ready-dry-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", private: true }), "utf8");

    const result = runCli(["ready", "--cwd", dir, "--fix", "--dry-run", "--json"], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      fix: { applied: boolean; dryRun: boolean; fixes: unknown[] };
    };
    assert.equal(payload.fix.applied, false);
    assert.equal(payload.fix.dryRun, true);
    assert.equal(payload.fix.fixes.length, 3);
    assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), false);
    assert.equal(existsSync(join(dir, ".oc-pilot.json")), false);
    assert.equal(existsSync(join(dir, "AGENTS.md")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ready --fix --receipt records a verified receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-ready-receipt-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
      "utf8",
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ name: "demo", lockfileVersion: 3, packages: { "": { name: "demo" } } }),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const result = runCli(["ready", "--cwd", dir, "--fix", "--receipt", "--json"], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      score: number;
      fix: { applied: boolean; receipt?: { path: string; testsPassed: boolean; preflight: string } };
    };
    assert.equal(payload.fix.applied, true);
    assert.equal(payload.fix.receipt?.testsPassed, true);
    assert.equal(payload.fix.receipt?.preflight, "pass");
    assert.ok(payload.fix.receipt?.path.endsWith("receipt.json"));
    assert.ok(existsSync(join(dir, ".git", "oc-pilot", "receipt.json")));
    assert.ok(payload.score >= 90);

    const after = runCli(["ready", "--cwd", dir, "--json"], dir);
    const checks = (JSON.parse(after.stdout) as { checks: Array<{ id: string; status: string }> }).checks;
    assert.equal(checks.find((check) => check.id === "receipt")?.status, "pass");

    const invalid = runCli(["ready", "--cwd", dir, "--receipt", "--json"], dir);
    assert.equal(invalid.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutate reports a killed and a surviving mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-mutate-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const calc = [
      "function same(a, b) { return a === b; }",
      "const flag = true;",
      "module.exports = { same };",
      "",
    ].join("\n");
    writeFileSync(join(dir, "calc.js"), calc, "utf8");
    writeFileSync(
      join(dir, "check.js"),
      ['const { same } = require("./calc.js");', "if (!same(1, 1)) process.exit(1);", ""].join("\n"),
      "utf8",
    );

    const patch = [
      "diff --git a/calc.js b/calc.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/calc.js",
      "@@ -0,0 +1,3 @@",
      "+function same(a, b) { return a === b; }",
      "+const flag = true;",
      "+module.exports = { same };",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch, "utf8");

    const result = runCli(
      ["mutate", "--diff", diffPath, "--command", "node check.js", "--max-mutants", "5", "--cwd", dir, "--json"],
      dir,
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      sites: number;
      killed: number;
      survived: number;
      score: number;
      mutants: Array<{ operator: string; status: string }>;
    };
    assert.equal(payload.sites, 2);
    assert.equal(payload.killed, 1);
    assert.equal(payload.survived, 1);
    assert.equal(payload.score, 50);
    assert.deepEqual(
      payload.mutants.map((mutant) => [mutant.operator, mutant.status]),
      [
        ["===", "killed"],
        ["true", "survived"],
      ],
    );
    assert.equal(readFileSync(join(dir, "calc.js"), "utf8"), calc);

    const gated = runCli(
      ["mutate", "--diff", diffPath, "--command", "node check.js", "--max-mutants", "5", "--min-score", "100", "--cwd", dir, "--json"],
      dir,
    );
    assert.equal(gated.status, 1, gated.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deps --audit fails on a known vulnerability from OSV", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-osv-"));
  let server: ReturnType<typeof spawn> | undefined;
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", private: true, dependencies: { "left-pad": "1.3.0" } }),
      "utf8",
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        name: "demo",
        lockfileVersion: 3,
        packages: { "": { name: "demo" }, "node_modules/left-pad": { version: "1.3.0" } },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), 'import leftPad from "left-pad";\n', "utf8");

    const serverPath = join(dir, "osv-server.js");
    writeFileSync(
      serverPath,
      [
        'const http = require("node:http");',
        "const server = http.createServer((req, res) => {",
        '  req.on("data", () => {});',
        '  req.on("end", () => {',
        '    res.writeHead(200, { "content-type": "application/json" });',
        "    res.end(JSON.stringify({ results: [{ vulns: [{",
        '      id: "GHSA-test-1234",',
        '      summary: "test vulnerability",',
        '      database_specific: { severity: "high" },',
        '      affected: [{ ranges: [{ events: [{ fixed: "1.3.1" }] }] }],',
        "    }] }] }));",
        "  });",
        "});",
        'server.listen(0, "127.0.0.1", () => {',
        "  process.stdout.write(String(server.address().port) + \"\\n\");",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    server = spawn(process.execPath, [serverPath], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise<number>((resolvePort, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("OSV server did not start")), 10_000);
      server?.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(/(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      });
      server?.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const result = runCli(
      [
        "deps",
        "--cwd",
        dir,
        "--audit",
        "--osv-url",
        `http://127.0.0.1:${String(port)}/v1/querybatch`,
        "--fail-on-vuln",
        "high",
        "--json",
      ],
      dir,
    );
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      audit?: { vulnerabilities?: Array<{ id: string; severity: string; fixed: string[] }> };
    };
    const vulnerability = payload.audit?.vulnerabilities?.[0];
    assert.equal(vulnerability?.id, "GHSA-test-1234");
    assert.equal(vulnerability?.severity, "high");
    assert.deepEqual(vulnerability?.fixed, ["1.3.1"]);
  } finally {
    const child = server;
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
      ]);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("deps --sbom writes a CycloneDX file", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-sbom-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", private: true, dependencies: { "left-pad": "1.3.0" } }),
      "utf8",
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        name: "demo",
        lockfileVersion: 3,
        packages: { "": { name: "demo" }, "node_modules/left-pad": { version: "1.3.0" } },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "app.ts"), 'import leftPad from "left-pad";\n', "utf8");

    const result = runCli(["deps", "--cwd", dir, "--sbom", "out/sbom.json", "--json"], dir);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { sbom?: string };
    assert.match(payload.sbom ?? "", /out[\\/]sbom\.json$/);
    const sbom = JSON.parse(readFileSync(join(dir, "out", "sbom.json"), "utf8")) as {
      bomFormat: string;
      components: Array<{ name: string }>;
    };
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.ok(sbom.components.some((component) => component.name === "left-pad"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sast flags request data in shell and SQL sinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-sast-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "app.js"),
      [
        'const { exec } = require("node:child_process");',
        "function handler(req, db) {",
        "  exec(`rm -rf ${req.query.dir}`);",
        '  db.query("SELECT * FROM users WHERE id = " + req.query.id);',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    spawnSync("git", ["add", "app.js"], { cwd: dir });

    const result = runCli(["sast", "--cwd", dir, "--staged", "--fail-on-issue", "high", "--json"], dir);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      findings: Array<{ rule: string; severity: string }>;
      summary: { high: number };
    };
    assert.ok(payload.findings.some((finding) => finding.rule === "command-injection"));
    assert.ok(payload.findings.some((finding) => finding.rule === "sql-injection"));
    assert.ok(payload.summary.high >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sast passes clean code and emits SARIF", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-sast-clean-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "safe.js"),
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'function handler(req) { return fs.readFileSync(path.join("/data", path.basename(req.query.file))); }',
        "",
      ].join("\n"),
      "utf8",
    );
    spawnSync("git", ["add", "safe.js"], { cwd: dir });

    const clean = runCli(["sast", "--cwd", dir, "--staged", "--json"], dir);
    assert.equal(clean.status, 0, clean.stderr);
    const payload = JSON.parse(clean.stdout) as { findings: unknown[] };
    assert.deepEqual(payload.findings, []);

    const sarif = runCli(["sast", "--cwd", dir, "--staged", "--format", "sarif"], dir);
    assert.equal(sarif.status, 0, sarif.stderr);
    const report = JSON.parse(sarif.stdout) as {
      version: string;
      runs: Array<{ results: unknown[] }>;
    };
    assert.equal(report.version, "2.1.0");
    assert.deepEqual(report.runs[0]?.results, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight runs SAST on the changed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-preflight-sast-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "base.txt"), "x\n", "utf8");
    spawnSync("git", ["add", "base.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const patch = [
      "diff --git a/src/app.js b/src/app.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/app.js",
      "@@ -0,0 +1,2 @@",
      '+const { exec } = require("child_process");',
      "+exec(`rm -rf ${req.query.dir}`);",
      "",
    ].join("\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.js"), 'const { exec } = require("child_process");\nexec(`rm -rf ${req.query.dir}`);\n', "utf8");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch, "utf8");

    const result = runCli(
      ["preflight", "--diff", diffPath, "--no-deps", "--no-slop", "--json", "--cwd", dir],
      dir,
    );
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string; summary: string }>;
    };
    const sast = payload.checks.find((check) => check.id === "sast");
    assert.equal(sast?.status, "fail");
    assert.match(sast?.summary ?? "", /command-injection|1 находок/);

    const skipped = runCli(
      ["preflight", "--diff", diffPath, "--no-deps", "--no-slop", "--no-sast", "--json", "--cwd", dir],
      dir,
    );
    assert.equal(skipped.status, 0, skipped.stderr);
    const skippedPayload = JSON.parse(skipped.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(skippedPayload.checks.find((check) => check.id === "sast")?.status, "skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight runs authz on changed routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-preflight-authz-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "base.txt"), "x\n", "utf8");
    spawnSync("git", ["add", "base.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const route =
      'router.get("/users/:id", async (req, res) => { const user = await db.user.findUnique({ where: { id: req.params.id } }); res.json(user); });\n';
    const patch = [
      "diff --git a/src/routes.js b/src/routes.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/routes.js",
      "@@ -0,0 +1 @@",
      `+${route.trimEnd()}`,
      "",
    ].join("\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "routes.js"), route, "utf8");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch, "utf8");

    const result = runCli(
      ["preflight", "--diff", diffPath, "--no-deps", "--no-slop", "--no-sast", "--json", "--cwd", dir],
      dir,
    );
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string; summary: string }>;
    };
    const authz = payload.checks.find((check) => check.id === "authz");
    assert.equal(authz?.status, "fail");
    assert.match(authz?.summary ?? "", /idor|route-no-auth|2 находок/);

    const skipped = runCli(
      [
        "preflight",
        "--diff",
        diffPath,
        "--no-deps",
        "--no-slop",
        "--no-sast",
        "--no-authz",
        "--json",
        "--cwd",
        dir,
      ],
      dir,
    );
    assert.equal(skipped.status, 0, skipped.stderr);
    const skippedPayload = JSON.parse(skipped.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(skippedPayload.checks.find((check) => check.id === "authz")?.status, "skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authz flags an unauthenticated IDOR route", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-authz-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "base.txt"), "base\n", "utf8");
    spawnSync("git", ["add", "base.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const source = [
      'router.get("/users/:id", async (req, res) => {',
      "  const user = await db.user.findUnique({ where: { id: req.params.id } });",
      "  res.json(user);",
      "});",
      "",
    ].join("\n");
    const patch = [
      "diff --git a/src/routes.js b/src/routes.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/routes.js",
      "@@ -0,0 +1,4 @@",
      ...source.trimEnd().split("\n").map((line) => `+${line}`),
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, patch);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "routes.js"), source, "utf8");

    const result = runCli(["authz", "--diff", diffPath, "--json", "--cwd", dir], dir);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      routes: Array<{ route: string; method: string }>;
      findings: Array<{ rule: string; severity: string }>;
      summary: { high: number };
    };
    assert.equal(payload.routes.length, 1);
    assert.deepEqual(
      payload.findings.map((finding) => finding.rule).sort(),
      ["idor", "route-no-auth"],
    );
    assert.equal(payload.summary.high, 2);

    const publicOnly = runCli(
      ["authz", "--public", "/users", "--diff", diffPath, "--json", "--cwd", dir],
      dir,
    );
    const publicPayload = JSON.parse(publicOnly.stdout) as {
      findings: Array<{ rule: string }>;
    };
    assert.deepEqual(publicPayload.findings.map((finding) => finding.rule), ["idor"]);

    const sarif = runCli(["authz", "--diff", diffPath, "--format", "sarif", "--cwd", dir], dir);
    assert.equal(sarif.status, 1, sarif.stderr);
    const doc = JSON.parse(sarif.stdout) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    assert.equal(doc.version, "2.1.0");
    assert.ok(doc.runs[0]?.results.some((entry) => entry.ruleId === "oc-pilot/idor"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sast baseline accepts known findings and catches new ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-baseline-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "base.txt"), "x\n", "utf8");
    spawnSync("git", ["add", "base.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "app.js"),
      'const { exec } = require("child_process");\nexec(`rm -rf ${req.query.dir}`);\n',
      "utf8",
    );
    const firstDiff = join(dir, "first.diff");
    writeFileSync(
      firstDiff,
      [
        "diff --git a/src/app.js b/src/app.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/app.js",
        "@@ -0,0 +1,2 @@",
        '+const { exec } = require("child_process");',
        "+exec(`rm -rf ${req.query.dir}`);",
        "",
      ].join("\n"),
      "utf8",
    );

    const updated = runCli(
      ["sast", "--diff", firstDiff, "--update-baseline", "--baseline", ".oc-pilot/baseline.json", "--cwd", dir, "--json"],
      dir,
    );
    assert.equal(updated.status, 0, updated.stderr);
    const updatePayload = JSON.parse(updated.stdout) as { baseline?: { updated?: boolean; entries?: number } };
    assert.equal(updatePayload.baseline?.updated, true);
    assert.equal(updatePayload.baseline?.entries, 1);
    assert.ok(existsSync(join(dir, ".oc-pilot", "baseline.json")));

    const filtered = runCli(
      ["sast", "--diff", firstDiff, "--baseline", ".oc-pilot/baseline.json", "--cwd", dir, "--json"],
      dir,
    );
    assert.equal(filtered.status, 0, filtered.stderr);
    const filteredPayload = JSON.parse(filtered.stdout) as { findings: unknown[]; baselineSuppressed?: number };
    assert.deepEqual(filteredPayload.findings, []);
    assert.equal(filteredPayload.baselineSuppressed, 1);

    writeFileSync(join(dir, "src", "other.js"), "eval(req.query.code);\n", "utf8");
    const secondDiff = join(dir, "second.diff");
    writeFileSync(
      secondDiff,
      [
        "diff --git a/src/app.js b/src/app.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/app.js",
        "@@ -0,0 +1,2 @@",
        '+const { exec } = require("child_process");',
        "+exec(`rm -rf ${req.query.dir}`);",
        "diff --git a/src/other.js b/src/other.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/other.js",
        "@@ -0,0 +1 @@",
        "+eval(req.query.code);",
        "",
      ].join("\n"),
      "utf8",
    );

    const fresh = runCli(
      ["sast", "--diff", secondDiff, "--baseline", ".oc-pilot/baseline.json", "--cwd", dir, "--json"],
      dir,
    );
    assert.equal(fresh.status, 1, fresh.stderr);
    const freshPayload = JSON.parse(fresh.stdout) as { findings: Array<{ rule: string }>; baselineSuppressed?: number };
    assert.equal(freshPayload.baselineSuppressed, 1);
    assert.deepEqual(freshPayload.findings.map((finding) => finding.rule), ["code-injection"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix --from-sast repairs a vulnerable line", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-fix-sast-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "base.txt"), "x\n", "utf8");
    spawnSync("git", ["add", "base.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "app.js"),
      'const { exec } = require("child_process");\nexec(req.query.cmd);\n',
      "utf8",
    );
    const diff = [
      "diff --git a/src/app.js b/src/app.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/app.js",
      "@@ -0,0 +1,2 @@",
      '+const { exec } = require("child_process");',
      "+exec(req.query.cmd);",
      "",
    ].join("\n");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(diffPath, diff, "utf8");

    const patch = [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -1,2 +1 @@",
      '-const { exec } = require("child_process");',
      "-exec(req.query.cmd);",
      "+console.log(req.query.cmd);",
      "",
    ].join("\n");

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["fix", "--from-sast", "--diff", diffPath, "--apply", "--no-tests", "--cwd", dir, "--json"],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      sast?: { before: number; after: number; remaining: number };
    };
    assert.equal(payload.applied, true);
    assert.deepEqual(payload.sast, { before: 1, after: 0, remaining: 0 });
    assert.match(readFileSync(join(dir, "src", "app.js"), "utf8"), /console\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fix --from-authz repairs an IDOR route", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-cli-fix-authz-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "base.txt"), "x\n", "utf8");
    spawnSync("git", ["add", "base.txt"], { cwd: dir });
    spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
      { cwd: dir },
    );

    const source = [
      'const express = require("express");',
      "const router = express.Router();",
      'router.get("/users/:id", async (req, res) => {',
      "  const user = await db.user.findUnique({ where: { id: req.params.id } });",
      "  res.json(user);",
      "});",
      "module.exports = router;",
      "",
    ].join("\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "routes.js"), source, "utf8");
    const diffPath = join(dir, "changes.diff");
    writeFileSync(
      diffPath,
      [
        "diff --git a/src/routes.js b/src/routes.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/routes.js",
        "@@ -0,0 +1,7 @@",
        '+const express = require("express");',
        "+const router = express.Router();",
        '+router.get("/users/:id", async (req, res) => {',
        "+  const user = await db.user.findUnique({ where: { id: req.params.id } });",
        "+  res.json(user);",
        "+});",
        "+module.exports = router;",
        "",
      ].join("\n"),
      "utf8",
    );

    const patch = [
      "diff --git a/src/routes.js b/src/routes.js",
      "--- a/src/routes.js",
      "+++ b/src/routes.js",
      "@@ -3,4 +3,6 @@",
      ' router.get("/users/:id", async (req, res) => {',
      "   const user = await db.user.findUnique({ where: { id: req.params.id } });",
      "+  if (!req.user) return res.status(401).end();",
      "+  if (user.id !== req.user.id) return res.status(403).end();",
      "   res.json(user);",
      " });",
      "",
    ].join("\n");

    const fake = installFakeOpenCode(dir);
    const result = runCli(
      ["fix", "--from-authz", "--diff", diffPath, "--apply", "--no-tests", "--cwd", dir, "--json"],
      dir,
      { ...fake, FAKE_PATCH_TEXT: patch },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      authz?: { before: number; after: number; remaining: number };
    };
    assert.equal(payload.applied, true);
    assert.ok((payload.authz?.before ?? 0) >= 1);
    assert.equal(payload.authz?.after, 0);
    assert.equal(payload.authz?.remaining, 0);
    assert.match(readFileSync(join(dir, "src", "routes.js"), "utf8"), /req\.user\.id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
