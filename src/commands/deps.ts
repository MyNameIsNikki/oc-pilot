import { applyDependencyFixPlan, planDependencyFixes, type DependencyFixPlan } from "../core/deps-fix.js";
import { auditDependencies, issueFailsGate, type DepSeverity, type DepIssue } from "../core/deps-health.js";
import { explainDependency, renderDependencyWhy } from "../core/deps-why.js";
import { PilotError } from "../core/errors.js";
import { writeOutput } from "../core/io.js";
import { readLockfile } from "../core/lockfile.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, resolveContext, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { auditVulnerabilities, renderVulnerabilities, severityAtLeast, type OsvAuditResult, type VulnSeverity } from "../core/osv.js";
import { auditLicenses, buildSbom, renderLicenses, writeSbom, type LicenseAudit } from "../core/sbom.js";

const OPTIONS: OptionSpec = withCommon({
  "fail-on-issue": { type: "string" },
  ignore: { type: "string" },
  fix: { type: "boolean" },
  why: { type: "string" },
  audit: { type: "boolean" },
  "osv-url": { type: "string" },
  offline: { type: "boolean" },
  "fail-on-vuln": { type: "string" },
  sbom: { type: "string" },
});

const HELP = `Использование:
  oc-pilot deps [опции]

Офлайн-аудит зависимостей npm-проекта. Находит импорты пакетов, которых нет
в package.json (чистая установка упадёт), объявленные но неиспользуемые
пакеты, зависимости только для тестов в dependencies, дубли по назначению,
небезопасные спецификации версий и рассинхрон с package-lock.json.
По умолчанию сеть не используется и модель не вызывается; --audit
дополнительно запрашивает OSV и кеширует ответы.

Опции:
      --fail-on-issue <level>  код 1 при проблеме уровня high, medium или low
      --ignore <names>         не проверять пакеты (через запятую)
      --fix                    исправить безопасное: тестовые пакеты в devDependencies,
                               фантомные импорты и плавающие версии — по lockfile
      --why <name>             показать, откуда пакет: объявление, импорты,
                               зависимые пакеты и цепочки от корня
      --audit                  проверить известные уязвимости через OSV (нужна сеть)
      --fail-on-vuln <level>   код 1 при уязвимости уровня critical, high, medium или low
      --offline                не ходить в сеть, использовать кеш .oc-pilot/osv-cache.json
      --osv-url <url>          другой endpoint OSV (по умолчанию api.osv.dev)
      --sbom <file>            записать CycloneDX SBOM по версиям из lockfile
${COMMON_HELP}

Примеры:
  oc-pilot deps
  oc-pilot deps --json
  oc-pilot deps --fail-on-issue high
  oc-pilot deps --ignore lint-staged
  oc-pilot deps --why qs
  oc-pilot deps --why qs --json
  oc-pilot deps --fix --dry-run
  oc-pilot deps --fix --fail-on-issue high
  oc-pilot deps --audit --fail-on-vuln high
  oc-pilot deps --audit --offline --json
  oc-pilot deps --sbom sbom.json`;

const SEVERITIES = new Set<DepSeverity>(["high", "medium", "low"]);

function parseSeverity(value: string): DepSeverity {
  const normalized = value.trim().toLowerCase() as DepSeverity;
  if (!SEVERITIES.has(normalized)) {
    throw new PilotError(`Некорректный --fail-on-issue: ${value}`, {
      hint: "Допустимые значения: high, medium, low",
      exitCode: 2,
    });
  }
  return normalized;
}

function parseVulnSeverity(value: string): VulnSeverity {
  const normalized = value.trim().toLowerCase() as VulnSeverity;
  if (!VULN_SEVERITIES.has(normalized)) {
    throw new PilotError(`Некорректный --fail-on-vuln: ${value}`, {
      hint: "Допустимые значения: critical, high, medium, low",
      exitCode: 2,
    });
  }
  return normalized;
}

const VULN_SEVERITIES = new Set<VulnSeverity>(["critical", "high", "medium", "low"]);

function renderIssue(issue: DepIssue): string {
  const files = issue.files && issue.files.length > 0 ? ` [${issue.files.join(", ")}]` : "";
  return `${issue.severity.toUpperCase().padEnd(6)} ${issue.kind.padEnd(9)} ${issue.name} — ${issue.message}${files}`;
}

export async function runDeps(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const ctx = resolveContext(values);
  const ignoreRaw = asString(values, "ignore");
  const ignore = ignoreRaw
    ? ignoreRaw
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
  const gateRaw = asString(values, "fail-on-issue");
  const gate = gateRaw ? parseSeverity(gateRaw) : undefined;
  const fix = asBoolean(values, "fix");
  const whyName = asString(values, "why")?.trim();
  const audit = asBoolean(values, "audit");
  const offline = asBoolean(values, "offline");
  const sbomFile = asString(values, "sbom");
  const vulnGateRaw = asString(values, "fail-on-vuln");
  const vulnGate = vulnGateRaw ? parseVulnSeverity(vulnGateRaw) : undefined;
  const osvUrl = asString(values, "osv-url");

  if (offline && !audit) {
    throw new PilotError("--offline требует --audit", { hint: "Добавьте --audit или уберите --offline.", exitCode: 2 });
  }
  if (vulnGate && !audit) {
    throw new PilotError("--fail-on-vuln требует --audit", { hint: "Добавьте --audit.", exitCode: 2 });
  }
  if (osvUrl && !audit) {
    throw new PilotError("--osv-url требует --audit", { hint: "Добавьте --audit.", exitCode: 2 });
  }
  if (whyName && (audit || sbomFile)) {
    throw new PilotError("--why не сочетается с --audit и --sbom", {
      hint: "Сначала посмотрите происхождение пакета, затем запускайте аудит отдельно.",
      exitCode: 2,
    });
  }

  if (whyName) {
    if (fix) {
      throw new PilotError("--why не сочетается с --fix", {
        hint: "Сначала посмотрите происхождение пакета, затем запускайте --fix отдельно.",
        exitCode: 2,
      });
    }
    const why = explainDependency(ctx.cwd, whyName);
    if (!why) {
      log.warn(`Пакет ${whyName} не найден ни в package.json, ни в package-lock.json, ни в импортах.`);
      return 1;
    }
    if (ctx.flags.json) {
      writeOutput(JSON.stringify(why, null, 2), ctx.flags.output);
      return 0;
    }
    const wrote = writeOutput(renderDependencyWhy(why), ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    return 0;
  }

  let report = auditDependencies(ctx.cwd, { ignore });
  let plan: DependencyFixPlan | undefined;
  let applied = false;
  if (fix) {
    plan = planDependencyFixes(ctx.cwd, report);
    if (plan.fixes.length > 0 && !ctx.flags.dryRun) {
      applied = applyDependencyFixPlan(ctx.cwd, plan);
      if (applied) report = auditDependencies(ctx.cwd, { ignore });
    }
  }
  let auditResult: OsvAuditResult | undefined;
  let licenseAudit: LicenseAudit | undefined;
  let sbomPath: string | undefined;

  if (audit || sbomFile) {
    const lock = readLockfile(ctx.cwd);
    if (!lock || lock.packages.length === 0) {
      throw new PilotError("Lockfile не найден или пуст", {
        hint: "Аудит уязвимостей и SBOM требуют разрешённых версий: выполните установку зависимостей.",
        exitCode: 2,
      });
    }
    if (audit) {
      auditResult = await auditVulnerabilities(ctx.cwd, lock.packages, {
        url: osvUrl ?? process.env.OC_PILOT_OSV_URL,
        offline,
      });
      licenseAudit = auditLicenses(ctx.cwd, lock.packages);
    }
    if (sbomFile) sbomPath = writeSbom(ctx.cwd, sbomFile, buildSbom(lock.packages, report.packageName));
  }

  const vulnFailed =
    auditResult !== undefined &&
    vulnGate !== undefined &&
    auditResult.vulnerabilities.some((vuln) => severityAtLeast(vuln.severity, vulnGate));
  const failed = (gate !== undefined && issueFailsGate(report.issues, gate)) || vulnFailed;

  const auditLines: string[] = [];
  if (auditResult) auditLines.push(renderVulnerabilities(auditResult).trimEnd());
  if (licenseAudit) auditLines.push(renderLicenses(licenseAudit).trimEnd());
  if (sbomPath) auditLines.push(`SBOM сохранён: ${sbomPath}`);

  if (ctx.flags.json) {
    const payload: Record<string, unknown> = { ...report };
    if (fix && plan) payload.fix = { applied, dryRun: ctx.flags.dryRun, fixes: plan.fixes, skipped: plan.skipped };
    if (auditResult) payload.audit = { ...auditResult, licenses: licenseAudit };
    if (sbomPath) payload.sbom = sbomPath;
    writeOutput(JSON.stringify(payload, null, 2), ctx.flags.output);
    return failed ? 1 : 0;
  }

  log.info(
    `Зависимости ${report.packageName}: объявлено ${report.declared}, импортируется ${report.imported}, файлов ${report.scannedFiles}.`,
  );
  if (report.truncated) log.warn("Список файлов обрезан: проверены не все исходники.");

  const fixLines =
    plan?.fixes.map(
      (item) =>
        `${ctx.flags.dryRun ? "PLAN " : "FIXED"} ${item.action.padEnd(11)} ${item.name} — ${item.reason}`,
    ) ?? [];
  if (plan && ctx.flags.dryRun && plan.fixes.length > 0) {
    log.warn("Режим --dry-run: package.json не изменён.");
  }

  if (report.issues.length === 0) {
    const parts = [...fixLines, "Проблем не найдено.", ...auditLines];
    const wrote = writeOutput(`${parts.join("\n")}\n`, ctx.flags.output);
    if (wrote) log.success(`Отчёт сохранён: ${wrote}`);
    else log.success("Проблем не найдено.");
    if (vulnFailed) log.error(`Есть уязвимости уровня ${vulnGate ?? "high"} или выше.`);
    return failed ? 1 : 0;
  }

  const lines = [...fixLines, ...report.issues.map(renderIssue)];
  const counts = {
    high: report.issues.filter((issue) => issue.severity === "high").length,
    medium: report.issues.filter((issue) => issue.severity === "medium").length,
    low: report.issues.filter((issue) => issue.severity === "low").length,
  };
  lines.push("");
  lines.push(`Итог: high ${counts.high}, medium ${counts.medium}, low ${counts.low}.`);
  lines.push(...auditLines);

  const body = `${lines.join("\n")}\n`;
  const wrote = writeOutput(body, ctx.flags.output);
  if (wrote) {
    log.success(`Отчёт сохранён: ${wrote}`);
  } else {
    for (const issue of report.issues) {
      if (issue.severity === "high") log.warn(`${issue.kind}: ${issue.name}`);
      else log.detail(`${issue.kind}: ${issue.name}`);
    }
  }

  if (vulnFailed) log.error(`Есть уязвимости уровня ${vulnGate ?? "high"} или выше.`);
  else if (failed) log.error(`Есть проблемы уровня ${gate ?? "high"} или выше.`);
  return failed ? 1 : 0;
}
