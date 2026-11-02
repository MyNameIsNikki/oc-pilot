const COMMON_HEAD = `# Project review rules

These rules are injected into every review, test-fix and fix request.
Keep the file short and concrete; long rule files get truncated.

`;
function preset(id, title, description, body) {
    return { id, title, description, rules: `${COMMON_HEAD}${body.trim()}\n` };
}
export const PRESETS = [
    preset("base", "Base", "Minimal language-agnostic starter rules", `
## Correctness
- Flag race conditions, off-by-one errors and incorrect null/undefined handling.
- Flag swallowed errors: empty catch blocks, \`catch {}\` without logging or rethrow.
- Flag dead branches and unreachable code after return/throw.

## Security
- Flag injection risks: string-built SQL, shell commands, HTML and eval usage.
- Flag unvalidated external input crossing trust boundaries without checks.
- Flag hardcoded credentials, tokens and private keys.

## Maintainability
- Flag functions longer than ~80 lines or with deeply nested conditionals (3+ levels).
- Flag duplicated logic that appears three or more times.
- Flag misleading names: a function that does something other than its name says.
`),
    preset("node", "Node.js / TypeScript", "Backend services, CLIs and libraries on modern Node", `
## Async and errors
- Always await or explicitly handle promises; flag floating promises and missing .catch.
- Flag sync APIs in hot paths: readFileSync, existsSync in request handlers.
- Wrap async route handlers so rejections reach the error middleware.
- Use structured errors with codes; never throw plain strings.

## APIs and data
- Validate and normalize all external input at the boundary; distrust it downstream.
- Flag unbounded queries and missing pagination on collection endpoints.
- Prefer explicit typed schemas over \`any\`; flag \`as any\` casts and non-null \`!\` chains.

## Operations
- Fail fast on misconfiguration at startup, not on first request.
- Log with context (request id, user id); never log secrets or full payloads.
- Respect timeouts on every outbound call: fetch, DB, message queues.
- Flag missing cleanup: open handles, timers, listeners after shutdown.
`),
    preset("react", "React", "React 18+ components, hooks and state management", `
## Hooks
- Every effect dependency must be intentional; flag missing deps and stale closures.
- Flag derived state stored in useState that should be computed during render.
- Prefer useReducer or external stores over chains of inter-dependent useState.
- Flag effects that duplicate what event handlers should do.

## Rendering
- Keys must be stable ids; flag array-index keys on reorderable lists.
- Flag state updates that mutate objects or arrays in place.
- Flag expensive computations in render without useMemo only when measurable.
- Accessible by default: label inputs, keep keyboard handlers, alt non-decorative images.

## Boundaries
- Validate data at the network layer; components render, they do not fetch-validate.
- Flag direct DOM manipulation that React also manages (className, styles, listeners).
- Colocate styles and types with the component; flag cross-importing internals.
`),
    preset("python", "Python", "Python 3.10+ services, scripts and libraries", `
## Typing and contracts
- Public functions carry type hints; flag untyped boundaries of modules.
- Prefer dataclasses or pydantic models over dicts for structured data.
- Flag bare except and except Exception without re-raise or log; never swallow KeyboardInterrupt.

## Correctness
- Use context managers for files, sockets, locks and DB transactions.
- Flag mutable default arguments (\`def f(x=[])\`).
- Prefer pathlib over string path concatenation.
- Flag f-string SQL and subprocess calls built from untrusted input; use parameters.

## Style
- Prefer comprehensions and early returns over nested loops and flags.
- Flag wildcard imports and unused imports left in the diff.
- Enums and constants instead of magic strings repeated across files.
`),
    preset("go", "Go", "Go services and CLIs", `
## Errors
- Always check returned errors; flag \`_\` assignments of err.
- Wrap with context: fmt.Errorf("doing x: %w", err); never lose the chain.
- Do not log and return the same error; pick one per call path.

## Concurrency
- Every goroutine must have a termination path; flag leaks in loops and handlers.
- Flag unreleased mutexes, tickers and contexts without defer cancel.
- Channels: know who closes; flag close from the receiver side.
- Respect context.Context: pass it down, abort on ctx.Done().

## Correctness
- Flag range-loop variable capture in goroutines and closures.
- Defer close on every resource acquired (files, rows, response bodies).
- Flag ignored return values of fmt.Fprintf-style writers where errors matter.
- Keep structs narrow; flag exported fields that leak internal state.
`),
];
export function presetIds() {
    return PRESETS.map((preset) => preset.id);
}
export function getPreset(id) {
    return PRESETS.find((preset) => preset.id === id);
}
//# sourceMappingURL=presets.js.map