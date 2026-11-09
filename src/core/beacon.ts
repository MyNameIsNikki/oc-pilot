import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION } from "../version.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { canonicalJson } from "./passport.js";

export type BeaconCheckStatus = "pass" | "warn" | "fail" | "skip";
export type BeaconVerdict = "pass" | "warn" | "fail";

export interface BeaconCheck {
  name: string;
  status: BeaconCheckStatus;
  command?: string;
}

export type BeaconSignature =
  | { type: "hmac-sha256"; value: string }
  | { type: "ssh"; namespace: "oc-pilot-beacon"; value: string };

export interface BeaconManifest {
  version: 1;
  tool: "oc-pilot";
  toolVersion: string;
  createdAt: string;
  commit: string;
  tree: string;
  agent?: string;
  model?: string;
  promptHash?: string;
  checks: BeaconCheck[];
  commands: string[];
  verdict: BeaconVerdict;
  digest: string;
  signature?: BeaconSignature;
}

export type BeaconVerifyStatus = "valid" | "unsigned" | "tampered" | "unattributed" | "missing" | "error";

export interface BeaconVerifyResult {
  status: BeaconVerifyStatus;
  summary: string;
  manifest?: BeaconManifest;
  content: string;
}

export interface CreateBeaconOptions {
  checks?: BeaconCheck[];
  commands?: string[];
  agent?: string;
  model?: string;
  promptHash?: string;
  keyPath?: string;
  sshKeyPath?: string;
}

export interface VerifyBeaconOptions {
  keyPath?: string;
  allowedSigners?: string;
  identity?: string;
}

export const BEACON_PATH = ".oc-pilot/beacon.json";
const BEACON_VERSION = 1;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function beaconDigest(base: Omit<BeaconManifest, "digest" | "signature">): string {
  return `sha256:${sha256(canonicalJson(base))}`;
}

function hmacValue(key: Buffer, digest: string): string {
  return createHmac("sha256", key).update(digest).digest("hex");
}

function readKey(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new PilotError(`Не удалось прочитать ключ ${path}`, {
      hint: "Проверьте путь к файлу ключа.",
      exitCode: 2,
    });
  }
}

export function beaconPath(cwd: string): string {
  return join(cwd, ".oc-pilot", "beacon.json");
}

function verdictOf(checks: BeaconCheck[]): BeaconVerdict {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.length === 0 || checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

export function parseBeaconCheck(raw: string): BeaconCheck {
  const match = /^(.+?)=(pass|warn|fail|skip)$/i.exec(raw.trim());
  if (!match?.[1] || !match[2]) {
    throw new PilotError(`Некорректная проверка: ${raw}`, {
      hint: "Используйте name=pass|warn|fail|skip.",
      exitCode: 2,
    });
  }
  return { name: match[1].trim(), status: match[2].toLowerCase() as BeaconCheckStatus };
}

function signSsh(body: string, keyPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-beacon-"));
  const file = join(dir, "beacon.json");
  try {
    writeFileSync(file, body, "utf8");
    const result = spawnSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", "oc-pilot-beacon", file], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
      throw new PilotError("Не удалось подписать beacon через ssh-keygen", {
        hint: result.error?.message || result.stderr?.trim() || "Проверьте ключ и ssh-keygen.",
        exitCode: 2,
      });
    }
    const signature = readFileSync(`${file}.sig`);
    return signature.toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verifySsh(
  body: string,
  signatureBase64: string,
  allowedSigners: string,
  identity: string,
): boolean {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-beacon-verify-"));
  const sigFile = join(dir, "beacon.sig");
  try {
    writeFileSync(sigFile, Buffer.from(signatureBase64, "base64"));
    const result = spawnSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", allowedSigners, "-I", identity, "-n", "oc-pilot-beacon", "-s", sigFile],
      { input: body, encoding: "utf8", timeout: 30_000 },
    );
    return !result.error && result.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Creates a verification beacon for HEAD, optionally signed with HMAC or ssh-keygen. */
export function createBeacon(cwd: string, options: CreateBeaconOptions = {}): BeaconManifest {
  if (options.keyPath && options.sshKeyPath) {
    throw new PilotError("Выберите один способ подписи: --key или --ssh-key", { exitCode: 2 });
  }
  const commit = runGit(["rev-parse", "HEAD"], cwd);
  if (commit.status !== 0) {
    throw new PilotError("Beacon требует хотя бы один коммит", {
      hint: "Сделайте первый коммит.",
      exitCode: 2,
    });
  }
  const tree = runGit(["rev-parse", "HEAD^{tree}"], cwd);
  if (tree.status !== 0) {
    throw new PilotError("Не удалось определить tree коммита", { exitCode: 2 });
  }

  const checks = options.checks ?? [];
  const base: Omit<BeaconManifest, "digest" | "signature"> = {
    version: BEACON_VERSION,
    tool: "oc-pilot",
    toolVersion: VERSION,
    createdAt: new Date().toISOString(),
    commit: commit.stdout.trim(),
    tree: tree.stdout.trim(),
    agent: options.agent,
    model: options.model,
    promptHash: options.promptHash,
    checks,
    commands: options.commands ?? [],
    verdict: verdictOf(checks),
  };
  const digest = beaconDigest(base);
  const manifest: BeaconManifest = { ...base, digest };

  if (options.keyPath) {
    manifest.signature = { type: "hmac-sha256", value: hmacValue(readKey(options.keyPath), digest) };
  } else if (options.sshKeyPath) {
    manifest.signature = {
      type: "ssh",
      namespace: "oc-pilot-beacon",
      value: signSsh(canonicalJson(base), options.sshKeyPath),
    };
  }

  const path = beaconPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function readBeacon(cwd: string): BeaconManifest | undefined {
  const path = beaconPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BeaconManifest>;
    if (
      parsed.version !== BEACON_VERSION ||
      typeof parsed.commit !== "string" ||
      typeof parsed.tree !== "string" ||
      typeof parsed.digest !== "string" ||
      !Array.isArray(parsed.checks) ||
      !Array.isArray(parsed.commands)
    ) {
      return undefined;
    }
    return parsed as BeaconManifest;
  } catch {
    return undefined;
  }
}

export function verifyBeacon(cwd: string, options: VerifyBeaconOptions = {}): BeaconVerifyResult {
  const manifest = readBeacon(cwd);
  if (!manifest) {
    const result: BeaconVerifyResult = {
      status: "missing",
      summary: "[BEACON MISSING]: .oc-pilot/beacon.json не найден или повреждён.",
      content: "",
    };
    result.content = renderBeaconVerify(result);
    return result;
  }

  const { digest, signature, ...base } = manifest;
  if (beaconDigest(base) !== digest) {
    const result: BeaconVerifyResult = {
      status: "tampered",
      summary: "[BEACON TAMPERED]: digest манифеста не совпадает с содержимым.",
      manifest,
      content: "",
    };
    result.content = renderBeaconVerify(result);
    return result;
  }

  if (!signature) {
    const result: BeaconVerifyResult = {
      status: "unsigned",
      summary: "[UNATTRIBUTED]: beacon не подписан; digest цел, но автор не подтверждён.",
      manifest,
      content: "",
    };
    result.content = renderBeaconVerify(result);
    return result;
  }

  if (signature.type === "hmac-sha256") {
    if (!options.keyPath) {
      const result: BeaconVerifyResult = {
        status: "error",
        summary: "[BEACON ERROR]: для HMAC-подписи нужен --key.",
        manifest,
        content: "",
      };
      result.content = renderBeaconVerify(result);
      return result;
    }
    const expected = Buffer.from(hmacValue(readKey(options.keyPath), digest), "hex");
    const actual = Buffer.from(signature.value, "hex");
    const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
    const result: BeaconVerifyResult = valid
      ? { status: "valid", summary: "[BEACON VALID]: digest и HMAC-подпись совпадают.", manifest, content: "" }
      : { status: "unattributed", summary: "[UNATTRIBUTED]: HMAC-подпись не совпадает.", manifest, content: "" };
    result.content = renderBeaconVerify(result);
    return result;
  }

  if (!options.allowedSigners || !options.identity) {
    const result: BeaconVerifyResult = {
      status: "error",
      summary: "[BEACON ERROR]: для SSH-подписи нужны --allowed-signers и --identity.",
      manifest,
      content: "",
    };
    result.content = renderBeaconVerify(result);
    return result;
  }
  const valid = verifySsh(canonicalJson(base), signature.value, options.allowedSigners, options.identity);
  const result: BeaconVerifyResult = valid
    ? { status: "valid", summary: "[BEACON VALID]: digest и SSH-подпись совпадают.", manifest, content: "" }
    : { status: "unattributed", summary: "[UNATTRIBUTED]: SSH-подпись не подтверждена.", manifest, content: "" };
  result.content = renderBeaconVerify(result);
  return result;
}

export function clearBeacon(cwd: string): { removed: boolean } {
  const path = beaconPath(cwd);
  if (!existsSync(path)) return { removed: false };
  rmSync(path, { force: true });
  return { removed: true };
}

export function renderBeacon(manifest: BeaconManifest): string {
  const signature = manifest.signature ? manifest.signature.type : "none";
  const lines = [
    `Beacon: ${manifest.verdict}`,
    `Commit: ${manifest.commit}`,
    `Tree: ${manifest.tree}`,
    manifest.agent ? `Agent: ${manifest.agent}` : "",
    manifest.model ? `Model: ${manifest.model}` : "",
    `Checks: ${manifest.checks.length === 0 ? "нет" : manifest.checks.map((check) => `${check.name}=${check.status}`).join(", ")}`,
    manifest.commands.length > 0 ? `Commands: ${manifest.commands.join(" | ")}` : "",
    `Signature: ${signature}`,
    `Digest: ${manifest.digest}`,
  ].filter((line) => line.length > 0);
  return `${lines.join("\n")}\n`;
}

export function renderBeaconMarkdown(manifest: BeaconManifest): string {
  const checks =
    manifest.checks.length === 0
      ? "нет"
      : manifest.checks.map((check) => `\`${check.name}\` ${check.status}`).join(", ");
  const signature = manifest.signature ? manifest.signature.type : "UNATTRIBUTED";
  return [
    "## oc-pilot beacon",
    "",
    `- **Verdict:** ${manifest.verdict}`,
    `- **Commit:** \`${manifest.commit}\``,
    `- **Tree:** \`${manifest.tree}\``,
    manifest.agent ? `- **Agent:** ${manifest.agent}` : "",
    manifest.model ? `- **Model:** ${manifest.model}` : "",
    `- **Checks:** ${checks}`,
    `- **Signature:** ${signature}`,
    `- **Digest:** \`${manifest.digest}\``,
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function renderBeaconVerify(result: BeaconVerifyResult): string {
  const lines = [`Beacon: ${result.status}`, result.summary];
  if (result.manifest) {
    lines.push(`Commit: ${result.manifest.commit}`);
    lines.push(`Verdict: ${result.manifest.verdict}`);
    lines.push(`Checks: ${String(result.manifest.checks.length)}`);
  }
  return `${lines.join("\n")}\n`;
}
