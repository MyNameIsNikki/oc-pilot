import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { readReceipt, receiptPath, verifyReceipt, type Receipt } from "./receipt.js";

export interface ComplianceCheck {
  id: string;
  status: string;
  summary: string;
}

export interface ComplianceManifestBody {
  version: 1;
  tool: "oc-pilot";
  createdAt: string;
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  previous: string | null;
  receipt: { path: string; hash: string; ok: boolean; signature: string } | null;
  checks: ComplianceCheck[];
  tests: { command: string; passed: boolean; exitCode: number | null } | null;
  sbom: { path: string; hash: string } | null;
  model: string | null;
}

export interface ComplianceManifest extends ComplianceManifestBody {
  hash: string;
  signature?: string;
}

export interface ComplianceVerification {
  ok: boolean;
  hashOk: boolean;
  chainOk: boolean;
  commitOk: boolean;
  signature: "valid" | "invalid" | "missing" | "unchecked";
  commit: string | null;
  head: string | null;
  reason?: string;
}

export interface BuildComplianceOptions {
  receiptPath?: string;
  sbomPath?: string;
  model?: string;
  previous?: ComplianceManifest | null;
}

export interface VerifyComplianceOptions {
  publicKeyPem?: string;
}

const MANIFEST_VERSION = 1;

export function complianceDir(cwd: string): string {
  return join(cwd, ".oc-pilot", "compliance");
}

export function latestManifestPath(cwd: string): string {
  return join(complianceDir(cwd), "latest.json");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function manifestBody(manifest: ComplianceManifest): ComplianceManifestBody {
  const { hash: _hash, signature: _signature, ...body } = manifest;
  return body;
}

export function manifestHash(manifest: ComplianceManifest): string {
  return sha256(stable(manifestBody(manifest)));
}

export function buildComplianceManifest(cwd: string, options: BuildComplianceOptions = {}): ComplianceManifest {
  const head = runGit(["rev-parse", "HEAD"], cwd);
  const commit = head.status === 0 ? head.stdout.trim() : null;
  const branchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const status = runGit(["status", "--porcelain"], cwd);
  const dirty = status.status === 0 && status.stdout.trim().length > 0;

  const receiptFile = options.receiptPath ? resolve(cwd, options.receiptPath) : receiptPath(cwd);
  let receipt: Receipt | null = null;
  let receiptSummary: ComplianceManifestBody["receipt"] = null;
  let checks: ComplianceCheck[] = [];
  let tests: ComplianceManifestBody["tests"] = null;
  if (receiptFile && existsSync(receiptFile)) {
    receipt = readReceipt(receiptFile);
    const verification = verifyReceipt(cwd, receipt);
    receiptSummary = {
      path: receiptFile,
      hash: receipt.hash,
      ok: verification.ok,
      signature: verification.signature,
    };
    checks = receipt.preflight.checks.map((check) => ({
      id: check.id,
      status: check.status,
      summary: check.summary,
    }));
    tests = receipt.tests
      ? { command: receipt.tests.command, passed: receipt.tests.passed, exitCode: receipt.tests.exitCode }
      : null;
  }

  let sbom: ComplianceManifestBody["sbom"] = null;
  if (options.sbomPath) {
    const sbomPath = resolve(cwd, options.sbomPath);
    if (!existsSync(sbomPath)) {
      throw new PilotError(`SBOM не найден: ${options.sbomPath}`, { exitCode: 2 });
    }
    sbom = { path: sbomPath, hash: sha256(readFileSync(sbomPath, "utf8")) };
  }

  const previous =
    options.previous !== undefined ? options.previous : loadLatestManifest(cwd);

  const body: ComplianceManifestBody = {
    version: MANIFEST_VERSION,
    tool: "oc-pilot",
    createdAt: new Date().toISOString(),
    commit,
    branch,
    dirty,
    previous: previous?.hash ?? null,
    receipt: receiptSummary,
    checks,
    tests,
    sbom,
    model: options.model ?? null,
  };
  const manifest: ComplianceManifest = { ...body, hash: sha256(stable(body)) };
  return manifest;
}

export function signComplianceManifest(manifest: ComplianceManifest, privateKeyPem: string): ComplianceManifest {
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(stable(manifestBody(manifest)), "utf8"), key).toString("base64");
  return { ...manifest, signature };
}

export function verifyComplianceManifest(
  cwd: string,
  manifest: ComplianceManifest,
  options: VerifyComplianceOptions = {},
): ComplianceVerification {
  const hashOk = manifestHash(manifest) === manifest.hash;
  const headResult = runGit(["rev-parse", "HEAD"], cwd);
  const head = headResult.status === 0 ? headResult.stdout.trim() : null;
  const commitOk = manifest.commit === null || manifest.commit === head;

  let chainOk = manifest.previous === null;
  if (manifest.previous !== null) {
    chainOk = findManifestByHash(cwd, manifest.previous) !== undefined;
  }

  let signature: ComplianceVerification["signature"] = "unchecked";
  if (manifest.signature === undefined) {
    signature = "missing";
  } else if (options.publicKeyPem) {
    try {
      const key = createPublicKey(options.publicKeyPem);
      const valid = verify(
        null,
        Buffer.from(stable(manifestBody(manifest)), "utf8"),
        key,
        Buffer.from(manifest.signature, "base64"),
      );
      signature = valid ? "valid" : "invalid";
    } catch {
      signature = "invalid";
    }
  }

  const ok = hashOk && commitOk && chainOk && signature !== "invalid";
  const reason = !hashOk
    ? "хеш манифеста не совпадает"
    : !commitOk
      ? "манифест относится к другому коммиту"
      : !chainOk
        ? "предыдущий манифест не найден в цепочке"
        : signature === "invalid"
          ? "подпись недействительна"
          : undefined;

  return { ok, hashOk, chainOk, commitOk, signature, commit: manifest.commit, head, ...(reason ? { reason } : {}) };
}

export function findManifestByHash(cwd: string, hash: string): ComplianceManifest | undefined {
  const dir = complianceDir(cwd);
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(dir, entry), "utf8")) as ComplianceManifest;
      if (manifest.hash === hash) return manifest;
    } catch {
      // Ignore unreadable manifests; verification reports the broken chain.
    }
  }
  return undefined;
}

export function loadLatestManifest(cwd: string): ComplianceManifest | null {
  const path = latestManifestPath(cwd);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ComplianceManifest;
  } catch {
    return null;
  }
}

export function saveComplianceManifest(cwd: string, manifest: ComplianceManifest, output?: string): string {
  const target = output ? resolve(cwd, output) : join(complianceDir(cwd), `manifest-${manifest.hash.slice(0, 12)}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (!output) {
    writeFileSync(latestManifestPath(cwd), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return target;
}

export function readComplianceManifest(path: string): ComplianceManifest {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ComplianceManifest;
  } catch (error) {
    throw new PilotError(`Не удалось прочитать манифест: ${path}`, {
      hint: error instanceof Error ? error.message : undefined,
      exitCode: 2,
    });
  }
}

export function describeCompliance(manifest: ComplianceManifest): string {
  const failed = manifest.checks.filter((check) => check.status === "fail");
  const lines = [
    `Коммит: ${manifest.commit ?? "нет"} (${manifest.branch ?? "detached"})${manifest.dirty ? ", дерево изменено" : ""}.`,
    `Проверок: ${String(manifest.checks.length)}, провалено: ${String(failed.length)}.`,
    `Тесты: ${manifest.tests ? (manifest.tests.passed ? "пройдены" : "провалены") : "нет данных"}.`,
    `Квитанция: ${manifest.receipt ? (manifest.receipt.ok ? "действительна" : "недействительна") : "нет"}.`,
    `SBOM: ${manifest.sbom ? "приложен" : "нет"}.`,
    `Хеш: ${manifest.hash}.`,
  ];
  if (manifest.previous) lines.push(`Предыдущий манифест: ${manifest.previous}.`);
  return `${lines.join("\n")}\n`;
}
