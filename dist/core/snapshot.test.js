import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGit } from "./git.js";
import { createSnapshot, listSnapshots, restoreSnapshot } from "./snapshot.js";
function initRepo() {
    const dir = mkdtempSync(join(tmpdir(), "oc-pilot-snapshot-"));
    runGit(["init"], dir);
    runGit(["config", "user.email", "test@example.com"], dir);
    runGit(["config", "user.name", "Test"], dir);
    runGit(["config", "core.autocrlf", "false"], dir);
    return dir;
}
function commit(dir, file, content, message) {
    writeFileSync(join(dir, file), content, "utf8");
    runGit(["add", file], dir);
    runGit(["commit", "-m", message], dir);
}
test("createSnapshot stores tracked patch, untracked copies and meta", () => {
    const dir = initRepo();
    try {
        commit(dir, "a.txt", "v1\n", "init");
        writeFileSync(join(dir, "a.txt"), "v2\n", "utf8");
        writeFileSync(join(dir, "u.txt"), "untracked\n", "utf8");
        const snapshot = createSnapshot(dir);
        assert.ok(existsSync(join(snapshot.path, "tracked.patch")));
        assert.ok(existsSync(join(snapshot.path, "meta.json")));
        assert.ok(existsSync(join(snapshot.path, "untracked", "u.txt")));
        assert.ok(readFileSync(join(snapshot.path, "tracked.patch"), "utf8").includes("+v2"));
        assert.equal(snapshot.untrackedCount, 1);
        assert.ok(snapshot.tracked);
        const meta = JSON.parse(readFileSync(join(snapshot.path, "meta.json"), "utf8"));
        assert.equal(meta.head, runGit(["rev-parse", "HEAD"], dir).stdout.trim());
        assert.deepEqual(meta.untracked, ["u.txt"]);
        const listed = listSnapshots(dir);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.id, snapshot.id);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("restoreSnapshot returns tracked files and untracked copies, keeps new files", () => {
    const dir = initRepo();
    try {
        commit(dir, "a.txt", "v1\n", "init");
        writeFileSync(join(dir, "a.txt"), "v2\n", "utf8");
        writeFileSync(join(dir, "u.txt"), "untracked\n", "utf8");
        const snapshot = createSnapshot(dir);
        writeFileSync(join(dir, "a.txt"), "v3\n", "utf8");
        rmSync(join(dir, "u.txt"));
        writeFileSync(join(dir, "new.txt"), "after snapshot\n", "utf8");
        const restored = restoreSnapshot(dir, snapshot.id);
        assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "v2\n");
        assert.equal(readFileSync(join(dir, "u.txt"), "utf8"), "untracked\n");
        assert.ok(existsSync(join(dir, "new.txt")), "files created after snapshot must survive");
        assert.ok(restored.tracked);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("restoreSnapshot without id uses the latest snapshot", () => {
    const dir = initRepo();
    try {
        commit(dir, "a.txt", "v1\n", "init");
        writeFileSync(join(dir, "a.txt"), "v2\n", "utf8");
        createSnapshot(dir);
        const restored = restoreSnapshot(dir);
        assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "v2\n");
        assert.ok(restored.id.length > 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("createSnapshot fails in a repo without commits", () => {
    const dir = initRepo();
    try {
        assert.throws(() => createSnapshot(dir), /HEAD/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("restoreSnapshot refuses when HEAD moved after the snapshot", () => {
    const dir = initRepo();
    try {
        commit(dir, "a.txt", "v1\n", "init");
        writeFileSync(join(dir, "a.txt"), "v2\n", "utf8");
        createSnapshot(dir);
        commit(dir, "b.txt", "new\n", "move head");
        assert.throws(() => restoreSnapshot(dir), /HEAD/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=snapshot.test.js.map