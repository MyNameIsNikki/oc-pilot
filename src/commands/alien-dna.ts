import { analyzeAlienDna } from "../core/alien-dna.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot alien-dna [опции]

Сравнивает добавленные строки diff с архитектурной ДНК репозитория.
ДНК строится по HEAD: для каждого паттерна считается число вхождений.
Если diff впервые приносит паттерн, которого в базе не было (0%),
команда печатает [ALIEN DNA DETECTED] и завершается кодом 1.
Модель и сеть не используются.

Паттерны: Singleton, Proxy, new RegExp, eval/new Function, globalThis,
extends, декораторы, Worker, EventEmitter, динамический import,
синхронный I/O, мутация prototype.

Опции:
      --diff <file>       взять diff из файла (или - для stdin)
      --stdin             прочитать diff из stdin
      --staged            diff индекса
      --unstaged          diff рабочего дерева
      --base <ref>        diff от указанной ветки/коммита
      --include-untracked включить неотслеживаемые файлы
${COMMON_HELP}

Примеры:
  oc-pilot alien-dna --staged
  oc-pilot alien-dna --base origin/main --json
  git diff | oc-pilot alien-dna --stdin`;

export async function runAlienDna(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (positionals.length > 0) {
    throw new PilotError("alien-dna не принимает позиционные аргументы", {
      hint: "Передайте diff через --diff, --stdin, --staged или --base.",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const data = await loadDiff(values, ctx, [], { optionalGit: true });
  if (!data.diff.trim()) {
    log.info("Изменений нет — проверять ДНК нечего.");
    return 0;
  }

  const report = analyzeAlienDna(ctx.cwd, data.diff);
  const payload = { source: data.source, ...report };
  const wrote = ctx.flags.json
    ? writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output)
    : writeOutput(report.content, ctx.flags.output);
  if (wrote) log.success(`Результат сохранён: ${wrote}`);

  if (report.triggers.length > 0) {
    log.error(report.summary);
    return 1;
  }
  return 0;
}
