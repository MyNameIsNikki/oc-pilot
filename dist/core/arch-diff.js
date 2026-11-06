import { splitDiffBlocks } from "./diff.js";
import { parseImports, resolveImportSpecifier } from "./import-graph.js";
import { readRepository } from "./slop/collect.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";
const DEFAULT_MAX_EDGES = 200;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function importOnLine(file, line) {
    return parseImports(file, line)[0]?.specifier;
}
function collect(cwd, diff, files) {
    const added = [];
    const removed = [];
    const seen = new Set();
    for (const block of splitDiffBlocks(diff)) {
        if (block.path === "(diff)" || block.path === "(unknown)")
            continue;
        if (!isCodeFile(block.path) || isTestFile(block.path) || isGeneratedPath(block.path))
            continue;
        let oldLine = 0;
        let newLine = 0;
        for (const raw of block.text.split("\n")) {
            const hunk = HUNK.exec(raw);
            if (hunk) {
                newLine = Number(hunk[1]);
                oldLine = Number(/^@@ -(\d+)/.exec(raw)?.[1] ?? "0");
                continue;
            }
            if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("\\"))
                continue;
            const isAdded = raw.startsWith("+");
            const isRemoved = raw.startsWith("-");
            if (isAdded || isRemoved) {
                const specifier = importOnLine(block.path, raw.slice(1));
                if (specifier) {
                    const to = resolveImportSpecifier(cwd, block.path, specifier, files);
                    if (to && to !== block.path) {
                        const line = isAdded ? newLine : oldLine;
                        const key = `${isAdded ? "added" : "removed"}:${block.path}:${to}:${String(line)}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            const edge = { from: block.path, to, specifier, line, change: isAdded ? "added" : "removed" };
                            if (isAdded)
                                added.push(edge);
                            else
                                removed.push(edge);
                        }
                    }
                }
            }
            if (isAdded)
                newLine += 1;
            else if (isRemoved)
                oldLine += 1;
            else if (raw.length > 0) {
                oldLine += 1;
                newLine += 1;
            }
        }
    }
    const sort = (left, right) => left.from.localeCompare(right.from) || left.line - right.line || left.to.localeCompare(right.to);
    added.sort(sort);
    removed.sort(sort);
    return { added, removed };
}
function nodeId(index) {
    return `n${String(index)}`;
}
function renderDiagram(nodes, edges) {
    const ids = new Map(nodes.map((node, index) => [node, nodeId(index)]));
    const lines = ["flowchart LR"];
    for (const node of nodes) {
        lines.push(`  ${ids.get(node)}["${node.replaceAll('"', "'")}"]`);
    }
    for (const edge of edges) {
        const arrow = edge.change === "added" ? "-->" : "-.->";
        lines.push(`  ${ids.get(edge.from)} ${arrow}|${edge.change}| ${ids.get(edge.to)}`);
    }
    lines.push("  classDef added stroke:#2e7d32,stroke-width:2px");
    lines.push("  classDef removed stroke:#c62828,stroke-width:2px,stroke-dasharray: 4 2");
    const addedIndexes = edges
        .map((edge, index) => (edge.change === "added" ? index : -1))
        .filter((index) => index >= 0);
    const removedIndexes = edges
        .map((edge, index) => (edge.change === "removed" ? index : -1))
        .filter((index) => index >= 0);
    if (addedIndexes.length > 0)
        lines.push(`  linkStyle ${addedIndexes.join(",")} stroke:#2e7d32,stroke-width:2px`);
    if (removedIndexes.length > 0) {
        lines.push(`  linkStyle ${removedIndexes.join(",")} stroke:#c62828,stroke-width:2px,stroke-dasharray: 4 2`);
    }
    return lines.join("\n");
}
export function analyzeArchDiff(cwd, diff, options = {}) {
    const files = new Set(readRepository(cwd).files.map((file) => file.path));
    const { added, removed } = collect(cwd, diff, files);
    const maxEdges = Math.max(1, options.maxEdges ?? DEFAULT_MAX_EDGES);
    const all = [...added, ...removed];
    const selected = all.slice(0, maxEdges);
    const selectedAdded = selected.filter((edge) => edge.change === "added");
    const selectedRemoved = selected.filter((edge) => edge.change === "removed");
    const nodes = [...new Set(selected.flatMap((edge) => [edge.from, edge.to]))].sort();
    return {
        added: selectedAdded,
        removed: selectedRemoved,
        nodes,
        diagram: renderDiagram(nodes, selected),
        truncated: all.length > selected.length,
    };
}
export function renderMermaid(report) {
    return `\`\`\`mermaid\n${report.diagram}\n\`\`\`\n`;
}
export function describeArchDiff(report) {
    const lines = [
        `Добавлено связей: ${String(report.added.length)}, удалено: ${String(report.removed.length)}.`,
        `Узлов на схеме: ${String(report.nodes.length)}.`,
    ];
    if (report.truncated)
        lines.push("Схема усечена лимитом --max-edges.");
    return lines.join("\n");
}
//# sourceMappingURL=arch-diff.js.map