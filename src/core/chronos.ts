import { readAntibodyStore } from "./antibody.js";
import { runGit } from "./git.js";
import { readVaccineStore } from "./vaccine.js";

export interface ChronosCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  additions: number;
  deletions: number;
  flags: string[];
}

export interface ChronosTotals {
  commits: number;
  additions: number;
  deletions: number;
  fixes: number;
  reverts: number;
  incidents: number;
  security: number;
}

export interface ChronosReport {
  file: string;
  commits: ChronosCommit[];
  totals: ChronosTotals;
  antibodies: number;
  vaccines: number;
  score: number;
  hotspot: boolean;
  summary: string;
  content: string;
}

export interface ChronosOptions {
  limit?: number;
  since?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const HOTSPOT_SCORE = 10;

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function flagsOf(subject: string): string[] {
  const flags: string[] = [];
  if (/\b(?:fix|bug|hotfix|patch|repair|regression)\b/i.test(subject)) flags.push("fix");
  if (/\brevert(?:s|ed|ing)?\b/i.test(subject)) flags.push("revert");
  if (/\b(?:incident|outage|sev[0-9]?|rollback|production|prod)\b/i.test(subject)) flags.push("incident");
  if (/\b(?:security|cve-\d+|vulnerab|xss|csrf|injection|auth)\b/i.test(subject)) flags.push("security");
  return flags;
}

function shortstat(cwd: string, sha: string): { additions: number; deletions: number } {
  const result = runGit(["show", "--shortstat", "--format=", sha], cwd);
  if (result.status !== 0) return { additions: 0, deletions: 0 };
  const additions = /(\d+) insertions?/.exec(result.stdout)?.[1];
  const deletions = /(\d+) deletions?/.exec(result.stdout)?.[1];
  return {
    additions: additions ? Number(additions) : 0,
    deletions: deletions ? Number(deletions) : 0,
  };
}

/** Reads the commit chronicle of one file and scores it as a hotspot. */
export function analyzeChronos(cwd: string, file: string, options: ChronosOptions = {}): ChronosReport {
  const limit = Math.max(1, Math.min(MAX_LIMIT, options.limit ?? DEFAULT_LIMIT));
  const args = [
    "log",
    "--follow",
    `--max-count=${String(limit)}`,
    "--format=%H%x1f%an%x1f%ad%x1f%s",
    "--date=short",
  ];
  if (options.since) args.push(`--since=${options.since}`);
  args.push("--", file);

  const result = runGit(args, cwd);
  const commits: ChronosCommit[] = [];
  if (result.status === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [sha, author, date, subject] = line.split("\x1f");
      if (!sha || !subject) continue;
      const stat = shortstat(cwd, sha);
      commits.push({
        sha,
        author: author ?? "unknown",
        date: date ?? "unknown",
        subject,
        additions: stat.additions,
        deletions: stat.deletions,
        flags: flagsOf(subject),
      });
    }
  }

  const totals: ChronosTotals = {
    commits: commits.length,
    additions: commits.reduce((sum, commit) => sum + commit.additions, 0),
    deletions: commits.reduce((sum, commit) => sum + commit.deletions, 0),
    fixes: commits.filter((commit) => commit.flags.includes("fix")).length,
    reverts: commits.filter((commit) => commit.flags.includes("revert")).length,
    incidents: commits.filter((commit) => commit.flags.includes("incident")).length,
    security: commits.filter((commit) => commit.flags.includes("security")).length,
  };

  const target = normalize(file);
  const antibodies = readAntibodyStore(cwd).signatures.filter(
    (signature) => signature.file && normalize(signature.file) === target,
  ).length;
  const shas = new Set(commits.map((commit) => commit.sha));
  const vaccines = readVaccineStore(cwd).vaccines.filter(
    (vaccine) => shas.has(vaccine.bug) || shas.has(vaccine.fix),
  ).length;

  const churn = Math.min(10, Math.floor((totals.additions + totals.deletions) / 100));
  const score =
    totals.fixes * 3 +
    totals.reverts * 5 +
    totals.incidents * 4 +
    totals.security * 2 +
    churn +
    antibodies * 2 +
    vaccines * 3;
  const hotspot = score >= HOTSPOT_SCORE;
  const summary =
    totals.commits === 0
      ? `[CHRONOS]: история файла ${file} пуста.`
      : hotspot
        ? `[HOTSPOT]: ${file} — score ${String(score)}; fixes ${String(totals.fixes)}, reverts ${String(totals.reverts)}, incidents ${String(totals.incidents)}.`
        : `[CHRONOS]: ${file} — score ${String(score)}; явных инцидентов в истории нет.`;

  const report: ChronosReport = {
    file,
    commits,
    totals,
    antibodies,
    vaccines,
    score,
    hotspot,
    summary,
    content: "",
  };
  report.content = renderChronos(report);
  return report;
}

export function renderChronos(report: ChronosReport): string {
  const lines = [
    `Chronos: ${report.file}`,
    `Commits: ${String(report.totals.commits)}, +${String(report.totals.additions)}/-${String(report.totals.deletions)}`,
    `Fixes: ${String(report.totals.fixes)}, reverts: ${String(report.totals.reverts)}, incidents: ${String(report.totals.incidents)}, security: ${String(report.totals.security)}`,
    `Antibodies: ${String(report.antibodies)}, vaccines: ${String(report.vaccines)}`,
    `Hotspot score: ${String(report.score)}${report.hotspot ? " [HOTSPOT]" : ""}`,
  ];
  if (report.commits.length > 0) {
    lines.push("Recent:");
    for (const commit of report.commits.slice(0, 10)) {
      const flags = commit.flags.length > 0 ? ` [${commit.flags.join(",")}]` : "";
      lines.push(`  ${commit.date} ${commit.sha.slice(0, 8)}${flags} ${commit.subject} (${commit.author})`);
    }
  }
  lines.push("", report.summary);
  return `${lines.join("\n")}\n`;
}
