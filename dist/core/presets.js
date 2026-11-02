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
    preset("next", "Next.js", "App Router: server components, server actions and caching", `
## Rendering and data
- Server Components by default; flag "use client" without a concrete reason.
- Do not fetch in useEffect for data available via server components; move it server-side.
- Flag searchParams and dynamic segment params used without validation.

## Security
- Server Actions must validate input and check auth/ownership; flag blind mutations.
- Flag secrets reaching the client: sensitive values in NEXT_PUBLIC_ vars or client props.
- Flag dangerouslySetInnerHTML on user content; sanitize at the data source.
- Keep middleware lean: it runs on every request.

## Caching and correctness
- Fetch calls state their cache/revalidate strategy where staleness matters.
- Flag hydration mismatches: server/client differences in dates, randomness, locale.
- Use next/image and next/link; flag raw <img> and <a> in app code.
`),
    preset("vue", "Vue", "Vue 3 Composition API components and reactivity", `
## Composition API
- Flag props mutation and v-model on props; props are read-only.
- computed must stay pure; flag side effects inside computed.
- watch needs cleanup and a precise source; flag deep watchers used as a default.

## Reactivity
- Destructuring props loses reactivity; use toRefs where reactivity must survive.
- Flag in-place mutations of non-reactive copies expected to update the view.
- v-for keys must be stable ids, not array index, on reorderable lists.

## Boundaries
- Validate API data at the network layer; components render, they do not fetch-validate.
- Flag direct DOM manipulation that Vue also manages (bound attrs, listeners).
- Keep provide/inject typed; flag untyped injection of app-wide state.
`),
    preset("svelte", "Svelte", "Svelte 5 runes, stores and SSR", `
## Runes and state
- $derived must be pure; flag side effects inside $derived.
- $effect is for synchronizing with the outside world, not for events; flag misuse.
- Flag $effect without cleanup of subscriptions and timers.
- Bindable props must be declared; flag mutating props directly.

## Rendering
- {#each} keys must be stable ids, not index, on reorderable lists.
- Flag store subscriptions that should be $derived, and vice versa.
- Flag reactivity broken by replacing fields of non-reactive objects.

## SSR and boundaries
- Guard browser-only APIs (window, localStorage) in SSR contexts.
- Validate data at the load/network layer; components render, they do not fetch-validate.
`),
    preset("angular", "Angular", "Signals, dependency injection and RxJS", `
## Components and signals
- Use signals (signal/computed/effect) for template state; flag plain mutable fields.
- OnPush by default: flag in-place array mutations that skip change detection.
- effect() is for side effects, not dataflow; flag signal chains hidden in effects.

## Templates and DI
- Prefer inject() over constructor injection; flag services instantiated in components.
- Flag logic in templates that belongs in the component class.
- Flag field injection and mutable service state in request-scoped code.

## RxJS
- Flag subscriptions without takeUntilDestroyed or async pipe management.
- Prefer switchMap for dependent requests; flag nested subscribe calls.
- Share expensive streams with shareReplay when many consumers subscribe.
`),
    preset("typescript", "TypeScript", "Strict type safety across any runtime", `
## Type safety
- Flag \`as any\`, \`@ts-ignore\` without an explanation and implicit any at boundaries.
- Prefer discriminated unions over boolean-flag combinations.
- Flag non-null \`!\` on values that can genuinely be null/undefined at runtime.
- Switch over unions must be exhaustive or safely defaulted.

## Boundaries
- Validate external data (API, env, files) with a schema before use; distrust unknown.
- Prefer \`readonly\` and \`as const\` for data that must not change.
- Flag platform types leaking from untyped interop without explicit narrowing.

## Runtime hygiene
- Flag \`==\` where \`===\` is meant and truthiness checks where 0 or "" are valid.
- async functions must propagate errors; flag swallowed promise rejections.
- Catch clauses narrow \`unknown\` before use; flag \`catch (e: any)\`.
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
    preset("rust", "Rust", "Ownership, Result handling and unsafe discipline", `
## Ownership and errors
- Use Result/Option instead of unwrap/expect outside tests; invariants need a comment.
- Prefer \`?\` propagation; flag match arms that swallow Err silently.
- Flag clones that hide move problems where borrows suffice.

## Safety
- unsafe blocks must carry a safety comment explaining the invariants upheld.
- Flag manual pointer arithmetic and transmute in ordinary code.
- Prefer iterators over index loops; flag slice indexing with computed offsets.

## API
- Public APIs document panic paths; flag unwrap/index/slice panics in library code.
- Public error types implement std::error::Error; flag String errors at API boundaries.
- Flag obvious clippy-level lints introduced by the diff.
`),
    preset("java", "Java", "Services on modern Java and Spring", `
## Errors
- Exceptions carry context; flag catch blocks that swallow, log-and-continue, or return null.
- Use Optional over null returns; flag get() without isPresent/orElse guards.
- Flag catch (Exception/Throwable) without a documented re-throw intent.

## Concurrency
- Shared mutable state needs synchronization; flag racy fields in request-scoped services.
- Use try-with-resources for everything AutoCloseable (streams, connections).
- CompletableFuture chains must handle failures (exceptionally/handle).

## API and data
- Validate at boundaries; flag unvalidated request params reaching queries.
- Flag collect-to-list-then-loop where a single stream pipeline suffices.
- Prefer constructor injection; flag mutable statics and field injection.
`),
    preset("kotlin", "Kotlin", "Idiomatic Kotlin, coroutines and Android", `
## Null safety
- Flag \`!!\` on values that can be null at runtime; prefer safe calls and early returns.
- Java interop boundaries handle platform types explicitly.
- Flag late-initialized state that could be plain nullable or lazy.

## Coroutines
- Structured concurrency: launch in scopes that get cancelled (viewModelScope, lifecycle).
- Every launch/async handles errors; flag fire-and-forget coroutines.
- Flag GlobalScope and runBlocking on production paths; prefer suspend functions.
- Cancellation must be cooperative: flag CPU loops without isActive/ensureActive checks.

## Idiomatic
- Prefer val, data classes, sealed hierarchies and expression bodies.
- Flag Java-style Kotlin: StringBuilder chains, manual getters, platform types leaking.
`),
    preset("csharp", "C# / .NET", "async/await discipline and resource safety", `
## Async
- Flag .Result/.Wait() on tasks: deadlock risk; async all the way.
- Flag async void outside event handlers and fire-and-forget without error handling.
- CancellationToken must flow through every async call chain.

## Resources
- IDisposable needs using/await using; flag undisposed contexts and connections.
- Flag event subscriptions and closures that capture this longer than its lifetime.

## API and types
- Nullable reference types stay on; flag null-forgiving \`!\` where null is possible.
- Validate at boundaries; flag unvalidated input reaching EF/SQL queries.
- Flag double enumeration of IEnumerable; materialize when reused.
`),
    preset("swift", "Swift", "Optionals, structured concurrency and UI state", `
## Optionals and errors
- Force unwrap only with an invariant comment; prefer guard let and nil-coalescing.
- Flag try? that swallows errors silently; handle or propagate instead.

## Concurrency
- Flag mutable shared state crossing concurrency domains; use actors or isolation.
- Prefer async/await over manual queues and locks.
- Long-lived closures and delegates capture [weak self]; flag retain cycles.

## UI and data
- UI state mutates on the main actor; flag background-context updates.
- Prefer Codable models over dictionaries; validate decoded external data.
`),
    preset("php", "PHP", "PHP 8+ services and Laravel", `
## Types and errors
- Declare strict_types; flag missing parameter/return types on public functions.
- Flag catch blocks that swallow; rethrow or log with context.

## Security
- SQL through prepared statements only; flag string-interpolated queries.
- Flag raw $_GET/$_POST/$_SERVER reaching queries or HTML; validate and escape by context.
- Flag unserialize on user input and any eval usage.

## Laravel
- N+1: flag relation loops without eager loading.
- Validate via FormRequest; flag mass assignment without \$fillable.
- Migrations safe for production: chunk big tables, avoid destructive one-step DDL.
`),
    preset("ruby", "Ruby / Rails", "Rails services, queries and migrations", `
## Errors
- Never rescue Exception; flag rescue without an error class.
- Flag swallowed errors; raise specific errors with context over nil returns.

## Rails
- Strong params on every controller; flag params[:x] used raw.
- N+1: flag association loops without includes/preload; prefer batch finders.
- Migrations safe for production: flag renames/removals without a two-step plan.

## Idiomatic
- Prefer each/map over for loops; early returns over nested conditionals.
- Do not mutate frozen constants; keep structured logging free of secrets.
`),
    preset("security", "Security", "Cross-stack hardening rules, combine with a stack preset", `
## Injection
- Parameterized queries only; flag string-built SQL and ORM filters from user input.
- Shell calls take argument arrays, never interpolated strings; flag unsanitized paths.
- Escape output by context: HTML, attributes, URLs, SQL, shell.

## Auth and crypto
- Flag mutations missing an auth check and IDOR (ownership) risks on id-addressed data.
- Compare secrets with constant-time APIs; never log tokens or password fields.
- Crypto via vetted libraries; flag hand-rolled hashing or encoding labeled as crypto.
- New dependencies get a provenance check: right repo, no typosquats, lockfile pinned.

## Data exposure
- Flag secrets in code, config, logs, errors, client bundles and test fixtures.
- Validate size and content of uploads; flag user input reaching eval or exec.
`),
    preset("devops", "DevOps", "Dockerfiles, CI workflows and infrastructure", `
## Dockerfiles
- Pin base images to digests or minor versions; flag :latest.
- Multi-stage builds; flag toolchains shipped in runtime images.
- Non-root USER, minimal EXPOSE, no secrets in ENV or layers.
- .dockerignore excludes .git, dependencies and local env files.

## CI workflows
- Pin actions to commit SHAs; flag floating tags on security-relevant steps.
- Least-privilege tokens (permissions:); flag secret leaks to forks or logs.
- Flag secrets echoed to logs or passed into untrusted scripts.

## Infrastructure
- Terraform/Kubernetes: flag resources without explicit limits and security contexts.
- Destructive steps (delete, force-push) need an explicit guard or manual gate.
`),
];
export function presetIds() {
    return PRESETS.map((preset) => preset.id);
}
export function getPreset(id) {
    return PRESETS.find((preset) => preset.id === id);
}
const PRESET_SEPARATOR = "\n---\n\n";
/**
 * Combines several presets into one rules document for comma-separated
 * `--preset a,b`. The common header appears once; bodies are joined with
 * horizontal rules so each stack keeps its own section.
 */
export function combinePresets(items) {
    const bodies = items.map((item) => item.rules.slice(COMMON_HEAD.length));
    return `${COMMON_HEAD}${bodies.join(PRESET_SEPARATOR)}`;
}
//# sourceMappingURL=presets.js.map