import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeDiffSource, loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { parseOracleCorpus, renderOracle, runOracle } from "../core/oracle.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt, parseSeconds } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  command: { type: "string" },
  input: { type: "string" },
  "case-timeout": { type: "string" },
  "max-cases": { type: "string" },
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot oracle --command "node harness.mjs {input}" --input corpus.json [опции]

Запускает одну и ту же команду на чистом HEAD и на diff в двух shadow
worktree, подаёт каждому кейсу JSON-файл вместо {input} и сравнивает
stdout и код выхода. Любое расхождение — [BEHAVIOR CHANGED], совпадение — [BEHAVIOR SAME].
Модель и сеть не используются; команда должна быть детерминированной.

Корпус: JSON-массив кейсов, объект {"cases":[...]} или один объект.
Каждый кейс — {"id":"имя","input":<любой JSON>}; без id получит case-N.

Опции:
      --command <cmd>      команда с {input}, например node harness.mjs {input}
      --input <file|->     файл корпуса или - для stdin
      --case-timeout <30s> таймаут одного кейса (1s–300s)
      --max-cases <50>     максимум кейсов (1–200)
      --diff <file|->      готовый unified diff
      --stdin              читать diff из stdin
      --staged             только staged-изменения
      --unstaged           только unstaged-изменения
      --base <ref>         diff против ветки
      --include-untracked  добавить неотслеживаемые файлы
${COMMON_HELP}

Коды выхода:
  0  поведение совпало
  1  поведение изменилось
  2  ошибка корпуса, команды или git

Примеры:
  oc-pilot oracle --command "node harness.mjs {input}" --input corpus.json --staged
  oc-pilot oracle --command "node harness.mjs {input}" --input corpus.json --base main --json`;

function readCorpus(cwd: string, path: string): string {
  if (path === "-") return readFileSync(0, "utf8");
  try {
    return readFileSync(resolve(cwd, path), "utf8");
  } catch {
    throw new PilotError(`Не удалось прочитать корпус ${path}`, {
      hint: "Проверьте путь к JSON-файлу.",
      exitCode: 2,
    });
  }
}

export async function runOracleCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new PilotError("oracle не принимает позиционных аргументов", {
      hint: "Передайте команду через --command, а корпус через --input.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const command = asString(values, "command");
  if (!command) {
    throw new PilotError("Нужна команда с {input}", {
      hint: 'Например: --command "node harness.mjs {input}".',
      exitCode: 2,
    });
  }
  const inputPath = asString(values, "input");
  if (!inputPath) {
    throw new PilotError("Нужен файл корпуса", {
      hint: "Передайте --input corpus.json.",
      exitCode: 2,
    });
  }

  const cases = parseOracleCorpus(readCorpus(ctx.cwd, inputPath));
  if (!cases) {
    throw new PilotError("Корпус не является JSON-массивом кейсов", {
      hint: 'Ожидается [{"id":"x","input":...}] или {"cases":[...]}.',
      exitCode: 2,
    });
  }
  if (cases.length === 0) {
    log.info("В корпусе нет кейсов — сравнивать нечего.");
    return 0;
  }

  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  if (!data.diff.trim()) {
    log.info("Изменений нет — сравнивать поведение нечего.");
    return 0;
  }

  const timeoutRaw = asString(values, "case-timeout");
  const maxCasesRaw = asString(values, "max-cases");
  const report = await runOracle(ctx.cwd, data.diff, cases, {
    command,
    timeoutMs: timeoutRaw ? parseSeconds(timeoutRaw, "case-timeout") * 1000 : undefined,
    maxCases: maxCasesRaw ? parsePositiveInt(maxCasesRaw, "max-cases", 200) : undefined,
    source: describeDiffSource(data.source),
  });

  const wrote = ctx.flags.json
    ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
    : writeOutput(renderOracle(report), ctx.flags.output);
  if (wrote) log.success(`Отчёт сохранён: ${wrote}`);

  if (report.changed > 0) log.error(report.summary);
  else log.success(report.summary);
  return report.changed > 0 ? 1 : 0;
}
