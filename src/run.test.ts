// `outrun run` (run.ts): the workflow read, refused or run as GitHub runs it. The jobs' programs
// (job-script.ts) run here in bash, in a scratch directory standing for the worker's checkout, so
// what these tests prove is the program's behaviour, not a fake of it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, describe, expect, it } from "vitest";
import { NotRun } from "./check.ts";
import { condition, evaluate, interpolate, parse } from "./expr.ts";
import { type Cell, prepare, type Ran, runWorkflow } from "./run.ts";
import { expandMatrix, parseWorkflow } from "./workflow.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// A worker: the cell's program in bash, in a git checkout of its own.
const local = (cells: Cell[]) => (cell: Cell) =>
  Effect.sync((): Ran => {
    cells.push(cell);
    const dir = mkdtempSync(join(tmpdir(), "outrun-run-"));
    dirs.push(dir);
    spawnSync("bash", ["-c", "git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init"], { cwd: dir });
    const result = join(dir, ".result.json");
    const done = spawnSync("bash", ["-s"], { cwd: dir, input: cell.script, encoding: "utf8", env: { ...process.env, OUTRUN_RUN_RESULT: result } });
    const job = spawnSync("cat", [result], { encoding: "utf8" }).stdout;
    const parsed = job ? (JSON.parse(job) as { outputs: Record<string, string>; steps: Ran["steps"] }) : { outputs: {}, steps: [] };
    return {
      result: done.status === 0 ? "success" : "failure",
      outputs: parsed.outputs,
      steps: parsed.steps,
      log: `${done.stdout}${done.stderr}`,
      ms: 1,
      where: "here",
    };
  });

const run = async (yaml: string, options: { jobs?: string[]; fields?: string[] } = {}) => {
  const lines: string[] = [];
  const cells: Cell[] = [];
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const { workflow, jobs, inputs } = yield* prepare("w.yml", yaml, options.jobs ?? [], options.fields ?? [], "acme/app");
      return yield* runWorkflow(workflow, jobs, { repository: "acme/app", ref: "refs/heads/main", inputs }, local(cells), (line) =>
        Effect.sync(() => void lines.push(line)),
      );
    }),
  );
  return { exit, lines, cells, results: Exit.isSuccess(exit) ? Object.fromEntries(exit.value) : null, log: lines.join("\n") };
};
const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return null;
  const failure = exit.cause.reasons.find((r) => r._tag === "Fail") as { error: { _tag: string; message: string } } | undefined;
  return failure?.error._tag === "RunRefused" ? failure.error.message : null;
};

describe("expressions as GitHub evaluates them", () => {
  const scope = {
    contexts: { matrix: { os: "linux", n: 2 }, inputs: { mode: "fast", on: true }, needs: { plan: { result: "success", outputs: { list: '["a","b"]' } } } },
  };
  it("compares strings without case, numbers by value, and && / || return an operand", () => {
    expect(evaluate(parse("matrix.os == 'LINUX'"), scope)).toBe(true);
    expect(evaluate(parse("matrix.n == '2'"), scope)).toBe(true);
    expect(evaluate(parse("matrix.missing || 'default'"), scope)).toBe("default");
    expect(evaluate(parse("inputs.on && 'yes'"), scope)).toBe("yes");
  });
  it("reads fromJSON, contains, format, join and property filters", () => {
    expect(evaluate(parse("fromJSON(needs.plan.outputs.list)"), scope)).toEqual(["a", "b"]);
    expect(evaluate(parse("contains(fromJSON(needs.plan.outputs.list), 'b')"), scope)).toBe(true);
    expect(evaluate(parse("format('{0}-{1}', matrix.os, matrix.n)"), scope)).toBe("linux-2");
    expect(evaluate(parse("join(fromJSON(needs.plan.outputs.list), '+')"), scope)).toBe("a+b");
    expect(interpolate(`go \${{ matrix.os }} \${{ matrix.n }}`, scope)).toBe("go linux 2");
  });
  it("adds success() to an if: without a status function", () => {
    const node = condition("inputs.mode == 'fast'");
    expect(evaluate(node, { ...scope, status: "failure" })).toBe(false);
    expect(evaluate(condition(`\${{ always() }}`), { ...scope, status: "failure" })).toBe(true);
  });
});

describe("matrices as GitHub expands them", () => {
  it("takes the product, removes exclude, then extends or adds include", () => {
    expect(
      expandMatrix({
        os: ["a", "b"],
        n: [1, 2],
        exclude: [{ os: "b", n: 2 }],
        include: [
          { os: "a", extra: "x" },
          { os: "c", n: 9 },
        ],
      }),
    ).toEqual([
      { os: "a", n: 1, extra: "x" },
      { os: "a", n: 2, extra: "x" },
      { os: "b", n: 1 },
      { os: "c", n: 9 },
    ]);
  });
  it("makes each include its own combination when the matrix has no other key, as a fromJSON list of shards", () => {
    const shards = [
      { name: "1/3", tasks: "a" },
      { name: "2/3", tasks: "b" },
      { name: "3/3", tasks: "c" },
    ];
    expect(expandMatrix({ include: shards })).toEqual(shards);
    expect(expandMatrix({ os: ["a"], include: [{ extra: 1 }, { os: "z" }, { more: 2 }] })).toEqual([{ os: "a", extra: 1, more: 2 }, { os: "z" }]);
  });
});

describe("outrun run refuses what it cannot run as GitHub does, before anything runs", () => {
  it("names the feature, the file and the line", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    environment: prod
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
      - run: echo \${{ secrets.TOKEN }}
`;
    const { exit, cells } = await run(yaml);
    const text = refusal(exit);
    expect(cells).toHaveLength(0);
    expect(text).toContain("w.yml:3: job build: environment");
    expect(text).toContain("w.yml:8: job build, step 2: uses: actions/setup-node@v4");
    expect(text).toContain("w.yml:9: job build, step 3 run: secrets");
  });
  it("refuses a checkout input it would not honor, and a macOS runner once known", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  a:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-15]
    steps:
      - uses: actions/checkout@v5
      - run: true
`;
    const { exit } = await run(yaml);
    expect(refusal(exit)).toContain("runs-on macos-15");
    const lfs = await run(
      `on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          lfs: true\n      - run: true\n`,
    );
    expect(refusal(lfs.exit)).toContain("w.yml:6: job a, step 1: actions/checkout's lfs");
  });
  it("checks workflow_dispatch inputs: required, typed, defaulted", async () => {
    const yaml = `on:
  workflow_dispatch:
    inputs:
      level: { type: choice, options: [low, high], required: true }
      dry: { type: boolean, default: true }
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: echo "\${{ inputs.level }} \${{ inputs.dry }}"
`;
    expect(refusal((await run(yaml)).exit)).toContain("input level is required");
    expect(refusal((await run(yaml, { fields: ["level=mid"] })).exit)).toContain("one of low, high, not mid");
    const ok = await run(yaml, { fields: ["level=high"] });
    expect(ok.results).toEqual({ a: "success" });
    expect(ok.log).toContain("high true");
  });
});

describe("outrun run runs a workflow as GitHub runs it", () => {
  it("passes outputs from a job to a fromJSON matrix of the next, one cell per combination", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      shards: \${{ steps.list.outputs.shards }}
    steps:
      - uses: actions/checkout@v5
      - id: list
        run: echo 'shards=[1,2,3]' >> "$GITHUB_OUTPUT"
  test:
    needs: plan
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: \${{ fromJSON(needs.plan.outputs.shards) }}
    steps:
      - uses: actions/checkout@v5
      - run: echo "shard \${{ matrix.shard }} of \${{ strategy.job-total }}"
`;
    const { results, cells, log } = await run(yaml);
    expect(results).toEqual({ plan: "success", test: "success" });
    expect(cells.map((c) => c.name)).toEqual(["plan", "test (1)", "test (2)", "test (3)"]);
    expect(log).toContain("✓ test (2)");
  });
  it("fails the job on a failing step, runs if: failure() and always() steps, skips the rest, and skips dependents", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: echo boom; exit 3
      - run: echo never
      - if: failure()
        run: echo on-failure
      - if: always()
        run: echo always
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: echo b
  c:
    needs: a
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: echo "a was \${{ needs.a.result }}"
`;
    const { results, log } = await run(yaml);
    expect(results).toEqual({ a: "failure", b: "skipped", c: "success" });
    expect(log).toContain("boom");
    expect(log).toContain("on-failure");
    expect(log).toContain("always");
    expect(log).not.toMatch(/^never$/m);
    expect(log).toContain("- Run echo never skipped");
  });
  it("carries GITHUB_ENV, GITHUB_PATH, step outputs, continue-on-error, defaults and working-directory", async () => {
    const yaml = `on: workflow_dispatch
env:
  TOP: top
jobs:
  a:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    env:
      JOB: job-\${{ github.repository }}
    steps:
      - uses: actions/checkout@v5
      - run: |
          echo "FROM_STEP=one" >> "$GITHUB_ENV"
          { echo "MULTI<<EOF"; echo "l1"; echo "l2"; echo "EOF"; } >> "$GITHUB_ENV"
          mkdir -p bin sub && printf '#!/bin/sh\\necho tool-ran\\n' > bin/mytool && chmod +x bin/mytool
          echo "$PWD/bin" >> "$GITHUB_PATH"
      - id: out
        run: echo "value=v 1" >> "$GITHUB_OUTPUT"
      - continue-on-error: true
        run: exit 1
      - working-directory: sub
        env:
          GOT: \${{ steps.out.outputs.value }}
        run: |
          echo "$TOP $JOB $FROM_STEP $(basename "$PWD") [$GOT] \${{ env.FROM_STEP }}"
          echo "$MULTI" | tr '\\n' '+'
          mytool
`;
    const { results, log } = await run(yaml);
    expect(results).toEqual({ a: "success" });
    expect(log).toContain("top job-acme/app one sub [v 1] one");
    expect(log).toContain("l1+l2+");
    expect(log).toContain("tool-ran");
  });
  it("decides a step's if: on steps and env as the job runs, comparing strings without case", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: plan
        run: echo "mode=Here" >> "$GITHUB_OUTPUT"; echo "FLAG=1" >> "$GITHUB_ENV"
      - if: steps.plan.outputs.mode == 'here'
        run: printf '%s-%s\\n' ran here
      - if: \${{ steps.plan.outputs.mode != 'here' }}
        run: printf '%s-%s\\n' ran elsewhere
      - if: env.FLAG && steps.plan.outcome == 'success' && !steps.plan.outputs.missing
        run: printf '%s-%s\\n' ran flag
      - if: always() && steps.plan.outputs.mode == 'nope'
        run: printf '%s-%s\\n' ran nope
`;
    const { results, log, exit } = await run(yaml);
    expect(refusal(exit)).toBe(null);
    expect(results).toEqual({ a: "success" });
    expect(log).toContain("ran-here");
    expect(log).toContain("ran-flag");
    expect(log).not.toContain("ran-elsewhere");
    expect(log).not.toContain("ran-nope");
    const refused = await run(`on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: x
        run: "true"
      - if: contains(steps.x.outputs.list, 'a')
        run: "true"
`);
    expect(refusal(refused.exit)).toContain("w.yml:8: job a, step 2 if:");
  });

  it("honors fail-fast: a failed cell cancels the cells not started", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      max-parallel: 1
      matrix:
        n: [1, 2, 3]
    steps:
      - uses: actions/checkout@v5
      - run: test \${{ matrix.n }} != 1
`;
    const { results, cells, log } = await run(yaml);
    expect(results).toEqual({ a: "failure" });
    expect(cells).toHaveLength(1);
    expect(log).toContain("a (2): cancelled (fail-fast)");
  });
  it("runs only the selected job and what it needs", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  a: { runs-on: ubuntu-latest, steps: [{ uses: actions/checkout@v5 }, { run: "true" }] }
  b: { runs-on: ubuntu-latest, needs: a, steps: [{ uses: actions/checkout@v5 }, { run: "true" }] }
  c: { runs-on: ubuntu-latest, steps: [{ uses: actions/checkout@v5 }, { run: "true" }] }
`;
    const { results } = await run(yaml, { jobs: ["b"] });
    expect(results).toEqual({ a: "success", b: "success" });
  });
  it("is not run (NotRun) when the fleet does not run a cell", async () => {
    const parsed = parseWorkflow(
      "w.yml",
      `on: workflow_dispatch\njobs:\n  a: { runs-on: ubuntu-latest, steps: [{ uses: actions/checkout@v5 }, { run: "true" }] }\n`,
    );
    if (!("workflow" in parsed)) throw new Error("not parsed");
    const exit = await Effect.runPromiseExit(
      runWorkflow(
        parsed.workflow,
        [...parsed.workflow.jobs.values()],
        { repository: "acme/app", ref: "refs/heads/main", inputs: {} },
        () => Effect.fail(new NotRun({ message: "409 full" })),
        () => Effect.void,
      ),
    );
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Fail" && (r.error as { _tag: string })._tag === "NotRun")).toBe(true);
  });
});
