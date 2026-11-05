import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AuthzFinding } from "./authz.js";
import { PilotError } from "./errors.js";
import type { SastFinding } from "./sast.js";

export const BASELINE_VERSION = 1;
export const DEFAULT_BASELINE_PATH = ".oc-pilot/baseline.json";

export interface FindingsBaseline {
  version: number;
  sast: string[];
  authz: string[];
}

export interface LoadedBaseline {
  path: string;
  baseline: FindingsBaseline;
  exists: boolean;
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/** A SAST finding keeps its identity when the file moves lines or gains whitespace. */
export function sastFingerprint(finding: SastFinding): string {
  return fingerprint(["sast", finding.rule, finding.file, finding.snippet.trim()]);
}

/** A route finding is identified by the rule and the route it protects. */
export function authzFingerprint(finding: AuthzFinding): string {
  return fingerprint(["authz", finding.rule, finding.file, finding.method, finding.route]);
}

export function emptyBaseline(): FindingsBaseline {
  return { version: BASELINE_VERSION, sast: [], authz: [] };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function loadFindingsBaseline(cwd: string, file: string = DEFAULT_BASELINE_PATH): LoadedBaseline {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return { path, baseline: emptyBaseline(), exists: false };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new PilotError(`Не удалось прочитать baseline: ${file}`, {
      hint: "Файл baseline должен содержать JSON, созданный через --update-baseline.",
      exitCode: 2,
    });
  }
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  return {
    path,
    exists: true,
    baseline: {
      version: BASELINE_VERSION,
      sast: stringArray(record.sast),
      authz: stringArray(record.authz),
    },
  };
}

export function saveFindingsBaseline(cwd: string, file: string, baseline: FindingsBaseline): string {
  const path = resolve(cwd, file);
  mkdirSync(dirname(path), { recursive: true });
  const payload: FindingsBaseline = {
    version: BASELINE_VERSION,
    sast: [...new Set(baseline.sast)].sort(),
    authz: [...new Set(baseline.authz)].sort(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
