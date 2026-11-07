import { basename, dirname, extname, join } from "node:path";
import { coverageGaps, changedLines, loadCoverage } from "./coverage.js";
import { PilotError } from "./errors.js";
import { analyzeImpact } from "./impact.js";
import { buildImportGraph, reverseClosure, type ImportGraph } from "./import-graph.js";
import { detectTestCommand } from "./project.js";
import { readRepository } from "./slop/collect.js";
import { isCodeFile, isGeneratedPath, isTestFile } from "./slop/source.js";

export type PlanStrategy = "affected" | "fast" | "full";

export type PlanReason =
  | "changed-test"
  | "direct-import"
  | "transitive-import"
  | "naming"
  | "symbol-reference";

export type PlanConfidence = "high" | "medium" | "low";

export interface SelectedTest {
  file: string;
  reasons: PlanReason[];
  confidence: PlanConfidence;
}

export interface TestPlanStats {
  scannedFiles: number;
  graphEdges: number;
  selected: number;
  skipped: number;
  totalSelected: number;
  truncated: boolean;
}

export interface TestPlanReport {
  strategy: PlanStrategy;
  changedFiles: string[];
  tests: SelectedTest[];
  uncovered: string[];
  stats: TestPlanStats;
  command: string | null;
}

export interface TestPlanOptions {
  strategy?: PlanStrategy;
  maxTests?: number;
  coverageFile?: string;
  printCommand?: boolean;
  command?: string;
}

const CONFIDENCE_RANK: Record<PlanConfidence, number> = { high: 0, medium: 1, low: 2 };

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function namingCandidates(file: string): string[] {
  const extension = extname(file);
  const base = basename(file, extension);
  const directory = dirname(file);
  if (extension === ".go") return [normalize(file.replace(/\.go$/, "_test.go"))];
  if (extension === ".py") {
    return [
      normalize(join(directory, `test_${base}.py`)),
      normalize(join(directory, `${base}_test.py`)),
      normalize(join(directory, "tests", `test_${base}.py`)),
    ];
  }
  return [
    normalize(join(directory, `${base}.test${extension}`)),
    normalize(join(directory, `${base}.spec${extension}`)),
    normalize(join(directory, "__tests__", `${base}.test${extension}`)),
    normalize(join(directory, "__tests__", `${base}.spec${extension}`)),
  ];
}

function isNamingMatch(file: string, test: string): boolean {
  return namingCandidates(file).includes(normalize(test));
}

function confidenceOf(reasons: PlanReason[]): PlanConfidence {
  if (reasons.includes("changed-test") || reasons.includes("direct-import") || reasons.includes("naming")) {
    return "high";
  }
  if (reasons.includes("transitive-import")) return "medium";
  return "low";
}

export function quoteCommandArg(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildCommand(cwd: string, tests: SelectedTest[], options: TestPlanOptions): string | null {
  if (!options.printCommand) return null;
  const command = options.command ?? detectTestCommand(cwd)?.command;
  if (!command) {
    throw new PilotError("Не найдена команда тестов для --print-command", {
      hint: "Укажите --command или поле testCommand в .oc-pilot.json.",
      exitCode: 2,
    });
  }
  if (!command.includes("{files}")) {
    throw new PilotError("--print-command требует {files} в команде тестов", {
      hint: 'Пример: --command "node --test {files}".',
      exitCode: 2,
    });
  }
  return command.replace("{files}", tests.map((test) => quoteCommandArg(test.file)).join(" "));
}

function directChangedImports(graph: ImportGraph, test: string, changed: Set<string>): boolean {
  return graph.edges.some((edge) => edge.from === test && changed.has(edge.to));
}

/**
 * Deterministically selects the test files a diff can affect. The graph is
 * textual, so the plan prefers extra tests over silently missing one.
 */
export function selectTests(cwd: string, diff: string, changedFiles: string[], options: TestPlanOptions = {}): TestPlanReport {
  const strategy = options.strategy ?? "affected";
  const repository = readRepository(cwd);
  const graph = buildImportGraph(cwd, repository.files);
  const allFiles = new Set(graph.files);
  const changed = changedFiles
    .map(normalize)
    .filter((file) => isCodeFile(file) && !isGeneratedPath(file) && allFiles.has(file));
  const changedSet = new Set(changed);
  const changedCode = changed.filter((file) => !isTestFile(file));
  const changedTests = new Set(changed.filter(isTestFile));
  const tests = graph.files.filter(isTestFile);

  if (strategy === "full") {
    const selected = tests.map((file) => ({
      file,
      reasons: changedTests.has(file) ? (["changed-test"] as PlanReason[]) : [],
      confidence: "high" as PlanConfidence,
    }));
    return {
      strategy,
      changedFiles: changed,
      tests: selected,
      uncovered: [],
      stats: {
        scannedFiles: graph.files.length,
        graphEdges: graph.edges.length,
        selected: selected.length,
        skipped: 0,
        totalSelected: selected.length,
        truncated: false,
      },
      command: buildCommand(cwd, selected, options),
    };
  }

  const affected = reverseClosure(graph, changedCode);
  const impact = changedCode.length > 0 ? analyzeImpact(cwd, diff, changed) : undefined;
  const symbolFiles = new Map<string, string>();
  for (const symbol of impact?.symbols ?? []) symbolFiles.set(symbol.name, symbol.file);
  const testSymbols = new Map<string, Set<string>>();
  for (const reference of impact?.references ?? []) {
    if (!isTestFile(reference.file)) continue;
    const source = symbolFiles.get(reference.symbol);
    if (!source) continue;
    const set = testSymbols.get(reference.file) ?? new Set<string>();
    set.add(source);
    testSymbols.set(reference.file, set);
  }

  const selected: SelectedTest[] = [];
  const coveredChanged = new Set<string>();
  for (const test of tests) {
    const reasons: PlanReason[] = [];
    if (changedTests.has(test)) {
      reasons.push("changed-test");
      for (const file of changed) coveredChanged.add(file);
    }
    if (directChangedImports(graph, test, changedSet)) reasons.push("direct-import");
    if (affected.has(test)) reasons.push("transitive-import");
    for (const file of changedCode) {
      if (isNamingMatch(file, test)) {
        if (!reasons.includes("naming")) reasons.push("naming");
        coveredChanged.add(file);
      }
    }
    if (testSymbols.has(test)) {
      reasons.push("symbol-reference");
      for (const file of testSymbols.get(test) ?? []) coveredChanged.add(file);
    }
    for (const edge of graph.edges) {
      if (edge.from === test && changedSet.has(edge.to)) coveredChanged.add(edge.to);
    }
    if (reasons.length === 0) continue;
    const confidence = confidenceOf(reasons);
    if (strategy === "fast" && confidence !== "high") continue;
    selected.push({ file: test, reasons, confidence });
  }

  if (options.coverageFile) {
    const report = loadCoverage(cwd, options.coverageFile);
    if (report) {
      const gaps = coverageGaps(report, changedLines(diff));
      for (const gap of gaps.gaps) coveredChanged.delete(gap.file);
    }
  }

  selected.sort(
    (left, right) =>
      CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] || left.file.localeCompare(right.file),
  );
  const totalSelected = selected.length;
  const maxTests = options.maxTests;
  const truncated = maxTests !== undefined && totalSelected > maxTests;
  const limited = truncated ? selected.slice(0, maxTests) : selected;
  const uncovered = changedCode.filter((file) => !coveredChanged.has(file)).sort();

  return {
    strategy,
    changedFiles: changed,
    tests: limited,
    uncovered,
    stats: {
      scannedFiles: graph.files.length,
      graphEdges: graph.edges.length,
      selected: limited.length,
      skipped: tests.length - limited.length,
      totalSelected,
      truncated,
    },
    command: buildCommand(cwd, limited, options),
  };
}

/** Russian summary for the CLI. */
export function describeTestPlan(report: TestPlanReport): string {
  const lines = [
    `Стратегия: ${report.strategy}.`,
    `Изменённых файлов: ${String(report.changedFiles.length)}.`,
    `Выбрано тестов: ${String(report.tests.length)} из ${String(report.stats.totalSelected)}.`,
  ];
  if (report.stats.truncated) lines.push("Список урезан лимитом --max-tests.");
  if (report.tests.length > 0) {
    lines.push("", "Тесты:");
    for (const test of report.tests) {
      lines.push(`  ${test.file} — ${test.reasons.join(", ")} (${test.confidence})`);
    }
  }
  if (report.uncovered.length > 0) {
    lines.push("", "Без тестов:");
    for (const file of report.uncovered) lines.push(`  ${file}`);
  }
  if (report.command) lines.push("", `Команда: ${report.command}`);
  return `${lines.join("\n")}\n`;
}
