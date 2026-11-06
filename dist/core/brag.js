import { existsSync } from "node:fs";
import { runGit } from "./git.js";
import { loadLastReview } from "./last-review.js";
import { readReceipt, receiptPath, verifyReceipt } from "./receipt.js";
import { readStats, summarizeStats } from "./stats.js";
const DEFAULT_TITLE = "oc-pilot session report";
const DEFAULT_WATERMARK = "made with oc-pilot";
const DAY_MS = 86_400_000;
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function shortDate(ts) {
    return new Date(ts).toISOString().slice(0, 10);
}
function dailyBuckets(records, sinceMs, days) {
    const buckets = new Map();
    for (let index = days - 1; index >= 0; index -= 1) {
        const date = shortDate(Date.now() - index * DAY_MS);
        buckets.set(date, { date, runs: 0, apiCalls: 0 });
    }
    for (const run of records.runs) {
        if (run.ts < sinceMs)
            continue;
        const bucket = buckets.get(shortDate(run.ts));
        if (bucket)
            bucket.runs += 1;
    }
    for (const call of records.apiCalls) {
        if (call.ts < sinceMs)
            continue;
        const bucket = buckets.get(shortDate(call.ts));
        if (bucket)
            bucket.apiCalls += 1;
    }
    return [...buckets.values()];
}
function gitTotals(cwd, since) {
    const log = runGit(["log", `--since=${since}`, "--numstat", "--pretty=format:%H"], cwd);
    if (log.status !== 0)
        return { commits: 0, additions: 0, deletions: 0 };
    let commits = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of log.stdout.split(/\r?\n/)) {
        if (/^[0-9a-f]{40}$/.test(line.trim())) {
            commits += 1;
            continue;
        }
        const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
        if (!match)
            continue;
        if (match[1] !== "-")
            additions += Number(match[1]);
        if (match[2] !== "-")
            deletions += Number(match[2]);
    }
    return { commits, additions, deletions };
}
function sparkline(days) {
    const width = 560;
    const height = 120;
    const padding = 12;
    const max = Math.max(1, ...days.map((day) => day.runs + day.apiCalls));
    const step = days.length > 1 ? (width - padding * 2) / (days.length - 1) : 0;
    const points = days.map((day, index) => {
        const x = padding + index * step;
        const y = height - padding - ((day.runs + day.apiCalls) / max) * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const bars = days
        .map((day, index) => {
        const x = padding + index * step;
        const value = day.runs + day.apiCalls;
        const barHeight = (value / max) * (height - padding * 2);
        return `<rect x="${(x - 8).toFixed(1)}" y="${(height - padding - barHeight).toFixed(1)}" width="16" height="${barHeight.toFixed(1)}" fill="#3ddc97" opacity="0.35"><title>${escapeHtml(day.date)}: ${String(value)}</title></rect>`;
    })
        .join("");
    return `<svg viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="Activity per day" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0b0f14"/>${bars}<polyline fill="none" stroke="#3ddc97" stroke-width="2" points="${points.join(" ")}"/></svg>`;
}
function renderSvg(report) {
    return sparkline(report.stats.days).replace("</svg>", `<text x="12" y="20" fill="#8be9c0" font-family="monospace" font-size="12">${escapeHtml(report.title)}</text></svg>`);
}
function renderHtml(report) {
    const s = report.stats;
    const review = report.review
        ? `<ul>${report.review.items
            .map((item) => `<li><span class="sev">${escapeHtml(item.severity)}</span> <code>${escapeHtml(item.location)}</code> ${escapeHtml(item.text)}</li>`)
            .join("")}</ul>`
        : "<p class=\"muted\">No review recorded.</p>";
    const receipt = report.receipt
        ? `<p><code>${escapeHtml(report.receipt.commit?.slice(0, 12) ?? "no commit")}</code> · tests ${report.receipt.testsPassed === null ? "unknown" : report.receipt.testsPassed ? "passed" : "failed"} · preflight ${escapeHtml(report.receipt.preflight ?? "unknown")} · signature ${escapeHtml(report.receipt.signature)}</p>`
        : "<p class=\"muted\">No receipt for HEAD.</p>";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0f14;color:#d7e2ea;font:15px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
main{max-width:860px;margin:0 auto;padding:40px 20px 24px}h1{font-size:24px;color:#3ddc97;margin:0 0 4px}
.muted{color:#7d8b96}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
.card{border:1px solid #1f2a35;border-radius:10px;padding:14px;background:#101720}.card b{display:block;font-size:22px;color:#8be9c0}
section{border-top:1px solid #1f2a35;padding-top:18px;margin-top:22px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#7d8b96}
ul{padding-left:18px}code{color:#f0c674}.sev{color:#ff7b72;text-transform:uppercase;font-size:11px}
footer{margin-top:32px;color:#52606b;font-size:12px;display:flex;justify-content:space-between;gap:12px}
</style></head><body><main>
<h1>${escapeHtml(report.title)}</h1><p class="muted">Last ${String(report.sinceDays)} days · generated ${escapeHtml(report.generatedAt)}</p>
<div class="grid">
<div class="card"><span>commits</span><b>${String(s.commits)}</b></div>
<div class="card"><span>lines</span><b>+${String(s.additions)} / -${String(s.deletions)}</b></div>
<div class="card"><span>oc-pilot runs</span><b>${String(s.runs)}</b></div>
<div class="card"><span>model calls</span><b>${String(s.apiCalls)}</b></div>
<div class="card"><span>cache hits</span><b>${String(s.cacheHits)}</b></div>
<div class="card"><span>findings</span><b>${String(s.findings.critical)}/${String(s.findings.warning)}/${String(s.findings.style)}</b></div>
</div>
<section><h2>Activity</h2>${sparkline(s.days)}</section>
<section><h2>Last review</h2>${review}</section>
<section><h2>Proof for HEAD</h2>${receipt}</section>
<footer><span>${escapeHtml(report.watermark ?? DEFAULT_WATERMARK)}</span><span>oc-pilot</span></footer>
</main></body></html>`;
}
export function buildBrag(cwd, options = {}) {
    const sinceDays = Math.max(1, Math.min(365, options.sinceDays ?? 7));
    const sinceMs = Date.now() - sinceDays * DAY_MS;
    const records = readStats(cwd);
    const summary = summarizeStats(records, sinceMs);
    const totals = gitTotals(cwd, `${String(sinceDays)} days ago`);
    const lastReview = loadLastReview(cwd);
    const reviewItems = (lastReview?.findings ?? []).slice(0, 5).map((finding) => ({
        location: options.noPaths ? "(hidden)" : (finding.location ?? "(unknown)"),
        severity: finding.severity,
        text: finding.text,
    }));
    let receiptInfo = null;
    const path = receiptPath(cwd);
    if (path && existsSync(path)) {
        try {
            const receipt = readReceipt(path);
            const verification = verifyReceipt(cwd, receipt);
            receiptInfo = {
                commit: receipt.commit,
                testsPassed: receipt.tests ? receipt.tests.passed : null,
                preflight: receipt.preflight?.status ?? null,
                signature: verification.signature,
            };
        }
        catch {
            receiptInfo = null;
        }
    }
    const report = {
        title: options.title?.trim() || DEFAULT_TITLE,
        watermark: options.watermark?.trim() || DEFAULT_WATERMARK,
        generatedAt: new Date().toISOString(),
        sinceDays,
        stats: {
            ...totals,
            runs: summary.runs,
            apiCalls: summary.apiCalls,
            cacheHits: summary.cacheHits,
            findings: summary.findings,
            days: dailyBuckets(records, sinceMs, sinceDays),
        },
        receipt: receiptInfo,
        review: lastReview ? { findings: lastReview.findings.length, items: reviewItems } : null,
        content: "",
    };
    report.content = options.svg ? renderSvg(report) : renderHtml(report);
    return report;
}
//# sourceMappingURL=brag.js.map