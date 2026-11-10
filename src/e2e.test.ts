// End to end with --e2e: a repository with a TesterArmy e2e config and no outrun.json, discovered,
// run, replayed, and rerun when the variable naming its app changes. The CLI is a stand-in with
// e2e's interface (`list --reporter json`, `run --reporter …,junit --output <dir> <files>`), and
// `node` a shim onto Bun, so the test needs neither Node nor the real CLI.
import { chmod, rm } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan, planCached, test as outrunTest, type TestOptions } from "./engine.ts";
import { FileFailed } from "./errors.ts";
import { tempDir } from "./test-tmp.ts";

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

// Tests within files: each line `test <name> [@tag] [FAIL]` or `serial <group> <name> ...` declares a
// test at that line (a serial group's members run together); `list` applies --exclude-tag, `run` takes
// `file:line` positionals and writes e2e's report.json, one result per test with its line.
const CLI_TESTS = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const files = fs.readdirSync("e2e").filter((f) => f.endsWith(".e2e.ts")).map((f) => "e2e/" + f).sort();
const excluded = args.flatMap((a, i) => (a === "--exclude-tag" ? [args[i + 1]] : []));
const tests = files.flatMap((file) =>
  fs.readFileSync(file, "utf8").split("\\n").flatMap((text, i) => {
    const w = text.trim().split(/\\s+/);
    if (w[0] !== "test" && w[0] !== "serial") return [];
    const serialId = w[0] === "serial" ? w[1] : undefined;
    const title = serialId ? w[2] : w[1];
    const tags = w.filter((x) => x.startsWith("@")).map((x) => x.slice(1));
    if (tags.some((t) => excluded.includes(t))) return [];
    return [{ file, title, titlePath: serialId ? [serialId, title] : [title], tags, source: { file, line: i + 1, column: 1 }, ...(serialId ? { serialId } : {}), fail: w.includes("FAIL") }];
  }),
);
if (args[0] === "list") {
  fs.appendFileSync("lists.log", args.slice(1).join(" ") + "\\n");
  console.log(JSON.stringify({ pairs: tests.map(({ fail, ...t }) => ({ id: t.file + t.title, kind: "test", ...t })) }));
  process.exit(0);
}
const out = args[args.indexOf("--output") + 1];
const given = args.filter((a) => /\\.e2e\\.ts:\\d+$/.test(a));
fs.appendFileSync("runs.log", given.join(" ") + "\\n");
const at = new Set(given);
const groups = new Set(tests.filter((t) => t.serialId && at.has(t.file + ":" + t.source.line)).map((t) => t.file + t.serialId));
const ran = tests.filter((t) => at.has(t.file + ":" + t.source.line) || (t.serialId && groups.has(t.file + t.serialId)));
const results = ran.map((t) => ({ file: t.file, source: t.source, titlePath: t.titlePath, serialGroupId: t.serialId ? t.file + t.serialId : null, status: t.fail ? "failed" : "passed", attempts: [{ durationMs: 100 }] }));
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ run: { errors: [], results } }));
fs.writeFileSync(path.join(out, "junit.xml"), '<?xml version="1.0"?>\\n<testsuites name="e2e"></testsuites>\\n');
process.exit(ran.some((t) => t.fail) ? 1 : 0);
`;

const setup = (cli = CLI, tests: Record<string, string> = {}) =>
  io(async () => {
    const dir = await tempDir("outrun-e2e-suite-");
    const bin = await tempDir("outrun-e2e-bin-");
    await Bun.write(`${bin}/node`, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    await chmod(`${bin}/node`, 0o755);
    const files: Record<string, string> = {
      ".gitignore": "node_modules/\n.e2e/\nruns.log\nlists.log\n",
      "package.json": JSON.stringify({ name: "acme", private: true }),
      "bun.lock": "{}\n",
      "web/e2e.config.ts": "export default { baseURL: process.env.ACME_URL };\n",
      ...(cli === CLI ? { "web/e2e/home.e2e.ts": "// home\n", "web/e2e/cart.e2e.ts": "// cart\n" } : tests),
      "web/src/app.ts": "export const app = 1;\n",
      "node_modules/e2e/dist/cli/bin.js": cli,
    };
    await Promise.all(Object.entries(files).map(([p, text]) => Bun.write(`${dir}/${p}`, text)));
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    const state = await tempDir("outrun-state-");
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

  it.effect(
    "plans with no install once the config was listed with these inputs, and its shards' keys are the plan's",
    () =>
      Effect.gen(function* () {
        const s = yield* setup();
        const out = `${s.state}/plan.json`;
        const runners = { max: 16, targetMs: 300_000, startMs: 60_000, slots: 1 };
        // Never listed: no plan without the CLI.
        expect(yield* planCached({ ...options(s, "c1"), out, runners })).toBeUndefined();
        const listed = yield* plan({ ...options(s, "c2"), out, runners });
        // The CLI gone (the plan job before its install): the kept listing plans the same units, same keys.
        yield* io(() => rm(`${s.dir}/node_modules`, { recursive: true }));
        const cached = yield* planCached({ ...options(s, "c3"), out, runners });
        expect(cached?.units).toEqual(listed.units);
        // An edit of the app is no new listing (its tests rerun, from the plan's keys).
        yield* io(() => Bun.write(`${s.dir}/web/src/app.ts`, "export const app = 3;\n"));
        const edited = yield* planCached({ ...options(s, "c3b"), out, runners });
        expect(edited?.units.map((u) => u.id)).toEqual(listed.units.map((u) => u.id));
        expect(edited?.units[0]?.key).not.toBe(listed.units[0]?.key);
        // A new build of the app (its key, OUTRUN_E2E_APP) is no new listing either.
        const rebuilt = yield* planCached({ ...options(s, "c3c", { OUTRUN_E2E_APP: "k9" }), out, runners });
        expect(rebuilt?.units.map((u) => u.id)).toEqual(listed.units.map((u) => u.id));
        expect(rebuilt?.units[0]?.key).not.toBe(edited?.units[0]?.key);
        // A new test file is a new listing: none is kept for it.
        yield* io(() => Bun.write(`${s.dir}/web/e2e/search.e2e.ts`, "// search\n"));
        git(s.dir, "add", ".");
        expect(yield* planCached({ ...options(s, "c4"), out, runners })).toBeUndefined();
      }),
    60_000,
  );

  it.effect(
    "replays and keeps the listing across runs whose sources read the run's own id (GITHUB_RUN_ID)",
    () =>
      Effect.gen(function* () {
        const s = yield* setup();
        // A fixture names its data after the run (a telemetry test's unique id, say).
        yield* io(() => Bun.write(`${s.dir}/web/e2e/fixture.ts`, "export const id = process.env.GITHUB_RUN_ID + process.env.RUNNER_NAME;\n"));
        git(s.dir, "add", ".");
        git(s.dir, "commit", "-qm", "fixture");
        const out = `${s.state}/plan.json`;
        const runners = { max: 16, targetMs: 300_000, startMs: 60_000, slots: 1 };
        const once = { GITHUB_RUN_ID: "1001", RUNNER_NAME: "outrun-a" };
        const again = { GITHUB_RUN_ID: "1002", GITHUB_RUN_ATTEMPT: "2", RUNNER_NAME: "outrun-b" };
        const first = yield* plan({ ...options(s, "g1", once), out, runners });
        // Another run of the same commit, on another runner: its listing is kept, and its keys are the same.
        const cached = yield* planCached({ ...options(s, "g2", again), out, runners });
        expect(cached?.units.map((u) => u.key)).toEqual(first.units.map((u) => u.key));
        expect((yield* outrunTest(options(s, "g1", once))).ran).toBe(2);
        expect((yield* outrunTest(options(s, "g2", again))).replayed).toBe(2);
      }),
    60_000,
  );

  it.effect(
    "reruns every test of the suite when the app built for it changes (OUTRUN_E2E_APP)",
    () =>
      Effect.gen(function* () {
        const s = yield* setup();
        expect((yield* outrunTest(options(s, "a1", { OUTRUN_E2E_APP: "k1" }))).ran).toBe(2);
        expect((yield* outrunTest(options(s, "a2", { OUTRUN_E2E_APP: "k1" }))).replayed).toBe(2);
        expect((yield* outrunTest(options(s, "a3", { OUTRUN_E2E_APP: "k2" }))).ran).toBe(2);
      }),
    60_000,
  );
});

describe("outrun e2e: a unit per test", () => {
  const files = {
    "web/e2e/long.e2e.ts": "test one\ntest two\nserial checkout pay\nserial checkout refund\ntest five @release\n",
    "web/e2e/cart.e2e.ts": "test cart\n",
  };
  const runners = { max: 16, targetMs: 1_000, startMs: 0, slots: 1 };

  it.effect(
    "makes each test a unit by its line, a serial group one unit at its first line, and spreads one file's tests over runners",
    () =>
      Effect.gen(function* () {
        const s = yield* setup(CLI_TESTS, files);
        const planned = yield* plan({ ...options(s, "t1"), out: `${s.state}/plan.json`, runners });
        expect(planned.units.map((u) => u.id).sort()).toEqual([
          "web/e2e/cart.e2e.ts:1",
          "web/e2e/long.e2e.ts:1",
          "web/e2e/long.e2e.ts:2",
          "web/e2e/long.e2e.ts:3",
          "web/e2e/long.e2e.ts:5",
        ]);
        // Five tests of a minute each (never timed), a target of a second: a runner each.
        expect(new Set(planned.units.map((u) => u.runner)).size).toBe(5);
      }),
    60_000,
  );

  it.effect(
    "runs the tests by their lines, fails only the test that failed, and replays the others",
    () =>
      Effect.gen(function* () {
        const s = yield* setup(CLI_TESTS, { ...files, "web/e2e/long.e2e.ts": files["web/e2e/long.e2e.ts"].replace("test two", "test two FAIL") });
        const first = yield* outrunTest(options(s, "t2"));
        expect([first.units, first.ran, first.failed]).toEqual([5, 5, ["web/e2e/long.e2e.ts:2"]]);
        expect(yield* runs(s.dir)).toEqual(["e2e/cart.e2e.ts:1 e2e/long.e2e.ts:1 e2e/long.e2e.ts:2 e2e/long.e2e.ts:3 e2e/long.e2e.ts:5"]);
        const again = yield* outrunTest(options(s, "t3"));
        // The failed test runs again; the passes of the same file replay.
        expect([again.replayed, again.ran, again.failed]).toEqual([4, 1, ["web/e2e/long.e2e.ts:2"]]);
      }),
    60_000,
  );

  it.effect(
    "applies OUTRUN_E2E_FILTER when listing, keys on it, and refuses what is not a selection flag",
    () =>
      Effect.gen(function* () {
        const s = yield* setup(CLI_TESTS, files);
        const out = `${s.state}/plan.json`;
        const all = yield* plan({ ...options(s, "x1"), out, runners });
        const some = yield* plan({ ...options(s, "x2", { OUTRUN_E2E_FILTER: "--exclude-tag release" }), out, runners });
        expect(some.units.map((u) => u.id)).not.toContain("web/e2e/long.e2e.ts:5");
        expect(some.units).toHaveLength(4);
        // The same test under a filter is another command: another key.
        const key = (p: typeof all, id: string) => p.units.find((u) => u.id === id)?.key;
        expect(key(some, "web/e2e/cart.e2e.ts:1")).not.toBe(key(all, "web/e2e/cart.e2e.ts:1"));
        expect((yield* io(() => Bun.file(`${s.dir}/web/lists.log`).text())).trim().split("\n")).toContain(
          "--reporter json --config e2e.config.ts --exclude-tag release --pass-with-no-tests",
        );
        // The shards run with the filter too, given only the selected tests.
        const ran = yield* outrunTest(options(s, "x3", { OUTRUN_E2E_FILTER: "--exclude-tag=release" }));
        expect(ran.ran).toBe(4);
        // Each test's own duration (100 ms in the report) is learned: a second's target now fits them on one runner.
        yield* io(() => Bun.write(`${s.dir}/web/src/app.ts`, "export const app = 4;\n"));
        const timed = yield* plan({ ...options(s, "x3b", { OUTRUN_E2E_FILTER: "--exclude-tag release" }), out, runners });
        expect(new Set(timed.units.map((u) => u.runner)).size).toBe(1);
        const refused = yield* Effect.flip(plan({ ...options(s, "x4", { OUTRUN_E2E_FILTER: "--retries 3" }), out, runners }));
        expect(refused.message).toContain("OUTRUN_E2E_FILTER");
      }),
    60_000,
  );
});
