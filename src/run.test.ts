// `outrun run` (run.ts): the workflow read, refused or run as GitHub runs it. The jobs' programs
// (job-script.ts) run here in bash, in a scratch directory standing for the worker's checkout, so
// what these tests prove is the program's behaviour, not a fake of it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { afterAll, describe, expect, it } from "vitest";
import { CheckApi, type CheckEvent, NotRun } from "./check.ts";
import { condition, evaluate, interpolate, parse } from "./expr.ts";
import { basePrelude } from "./job-script.ts";
import { type Cell, fleet, prepare, type Ran, redispatch, REDISPATCHES, runWorkflow, WorkerFailed } from "./run.ts";
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

describe("each step's time and the VM's load are in the job's log and the run's report", () => {
  it("prints after a step its seconds, the VM's CPU (mean and peak of its cores) and its peak memory, without naming the machine's provider", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Busy
        run: sleep 2.5
`;
    const { results, log } = await run(yaml);
    expect(results).toEqual({ a: "success" });
    // The load only when the sampler gave one (a busy runner may not within the step): its time always.
    expect(log).toMatch(/── step 1\/1 · Busy: 2\.\d s( · CPU \d+% avg, \d+% peak of \d+ vCPU · memory \d+\.\d GB peak of \d+ GB)?\n/);
    expect(log).toMatch(/ {2}Busy 2\.\d s( · CPU \d+% \(peak \d+%\) of \d+ · mem \d+\.\d\/\d+ GB)?\n/);
    expect(log).not.toMatch(/boat|hetzner|tart/i);
  });
});

describe("a job's output ends with its last step", () => {
  it("leaves nothing of its load sampling holding its output open: a one-step job is read to its end at once", async () => {
    const yaml = "on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";
    const t0 = Date.now();
    const { results } = await run(yaml);
    expect(results).toEqual({ a: "success" });
    // 1 s and more while the sampler's sleep held the job's stdout.
    expect(Date.now() - t0).toBeLessThan(900);
  });
});

describe("a job with runs-on: outrun-macos-26 runs on a macOS VM, as an ordinary GitHub Actions job", () => {
  it("gives its cell the macOS OS, RUNNER_OS and runner.os, and its Linux neighbours Linux", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  mac:
    runs-on: outrun-macos
    steps:
      - run: echo "os=$RUNNER_OS \${{ runner.os }} $RUNNER_ARCH"
  mac26:
    runs-on: outrun-macos-26-flex
    steps:
      - run: echo "os=$RUNNER_OS"
  linux:
    runs-on: [self-hosted, outrun]
    steps:
      - run: echo "os=$RUNNER_OS \${{ runner.os }}"
`;
    const { cells, results } = await run(yaml);
    expect(results).toEqual({ mac: "success", mac26: "success", linux: "success" });
    const byJob = Object.fromEntries(cells.map((cell) => [cell.job, cell]));
    expect(byJob.mac!.os).toBe("macos");
    // The new name and its deprecated alias (labels.ts ALIASES) are the same runner.
    expect(byJob.mac26!.os).toBe("macos");
    expect(byJob.mac!.script).toContain("export RUNNER_OS='macOS'");
    expect(byJob.mac!.script).toContain(`echo "os=$RUNNER_OS ''macOS'' $RUNNER_ARCH"`);
    expect(byJob.linux!.os).toBe("linux");
    expect(byJob.linux!.script).toContain("export RUNNER_OS='Linux'");
    expect(byJob.linux!.script).toContain(`echo "os=$RUNNER_OS ''Linux''"`);
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
    expect(refusal(exit)).toContain("runs-on macos-15: outrun run runs Linux jobs and outrun-macos-26 ones only");
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
  it("gives a job over outrun's cap, GitHub's default 360 included, the cap, and says so in one line (OUT-56: a 400)", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  plain: { runs-on: ubuntu-latest, strategy: { matrix: { n: [1, 2] } }, steps: [{ run: "true" }] }
  long: { runs-on: ubuntu-latest, timeout-minutes: 90, steps: [{ run: "true" }] }
  short: { runs-on: ubuntu-latest, timeout-minutes: 5, steps: [{ run: "true" }] }
`;
    const { results, cells, lines } = await run(yaml);
    expect(results).toEqual({ plain: "success", long: "success", short: "success" });
    expect(Object.fromEntries(cells.map((c) => [c.name, c.timeoutMs / 60_000]))).toEqual({ "plain (1)": 15, "plain (2)": 15, long: 15, short: 5 });
    expect(lines.filter((l) => l.includes("cap"))).toEqual([
      "- plain: timeout-minutes 360 (GitHub's default) is over outrun's cap: 15 min",
      "- long: timeout-minutes 90 is over outrun's cap: 15 min",
    ]);
  });
  it("stops a step at its timeout-minutes with the macOS guest's tools only: /bin/bash 3.2, no GNU timeout", async () => {
    const yaml = `on: workflow_dispatch
jobs:
  a:
    runs-on: outrun-macos
    steps:
      - run: echo before
      - run: sleep 30
        timeout-minutes: 0.02
      - if: always()
        run: echo after
`;
    const cells: Cell[] = [];
    await run(yaml).then((r) => cells.push(...r.cells));
    const dir = mkdtempSync(join(tmpdir(), "outrun-run-"));
    dirs.push(dir);
    const t0 = Date.now();
    const done = spawnSync("/bin/bash", ["-s"], { cwd: dir, input: cells[0]!.script, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir } });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(done.status).not.toBe(0);
    expect(done.stdout).toContain("before");
    expect(done.stdout).toContain("after");
  }, 30_000);
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

describe("the run's checkout on a VM", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const sh = (cwd: string, script: string) => spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
  // A commit object as the CLI reads it, its last newline kept (it is part of the object).
  const raw = (cwd: string, rev: string) => spawnSync("git", ["cat-file", "commit", rev], { cwd, encoding: "utf8" }).stdout;

  it("holds the push's base under its own sha as HEAD's parent, as GitHub's checkout of the pushed commit", () => {
    const root = mkdtempSync(join(tmpdir(), "outrun-base-"));
    try {
      // The caller: main W, then X, the push's base B, the push H. The VM: its warm commit (W's tree),
      // the base's tree committed on it, then H's tree (the agent's changeCommits); X and B absent.
      const caller = join(root, "caller");
      const vm = join(root, "vm");
      for (const dir of [caller, vm]) sh(root, `mkdir ${dir} && git -C ${dir} init -q`);
      const commit = (dir: string, script: string, message: string) => {
        sh(dir, script);
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", message);
      };
      commit(caller, "echo w > f", "W");
      commit(caller, "echo x > x", "X");
      commit(caller, "echo b >> f", "B");
      const base = git(caller, "rev-parse", "HEAD");
      commit(caller, "echo h > h", "H");
      commit(vm, "echo w > f", "warm");
      commit(vm, "echo x > x; echo b >> f", "outrun check: the push's base");
      commit(vm, "echo h > h", "the push");
      const tree = git(vm, "rev-parse", "HEAD^{tree}");

      const ran = sh(vm, basePrelude(base, raw(caller, base)));
      expect(ran.stderr).toBe("");
      expect(ran.status).toBe(0);
      expect(git(vm, "rev-parse", "HEAD~1")).toBe(base);
      expect(git(vm, "merge-base", base, "HEAD")).toBe(base);
      expect(git(vm, "diff", "--name-only", base, "HEAD")).toBe("h");
      expect(git(vm, "rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(git(vm, "status", "--porcelain")).toBe("");

      // Another base's tree than HEAD~1's: the checkout stays, and says so.
      const head = git(vm, "rev-parse", "HEAD");
      const other = sh(vm, basePrelude(git(caller, "rev-parse", "HEAD~2"), raw(caller, "HEAD~2")));
      expect(other.stderr).toContain("is not in this checkout");
      expect(git(vm, "rev-parse", "HEAD")).toBe(head);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // About 25 git processes: past vitest's 5 s when the whole suite loads the machine.
  }, 30_000);
});

// The fleet behind `outrun run` (run.ts `fleet`), on a fake control plane: each check one VM, its
// apply at once, its shard answered with the job's report.
// `slow`: a check whose VM comes up late. `minis`: where a check goes, the first not excluded by its
// create (none left: no VM); `faults`: what a Mini does to a shard, its VM lost under it, its
// agent reporting no job, or its job failing as a job does.
const fakeFleet = (slow?: string, { minis = ["mm1"], faults = {} }: { minis?: string[]; faults?: Record<string, "lost" | "no-job" | "fail"> } = {}) => {
  const calls: string[] = [];
  const scripts: string[] = [];
  const on = new Map<string, string>();
  const events = new Map<string, CheckEvent[]>();
  let next = 0;
  const push = (id: string, event: Omit<CheckEvent, "seq" | "ms" | "log" | "worker">) => {
    const list = events.get(id) ?? [];
    list.push({ ms: 1, log: "", worker: `w-${id}`, ...event, seq: list.length + 1 });
    events.set(id, list);
  };
  const layer = Layer.succeed(CheckApi, {
    create: (_repo, _workers, _run, _main, os, exclude = []) =>
      Effect.sync(() => {
        const id = `c${++next}`;
        calls.push(`create ${id}${os ? ` ${os}` : ""}${exclude.length ? ` not ${exclude.join(",")}` : ""}`);
        const free = minis.filter((m) => !exclude.includes(m));
        if (free.length === 0) return { id, sha: "a".repeat(40), workers: [] };
        const mini = free[0]!;
        on.set(id, mini);
        push(id, { step: "up", code: 0, json: {} });
        return { id, sha: "a".repeat(40), workers: [{ name: `w-${id}`, mini }] };
      }),
    patch: (id) =>
      Effect.sleep(id === slow ? "40 millis" : "1 millis").pipe(Effect.andThen(Effect.sync(() => void push(id, { step: "apply", code: 0, json: {} })))),
    // A job's program takes a moment, as on a VM.
    shards: (id, shards) =>
      Effect.sync(() => {
        const name = shards[0]!.tasks[0]!;
        calls.push(`run ${name} on ${id}${minis.length > 1 ? ` (${on.get(id)})` : ""}`);
        scripts.push(shards[0]!.script ?? "");
        return name;
      }).pipe(
        Effect.tap((name) =>
          Effect.sleep("20 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                const fault = faults[on.get(id)!];
                if (fault === "lost") return push(id, { step: "lost", code: 0, json: {} });
                push(id, {
                  step: "shard",
                  code: fault === "fail" ? 1 : 0,
                  json:
                    fault === "no-job"
                      ? {}
                      : {
                          job: { outputs: name.endsWith(":plan") ? { shards: "[1,2]" } : {}, steps: [] },
                          host: { cpu: 634, cpuPeak: 981, memMb: 20582, memTotalMb: 32768, cpus: 12 },
                        },
                });
              }),
            ),
          ),
        ),
        Effect.asVoid,
      ),
    events: (id, after) =>
      Effect.suspend(() => {
        const later = (events.get(id) ?? []).filter((e) => e.seq > after);
        return later.length > 0 ? Effect.succeed(later) : Effect.never;
      }),
    end: (id) => Effect.sync(() => void calls.push(`end ${id}`)),
  });
  return { calls, scripts, layer };
};

describe("a cell whose worker failed for the fleet's reason runs again on another Mini; a failed job never does", () => {
  const failure = (mini: string) => new WorkerFailed({ mini, message: `${mini} lost` });

  it("decides: again, leaving out every Mini that failed the run, up to REDISPATCHES times, then gives up naming each", () => {
    expect(REDISPATCHES).toBe(2);
    expect(redispatch("shard 1/4", [failure("mm11")], new Set(["mm11", "mm3"]))).toEqual({ again: true, exclude: ["mm11", "mm3"] });
    expect(redispatch("shard 1/4", [failure("mm11"), failure("mm6")], new Set())).toEqual({ again: true, exclude: ["mm11", "mm6"] });
    expect(redispatch("shard 1/4", [failure("mm11"), failure("mm6"), failure("mm8")], new Set())).toEqual({
      again: false,
      message: "shard 1/4: no worker ran it, 3 tried: mm11: mm11 lost; mm6: mm6 lost; mm8: mm8 lost",
    });
  });

  const yaml = "on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";
  const runOne = (options: Parameters<typeof fakeFleet>[1]) => {
    const fake = fakeFleet(undefined, options);
    const lines: string[] = [];
    return Effect.runPromiseExit(
      Effect.gen(function* () {
        const { workflow, jobs, inputs } = yield* prepare("w.yml", yaml, [], [], "acme/app");
        const print = (line: string) => Effect.sync(() => void lines.push(line));
        const f = yield* fleet(
          "acme/app",
          () => Effect.succeed("patch"),
          () => Effect.succeed("m"),
          undefined,
          undefined,
          {},
          print,
        );
        const results = yield* runWorkflow(workflow, jobs, { repository: "acme/app", ref: "refs/heads/main", inputs }, f.runCell, print);
        yield* f.close;
        return Object.fromEntries(results);
      }).pipe(Effect.provide(fake.layer)),
    ).then((exit) => ({ exit, lines, log: lines.join("\n"), ...fake }));
  };

  it("runs a cell whose VM was lost again on another Mini, names the lost one, and asks the fleet to leave it out", async () => {
    const { exit, log, calls, scripts } = await runOne({ minis: ["mm11", "mm6"], faults: { mm11: "lost" } });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ a: "success" });
    expect(log).toContain("- a: mm11 did not run it (worker w-c1 was lost: ); again on another worker, not on mm11 (attempt 2 of 3)");
    expect(log).toMatch(/✓ a · [\d.]+ s on mm6,/);
    expect(calls).toEqual(["create c1", "run w.yml:a on c1 (mm11)", "end c1", "create c2 not mm11", "run w.yml:a on c2 (mm6)", "end c2"]);
    // Each attempt's steps see it, as GitHub's re-run's.
    expect(scripts.map((s) => s.split("\n")[0])).toEqual(["export GITHUB_RUN_ATTEMPT=1", "export GITHUB_RUN_ATTEMPT=2"]);
  });

  it("runs a cell whose agent reported no job again elsewhere (mm11, 2026-11-11)", async () => {
    const { exit, log } = await runOne({ minis: ["mm11", "mm6"], faults: { mm11: "no-job" } });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ a: "success" });
    expect(log).toContain("- a: mm11 did not run it (its agent reported no job result");
    expect(log).toMatch(/✓ a · [\d.]+ s on mm6,/);
  });

  it("never runs again a job whose steps failed: that is a verdict", async () => {
    const { exit, calls } = await runOne({ minis: ["mm11", "mm6"], faults: { mm11: "fail" } });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ a: "failure" });
    expect(calls.filter((c) => c.startsWith("run "))).toEqual(["run w.yml:a on c1 (mm11)"]);
  });

  it("gives up, not run (exit 3), once REDISPATCHES + 1 workers failed it, naming each Mini", async () => {
    const { exit, calls } = await runOne({ minis: ["mm11", "mm6", "mm8", "mm9"], faults: { mm11: "lost", mm6: "lost", mm8: "no-job" } });
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: { _tag: string; message: string } }).error : null;
    expect(error?._tag).toBe("NotRun");
    expect(error?.message).toMatch(
      /^a: no worker ran it, 3 tried: mm11: worker w-c1 was lost: ; mm6: worker w-c2 was lost: ; mm8: its agent reported no job result/,
    );
    expect(calls.filter((c) => c.startsWith("create"))).toEqual(["create c1", "create c2 not mm11", "create c3 not mm11,mm6"]);
  });

  it("is not run when the fleet itself gives no VM: no Mini failed, none to leave out", async () => {
    const { exit, calls, log } = await runOne({ minis: [] });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.filter((c) => c.startsWith("create")).every((c) => !c.includes(" not "))).toBe(true);
    expect(log).not.toContain("did not run it");
  });
});

describe("the host's load during a job is in the run's report, beside its VM's", () => {
  it("prints on the job's line the whole host's CPU (mean and peak of its cores) and its peak memory", async () => {
    const { layer } = fakeFleet();
    const lines: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const yaml = "on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";
        const { workflow, jobs, inputs } = yield* prepare("w.yml", yaml, [], [], "acme/app");
        const f = yield* fleet(
          "acme/app",
          () => Effect.succeed("patch"),
          () => Effect.succeed("m"),
          undefined,
          undefined,
          {},
        );
        yield* runWorkflow(workflow, jobs, { repository: "acme/app", ref: "refs/heads/main", inputs }, f.runCell, (line) =>
          Effect.sync(() => void lines.push(line)),
        );
        yield* f.close;
      }).pipe(Effect.provide(layer)),
    );
    expect(lines.join("\n")).toMatch(/✓ a · [\d.]+ s on mm1, main at a{8} · host CPU 63% \(peak 98%\) of 12 · mem 20\.1\/32 GB/);
  });
});

describe("VMs started ahead while a job's needs run", () => {
  const yaml = `on: workflow_dispatch
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      shards: \${{ steps.list.outputs.shards }}
    steps:
      - id: list
        run: echo 'shards=[1,2]' >> "$GITHUB_OUTPUT"
  test:
    needs: plan
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: \${{ fromJSON(needs.plan.outputs.shards) }}
    steps:
      - run: echo "shard \${{ matrix.shard }}"
`;
  const runOn = (cells: Record<string, number>, slow?: string) => {
    const { calls, layer } = fakeFleet(slow);
    return Effect.runPromise(
      Effect.gen(function* () {
        const { workflow, jobs, inputs } = yield* prepare("w.yml", yaml, [], [], "acme/app");
        const f = yield* fleet(
          "acme/app",
          () => Effect.succeed("patch"),
          () => Effect.succeed("m"),
          undefined,
          undefined,
          cells,
        );
        const results = yield* runWorkflow(workflow, jobs, { repository: "acme/app", ref: "refs/heads/main", inputs }, f.runCell, () => Effect.void, f.ahead);
        const learned = yield* f.close;
        return { results: Object.fromEntries(results), learned, calls };
      }).pipe(Effect.provide(layer)),
    );
  };

  it("starts as many VMs for a job as it ran cells last time, runs its cells on them, and ends the ones left", async () => {
    const { results, learned, calls } = await runOn({ test: 3 });
    expect(results).toEqual({ plan: "success", test: "success" });
    // The plan's VM and the 3 started ahead are created before the plan's program runs.
    expect(calls.indexOf("create c4")).toBeLessThan(calls.indexOf("run w.yml:test (1) on c2"));
    expect(calls.indexOf("create c4")).toBeGreaterThan(-1);
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(4);
    const shards = calls.filter((c) => c.startsWith("run w.yml:test"));
    expect(shards.map((c) => c.split(" on ")[1]).sort()).toEqual(["c2", "c3"]);
    // Every VM ended, the one nobody used too; the counts learned for the next run.
    expect(calls.filter((c) => c.startsWith("end")).sort()).toEqual(["end c1", "end c2", "end c3", "end c4"]);
    expect(learned).toEqual({ plan: 1, test: 2 });
  });

  it("gives each cell the first VM ready, the plan included: the run's VMs are all the same", async () => {
    const { results, calls } = await runOn({ test: 2 }, "c1");
    expect(results).toEqual({ plan: "success", test: "success" });
    expect(calls).toContain("run w.yml:plan on c2");
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith("end")).sort()).toEqual(["end c1", "end c2", "end c3"]);
  });

  it("takes a macOS job's VM from the macOS pool only, never a Linux VM started ahead", async () => {
    const { calls, layer } = fakeFleet();
    const mixed = `on: workflow_dispatch
jobs:
  plan:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  mac:
    needs: plan
    runs-on: outrun-macos
    steps: [{ run: "true" }]
`;
    const { results } = await Effect.runPromise(
      Effect.gen(function* () {
        const { workflow, jobs, inputs } = yield* prepare("w.yml", mixed, [], [], "acme/app");
        const f = yield* fleet(
          "acme/app",
          () => Effect.succeed("patch"),
          () => Effect.succeed("m"),
          undefined,
          undefined,
          { mac: 1 },
        );
        const results = yield* runWorkflow(workflow, jobs, { repository: "acme/app", ref: "refs/heads/main", inputs }, f.runCell, () => Effect.void, f.ahead);
        yield* f.close;
        return { results: Object.fromEntries(results) };
      }).pipe(Effect.provide(layer)),
    );
    expect(results).toEqual({ plan: "success", mac: "success" });
    // The plan's Linux VM, and the macOS one started ahead while the plan ran.
    expect(calls.filter((c) => c.startsWith("create"))).toEqual(["create c1", "create c2 macos"]);
    expect(calls).toContain("run w.yml:plan on c1");
    expect(calls).toContain("run w.yml:mac on c2");
  });

  it("with nothing learned, starts a job's VMs once its needs ran", async () => {
    const { results, learned, calls } = await runOn({});
    expect(results).toEqual({ plan: "success", test: "success" });
    expect(calls.indexOf("create c2")).toBeGreaterThan(calls.indexOf("run w.yml:plan on c1"));
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(3);
    expect(learned).toEqual({ plan: 1, test: 2 });
  });
});
