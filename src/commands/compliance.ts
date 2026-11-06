import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { readReceiptPublicKey } from "../core/receipt.js";
import {
  buildComplianceManifest,
  describeCompliance,
  latestManifestPath,
  readComplianceManifest,
  saveComplianceManifest,
  signComplianceManifest,
  verifyComplianceManifest,
} from "../core/compliance.js";

const OPTIONS: OptionSpec = withCommon({
  verify: { type: "boolean" },
  manifest: { type: "string" },
  receipt: { type: "string" },
  sbom: { type: "string" },
  sign: { type: "boolean" },
  key: { type: "string" },
  "public-key": { type: "string" },
  out: { type: "string" },
  model: { type: "string" },
});

const HELP = `Использование:
  oc-pilot compliance [опции]
  oc-pilot compliance --verify [--manifest <file>]

Собирает подписанный аудит-манифест для текущего коммита: квитанция,
результаты preflight, тесты, SBOM и хеш предыдущего манифеста. Манифест
образует цепочку хешей, поэтому правка любого звена обнаруживается.
Блокчейн не нужен: подпись Ed25519 и внешний якорь дают достаточную
доказуемость. Модель не вызывается.

Опции:
      --verify              проверить манифест вместо создания
      --manifest <file>     путь к манифесту для --verify (по умолчанию latest.json)
      --receipt <file>      путь к квитанции (по умолчанию .git/oc-pilot/receipt.json)
      --sbom <file>         приложить SBOM и его SHA-256
      --sign                подписать манифест Ed25519-ключом
      --key <file>          приватный ключ для --sign (или OC_PILOT_RECEIPT_KEY)
      --public-key <file>   публичный ключ для --verify
      --out <file>          сохранить манифест в указанный файл
      --model <id>          записать модель, которой выполнялась работа
${COMMON_HELP}

Примеры:
  oc-pilot compliance
  oc-pilot compliance --sbom sbom.json --json
  oc-pilot compliance --sign --key receipt.key
  oc-pilot compliance --verify
  oc-pilot compliance --verify --manifest .oc-pilot/compliance/manifest-abc.json --public-key receipt.key.pub`;

function readKey(cwd: string, path: string | undefined, envName: string): string | undefined {
  const value = path ? readFileSync(resolve(cwd, path), "utf8") : process.env[envName];
  return value && value.trim() ? value : undefined;
}

export async function runCompliance(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);

  if (asBoolean(values, "verify")) {
    const path = resolve(ctx.cwd, asString(values, "manifest") ?? latestManifestPath(ctx.cwd));
    if (!existsSync(path)) {
      throw new PilotError(`Манифест не найден: ${path}`, {
        hint: "Сначала создайте его командой oc-pilot compliance.",
        exitCode: 2,
      });
    }
    const manifest = readComplianceManifest(path);
    const publicKey =
      asString(values, "public-key") !== undefined
        ? readKey(ctx.cwd, asString(values, "public-key"), "OC_PILOT_RECEIPT_PUBLIC_KEY")
        : readReceiptPublicKey(ctx.cwd);
    const verification = verifyComplianceManifest(ctx.cwd, manifest, publicKey ? { publicKeyPem: publicKey } : {});
    if (ctx.flags.json) {
      const wrote = writeOutput(JSON.stringify({ manifest, verification }, null, 2), ctx.flags.output);
      if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    } else {
      const lines = [
        describeCompliance(manifest).trimEnd(),
        `Подпись: ${verification.signature}.`,
        `Цепочка: ${verification.chainOk ? "целая" : "нарушена"}.`,
        `Проверка: ${verification.ok ? "действительна" : `недействительна${verification.reason ? ` — ${verification.reason}` : ""}`}.`,
        "",
      ];
      const wrote = writeOutput(lines.join("\n"), ctx.flags.output);
      if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    }
    return verification.ok ? 0 : 1;
  }

  const manifest = buildComplianceManifest(ctx.cwd, {
    receiptPath: asString(values, "receipt"),
    sbomPath: asString(values, "sbom"),
    model: asString(values, "model") ?? ctx.config.model,
  });

  let signed = manifest;
  if (asBoolean(values, "sign")) {
    const privateKey = readKey(ctx.cwd, asString(values, "key"), "OC_PILOT_RECEIPT_KEY");
    if (!privateKey) {
      throw new PilotError("Не найден приватный ключ для --sign", {
        hint: "Укажите --key <file> или переменную OC_PILOT_RECEIPT_KEY.",
        exitCode: 2,
      });
    }
    signed = signComplianceManifest(manifest, privateKey);
  }

  const saved = saveComplianceManifest(ctx.cwd, signed, asString(values, "out"));
  if (ctx.flags.json) {
    const wrote = writeOutput(JSON.stringify(signed, null, 2), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  } else {
    const wrote = writeOutput(`${describeCompliance(signed)}Сохранено: ${saved}\n`, ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
  }
  return 0;
}
