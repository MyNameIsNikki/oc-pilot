const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function paint(code: string, value: string): string {
  return useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
}

export const color = {
  bold: (value: string): string => paint("1", value),
  dim: (value: string): string => paint("2", value),
  red: (value: string): string => paint("31", value),
  green: (value: string): string => paint("32", value),
  yellow: (value: string): string => paint("33", value),
  blue: (value: string): string => paint("34", value),
  cyan: (value: string): string => paint("36", value),
};

function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

export const log = {
  step(message: string): void {
    write(color.cyan("→ ") + message);
  },
  info(message: string): void {
    write(color.blue("i ") + message);
  },
  success(message: string): void {
    write(color.green("✔ ") + message);
  },
  warn(message: string): void {
    write(color.yellow("! ") + message);
  },
  error(message: string): void {
    write(color.red("✖ ") + message);
  },
  detail(message: string): void {
    write(color.dim(`  ${message}`));
  },
  blank(): void {
    write("");
  },
};
