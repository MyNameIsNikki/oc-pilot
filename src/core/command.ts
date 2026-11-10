import { spawn } from "node:child_process";
import { PilotError } from "./errors.js";
import { killProcessTree } from "./process.js";

export interface ShellRunOptions {
  timeoutMs: number;
  verbose?: boolean;
  maxBufferChars?: number;
  env?: Record<string, string | undefined>;
}

export interface ShellRunResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export function runShellCommand(
  command: string,
  cwd: string,
  options: ShellRunOptions,
): Promise<ShellRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const maxBuffer = Math.max(200_000, options.maxBufferChars ?? 500_000);
    let output = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd,
      shell: true, // oc-pilot:sast-ignore shell-true: команда из конфигурации исполняется через shell по контракту
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: (() => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        // A nested test command must not inherit the parent test runner context.
        delete env.NODE_TEST_CONTEXT;
        Object.assign(env, options.env);
        env.NO_COLOR = "1";
        env.FORCE_COLOR = "0";
        return env;
      })(),
    });

    const append = (chunk: string): void => {
      output += chunk;
      if (output.length > maxBuffer) output = output.slice(-maxBuffer);
      if (options.verbose) process.stderr.write(chunk);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);

    const settle = (error: Error | undefined, result?: ShellRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => append(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => append(chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle(
          new PilotError("Команда тестов не найдена", {
            hint: "Проверьте --command или настройку testCommand в .oc-pilot.json.",
          }),
        );
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
