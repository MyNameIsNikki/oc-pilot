import { PilotError } from "./errors.js";

export type ArgsValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

export function asString(values: ArgsValues, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PilotError(`Опция --${key} ожидает значение`, { exitCode: 2 });
  }
  return value;
}

export function asBoolean(values: ArgsValues, key: string): boolean {
  return values[key] === true;
}

export function parseSize(raw: string, flag: string): number {
  const match = /^(\d+(?:[.,]\d+)?)\s*(b|k|kb|kib|m|mb|mib)?$/i.exec(raw.trim());
  if (!match) {
    throw new PilotError(`Некорректное значение --${flag}: ${raw}`, {
      hint: "Используйте число с суффиксом k или m, например 120k.",
      exitCode: 2,
    });
  }
  const value = Number(match[1]!.replace(",", "."));
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "m" || unit === "mb" || unit === "mib" ? 1_000_000 : unit === "b" ? 1 : 1_000;
  const result = Math.round(value * multiplier);
  if (!Number.isFinite(result) || result < 1) {
    throw new PilotError(`Некорректное значение --${flag}: ${raw}`, { exitCode: 2 });
  }
  return result;
}

export function parseSeconds(raw: string, flag: string): number {
  const match = /^(\d+(?:[.,]\d+)?)\s*(s|sec|m|min)?$/i.exec(raw.trim());
  if (!match) {
    throw new PilotError(`Некорректное значение --${flag}: ${raw}`, {
      hint: "Используйте секунды (300) или длительность (5m).",
      exitCode: 2,
    });
  }
  const value = Number(match[1]!.replace(",", "."));
  const unit = (match[2] ?? "s").toLowerCase();
  const seconds = unit === "m" || unit === "min" ? value * 60 : value;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new PilotError(`Некорректное значение --${flag}: ${raw}`, { exitCode: 2 });
  }
  return Math.round(seconds);
}

export function parsePositiveInt(raw: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new PilotError(`Некорректное значение --${flag}: ${raw}`, { exitCode: 2 });
  }
  return value;
}
