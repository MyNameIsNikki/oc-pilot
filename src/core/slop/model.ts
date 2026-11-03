/** Categories of repository entropy that the slop index measures. */
export type SlopCategoryId = "duplicates" | "deadExports" | "churn" | "todos";

export interface SourceFile {
  /** Repository-relative path with forward slashes. */
  path: string;
  text: string;
}

export interface DuplicatePair {
  first: { file: string; line: number };
  second: { file: string; line: number };
  /** Approximate number of identical tokens in the block. */
  tokens: number;
}

export interface DeadExport {
  file: string;
  line: number;
  name: string;
  kind: string;
}

export interface ChurnFile {
  file: string;
  commits: number;
  days: number;
  /** Commits in the window that also touched a test file. */
  testCommits: number;
}

export interface TodoItem {
  file: string;
  line: number;
  text: string;
  /** Age of the line in days, when git blame could tell. */
  ageDays?: number;
}

export interface SlopCategory {
  id: SlopCategoryId;
  label: string;
  score: number;
  max: number;
  metric: string;
}

export interface SlopStats {
  filesScanned: number;
  linesScanned: number;
  truncated: boolean;
}

export interface SlopReport {
  index: number;
  grade: string;
  categories: SlopCategory[];
  duplicates: DuplicatePair[];
  deadExports: DeadExport[];
  churn: ChurnFile[];
  todos: TodoItem[];
  stats: SlopStats;
}

/** One commit with the files it touched, used by the churn detector. */
export interface CommitFiles {
  sha: string;
  timestamp: number;
  files: string[];
}

export interface SlopInput {
  files: SourceFile[];
  /** Reference corpus for the dead-export check; defaults to `files`. */
  allFiles?: SourceFile[];
  commits?: CommitFiles[];
  /** Returns the age in days for a line, or undefined when unknown. */
  lineAge?: (file: string, line: number) => number | undefined;
}

export interface SlopOptions {
  /** Items kept per category in the report. */
  limit?: number;
  /** Churn window in days. */
  sinceDays?: number;
  /** Minimum commits before a file counts as churn. */
  minCommits?: number;
}

export interface SlopCategoryDelta {
  id: SlopCategoryId;
  label: string;
  introduced: number;
  removed: number;
}

export interface SlopDelta {
  base: string;
  index: number;
  deltaPoints: number;
  categories: SlopCategoryDelta[];
  introduced: number;
  removed: number;
}
