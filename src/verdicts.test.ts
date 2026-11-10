// `outrun verdicts lookup` and `record` (engine.ts lookupVerdicts, recordVerdicts): the cache of units
// a script runs itself, keyed by the globs it gives, as a presubmit's Dart test files are (OUT-56).
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lookupVerdicts, recordVerdicts } from "./engine.ts";
import { FileFailed } from "./errors.ts";
import { type Cell, prepare, runWorkflow } from "./run.ts";
import { tempDir } from "./test-tmp.ts";
import { tierOf } from "./verdict.ts";

const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new FileFailed({ message: String(e) }) });

const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

// A Dart package as a presubmit keys it, conservatively: the test file, the whole lib/ and the lockfile.
const dartUnit = (file: string) => ({
  name: `dart:${file}`,
  run: "flutter test 3.35.0",
  inputs: [`ui/${file}`, "ui/lib/**", "ui/pubspec.lock"],
});

const setup = io(async () => {
  const dir = await tempDir("outrun-verdicts-");
  for (const [path, text] of Object.entries({
    "ui/pubspec.lock": "packages: {}\n",
    "ui/lib/a.dart": "int a() => 1;\n",
    "ui/test/a_test.dart": "void main() {}\n",
    "ui/test/b_test.dart": "void main() {}\n",
    "README.md": "acme\n",
  }))
    await Bun.write(`${dir}/${path}`, text);
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return { dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, OUTRUN_STATE_DIR: await tempDir("outrun-state-") } };
});

describe("outrun verdicts", () => {
  it.effect(
    "replays a script's unit until its file, its package's lib/ or its lockfile changes",
    () =>
      Effect.gen(function* () {
        const { dir, env } = yield* setup;
        const commands = [dartUnit("test/a_test.dart"), dartUnit("test/b_test.dart")];
        const look = (runId: string) => lookupVerdicts({ cwd: dir, env, commands, runId }).pipe(Effect.map((r) => r.units));
        const first = yield* look("r1");
        expect(first.map((u) => u.hit)).toEqual([false, false]);
        yield* recordVerdicts({ cwd: dir, env, runId: "r1", write: false, passes: first.map((u) => ({ id: u.id, key: u.key, durationMs: 900 })) });
        expect((yield* look("r2")).map((u) => u.hit)).toEqual([true, true]);
        // Another test file changes: only its unit runs again.
        yield* io(() => writeFile(`${dir}/ui/test/b_test.dart`, "void main() { print(1); }\n"));
        expect((yield* look("r3")).map((u) => u.hit)).toEqual([true, false]);
        // A file outside the package: nothing.
        yield* io(() => writeFile(`${dir}/README.md`, "acme!\n"));
        expect((yield* look("r4")).map((u) => u.hit)).toEqual([true, false]);
        // The package's lib/ (what any test may import): every unit of it.
        yield* io(() => writeFile(`${dir}/ui/lib/a.dart`, "int a() => 2;\n"));
        expect((yield* look("r5")).map((u) => u.hit)).toEqual([false, false]);
      }),
    60_000,
  );

  it("puts every outrun run cell in the fleet tier, whatever ref it names", () => {
    const cell = { OUTRUN_RUN: "true", GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch" };
    expect(tierOf(cell, "refs/heads/main", "vm")).toBe("fleet");
    expect(tierOf({ ...cell, OUTRUN_RUN: undefined }, "refs/heads/main", "vm")).toBe("trusted");
  });

  it.effect("gives every cell of outrun run the run's verdict cache", () =>
    Effect.gen(function* () {
      const yaml = "on: workflow_dispatch\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./scripts/ci-fast.sh\n";
      const { workflow, jobs, inputs } = yield* prepare("w.yml", yaml, [], [], "acme/app");
      const cells: Cell[] = [];
      const env = { OUTRUN_RUN: "true", OUTRUN_CACHE_URL: "https://cache.outrun.sh", OUTRUN_CACHE_TOKEN: "ocv1.a.b" };
      yield* runWorkflow(
        workflow,
        jobs,
        { repository: "acme/app", ref: "refs/heads/main", inputs, env },
        (cell) =>
          Effect.sync(() => {
            cells.push(cell);
            return { result: "success" as const, outputs: {}, steps: [], log: "", ms: 1, where: "here" };
          }),
        () => Effect.void,
      );
      for (const [k, v] of Object.entries(env)) expect(cells[0]?.script).toContain(`export ${k}='${v}'`);
    }),
  );
});
