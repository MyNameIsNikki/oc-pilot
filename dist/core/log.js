const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
function paint(code, value) {
    return useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
}
export const color = {
    bold: (value) => paint("1", value),
    dim: (value) => paint("2", value),
    red: (value) => paint("31", value),
    green: (value) => paint("32", value),
    yellow: (value) => paint("33", value),
    blue: (value) => paint("34", value),
    cyan: (value) => paint("36", value),
};
function write(line) {
    process.stderr.write(`${line}\n`);
}
export const log = {
    step(message) {
        write(color.cyan("→ ") + message);
    },
    info(message) {
        write(color.blue("i ") + message);
    },
    success(message) {
        write(color.green("✔ ") + message);
    },
    warn(message) {
        write(color.yellow("! ") + message);
    },
    error(message) {
        write(color.red("✖ ") + message);
    },
    detail(message) {
        write(color.dim(`  ${message}`));
    },
    blank() {
        write("");
    },
};
//# sourceMappingURL=log.js.map