import { PilotError } from "../core/errors.js";
import { log } from "../core/log.js";
import { COMMON_HELP, parseCommandArgs, withCommon, type OptionSpec } from "../core/options.js";
import { asBoolean, asString } from "../core/parse.js";
import { listSnapshots, restoreSnapshot } from "../core/snapshot.js";
import { resolve } from "node:path";

const OPTIONS: OptionSpec = withCommon({
  list: { type: "boolean" },
});

const HELP = `Использование:
  oc-pilot restore [id] [опции]

Восстанавливает рабочее дерево из локального снимка, созданного перед
oc-pilot fix --apply. Снимки хранятся в .git/oc-pilot/snapshots/ и не
попадают в коммиты.

Опции:
      --list                показать доступные снимки
${COMMON_HELP}

Примеры:
  oc-pilot restore            # последний снимок
  oc-pilot restore 20260102-101500-ab12
  oc-pilot restore --list
`;

export async function runRestore(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (asBoolean(values, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const rawCwd = asString(values, "cwd");
  const cwd = rawCwd ? resolve(process.cwd(), rawCwd) : process.cwd();
  if (positionals.length > 1) {
    throw new PilotError("Укажите не более одного id снимка", { exitCode: 2 });
  }

  if (asBoolean(values, "list")) {
    const snapshots = listSnapshots(cwd);
    if (snapshots.length === 0) {
      log.info("Снимков нет.");
      return 0;
    }
    const lines = snapshots.map(
      (snapshot) =>
        `${snapshot.id}  head=${snapshot.head.slice(0, 8)}  untracked=${snapshot.untrackedCount}` +
        `${snapshot.tracked ? "" : "  (без tracked-изменений)"}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  const snapshot = restoreSnapshot(cwd, positionals[0]);
  log.success(
    `Рабочее дерево восстановлено из снимка ${snapshot.id} ` +
      `(untracked: ${snapshot.untrackedCount}${snapshot.tracked ? ", tracked-патч применён" : ""}).`,
  );
  log.detail("Разбиение staged/unstaged не восстанавливается; новые untracked-файлы не удаляются.");
  return 0;
}
