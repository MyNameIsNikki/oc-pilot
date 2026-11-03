import { relative } from "node:path";
import { filterAnalysisText, filterFindings } from "./baseline.js";
import { cachedRunOpenAi, DEFAULT_CACHE_TTL_SECONDS } from "./cache.js";
import { findAgentRules } from "./agent-rules.js";
import { truncateDiff, truncateText } from "./diff.js";
import { buildFileContext } from "./file-context.js";
import { describeFindings, countFindings, parseFindings, shouldFail } from "./findings.js";
import { buildJsonAnalysis, validateAnalysis } from "./format.js";
import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_API_BASE_URL, normalizeBaseUrl, runAnthropic, } from "./engine.js";
import { writeOutput } from "./io.js";
import { log } from "./log.js";
import { runOpenCode } from "./opencode.js";
import { buildInput, systemPromptFor, TRIAGE_SYSTEM_PROMPT } from "./prompt.js";
import { loadRules } from "./rules.js";
import { saveLastReview } from "./last-review.js";
import { parseTriageDecision } from "./router.js";
import { downgradeFindingInText, verifyCriticalFindings } from "./second-opinion.js";
import { loadSecretIgnore, scanText } from "./secrets.js";
import { recordRun } from "./stats.js";
import { lgtmText, mergeSliceAnalyses, planDiffSlices } from "./slicing.js";
const MAX_PROMPT_CHARS = 300_000;
/** Slices are independent diff blocks, so a few API calls can overlap. */
const SLICE_CONCURRENCY = 3;
async function mapWithConcurrency(items, limit, run) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length)
                return;
            results[index] = await run(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
function printSecretWarnings(findings, redacted) {
    if (findings.length === 0)
        return;
    log.warn(redacted
        ? `Найдено потенциальных секретов: ${findings.length}. Значения заменены маркерами.`
        : `Найдено потенциальных секретов: ${findings.length}. ВНИМАНИЕ: redaction отключён, значения уйдут модели.`);
    for (const finding of findings.slice(0, 10)) {
        log.detail(`${finding.severity === "critical" ? "🔴" : "🟡"} ${finding.file}:${finding.line} — ${finding.kind} (${finding.preview})`);
    }
    if (findings.length > 10)
        log.detail(`…и ещё ${findings.length - 10}`);
}
export { printSecretWarnings };
function escapeGithub(value) {
    return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
export function githubAnnotations(findings, cwd) {
    const lines = [];
    for (const finding of findings) {
        const level = finding.severity === "critical" ? "error" : finding.severity === "warning" ? "warning" : "notice";
        const location = finding.location ?? "";
        const match = /^(.*?):(\d+)(?::\d+)?$/.exec(location);
        const file = match ? relative(cwd, match[1]).replace(/\\/g, "/") : undefined;
        const line = match ? match[2] : undefined;
        const properties = [
            file ? `file=${escapeGithub(file)}` : undefined,
            line ? `line=${line}` : undefined,
            `title=${escapeGithub(`oc-pilot ${finding.severity}`)}`,
        ]
            .filter(Boolean)
            .join(",");
        lines.push(`::${level} ${properties}::${escapeGithub(finding.text)}`);
    }
    return lines;
}
function dedupeFindings(findings) {
    const unique = new Map();
    for (const finding of findings) {
        const key = `${finding.file}:${finding.line}:${finding.kind}`;
        if (!unique.has(key))
            unique.set(key, finding);
    }
    return [...unique.values()];
}
function buildInputFor(payload, redacted, repoContext, lang, diff = payload.diff, context = payload.additionalContext) {
    return buildInput({
        recipe: payload.recipe,
        projectType: payload.projectType,
        additionalContext: context,
        diff,
        findings: payload.secretFindings,
        redacted,
        repoContext,
        lang,
    });
}
function enforcePromptLimit(payload, redacted, repoContext, lang) {
    let diff = payload.diff;
    let context = payload.additionalContext;
    const build = () => buildInputFor(payload, redacted, repoContext, lang, diff, context);
    const overhead = systemPromptFor(lang).length + 80;
    let input = build();
    if (input.length + overhead > MAX_PROMPT_CHARS) {
        const excess = input.length + overhead - MAX_PROMPT_CHARS;
        const budget = Math.max(10_000, diff.length - excess - 1_000);
        if (diff.length > budget) {
            diff = truncateDiff(diff, budget).text;
            input = build();
            log.warn(`Промпт превысил ${MAX_PROMPT_CHARS} символов; diff дополнительно обрезан.`);
        }
    }
    if (input.length + overhead > MAX_PROMPT_CHARS) {
        const excess = input.length + overhead - MAX_PROMPT_CHARS;
        const budget = Math.max(5_000, context.length - excess - 1_000);
        context = truncateText(context, budget, { mode: "both" }).text;
        input = build();
        log.warn("Промпт превысил лимит; дополнительный контекст обрезан.");
    }
    if (input.length + overhead > MAX_PROMPT_CHARS) {
        input = `${input.slice(0, MAX_PROMPT_CHARS - overhead)}\n[... промпт обрезан ...]`;
    }
    return input;
}
export async function executeRecipeDetailed(payload, ctx, options = {}) {
    const scanSecrets = !payload.noSecretScan;
    const effectiveRepoContext = ctx.config.repoContext && ctx.config.engine === "opencode";
    const rules = loadRules(ctx.cwd, ctx.config.rules);
    const prefixes = [];
    let secretFindings = payload.secretFindings;
    let fileContextCount = 0;
    if (rules) {
        const rulesText = scanSecrets && ctx.config.redactSecrets ? rules.text : rules.rawText;
        prefixes.push([`PROJECT_RULES (${rules.path}${rules.truncated ? ", обрезано" : ""}):`, rulesText.trim() || "(пусто)"].join("\n"));
        if (scanSecrets) {
            secretFindings = dedupeFindings([...secretFindings, ...rules.findings]);
            if (rules.findings.length > 0) {
                log.warn(`В файле правил найдено потенциальных секретов: ${rules.findings.length}.`);
            }
        }
        if (rules.truncated)
            log.warn(`Правила проекта обрезаны до ${20_000} символов.`);
    }
    if (ctx.config.agentRules !== false) {
        const agentRules = findAgentRules(ctx.cwd);
        if (agentRules) {
            let agentText = agentRules.text;
            if (scanSecrets && ctx.config.redactSecrets) {
                const scan = scanText(agentText, agentRules.path, { ignore: loadSecretIgnore(ctx.cwd) });
                if (scan.findings.length > 0) {
                    secretFindings = dedupeFindings([...secretFindings, ...scan.findings]);
                    log.warn(`В агентских правилах найдено потенциальных секретов: ${scan.findings.length}.`);
                }
                agentText = scan.redacted;
            }
            prefixes.push(`AGENT_RULES (${agentRules.path}${agentRules.truncated ? ", обрезано" : ""}):\n${agentText}`);
            if (agentRules.truncated)
                log.warn("Агентские правила обрезаны до 10 000 символов.");
        }
    }
    if (!effectiveRepoContext && payload.recipe !== "docgen" && payload.changedFiles.length > 0) {
        const fileContext = buildFileContext(ctx.cwd, payload.changedFiles, {
            redact: scanSecrets && ctx.config.redactSecrets,
        });
        if (fileContext.text) {
            prefixes.push(`FULL_FILE_CONTEXT (read-only, ${scanSecrets && ctx.config.redactSecrets ? "секреты отредактированы" : "redaction отключён"}):\n${fileContext.text}`);
            fileContextCount = fileContext.files.length;
            if (scanSecrets)
                secretFindings = dedupeFindings([...secretFindings, ...fileContext.findings]);
        }
        if (fileContext.omitted.length > 0) {
            log.warn(`В full-file контекст не поместились: ${fileContext.omitted.join(", ")}`);
        }
    }
    const additionalContext = prefixes.length > 0 ? [...prefixes, payload.additionalContext].join("\n\n") : payload.additionalContext;
    const effective = { ...payload, additionalContext, secretFindings };
    const lang = ctx.config.lang;
    const systemPrompt = systemPromptFor(lang);
    // Smart slicing (engine=openai): when the diff would not fit one prompt,
    // split it into per-file slices instead of truncating files away.
    const overhead = systemPrompt.length + 80;
    const rawInput = buildInputFor(effective, ctx.config.redactSecrets, effectiveRepoContext, lang);
    let slicePlan;
    let sliceContext = "";
    if (rawInput.length + overhead > MAX_PROMPT_CHARS &&
        ctx.config.engine === "openai" &&
        options.slicing !== false &&
        payload.recipe !== "docgen" &&
        effective.diff.trim()) {
        const contextBudget = Math.max(5_000, Math.floor(MAX_PROMPT_CHARS * 0.4));
        let context = effective.additionalContext;
        if (context.length > contextBudget) {
            context = truncateText(context, contextBudget, { mode: "both" }).text;
            log.warn("Дополнительный контекст обрезан, чтобы оставить место слайсам diff.");
        }
        const reserve = 2_000;
        const diffBudget = Math.max(10_000, MAX_PROMPT_CHARS - overhead - context.length - reserve);
        const plan = planDiffSlices(effective.diff, diffBudget);
        if (plan.slices.length > 1) {
            slicePlan = plan;
            sliceContext = context;
            log.info(`Diff не помещается в один промпт: разбит на ${plan.slices.length} частей (умный slicing, engine=openai).`);
        }
    }
    const input = slicePlan
        ? enforcePromptLimit({ ...effective, diff: slicePlan.slices[0], additionalContext: sliceContext }, ctx.config.redactSecrets, effectiveRepoContext, lang)
        : enforcePromptLimit(effective, ctx.config.redactSecrets, effectiveRepoContext, lang);
    const fullPrompt = `${systemPrompt}\n\n=== INPUT ===\n${input}\n=== END INPUT ===`;
    const criticalSecrets = payload.secretFindings.filter((finding) => finding.severity === "critical");
    printSecretWarnings(secretFindings, ctx.config.redactSecrets);
    if (ctx.flags.dryRun) {
        if (ctx.flags.json) {
            const data = {
                dryRun: true,
                recipe: payload.recipe,
                projectType: payload.projectType,
                filesChanged: payload.changedFiles,
                secrets: secretFindings,
                engine: ctx.config.engine,
                baseUrl: ctx.config.engine === "openai" ? normalizeBaseUrl(ctx.config.baseUrl) : null,
                repoContext: effectiveRepoContext,
                repoContextRequested: ctx.config.repoContext,
                lang: ctx.config.lang,
                router: options.router?.enabled
                    ? {
                        enabled: true,
                        model: options.router.model ?? ctx.config.routerModel ?? ctx.config.model ?? null,
                    }
                    : undefined,
                failOn: ctx.config.failOn,
                rules: rules?.path ?? null,
                fileContext: fileContextCount,
                systemPrompt,
                input,
                prompt: fullPrompt,
            };
            const path = writeOutput(JSON.stringify(data, null, 2), ctx.flags.output);
            if (path)
                log.success(`Промпт записан: ${path}`);
        }
        else {
            const path = writeOutput(fullPrompt, ctx.flags.output);
            if (path)
                log.success(`Промпт записан: ${path}`);
        }
        if (payload.failOnSecrets && criticalSecrets.length > 0) {
            log.warn(`--fail-on-secrets: обнаружено critical-секретов: ${criticalSecrets.length}`);
            return { exitCode: 3 };
        }
        return { exitCode: 0 };
    }
    const cacheTtl = ctx.flags.noCache ? 0 : (ctx.config.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS);
    // Two-phase routing (engine=openai, recipe=review): a fast triage model
    // decides whether the main review call is needed at all. Any triage
    // failure or unparsable answer falls back to the full review.
    let routerMeta;
    const routerWanted = options.router?.enabled === true &&
        ctx.config.engine === "openai" &&
        payload.recipe === "review" &&
        !slicePlan &&
        effective.diff.trim().length > 0;
    if (routerWanted) {
        const routerModel = options.router?.model ?? ctx.config.routerModel ?? ctx.config.model;
        try {
            const triage = await cachedRunOpenAi({
                systemPrompt: TRIAGE_SYSTEM_PROMPT,
                input,
                baseUrl: ctx.config.baseUrl,
                apiKeyEnv: ctx.config.apiKeyEnv,
                model: routerModel,
                timeoutMs: ctx.config.timeoutSeconds * 1000,
                cwd: ctx.cwd,
                ttlSeconds: cacheTtl,
                dailyLimit: ctx.config.maxDailyApiCalls,
                maxCostUsd: ctx.config.maxCostUsd,
            });
            const decision = parseTriageDecision(triage.text);
            routerMeta = { model: routerModel ?? null, decision, durationMs: triage.durationMs };
            if (decision === "unknown") {
                routerMeta.decision = "review";
                routerMeta.fallback = true;
                log.warn("Router: ответ триажа не распознан — выполняется полный ревью.");
            }
            else {
                log.info(decision === "lgtm"
                    ? `Router (${routerModel ?? "модель по умолчанию"}): LGTM — основной вызов пропущен.`
                    : `Router (${routerModel ?? "модель по умолчанию"}): REVIEW — выполняется полный ревью.`);
            }
        }
        catch (error) {
            routerMeta = { model: routerModel ?? null, decision: "review", fallback: true };
            log.warn(`Router недоступен (${error instanceof Error ? error.message : String(error)}) — выполняется полный ревью.`);
        }
    }
    const modelLabel = ctx.config.model ?? "модель по умолчанию";
    if (ctx.config.engine === "openai") {
        log.step(`API: ${modelLabel} · ${normalizeBaseUrl(ctx.config.baseUrl) || DEFAULT_API_BASE_URL} · diff-only context${slicePlan ? ` · слайсов: ${slicePlan.slices.length}` : ""}${routerMeta ? ` · router: ${String(routerMeta.decision)}` : ""}`);
    }
    else if (ctx.config.engine === "anthropic") {
        log.step(`Anthropic: ${modelLabel} · ${normalizeBaseUrl(ctx.config.baseUrl) || DEFAULT_ANTHROPIC_BASE_URL} · cached system prompt`);
    }
    else {
        log.step(`OpenCode: ${modelLabel} · агент ${ctx.config.agent} · ${effectiveRepoContext ? "read-only repo context" : "diff-only"}`);
    }
    let analysis;
    let warnings;
    let cacheStatus;
    if (routerMeta?.decision === "lgtm") {
        analysis = { text: lgtmText(lang), durationMs: Number(routerMeta.durationMs ?? 0), stderr: "" };
        warnings = validateAnalysis(analysis.text, payload.recipe);
    }
    else if (slicePlan) {
        const slices = slicePlan.slices;
        const prepared = slices.map((slice, index) => {
            const slicePayload = {
                ...effective,
                diff: slice,
                additionalContext: sliceContext,
            };
            return {
                index,
                input: enforcePromptLimit(slicePayload, ctx.config.redactSecrets, effectiveRepoContext, lang),
                files: slicePlan.filesPerSlice[index]?.length ?? 0,
            };
        });
        const results = await mapWithConcurrency(prepared, SLICE_CONCURRENCY, async (item) => {
            log.info(`Слайс ${item.index + 1}/${slices.length} (файлов: ${item.files})`);
            const result = await cachedRunOpenAi({
                systemPrompt,
                input: item.input,
                baseUrl: ctx.config.baseUrl,
                apiKeyEnv: ctx.config.apiKeyEnv,
                model: ctx.config.model,
                timeoutMs: ctx.config.timeoutSeconds * 1000,
                cwd: ctx.cwd,
                ttlSeconds: cacheTtl,
                dailyLimit: ctx.config.maxDailyApiCalls,
                maxCostUsd: ctx.config.maxCostUsd,
            });
            log.detail(`Слайс ${item.index + 1}/${slices.length} готов за ${result.durationMs} мс`);
            return { ...result, index: item.index };
        });
        const ordered = [...results].sort((left, right) => left.index - right.index);
        let totalDurationMs = 0;
        const sliceWarnings = [];
        const seenWarnings = new Set();
        for (const sliceResult of ordered) {
            if (sliceResult.cached)
                cacheStatus = "hit";
            else if (!cacheStatus)
                cacheStatus = "miss";
            totalDurationMs += sliceResult.durationMs;
            for (const warning of validateAnalysis(sliceResult.text, payload.recipe)) {
                if (seenWarnings.has(warning.message))
                    continue;
                seenWarnings.add(warning.message);
                sliceWarnings.push(warning);
            }
        }
        const merged = mergeSliceAnalyses(ordered.map((sliceResult) => sliceResult.text), lang);
        analysis = { text: merged.text, durationMs: totalDurationMs, stderr: "" };
        warnings = sliceWarnings;
    }
    else if (ctx.config.engine === "openai") {
        const result = await cachedRunOpenAi({
            systemPrompt,
            input,
            baseUrl: ctx.config.baseUrl,
            apiKeyEnv: ctx.config.apiKeyEnv,
            model: ctx.config.model,
            timeoutMs: ctx.config.timeoutSeconds * 1000,
            cwd: ctx.cwd,
            ttlSeconds: cacheTtl,
            dailyLimit: ctx.config.maxDailyApiCalls,
            maxCostUsd: ctx.config.maxCostUsd,
        });
        analysis = result;
        cacheStatus = result.cached ? "hit" : "miss";
        warnings = validateAnalysis(analysis.text, payload.recipe);
    }
    else if (ctx.config.engine === "anthropic") {
        analysis = await runAnthropic({
            systemPrompt,
            input,
            baseUrl: ctx.config.baseUrl,
            apiKeyEnv: ctx.config.apiKeyEnv,
            model: ctx.config.model,
            timeoutMs: ctx.config.timeoutSeconds * 1000,
        });
        warnings = validateAnalysis(analysis.text, payload.recipe);
    }
    else {
        analysis = await runOpenCode({
            systemPrompt,
            input,
            cwd: ctx.cwd,
            model: ctx.config.model,
            agent: ctx.config.agent,
            timeoutMs: ctx.config.timeoutSeconds * 1000,
            verbose: ctx.flags.verbose,
            repoContext: effectiveRepoContext,
        });
        warnings = validateAnalysis(analysis.text, payload.recipe);
    }
    for (const warning of warnings) {
        log.warn(`Ответ не соответствует OUTPUT SCHEMA: ${warning.message}`);
    }
    let analysisFindings = parseFindings(analysis.text);
    let outputText = analysis.text;
    let baselineMeta;
    if (payload.baseline && payload.baseline.length > 0) {
        const known = new Set(payload.baseline);
        const { kept, knownCount } = filterFindings(analysisFindings, known);
        if (knownCount > 0) {
            analysisFindings = kept;
            outputText = filterAnalysisText(analysis.text, known);
            baselineMeta = { baseline: { known: knownCount, total: knownCount + kept.length } };
            log.info(`Baseline: скрыто известных находок: ${knownCount}.`);
        }
    }
    // Second opinion (engine=openai, recipe=review): verify each critical
    // finding with a second model call; rejected findings downgrade to style.
    let secondOpinionMeta;
    const soWanted = options.secondOpinion?.enabled === true &&
        ctx.config.engine === "openai" &&
        payload.recipe === "review";
    if (soWanted) {
        const criticals = analysisFindings.filter((finding) => finding.severity === "critical").slice(0, 10);
        if (criticals.length > 0) {
            const soModel = options.secondOpinion?.model ?? ctx.config.secondOpinionModel ?? ctx.config.model;
            const soBaseUrl = options.secondOpinion?.baseUrl ?? ctx.config.secondOpinionBaseUrl ?? ctx.config.baseUrl;
            const soApiKeyEnv = options.secondOpinion?.apiKeyEnv ?? ctx.config.secondOpinionApiKeyEnv ?? ctx.config.apiKeyEnv;
            log.step(`Second opinion: проверка критичных находок (${soModel ?? "модель по умолчанию"}).`);
            try {
                const verified = await verifyCriticalFindings(criticals, effective.diff, {
                    model: soModel,
                    baseUrl: soBaseUrl,
                    apiKeyEnv: soApiKeyEnv,
                    timeoutMs: ctx.config.timeoutSeconds * 1000,
                    cwd: ctx.cwd,
                });
                let downgraded = 0;
                for (const rejected of verified.rejected) {
                    const original = criticals[rejected.index];
                    if (!original)
                        continue;
                    const at = analysisFindings.indexOf(original);
                    if (at >= 0)
                        analysisFindings[at] = { ...original, severity: "style" };
                    outputText = downgradeFindingInText(outputText, original, rejected.reason);
                    downgraded += 1;
                }
                secondOpinionMeta = {
                    model: soModel ?? null,
                    verified: verified.verified,
                    rejected: downgraded,
                    durationMs: verified.durationMs,
                };
                if (downgraded > 0)
                    log.info(`Second opinion: отклонено находок: ${downgraded} (понижены до style).`);
            }
            catch (error) {
                log.warn(`Second opinion недоступен (${error instanceof Error ? error.message : String(error)}) — находки оставлены как есть.`);
            }
        }
    }
    if (payload.recipe === "review") {
        saveLastReview(ctx.cwd, {
            recipe: payload.recipe,
            model: ctx.config.model,
            findings: analysisFindings,
        });
    }
    if (analysisFindings.length > 0)
        log.info(`Замечания: ${describeFindings(analysisFindings)}`);
    if (ctx.flags.github) {
        for (const annotation of githubAnnotations(analysisFindings, ctx.cwd)) {
            process.stderr.write(`${annotation}\n`);
        }
    }
    const meta = {
        recipe: payload.recipe,
        projectType: payload.projectType,
        engine: ctx.config.engine,
        agent: ctx.config.agent,
        model: ctx.config.model ?? null,
        durationMs: analysis.durationMs,
        filesChanged: payload.changedFiles.length,
        sessionID: analysis.sessionID,
        cost: analysis.cost,
        formatValid: warnings.length === 0,
        formatWarnings: warnings.map((warning) => warning.message),
        repoContext: effectiveRepoContext,
        repoContextRequested: ctx.config.repoContext,
        rules: rules?.path ?? null,
        fileContext: fileContextCount,
        findings: countFindings(analysisFindings),
        ...(slicePlan ? { slices: slicePlan.slices.length } : {}),
        ...(routerMeta ? { router: routerMeta } : {}),
        ...(cacheStatus ? { cache: cacheStatus } : {}),
        ...(baselineMeta ? baselineMeta : {}),
        ...(secondOpinionMeta ? { secondOpinion: secondOpinionMeta } : {}),
        ...payload.meta,
    };
    if (!options.capture) {
        if (ctx.flags.json) {
            const json = buildJsonAnalysis(outputText, secretFindings, meta, analysisFindings);
            const path = writeOutput(JSON.stringify(json, null, 2), ctx.flags.output);
            if (path)
                log.success(`Результат записан: ${path}`);
        }
        else {
            const path = writeOutput(outputText, ctx.flags.output);
            if (path)
                log.success(`Результат записан: ${path}`);
        }
    }
    let exitCode = 0;
    if (payload.failOnSecrets && criticalSecrets.length > 0) {
        log.warn(`--fail-on-secrets: обнаружено critical-секретов: ${criticalSecrets.length}`);
        exitCode = 3;
    }
    if (shouldFail(analysisFindings, ctx.config.failOn)) {
        log.warn(`--fail-on ${ctx.config.failOn}: найдены замечания (${describeFindings(analysisFindings)})`);
        exitCode = 3;
    }
    if (ctx.flags.strict && warnings.length > 0) {
        log.warn("--strict: ответ не соответствует OUTPUT SCHEMA");
        exitCode = 3;
    }
    recordRun(ctx.cwd, {
        recipe: payload.recipe,
        engine: ctx.config.engine,
        exitCode,
        findings: countFindings(analysisFindings),
    });
    return { exitCode, analysis: outputText, meta };
}
export async function executeRecipe(payload, ctx, options = {}) {
    return (await executeRecipeDetailed(payload, ctx, options)).exitCode;
}
//# sourceMappingURL=run.js.map