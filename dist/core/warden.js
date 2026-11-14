import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectAddedLines } from "./alien-dna.js";
import { collectChangedFiles, splitDiffBlocks } from "./diff.js";
import { PilotError } from "./errors.js";
export const WARDEN_POLICY = ".oc-pilot/policy.json";
const POLICY_VERSION = 1;
const RULE_KINDS = new Set([
    "forbid-paths",
    "forbid-content",
    "forbid-deps",
    "forbid-extensions",
    "require-tests",
    "max-files",
]);
export function wardenPolicyPath(cwd) {
    return join(cwd, WARDEN_POLICY);
}
/** Converts a glob with * and ** into a regular expression. */
export function globToRegExp(glob) {
    const source = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*");
    return new RegExp(`^${source}$`);
}
export const SAMPLE_POLICY = {
    version: 1,
    rules: [
        {
            kind: "forbid-paths",
            name: "lockfiles",
            patterns: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
            message: "lockfiles изменяются только релизным ботом",
        },
        {
            kind: "forbid-paths",
            name: "secrets",
            patterns: [".env", ".env.*", "**/*.pem", "**/*.key"],
            message: "секреты не коммитятся",
        },
        {
            kind: "forbid-content",
            name: "no-eval",
            patterns: ["\\beval\\s*\\(", "new\\s+Function\\s*\\("],
            message: "eval и new Function запрещены",
        },
        {
            kind: "require-tests",
            name: "tests-required",
            message: "изменение исходников требует изменения тестов",
        },
        {
            kind: "max-files",
            name: "review-size",
            max: 40,
            message: "diff слишком большой для ревью",
        },
    ],
};
export function parseWardenPolicy(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    const record = parsed;
    if (record.version !== POLICY_VERSION || !Array.isArray(record.rules))
        return undefined;
    const rules = [];
    for (const item of record.rules) {
        if (!item || typeof item !== "object")
            continue;
        const rule = item;
        const kind = rule.kind;
        if (typeof kind !== "string" || !RULE_KINDS.has(kind))
            continue;
        const entry = { kind: kind };
        if (typeof rule.name === "string" && rule.name.trim())
            entry.name = rule.name.trim();
        if (typeof rule.message === "string" && rule.message.trim())
            entry.message = rule.message.trim();
        if (Array.isArray(rule.patterns)) {
            const patterns = rule.patterns.filter((pattern) => typeof pattern === "string" && pattern.length > 0);
            if (patterns.length > 0)
                entry.patterns = patterns;
        }
        if (typeof rule.max === "number" && Number.isInteger(rule.max) && rule.max >= 0)
            entry.max = rule.max;
        rules.push(entry);
    }
    return { version: POLICY_VERSION, rules };
}
export function readWardenPolicy(cwd) {
    const path = wardenPolicyPath(cwd);
    if (!existsSync(path))
        return undefined;
    return parseWardenPolicy(readFileSync(path, "utf8"));
}
export function initWardenPolicy(cwd, force) {
    const path = wardenPolicyPath(cwd);
    if (existsSync(path) && !force) {
        throw new PilotError("Политика уже существует", {
            hint: "Используйте --force, чтобы перезаписать.",
            exitCode: 2,
        });
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(SAMPLE_POLICY, null, 2)}\n`, "utf8");
    return { written: WARDEN_POLICY, existed: false };
}
const DEP_LINE = /"(@?[A-Za-z0-9._/-]+)"\s*:\s*"[~^<>=0-9]/;
function isTestPath(path) {
    return /(^|\/)(test|tests|__tests__|spec|specs)\//.test(path) || /\.(test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]*\.py$/.test(path);
}
/** Checks the diff against the policy. Pure and deterministic. */
export function checkWardenPolicy(diff, policy) {
    const files = collectChangedFiles(diff).filter((path) => path !== "(unknown)" && path !== "(diff)");
    const addedLines = collectAddedLines(diff);
    const violations = [];
    const sourceFiles = files.filter((path) => /\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|dart|ex)$/i.test(path) && !isTestPath(path));
    const testFiles = files.filter((path) => isTestPath(path));
    for (const rule of policy.rules) {
        const label = rule.name ?? rule.kind;
        switch (rule.kind) {
            case "forbid-paths": {
                const matchers = (rule.patterns ?? []).map(globToRegExp);
                for (const file of files) {
                    if (matchers.some((matcher) => matcher.test(file))) {
                        violations.push({
                            rule: label,
                            kind: rule.kind,
                            file,
                            evidence: file,
                            message: rule.message ?? "запрещённый путь",
                        });
                    }
                }
                break;
            }
            case "forbid-content": {
                for (const line of addedLines) {
                    for (const pattern of rule.patterns ?? []) {
                        let matcher;
                        try {
                            matcher = new RegExp(pattern);
                        }
                        catch {
                            continue;
                        }
                        if (matcher.test(line.text)) {
                            violations.push({
                                rule: label,
                                kind: rule.kind,
                                file: line.path,
                                line: line.line,
                                evidence: line.text.trim().slice(0, 200),
                                message: rule.message ?? "запрещённое содержимое",
                            });
                            break;
                        }
                    }
                }
                break;
            }
            case "forbid-deps": {
                for (const line of addedLines) {
                    const dependency = DEP_LINE.exec(line.text)?.[1];
                    if (dependency && (rule.patterns ?? []).some((pattern) => pattern === dependency)) {
                        violations.push({
                            rule: label,
                            kind: rule.kind,
                            file: line.path,
                            line: line.line,
                            evidence: `${dependency} ${line.text.trim().slice(0, 120)}`.trim(),
                            message: rule.message ?? `запрещённая зависимость ${dependency}`,
                        });
                    }
                }
                break;
            }
            case "forbid-extensions": {
                for (const file of files) {
                    const extension = /\.([^./]+)$/.exec(file)?.[1];
                    if (extension && (rule.patterns ?? []).some((pattern) => pattern.toLowerCase() === extension.toLowerCase())) {
                        violations.push({
                            rule: label,
                            kind: rule.kind,
                            file,
                            evidence: file,
                            message: rule.message ?? `запрещённое расширение .${extension}`,
                        });
                    }
                }
                break;
            }
            case "require-tests": {
                if (sourceFiles.length > 0 && testFiles.length === 0) {
                    violations.push({
                        rule: label,
                        kind: rule.kind,
                        evidence: sourceFiles.slice(0, 3).join(", "),
                        message: rule.message ?? "изменение исходников требует изменения тестов",
                    });
                }
                break;
            }
            case "max-files": {
                const max = rule.max ?? 0;
                if (files.length > max) {
                    violations.push({
                        rule: label,
                        kind: rule.kind,
                        evidence: `${String(files.length)} файлов`,
                        message: rule.message ?? `больше ${String(max)} файлов`,
                    });
                }
                break;
            }
        }
    }
    const status = violations.length > 0 ? "violation" : "pass";
    const summary = status === "violation"
        ? `[POLICY VIOLATION]: ${String(violations.length)} нарушений политики.`
        : "[POLICY PASS]: diff соответствует политике.";
    const lines = [
        `Warden: ${status}`,
        `Files: ${String(files.length)}, added lines: ${String(addedLines.length)}`,
        `Rules: ${String(policy.rules.length)}, violations: ${String(violations.length)}`,
    ];
    if (violations.length > 0) {
        lines.push("Violations:");
        for (const violation of violations.slice(0, 50)) {
            const at = violation.file ? ` (${violation.file}${violation.line ? `:${String(violation.line)}` : ""})` : "";
            lines.push(`  [${violation.rule}]${at} ${violation.message}: ${violation.evidence}`);
        }
    }
    lines.push("", summary);
    return {
        files: files.length,
        addedLines: addedLines.length,
        violations,
        status,
        summary,
        content: `${lines.join("\n")}\n`,
    };
}
export function renderWardenPolicy(policy) {
    const lines = [`Policy: ${String(policy.rules.length)} rule(s).`];
    if (policy.rules.length === 0)
        lines.push("Правил нет — любой diff проходит.");
    for (const rule of policy.rules) {
        const label = rule.name ?? rule.kind;
        const detail = rule.kind === "max-files"
            ? `max ${String(rule.max ?? 0)}`
            : (rule.patterns ?? []).join(", ") || "—";
        lines.push(`  ${label} (${rule.kind}): ${detail}${rule.message ? ` — ${rule.message}` : ""}`);
    }
    return `${lines.join("\n")}\n`;
}
export { splitDiffBlocks };
//# sourceMappingURL=warden.js.map