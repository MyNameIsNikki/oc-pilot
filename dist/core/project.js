import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const MARKERS = [
    { file: "go.mod", type: "Go" },
    { file: "Cargo.toml", type: "Rust" },
    { file: "tsconfig.json", type: "TypeScript" },
    { file: "package.json", type: "JavaScript" },
    { file: "pyproject.toml", type: "Python" },
    { file: "requirements.txt", type: "Python" },
    { file: "setup.py", type: "Python" },
    { file: "Pipfile", type: "Python" },
    { file: "pom.xml", type: "Java" },
    { file: "build.gradle", type: "Java/Kotlin" },
    { file: "build.gradle.kts", type: "Kotlin" },
    { file: "Gemfile", type: "Ruby" },
    { file: "composer.json", type: "PHP" },
    { file: "Package.swift", type: "Swift" },
    { file: "mix.exs", type: "Elixir" },
    { file: "pubspec.yaml", type: "Dart" },
    { file: "CMakeLists.txt", type: "C/C++" },
];
const EXTENSIONS = {
    ".go": "Go",
    ".rs": "Rust",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".pyi": "Python",
    ".java": "Java",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".cs": "C#",
    ".c": "C/C++",
    ".h": "C/C++",
    ".cc": "C/C++",
    ".cpp": "C/C++",
    ".cxx": "C/C++",
    ".hpp": "C/C++",
    ".rb": "Ruby",
    ".php": "PHP",
    ".swift": "Swift",
    ".scala": "Scala",
    ".ex": "Elixir",
    ".exs": "Elixir",
    ".dart": "Dart",
    ".sh": "Shell",
    ".ps1": "PowerShell",
    ".sql": "SQL",
    ".lua": "Lua",
};
function readJson(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // Ignore malformed project manifests; language detection is best-effort.
    }
    return undefined;
}
function packageJsonType(cwd, changedFiles) {
    const packageJson = readJson(join(cwd, "package.json"));
    const dependencies = {
        ...packageJson?.dependencies,
        ...packageJson?.devDependencies,
    };
    const hasTypeScript = existsSync(join(cwd, "tsconfig.json")) ||
        Object.prototype.hasOwnProperty.call(dependencies, "typescript") ||
        changedFiles.some((file) => /\.(?:ts|tsx|mts|cts)$/i.test(file));
    return hasTypeScript ? "TypeScript" : "JavaScript";
}
export function languageFromPath(file) {
    const match = /(\.[A-Za-z0-9]+)$/.exec(file);
    return match ? EXTENSIONS[match[1].toLowerCase()] : undefined;
}
/**
 * Detects the dominant language/stack from manifests and changed files.
 * Returns a short human-readable label suitable for PROJECT_TYPE.
 */
export function detectProjectType(cwd, changedFiles = []) {
    const fromChanges = [];
    for (const file of changedFiles) {
        const language = languageFromPath(file);
        if (language && !fromChanges.includes(language))
            fromChanges.push(language);
    }
    // The files actually under review are the best signal, especially in
    // polyglot repositories. Manifests are the fallback.
    if (fromChanges.length > 0) {
        if (fromChanges.length === 1)
            return fromChanges[0];
        return `Mixed (${fromChanges.slice(0, 5).join(", ")})`;
    }
    const detected = [];
    for (const marker of MARKERS) {
        if (!existsSync(join(cwd, marker.file)))
            continue;
        const type = marker.file === "package.json" ? packageJsonType(cwd, changedFiles) : marker.type;
        if (!detected.includes(type))
            detected.push(type);
    }
    if (detected.length === 0)
        return "Unknown";
    if (detected.length === 1)
        return detected[0];
    return `Mixed (${detected.slice(0, 5).join(", ")})`;
}
function packageManager(cwd) {
    if (existsSync(join(cwd, "pnpm-lock.yaml")))
        return { test: "pnpm test" };
    if (existsSync(join(cwd, "yarn.lock")))
        return { test: "yarn test" };
    if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) {
        return { test: "bun test" };
    }
    return { test: "npm test" };
}
/**
 * Best-effort detection of the project's test command. Returns undefined when
 * the stack is ambiguous; callers should then require --command or config.
 */
export function detectTestCommand(cwd) {
    const packageJsonPath = join(cwd, "package.json");
    if (existsSync(packageJsonPath)) {
        const packageJson = readJson(packageJsonPath);
        const scripts = packageJson?.scripts;
        if (typeof scripts?.test === "string" && !/no test specified/i.test(scripts.test)) {
            return { command: packageManager(cwd).test, source: "package.json → scripts.test" };
        }
    }
    if (existsSync(join(cwd, "go.mod")))
        return { command: "go test ./...", source: "go.mod" };
    if (existsSync(join(cwd, "Cargo.toml")))
        return { command: "cargo test", source: "Cargo.toml" };
    for (const file of ["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg", "requirements.txt"]) {
        if (existsSync(join(cwd, file)))
            return { command: "python -m pytest", source: file };
    }
    if (existsSync(join(cwd, "pom.xml")))
        return { command: "mvn test", source: "pom.xml" };
    if (existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) {
        const wrapper = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
        return {
            command: existsSync(join(cwd, process.platform === "win32" ? "gradlew.bat" : "gradlew"))
                ? `${wrapper} test`
                : "gradle test",
            source: "Gradle",
        };
    }
    if (existsSync(join(cwd, "Package.swift")))
        return { command: "swift test", source: "Package.swift" };
    if (existsSync(join(cwd, "mix.exs")))
        return { command: "mix test", source: "mix.exs" };
    if (existsSync(join(cwd, "pubspec.yaml")))
        return { command: "dart test", source: "pubspec.yaml" };
    if (existsSync(join(cwd, "Gemfile"))) {
        return existsSync(join(cwd, "spec"))
            ? { command: "bundle exec rspec", source: "Gemfile + spec/" }
            : { command: "bundle exec rake test", source: "Gemfile" };
    }
    if (existsSync(join(cwd, "composer.json")))
        return { command: "composer test", source: "composer.json" };
    try {
        const csproj = readdirSync(cwd).find((file) => file.endsWith(".csproj") || file.endsWith(".sln"));
        if (csproj)
            return { command: "dotnet test", source: csproj };
    }
    catch {
        // Ignore unreadable directories.
    }
    if (existsSync(join(cwd, "Makefile"))) {
        try {
            if (/^test\s*:/m.test(readFileSync(join(cwd, "Makefile"), "utf8"))) {
                return { command: "make test", source: "Makefile" };
            }
        }
        catch {
            // Ignore unreadable Makefile.
        }
    }
    return undefined;
}
//# sourceMappingURL=project.js.map