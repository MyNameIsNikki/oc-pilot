# Growth playbook

How to take `oc-pilot` from "few npm downloads" to a tool developers recognise.

## Positioning

One sentence, repeated everywhere:

> oc-pilot is the flight recorder and proof layer for coding agents: it records what an agent did, and proves whether a claimed fix actually fixes anything.

Supporting line for README and npm:

> Local, zero-dependency CLI for OpenCode, Claude Code, Codex, Cursor and Gemini CLI.

Avoid "AI code review" as the headline: the category is crowded and undifferentiated.

## Audiences

1. **Agent users** who ship code they did not fully read. They want proof, not more lint.
2. **Agent builders** who need a verifier and an MCP server in their loop.
3. **Teams** that must audit agent changes (security, compliance, postmortems).

## Channels, ranked by expected return

### 1. Agent and MCP registries (highest return)

Being listed where agents look for tools beats any single post.

- OpenCode plugins and skills registry.
- Claude Code plugin and MCP marketplaces.
- Cursor MCP directory.
- Codex and Gemini CLI extension lists.
- `modelcontextprotocol/servers` community list.
- `punkpeye/awesome-mcp-servers`.

Deliverable per registry: name, one-line description, install command, tool list, link to `docs/integrations.md`.

### 2. GitHub surface

- Repository description: the positioning sentence.
- Topics: `ai-agents`, `coding-agent`, `mcp`, `code-review`, `verification`, `flight-recorder`, `devtools`, `cli`, `typescript`, `llm`.
- README first screen: what it is, one command, one recorded demo.
- `llms.txt` at the root so assistants can describe the project correctly.
- Pinned issue: "What oc-pilot is and is not".

### 3. Awesome lists and directories

`awesome-cli-apps`, `awesome-devtools`, `awesome-ai-agents`, `awesome-nodejs` (if criteria fit), `awesome-testing`, `awesome-static-analysis`, Product Hunt, AlternativeTo, SaaSHub, LibHunt.

Rules: read the contribution guide, one PR per list, no marketing language.

### 4. Communities

- Hacker News: Show HN with a recorded terminal demo, posted Tuesday to Thursday morning US time.
- Reddit: r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA (only if relevant), r/ExperiencedDevs (careful, no promotion tone).
- Discord and Slack communities of OpenCode, Cursor, Claude Code.
- Lobsters and dev.to for the technical write-up.

### 5. Content that gets cited

- "We ran N agent PRs through a verifier: X% of 'fixes' did not reproduce the bug" — data post with the script and raw output.
- Comparison pages: `oc-pilot vs <tool>` for review, test triage, flight recording.
- How-to pages answering exact queries: "how to verify an AI agent fixed a bug", "how to record a coding agent session", "MCP server for code review".
- Each page: one question in the title, a direct answer in the first paragraph, a command that reproduces it.

### 6. Release cadence as content

- Public changelog page generated from `CHANGELOG.md`.
- Automatic post per release to X, Bluesky, LinkedIn, Telegram.
- Monthly digest: what shipped, what users asked for, what changed in the agent ecosystem.

## Launch sequence

T-7 days:

- English README first screen, demo recording, badges.
- npm description and keywords final.
- `llms.txt` and docs pages live.
- Registry submissions prepared (one per registry).

T-0:

- Show HN post.
- Reddit posts (staggered by a day).
- X/Bluesky thread with the demo.
- Product Hunt launch scheduled.

T+1 to T+7:

- Reply to every comment within a few hours.
- Publish the data post.
- Submit to awesome lists.
- Follow up with communities that engaged.

## Metrics

- npm downloads per week (lagging indicator, do not optimise directly).
- GitHub stars and unique visitors (leading).
- Install to first successful command (activation) — instrument via opt-in ping.
- Which commands are actually used, so the roadmap is data-driven.
- Referrers: registries, HN, Reddit, LLM answers.

## Copy blocks

One-liner, English:

> Record what your coding agent did, and prove the fix is real.

One-liner, Russian:

> Записывай, что сделал агент, и доказывай, что фикс настоящий.

Show HN title:

> Show HN: oc-pilot – flight recorder and proof layer for coding agents

Reddit post skeleton:

1. Problem: agents claim "fixed", tests written afterwards pass trivially.
2. What I built: a local journal with checkpoints plus a verifier that requires fail-before and pass-after.
3. Demo: one command, one recorded transition.
4. What I want: feedback on the proof format and the MCP interface.

## Non-goals

- Do not buy stars or downloads.
- Do not post the same text across communities.
- Do not lead with feature lists; lead with the failure mode being fixed.
