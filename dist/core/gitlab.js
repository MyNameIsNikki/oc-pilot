import { PilotError } from "./errors.js";
import { log } from "./log.js";
/**
 * Reads the merge request coordinates from the GitLab CI environment.
 * Returns undefined outside a merge request pipeline, so callers can skip
 * quietly instead of failing a job that only runs on the default branch.
 */
export function gitlabTarget(env = process.env) {
    const iid = env.CI_MERGE_REQUEST_IID?.trim();
    const projectId = env.CI_PROJECT_ID?.trim();
    const apiUrl = (env.CI_API_V4_URL ?? "").trim().replace(/\/+$/, "");
    const token = (env.GITLAB_TOKEN ?? env.CI_JOB_TOKEN ?? "").trim();
    if (!iid || !projectId || !apiUrl || !token)
        return undefined;
    return { projectId, iid, token, apiUrl };
}
/**
 * Reads the diff refs from the pipeline environment.
 * `CI_MERGE_REQUEST_TARGET_BRANCH_SHA` is only set in merged-results
 * pipelines, so a partial set counts as missing and the merge request itself
 * is asked for `diff_refs` instead.
 */
export function mrDiffRefs(env = process.env) {
    const baseSha = (env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? "").trim();
    const startSha = (env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA ?? "").trim();
    const headSha = (env.CI_COMMIT_SHA ?? "").trim();
    if (!baseSha || !startSha || !headSha)
        return undefined;
    return { baseSha, startSha, headSha };
}
function mrPath(target) {
    return `/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.iid}`;
}
async function fail(response) {
    const detail = (await response.text()).trim().slice(0, 300);
    throw new PilotError(`GitLab API вернул HTTP ${response.status}`, {
        hint: `${detail ? `${detail}\n` : ""}Нужен токен с правом api: GITLAB_TOKEN (CI_JOB_TOKEN не умеет писать заметки).`,
        exitCode: 1,
    });
}
async function request(target, path, body) {
    const response = await fetch(`${target.apiUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "PRIVATE-TOKEN": target.token,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok)
        await fail(response);
}
async function requestJson(target, path) {
    const response = await fetch(`${target.apiUrl}${path}`, {
        headers: {
            accept: "application/json",
            "PRIVATE-TOKEN": target.token,
        },
    });
    if (!response.ok)
        await fail(response);
    return (await response.json());
}
/** Posts one summary note into the merge request. */
export async function postMrNote(body, target) {
    await request(target, `${mrPath(target)}/notes`, { body });
}
/**
 * Posts one discussion pinned to a line of the diff. GitLab rejects the note,
 * not the whole batch, when the position is stale, so callers post these one
 * by one and count the survivors.
 */
export async function postMrDiscussion(comment, refs, target) {
    await request(target, `${mrPath(target)}/discussions`, {
        body: comment.body,
        position: {
            position_type: "text",
            base_sha: refs.baseSha,
            start_sha: refs.startSha,
            head_sha: refs.headSha,
            new_path: comment.path,
            new_line: comment.line,
        },
    });
}
/**
 * Resolves the diff refs for inline comments: the pipeline variables when the
 * job is a plain merge request pipeline, otherwise the `diff_refs` block of
 * the merge request itself.
 */
export async function resolveDiffRefs(target) {
    const fromEnv = mrDiffRefs();
    if (fromEnv)
        return fromEnv;
    try {
        const payload = await requestJson(target, mrPath(target));
        const baseSha = payload.diff_refs?.base_sha?.trim();
        const startSha = payload.diff_refs?.start_sha?.trim();
        const headSha = payload.diff_refs?.head_sha?.trim();
        if (!baseSha || !startSha || !headSha)
            return undefined;
        return { baseSha, startSha, headSha };
    }
    catch (error) {
        log.warn(`GitLab: diff_refs не получены — ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
/** Posts a pipeline status for the reviewed commit. Never throws by itself. */
export async function postMrStatus(state, description, sha, target) {
    const resolved = target ?? gitlabTarget();
    if (!resolved || !sha)
        return false;
    try {
        await request(resolved, `/projects/${encodeURIComponent(resolved.projectId)}/statuses/${encodeURIComponent(sha)}`, {
            state,
            name: "oc-pilot",
            description: description.slice(0, 140),
        });
        return true;
    }
    catch (error) {
        log.warn(`Не удалось отправить статус в GitLab: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
/**
 * Posts the review to the merge request: one discussion per finding that maps
 * to a changed line, then the summary note. Outside a merge request pipeline
 * the call is a no-op with a warning, because the same command runs on main
 * where there is nothing to comment on.
 */
export async function postMrReview(summary, comments, cwd, target) {
    const resolved = target ?? gitlabTarget();
    if (!resolved) {
        log.warn("GitLab: не найдены CI_MERGE_REQUEST_IID / CI_PROJECT_ID / CI_API_V4_URL / GITLAB_TOKEN — пропускаю.");
        return { posted: false, inline: 0, summary: false };
    }
    let inline = 0;
    if (comments.length > 0) {
        const refs = await resolveDiffRefs(resolved);
        if (!refs) {
            log.warn("GitLab: не удалось определить base/start/head SHA — inline-комментарии пропущены.");
        }
        else {
            for (const comment of comments) {
                try {
                    await postMrDiscussion(comment, refs, resolved);
                    inline += 1;
                }
                catch (error) {
                    log.warn(`GitLab: inline-комментарий к ${comment.path}:${comment.line} не отправлен — ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    let summaryPosted = false;
    try {
        await postMrNote(summary, resolved);
        summaryPosted = true;
    }
    catch (error) {
        log.warn(`GitLab: заметка не отправлена — ${error instanceof Error ? error.message : String(error)}`);
    }
    if (inline > 0 && summaryPosted) {
        log.success(`Сводка и ${inline} inline-комментариев отправлены в merge request !${resolved.iid} (${cwd}).`);
    }
    else if (inline > 0) {
        log.success(`${inline} inline-комментариев отправлено в merge request !${resolved.iid} (${cwd}).`);
    }
    else if (summaryPosted) {
        log.success(`Сводка отправлена в merge request !${resolved.iid} (${cwd}).`);
    }
    return { posted: summaryPosted || inline > 0, inline, summary: summaryPosted };
}
//# sourceMappingURL=gitlab.js.map