import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitDiffBlocks } from "./diff.js";

export interface EnvReference {
  name: string;
  file: string;
  line: number;
  source: "process.env" | "import.meta.env" | "Deno.env" | "Bun.env";
}

export interface EnvSyncReport {
  references: EnvReference[];
  envFiles: string[];
  exampleFiles: string[];
  defined: string[];
  documented: string[];
  missing: string[];
  undocumented: string[];
  status: "pass" | "warn" | "fail";
}

/** Variables that every runtime provides and that need no project documentation. */
const IGNORED = new Set([
  "NODE_ENV",
  "CI",
  "HOME",
  "PATH",
  "PWD",
  "TMPDIR",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
]);

const PATTERNS: Array<{ source: EnvReference["source"]; regex: RegExp }> = [
  { source: "process.env", regex: /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g },
  { source: "process.env", regex: /\bprocess\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g },
  { source: "import.meta.env", regex: /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g },
  { source: "Deno.env", regex: /\bDeno\.env\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g },
  { source: "Bun.env", regex: /\bBun\.env\.([A-Za-z_][A-Za-z0-9_]*)/g },
];

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function isExampleFile(name: string): boolean {
  return name === ".env.example" || name === ".env.sample" || name === ".env.template";
}

/** Lists the environment files in the repository root, including examples. */
export function listEnvFiles(cwd: string): string[] {
  try {
    return readdirSync(cwd)
      .filter((name) => name === ".env" || name.startsWith(".env."))
      .sort();
  } catch {
    return [];
  }
}

function readNames(cwd: string, name: string): string[] {
  try {
    const text = readFileSync(join(cwd, name), "utf8");
    const names: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = ENV_LINE.exec(line);
      if (match?.[1]) names.push(match[1]);
    }
    return names;
  } catch {
    return [];
  }
}

/** Extracts added env-var references from a unified diff. */
export function extractEnvReferences(diff: string): EnvReference[] {
  const references: EnvReference[] = [];
  for (const block of splitDiffBlocks(diff)) {
    if (block.path === "(diff)" || block.path === "(unknown)") continue;
    let newLine = 0;
    for (const line of block.text.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk?.[1]) {
        newLine = Number.parseInt(hunk[1], 10);
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        const added = line.slice(1);
        for (const { source, regex } of PATTERNS) {
          regex.lastIndex = 0;
          for (let match = regex.exec(added); match; match = regex.exec(added)) {
            const name = match[1];
            if (!name || IGNORED.has(name)) continue;
            references.push({ name, file: block.path, line: newLine, source });
          }
        }
        newLine += 1;
      } else if (line.startsWith(" ") || line === "") {
        newLine += 1;
      }
    }
  }
  return references;
}

/** Compares the env vars introduced by a diff with the project's .env files. */
export function analyzeEnvSync(cwd: string, diff: string): EnvSyncReport {
  const references = extractEnvReferences(diff);
  const envFiles = listEnvFiles(cwd);
  const exampleFiles = envFiles.filter(isExampleFile);
  const defined = new Set<string>();
  const documented = new Set<string>();
  for (const file of envFiles) {
    const names = readNames(cwd, file);
    for (const name of names) defined.add(name);
    if (isExampleFile(file)) {
      for (const name of names) documented.add(name);
    }
  }

  const missing = [...new Set(references.map((reference) => reference.name))]
    .filter((name) => !defined.has(name))
    .sort();
  const undocumented = [...new Set(references.map((reference) => reference.name))]
    .filter((name) => defined.has(name) && !documented.has(name))
    .sort();

  return {
    references,
    envFiles,
    exampleFiles,
    defined: [...defined].sort(),
    documented: [...documented].sort(),
    missing,
    undocumented,
    status: missing.length > 0 ? "fail" : undocumented.length > 0 ? "warn" : "pass",
  };
}
