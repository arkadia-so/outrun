// End to end: a git repository with a bun workspace, run, re-run, changed, failed.
import { chmod, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { blocking, contextDiff, deadlineMs, lookupCommand, plan, recordCommand, test as outrunTest, type TestOptions } from "./engine.ts";
import { FileFailed } from "./errors.ts";
import { tempDir } from "./test-tmp.ts";

const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new FileFailed({ message: String(e) }) });

const write = (dir: string, files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await Bun.write(`${dir}/${path}`, text);
    }),
  );

const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

const setup = (extra: Record<string, string> = {}) =>
  io(async () => {
    const dir = await tempDir("outrun-e2e-");
    await write(dir, {
      ...extra,
      "package.json": JSON.stringify({ name: "acme", private: true }),
      "outrun.json": JSON.stringify({
        inputs: ["package.json"],
        suites: [{ name: "unit", adapter: "bun", dir: ".", tests: ["test/*.test.ts"], run: ["bun", "test"] }],
        commands: [{ name: "build", run: "bun build src/math.ts", inputs: ["src/**"] }],
      }),
      "src/math.ts": "export const add = (a: number, b: number) => a + b\n",
      "src/text.ts": "export const shout = (s: string) => s.toUpperCase()\n",
      "test/math.test.ts": 'import { expect, test } from "bun:test"\nimport { add } from "../src/math.ts"\ntest("adds", () => expect(add(1, 2)).toBe(3))\n',
      "test/text.test.ts":
        'import { expect, test } from "bun:test"\nimport { shout } from "../src/text.ts"\ntest("shouts", () => expect(shout("a")).toBe("A"))\n',
    });
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    const state = await tempDir("outrun-state-");
    return { dir, state };
  });

const options = (dir: string, state: string, runId: string): TestOptions => ({
  cwd: dir,
  shard: { index: 1, count: 1 },
  slots: 2,
  dryRun: false,
  write: false,
  audit: 0,
  runId,
  env: { ...process.env, OUTRUN_STATE_DIR: state },
});

describe("outrun test", () => {
  it.effect(
    "runs every unit once, replays them unchanged, and reruns only what a change reaches",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup();
        const first = yield* outrunTest(options(dir, state, "r1"));
        expect([first.ran, first.replayed, first.failed]).toEqual([2, 0, []]);
        const second = yield* outrunTest(options(dir, state, "r2"));
        expect([second.ran, second.replayed]).toEqual([0, 2]);
        yield* io(() => writeFile(`${dir}/src/math.ts`, "export const add = (a: number, b: number) => b + a\n"));
        const third = yield* outrunTest(options(dir, state, "r3"));
        expect([third.ran, third.replayed]).toEqual([1, 1]);
        yield* io(() => writeFile(`${dir}/src/text.ts`, "export const shout = (s: string) => s\n"));
        const failing = yield* outrunTest(options(dir, state, "r4"));
        expect(failing.failed).toEqual(["test/text.test.ts"]);
        // A failure is never replayed: the next run runs it again.
        const again = yield* outrunTest(options(dir, state, "r5"));
        expect([again.ran, again.failed]).toEqual([1, ["test/text.test.ts"]]);
      }),
    60_000,
  );

  it.effect(
    "passes a test file that defines no test when bun exits cleanly",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup({
          "test/generated.test.ts": 'import { test } from "bun:test"\nfor (const f of [] as string[]) test(f, () => {})\n',
        });
        const run = yield* outrunTest(options(dir, state, "g1"));
        expect([run.ran, run.failed, blocking(run)]).toEqual([3, [], 0]);
      }),
    60_000,
  );

  it.effect(
    "reruns a red unit alone: green alone is flaky, quarantined and not blocking",
    () =>
      Effect.gen(function* () {
        const marker = `${yield* io(() => tempDir("outrun-flaky-"))}/marker`;
        const { dir, state } = yield* setup({
          "test/flaky.test.ts": `import { expect, test } from "bun:test"\nimport { existsSync, writeFileSync } from "node:fs"\ntest("second time", () => { const seen = existsSync("${marker}"); writeFileSync("${marker}", "1"); expect(seen).toBe(true) })\n`,
        });
        const first = yield* outrunTest(options(dir, state, "f1"));
        expect([first.flaky, first.failed, blocking(first)]).toEqual([["test/flaky.test.ts"], [], 0]);
        // Quarantined: never replayed, and its failures do not block.
        const second = yield* outrunTest(options(dir, state, "f2"));
        expect([second.ran, second.replayed]).toEqual([1, 2]);
      }),
    60_000,
  );

  it.effect(
    "runs a unit with only the allowed variables and its own TMPDIR",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup({
          "test/env.test.ts": `import { expect, test } from "bun:test"\ntest("env", () => { expect(process.env.OUTRUN_SECRET).toBeUndefined(); expect(process.env.TMPDIR).toContain("outrun-tmp-") })\n`,
        });
        const run = yield* outrunTest({ ...options(dir, state, "e1"), env: { ...process.env, OUTRUN_STATE_DIR: state, OUTRUN_SECRET: "x" } });
        expect(run.failed).toEqual([]);
      }),
    60_000,
  );

  it.effect(
    "writes no verdict when the tests wrote into the working tree, and fails",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup({
          "test/writer.test.ts": `import { test } from "bun:test"\nimport { writeFileSync } from "node:fs"\ntest("writes", () => writeFileSync(\`\${import.meta.dir}/../written.txt\`, "x"))\n`,
        });
        const run = yield* outrunTest(options(dir, state, "w1"));
        expect([run.wroteTree, blocking(run)]).toEqual([["written.txt"], 1]);
        const again = yield* outrunTest(options(dir, state, "w2"));
        expect(again.replayed).toBe(0);
      }),
    60_000,
  );

  it.effect(
    "audits a hit: a cached pass that fails now marks its suite diverged and blocks",
    () =>
      Effect.gen(function* () {
        const flag = `${yield* io(() => tempDir("outrun-audit-"))}/flag`;
        const { dir, state } = yield* setup({
          "test/clock.test.ts": `import { expect, test } from "bun:test"\nimport { existsSync } from "node:fs"\ntest("outside", () => expect(existsSync("${flag}")).toBe(false))\n`,
        });
        yield* outrunTest(options(dir, state, "a1"));
        yield* io(() => writeFile(flag, "1"));
        const audit = yield* outrunTest({ ...options(dir, state, "a2"), audit: 1 });
        expect([audit.audits, audit.diverged, blocking(audit)]).toEqual([3, ["test/clock.test.ts"], 1]);
        // The suite's verdicts are not replayed while the divergence is fresh.
        const after = yield* outrunTest(options(dir, state, "a3"));
        expect(after.replayed).toBe(0);
      }),
    60_000,
  );

  it.effect(
    "plans no runner when every unit hits",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup();
        const out = `${state}/plan.json`;
        const runners = { max: 4, targetMs: 60_000, startMs: 1000, slots: 2 };
        const cold = yield* plan({ ...options(dir, state, "p1"), out, runners });
        expect(cold.runners).toBe(1);
        yield* outrunTest({ ...options(dir, state, "p1"), plan: out });
        const warm = yield* plan({ ...options(dir, state, "p2"), out, runners });
        expect([warm.runners, warm.units]).toEqual([0, []]);
      }),
    60_000,
  );

  it.effect(
    "keys none of its own files: a plan downloaded into the checkout moves no key, so a rerun plans no runner",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup();
        // Every file of the checkout is in the suite's key, plan.json included if it were keyed.
        yield* io(() =>
          write(dir, {
            "outrun.json": JSON.stringify({
              inputs: ["package.json"],
              suites: [{ name: "unit", adapter: "bun", dir: ".", tests: ["test/*.test.ts"], run: ["bun", "test"], sources: ["imports", "suite"] }],
            }),
          }),
        );
        git(dir, "commit", "-qam", "whole suite");
        const out = `${dir}/plan.json`;
        const runners = { max: 4, targetMs: 60_000, startMs: 1000, slots: 2 };
        const cold = yield* plan({ ...options(dir, state, "o1"), out, runners });
        expect(cold.runners).toBe(1);
        const run = yield* outrunTest({ ...options(dir, state, "o1"), plan: out });
        expect([run.ran, run.failed]).toEqual([2, []]);
        // The rerun's plan job checks out the commit afresh: no plan.json in it.
        yield* io(() => rm(out));
        const warm = yield* plan({ ...options(dir, state, "o2"), out: `${state}/plan.json`, runners });
        expect([warm.runners, warm.units]).toEqual([0, []]);
      }),
    60_000,
  );

  it.effect(
    "replays a command unit's recorded pass until one of its inputs changes",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup();
        const out = `${state}/plan.json`;
        const runners = { max: 4, targetMs: 60_000, startMs: 1000, slots: 2 };
        const base = options(dir, state, "c1");
        expect((yield* plan({ ...base, out, runners })).commands).toEqual({ build: "run" });
        yield* recordCommand({ ...base, name: "build", write: false, durationMs: 1000 });
        expect((yield* plan({ ...options(dir, state, "c2"), out, runners })).commands).toEqual({ build: "hit" });
        yield* io(() => writeFile(`${dir}/src/math.ts`, "export const add = (a: number, b: number) => b + a\n"));
        expect((yield* plan({ ...options(dir, state, "c3"), out, runners })).commands).toEqual({ build: "run" });
        // A step that changed the checkout records under the key its plan gave.
        const before = yield* plan({ ...options(dir, state, "c4"), out, runners });
        yield* io(() => writeFile(`${dir}/src/math.ts`, "export const add = 0\n"));
        yield* recordCommand({ ...options(dir, state, "c4"), name: "build", write: false, durationMs: 1000, key: before.commandKeys.build });
        yield* io(() => writeFile(`${dir}/src/math.ts`, "export const add = (a: number, b: number) => b + a\n"));
        expect((yield* plan({ ...options(dir, state, "c5"), out, runners })).commands).toEqual({ build: "hit" });
        // A job that runs one command looks it up alone, with the plan's answer.
        expect(yield* lookupCommand({ ...options(dir, state, "c6"), name: "build" })).toEqual({ run: false, key: before.commandKeys.build });
        yield* io(() => writeFile(`${dir}/src/math.ts`, "export const add = 1\n"));
        expect((yield* lookupCommand({ ...options(dir, state, "c7"), name: "build" })).run).toBe(true);
      }),
    60_000,
  );

  it.effect(
    "records a command under its given key without reading the checkout, so a step's outputs cost the record nothing",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup();
        const out = `${state}/plan.json`;
        const runners = { max: 4, targetMs: 60_000, startMs: 1000, slots: 2 };
        const before = yield* plan({ ...options(dir, state, "k1"), out, runners });
        // What a build leaves in the checkout, unignored: keying would read it, and fails on this one.
        yield* io(() => writeFile(`${dir}/src/output.bin`, "built\n"));
        yield* io(() => chmod(`${dir}/src/output.bin`, 0o000));
        expect(Exit.isFailure(yield* Effect.exit(recordCommand({ ...options(dir, state, "k1"), name: "build", write: false, durationMs: 1000 })))).toBe(true);
        yield* recordCommand({ ...options(dir, state, "k1"), name: "build", write: false, durationMs: 1000, key: before.commandKeys.build });
        yield* io(() => rm(`${dir}/src/output.bin`));
        expect((yield* plan({ ...options(dir, state, "k2"), out, runners })).commands).toEqual({ build: "hit" });
        expect(
          Exit.isFailure(
            yield* Effect.exit(recordCommand({ ...options(dir, state, "k3"), name: "nope", write: false, durationMs: 1, key: before.commandKeys.build })),
          ),
        ).toBe(true);
      }),
    60_000,
  );

  it.effect(
    "records a quarantined command's failure and replays it, and refuses a failure for any other command",
    () =>
      Effect.gen(function* () {
        const { dir, state } = yield* setup();
        yield* io(() =>
          write(dir, {
            "outrun.json": JSON.stringify({
              inputs: ["package.json"],
              suites: [],
              commands: [
                { name: "build", run: "bun build src/math.ts", inputs: ["src/**"] },
                { name: "known-red", run: "bun test e2e", inputs: ["src/**"], quarantined: true },
              ],
            }),
          }),
        );
        git(dir, "commit", "-qam", "quarantine");
        const refused = yield* Effect.exit(recordCommand({ ...options(dir, state, "q1"), name: "build", write: false, durationMs: 1, failed: true }));
        expect(Exit.isFailure(refused)).toBe(true);
        expect((yield* lookupCommand({ ...options(dir, state, "q2"), name: "known-red" })).run).toBe(true);
        yield* recordCommand({ ...options(dir, state, "q2"), name: "known-red", write: false, durationMs: 1, failed: true });
        expect((yield* lookupCommand({ ...options(dir, state, "q3"), name: "known-red" })).run).toBe(false);
        yield* io(() => writeFile(`${dir}/src/math.ts`, "export const add = 2\n"));
        expect((yield* lookupCommand({ ...options(dir, state, "q4"), name: "known-red" })).run).toBe(true);
      }),
    60_000,
  );

  it("names, without their values, the keyed variables and toolchains a shard does not share with its plan", () => {
    const plan = { toolchains: { bun: "bun 1 linux" }, env: { CI: "true", SECRET: "a" } };
    expect(contextDiff(plan, { toolchains: { bun: "bun 1 linux" }, env: { CI: "true", SECRET: "a" } })).toEqual([]);
    expect(contextDiff(plan, { toolchains: { bun: "bun 2 linux" }, env: { CI: "true", SECRET: "b" } })).toEqual(["the bun toolchain or machine", "$SECRET"]);
    expect(contextDiff(undefined, plan)).toEqual(["the plan has no context (an older outrun)"]);
  });

  it.effect("refuses a shard outside its count", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(outrunTest({ ...options("/tmp", "/tmp", "x"), shard: { index: 3, count: 2 } }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("deadlineMs", () => {
  it("derives a batch's deadline from its durations only when every file was timed", () => {
    expect(deadlineMs({ expectedMs: 20_000, measured: true })).toBe(120_000);
    // A file never timed: its 2 s guess must not kill it at 66 s (a 120 s file did, ARK-81).
    expect(deadlineMs({ expectedMs: 2_000, measured: false })).toBe(15 * 60_000);
    expect(deadlineMs({ expectedMs: 2_000, measured: true }, 1_800_000)).toBe(1_800_000);
  });

  it("gives a file run again alone more than the time its batch had", () => {
    expect(deadlineMs({ expectedMs: 500, measured: true, floorMs: 2 * 121_500 + 60_000 })).toBe(303_000);
  });
});
