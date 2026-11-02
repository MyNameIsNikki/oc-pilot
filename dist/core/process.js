import { spawn } from "node:child_process";
export function killProcessTree(child) {
    if (child.pid === undefined)
        return;
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
        });
        return;
    }
    try {
        child.kill("SIGTERM");
    }
    catch {
        // The process may already be gone.
    }
    setTimeout(() => {
        try {
            child.kill("SIGKILL");
        }
        catch {
            // The process may already be gone.
        }
    }, 2_000).unref();
}
//# sourceMappingURL=process.js.map