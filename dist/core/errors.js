/**
 * An error that is safe to show to the user without a stack trace.
 */
export class PilotError extends Error {
    exitCode;
    hint;
    constructor(message, options = {}) {
        super(message);
        this.name = "PilotError";
        this.exitCode = options.exitCode ?? 1;
        this.hint = options.hint;
    }
}
export function toPilotError(error) {
    if (error instanceof PilotError)
        return error;
    if (error instanceof Error)
        return new PilotError(error.message);
    return new PilotError(String(error));
}
//# sourceMappingURL=errors.js.map