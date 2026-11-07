import { runAql } from "../core/aql.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString, parsePositiveInt } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  limit: { type: "string" },
});

const HELP = `Использование:
  oc-pilot query "<AQL>" [опции]

Графовый запрос к коду без SQL и без полноценного парсера. Цепочка
шагов: find(Type), where(field, value), sort(field), limit(n),
select(fields...), count(). Типы: File, Function, Class, Import,
CallExpression. Модель и сеть не используются.

Опции:
      --limit <n>   максимум строк (по умолчанию 200, максимум 1000)
${COMMON_HELP}

Примеры:
  oc-pilot query "find(CallExpression).where(name, 'stripe').select(file, line)"
  oc-pilot query "find(Function).where(file, 'src/app.ts').select(name, line)"
  oc-pilot query "find(Import).where(specifier, 'node:fs').count()"
  oc-pilot query "find(Class).select(file, name).limit(20)"`;

export async function runQuery(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const query = positionals.join(" ").trim();
  if (!query) {
    throw new PilotError("Не указан AQL-запрос", {
      hint: 'Например: oc-pilot query "find(CallExpression).where(name, \'stripe\').select(file, line)"',
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const limitRaw = asString(values, "limit");
  const report = runAql(ctx.cwd, query, {
    limit: limitRaw ? parsePositiveInt(limitRaw, "limit", 1000) : 200,
  });

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(report, null, 2), ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
  } else {
    const wrote = writeOutput(report.content, ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
  }
  return 0;
}
