import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { asBoolean, asString } from "../core/parse.js";
import { isGitRepo, runGit } from "../core/git.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, withCommon, type OptionSpec } from "../core/options.js";
import { readStats, summarizeStats } from "../core/stats.js";
import { writeOutput } from "../core/io.js";
import { PilotError } from "../core/errors.js";

const OPTIONS: OptionSpec = withCommon({
  since: { type: "string" },
});

const HELP = `Использование:
  oc-pilot day [опции]

Сводка активности за период: коммиты, файлы, находки oc-pilot.

Опции:
      --since <when>        период в синтаксисе git (по умолчанию "1 day ago")
${COMMON_HELP}

Примеры:
  oc-pilot day
  oc-pilot day --since "3 hours ago"
  oc-pilot day --since "yesterday" --json
`;

interface DayCommit {
  hash: string;
  time: string;
  subject: string;
}

interface DayFile {
  file: string;
  additions: number;
  deletions: number;
}

export async function runDay(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const cwdFlag = asString(values, "cwd");
  const cwd = cwdFlag ? resolve(cwdFlag) : process.cwd();
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new PilotError(`Каталог не найден: ${cwd}`);
  }
  if (!isGitRepo(cwd)) {
    throw new PilotError("Не git-репозиторий: сводка day работает только внутри репозитория.", {
      hint: "Выполните команду в корне репозитория.",
    });
  }

  const since = asString(values, "since") ?? "1 day ago";

  const commitLog = runGit(
    ["log", "--since", since, "--pretty=format:%h|%ad|%s", "--date=format:%H:%M"],
    cwd,
  );
  if (commitLog.status !== 0) {
    throw new PilotError("Не удалось прочитать git log.", { hint: commitLog.stderr || undefined });
  }
  const commits: DayCommit[] = commitLog.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash = "", time = "", ...rest] = line.split("|");
      return { hash, time, subject: rest.join("|") };
    });

  const numstatLog = runGit(["log", "--since", since, "--numstat", "--pretty=format:"], cwd);
  const fileMap = new Map<string, DayFile>();
  if (numstatLog.status === 0) {
    for (const line of numstatLog.stdout.split("\n")) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) continue;
      const additions = match[1] === "-" ? 0 : Number(match[1]);
      const deletions = match[2] === "-" ? 0 : Number(match[2]);
      const file = match[3];
      const existing = fileMap.get(file);
      if (existing) {
        existing.additions += additions;
        existing.deletions += deletions;
      } else {
        fileMap.set(file, { file, additions, deletions });
      }
    }
  }
  const files = [...fileMap.values()].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );

  // Timestamp cutoff for oc-pilot stats: oldest commit in range, or now.
  const cutoffLog = runGit(["log", "--since", since, "--reverse", "--pretty=format:%ct"], cwd);
  let cutoffMs = Date.now();
  if (cutoffLog.status === 0 && cutoffLog.stdout.trim()) {
    const oldest = Number(cutoffLog.stdout.split("\n")[0]);
    if (Number.isFinite(oldest) && oldest > 0) cutoffMs = oldest * 1000;
  }
  const summary = summarizeStats(readStats(cwd), cutoffMs);

  if (asBoolean(values, "json") || values.format === "json") {
    const payload = {
      since,
      commits,
      files,
      totals: {
        commits: commits.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      },
      ocPilot: summary,
    };
    writeOutput(JSON.stringify(payload, null, 2), asString(values, "output"));
    return 0;
  }

  log.info(`Коммиты за период (${since}): ${commits.length}.`);
  for (const commit of commits.slice(0, 10)) {
    log.detail(`${commit.time} ${commit.hash} ${commit.subject}`);
  }
  if (commits.length > 10) log.detail(`…и ещё ${commits.length - 10}.`);

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  log.info(`Файлы: +${additions} / -${deletions} по ${files.length} файл(ам). Топ:`);
  for (const file of files.slice(0, 10)) {
    log.detail(`${file.file} +${file.additions} / -${file.deletions}`);
  }

  log.info(
    `oc-pilot: запусков ${summary.runs}, вызовов API ${summary.apiCalls}, из кеша ${summary.cacheHits}, ` +
      `находок ${summary.findings.critical} critical / ${summary.findings.warning} warning / ${summary.findings.style} style.`,
  );
  return 0;
}
