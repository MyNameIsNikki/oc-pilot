# Contributing

## Development

```bash
git clone https://github.com/MyNameIsNikki/oc-pilot.git
cd oc-pilot
npm install
npm run check
npm test
```

Requirements: Node.js 22+, Git, and OpenCode 2.x for live model calls. The test suite uses a fake `opencode` executable and does not need credentials.

## Pull requests

- Keep the CLI and MCP behavior in sync. A new command option usually needs an MCP tool argument.
- Add a regression test for every bug fix. Tests live next to the code in `src/**/*.test.ts`.
- Do not add runtime dependencies without a security and size justification. The package intentionally ships with none.
- Do not log prompts, diffs, tokens, or provider responses in production paths. Use the existing `log` helpers.
- Preserve the bilingual prompt contract. Model-facing English is the default; Russian is selected with `--lang ru`.
- Run `npm run prompt:export` after changing `src/core/prompt.ts`.

## Security-sensitive changes

Changes to secret detection, redaction, the read-only agent permissions, patch application, MCP HTTP authentication, or path confinement need:

- negative tests (what must be rejected);
- updates to `SECURITY.md` when the trust model changes;
- a note in `CHANGELOG.md`.

## Release

Releases are tag-driven. Set `NPM_TOKEN` in GitHub Actions secrets, then:

```bash
npm version patch --no-git-tag-version
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

The release workflow checks that the tag matches `package.json`, runs the full suite, and publishes with npm provenance.
