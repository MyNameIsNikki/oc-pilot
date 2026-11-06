import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeContractDrift, describeContractDrift } from "./contract-drift.js";
function makeRepo(files) {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-contract-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    return dir;
}
test("analyzeContractDrift flags optional-to-required and type changes", () => {
    const dir = makeRepo({
        "src/types.ts": "export interface User {\n  email: string;\n  age: string;\n  role: string;\n}\n",
        "src/consumer.ts": "export function notify(user: User) {\n  return user.email + user.age;\n}\n",
    });
    const diff = [
        "diff --git a/src/types.ts b/src/types.ts",
        "--- a/src/types.ts",
        "+++ b/src/types.ts",
        "@@ -1,4 +1,4 @@",
        " export interface User {",
        "-  email?: string;",
        "-  age: number;",
        "+  email: string;",
        "+  age: string;",
        "   role: string;",
        " }",
        "",
    ].join("\n");
    try {
        const report = analyzeContractDrift(dir, diff, ["src/types.ts"]);
        const kinds = report.findings.map((finding) => finding.kind).sort();
        assert.deepEqual(kinds, ["optional-to-required", "type-change"]);
        assert.equal(report.counts.high, 1);
        assert.equal(report.counts.medium, 1);
        const email = report.findings.find((finding) => finding.field === "email");
        assert.ok(email?.references.some((reference) => reference.file === "src/consumer.ts"));
        assert.equal(report.status, "fail");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeContractDrift flags a removed field that is still used", () => {
    const dir = makeRepo({
        "src/types.ts": "export interface Account {\n  id: string;\n  role: string;\n}\n",
        "src/billing.ts": "export function bill(account: Account) {\n  return account.billingEmail;\n}\n",
    });
    const diff = [
        "diff --git a/src/types.ts b/src/types.ts",
        "--- a/src/types.ts",
        "+++ b/src/types.ts",
        "@@ -1,4 +1,3 @@",
        " export interface Account {",
        "   id: string;",
        "-  billingEmail: string;",
        "   role: string;",
        " }",
        "",
    ].join("\n");
    try {
        const report = analyzeContractDrift(dir, diff, ["src/types.ts"]);
        assert.equal(report.findings.length, 1);
        const finding = report.findings[0];
        assert.equal(finding.kind, "removed-field");
        assert.equal(finding.field, "billingEmail");
        assert.equal(finding.severity, "high");
        assert.equal(finding.references[0]?.file, "src/billing.ts");
        assert.equal(finding.references[0]?.line, 2);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeContractDrift reads Prisma models", () => {
    const dir = makeRepo({
        "prisma/schema.prisma": "model User {\n  id Int @id\n  role String\n}\n",
        "src/users.ts": "export function role(user: User) {\n  return user.billingEmail;\n}\n",
    });
    const diff = [
        "diff --git a/prisma/schema.prisma b/prisma/schema.prisma",
        "--- a/prisma/schema.prisma",
        "+++ b/prisma/schema.prisma",
        "@@ -1,4 +1,3 @@",
        " model User {",
        "   id Int @id",
        "-  billingEmail String",
        "   role String",
        " }",
        "",
    ].join("\n");
    try {
        const report = analyzeContractDrift(dir, diff, ["prisma/schema.prisma"]);
        assert.equal(report.findings.length, 1);
        assert.equal(report.findings[0]?.contract, "User");
        assert.equal(report.findings[0]?.field, "billingEmail");
        assert.equal(report.findings[0]?.severity, "high");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeContractDrift reads JSON Schema properties", () => {
    const dir = makeRepo({
        "schemas/user.json": '{\n  "title": "User",\n  "type": "object",\n  "properties": {\n    "role": { "type": "string" }\n  }\n}\n',
        "src/users.ts": "export function role(user: User) {\n  return user.billingEmail;\n}\n",
    });
    const diff = [
        "diff --git a/schemas/user.json b/schemas/user.json",
        "--- a/schemas/user.json",
        "+++ b/schemas/user.json",
        "@@ -1,6 +1,5 @@",
        " {",
        '   "title": "User",',
        '   "type": "object",',
        '   "properties": {',
        '-    "billingEmail": { "type": "string" },',
        '     "role": { "type": "string" }',
        "   }",
        " }",
        "",
    ].join("\n");
    try {
        const report = analyzeContractDrift(dir, diff, ["schemas/user.json"]);
        assert.equal(report.findings.length, 1);
        assert.equal(report.findings[0]?.kind, "removed-field");
        assert.equal(report.findings[0]?.field, "billingEmail");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("analyzeContractDrift ignores an added field and describes findings", () => {
    const dir = makeRepo({
        "src/types.ts": "export interface User {\n  id: string;\n  role: string;\n}\n",
    });
    const diff = [
        "diff --git a/src/types.ts b/src/types.ts",
        "--- a/src/types.ts",
        "+++ b/src/types.ts",
        "@@ -1,3 +1,4 @@",
        " export interface User {",
        "   id: string;",
        "   role: string;",
        "+  nickname: string;",
        " }",
        "",
    ].join("\n");
    try {
        const report = analyzeContractDrift(dir, diff, ["src/types.ts"]);
        assert.equal(report.findings.length, 0);
        assert.equal(report.status, "pass");
        assert.match(describeContractDrift(report.findings), /не найдено/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=contract-drift.test.js.map