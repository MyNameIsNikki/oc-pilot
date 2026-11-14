# AGENTS.md

## Project

oc-pilot is an offline CLI for reviewing, testing and shipping code changes. It also exposes the same capabilities through an MCP server.

## Stack and constraints

- Node.js 22 or newer, TypeScript ESM, zero runtime dependencies.
- `dist/` is committed and must stay in sync with `src/`.
- User-facing CLI text is Russian. `README.md` and `README.ru.md` are kept in sync.
- Do not add emojis to the README.
- Never print, commit or reuse secrets or tokens.

## Commands

- Type check: `npm run check`
- Build: `npm run build`
- Full test suite: `npm test` (runs the compiled `dist/**/*.test.js`; build first)
- Run the local CLI: `node dist/cli.js <command>`
- Gate a change: `node dist/cli.js preflight --staged --no-tests --no-slop`
- Prove a change: `node dist/cli.js receipt --staged`

## Release checklist

1. Bump the version in `package.json`, `src/version.ts` and both `package-lock.json` version fields.
2. Add a `CHANGELOG.md` section and sweep the pinned version in `README.md`, `README.ru.md`, `docs/integrations.md` and the skill files.
3. Run `npm run check`, `npm run build`, the full `npm test`, and preflight.
4. Commit, tag, push `main` and the tag, then verify the GitHub release and the npm package with a fresh install.

## Rules

- Run the gate before reporting work as done.
- Do not lower a threshold or disable a check just to get a pass.
- Keep the diff inside the task scope.
