import { renderCuckoo, runCuckoo } from "../core/cuckoo.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString, parseSeconds } from "../core/parse.js";
const OPTIONS = withCommon({
    file: { type: "string" },
    "script-timeout": { type: "string" },
    allow: { type: "string" },
});
const HELP = `Использование:
  oc-pilot cuckoo <file> [опции]
  oc-pilot cuckoo --file <file> [опции]

Запускает JS/ESM-файл в инструментированной vm-песочнице и показывает,
какие возможности он запрашивает: fs, net, child_process, env, exit,
require, import. Код не получает реальный доступ: моки записывают попытки,
а опасные операции останавливают выполнение.
Модель и сеть не используются.

Опции:
      --file <file>          файл для аудита
      --script-timeout <30s> таймаут выполнения (0.1s–60s)
      --allow <kinds>        разрешённые виды через запятую; иначе любой запрос — код 1
${COMMON_HELP}

Коды выхода:
  0  чисто или все запросы разрешены
  1  [CAPABILITY DENIED] есть запрещённые возможности
  2  ошибка файла, песочницы или таймаут

Примеры:
  oc-pilot cuckoo dist/tool.mjs
  oc-pilot cuckoo --file generated.mjs --allow fs,env`;
export async function runCuckooCommand(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    const fileFlag = asString(values, "file");
    if (positionals.length > 1) {
        throw new PilotError("cuckoo принимает один файл", {
            hint: "Передайте путь позиционно или через --file.",
            exitCode: 2,
        });
    }
    const file = fileFlag ?? positionals[0];
    if (!file) {
        throw new PilotError("Нужен файл для аудита", {
            hint: "Например: oc-pilot cuckoo dist/tool.mjs.",
            exitCode: 2,
        });
    }
    if (fileFlag && positionals.length > 0) {
        throw new PilotError("Укажите файл только один раз", {
            hint: "Либо позиционно, либо через --file.",
            exitCode: 2,
        });
    }
    const ctx = resolveContext(values);
    const timeoutRaw = asString(values, "script-timeout");
    const allowRaw = asString(values, "allow");
    const allow = allowRaw
        ? new Set(allowRaw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean))
        : undefined;
    const report = runCuckoo(ctx.cwd, file, {
        timeoutMs: timeoutRaw ? parseSeconds(timeoutRaw, "script-timeout") * 1000 : undefined,
    });
    const wrote = ctx.flags.json
        ? writeOutput(JSON.stringify(report, null, 2), ctx.flags.output)
        : writeOutput(renderCuckoo(report), ctx.flags.output);
    if (wrote)
        log.success(`Результат сохранён: ${wrote}`);
    if (report.status === "error" || report.status === "timeout") {
        log.error(report.summary);
        return 2;
    }
    const disallowed = allow
        ? report.capabilities.filter((capability) => !allow.has(capability.kind))
        : report.capabilities;
    if (disallowed.length > 0) {
        log.error(report.summary);
        return 1;
    }
    if (report.capabilities.length > 0)
        log.warn(report.summary);
    else
        log.success(report.summary);
    return 0;
}
//# sourceMappingURL=cuckoo.js.map