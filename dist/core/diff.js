function unquoteGitPath(value) {
    const body = value.slice(1, -1);
    return body.replace(/\\([0-7]{3}|[\\"ntr])/g, (_match, escape) => {
        if (/^[0-7]{3}$/.test(escape))
            return String.fromCharCode(Number.parseInt(escape, 8));
        switch (escape) {
            case "n":
                return "\n";
            case "t":
                return "\t";
            case "r":
                return "\r";
            default:
                return escape;
        }
    });
}
export function parseGitPath(raw) {
    let value = raw.trim();
    const tab = value.indexOf("\t");
    if (tab >= 0)
        value = value.slice(0, tab);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = unquoteGitPath(value);
    }
    if (value.startsWith("a/") || value.startsWith("b/"))
        value = value.slice(2);
    return value.replace(/\\/g, "/");
}
function pathFromHeader(block) {
    const plus = /^\+\+\+ (.+)$/m.exec(block);
    if (plus && plus[1].trim() !== "/dev/null") {
        return parseGitPath(plus[1]);
    }
    const minus = /^--- (.+)$/m.exec(block);
    if (minus && minus[1].trim() !== "/dev/null") {
        return parseGitPath(minus[1]);
    }
    const header = /^diff --git (.+) (.+)$/m.exec(block);
    if (header) {
        const candidate = header[2].trim();
        return parseGitPath(candidate);
    }
    return "(unknown)";
}
export function splitDiffBlocks(diff) {
    if (!diff.trim())
        return [];
    const starts = [];
    const pattern = /^diff --git /gm;
    for (let match = pattern.exec(diff); match; match = pattern.exec(diff)) {
        starts.push(match.index);
    }
    if (starts.length === 0)
        return [{ path: "(diff)", text: diff }];
    return starts.map((start, index) => {
        const end = index + 1 < starts.length ? starts[index + 1] : diff.length;
        const text = diff.slice(start, end);
        return { path: pathFromHeader(text), text };
    });
}
export function collectChangedFiles(diff) {
    return splitDiffBlocks(diff)
        .map((block) => block.path)
        .filter((path) => path !== "(unknown)" && path !== "(diff)");
}
export function collectDiffStats(diff) {
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            inHunk = false;
            continue;
        }
        if (line.startsWith("@@ ")) {
            inHunk = true;
            continue;
        }
        if (!inHunk)
            continue;
        // Inside a hunk every '+'/'-' line is content, even if the content itself
        // begins with "++" or "--" (which makes the diff line "+++"/"---").
        if (line.startsWith("+"))
            additions += 1;
        else if (line.startsWith("-"))
            deletions += 1;
    }
    return { files: splitDiffBlocks(diff).length, additions, deletions };
}
function cutAtNewline(text, limit) {
    if (text.length <= limit)
        return text;
    const candidate = text.slice(0, limit);
    const newline = candidate.lastIndexOf("\n");
    return newline > limit / 2 ? candidate.slice(0, newline + 1) : candidate;
}
export function truncateDiff(diff, maxChars) {
    if (diff.length <= maxChars) {
        return { text: diff, truncated: false, truncatedFiles: [], omittedFiles: [] };
    }
    const blocks = splitDiffBlocks(diff);
    if (blocks.length === 0) {
        return {
            text: `${cutAtNewline(diff, maxChars)}\n[... diff обрезан: ${diff.length} → ${maxChars} символов ...]\n`,
            truncated: true,
            truncatedFiles: [],
            omittedFiles: [],
        };
    }
    const reserve = 400;
    const perFile = Math.max(600, Math.floor((maxChars - reserve) / blocks.length));
    const parts = [];
    const truncatedFiles = [];
    const omittedFiles = [];
    let used = 0;
    for (const block of blocks) {
        let piece = block.text;
        if (piece.length > perFile) {
            piece = `${cutAtNewline(piece, perFile)}[... файл обрезан: ${block.path} ...]\n`;
            truncatedFiles.push(block.path);
        }
        if (used + piece.length > maxChars) {
            omittedFiles.push(block.path);
            continue;
        }
        parts.push(piece);
        used += piece.length;
    }
    if (omittedFiles.length > 0) {
        parts.push(`[... пропущены файлы из-за лимита: ${omittedFiles.join(", ")} ...]\n`);
    }
    parts.push(`[... diff обрезан до ${maxChars} символов ...]\n`);
    let text = parts.join("");
    if (text.length > maxChars) {
        text = `${cutAtNewline(text, maxChars)}\n[... diff обрезан ...]\n`;
    }
    return { text, truncated: true, truncatedFiles, omittedFiles };
}
export function truncateText(text, maxChars, options = {}) {
    if (text.length <= maxChars)
        return { text, truncated: false, originalLength: text.length };
    const mode = options.mode ?? "head";
    const marker = `[... обрезано: ${text.length} → ${maxChars} символов ...]`;
    if (mode === "tail") {
        return {
            text: `${marker}\n${text.slice(Math.max(0, text.length - maxChars + marker.length + 1))}`,
            truncated: true,
            originalLength: text.length,
        };
    }
    if (mode === "both") {
        const budget = Math.max(0, maxChars - marker.length - 2);
        const head = Math.ceil(budget * 0.6);
        const tail = Math.floor(budget * 0.4);
        return {
            text: `${text.slice(0, head)}\n${marker}\n${text.slice(Math.max(head, text.length - tail))}`,
            truncated: true,
            originalLength: text.length,
        };
    }
    return {
        text: `${cutAtNewline(text, Math.max(0, maxChars - marker.length - 1))}\n${marker}`,
        truncated: true,
        originalLength: text.length,
    };
}
//# sourceMappingURL=diff.js.map