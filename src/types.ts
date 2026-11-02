export type Recipe = "review" | "test-fix" | "docgen" | "custom";

export type PromptLang = "en" | "ru";

export type SecretSeverity = "critical" | "warning";

export type FindingSeverity = "critical" | "warning" | "style";

export type FailOn = "none" | FindingSeverity;

export interface SecretFinding {
  /** Path relative to the analyzed project. */
  file: string;
  /** 1-based line number in the new version of the file. */
  line: number;
  /** Human-readable kind, e.g. "AWS Access Key ID". */
  kind: string;
  severity: SecretSeverity;
  /** Redacted preview. Never contains the full secret. */
  preview: string;
}

export interface AnalysisFinding {
  severity: FindingSeverity;
  /** File:line or symbol from the finding, when present. */
  location?: string;
  text: string;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface ResolvedConfig {
  model?: string;
  agent: string;
  maxDiffChars: number;
  maxOutputChars: number;
  timeoutSeconds: number;
  testCommand?: string;
  redactSecrets: boolean;
  maxFileChars: number;
  /** Allow the built-in agent to inspect the repository with read-only tools. */
  repoContext: boolean;
  /** Fail with exit code 3 when a finding at this level or higher is present. */
  failOn: FailOn;
  /** Optional path to project-specific review rules. */
  rules?: string;
  /** Language of the model-facing system prompt and instructions. */
  lang: PromptLang;
}

export interface ConfigOverrides {
  model?: string;
  agent?: string;
  maxDiffChars?: number;
  maxFileChars?: number;
  timeoutSeconds?: number;
  testCommand?: string;
  repoContext?: boolean;
  failOn?: FailOn;
  rules?: string;
  lang?: PromptLang;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  path?: string;
}

export interface GlobalFlags {
  cwd: string;
  json: boolean;
  dryRun: boolean;
  verbose: boolean;
  strict: boolean;
  github: boolean;
  output?: string;
}

export interface CommandContext {
  cwd: string;
  config: ResolvedConfig;
  configPath?: string;
  flags: GlobalFlags;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  /** Copy of the source with every detected secret replaced by a marker. */
  redacted: string;
}

export interface AnalysisResult {
  text: string;
  sessionID?: string;
  cost?: number;
  durationMs: number;
  stderr: string;
}
