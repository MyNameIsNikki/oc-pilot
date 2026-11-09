import { runShellCommand } from "./command.js";
import { PilotError } from "./errors.js";
import { runGit } from "./git.js";
import { createShadow, writeShadowDiff } from "./shadow.js";

export type HemorrhageMetric = "time" | "stdout";
export type HemorrhageDirection = "lower" | "higher";
export type HemorrhageStatus = "regression" | "improvement" | "same" | "error";

export interface HemorrhageStats {
  runs: number;
  median: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  mad: number;
}

export interface HemorrhageReport {
  status: HemorrhageStatus;
  metric: HemorrhageMetric;
  direction: HemorrhageDirection;
  before: HemorrhageStats;
  after: HemorrhageStats;
  changePct: number;
  pValue: number;
  noisePct: number;
  thresholdPct: number;
  summary: string;
  content: string;
}

export interface HemorrhageOptions {
  command: string;
  metric?: HemorrhageMetric;
  direction?: HemorrhageDirection;
  runs?: number;
  warmup?: number;
  thresholdPct?: number;
  timeoutMs?: number;
}

const DEFAULT_RUNS = 10;
const MAX_RUNS = 50;
const DEFAULT_WARMUP = 2;
const DEFAULT_THRESHOLD_PCT = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

function sorted(values: number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const data = sorted(values);
  const middle = Math.floor(data.length / 2);
  if (data.length % 2 === 1) return data[middle]!;
  return (data[middle - 1]! + data[middle]!) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const data = sorted(values);
  const rank = Math.max(0, Math.min(1, p)) * (data.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return data[lower]!;
  const weight = rank - lower;
  return data[lower]! * (1 - weight) + data[upper]! * weight;
}

export function summarize(values: number[]): HemorrhageStats {
  const med = median(values);
  const deviations = values.map((value) => Math.abs(value - med));
  return {
    runs: values.length,
    median: med,
    p95: percentile(values, 0.95),
    mean: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
    min: values.length === 0 ? 0 : Math.min(...values),
    max: values.length === 0 ? 0 : Math.max(...values),
    mad: median(deviations),
  };
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function ranks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const result = new Array<number>(values.length).fill(0);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1]!.value === order[position]!.value) end += 1;
    const average = (position + end) / 2 + 1;
    for (let index = position; index <= end; index += 1) result[order[index]!.index] = average;
    position = end + 1;
  }
  return result;
}

/** Mann-Whitney U with a normal approximation; returns a two-sided p-value. */
export function mannWhitney(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) return 1;
  const combined = [...left, ...right];
  const allRanks = ranks(combined);
  const leftRank = allRanks.slice(0, left.length).reduce((sum, value) => sum + value, 0);
  const n1 = left.length;
  const n2 = right.length;
  const u1 = leftRank - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);
  const mean = (n1 * n2) / 2;
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  if (sd === 0) return 1;
  const z = (u - mean) / sd;
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))));
}

function parseNumber(output: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(output);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function applyPatch(dir: string, patch: string): void {
  const temp = writeShadowDiff(patch);
  try {
    const check = runGit(["apply", "--check", temp.path], dir);
    if (check.status !== 0) {
      throw new PilotError("Diff не применился в shadow worktree", {
        hint: check.stderr.trim() || check.stdout.trim() || undefined,
        exitCode: 2,
      });
    }
    const applied = runGit(["apply", temp.path], dir);
    if (applied.status !== 0) {
      throw new PilotError("Не удалось применить diff в shadow worktree", {
        hint: applied.stderr.trim() || applied.stdout.trim() || undefined,
        exitCode: 2,
      });
    }
  } finally {
    temp.cleanup();
  }
}

async function measure(
  dir: string,
  options: Required<Pick<HemorrhageOptions, "command" | "metric" | "timeoutMs">>,
): Promise<number> {
  const run = await runShellCommand(options.command, dir, {
    timeoutMs: options.timeoutMs,
    maxBufferChars: 1_000_000,
  });
  if (run.timedOut) {
    throw new PilotError("Бенчмарк не завершился по таймауту", { exitCode: 2 });
  }
  if (run.exitCode !== 0) {
    throw new PilotError(`Бенчмарк завершился с кодом ${String(run.exitCode)}`, {
      hint: run.output.trim().slice(-500) || undefined,
      exitCode: 2,
    });
  }
  if (options.metric === "stdout") {
    const value = parseNumber(run.output);
    if (value === undefined) {
      throw new PilotError("Не удалось разобрать число из stdout бенчмарка", {
        hint: "Печатайте одно число, например 123.4.",
        exitCode: 2,
      });
    }
    return value;
  }
  return run.durationMs;
}

/** Measures HEAD and the diff on the same benchmark and tests the difference. */
export async function runHemorrhage(
  cwd: string,
  diff: string,
  options: HemorrhageOptions,
): Promise<HemorrhageReport> {
  const metric = options.metric ?? "time";
  const direction = options.direction ?? "lower";
  const runs = Math.max(3, Math.min(MAX_RUNS, options.runs ?? DEFAULT_RUNS));
  const warmup = Math.max(0, Math.min(10, options.warmup ?? DEFAULT_WARMUP));
  const thresholdPct = Math.max(0, Math.min(100, options.thresholdPct ?? DEFAULT_THRESHOLD_PCT));
  const timeoutMs = Math.max(1_000, Math.min(900_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  const head = createShadow(cwd, "hemorrhage-head", "HEAD");
  const changed = createShadow(cwd, "hemorrhage-diff", "HEAD");
  try {
    if (diff.trim()) applyPatch(changed.dir, diff);
    const settings = { command: options.command, metric, timeoutMs };

    for (let index = 0; index < warmup; index += 1) {
      await measure(head.dir, settings);
      await measure(changed.dir, settings);
    }

    const beforeSamples: number[] = [];
    const afterSamples: number[] = [];
    for (let index = 0; index < runs; index += 1) {
      const order = index % 2 === 0 ? [head, changed] : [changed, head];
      for (const tree of order) {
        const value = await measure(tree.dir, settings);
        if (tree === head) beforeSamples.push(value);
        else afterSamples.push(value);
      }
    }

    const before = summarize(beforeSamples);
    const after = summarize(afterSamples);
    const changePct =
      before.median === 0
        ? after.median === 0
          ? 0
          : 100
        : ((after.median - before.median) / before.median) * 100;
    const pValue = mannWhitney(beforeSamples, afterSamples);
    const beforeNoise = before.median === 0 ? 0 : (before.mad / before.median) * 100;
    const afterNoise = after.median === 0 ? 0 : (after.mad / after.median) * 100;
    const noisePct = Math.max(beforeNoise, afterNoise);
    const significant = pValue < 0.05;
    const beyondNoise = Math.abs(changePct) > Math.max(noisePct, 1);
    const worse = direction === "lower" ? changePct > thresholdPct : changePct < -thresholdPct;
    const better = direction === "lower" ? changePct < -thresholdPct : changePct > thresholdPct;
    const status: HemorrhageStatus =
      worse && significant && beyondNoise
        ? "regression"
        : better && significant && beyondNoise
          ? "improvement"
          : "same";

    const changeText = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%`;
    const summary =
      status === "regression"
        ? `[PERFORMANCE REGRESSION]: median ${format(before.median)} -> ${format(after.median)} (${changeText}), p=${pValue.toFixed(3)}, noise=${noisePct.toFixed(1)}%.`
        : status === "improvement"
          ? `[PERFORMANCE IMPROVEMENT]: median ${format(before.median)} -> ${format(after.median)} (${changeText}), p=${pValue.toFixed(3)}, noise=${noisePct.toFixed(1)}%.`
          : `[PERFORMANCE SAME]: median ${format(before.median)} -> ${format(after.median)} (${changeText}), p=${pValue.toFixed(3)}, noise=${noisePct.toFixed(1)}%.`;

    const lines = [
      `Hemorrhage: ${status}`,
      `Metric: ${metric} (${direction} is better)`,
      `Runs: ${String(runs)}, warmup ${String(warmup)}`,
      `Before: median ${format(before.median)}, p95 ${format(before.p95)}, MAD ${format(before.mad)}`,
      `After: median ${format(after.median)}, p95 ${format(after.p95)}, MAD ${format(after.mad)}`,
      `Change: ${changeText}, p=${pValue.toFixed(3)}, noise=${noisePct.toFixed(1)}%, threshold=${String(thresholdPct)}%`,
      "",
      summary,
    ];
    return {
      status,
      metric,
      direction,
      before,
      after,
      changePct,
      pValue,
      noisePct,
      thresholdPct,
      summary,
      content: `${lines.join("\n")}\n`,
    };
  } finally {
    head.cleanup();
    changed.cleanup();
  }
}
