import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditDependencies } from "./deps-health.js";
import { PilotError } from "./errors.js";
import { isGitRepo } from "./git.js";
import { parseBinaryVersion, readBinaryVersion, resolveHookBinary, resolveHooksDir } from "./hooks.js";
import { VERSION } from "../version.js";
import { detectLockfile, readLockfile } from "./lockfile.js";
import { detectTestCommand } from "./project.js";
import { readReceipt, readReceiptPublicKey, receiptPath, verifyReceipt } from "./receipt.js";
import { analyzeRepository } from "./slop/index.js";
import { scanAuthzSource } from "./authz.js";
import { authzFingerprint, loadFindingsBaseline, sastFingerprint } from "./findings-baseline.js";
import { scanSource } from "./sast.js";
import { readRepository } from "./slop/collect.js";
import { isTestFile } from "./slop/source.js";

export type ReadinessStatus = "pass" | "warn" | "fail";
export type ReadinessGrade = "agent-ready" | "almost" | "risky" | "not-ready";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  points: number;
  max: number;
  detail: string;
}

export interface ReadinessReport {
  score: number;
  grade: ReadinessGrade;
  checks: ReadinessCheck[];
  commit: string | null;
}

export interface ReadinessOptions {
  /** Slop Index above this value is a warning, above twice this value is a failure. */
  slopMax?: number;
}

const GRADE_LABELS: Record<ReadinessGrade, string> = {
  "agent-ready": "готов к агенту",
  almost: "почти готов",
  risky: "рискованно",
  "not-ready": "не готов",
};

/** Short human-readable grade. */
export function gradeLabel(grade: ReadinessGrade): string {
  return GRADE_LABELS[grade];
}

function check(id: string, label: string, max: number, status: ReadinessStatus, detail: string): ReadinessCheck {
  const ratio = status === "pass" ? 1 : status === "warn" ? 0.5 : 0;
  return { id, label, status, points: Math.round(max * ratio), max, detail };
}

function readIfExists(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function hookPath(cwd: string, name: string): string {
  try {
    return join(resolveHooksDir(cwd), name);
  } catch {
    return join(cwd, ".git", "hooks", name);
  }
}

export function agentDocsFile(cwd: string): string | undefined {
  for (const name of ["AGENTS.md", "CLAUDE.md", ".cursorrules", join(".github", "copilot-instructions.md")]) {
    if (existsSync(join(cwd, name))) return name;
  }
  return undefined;
}

function ciFile(cwd: string): string | undefined {
  if (existsSync(join(cwd, ".github", "workflows"))) return ".github/workflows";
  if (existsSync(join(cwd, ".gitlab-ci.yml"))) return ".gitlab-ci.yml";
  return undefined;
}

/**
 * Scores how safely a coding agent can work in this repository. Every check is
 * offline and cheap: no model call, no network, no test run.
 */
function securityCheck(cwd: string): ReadinessCheck {
  const files = readRepository(cwd).files.filter((file) => !isTestFile(file.path));
  if (files.length === 0) {
    return check("security", "Безопасность", 15, "fail", "нет исходников для анализа");
  }
  const sast = files.flatMap((file) => scanSource(file.path, file.text).findings);
  const authz = files.flatMap((file) => scanAuthzSource(file.path, file.text).findings);
  let baselineSast = new Set<string>();
  let baselineAuthz = new Set<string>();
  try {
    const baseline = loadFindingsBaseline(cwd);
    baselineSast = new Set(baseline.baseline.sast);
    baselineAuthz = new Set(baseline.baseline.authz);
  } catch {
    // A broken baseline must never hide findings.
  }
  const activeSast = sast.filter((finding) => !baselineSast.has(sastFingerprint(finding)));
  const activeAuthz = authz.filter((finding) => !baselineAuthz.has(authzFingerprint(finding)));
  const all = [...activeSast, ...activeAuthz];
  const high = all.filter((finding) => finding.severity === "high").length;
  const medium = all.filter((finding) => finding.severity === "medium").length;
  const low = all.filter((finding) => finding.severity === "low").length;
  if (high > 0) {
    return check("security", "Безопасность", 15, "fail", `${String(high)} high, ${String(medium)} medium, ${String(low)} low`);
  }
  if (medium + low > 0) {
    return check("security", "Безопасность", 15, "warn", `high нет, ${String(medium)} medium, ${String(low)} low`);
  }
  return check("security", "Безопасность", 15, "pass", `проверено ${String(files.length)} файл(ов), опасных паттернов нет`);
}

export function assessReadiness(cwd: string, options: ReadinessOptions = {}): ReadinessReport {
  if (!isGitRepo(cwd)) {
    throw new PilotError("Готовность считается только в git-репозитории", {
      hint: "Инициализируйте git или укажите --cwd корня репозитория.",
      exitCode: 2,
    });
  }

  const checks: ReadinessCheck[] = [];
  const testCommand = detectTestCommand(cwd)?.command;
  checks.push(
    testCommand
      ? check("tests", "Тестовая команда", 15, "pass", testCommand)
      : check("tests", "Тестовая команда", 15, "fail", "не найдена — агенту нечем проверять изменения"),
  );

  checks.push(securityCheck(cwd));

  const lock = detectLockfile(cwd);
  if (!lock) {
    checks.push(check("lockfile", "Lockfile", 10, "fail", "не найден — установка невоспроизводима"));
  } else {
    const audit = auditDependencies(cwd);
    const lockIssues = audit.issues.filter((issue) => issue.kind === "lockfile");
    const broken = lockIssues.filter((issue) => issue.severity === "high");
    const data = readLockfile(cwd);
    let unreadable = (data?.packages.length ?? 0) === 0;
    if (unreadable && lock.kind === "npm") {
      try {
        JSON.parse(readFileSync(lock.path, "utf8").replace(/^\uFEFF/, ""));
        unreadable = false;
      } catch {
        unreadable = true;
      }
    }
    checks.push(
      broken.length > 0
        ? check("lockfile", "Lockfile", 10, "fail", `${lock.file}: ${String(broken.length)} пакет(ов) не установлены`)
        : unreadable
          ? check("lockfile", "Lockfile", 10, "warn", `${lock.file}: не удалось прочитать lockfile`)
          : check("lockfile", "Lockfile", 10, "pass", lock.file),
    );
  }

  const preCommit = readIfExists(hookPath(cwd, "pre-commit"));
  if (preCommit?.includes("# oc-pilot hook")) {
    const managed = ["pre-commit", "pre-push"].filter((kind) =>
      readIfExists(hookPath(cwd, kind))?.includes("# oc-pilot hook"),
    );
    const label = managed.join(" и ");
    const installed = managed.length > 1 ? `${label} установлены` : `${label} установлен`;
    const subject = managed.length > 1 ? `${label} используют` : `${label} использует`;
    const verifies = managed.length > 1 ? "проверяют" : "проверяет";
    const binary = resolveHookBinary(cwd);
    if (!binary) {
      checks.push(
        check(
          "hooks",
          "Git-хук",
          15,
          "warn",
          `${installed}, но oc-pilot не найден: проверка будет пропущена; задайте OC_PILOT_BIN или установите oc-pilot`,
        ),
      );
    } else {
      const reported = readBinaryVersion(binary);
      const actual = parseBinaryVersion(reported);
      if (!actual) {
        checks.push(
          check(
            "hooks",
            "Git-хук",
            15,
            "warn",
            `${subject} ${binary}, но версию определить не удалось; задайте OC_PILOT_BIN или обновите oc-pilot`,
          ),
        );
      } else if (actual !== VERSION) {
        checks.push(
          check(
            "hooks",
            "Git-хук",
            15,
            "warn",
            `${subject} oc-pilot ${actual} (${binary}), а текущий ${VERSION}: обновите бинарник или задайте OC_PILOT_BIN`,
          ),
        );
      } else {
        checks.push(
          check("hooks", "Git-хук", 15, "pass", `${label} ${verifies} изменение (${binary}, ${actual})`),
        );
      }
    }
  } else if (preCommit) {
    checks.push(check("hooks", "Git-хук", 15, "warn", "pre-commit есть, но не oc-pilot"));
  } else {
    checks.push(check("hooks", "Git-хук", 15, "fail", "pre-commit не установлен: oc-pilot install-hook"));
  }

  const slop = analyzeRepository(cwd, { blame: false });
  const slopMax = options.slopMax ?? 45;
  checks.push(
    slop.index <= slopMax
      ? check("slop", "Slop Index", 15, "pass", `${String(slop.index)}/100`)
      : slop.index <= slopMax * 2
        ? check("slop", "Slop Index", 15, "warn", `${String(slop.index)}/100 — выше ${String(slopMax)}`)
        : check("slop", "Slop Index", 15, "fail", `${String(slop.index)}/100 — энтропия высокая`),
  );

  const path = receiptPath(cwd);
  const receipt = path ? readReceiptOrUndefined(path) : undefined;
  if (!receipt) {
    checks.push(check("receipt", "Квитанция", 10, "fail", "нет квитанции для HEAD: oc-pilot receipt"));
  } else {
    const verification = verifyReceipt(cwd, receipt, readReceiptPublicKey(cwd));
    checks.push(
      verification.ok
        ? check(
            "receipt",
            "Квитанция",
            10,
            "pass",
            `действительна (${receipt.commit?.slice(0, 12) ?? "без коммита"})${
              verification.signature === "valid" ? ", подпись проверена" : ""
            }`,
          )
        : check("receipt", "Квитанция", 10, "warn", verification.reason ?? "недействительна"),
    );
  }

  const docs = agentDocsFile(cwd);
  checks.push(
    docs
      ? check("docs", "Инструкции для агента", 10, "pass", docs)
      : check("docs", "Инструкции для агента", 10, "warn", "AGENTS.md или CLAUDE.md не найден"),
  );

  const ci = ciFile(cwd);
  checks.push(
    ci
      ? check("ci", "CI", 5, "pass", ci)
      : check("ci", "CI", 5, "warn", "CI не настроен"),
  );

  checks.push(
    existsSync(join(cwd, ".oc-pilot.json"))
      ? check("config", "Конфигурация", 5, "pass", ".oc-pilot.json")
      : check("config", "Конфигурация", 5, "warn", ".oc-pilot.json не найден"),
  );

  const score = checks.reduce((total, item) => total + item.points, 0);
  const grade: ReadinessGrade = score >= 85 ? "agent-ready" : score >= 65 ? "almost" : score >= 40 ? "risky" : "not-ready";
  const commit = receipt?.commit ?? null;

  return { score, grade, checks, commit };
}

function readReceiptOrUndefined(path: string) {
  try {
    return readReceipt(path);
  } catch {
    return undefined;
  }
}

/** Shields.io markdown badge for a readiness score. */
export function renderBadge(report: ReadinessReport): string {
  const color = report.score >= 85 ? "brightgreen" : report.score >= 65 ? "yellow" : report.score >= 40 ? "orange" : "red";
  return `[![agent-ready: ${String(report.score)}/100](https://img.shields.io/badge/agent--ready-${String(report.score)}%2F100-${color})](https://github.com/aleyn/oc-pilot)`;
}

/** Text report with one line per check. */
export function renderReadiness(report: ReadinessReport): string {
  const lines = [`Готовность к агенту: ${String(report.score)}/100 (${gradeLabel(report.grade)}).`, ""];
  for (const item of report.checks) {
    const mark = item.status === "pass" ? "OK  " : item.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${mark} ${item.id.padEnd(9)} ${String(item.points).padStart(2)}/${String(item.max).padEnd(2)} ${item.detail}`);
  }
  return `${lines.join("\n")}\n`;
}
