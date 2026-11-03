import { extname } from "node:path";

/**
 * Extensions we are willing to tokenize. Unknown languages degrade to plain
 * text or are skipped entirely instead of producing noise.
 */
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".py",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".swift",
  ".scala",
  ".sh",
  ".ps1",
  ".lua",
  ".dart",
  ".ex",
]);

/** Languages where `#` starts a line comment. */
const HASH_COMMENT = new Set([".py", ".rb", ".sh", ".ps1", ".lua", ".ex"]);

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs)\//;
const TEST_NAME = /\.(test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]*\.py$|\.snap$/;

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isTestFile(path: string): boolean {
  return TEST_PATH.test(path) || TEST_NAME.test(path);
}

/** Files whose contents are generated or vendored, so entropy is not ours. */
export function isGeneratedPath(path: string): boolean {
  return (
    /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|target)\//.test(path) ||
    /\.(min|map|lock)\.[^/]+$|\.d\.ts$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path)
  );
}

export interface Token {
  value: string;
  line: number;
}

const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|==|!=|=>|<=|>=|&&|\|\||[-+*/%<>=!?:;,.(){}[\]]/g;

/**
 * Replaces comments and string literals with spaces while keeping newlines,
 * so token offsets and line numbers stay valid.
 */
export function stripCode(text: string, path = ""): string {
  const hashComments = HASH_COMMENT.has(extname(path).toLowerCase());
  const out: string[] = [];
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let cursor = from; cursor < to && cursor < text.length; cursor += 1) {
      out[cursor] = text[cursor] === "\n" ? "\n" : " ";
    }
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (hashComments && char === "#") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote) {
          cursor += 1;
          break;
        }
        if (quote !== "`" && text[cursor] === "\n") break;
        cursor += 1;
      }
      blank(index + 1, Math.max(index + 1, cursor - 1));
      index = cursor;
      continue;
    }
    out[index] = char;
    index += 1;
  }

  return out.join("");
}

/** Splits code into identifiers, numbers and operators, tracking line numbers. */
export function tokenize(text: string, path = ""): Token[] {
  const tokens: Token[] = [];
  const source = stripCode(text, path);
  let line = 1;
  let cursor = 0;

  for (const match of source.matchAll(TOKEN_RE)) {
    const position = match.index ?? 0;
    for (let scan = cursor; scan < position; scan += 1) {
      if (source[scan] === "\n") line += 1;
    }
    cursor = position;
    tokens.push({ value: match[0], line });
  }

  return tokens;
}
