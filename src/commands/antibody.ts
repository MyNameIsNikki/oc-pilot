import {
  clearAntibodies,
  forgetAntibody,
  learnAntibodies,
  listAntibodies,
  scanAntibodies,
} from "../core/antibody.js";
import { loadDiff } from "../core/diff-source.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  diff: { type: "string" },
  stdin: { type: "boolean" },
  staged: { type: "boolean" },
  unstaged: { type: "boolean" },
  base: { type: "string" },
  "include-untracked": { type: "boolean" },
  id: { type: "string" },
  force: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot antibody learn
  oc-pilot antibody scan [опции]
  oc-pilot antibody list
  oc-pilot antibody forget --id <id>
  oc-pilot antibody clear --force

Учит SAST-находки репозитория как подписи и ловит их повторное
появление в diff. Подписи хранятся в .oc-pilot/antibodies.json.
Модель и сеть не используются.

Опции:
      --diff <file>       взять diff из файла (или - для stdin)
      --stdin             прочитать diff из stdin
      --staged            diff индекса
      --unstaged          diff рабочего дерева
      --base <ref>        diff от указанной ветки/коммита
      --include-untracked включить неотслеживаемые файлы
      --id <id>           подпись для forget
      --force             подтвердить clear
${COMMON_HELP}

Примеры:
  oc-pilot antibody learn
  oc-pilot antibody scan --staged
  oc-pilot antibody list --json
  oc-pilot antibody forget --id ab_0123456789abcdef
  oc-pilot antibody clear --force`;

export async function runAntibody(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const [subcommand] = positionals;
  const ctx = resolveContext(values);

  if (subcommand === "learn") {
    const result = learnAntibodies(ctx.cwd);
    if (ctx.flags.json) {
      const wrote = writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
      if (wrote) log.success(`Результат сохранён: ${wrote}`);
    } else {
      process.stdout.write(
        `Antibody: файлов ${String(result.scanned)}, находок ${String(result.findings)}, добавлено ${String(result.added)}, всего ${String(result.total)}.\n`,
      );
    }
    return 0;
  }

  if (subcommand === "scan") {
    const data = await loadDiff(values, ctx, [], { optionalGit: true });
    if (!data.diff.trim()) {
      log.info("Изменений нет — проверять антитела нечего.");
      return 0;
    }
    const report = scanAntibodies(ctx.cwd, data.diff);
    const payload = { source: data.source, ...report };
    const wrote = ctx.flags.json
      ? writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output)
      : writeOutput(report.content, ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
    if (report.matches.length > 0) {
      log.error(report.summary);
      return 1;
    }
    return 0;
  }

  if (subcommand === "list") {
    const report = listAntibodies(ctx.cwd);
    const wrote = ctx.flags.json
      ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
      : writeOutput(report.content, ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
    return 0;
  }

  if (subcommand === "forget") {
    const id = asString(values, "id");
    if (!id) {
      throw new PilotError("Укажите --id подписи", {
        hint: "Список подписей: oc-pilot antibody list.",
        exitCode: 2,
      });
    }
    const result = forgetAntibody(ctx.cwd, id);
    if (!result.removed) {
      log.warn(`Подпись ${id} не найдена.`);
      return 1;
    }
    if (ctx.flags.json) writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
    else process.stdout.write(`Antibody: удалено 1, осталось ${String(result.remaining)}.\n`);
    return 0;
  }

  if (subcommand === "clear") {
    if (!asBoolean(values, "force")) {
      throw new PilotError("clear удаляет все подписи; добавьте --force", {
        hint: "Проверить подписи: oc-pilot antibody list.",
        exitCode: 2,
      });
    }
    const result = clearAntibodies(ctx.cwd);
    if (ctx.flags.json) writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
    else process.stdout.write(`Antibody: удалено подписей ${String(result.removed)}.\n`);
    return 0;
  }

  throw new PilotError("Неизвестная подкоманда antibody", {
    hint: "Доступно: learn, scan, list, forget, clear.",
    exitCode: 2,
  });
}
