import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
