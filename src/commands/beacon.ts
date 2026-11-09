import {
  clearBeacon,
  createBeacon,
  parseBeaconCheck,
  readBeacon,
  renderBeacon,
  renderBeaconMarkdown,
  verifyBeacon,
} from "../core/beacon.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";

const OPTIONS: OptionSpec = withCommon({
  check: { type: "string", multiple: true },
  command: { type: "string", multiple: true },
  agent: { type: "string" },
  model: { type: "string" },
  "prompt-hash": { type: "string" },
  key: { type: "string" },
  "ssh-key": { type: "string" },
  "allowed-signers": { type: "string" },
  identity: { type: "string" },
  "require-signature": { type: "boolean" },
  markdown: { type: "boolean" },
  force: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot beacon stamp [--check name=status]... [опции]
  oc-pilot beacon verify [--key <file> | --allowed-signers <file> --identity <id>]
  oc-pilot beacon render [--markdown]
  oc-pilot beacon clear --force

Beacon — это манифест проверки коммита: commit, tree, версия инструмента,
агент, модель, команды, проверки и digest. Подпись HMAC или ssh-keygen
привязывает манифест к автору; verify проверяет digest и подпись, render
печатает Markdown для PR или check.

Статусы verify:
  [BEACON VALID]        digest и подпись совпадают
  [UNATTRIBUTED]        beacon не подписан или подпись не подтверждена
  [BEACON TAMPERED]     digest не совпадает
  [BEACON MISSING]      файла нет

Опции:
      --check <name=...>     проверка: name=pass|warn|fail|skip (можно несколько)
      --command <cmd>        выполненная команда (можно несколько)
      --agent <name>         кто выполнил проверку
      --model <name>         какая модель использовалась
      --prompt-hash <h>      хеш промпта или сессии
      --key <file>           HMAC-ключ для stamp/verify
      --ssh-key <file>       ключ ssh-keygen для stamp
      --allowed-signers <f>  allowed_signers для SSH-verify
      --identity <id>        identity для SSH-verify
      --require-signature    verify падает на unsigned
      --markdown             render в Markdown
      --force                подтвердить clear
${COMMON_HELP}

Коды выхода verify:
  0  valid или unsigned (если не указан --require-signature)
  1  unsigned при --require-signature, tampered или unattributed
  2  missing или ошибка ключа

Примеры:
  oc-pilot beacon stamp --check tests=pass --check preflight=pass --key beacon.key
  oc-pilot beacon verify --key beacon.key
  oc-pilot beacon render --markdown`;

function strings(values: Record<string, unknown>, key: string): string[] {
  const value = values[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  throw new PilotError(`--${key} ожидает значение`, { exitCode: 2 });
}

export async function runBeacon(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const [subcommand] = positionals;
  const ctx = resolveContext(values);

  if (subcommand === "stamp") {
    const checks = strings(values as Record<string, unknown>, "check").map(parseBeaconCheck);
    const commands = strings(values as Record<string, unknown>, "command");
    const manifest = createBeacon(ctx.cwd, {
      checks,
      commands,
      agent: asString(values, "agent"),
      model: asString(values, "model"),
      promptHash: asString(values, "prompt-hash"),
      keyPath: asString(values, "key"),
      sshKeyPath: asString(values, "ssh-key"),
    });
    const wrote = ctx.flags.json
      ? writeOutput(JSON.stringify(manifest, null, 2), ctx.flags.output)
      : writeOutput(renderBeacon(manifest), ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
    log.success(`Beacon записан: .oc-pilot/beacon.json`);
    return 0;
  }

  if (subcommand === "verify") {
    const result = verifyBeacon(ctx.cwd, {
      keyPath: asString(values, "key"),
      allowedSigners: asString(values, "allowed-signers"),
      identity: asString(values, "identity"),
    });
    const wrote = ctx.flags.json
      ? writeOutput(JSON.stringify(result, null, 2), ctx.flags.output)
      : writeOutput(result.content, ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
    if (result.status === "valid") {
      log.success(result.summary);
      return 0;
    }
    if (result.status === "unsigned" && !asBoolean(values, "require-signature")) {
      log.warn(result.summary);
      return 0;
    }
    if (result.status === "missing" || result.status === "error") {
      log.error(result.summary);
      return 2;
    }
    log.error(result.summary);
    return 1;
  }

  if (subcommand === "render") {
    const manifest = readBeacon(ctx.cwd);
    if (!manifest) {
      throw new PilotError("Beacon не найден", {
        hint: "Сначала выполните oc-pilot beacon stamp.",
        exitCode: 2,
      });
    }
    const text = asBoolean(values, "markdown")
      ? renderBeaconMarkdown(manifest)
      : renderBeacon(manifest);
    const wrote = ctx.flags.json
      ? writeOutput(JSON.stringify(manifest, null, 2), ctx.flags.output)
      : writeOutput(text, ctx.flags.output);
    if (wrote) log.success(`Результат сохранён: ${wrote}`);
    return 0;
  }

  if (subcommand === "clear") {
    if (!asBoolean(values, "force")) {
      throw new PilotError("clear удаляет beacon; добавьте --force", {
        hint: "Проверить beacon: oc-pilot beacon render.",
        exitCode: 2,
      });
    }
    const result = clearBeacon(ctx.cwd);
    if (ctx.flags.json) writeOutput(JSON.stringify(result, null, 2), ctx.flags.output);
    else process.stdout.write(`Beacon: ${result.removed ? "удалён" : "не найден"}.\n`);
    return 0;
  }

  throw new PilotError("Неизвестная подкоманда beacon", {
    hint: "Доступно: stamp, verify, render, clear.",
    exitCode: 2,
  });
}
