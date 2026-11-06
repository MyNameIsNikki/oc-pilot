import { readRepository } from "./slop/collect.js";
import { analyzeRepository } from "./slop/index.js";
import { scanSource, type SastSeverity } from "./sast.js";

export type BountyReasonKind = "sast" | "duplicate" | "dead-export" | "todo" | "churn";

export interface BountyReason {
  kind: BountyReasonKind;
  weight: number;
  detail: string;
}

export interface BountyCandidate {
  file: string;
  score: number;
  reasons: BountyReason[];
}

export interface BountyReport {
  file: string | null;
  score: number;
  candidates: BountyCandidate[];
  poster: string;
  scannedFiles: number;
  sinceDays: number;
}

export interface BountyOptions {
  limit?: number;
  sinceDays?: number;
}

const SAST_WEIGHT: Record<SastSeverity, number> = { high: 5, medium: 3, low: 1 };

interface MutableCandidate {
  file: string;
  score: number;
  reasons: BountyReason[];
}

function candidate(map: Map<string, MutableCandidate>, file: string): MutableCandidate {
  const existing = map.get(file);
  if (existing) return existing;
  const created: MutableCandidate = { file, score: 0, reasons: [] };
  map.set(file, created);
  return created;
}

function add(map: Map<string, MutableCandidate>, file: string, reason: BountyReason): void {
  const entry = candidate(map, file);
  entry.score += reason.weight;
  entry.reasons.push(reason);
}

/** Ranks files by the mess they carry: security findings, duplication, dead code, TODOs and churn. */
export function buildBounty(cwd: string, options: BountyOptions = {}): BountyReport {
  const limit = Math.min(20, Math.max(1, options.limit ?? 5));
  const sinceDays = Math.min(365, Math.max(1, options.sinceDays ?? 30));
  const slop = analyzeRepository(cwd, { sinceDays, blame: true, limit: 500 });

  const scores = new Map<string, MutableCandidate>();

  for (const file of slop.duplicates) {
    for (const side of [file.first, file.second]) {
      add(scores, side.file, {
        kind: "duplicate",
        weight: 3,
        detail: `дубликат блока (${String(file.tokens)} токенов)`,
      });
    }
  }

  for (const dead of slop.deadExports) {
    add(scores, dead.file, {
      kind: "dead-export",
      weight: 2,
      detail: `мёртвый экспорт ${dead.name}`,
    });
  }

  for (const todo of slop.todos) {
    const age = todo.ageDays ?? 0;
    const weight = 1 + Math.min(3, Math.floor(age / 30));
    add(scores, todo.file, {
      kind: "todo",
      weight,
      detail: `TODO${age > 0 ? ` возрастом ${String(age)} дн.` : ""}: ${todo.text.slice(0, 80)}`,
    });
  }

  for (const churn of slop.churn) {
    if (churn.commits < 5) continue;
    add(scores, churn.file, {
      kind: "churn",
      weight: Math.min(5, Math.floor(churn.commits / 5)),
      detail: `${String(churn.commits)} коммитов без достаточного числа тестов`,
    });
  }

  let scannedFiles = 0;
  try {
    const repository = readRepository(cwd).files;
    scannedFiles = repository.length;
    for (const file of repository) {
      for (const finding of scanSource(file.path, file.text).findings) {
        add(scores, finding.file, {
          kind: "sast",
          weight: SAST_WEIGHT[finding.severity],
          detail: `${finding.severity}: ${finding.rule} в строке ${String(finding.line)}`,
        });
      }
    }
  } catch {
    // The poster still works from the slop data when sources cannot be read.
  }

  const candidates = [...scores.values()]
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit);

  const worst = candidates[0];
  const report: BountyReport = {
    file: worst?.file ?? null,
    score: worst?.score ?? 0,
    candidates,
    poster: "",
    scannedFiles,
    sinceDays,
  };
  report.poster = renderPoster(report);
  return report;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

export function renderPoster(report: BountyReport): string {
  const lines = [
    "+--------------------------------------------------------------+",
    "|                         W A N T E D                          |",
    "+--------------------------------------------------------------+",
  ];
  if (!report.file) {
    lines.push("|  Ни один файл не попал в розыск. Пока чисто.                 |");
    lines.push("+--------------------------------------------------------------+");
    return `${lines.join("\n")}\n`;
  }

  lines.push(`|  ${pad(report.file, 58)}|`);
  lines.push(`|  ${pad(`Награда: ${String(report.score)} очков позора`, 58)}|`);
  lines.push("+--------------------------------------------------------------+");
  for (const reason of report.candidates[0]!.reasons.slice(0, 6)) {
    lines.push(`|  ${pad(`- ${reason.detail}`, 58)}|`);
  }
  lines.push("+--------------------------------------------------------------+");
  if (report.candidates.length > 1) {
    const others = report.candidates
      .slice(1, 4)
      .map((entry) => `${entry.file} (${String(entry.score)})`)
      .join(", ");
    lines.push(`|  ${pad(`Сообщники: ${others}`, 58)}|`);
    lines.push("+--------------------------------------------------------------+");
  }
  return `${lines.join("\n")}\n`;
}

export function describeBounty(report: BountyReport): string {
  if (!report.file) {
    return `Розыск не требуется: ${String(report.scannedFiles)} файл(ов) проверено.`;
  }
  return `Худший файл: ${report.file} (${String(report.score)} очков, ${String(report.candidates[0]!.reasons.length)} причин).`;
}
