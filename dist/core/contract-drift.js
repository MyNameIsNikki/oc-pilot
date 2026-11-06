import { splitDiffBlocks } from "./diff.js";
import { readRepository } from "./slop/collect.js";
import { isGeneratedPath } from "./slop/source.js";
const MAX_FINDINGS = 50;
const MAX_REFERENCES = 5;
const GENERIC_FIELDS = new Set([
    "id",
    "name",
    "type",
    "data",
    "value",
    "status",
    "error",
    "code",
    "message",
    "count",
    "total",
    "page",
    "limit",
    "offset",
    "items",
    "result",
    "createdAt",
    "updatedAt",
    "deletedAt",
]);
const RESERVED = new Set([
    "if",
    "for",
    "while",
    "switch",
    "return",
    "const",
    "let",
    "var",
    "function",
    "class",
    "import",
    "export",
    "interface",
    "type",
    "enum",
    "extends",
    "implements",
    "new",
    "this",
    "super",
    "def",
]);
const TS_INTERFACE = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const TS_TYPE = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\{/;
const ZOD_OBJECT = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*z\.object\s*\(\s*\{/;
const PRISMA_MODEL = /^\s*model\s+([A-Za-z_][\w]*)\s*\{/;
const PYDANTIC_CLASS = /^\s*class\s+([A-Za-z_][\w]*)\s*\([^)]*(?:BaseModel|pydantic)[^)]*\)\s*:/;
const JSON_TITLE = /"title"\s*:\s*"([^"]+)"/;
const TS_FIELD = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+?)[,;]?\s*$/;
const PRISMA_FIELD = /^\s*([A-Za-z_][\w]*)(\?)?\s+([A-Za-z_][\w[\]?@.]*)\s*(?:@.*)?$/;
const PYDANTIC_FIELD = /^\s*([A-Za-z_][\w]*)\s*:\s*(.+?)(?:\s*=\s*.+)?$/;
const JSON_PROPERTY = /"([A-Za-z_$][\w$]*)"\s*:\s*\{/;
function detectContract(text, file) {
    const checks = [
        [TS_INTERFACE, "typescript"],
        [TS_TYPE, "typescript"],
        [ZOD_OBJECT, "zod"],
        [PRISMA_MODEL, "prisma"],
        [PYDANTIC_CLASS, "pydantic"],
    ];
    for (const [regex, kind] of checks) {
        const match = regex.exec(text);
        if (match?.[1])
            return { name: match[1], kind };
    }
    if (file.endsWith(".json")) {
        const match = JSON_TITLE.exec(text);
        if (match?.[1])
            return { name: match[1], kind: "json-schema" };
    }
    return undefined;
}
function detectField(text, kind) {
    if (kind === "json-schema") {
        const match = JSON_PROPERTY.exec(text);
        if (!match?.[1])
            return undefined;
        return { name: match[1], type: "", optional: false, line: 0 };
    }
    if (kind === "prisma") {
        const match = PRISMA_FIELD.exec(text);
        if (!match?.[1] || !match[3] || RESERVED.has(match[1]))
            return undefined;
        return { name: match[1], type: match[3], optional: match[2] === "?", line: 0 };
    }
    if (kind === "pydantic") {
        const match = PYDANTIC_FIELD.exec(text);
        if (!match?.[1] || !match[2] || RESERVED.has(match[1]))
            return undefined;
        return { name: match[1], type: match[2].trim(), optional: match[2].includes("None"), line: 0 };
    }
    const match = TS_FIELD.exec(text);
    if (!match?.[1] || !match[3] || RESERVED.has(match[1]))
        return undefined;
    return { name: match[1], type: match[3].trim(), optional: match[2] === "?", line: 0 };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findReferences(files, changed, field) {
    if (GENERIC_FIELDS.has(field) || field.length < 3)
        return [];
    const pattern = new RegExp(`(?:\\.${escapeRegExp(field)}\\b|\\b${escapeRegExp(field)}\\s*:|["']${escapeRegExp(field)}["'])`);
    const references = [];
    for (const file of files) {
        if (changed.has(file.path) || isGeneratedPath(file.path))
            continue;
        const lines = file.text.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
            if (!pattern.test(line))
                continue;
            references.push({ file: file.path, line: index + 1, text: line.trim().slice(0, 120) });
            if (references.length >= MAX_REFERENCES)
                return references;
        }
    }
    return references;
}
function compareContract(contract, files, changed) {
    const findings = [];
    const removed = [...contract.oldFields.values()].filter((field) => !contract.newFields.has(field.name) && !contract.contextFields.has(field.name));
    for (const field of removed) {
        const references = findReferences(files, changed, field.name);
        findings.push({
            contract: contract.name,
            kind: "removed-field",
            field: field.name,
            severity: references.length > 0 ? "high" : "medium",
            file: contract.file,
            line: field.line,
            detail: references.length > 0
                ? `поле ${field.name} удалено из ${contract.name}, но ещё используется в других файлах`
                : `поле ${field.name} удалено из ${contract.name}`,
            references,
        });
    }
    for (const [name, oldField] of contract.oldFields) {
        const newField = contract.newFields.get(name);
        if (!newField)
            continue;
        if (oldField.optional && !newField.optional) {
            findings.push({
                contract: contract.name,
                kind: "optional-to-required",
                field: name,
                severity: "high",
                file: contract.file,
                line: newField.line,
                detail: `поле ${name} стало обязательным в ${contract.name}`,
                references: findReferences(files, changed, name),
            });
            continue;
        }
        if (oldField.type && newField.type && oldField.type !== newField.type) {
            findings.push({
                contract: contract.name,
                kind: "type-change",
                field: name,
                severity: "medium",
                file: contract.file,
                line: newField.line,
                detail: `тип поля ${name} изменился: ${oldField.type} -> ${newField.type}`,
                references: findReferences(files, changed, name),
            });
        }
    }
    return findings;
}
/**
 * Finds contract changes in a diff and checks whether removed or narrowed
 * fields are still used outside the changed files. It is intentionally
 * textual: no TypeScript compiler and no schema runtime are required.
 */
export function analyzeContractDrift(cwd, diff, changedFiles) {
    const changed = new Set(changedFiles);
    let files = [];
    try {
        files = readRepository(cwd).files;
    }
    catch {
        // Outside git or without a readable tree, drift is still reported without consumers.
    }
    const contracts = [];
    const findings = [];
    const flush = (contract) => {
        if (!contract)
            return;
        contracts.push({
            name: contract.name,
            kind: contract.kind,
            file: contract.file,
            line: contract.line,
            fields: [...contract.newFields.values()],
        });
        findings.push(...compareContract(contract, files, changed));
    };
    for (const block of splitDiffBlocks(diff)) {
        if (block.path === "(diff)" || block.path === "(unknown)")
            continue;
        if (isGeneratedPath(block.path))
            continue;
        let oldLine = 0;
        let newLine = 0;
        let contract;
        for (const line of block.text.split(/\r?\n/)) {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            if (hunk) {
                oldLine = Number(hunk[1]);
                newLine = Number(hunk[2]);
                continue;
            }
            if (line.startsWith("+++") || line.startsWith("---"))
                continue;
            const prefix = line[0];
            const text = line.slice(1);
            const lineNo = prefix === "-" ? oldLine : newLine;
            if (prefix === "+" || prefix === "-" || prefix === " ") {
                const declaration = detectContract(text, block.path);
                if (declaration) {
                    flush(contract);
                    contract = {
                        name: declaration.name,
                        kind: declaration.kind,
                        file: block.path,
                        line: lineNo,
                        oldFields: new Map(),
                        newFields: new Map(),
                        contextFields: new Set(),
                    };
                }
                else if (contract) {
                    const field = detectField(text, contract.kind);
                    if (field) {
                        field.line = lineNo;
                        if (prefix === "-")
                            contract.oldFields.set(field.name, field);
                        else if (prefix === "+")
                            contract.newFields.set(field.name, field);
                        else
                            contract.contextFields.add(field.name);
                    }
                }
            }
            if (prefix === "-" || prefix === " ")
                oldLine += 1;
            if (prefix === "+" || prefix === " ")
                newLine += 1;
        }
        flush(contract);
    }
    const seen = new Set();
    const unique = findings.filter((finding) => {
        const key = `${finding.file}:${finding.line}:${finding.kind}:${finding.field}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    const counts = {
        total: unique.length,
        high: unique.filter((finding) => finding.severity === "high").length,
        medium: unique.filter((finding) => finding.severity === "medium").length,
        byKind: unique.reduce((accumulator, finding) => {
            accumulator[finding.kind] = (accumulator[finding.kind] ?? 0) + 1;
            return accumulator;
        }, {}),
    };
    return {
        contracts,
        findings: unique.slice(0, MAX_FINDINGS),
        counts,
        scannedFiles: files.length,
        status: counts.high > 0 ? "fail" : counts.total > 0 ? "warn" : "pass",
    };
}
export function describeContractDrift(findings) {
    if (findings.length === 0)
        return "Ломки контрактов в изменённых схемах не найдено.";
    const lines = findings.slice(0, 10).map((finding) => {
        const consumers = finding.references.length > 0
            ? `; используется: ${finding.references.map((reference) => `${reference.file}:${String(reference.line)}`).join(", ")}`
            : "";
        return `- ${finding.file}:${String(finding.line)} [${finding.kind}] ${finding.detail}${consumers}`;
    });
    if (findings.length > 10)
        lines.push(`- …и ещё ${String(findings.length - 10)}`);
    return lines.join("\n");
}
//# sourceMappingURL=contract-drift.js.map