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
async function request(target, path, body) {
    const response = await fetch(`${target.apiUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "PRIVATE-TOKEN": target.token,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 300);
        throw new PilotError(`GitLab API вернул HTTP ${response.status}`, {
            hint: `${detail ? `${detail}\n` : ""}Нужен токен с правом api: GITLAB_TOKEN (CI_JOB_TOKEN не умеет писать заметки).`,
            exitCode: 1,
        });
    }
}
/** Posts one summary note into the merge request. */
export async function postMrNote(body, target) {
    await request(target, `/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.iid}/notes`, {
        body,
    });
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
 * Posts the review summary to the merge request. Outside a merge request
 * pipeline the call is a no-op with a warning, because the same command runs
 * on main where there is nothing to comment on.
 */
export async function postMrSummary(body, cwd, target) {
    const resolved = target ?? gitlabTarget();
    if (!resolved) {
        log.warn("GitLab: не найдены CI_MERGE_REQUEST_IID / CI_PROJECT_ID / CI_API_V4_URL / GITLAB_TOKEN — пропускаю.");
        return false;
    }
    try {
        await postMrNote(body, resolved);
        log.success(`Сводка отправлена в merge request !${resolved.iid} (${cwd}).`);
        return true;
    }
    catch (error) {
        log.warn(`GitLab: заметка не отправлена — ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
//# sourceMappingURL=gitlab.js.map