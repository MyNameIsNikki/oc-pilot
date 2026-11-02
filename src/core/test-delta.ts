/**
 * Test-delta heuristic: flags diffs where real logic changed but no test file
 * was touched. Vibe coders rarely write tests unless something nudges them.
 */
export interface TestDelta {
  codeFiles: string[];
  testFiles: string[];
  addedCodeLines: number;
  /** True when meaningful logic changed and no tests were touched. */
  gap: boolean;
}

/** Minimum added lines in code files before a missing-test warning fires. */
const GAP_THRESHOLD_LINES = 20;
const MAX_LISTED_FILES = 10;

const TEST_FILE_PATTERNS: RegExp[] = [
  /(^|[\\/])(tests?|__tests__)[\\/]/i,
  /\.(test|spec)\.[a-z]+$/i,
  /_test\.(go|py|rs|c|cpp|cc|h)$/i,
  /^test_[a-z_]+\.py$/i,
  /\.(uitest|snap)\.[a-z]+$/i,
];

const NON_CODE_EXTENSIONS = /\.(md|txt|rst|json|ya?ml|toml|ini|lock|csv|env|gitignore|editorconfig|dockerignore|nvmrc|node-version|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|pdf)$/i;

function isTestFile(file: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

function isCodeFile(file: string): boolean {
  const base = file.split(/[\\/]/).pop() ?? file;
  if (base.startsWith(".")
    || /^(dockerfile|makefile|jenkinsfile|gemfile|rakefile)$/i.test(base)) {
    return false;
  }
  return !NON_CODE_EXTENSIONS.test(file);
}

function countAddedLines(diff: string, codeFiles: Set<string>): number {
  let file = "";
  let added = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (file === "/dev/null" || !codeFiles.has(file)) continue;
    added += 1;
  }
  return added;
}

/** Analyzes changed files + diff for the "logic without tests" signal. */
export function analyzeTestDelta(changedFiles: string[], diff: string): TestDelta {
  const testFiles = changedFiles.filter(isTestFile);
  const codeFiles = changedFiles.filter((file) => isCodeFile(file) && !isTestFile(file));
  const addedCodeLines = countAddedLines(diff, new Set(codeFiles));
  const gap = codeFiles.length > 0 && testFiles.length === 0 && addedCodeLines >= GAP_THRESHOLD_LINES;
  return { codeFiles, testFiles, addedCodeLines, gap };
}

/** Short human-readable summary for logs and meta. */
export function describeTestDelta(delta: TestDelta): string {
  const files = delta.codeFiles.slice(0, MAX_LISTED_FILES).join(", ");
  const more = delta.codeFiles.length > MAX_LISTED_FILES ? `, +${delta.codeFiles.length - MAX_LISTED_FILES} ещё` : "";
  return `+${delta.addedCodeLines} строк кода в ${delta.codeFiles.length} файл(ах) (${files}${more}), тесты не изменены`;
}
