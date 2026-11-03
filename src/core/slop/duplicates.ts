import type { DuplicatePair, SourceFile } from "./model.js";
import { tokenize } from "./source.js";

/** Window length in tokens. Short windows match by accident. */
const WINDOW = 18;
const MIN_DISTINCT_RATIO = 0.45;
const MIN_IDENTIFIERS = 5;
const MAX_TOKENS_PER_FILE = 20_000;
const MAX_OCCURRENCES = 8;
const MAX_HITS = 20_000;
const MAX_BLOCKS = 200;
/** One window (18 tokens) is too easy to match; require a real block (72). */
const MIN_BLOCK_TOKENS = 72;

function slash(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Lines that only move symbols around; they duplicate everywhere. */
function importLines(text: string): Set<number> {
  const lines = new Set<number>();
  text.split("\n").forEach((line, index) => {
    if (/^\s*(?:import|export)\b.*\bfrom\b|^\s*import\s/.test(line)) lines.add(index + 1);
  });
  return lines;
}

function hashWindow(tokens: Array<{ value: string }>): number {
  let hash = 2166136261;
  for (const token of tokens) {
    for (let index = 0; index < token.value.length; index += 1) {
      hash ^= token.value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

interface Hit {
  a: string;
  al: number;
  b: string;
  bl: number;
  /** Hash of the first window: identifies the duplicated content itself. */
  hash: number;
}

/**
 * Finds blocks of at least {@link WINDOW} identical tokens that appear in two
 * different files. Comments, strings and import lines are ignored, so the
 * result tracks real copy-paste rather than boilerplate.
 */
export function findDuplicates(files: SourceFile[], maxBlocks = MAX_BLOCKS): DuplicatePair[] {
  if (files.length < 2) return [];

  const buckets = new Map<number, Array<{ file: string; line: number }>>();

  for (const file of files) {
    const path = slash(file.path);
    const skip = importLines(file.text);
    const tokens = tokenize(file.text, path)
      .filter((token) => !skip.has(token.line))
      .slice(0, MAX_TOKENS_PER_FILE);
    if (tokens.length < WINDOW) continue;

    for (let index = 0; index + WINDOW <= tokens.length; index += 1) {
      const window = tokens.slice(index, index + WINDOW);
      const distinct = new Set(window.map((token) => token.value)).size;
      if (distinct < WINDOW * MIN_DISTINCT_RATIO) continue;

      let identifiers = 0;
      for (const token of window) {
        if (/^[A-Za-z_$]/.test(token.value) && token.value.length >= 3) identifiers += 1;
      }
      if (identifiers < MIN_IDENTIFIERS) continue;

      const hash = hashWindow(window);
      const line = window[0]!.line;
      const bucket = buckets.get(hash);
      if (!bucket) {
        buckets.set(hash, [{ file: path, line }]);
        continue;
      }
      if (bucket.length >= MAX_OCCURRENCES) continue;
      // Neighbouring windows of the same block must not flood the bucket.
      if (bucket.some((entry) => entry.file === path && Math.abs(entry.line - line) <= 2)) continue;
      bucket.push({ file: path, line });
    }
  }

  const hits: Hit[] = [];
  for (const [hash, bucket] of buckets) {
    if (bucket.length < 2) continue;
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const first = bucket[left]!;
        const second = bucket[right]!;
        if (first.file === second.file) continue;
        if (first.file < second.file) {
          hits.push({ a: first.file, al: first.line, b: second.file, bl: second.line, hash });
        } else {
          hits.push({ a: second.file, al: second.line, b: first.file, bl: first.line, hash });
        }
        if (hits.length >= MAX_HITS) break;
      }
      if (hits.length >= MAX_HITS) break;
    }
    if (hits.length >= MAX_HITS) break;
  }

  hits.sort((x, y) => {
    if (x.a !== y.a) return x.a < y.a ? -1 : 1;
    if (x.b !== y.b) return x.b < y.b ? -1 : 1;
    return x.al - y.al;
  });

  const merged: Array<{ block: DuplicatePair; hash: number }> = [];
  let lastHit: Hit | undefined;
  for (const hit of hits) {
    const current = merged[merged.length - 1];
    if (
      current &&
      lastHit &&
      current.block.first.file === hit.a &&
      current.block.second.file === hit.b &&
      Math.abs(lastHit.al - hit.al) <= 2 &&
      Math.abs(lastHit.bl - hit.bl) <= 2
    ) {
      current.block.tokens += WINDOW;
      lastHit = hit;
      continue;
    }
    merged.push({
      block: {
        first: { file: hit.a, line: hit.al },
        second: { file: hit.b, line: hit.bl },
        tokens: WINDOW,
      },
      hash: hit.hash,
    });
    lastHit = hit;
  }

  merged.sort(
    (x, y) =>
      y.block.tokens - x.block.tokens ||
      x.block.first.file.localeCompare(y.block.first.file) ||
      x.block.first.line - y.block.first.line,
  );

  // One block copied into five commands produces ten file pairs. Report and
  // count each distinct chunk of text once, keeping the longest merge.
  const kept: DuplicatePair[] = [];
  const seen = new Set<number>();
  for (const item of merged) {
    if (item.block.tokens < MIN_BLOCK_TOKENS) continue;
    if (seen.has(item.hash)) continue;
    seen.add(item.hash);
    kept.push(item.block);
    if (kept.length >= maxBlocks) break;
  }

  return kept;
}
