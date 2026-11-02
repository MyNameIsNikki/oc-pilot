import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentDefinition } from "../dist/core/opencode.js";
import { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_RU } from "../dist/core/prompt.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const definition = buildAgentDefinition(SYSTEM_PROMPT_EN, true);
const permissions = definition.permissions
  .map((rule) => `  - action: "${rule.action}"\n    resource: "${rule.resource}"\n    effect: ${rule.effect}`)
  .join("\n");
const frontmatter = `---
description: ${definition.description}
mode: primary
steps: ${definition.steps}
permissions:
${permissions}
---
`;

mkdirSync(join(root, "prompts"), { recursive: true });
writeFileSync(join(root, "prompts", "oc-pilot.en.md"), `${SYSTEM_PROMPT_EN}\n`, "utf8");
writeFileSync(join(root, "prompts", "oc-pilot.ru.md"), `${SYSTEM_PROMPT_RU}\n`, "utf8");

mkdirSync(join(root, ".opencode", "agents"), { recursive: true });
writeFileSync(join(root, ".opencode", "agents", "oc-pilot.md"), `${frontmatter}\n${SYSTEM_PROMPT_EN}\n`, "utf8");

process.stdout.write("Exported prompts/oc-pilot.en.md, prompts/oc-pilot.ru.md and .opencode/agents/oc-pilot.md\n");
