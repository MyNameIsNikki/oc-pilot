import assert from "node:assert/strict";
import { test } from "node:test";
import { findDeadExports } from "./dead-exports.js";
test("findDeadExports ignores exports used inside their own module", () => {
    const files = [
        {
            path: "src/a.ts",
            text: [
                "export function helper() {",
                "  return 1;",
                "}",
                "export function caller() {",
                "  return helper();",
                "}",
                "",
            ].join("\n"),
        },
        {
            path: "src/b.ts",
            text: ['import { caller } from "./a.js";', "caller();", ""].join("\n"),
        },
        {
            path: "src/c.ts",
            text: ["export function unused() {", "  return 1;", "}", ""].join("\n"),
        },
    ];
    assert.deepEqual(findDeadExports(files).map((item) => item.name), ["unused"]);
});
//# sourceMappingURL=dead-exports.test.js.map