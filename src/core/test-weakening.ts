/**
 * Test-weakening heuristic: agent-made green builds often come from disabling
 * or deleting checks instead of fixing the code. This scans the diff for the
 * usual tricks — skipped/focused tests, removed assertions, commented-out
 * assertions and stretched timeouts.
 */
import { isTestFile } from "./test-delta.js";

export type TestWeaknessKind =
  | "skipped-test"
  | "focused-test"
  | "removed-assertions"
  | "commented-assertion"
  | "raised-timeout"
  | "weakened-matcher"
  | "suppressed-type-check"
  | "swallowed-assertion"
  | "removed-test";

export interface TestWeakness {
  file: string;
  line: number;
  kind: TestWeaknessKind;
  detail: string;
}

const MAX_REPORTED = 20;
const MAX_LISTED = 10;

/** Patterns that disable or narrow a test run. */
const SKIP_PATTERNS: Array<{ re: RegExp; kind: TestWeaknessKind; detail: string }> = [
  { re: /\b(?:it|test|describe|context|suite)\.skip\s*\(/, kind: "skipped-test", detail: "тест помечен как .skip" },
  { re: /\b(?:it|test|describe|context|suite)\.todo\s*\(/, kind: "skipped-test", detail: "тест помечен как .todo" },
  { re: /\b(?:xit|xdescribe|xtest)\s*\(/, kind: "skipped-test", detail: "тест заменён на x-вариант" },
  { re: /\bt\.Skip(?:f|Now)?\s*\(/, kind: "skipped-test", detail: "t.Skip в Go-тесте" },
  { re: /@pytest\.mark\.(?:skip|xfail)\b/, kind: "skipped-test", detail: "pytest skip/xfail" },
  { re: /pytest\.skip\s*\(/, kind: "skipped-test", detail: "pytest.skip()" },
  { re: /#\[ignore\]/, kind: "skipped-test", detail: "Rust #[ignore]" },
  { re: /@Ignore\b/, kind: "skipped-test", detail: "JUnit @Ignore" },
  { re: /\bpending\s*\(\s*["'`]/, kind: "skipped-test", detail: "pending-тест" },
  { re: /\.only\s*\(/, kind: "focused-test", detail: ".only сужает прогон до одного теста" },
  { re: /\bf(?:it|describe)\s*\(/, kind: "focused-test", detail: "focused-тест (fit/fdescribe)" },
];

/** Lines that actually check something, used to compare removed vs added. */
const ASSERTION_RE = /\b(?:expect|assert(?:_eq|_ne|_matches)?|assertEquals?|assertTrue|assertFalse|XCTAssert\w*|require)\s*\(|\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(|\bAssert\.\w+\s*\(|\.should\b/;

/** Assertion that was commented out instead of deleted. */
const COMMENTED_ASSERTION_RE = /^\s*(?:\/\/|#|\/\*|\*)\s*(?:expect|assert|Assert|XCTAssert|require)\b/;

/** Jest timeout raised to at least 10 seconds. */
const RAISED_TIMEOUT_RE = /\b(?:jest\.)?setTimeout\s*\(\s*(\d{4,})\s*\)/;

/** Strict matchers that prove a concrete value. */
const STRICT_MATCHER_RE = /\.(?:toEqual|toStrictEqual|toBe)\s*\(/;

/** Loose matchers that only prove existence or truthiness. */
const LOOSE_MATCHER_RE = /\.(?:toBeDefined|toBeTruthy|toBeFalsy)\s*\(|\.not\.(?:toBeNull|toBeUndefined|toBeFalsy)\s*\(/;

/** Type-check suppression added to a test instead of fixing the type. */
const TYPE_SUPPRESSION_RE = /@ts-(?:ignore|expect-error)\b/;

/** A catch block with no body swallows the assertion failure. */
const SWALLOWED_CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;

/** Test declarations, used to notice a deleted test that was never replaced. */
const TEST_DECLARATION_RE = /\b(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/;

interface FileState {
  file: string;
  added: number;
  removed: number;
  firstRemovedLine: number;
  removedTests: Map<string, number>;
  addedTests: Set<string>;
}

/**
 * Scans a unified diff and reports places where tests appear to have been
 * weakened. Only added lines of test files produce line hits; removed
 * assertions are reported once per file.
 */
export function analyzeTestWeakness(diff: string): TestWeakness[] {
  const findings: TestWeakness[] = [];
  const files: FileState[] = [];
  let current: FileState | undefined;
  let nextLine = 0;
  let hunkRemovedStrict = false;

  const flush = (): void => {
    if (!current) return;
    files.push(current);
    current = undefined;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      flush();
      const file = line.slice(4).replace(/^b\//, "").trim();
      current = isTestFile(file)
        ? {
            file,
            added: 0,
            removed: 0,
            firstRemovedLine: 0,
            removedTests: new Map(),
            addedTests: new Set(),
          }
        : undefined;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /\+(\d+)/.exec(line.slice(2));
      if (match) nextLine = Number(match[1]);
      hunkRemovedStrict = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("---") || line.startsWith("diff --git")) continue;

    const added = line.startsWith("+");
    const removed = line.startsWith("-") && !line.startsWith("---");
    const body = line.slice(1);

    if (removed) {
      if (ASSERTION_RE.test(body)) {
        current.removed += 1;
        if (current.firstRemovedLine === 0) current.firstRemovedLine = nextLine;
      }
      if (STRICT_MATCHER_RE.test(body)) hunkRemovedStrict = true;
      const removedTest = TEST_DECLARATION_RE.exec(body);
      if (removedTest?.[1] && !current.removedTests.has(removedTest[1])) {
        current.removedTests.set(removedTest[1], nextLine);
      }
      continue;
    }
    if (!added) {
      nextLine += 1;
      continue;
    }

    const lineNumber = nextLine;
    nextLine += 1;
    if (ASSERTION_RE.test(body)) current.added += 1;

    const addedTest = TEST_DECLARATION_RE.exec(body);
    if (addedTest?.[1]) current.addedTests.add(addedTest[1]);
    if (hunkRemovedStrict && LOOSE_MATCHER_RE.test(body)) {
      findings.push({
        file: current.file,
        line: lineNumber,
        kind: "weakened-matcher",
        detail: "строгая проверка заменена на проверку существования или истинности",
      });
      hunkRemovedStrict = false;
    }
    if (TYPE_SUPPRESSION_RE.test(body)) {
      findings.push({
        file: current.file,
        line: lineNumber,
        kind: "suppressed-type-check",
        detail: "проверка типов подавлена через @ts-ignore/@ts-expect-error",
      });
    }
    if (SWALLOWED_CATCH_RE.test(body)) {
      findings.push({
        file: current.file,
        line: lineNumber,
        kind: "swallowed-assertion",
        detail: "пустой catch проглатывает падение проверки",
      });
    }

    for (const pattern of SKIP_PATTERNS) {
      if (pattern.re.test(body)) {
        findings.push({ file: current.file, line: lineNumber, kind: pattern.kind, detail: pattern.detail });
        break;
      }
    }
    if (COMMENTED_ASSERTION_RE.test(body)) {
      findings.push({
        file: current.file,
        line: lineNumber,
        kind: "commented-assertion",
        detail: "проверка закомментирована вместо удаления",
      });
    }
    const timeout = RAISED_TIMEOUT_RE.exec(body);
    if (timeout && Number(timeout[1]) >= 10_000) {
      findings.push({
        file: current.file,
        line: lineNumber,
        kind: "raised-timeout",
        detail: `таймаут теста поднят до ${Number(timeout[1])} мс`,
      });
    }
  }
  flush();

  for (const file of files) {
    if (file.removed > file.added) {
      findings.push({
        file: file.file,
        line: file.firstRemovedLine,
        kind: "removed-assertions",
        detail: `удалено проверок: ${file.removed - file.added} (добавлено ${file.added}, удалено ${file.removed})`,
      });
    }
    for (const [name, line] of file.removedTests) {
      if (!file.addedTests.has(name)) {
        findings.push({
          file: file.file,
          line,
          kind: "removed-test",
          detail: `тест «${name}» удалён и не заменён`,
        });
      }
    }
  }

  return findings.slice(0, MAX_REPORTED);
}

/** Short human-readable summary for logs and prompts. */
export function describeTestWeakening(findings: TestWeakness[]): string {
  const listed = findings.slice(0, MAX_LISTED).map((item) => `- ${item.file}:${item.line} [${item.kind}] ${item.detail}`);
  if (findings.length > MAX_LISTED) listed.push(`- …и ещё ${findings.length - MAX_LISTED}`);
  return listed.join("\n");
}
