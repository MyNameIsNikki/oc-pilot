import { PilotError } from "../core/errors.js";
import { runSandbox, renderSandbox } from "../core/phantom.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
const OPTIONS = withCommon({
    timeout: { type: "string" },
    "memory-limit": { type: "string" },
    "allow-unsafe-exec": { type: "boolean" },
});
const HELP = `Использование:
  oc-pilot sandbox run <file> [опции]

Запускает JavaScript или ESM-файл в node:vm с отдельным контекстом:
require, import, fetch, process.exit и таймеры длиннее секунды блокируются,
console перехватывается, а исполнение ограничено таймаутом и кучей.
TypeScript запускается только если рядом есть собранный dist/*.js.
Это не ОС-песочница: для нативного кода нужен bwrap/sandbox-exec, поэтому
флаг --allow-unsafe-exec оставлен явным подтверждением для таких сценариев.

Опции:
      --timeout <2s|500ms>   таймаут исполнения (по умолчанию 2s)
      --memory-limit <128MB> лимит кучи процесса (по умолчанию 128MB)
      --allow-unsafe-exec    разрешить нативный запуск без песочницы (не рекомендуется)
${COMMON_HELP}

Примеры:
  oc-pilot sandbox run scripts/demo.mjs
  oc-pilot sandbox run scripts/demo.mjs --timeout 500ms --json
  oc-pilot sandbox run dist/task.js --memory-limit 64MB`;
function parseDuration(raw) {
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const match = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(raw.trim());
    if (!match?.[1]) {
        throw new PilotError(`Некорректный таймаут: ${raw}`, { hint: "Используйте 2s, 500ms или миллисекунды.", exitCode: 2 });
    }
    const value = Number(match[1]);
    return Math.round(match[2]?.toLowerCase() === "ms" ? value : value * 1000);
}
function parseMemory(raw) {
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const match = /^(\d+)(?:mb)?$/i.exec(raw.trim());
    if (!match?.[1]) {
        throw new PilotError(`Некорректный лимит памяти: ${raw}`, { hint: "Используйте 128MB или мегабайты.", exitCode: 2 });
    }
    return Number(match[1]);
}
export async function runSandboxCommand(argv) {
    const { values, positionals } = parseCommandArgs(argv, OPTIONS);
    if (asBoolean(values, "help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const [subcommand, file] = positionals;
    if (subcommand !== "run" || !file) {
        throw new PilotError("Использование: oc-pilot sandbox run <file>", { exitCode: 2 });
    }
    const ctx = resolveContext(values);
    const result = runSandbox(ctx.cwd, file, {
        timeoutMs: parseDuration(asString(values, "timeout")),
        memoryMb: parseMemory(asString(values, "memory-limit")),
    });
    if (ctx.flags.json) {
        const wrote = writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
    }
    else {
        const wrote = writeOutput(renderSandbox(result), ctx.flags.output);
        if (wrote)
            log.success(`Результат сохранён: ${wrote}`);
    }
    if (result.status === "blocked")
        log.warn("Побочный эффект заблокирован.");
    if (result.status === "error" || result.status === "timeout")
        log.error(`Sandbox: ${result.status}.`);
    return result.status === "ok" || result.status === "blocked" ? 0 : 1;
}
//# sourceMappingURL=sandbox.js.map