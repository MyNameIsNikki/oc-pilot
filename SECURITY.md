# Security

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use a private GitHub Security Advisory:

https://github.com/MyNameIsNikki/oc-pilot/security/advisories/new

Include the affected version, a minimal reproduction, and the impact. Do not include real API keys, tokens, private keys, or customer data. Replace credentials with synthetic values.

Supported versions: the latest release on npm. Security fixes are released as patch versions.

## Trust model

`oc-pilot` is a local developer tool and a single-tenant MCP server. It is not a multi-user service, a sandbox, or a secret store.

- The CLI reads the project, the diff, and files explicitly passed on the command line. It sends selected content to the OpenCode provider configured by the user.
- The built-in OpenCode agent is read-only: `read`, `glob`, and `grep` are allowed; `edit`, `shell`, web access, and external directories are denied. Sensitive paths such as `.env`, private keys, `.ssh`, `.aws`, and `.git` are denied.
- Secret scanning is best-effort. Findings are redacted before model calls when `redactSecrets` is enabled, but a missed secret is still sent to the provider. Never rely on this as the only control.
- `fix --apply` writes to the working tree. It rejects patches that touch files outside the reviewed diff, checks the patch with `git apply --check`, and reverts it when tests fail unless `--keep-on-test-failure` is used. It never commits or pushes.
- `test-fix` and `fix` run the detected or supplied test command with the user's privileges. Treat the command as code execution.

## MCP server

- stdio is for a local client and inherits the local user's privileges.
- MCP is read-only by default for both stdio and HTTP: `fix apply` and running new test commands are rejected. Use `--allow-write` only for a trusted local client or a trusted, authenticated deployment. Generated `setup` configs stay read-only unless `--allow-write` is passed.
- A non-loopback HTTP bind refuses to start without a token of at least 16 characters. Tokens are compared in constant time. `GET /health` is unauthenticated and returns only status, name, and version.
- MCP path and file arguments are confined to the project directory. `context` is literal text, not an `@file` reference. `base` must be a git ref.
- The server is single-tenant. Do not share one instance between mutually untrusted users or repositories. Run one container per trust boundary.
- Container deployments must mount only the intended workspace and provider credentials. Prefer a read-only mount and `OC_PILOT_MCP_READ_ONLY=true` when writes are not required.
- Put a TLS-terminating reverse proxy in front of any public endpoint, and keep the token out of URLs and logs.

## Supply chain

Releases are published from GitHub Actions with npm provenance (`--provenance`). The package has no runtime dependencies. CI runs type checking, the full test suite, CodeQL, and package-content checks. Dependabot monitors npm, Docker, and GitHub Actions.

Verify a published release:

```bash
npm view oc-pilot@<version> dist.integrity
npm audit signatures
```
