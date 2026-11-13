import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PilotError } from "../core/errors.js";
import { resolveHooksDir } from "../core/hooks.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";

export type HookKind = "pre-commit" | "pre-push";
export type HookMode = "preflight" | "scan";

export const HOOK_MARKER = "# oc-pilot hook v2";

const LEGACY_MARKERS = ["# oc-pilot hook v1"];

const OPTIONS: OptionSpec = withCommon({
  uninstall: { type: "boolean" },
  force: { type: "boolean" },
  "pre-push": { type: "boolean" },
  scan: { type: "boolean" },
});

export function hookScript(kind: HookKind, mode: HookMode = "preflight"): string {
  const command =
    kind === "pre-commit"
      ? mode === "scan"
        ? "scan --staged"
        : "preflight --staged"
      : "review --fail-on critical --fail-on-secrets";
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Managed by oc-pilot install-hook. Remove with: oc-pilot install-hook --uninstall",
    'if [ "$OC_PILOT_SKIP" = "1" ] || [ "$OC_PILOT_SKIP" = "true" ]; then',
    "  exit 0",
    "fi",
    'if [ -n "$OC_PILOT_BIN" ]; then',
    `  exec "$OC_PILOT_BIN" ${command}`,
    "fi",
    'for candidate in ./node_modules/.bin/oc-pilot ./node_modules/.bin/oc-pilot.cmd; do',
    '  if [ -x "$candidate" ]; then',
    `    exec "$candidate" ${command}`,
    "  fi",
    "done",
    'if command -v oc-pilot >/dev/null 2>&1; then',
    `  exec oc-pilot ${command}`,
    "fi",
    'echo "oc-pilot: binary not found (set OC_PILOT_BIN or install oc-pilot), skipping check" >&2',
    "exit 0",
    "",
  ].join("\n");
}

export { resolveHooksDir };

export interface HookActionResult {
  kind: HookKind;
  path: string;
  backup?: string;
  removed: boolean;
}

function isOurs(content: string): boolean {
  return content
    .split("\n")
    .some((line) => line.trim() === HOOK_MARKER || LEGACY_MARKERS.includes(line.trim()));
}

export function installHook(
  cwd: string,
  kind: HookKind,
  force: boolean,
  mode: HookMode = "preflight",
): HookActionResult {
  const dir = resolveHooksDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, kind);
  const backup = `${path}.oc-pilot.bak`;

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (!isOurs(existing)) {
      if (!force) {
        throw new PilotError(`Хук ${kind} уже существует и не принадлежит oc-pilot`, {
          hint: "Используйте --force: существующий хук будет сохранён как <имя>.oc-pilot.bak.",
          exitCode: 2,
        });
      }
      if (existsSync(backup)) rmSync(backup);
      renameSync(path, backup);
      log.warn(`Существующий хук ${kind} сохранён: ${backup}`);
    } else {
      rmSync(path);
    }
  }

  writeFileSync(path, hookScript(kind, mode), "utf8");
  try {
    chmodSync(path, 0o755);
  } catch {
    // Permissions are best-effort (e.g. on some Windows setups).
  }
  return { kind, path, backup: existsSync(backup) ? backup : undefined, removed: false };
}

export function uninstallHook(cwd: string, kind: HookKind): HookActionResult {
  const dir = resolveHooksDir(cwd);
  const path = join(dir, kind);
  const backup = `${path}.oc-pilot.bak`;
  const existed = existsSync(path);

  if (existed) {
    const existing = readFileSync(path, "utf8");
    if (!isOurs(existing)) {
      throw new PilotError(`Хук ${kind} не принадлежит oc-pilot; удаление отменено`, { exitCode: 2 });
    }
    rmSync(path);
  }

  let restored: string | undefined;
  if (existsSync(backup)) {
    renameSync(backup, path);
    restored = path;
  }
  return { kind, path, backup: restored, removed: existed && !restored };
}

const HELP = `Использование:
  oc-pilot install-hook [опции]

Устанавливает нативные git-хуки (POSIX sh, без husky):
  pre-commit  -> oc-pilot preflight --staged (секреты, зависимости, тесты, slop)
  pre-push    -> oc-pilot review --fail-on critical --fail-on-secrets

Хуки опциональны и полностью обратимы; чужие хуки не перезаписываются
без --force (сохраняются как <имя>.oc-pilot.bak). Пропуск разового запуска:
OC_PILOT_SKIP=1 git commit ...

Опции:
      --uninstall            удалить хуки oc-pilot (вернуть .bak при наличии)
      --force                перезаписать чужой хук (с бэкапом)
      --scan                 лёгкий pre-commit: только scan --staged, без зависимостей и slop
      --pre-push             дополнительно установить pre-push (вызывает модель)
${COMMON_HELP}

Примеры:
  oc-pilot install-hook
  oc-pilot install-hook --pre-push
  oc-pilot install-hook --uninstall
`;

export async function runInstallHook(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const rawCwd = asString(values, "cwd");
  const cwd = rawCwd ? resolve(process.cwd(), rawCwd) : process.cwd();
  const uninstall = asBoolean(values, "uninstall");
  const force = asBoolean(values, "force");
  const withPrePush = asBoolean(values, "pre-push");
  const mode: HookMode = asBoolean(values, "scan") ? "scan" : "preflight";
  const kinds: HookKind[] = withPrePush ? ["pre-commit", "pre-push"] : ["pre-commit"];

  for (const kind of kinds) {
    if (uninstall) {
      const result = uninstallHook(cwd, kind);
      if (result.backup) {
        log.success(`Хук ${kind} удалён; восстановлен бэкап ${result.backup}.`);
      } else if (result.removed) {
        log.success(`Хук ${kind} удалён.`);
      } else {
        log.info(`Хук ${kind} не найден — нечего удалять.`);
      }
    } else {
      const result = installHook(cwd, kind, force, mode);
      log.success(`Хук ${kind} установлен: ${result.path}`);
    }
  }

  if (!uninstall) {
    log.detail("Пропуск разового запуска: OC_PILOT_SKIP=1 git commit ...");
  }
  return 0;
}
