/**
 * Agent rules awareness: projects increasingly keep agent instructions in
 * AGENTS.md / CLAUDE.md and friends. When present, they are injected into
 * review context so the reviewer enforces the same conventions the coding
 * agent was told to follow.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { truncateText } from "./diff.js";
export const AGENT_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
];
const MAX_AGENT_RULES_CHARS = 10_000;
/** Finds the first agent-instruction file in the project root, if any. */
export function findAgentRules(cwd) {
    for (const name of AGENT_RULE_FILES) {
        const path = join(cwd, name);
        try {
            if (!existsSync(path) || !statSync(path).isFile())
                continue;
            const raw = readFileSync(path, "utf8");
            const truncated = raw.length > MAX_AGENT_RULES_CHARS;
            return { path, text: truncated ? truncateText(raw, MAX_AGENT_RULES_CHARS, { mode: "head" }).text : raw, truncated };
        }
        catch {
            continue;
        }
    }
    return undefined;
}
//# sourceMappingURL=agent-rules.js.map