import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const oss = join(import.meta.dirname, "..");
const bunVersion = /^BUN_VERSION=(\S+)$/m.exec(readFileSync(join(import.meta.dirname, "install.sh"), "utf8"))?.[1];
const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A job's runner folders, the action checked out as GitHub does (its files, no node_modules),
 * and a `curl` that writes `download` wherever it is asked to. */
const job = (download: string) => {
  const root = mkdtempSync(join(tmpdir(), "outrun-action-"));
  dirs.push(root);
  const action = join(root, "action");
  for (const entry of ["action", "src", "package.json", "bun.lock", "tsconfig.json"]) {
    cpSync(join(oss, entry), join(action, entry), { recursive: true });
  }
  const fake = join(root, "fake-bin");
  mkdirSync(fake);
  writeFileSync(
    join(fake, "curl"),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { shift; printf %s '${download}' > "$1"; }; shift; done\necho called >> "${root}/curl.log"\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${fake}:${process.env.PATH}`,
    HOME: process.env.HOME ?? root,
    RUNNER_TOOL_CACHE: join(root, "tool-cache"),
    RUNNER_TEMP: join(root, "temp"),
    GITHUB_PATH: join(root, "github-path"),
  };
  mkdirSync(env.RUNNER_TEMP);
  writeFileSync(env.GITHUB_PATH, "");
  const install = () => Bun.spawnSync(["sh", join(action, "action", "install.sh")], { env });
  return { root, env, install };
};

describe("the GitHub Action", () => {
  it("refuses a Bun download whose SHA-256 is not the pinned one, and puts nothing on PATH", () => {
    const { root, env, install } = job("not bun");
    const run = install();
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toMatch(/has SHA-256 \w+, expected \w+/);
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toBe("");
    expect(existsSync(join(env.RUNNER_TOOL_CACHE, "outrun-bun", String(bunVersion), "bun"))).toBe(false);
    expect(readFileSync(join(root, "curl.log"), "utf8")).toBe("called\n");
  });

  it("puts on PATH an `outrun` that runs the action's own sources, on the Bun of the tool cache", () => {
    const { root, env, install } = job("");
    const cached = join(env.RUNNER_TOOL_CACHE, "outrun-bun", String(bunVersion));
    mkdirSync(cached, { recursive: true });
    symlinkSync(process.execPath, join(cached, "bun"));

    const run = install();
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(root, "curl.log"))).toBe(false);
    const bin = readFileSync(env.GITHUB_PATH, "utf8").trim();
    expect(bin).toBe(join(env.RUNNER_TEMP, "outrun-bin"));

    const pkg = JSON.parse(readFileSync(join(oss, "package.json"), "utf8")) as { version: string };
    const outrun = Bun.spawnSync([join(bin, "outrun"), "--version"]);
    expect(outrun.stdout.toString().trim()).toBe(`outrun v${pkg.version}`);
    // Real work, not a hang: `bun install` from Bun's install cache (HOME's, 0.3-0.7 s) and two cold
    // starts of the CLI's sources (`outrun --version`, 1.2-4 s each under load). Measured 3.7-5.6 s
    // alone on a laptop at load average 115-250 (2026-11-07), 7.8 s in CI run 42262946102, past
    // vitest's 5 s default.
  }, 30_000);
});
