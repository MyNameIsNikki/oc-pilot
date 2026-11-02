import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SecretFinding } from "../types.js";
import { truncateText } from "./diff.js";
import { loadSecretIgnore, scanText } from "./secrets.js";

export interface FileContextOptions {
  maxTotalChars?: number;
  maxFileChars?: number;
  redact?: boolean;
}

export interface FileContextResult {
  text: string;
  files: string[];
  findings: SecretFinding[];
  omitted: string[];
}

const DEFAULT_TOTAL = 60_000;
const DEFAULT_FILE = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Builds a fallback full-file context for --no-repo-context. Only files inside
 * the analyzed project are read; secrets are redacted with the shared scanner.
 */
export function buildFileContext(
  cwd: string,
  changedFiles: string[],
  options: FileContextOptions = {},
): FileContextResult {
  const maxTotal = options.maxTotalChars ?? DEFAULT_TOTAL;
  const maxFile = options.maxFileChars ?? DEFAULT_FILE;
  const redact = options.redact !== false;
  const findings: SecretFinding[] = [];
  const included: string[] = [];
  const omitted: string[] = [];
  const blocks: string[] = [];
  let used = 0;

  for (const changed of [...new Set(changedFiles)]) {
    const absolute = resolve(cwd, changed);
    const rel = relative(cwd, absolute).replace(/\\/g, "/");
    if (isAbsolute(changed) || rel === "" || rel.startsWith("../") || rel === "..") {
      omitted.push(changed);
      continue;
    }

    let content: string;
    try {
      if (!statSync(absolute).isFile() || statSync(absolute).size > MAX_FILE_BYTES) {
        omitted.push(rel);
        continue;
      }
      content = readFileSync(absolute, "utf8");
    } catch {
      omitted.push(rel);
      continue;
    }

    if (content.includes("\0")) {
      omitted.push(rel);
      continue;
    }

    const scan = redact
      ? scanText(content, rel, { ignore: loadSecretIgnore(cwd) })
      : { findings: [], redacted: content };
    findings.push(...scan.findings);
    const perFile = truncateText(scan.redacted, maxFile, { mode: "head" });
    const block = `--- FILE: ${rel} ---\n${perFile.text.trimEnd()}`;

    if (used + block.length > maxTotal && included.length > 0) {
      omitted.push(rel);
      continue;
    }

    blocks.push(block);
    included.push(rel);
    used += block.length;
  }

  return { text: blocks.join("\n\n"), files: included, findings, omitted };
}
