import { existsSync } from "node:fs";
import { runGit } from "./git.js";
import { loadLastReview } from "./last-review.js";
import { readReceipt, receiptPath, verifyReceipt } from "./receipt.js";
import { readStats } from "./stats.js";
const DEFAULT_TITLE = "oc-pilot session cinema";
const DAY_MS = 86_400_000;
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function isoAt(ts) {
    return new Date(ts).toISOString();
}
function shortAt(at) {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? at : date.toISOString().replace("T", " ").slice(0, 16);
}
function gitFrames(cwd, sinceMs, noPaths) {
    const result = runGit(["log", `--since=${new Date(sinceMs).toISOString()}`, "--pretty=format:%h%x1f%aI%x1f%s"], cwd);
    if (result.status !== 0)
        return [];
    const frames = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const [hash, at, ...subjectParts] = line.split("\u001f");
        if (!hash || !at)
            continue;
        const subject = subjectParts.join("\u001f").trim();
        frames.push({
            at,
            kind: "commit",
            text: `${hash} ${noPaths ? "(path hidden)" : subject || "commit"}`,
        });
    }
    // git log prints newest first; keep oldest first so a stable sort leaves
    // the newest commit last when timestamps share a second.
    return frames.reverse();
}
function statsFrames(cwd, sinceMs) {
    const records = readStats(cwd);
    const frames = [];
    for (const run of records.runs) {
        if (run.ts < sinceMs)
            continue;
        const findings = run.findings.critical + run.findings.warning + run.findings.style;
        frames.push({
            at: isoAt(run.ts),
            kind: "run",
            text: `${run.recipe} exited ${String(run.exitCode)}${findings > 0 ? `, ${String(findings)} finding(s)` : ""}`,
        });
    }
    const apiByDay = new Map();
    for (const call of records.apiCalls) {
        if (call.ts < sinceMs)
            continue;
        const day = isoAt(call.ts).slice(0, 10);
        const entry = apiByDay.get(day) ?? { calls: 0, cached: 0 };
        entry.calls += 1;
        if (call.cached)
            entry.cached += 1;
        apiByDay.set(day, entry);
    }
    for (const [day, entry] of apiByDay) {
        frames.push({
            at: `${day}T12:00:00.000Z`,
            kind: "api",
            text: `API: ${String(entry.calls)} call(s), ${String(entry.cached)} cached`,
        });
    }
    return frames;
}
function reviewFrame(cwd, sinceMs, noPaths) {
    const review = loadLastReview(cwd);
    if (!review)
        return [];
    const at = new Date(review.createdAt);
    if (Number.isNaN(at.getTime()) || at.getTime() < sinceMs)
        return [];
    const first = review.findings[0];
    const location = first ? (noPaths ? "(path hidden)" : (first.location ?? "unknown")) : "";
    return [
        {
            at: at.toISOString(),
            kind: "review",
            text: `review: ${String(review.findings.length)} finding(s)${location ? `, first at ${location}` : ""}`,
        },
    ];
}
function receiptFrame(cwd, sinceMs) {
    const path = receiptPath(cwd);
    if (!path || !existsSync(path))
        return [];
    const receipt = readReceipt(path);
    const at = new Date(receipt.createdAt);
    if (Number.isNaN(at.getTime()) || at.getTime() < sinceMs)
        return [];
    const verification = verifyReceipt(cwd, receipt);
    const tests = receipt.tests ? (receipt.tests.passed ? "tests passed" : "tests failed") : "tests not run";
    return [
        {
            at: at.toISOString(),
            kind: "receipt",
            text: `receipt ${receipt.commit?.slice(0, 7) ?? "no commit"}: ${tests}, ${verification.ok ? "verified" : "not verified"}`,
        },
    ];
}
function renderHtml(title, frames, sinceDays) {
    const payload = JSON.stringify(frames).replaceAll("<", "\\u003c");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; background: #0b0f14; color: #c9d1d9; font: 15px/1.5 "Cascadia Mono", "SFMono-Regular", Consolas, monospace; }
main { max-width: 900px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { margin: 0 0 4px; color: #58a6ff; font-size: 20px; }
.meta { margin: 0 0 24px; color: #8b949e; }
#screen { min-height: 320px; padding: 20px; border: 1px solid #30363d; border-radius: 8px; background: #010409; white-space: pre-wrap; }
.frame { margin: 0 0 10px; }
.at { color: #8b949e; }
.kind { color: #d2a8ff; }
.controls { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
button, select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; font: inherit; }
button:hover { border-color: #58a6ff; }
#counter { color: #8b949e; margin-left: auto; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${String(frames.length)} frames over ${String(sinceDays)} day(s). Generated by oc-pilot.</p>
<div id="screen"></div>
<div class="controls">
<button id="play">Pause</button>
<select id="speed"><option value="1500">0.5x</option><option value="800" selected>1x</option><option value="400">2x</option><option value="150">5x</option></select>
<span id="counter"></span>
</div>
</main>
<script>
const frames = ${payload};
const screen = document.getElementById("screen");
const play = document.getElementById("play");
const speed = document.getElementById("speed");
const counter = document.getElementById("counter");
let index = 0;
let timer = null;
function draw() {
  if (frames.length === 0) {
    screen.textContent = "No activity in this window.";
    counter.textContent = "0 / 0";
    return;
  }
  const frame = frames[Math.min(index, frames.length - 1)];
  const row = document.createElement("p");
  row.className = "frame";
  const at = document.createElement("span");
  at.className = "at";
  at.textContent = "[" + frame.at.replace("T", " ").slice(0, 16) + "] ";
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = frame.kind + " ";
  const text = document.createElement("span");
  text.textContent = frame.text;
  row.append(at, kind, text);
  screen.append(row);
  screen.scrollTop = screen.scrollHeight;
  counter.textContent = (index + 1) + " / " + frames.length;
}
function tick() {
  if (index >= frames.length - 1) {
    stop();
    return;
  }
  index += 1;
  draw();
}
function start() {
  if (frames.length === 0 || timer !== null) return;
  play.textContent = "Pause";
  timer = setInterval(tick, Number(speed.value));
}
function stop() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  play.textContent = "Play";
}
play.addEventListener("click", () => { if (timer === null) start(); else stop(); });
speed.addEventListener("change", () => { if (timer !== null) { stop(); start(); } });
draw();
start();
</script>
</body>
</html>
`;
}
function renderCast(frames) {
    const header = JSON.stringify({ version: 2, width: 100, height: 30, timestamp: Math.floor(Date.now() / 1000) });
    const lines = frames.map((frame, index) => {
        const time = index * 0.6;
        const output = `[${shortAt(frame.at)}] ${frame.kind} ${frame.text}\r\n`;
        return JSON.stringify([Number(time.toFixed(2)), "o", output]);
    });
    return `${[header, ...lines].join("\n")}\n`;
}
export function buildCinema(cwd, options = {}) {
    const sinceDays = Math.max(1, Math.min(365, Math.round(options.sinceDays ?? 7)));
    const maxFrames = Math.max(1, Math.min(500, Math.round(options.maxFrames ?? 120)));
    const sinceMs = Date.now() - sinceDays * DAY_MS;
    const title = options.title?.trim() || DEFAULT_TITLE;
    const noPaths = options.noPaths === true;
    const frames = [
        ...gitFrames(cwd, sinceMs, noPaths),
        ...statsFrames(cwd, sinceMs),
        ...reviewFrame(cwd, sinceMs, noPaths),
        ...receiptFrame(cwd, sinceMs),
    ]
        .sort((left, right) => left.at.localeCompare(right.at))
        .slice(-maxFrames);
    const format = options.cast ? "cast" : "html";
    return {
        title,
        generatedAt: new Date().toISOString(),
        sinceDays,
        format,
        frames,
        content: format === "cast" ? renderCast(frames) : renderHtml(title, frames, sinceDays),
    };
}
export function describeCinema(report) {
    const format = report.format === "cast" ? "asciinema cast" : "HTML";
    return `${String(report.frames.length)} кадров за ${String(report.sinceDays)} дн. (${format})`;
}
//# sourceMappingURL=cinema.js.map