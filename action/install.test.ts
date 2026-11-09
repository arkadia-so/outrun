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
 * and a `curl` that writes `download` wherever it is asked to, after failing its first `failures`
 * calls as a 504 does (exit 22). */
const job = (download: string, home?: string, failures = 0) => {
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
    `#!/bin/sh\necho called >> "${root}/curl.log"\n[ "$(wc -l < "${root}/curl.log")" -le ${failures} ] && { echo "curl: (22) The requested URL returned error: 504" >&2; exit 22; }\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { shift; printf %s '${download}' > "$1"; }; shift; done\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${fake}:${process.env.PATH}`,
    // The runner's HOME: a job's own when given (its ~/.bun/bin/bun), else this machine's (Bun's install cache).
    HOME: home ?? process.env.HOME ?? root,
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
    const { root, env, install } = job("not bun", tmpdir());
    const run = install();
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toMatch(/has SHA-256 \w+, expected \w+/);
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toBe("");
    expect(existsSync(join(env.RUNNER_TOOL_CACHE, "outrun-bun", String(bunVersion), "bun"))).toBe(false);
    expect(readFileSync(join(root, "curl.log"), "utf8")).toBe("called\n");
  });

  it("retries Bun's download when it fails once (a 504), then checks what it got", () => {
    const { root, install } = job("not bun", tmpdir(), 1);
    const run = install();
    expect(run.stderr.toString()).toContain("try 1 of 3");
    expect(run.stderr.toString()).toMatch(/has SHA-256 \w+, expected \w+/);
    expect(readFileSync(join(root, "curl.log"), "utf8")).toBe("called\ncalled\n");
  });

  it("gives up on Bun's download after three failed tries, and puts nothing on PATH", () => {
    const { root, env, install } = job("not bun", tmpdir(), 3);
    const run = install();
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("cannot download Bun");
    expect(readFileSync(env.GITHUB_PATH, "utf8")).toBe("");
    expect(readFileSync(join(root, "curl.log"), "utf8")).toBe("called\ncalled\ncalled\n");
  }, 15_000);

  it("downloads Bun when the runner's own ~/.bun/bin/bun is another build than the pinned one", () => {
    const home = mkdtempSync(join(tmpdir(), "outrun-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    writeFileSync(join(home, ".bun", "bin", "bun"), "#!/bin/sh\necho 1.4.4\n", { mode: 0o755 });
    const { root, install } = job("not bun", home);
    const run = install();
    expect(run.stdout.toString()).not.toContain("from the runner");
    expect(readFileSync(join(root, "curl.log"), "utf8")).toBe("called\n");
    expect(run.exitCode).not.toBe(0);
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
