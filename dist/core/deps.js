const POPULAR_PACKAGES = {
    npm: [
        "react", "react-dom", "vue", "express", "axios", "lodash", "underscore",
        "chalk", "commander", "typescript", "webpack", "vite", "jest", "mocha",
        "eslint", "prettier", "dotenv", "mongoose", "sequelize", "prisma",
        "next", "svelte", "zod", "uuid", "glob", "minimist", "qs", "cross-env",
        "nanoid", "fs-extra", "dayjs", "moment", "ramda", "jquery", "core-js",
        "tslib", "got", "node-fetch", "yaml", "joi", "winston", "pino",
    ],
    pypi: [
        "requests", "flask", "django", "numpy", "pandas", "pytest", "urllib3",
        "cryptography", "pyyaml", "sqlalchemy", "pillow", "click", "fastapi",
        "httpx", "aiohttp", "boto3", "botocore", "redis", "celery", "marshmallow",
    ],
};
function levenshtein(a, b) {
    if (a === b)
        return 0;
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
        }
        previous = current;
    }
    return previous[b.length];
}
/** Near-match against well-known package names (edit distance 1-2, length >= 4). */
function typosquatOf(name, ecosystem) {
    const popular = POPULAR_PACKAGES[ecosystem];
    if (!popular || name.length < 4)
        return undefined;
    for (const candidate of popular) {
        if (candidate === name)
            return undefined;
        const distance = levenshtein(name, candidate);
        if (distance > 0 && distance <= 2 && Math.abs(name.length - candidate.length) <= 2) {
            return candidate;
        }
    }
    return undefined;
}
function specRisks(spec) {
    const risks = [];
    const value = spec.trim();
    if (value === "" || value === "*" || value === "latest")
        risks.push("unpinned");
    if (/^(git\+|github:|git@|https?:\/\/|file:)/i.test(value))
        risks.push("vcs-or-url reference");
    return risks;
}
const JSON_DEPENDENCY_LINE = /^\+\s*"([^"@][^"]*)"\s*:\s*"([^"]*)"/;
const MANIFESTS = [
    {
        ecosystem: "npm",
        match: (file) => file.endsWith("package.json") || file.endsWith("package-lock.json") === false && file.endsWith("npm-shrinkwrap.json") === false && /(^|\/)package\.json$/.test(file),
        parse: (line) => {
            const match = JSON_DEPENDENCY_LINE.exec(line);
            if (!match)
                return undefined;
            const name = match[1].trim();
            if (!name || name.startsWith("@types/") === false && !/^[@a-zA-Z]/.test(name))
                return undefined;
            return { name, spec: match[2] };
        },
    },
    {
        ecosystem: "pypi",
        match: (file) => file === "requirements.txt" || file.endsWith("/requirements.txt") || file.endsWith("pyproject.toml"),
        parse: (line) => {
            const requirement = /^\+\s*([A-Za-z0-9_.\-]+)\s*(?:[=<>~!]=?|\[)[^\s]*/.exec(line);
            if (requirement)
                return { name: requirement[1], spec: line.slice(1).trim() };
            const pyproject = /^\+\s*([A-Za-z0-9_.\-]+)\s*=\s*"[^"]*"/.exec(line);
            if (pyproject)
                return { name: pyproject[1], spec: line.slice(1).trim() };
            return undefined;
        },
    },
    {
        ecosystem: "go",
        match: (file) => file === "go.mod" || file.endsWith("/go.mod"),
        parse: (line) => {
            const require = /^\+\s*([\w./~-]+)\s+(v[\w.\-+]+)/.exec(line);
            return require ? { name: require[1], spec: require[2] } : undefined;
        },
    },
    {
        ecosystem: "cargo",
        match: (file) => file === "Cargo.toml" || file.endsWith("/Cargo.toml"),
        parse: (line) => {
            const crate = /^\+\s*([\w-]+)\s*=\s*(".*|\{.*)/.exec(line);
            return crate ? { name: crate[1], spec: line.slice(1).trim() } : undefined;
        },
    },
    {
        ecosystem: "rubygems",
        match: (file) => file === "Gemfile" || file.endsWith("/Gemfile"),
        parse: (line) => {
            const gem = /^\+\s*gem\s+"([^"]+)"(.*)/.exec(line);
            return gem ? { name: gem[1], spec: gem[2].trim().replace(/[",]/g, "") } : undefined;
        },
    },
    {
        ecosystem: "packagist",
        match: (file) => file.endsWith("composer.json"),
        parse: (line) => {
            const match = JSON_DEPENDENCY_LINE.exec(line);
            return match ? { name: match[1].trim(), spec: match[2] } : undefined;
        },
    },
    {
        ecosystem: "maven",
        match: (file) => file.endsWith("pom.xml") || file.endsWith(".gradle") || file.endsWith(".gradle.kts"),
        parse: (line) => {
            const artifact = /^\+\s*(?:<artifactId>|["'])([\w.-]+)(?:<\/artifactId>|["'])/.exec(line);
            return artifact ? { name: artifact[1], spec: "" } : undefined;
        },
    },
    {
        ecosystem: "nuget",
        match: (file) => file.endsWith(".csproj") || file.endsWith("packages.config"),
        parse: (line) => {
            const reference = /^\+\s*<PackageReference\s+Include="([^"]+)"/.exec(line);
            if (reference)
                return { name: reference[1], spec: "" };
            const legacy = /^\+\s*<package\s+id="([^"]+)"/.exec(line);
            return legacy ? { name: legacy[1], spec: "" } : undefined;
        },
    },
];
const MAX_DEPENDENCY_FINDINGS = 50;
/** Scans a unified diff for added dependency declarations and risk signals. */
export function analyzeDependencyChanges(diff) {
    const findings = [];
    const seen = new Set();
    let file = "";
    for (const rawLine of diff.split(/\r?\n/)) {
        if (rawLine.startsWith("+++ ")) {
            file = rawLine.slice(4).replace(/^b\//, "").trim();
            continue;
        }
        if (!rawLine.startsWith("+") || rawLine.startsWith("+++"))
            continue;
        if (file === "/dev/null")
            continue;
        const manifest = MANIFESTS.find((rule) => rule.match(file));
        if (!manifest)
            continue;
        const parsed = manifest.parse(rawLine);
        if (!parsed)
            continue;
        const risks = ["new dependency", ...specRisks(parsed.spec)];
        const typosquat = typosquatOf(parsed.name, manifest.ecosystem);
        if (typosquat)
            risks.push(`possible typosquat of ${typosquat}`);
        const key = `${manifest.ecosystem}:${parsed.name}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        findings.push({ ecosystem: manifest.ecosystem, name: parsed.name, spec: parsed.spec, risks, file });
        if (findings.length >= MAX_DEPENDENCY_FINDINGS)
            break;
    }
    return findings;
}
/** Renders findings for the prompt context block. */
export function describeDependencyFindings(findings) {
    return findings
        .map((finding) => `- ${finding.ecosystem}: ${finding.name}${finding.spec ? ` (${finding.spec})` : ""} — ${finding.risks.join(", ")}`)
        .join("\n");
}
//# sourceMappingURL=deps.js.map