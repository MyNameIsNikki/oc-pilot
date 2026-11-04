import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareVersions, detectLockfile, lockfileHint, readLockfile } from "./lockfile.js";

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-pilot-lockfile-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

test("detectLockfile prefers npm, then pnpm, then yarn", () => {
  const all = makeRepo({
    "yarn.lock": "",
    "pnpm-lock.yaml": "lockfileVersion: 6.0\n",
    "package-lock.json": "{}",
  });
  try {
    assert.equal(detectLockfile(all)?.kind, "npm");
  } finally {
    rmSync(all, { recursive: true, force: true });
  }

  const pnpmAndYarn = makeRepo({ "yarn.lock": "", "pnpm-lock.yaml": "lockfileVersion: 6.0\n" });
  try {
    assert.equal(detectLockfile(pnpmAndYarn)?.kind, "pnpm");
  } finally {
    rmSync(pnpmAndYarn, { recursive: true, force: true });
  }

  const none = makeRepo({ "package.json": "{}" });
  try {
    assert.equal(detectLockfile(none), undefined);
    assert.equal(readLockfile(none), undefined);
  } finally {
    rmSync(none, { recursive: true, force: true });
  }
});

test("readLockfile reads npm v3 packages", () => {
  const dir = makeRepo({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "demo", dependencies: { "left-pad": "^1.3.0" } },
        "node_modules/left-pad": { version: "1.3.0" },
        "node_modules/@scope/pkg": { version: "2.0.0", dependencies: { "left-pad": "^1.3.0" } },
      },
    }),
  });
  try {
    const lock = readLockfile(dir);
    assert.equal(lock?.kind, "npm");
    assert.equal(lock?.file, "package-lock.json");
    assert.deepEqual(
      lock?.packages.map((entry) => [entry.name, entry.version]).sort(),
      [
        ["@scope/pkg", "2.0.0"],
        ["left-pad", "1.3.0"],
      ],
    );
    assert.deepEqual(lock?.packages.find((entry) => entry.name === "@scope/pkg")?.deps, { "left-pad": "^1.3.0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLockfile walks npm v1 dependencies", () => {
  const dir = makeRepo({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        "left-pad": { version: "1.3.0", dependencies: { nested: { version: "0.1.0" } } },
      },
    }),
  });
  try {
    const lock = readLockfile(dir);
    assert.deepEqual(
      lock?.packages.map((entry) => [entry.name, entry.version]).sort(),
      [
        ["left-pad", "1.3.0"],
        ["nested", "0.1.0"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLockfile reads pnpm v6 packages", () => {
  const dir = makeRepo({
    "pnpm-lock.yaml": [
      "lockfileVersion: 5.4",
      "packages:",
      "  /left-pad@1.3.0:",
      "    resolution: {integrity: sha512-x}",
      "  /@scope/pkg@2.0.0(peer@1.0.0):",
      "    dependencies:",
      "      left-pad: 1.3.0",
      "",
    ].join("\n"),
  });
  try {
    const lock = readLockfile(dir);
    assert.equal(lock?.kind, "pnpm");
    assert.equal(lock?.versions.get("left-pad"), "1.3.0");
    assert.equal(lock?.versions.get("@scope/pkg"), "2.0.0");
    assert.deepEqual(lock?.packages.find((entry) => entry.name === "@scope/pkg")?.deps, { "left-pad": "1.3.0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLockfile keeps dependencies from pnpm v9 snapshots", () => {
  const dir = makeRepo({
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "packages:",
      "  /foo@2.0.0:",
      "    resolution: {integrity: sha512-y}",
      "snapshots:",
      "  /foo@2.0.0:",
      "    dependencies:",
      "      bar: 1.0.0",
      "  /bar@1.0.0: {}",
      "",
    ].join("\n"),
  });
  try {
    const lock = readLockfile(dir);
    assert.equal(lock?.versions.get("foo"), "2.0.0");
    assert.deepEqual(lock?.packages.find((entry) => entry.name === "foo")?.deps, { bar: "1.0.0" });
    assert.equal(lock?.packages.find((entry) => entry.name === "bar")?.version, "1.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLockfile reads yarn v1 and berry syntax", () => {
  const v1 = makeRepo({
    "yarn.lock": ['left-pad@^1.3.0:', '  version "1.3.0"', '  resolved "https://registry/x"', ""].join("\n"),
  });
  try {
    const lock = readLockfile(v1);
    assert.equal(lock?.kind, "yarn");
    assert.equal(lock?.versions.get("left-pad"), "1.3.0");
  } finally {
    rmSync(v1, { recursive: true, force: true });
  }

  const berry = makeRepo({
    "yarn.lock": [
      '"@scope/pkg@npm:^2.0.0":',
      "  version: 2.0.0",
      "  resolution: \"@scope/pkg@npm:2.0.0\"",
      "",
    ].join("\n"),
  });
  try {
    const lock = readLockfile(berry);
    assert.equal(lock?.versions.get("@scope/pkg"), "2.0.0");
  } finally {
    rmSync(berry, { recursive: true, force: true });
  }
});

test("readLockfile keeps the highest resolved version", () => {
  const dir = makeRepo({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/a/node_modules/shared": { version: "2.1.0" },
        "node_modules/shared": { version: "1.0.0" },
      },
    }),
  });
  try {
    assert.equal(readLockfile(dir)?.versions.get("shared"), "2.1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLockfile tolerates a corrupt lockfile", () => {
  const dir = makeRepo({ "package-lock.json": "{not json" });
  try {
    const lock = readLockfile(dir);
    assert.equal(lock?.kind, "npm");
    assert.deepEqual(lock?.packages, []);
    assert.equal(lock?.versions.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compareVersions orders numeric segments", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("2.0.0", "2.0.0") === 0);
  assert.ok(compareVersions("1.0.0-beta", "1.0.0") < 0);
});

test("lockfileHint names the right install command", () => {
  assert.match(lockfileHint("npm"), /npm ci/);
  assert.match(lockfileHint("pnpm"), /frozen-lockfile/);
  assert.match(lockfileHint("yarn"), /immutable/);
});
