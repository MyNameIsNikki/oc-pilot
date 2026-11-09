import { collectAddedLines, type AddedLine } from "./alien-dna.js";
import { splitDiffBlocks } from "./diff.js";
import { scanSource } from "./sast.js";
import { isCodeFile, isTestFile } from "./slop/source.js";

export type PolygraphKind =
  | "test-added"
  | "file-added"
  | "file-removed"
  | "api-change"
  | "dependency"
  | "docs"
  | "security"
  | "behavior"
  | "refactor"
  | "other";

export type PolygraphPolarity = "positive" | "negative";

export interface PolygraphClaim {
  kind: PolygraphKind;
  text: string;
  polarity: PolygraphPolarity;
}

export type PolygraphClaimStatus = "supported" | "contradicted" | "unverifiable";

export interface PolygraphClaimCheck {
  claim: PolygraphClaim;
  status: PolygraphClaimStatus;
  evidence: string;
}

export interface PolygraphChangedLine {
  path: string;
  text: string;
  kind: "added" | "removed";
}

export interface PolygraphFacts {
  changed: string[];
  added: string[];
  removed: string[];
  modified: string[];
  addedLines: AddedLine[];
  changedLines: PolygraphChangedLine[];
  dependencies: string[];
  removedDependencies: string[];
  testsTouched: boolean;
  docsTouched: boolean;
  behaviorTouched: boolean;
}

export type PolygraphStatus = "verified" | "contradicted" | "inconclusive" | "error";

export interface PolygraphReport {
  source: string;
  claims: PolygraphClaimCheck[];
  counts: Record<PolygraphClaimStatus, number>;
  status: PolygraphStatus;
  summary: string;
  content: string;
}

const KINDS = new Set<PolygraphKind>([
  "test-added",
  "file-added",
  "file-removed",
  "api-change",
  "dependency",
  "docs",
  "security",
  "behavior",
  "refactor",
  "other",
]);

const MAX_CLAIMS = 20;
const MAX_CLAIM_CHARS = 500;

const DOC_PATH = /^(?:docs\/|readme|changelog|contributing|license|authors)/i;
const DOC_EXT = /\.(?:md|mdx|rst)$/i;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$/i;
const API_PATTERN =
  /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\b|export\s*\{|(?:async\s+)?def\s+[A-Za-z_]|func\s+(?:\([^)]*\)\s*)?[A-Z]|pub\s+(?:fn|struct|enum|trait|mod)\b|public\s+(?:static\s+)?(?:class|interface|enum|void|final|[A-Z]\w*))/;
const SECURITY_PATTERN =
  /(?:auth|sanitiz|escape|csrf|csp|permission|encrypt|decrypt|hash|bcrypt|argon|validate|secret|token|tls|https|helmet|rate.?limit|allowlist|denylist|content-security)/i;
const DEPENDENCY_KEY_BLOCKLIST = new Set(["name", "version", "node", "npm", "engines", "packageManager", "type"]);

function isDoc(path: string): boolean {
  return DOC_PATH.test(path) || DOC_EXT.test(path);
}

function isBehaviorPath(path: string): boolean {
  if (isDoc(path) || isTestFile(path) || LOCKFILE.test(path)) return false;
  return !path.startsWith(".oc-pilot/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function dependenciesFrom(line: string): string[] {
  const found: string[] = [];
  const json = /"(@?[A-Za-z0-9._/-]+)"\s*:\s*"[~^<>=0-9]/.exec(line);
  if (json?.[1] && !DEPENDENCY_KEY_BLOCKLIST.has(json[1])) found.push(json[1]);
  const requirement = /^\s*([A-Za-z0-9_.-]+)\s*(?:==|>=|<=|~=|!=)/.exec(line);
  if (requirement?.[1] && requirement[1].toLowerCase() !== "python") found.push(requirement[1]);
  const go = /^\s*([A-Za-z0-9._/-]+\.[A-Za-z0-9._/-]+)\s+v[0-9]/.exec(line);
  if (go?.[1]) found.push(go[1]);
  return found;
}

function collectRemovedLines(diff: string): PolygraphChangedLine[] {
  const removed: PolygraphChangedLine[] = [];
  for (const block of splitDiffBlocks(diff)) {
    if (block.path === "(unknown)" || block.path === "(diff)") continue;
    let inHunk = false;
    for (const raw of block.text.split(/\r?\n/)) {
      if (raw === "") continue;
      if (/^@@ /.test(raw)) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (raw.startsWith("---") || raw.startsWith("+++")) continue;
      if (raw.startsWith("-")) removed.push({ path: block.path, text: raw.slice(1), kind: "removed" });
    }
  }
  return removed;
}

/** Turns a unified diff into deterministic facts that claims can be checked against. */
export function buildDiffFacts(diff: string): PolygraphFacts {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const block of splitDiffBlocks(diff)) {
    if (block.path === "(unknown)" || block.path === "(diff)") continue;
    if (/^new file mode /m.test(block.text)) added.push(block.path);
    else if (/^deleted file mode /m.test(block.text)) removed.push(block.path);
    else modified.push(block.path);
  }

  const changed = unique([...added, ...removed, ...modified]);
  const addedLines = collectAddedLines(diff);
  const removedLines = collectRemovedLines(diff);
  const changedLines: PolygraphChangedLine[] = [
    ...addedLines.map((line) => ({ path: line.path, text: line.text, kind: "added" as const })),
    ...removedLines,
  ];

  return {
    changed,
    added: unique(added),
    removed: unique(removed),
    modified: unique(modified),
    addedLines,
    changedLines,
    dependencies: unique(addedLines.flatMap((line) => dependenciesFrom(line.text))),
    removedDependencies: unique(removedLines.flatMap((line) => dependenciesFrom(line.text))),
    testsTouched: changed.some((path) => isTestFile(path)),
    docsTouched: changed.some((path) => isDoc(path)),
    behaviorTouched: changed.some((path) => isBehaviorPath(path)),
  };
}

function check(
  target: PolygraphClaim,
  status: PolygraphClaimStatus,
  evidence: string,
): PolygraphClaimCheck {
  return { claim: target, status, evidence };
}

function claimedPaths(text: string): string[] {
  const found = text.match(/`?[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+`?/g) ?? [];
  return unique(
    found
      .map((value) => value.replace(/`/g, "").replace(/^\.\//, "").replace(/[.,;:]+$/, ""))
      .filter((value) =>
        /\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|sh|ps1|lua|dart|json|md|mdx|yml|yaml|toml|lock|txt)$/i.test(
          value,
        ),
      ),
  );
}

function matchPath(candidates: string[], pool: string[]): string | undefined {
  for (const candidate of candidates) {
    const hit = pool.find((path) => path === candidate || path.endsWith(`/${candidate}`));
    if (hit) return hit;
  }
  return undefined;
}

function quotedNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /[`"]([^`"]{1,80})[`"]/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const value = match[1]?.trim() ?? "";
    if (!value || value.includes(" ")) continue;
    if (/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) names.push(value);
  }
  return unique(names);
}

/** Checks one claim against the diff facts. Pure and deterministic. */
export function checkClaim(target: PolygraphClaim, facts: PolygraphFacts): PolygraphClaimCheck {
  const negative = target.polarity === "negative";

  switch (target.kind) {
    case "test-added": {
      const testFile = facts.added.find((path) => isTestFile(path));
      const testLine = facts.addedLines.find((line) => isTestFile(line.path));
      if (negative) {
        if (testFile) return check(target, "contradicted", `diff добавляет тестовый файл ${testFile}`);
        if (testLine) return check(target, "contradicted", `diff добавляет строки в тест ${testLine.path}`);
        return check(target, "supported", "diff не добавляет тестов");
      }
      if (testFile) return check(target, "supported", `добавлен тестовый файл ${testFile}`);
      if (testLine) return check(target, "supported", `добавлены строки в тест ${testLine.path}`);
      if (facts.testsTouched) return check(target, "unverifiable", "тестовые файлы изменены, но новых тестов не добавлено");
      return check(target, "contradicted", "diff не содержит тестовых файлов или строк");
    }

    case "file-added":
    case "file-removed": {
      const paths = claimedPaths(target.text);
      if (paths.length === 0) return check(target, "unverifiable", "в утверждении нет пути файла");
      const pool = target.kind === "file-added" ? facts.added : facts.removed;
      const opposite = target.kind === "file-added" ? facts.removed : facts.added;
      const hit = matchPath(paths, pool);
      if (negative) {
        if (hit) {
          return check(
            target,
            "contradicted",
            `diff ${target.kind === "file-added" ? "добавляет" : "удаляет"} ${hit}`,
          );
        }
        return check(target, "supported", `diff не ${target.kind === "file-added" ? "добавляет" : "удаляет"} указанный файл`);
      }
      if (hit) {
        return check(
          target,
          "supported",
          `diff ${target.kind === "file-added" ? "добавляет" : "удаляет"} ${hit}`,
        );
      }
      const other = matchPath(paths, facts.changed);
      if (other) {
        return check(target, "contradicted", `файл ${other} изменён, но не ${target.kind === "file-added" ? "добавлен" : "удалён"}`);
      }
      const oppositeHit = matchPath(paths, opposite);
      if (oppositeHit) {
        return check(target, "contradicted", `файл ${oppositeHit} ${target.kind === "file-added" ? "удалён" : "добавлен"}, а не наоборот`);
      }
      return check(target, "contradicted", `файла ${paths[0]} нет в diff`);
    }

    case "api-change": {
      const apiLines = facts.changedLines.filter((line) => API_PATTERN.test(line.text));
      if (negative) {
        if (apiLines.length > 0) {
          return check(target, "contradicted", `изменена экспортируемая строка ${apiLines[0]?.path}: ${apiLines[0]?.text.trim().slice(0, 120)}`);
        }
        return check(target, "supported", "в diff нет изменений экспортируемого API");
      }
      if (apiLines.length > 0) {
        const first = apiLines[0]!;
        return check(target, "supported", `изменён API в ${first.path}: ${first.text.trim().slice(0, 120)}`);
      }
      if (facts.addedLines.length === 0) return check(target, "contradicted", "diff не добавляет строк кода");
      return check(target, "unverifiable", "в diff нет явных изменений экспортируемого API");
    }

    case "dependency": {
      if (negative) {
        if (facts.dependencies.length > 0) {
          return check(target, "contradicted", `добавлены зависимости: ${facts.dependencies.slice(0, 3).join(", ")}`);
        }
        return check(target, "supported", "манифесты не добавляют зависимостей");
      }
      if (facts.dependencies.length === 0) {
        if (facts.removedDependencies.length > 0) {
          return check(target, "contradicted", `diff удаляет зависимости (${facts.removedDependencies.slice(0, 3).join(", ")}), но не добавляет`);
        }
        return check(target, "contradicted", "в diff нет изменений манифестов зависимостей");
      }
      const named = quotedNames(target.text).find((name) =>
        facts.dependencies.some((dependency) => dependency === name || dependency.endsWith(`/${name}`)),
      );
      if (named) return check(target, "supported", `добавлена зависимость ${named}`);
      const quoted = quotedNames(target.text);
      if (quoted.length > 0) {
        return check(target, "contradicted", `в diff нет зависимости ${quoted[0]}`);
      }
      return check(target, "supported", `добавлены зависимости: ${facts.dependencies.slice(0, 3).join(", ")}`);
    }

    case "docs": {
      if (negative) {
        if (facts.docsTouched) return check(target, "contradicted", `изменена документация: ${facts.changed.find((path) => isDoc(path))}`);
        return check(target, "supported", "diff не меняет документацию");
      }
      if (facts.docsTouched) {
        return check(target, "supported", `изменена документация: ${facts.changed.find((path) => isDoc(path))}`);
      }
      if (facts.behaviorTouched) return check(target, "contradicted", "код изменён, но документация не тронута");
      return check(target, "contradicted", "diff не меняет документацию");
    }

    case "security": {
      const findings = facts.addedLines
        .filter((line) => isCodeFile(line.path))
        .slice(0, 200)
        .flatMap((line) => scanSource(line.path, line.text).findings);
      if (findings.length > 0) {
        const first = findings[0]!;
        return check(target, "contradicted", `добавлена строка с потенциальной уязвимостью (${first.rule}): ${first.snippet.slice(0, 120)}`);
      }
      if (negative) return check(target, "unverifiable", "отсутствие проблем безопасности по diff не доказывается");
      const securityLine = facts.addedLines.find((line) => SECURITY_PATTERN.test(line.text));
      if (securityLine) {
        return check(target, "supported", `добавлены строки про безопасность в ${securityLine.path}: ${securityLine.text.trim().slice(0, 120)}`);
      }
      return check(target, "unverifiable", "по diff нельзя подтвердить улучшение безопасности");
    }

    case "behavior": {
      const source = facts.changed.filter((path) => isBehaviorPath(path));
      if (negative) {
        if (source.length > 0) {
          return check(target, "contradicted", `изменены исходники: ${source.slice(0, 3).join(", ")}`);
        }
        return check(target, "supported", "diff не меняет исходники");
      }
      if (source.length > 0) {
        return check(target, "supported", `изменены исходники: ${source.slice(0, 3).join(", ")}`);
      }
      return check(target, "contradicted", "diff меняет только тесты и документацию");
    }

    case "refactor": {
      if (negative) return check(target, "unverifiable", "отрицание рефакторинга по diff не проверяется");
      if (!facts.behaviorTouched) return check(target, "contradicted", "diff не меняет исходный код");
      if (facts.testsTouched) {
        return check(target, "unverifiable", "исходники и тесты изменены вместе, поведение могло измениться");
      }
      return check(target, "supported", "исходники изменены без изменения тестов");
    }

    default:
      return check(target, "unverifiable", "нет детерминированной проверки для этого утверждения");
  }
}

/** Parses strict JSON claims from a model answer, a file or a test fixture. */
export function parsePolygraphClaims(text: string): PolygraphClaim[] | undefined {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  let start = -1;
  if (objectStart === -1 && arrayStart === -1) return undefined;
  if (objectStart === -1) start = arrayStart;
  else if (arrayStart === -1) start = objectStart;
  else start = Math.min(objectStart, arrayStart);

  const objectEnd = text.lastIndexOf("}");
  const arrayEnd = text.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);
  if (end <= start) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }

  let list: unknown;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).claims)) {
    list = (parsed as Record<string, unknown>).claims;
  } else {
    return undefined;
  }

  const claims: PolygraphClaim[] = [];
  for (const item of list as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const value = typeof record.text === "string" ? record.text.trim() : "";
    if (!value) continue;
    const kind = typeof record.kind === "string" && KINDS.has(record.kind as PolygraphKind)
      ? (record.kind as PolygraphKind)
      : "other";
    const polarity =
      record.polarity === "negative" || record.negated === true ? "negative" : "positive";
    claims.push({ kind, text: value.slice(0, MAX_CLAIM_CHARS), polarity });
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
}

export function buildPolygraphPrompt(message: string, diff: string): string {
  const cappedMessage = message.length > 20_000 ? message.slice(0, 20_000) : message;
  const cappedDiff = diff.length > 60_000 ? diff.slice(0, 60_000) : diff;
  return [
    "You are a polygraph for code changes. Extract every factual claim from the message that can be checked against the diff.",
    "Do not praise, summarize or judge the code. Only extract claims that the author asserts as facts about this change.",
    "Return strict JSON only, with no markdown and no prose outside the object:",
    '{"claims":[{"kind":"test-added","text":"adds a regression test for the timeout","polarity":"positive"}]}',
    "Allowed kinds: test-added, file-added, file-removed, api-change, dependency, docs, security, behavior, refactor, other.",
    "Rules: quote or closely paraphrase the claim; one claim per object; at most 12 claims; skip pure intentions and future work.",
    'Use polarity "negative" for claims such as "no behavior change", "without new dependencies" or "does not touch the API".',
    'Use "other" only when no specific kind fits.',
    "",
    "MESSAGE:",
    cappedMessage,
    "",
    "DIFF:",
    cappedDiff,
  ].join("\n");
}

export function renderPolygraph(report: PolygraphReport): string {
  const lines = [
    `Polygraph: ${report.status}`,
    `Source: ${report.source}`,
    `Claims: supported ${String(report.counts.supported)}, contradicted ${String(report.counts.contradicted)}, unverifiable ${String(report.counts.unverifiable)}`,
    "",
  ];
  if (report.claims.length === 0) {
    lines.push("Утверждений не найдено.");
  }
  for (const entry of report.claims) {
    lines.push(`  [${entry.status.toUpperCase()}] ${entry.claim.kind} (${entry.claim.polarity}): ${entry.claim.text}`);
    lines.push(`    ${entry.evidence}`);
  }
  lines.push("", report.summary);
  return `${lines.join("\n")}\n`;
}

/** Evaluates claims against the diff and builds the final report. */
export function evaluatePolygraph(
  diff: string,
  claims: PolygraphClaim[],
  source: string,
): PolygraphReport {
  const facts = buildDiffFacts(diff);
  const checks = claims.map((entry) => checkClaim(entry, facts));
  const counts: Record<PolygraphClaimStatus, number> = {
    supported: 0,
    contradicted: 0,
    unverifiable: 0,
  };
  for (const entry of checks) counts[entry.status] += 1;

  const status: PolygraphStatus =
    counts.contradicted > 0
      ? "contradicted"
      : checks.length === 0 || counts.unverifiable > 0
        ? "inconclusive"
        : "verified";

  const summary =
    status === "contradicted"
      ? `[CLAIM CONTRADICTED]: сообщение расходится с diff (${String(counts.contradicted)}).`
      : status === "inconclusive"
        ? `[POLYGRAPH INCONCLUSIVE]: проверяемых утверждений нет или им не хватает доказательств (${String(counts.unverifiable)}).`
        : "[POLYGRAPH VERIFIED]: все проверяемые утверждения согласуются с diff.";

  const report: PolygraphReport = {
    source,
    claims: checks,
    counts,
    status,
    summary,
    content: "",
  };
  report.content = renderPolygraph(report);
  return report;
}
