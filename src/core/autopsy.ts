import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { splitDiffBlocks } from "./diff.js";
import { analyzeMockLeaks } from "./mock-leak.js";
import { scanSource, type SastSeverity } from "./sast.js";
import { analyzeTestWeakness } from "./test-weakening.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";

export type AutopsyVerdict = "clean" | "suspicious" | "dangerous";
export type AutopsySignalKind = "sast" | "test-weakening" | "mock-leak";

export interface AutopsyCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface AutopsySignal {
  kind: AutopsySignalKind;
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  detail: string;
}

export interface AutopsySuspect {
  file: string;
  score: number;
  reasons: string[];
}

export interface AutopsyTimelineEntry {
  relation: "target" | "before" | "after";
  commit: AutopsyCommit;
  files: string[];
}

export interface AutopsyStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface AutopsyReport {
  commit: AutopsyCommit;
  stats: AutopsyStats;
  changedFiles: string[];
  signals: AutopsySignal[];
  suspects: AutopsySuspect[];
  timeline: AutopsyTimelineEntry[];
  verdict: AutopsyVerdict;
  summary: string;
}

export interface AutopsyOptions {
  depth?: number;
}

const RECORD = "\u001e";
const FIELD = "\u001f";
const SEVERITY_WEIGHT: Record<AutopsySignal["severity"], number> = { high: 5, medium: 3, low: 1 };
const SAST_WEIGHT: Record<SastSeverity, number> = { high: 5, medium: 3, low: 1 };

function parseCommit(record: string): AutopsyCommit | undefined {
  const [hash, shortHash, author, date, subject] = record.split(FIELD);
  if (!hash || !shortHash || !date) return undefined;
  return {
    hash,
    shortHash,
    author: author ?? "unknown",
    date,
    subject: subject ?? "(без темы)",
  };
}

function readCommit(cwd: string, ref: string): AutopsyCommit {
  const result = runGit(["show", "-s", `--format=%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s`, ref], cwd);
  if (result.status !== 0) {
    throw new PilotError(`Коммит не найден: ${ref}`, {
      hint: "Укажите существующий ref, например HEAD или HEAD~1.",
      exitCode: 2,
    });
  }
  const commit = parseCommit(result.stdout.trim());
  if (!commit) {
    throw new PilotError(`Не удалось прочитать коммит: ${ref}`, { exitCode: 2 });
  }
  return commit;
}

function readDiff(cwd: string, ref: string): string {
  const result = runGit(["show", "--format=", "--no-color", "--unified=0", ref], cwd);
  if (result.status !== 0) {
    throw new PilotError(`Не удалось получить diff коммита ${ref}`, { exitCode: 2 });
  }
  return result.stdout;
}

/** Added line numbers per file, used to keep SAST findings inside the commit. */
export function addedLinesByFile(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const block of splitDiffBlocks(diff)) {
    if (block.path === "(diff)" || block.path === "(unknown)") continue;
    const lines = new Set<number>();
    let newLine = 0;
    for (const line of block.text.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        lines.add(newLine);
        newLine += 1;
      } else if (line.startsWith(" ")) {
        newLine += 1;
      }
    }
    if (lines.size > 0) result.set(block.path.replace(/\\/g, "/"), lines);
  }
  return result;
}

function diffStats(diff: string): AutopsyStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { files, additions, deletions };
}

function scanAddedFiles(cwd: string, ref: string, added: Map<string, Set<number>>): AutopsySignal[] {
  const signals: AutopsySignal[] = [];
  for (const [file, lines] of added) {
    if (!isCodeFile(file) || isTestFile(file) || isGeneratedPath(file)) continue;
    const show = runGit(["show", `${ref}:${file}`], cwd);
    if (show.status !== 0) continue;
    for (const finding of scanSource(file, show.stdout).findings) {
      if (!lines.has(finding.line)) continue;
      signals.push({
        kind: "sast",
        severity: finding.severity,
        file,
        line: finding.line,
        detail: `${finding.rule}: ${finding.message}`,
      });
    }
  }
  return signals;
}

function timeline(cwd: string, ref: string, files: string[], depth: number): AutopsyTimelineEntry[] {
  if (files.length === 0) return [];
  const format = `--format=${RECORD}%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s`;
  const before = runGit(["log", `-n${String(depth)}`, format, ref, "--", ...files], cwd);
  const after = runGit(["log", `-n${String(depth)}`, format, `${ref}..HEAD`, "--", ...files], cwd);
  const entries: AutopsyTimelineEntry[] = [];
  const targetHash = readCommit(cwd, ref).hash;

  const push = (text: string, relation: "before" | "after"): void => {
    for (const record of text.split(RECORD)) {
      const commit = parseCommit(record.trim());
      if (!commit) continue;
      if (relation === "before" && commit.hash === targetHash) {
        entries.push({ relation: "target", commit, files });
      } else {
        entries.push({ relation, commit, files });
      }
    }
  };
  push(before.stdout, "before");
  push(after.stdout, "after");
  return entries;
}

/** Builds a deterministic post-mortem for one commit. */
export function analyzeAutopsy(cwd: string, ref: string, options: AutopsyOptions = {}): AutopsyReport {
  const depth = Math.min(50, Math.max(1, options.depth ?? 5));
  const commit = readCommit(cwd, ref);
  const diff = readDiff(cwd, ref);
  const added = addedLinesByFile(diff);
  const changedFiles = [...added.keys()].sort();
  const signals: AutopsySignal[] = [];

  signals.push(...scanAddedFiles(cwd, ref, added));

  for (const finding of analyzeTestWeakness(diff)) {
    signals.push({
      kind: "test-weakening",
      severity: "high",
      file: finding.file,
      line: finding.line,
      detail: `${finding.kind}: ${finding.detail}`,
    });
  }

  for (const leak of analyzeMockLeaks(diff).findings) {
    signals.push({
      kind: "mock-leak",
      severity: leak.severity,
      file: leak.file,
      line: leak.line,
      detail: `${leak.kind}: ${leak.detail}`,
    });
  }

  signals.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.kind.localeCompare(right.kind));

  const suspects = new Map<string, AutopsySuspect>();
  for (const signal of signals) {
    const entry = suspects.get(signal.file) ?? { file: signal.file, score: 0, reasons: [] };
    entry.score += signal.kind === "sast" ? SAST_WEIGHT[signal.severity] : SEVERITY_WEIGHT[signal.severity];
    entry.reasons.push(`${signal.kind}: ${signal.detail}`);
    suspects.set(signal.file, entry);
  }
  const suspectList = [...suspects.values()]
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, 5);

  const verdict: AutopsyVerdict = signals.some((signal) => signal.severity === "high")
    ? "dangerous"
    : signals.length > 0
      ? "suspicious"
      : "clean";
  const summary =
    verdict === "dangerous"
      ? `Коммит ${commit.shortHash} оставил ${String(signals.length)} риск(ов), включая high.`
      : verdict === "suspicious"
        ? `Коммит ${commit.shortHash} оставил ${String(signals.length)} риск(ов) без high.`
        : `Коммит ${commit.shortHash} не оставил рискованных сигналов.`;

  return {
    commit,
    stats: diffStats(diff),
    changedFiles,
    signals,
    suspects: suspectList,
    timeline: timeline(cwd, ref, changedFiles, depth),
    verdict,
    summary,
  };
}

/** Detective-style Russian report. */
export function renderAutopsy(report: AutopsyReport): string {
  const lines = [
    "ВСКРЫТИЕ КОММИТА",
    `Коммит: ${report.commit.shortHash} ${report.commit.subject}`,
    `Автор: ${report.commit.author}, ${report.commit.date}`,
    `Изменено: ${String(report.stats.files)} файл(ов), +${String(report.stats.additions)} / -${String(report.stats.deletions)}.`,
    `Вердикт: ${report.verdict}. ${report.summary}`,
  ];

  if (report.changedFiles.length > 0) {
    lines.push("", "Затронутые файлы:");
    for (const file of report.changedFiles) lines.push(`  ${file}`);
  }

  if (report.signals.length > 0) {
    lines.push("", "Улики:");
    for (const signal of report.signals.slice(0, 20)) {
      lines.push(`  ${signal.file}:${String(signal.line)} [${signal.kind}/${signal.severity}] ${signal.detail}`);
    }
    if (report.signals.length > 20) lines.push(`  …и ещё ${String(report.signals.length - 20)}`);
  }

  if (report.suspects.length > 0) {
    lines.push("", "Подозреваемые:");
    for (const suspect of report.suspects) {
      lines.push(`  ${suspect.file} (${String(suspect.score)} очков): ${suspect.reasons.slice(0, 3).join("; ")}`);
    }
  }

  if (report.timeline.length > 0) {
    lines.push("", "Хронология:");
    for (const entry of report.timeline) {
      lines.push(`  ${entry.commit.shortHash} ${entry.commit.date.slice(0, 10)} [${entry.relation}] ${entry.commit.subject}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
