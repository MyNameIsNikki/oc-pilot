import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PilotError } from "./errors.js";
export async function readStdin() {
    if (process.stdin.isTTY) {
        throw new PilotError("stdin не передан", {
            hint: "Передайте данные через pipe: git diff | oc-pilot review --stdin",
            exitCode: 2,
        });
    }
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
}
export function readTextFile(file, label = "файл") {
    const absolute = resolve(file);
    try {
        if (!statSync(absolute).isFile()) {
            throw new PilotError(`${label} не является файлом: ${absolute}`, { exitCode: 2 });
        }
        return readFileSync(absolute, "utf8").replace(/^\uFEFF/, "");
    }
    catch (error) {
        if (error instanceof PilotError)
            throw error;
        throw new PilotError(`Не удалось прочитать ${label}: ${absolute}`, {
            hint: error instanceof Error ? error.message : String(error),
            exitCode: 2,
        });
    }
}
/**
 * Accepts a literal string, "-" for stdin, or "@path" for a file.
 */
export async function resolveTextInput(value, cwd) {
    if (value === "-")
        return readStdin();
    if (value.startsWith("@")) {
        const path = value.slice(1);
        return readTextFile(isAbsolute(path) ? path : resolve(cwd, path), "файл контекста");
    }
    return value;
}
export function writeOutput(text, outputPath) {
    const normalized = text.endsWith("\n") ? text : `${text}\n`;
    if (!outputPath) {
        process.stdout.write(normalized);
        return undefined;
    }
    const absolute = resolve(outputPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, normalized, "utf8");
    return absolute;
}
//# sourceMappingURL=io.js.map