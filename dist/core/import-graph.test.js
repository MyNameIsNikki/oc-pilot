import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildImportGraph, parseImports, resolveSpecifier, reverseClosure } from "./import-graph.js";
function file(path, text) {
    return { path, text };
}
test("parseImports reads static, dynamic and require imports", () => {
    const imports = parseImports("src/app.ts", [
        'import { a } from "./a";',
        'import type { B } from "./b";',
        'export { c } from "./c";',
        'const d = require("./d");',
        'const e = import("./e");',
        "",
    ].join("\n"));
    assert.deepEqual(imports.map((item) => item.specifier), ["./a", "./b", "./c", "./d", "./e"]);
    assert.deepEqual(imports.map((item) => item.line), [1, 2, 3, 4, 5]);
});
test("parseImports reads relative Python imports", () => {
    const imports = parseImports("pkg/app.py", "from .models import User\nfrom . import helpers\n");
    assert.deepEqual(imports.map((item) => item.specifier), ["./models"]);
});
test("resolveSpecifier handles relative, index, @/ and aliases", () => {
    const files = new Set(["src/a.ts", "src/lib/index.ts", "src/alias/tool.ts", "src/b.ts"]);
    assert.equal(resolveSpecifier("src/app.ts", "./a", files), "src/a.ts");
    assert.equal(resolveSpecifier("src/app.ts", "./lib", files), "src/lib/index.ts");
    assert.equal(resolveSpecifier("src/app.ts", "@/b", files), "src/b.ts");
    assert.equal(resolveSpecifier("src/app.ts", "./b.js", files), "src/b.ts");
    assert.equal(resolveSpecifier("src/app.ts", "./missing", files), undefined);
});
test("buildImportGraph reads tsconfig aliases and reverseClosure finds importers", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-import-graph-"));
    try {
        mkdirSync(join(dir, "src", "lib"), { recursive: true });
        writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }), "utf8");
        const files = [
            file("src/lib/wallet.ts", "export const charge = 1;\n"),
            file("src/checkout.ts", 'import { charge } from "@lib/wallet";\n'),
            file("src/app.ts", 'import { pay } from "./checkout";\n'),
        ];
        const graph = buildImportGraph(dir, files);
        assert.deepEqual(graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["src/app.ts->src/checkout.ts", "src/checkout.ts->src/lib/wallet.ts"]);
        assert.deepEqual([...reverseClosure(graph, ["src/lib/wallet.ts"])].sort(), ["src/app.ts", "src/checkout.ts"]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=import-graph.test.js.map