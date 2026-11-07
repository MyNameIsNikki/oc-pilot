import { PilotError } from "../core/errors.js";
import { zoomSymbol } from "../core/hologram.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({});

const HELP = `Использование:
  oc-pilot zoom-symbol <file> <symbol> [опции]

Возвращает полное тело одного символа из файла. Это аварийный выход для
голограммного контекста (pack --hologram): тела функций в LOD 1 скрыты,
но если агенту нужна реализация, он запрашивает её точечно.

Аргументы:
  file                  путь к файлу относительно корня проекта
  symbol                имя функции, класса или стрелочной функции

Опции:
${COMMON_HELP}

Примеры:
  oc-pilot zoom-symbol src/core/pack.ts buildPack
  oc-pilot zoom-symbol src/core/pack.ts buildPack --json
  oc-pilot zoom-symbol src/core/pack.ts buildPack --output body.txt`;

export async function runZoomSymbol(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const [file, symbol] = positionals;
  if (!file || !symbol) {
    throw new PilotError("Нужны файл и символ", {
      hint: "Например: oc-pilot zoom-symbol src/core/pack.ts buildPack",
      exitCode: 2,
    });
  }

  const ctx = resolveContext(values);
  const result = zoomSymbol(ctx.cwd, file, symbol);

  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
    if (wrote) log.success(`Тело сохранено: ${wrote}`);
    return 0;
  }

  const wrote = writeOutput(`${result.body}\n`, ctx.flags.output);
  if (wrote) log.success(`Тело сохранено: ${wrote}`);
  return 0;
}
