// End to end with --e2e: a repository with a TesterArmy e2e config and no outrun.json, discovered,
// run, replayed, and rerun when the variable naming its app changes. The CLI is a stand-in with
// e2e's interface (`list --reporter json`, `run --reporter …,junit --output <dir> <files>`), and
// `node` a shim onto Bun, so the test needs neither Node nor the real CLI.
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan, test as outrunTest, type TestOptions } from "./engine.ts";
import { FileFailed } from "./errors.ts";

const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new FileFailed({ message: String(e) }) });

const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

// A test file passes when it holds no "FAIL"; every run appends the files it ran to runs.log.
const CLI = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const files = fs.readdirSync("e2e").filter((f) => f.endsWith(".e2e.ts")).map((f) => "e2e/" + f).sort();
if (args[0] === "list") {
  console.log(JSON.stringify({ pairs: files.map((file) => ({ id: file, file, title: "t" })) }));
  process.exit(0);
}
const out = args[args.indexOf("--output") + 1];
const given = args.filter((a, i) => a.endsWith(".e2e.ts") && args[i - 1] !== "--config");
fs.appendFileSync("runs.log", given.join(" ") + " secret=" + (process.env.ACME_SECRET ?? "") + "\\n");
let failed = false;
const suites = given.map((file) => {
  const bad = fs.readFileSync(file, "utf8").includes("FAIL");
  failed ||= bad;
  return '<testsuite name="' + file + '" tests="1" failures="' + (bad ? 1 : 0) + '" errors="0" skipped="0" time="0.250"></testsuite>';
});
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "junit.xml"), '<?xml version="1.0"?>\\n<testsuites name="e2e">\\n' + suites.join("\\n") + "\\n</testsuites>\\n");
process.exit(failed ? 1 : 0);
`;

const setup = () =>
  io(async () => {
    const dir = await mkdtemp(`${tmpdir()}/outrun-e2e-suite-`);
    const bin = await mkdtemp(`${tmpdir()}/outrun-e2e-bin-`);
    await Bun.write(`${bin}/node`, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    await chmod(`${bin}/node`, 0o755);
    const files: Record<string, string> = {
      ".gitignore": "node_modules/\n.e2e/\nruns.log\n",
      "package.json": JSON.stringify({ name: "acme", private: true }),
      "bun.lock": "{}\n",
      "web/e2e.config.ts": "export default { baseURL: process.env.ACME_URL };\n",
      "web/e2e/home.e2e.ts": "// home\n",
      "web/e2e/cart.e2e.ts": "// cart\n",
      "web/src/app.ts": "export const app = 1;\n",
      "node_modules/e2e/dist/cli/bin.js": CLI,
    };
    await Promise.all(Object.entries(files).map(([p, text]) => Bun.write(`${dir}/${p}`, text)));
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    const state = await mkdtemp(`${tmpdir()}/outrun-state-`);
    return { dir, bin, state };
  });

const options = (s: { dir: string; bin: string; state: string }, runId: string, env: Record<string, string> = {}): TestOptions => ({
  cwd: s.dir,
  shard: { index: 1, count: 1 },
  dryRun: false,
  write: false,
  audit: 0,
  runId,
  e2e: true,
  env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, OUTRUN_STATE_DIR: s.state, ACME_URL: "https://a.example.com", ...env },
});

const runs = (dir: string) => io(() => Bun.file(`${dir}/web/runs.log`).text()).pipe(Effect.map((t) => t.trim().split("\n")));

describe("outrun test --e2e", () => {
  it.effect(
    "runs a discovered suite in one CLI, replays it, and reruns it when its app's address or its folder changes",
    () =>
      Effect.gen(function* () {
        const s = yield* setup();
        const first = yield* outrunTest(options(s, "r1", { ACME_SECRET: "s3" }));
        expect([first.units, first.ran, first.failed]).toEqual([2, 2, []]);
        // One CLI for the suite's whole share, with the job's environment (a secret no allow-list names).
        expect(yield* runs(s.dir)).toEqual(["e2e/cart.e2e.ts e2e/home.e2e.ts secret=s3"]);
        expect((yield* outrunTest(options(s, "r2"))).replayed).toBe(2);
        // The config reads ACME_URL: another address is another app under test.
        expect((yield* outrunTest(options(s, "r3", { ACME_URL: "https://b.example.com" }))).ran).toBe(2);
        // Any file of the config's folder is an input of each of its tests (the app is there).
        yield* io(() => Bun.write(`${s.dir}/web/src/app.ts`, "export const app = 2;\n"));
        expect((yield* outrunTest(options(s, "r4"))).ran).toBe(2);
      }),
    60_000,
  );

  it.effect(
    "fails the file that failed, without rerunning it alone, and never replays it",
    () =>
      Effect.gen(function* () {
        const s = yield* setup();
        yield* io(() => Bun.write(`${s.dir}/web/e2e/cart.e2e.ts`, "// FAIL\n"));
        const first = yield* outrunTest(options(s, "f1"));
        expect(first.failed).toEqual(["web/e2e/cart.e2e.ts"]);
        expect(yield* runs(s.dir)).toHaveLength(1);
        const again = yield* outrunTest(options(s, "f2"));
        expect([again.replayed, again.ran, again.failed]).toEqual([1, 1, ["web/e2e/cart.e2e.ts"]]);
      }),
    60_000,
  );

  it.effect(
    "plans the discovered units with no outrun.json",
    () =>
      Effect.gen(function* () {
        const s = yield* setup();
        const out = `${s.state}/plan.json`;
        const planned = yield* plan({ ...options(s, "p1"), out, runners: { max: 16, targetMs: 300_000, startMs: 60_000, slots: 1 } });
        expect(planned.units.map((u) => u.id)).toEqual(["web/e2e/cart.e2e.ts", "web/e2e/home.e2e.ts"]);
      }),
    60_000,
  );
});
