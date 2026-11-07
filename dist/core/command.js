import { spawn } from "node:child_process";
import { PilotError } from "./errors.js";
import { killProcessTree } from "./process.js";
export function runShellCommand(command, cwd, options) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const maxBuffer = Math.max(200_000, options.maxBufferChars ?? 500_000);
        let output = "";
        let timedOut = false;
        let settled = false;
        const child = spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                ...options.env,
                NO_COLOR: "1",
                FORCE_COLOR: "0",
            },
        });
        const append = (chunk) => {
            output += chunk;
            if (output.length > maxBuffer)
                output = output.slice(-maxBuffer);
            if (options.verbose)
                process.stderr.write(chunk);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
        }, options.timeoutMs);
        const settle = (error, result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else if (result)
                resolve(result);
        };
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => append(chunk));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => append(chunk));
        child.on("error", (error) => {
            if (error.code === "ENOENT") {
                settle(new PilotError("Команда тестов не найдена", {
                    hint: "Проверьте --command или настройку testCommand в .oc-pilot.json.",
                }));
                return;
            }
            settle(new PilotError(`Не удалось запустить тесты: ${error.message}`));
        });
        child.on("close", (code) => {
            if (timedOut) {
                output += `\n[... тесты прерваны по таймауту ${Math.round(options.timeoutMs / 1000)} с ...]\n`;
            }
            settle(undefined, {
                exitCode: code ?? (timedOut ? 124 : 1),
                output,
                timedOut,
                durationMs: Date.now() - startedAt,
            });
        });
    });
}
//# sourceMappingURL=command.js.map