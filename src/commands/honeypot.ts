import { PilotError } from "../core/errors.js";
import { deployHoneypot, honeypotStatus, removeHoneypot, renderHoneypotStatus } from "../core/honeypot.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  force: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot honeypot deploy [--force]
  oc-pilot honeypot status
  oc-pilot honeypot remove

Разворачивает приманки для AI-агентов: фальшивый .env.backup с
example-ключами AWS, функцию bypassAuth, которая всегда возвращает true,
и legacy_db_drop с опасным SQL. Если агент прочитает или импортирует
приманку, preflight завершится с [HONEYPOT TRIGGERED]. Это не настоящие
секреты и не рабочий код: файлы помечены и удаляются одной командой.

Опции:
      --force   перезаписать существующие приманки
${COMMON_HELP}

Примеры:
  oc-pilot honeypot deploy
  oc-pilot honeypot status
  oc-pilot preflight --staged
  oc-pilot honeypot remove`;

export async function runHoneypot(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const [subcommand] = positionals;
  const ctx = resolveContext(values);

  if (subcommand === "deploy") {
    const result = deployHoneypot(ctx.cwd, { force: asBoolean(values, "force") });
    if (ctx.flags.json) {
      const wrote = writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
      if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    } else {
      log.success(`Honeypot развёрнут: создано ${String(result.created.length)}, пропущено ${String(result.skipped.length)}.`);
      for (const path of result.created) process.stdout.write(`  создано: ${path}\n`);
      for (const path of result.skipped) process.stdout.write(`  пропущено: ${path}\n`);
    }
    return 0;
  }

  if (subcommand === "status") {
    const scan = honeypotStatus(ctx.cwd);
    if (ctx.flags.json) {
      const wrote = writeOutput(JSON.stringify(scan, null, 2), ctx.flags.output);
      if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    } else {
      const wrote = writeOutput(renderHoneypotStatus(scan), ctx.flags.output);
      if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    }
    return 0;
  }

  if (subcommand === "remove") {
    const result = removeHoneypot(ctx.cwd);
    if (ctx.flags.json) {
      const wrote = writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
      if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    } else {
      log.success(`Honeypot удалён: файлов ${String(result.removed.length)}, отсутствовало ${String(result.missing.length)}.`);
    }
    return 0;
  }

  throw new PilotError("Неизвестная подкоманда honeypot", {
    hint: "Доступно: deploy, status, remove.",
    exitCode: 2,
  });
}
