/**
 * An error that is safe to show to the user without a stack trace.
 */
export class PilotError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, options: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = "PilotError";
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

export function toPilotError(error: unknown): PilotError {
  if (error instanceof PilotError) return error;
  if (error instanceof Error) return new PilotError(error.message);
  return new PilotError(String(error));
}
