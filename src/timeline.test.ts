import { describe, expect, it } from "vitest";
import { formatReport, runOf } from "./report.ts";
import { type ApiJob, type ApiStep, timeline, type WorkflowFiles } from "./timeline.ts";
import { parseWorkflow, type Workflow } from "./workflow.ts";

const T0 = Date.UTC(2026, 10, 18, 9);
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const parsed = (path: string, text: string): Workflow => {
  const result = parseWorkflow(path, text);
  if ("refusals" in result) throw new Error(JSON.stringify(result.refusals));
  return result.workflow;
};

// A step list as GitHub gives it: [name, seconds] run back to back from [start], numbered as GitHub numbers them
// (the workflow's steps first, the post steps after a gap).
const steps = (start: number, list: readonly (readonly [string, number, string?])[]): ApiStep[] => {
  let t = start;
  return list.map(([name, sec, conclusion], i) => {
    const step = {
      name,
      number: name.startsWith("Post ") || name.startsWith("Complete") ? 20 + i : i + 1,
      conclusion: conclusion ?? "success",
      started_at: at(t),
      completed_at: at(t + sec),
    };
    t += sec;
    return step;
  });
};

let nextId = 1;
/** A job queued at [queued], started at [start], its steps from start + 1, done [after] seconds after its last step. */
const job = (
  name: string,
  queued: number,
  start: number,
  list: readonly (readonly [string, number, string?])[],
  extra: Partial<ApiJob> = {},
  after = 2,
): ApiJob => {
  const s = steps(start + 1, list);
  const last = s.length ? Date.parse(s[s.length - 1]!.completed_at!) / 1000 - T0 / 1000 : start;
  return {
    id: nextId++,
    run_id: 7,
    run_attempt: 1,
    labels: ["ubuntu-latest"],
    name,
    conclusion: "success",
    status: "completed",
    created_at: at(queued),
    started_at: at(start),
    completed_at: at(last + after),
    runner_name: "runner-1",
    steps: s,
    ...extra,
  };
};

const WORKFLOW = `name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - name: Restore the build cache
        uses: actions/cache/restore@v4
        with: { path: x, key: y }
      - run: npm ci
      - name: Build
        run: |
          npm run build
          npm run pack
      - uses: actions/cache/save@v4
        with: { path: x, key: y }
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
  test:
    needs: build
    name: test (\${{ matrix.shard }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - uses: actions/checkout@v4
      - name: Tests
        run: npm test
  e2e:
    needs: [build]
    uses: ./.github/workflows/e2e.yml
  done:
    needs: [lint, test, e2e]
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
const E2E = `name: e2e
on: workflow_call
jobs:
  browser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright test
  report:
    needs: browser
    runs-on: ubuntu-latest
    steps:
      - run: echo report
`;
const files = (): WorkflowFiles => ({
  workflow: parsed(".github/workflows/ci.yml", WORKFLOW),
  callees: new Map([["./.github/workflows/e2e.yml", parsed(".github/workflows/e2e.yml", E2E)]]),
});

// The run: build (0-60), lint (0-20), test (1) and (2) after build, e2e / browser then e2e / report after build, done last.
const runJobs = (): ApiJob[] => [
  job("build", 0, 3, [
    ["Set up job", 2],
    ["Set up runner", 1],
    ["Run actions/checkout@v4", 3],
    ["Run actions/setup-node@v4", 4],
    ["Restore the build cache", 5],
    ["Run npm ci", 10],
    ["Build", 20],
    ["Run actions/cache/save@v4", 6],
    ["Post Run actions/checkout@v4", 1],
    ["Complete runner", 0],
    ["Complete job", 1],
  ]),
  job("lint", 0, 2, [
    ["Set up job", 1],
    ["Run actions/checkout@v4", 2],
    ["Run npm run lint", 7],
    ["Post Run actions/checkout@v4", 0],
    ["Complete job", 0],
  ]),
  // build completed at 3 + 1 + 53 + 2 = 59.
  job("test (1)", 59, 64, [
    ["Set up job", 2],
    ["Run actions/checkout@v4", 2],
    ["Tests", 30],
    ["Complete job", 1],
  ]),
  job("test (2)", 59, 61, [
    ["Set up job", 2],
    ["Run actions/checkout@v4", 2],
    ["Tests", 20],
    ["Complete job", 1],
  ]),
  job("e2e / browser", 59, 60, [
    ["Set up job", 1],
    ["Run actions/checkout@v4", 2],
    ["Run npx playwright test", 25],
    ["Complete job", 0],
  ]),
  job("e2e / report", 91, 92, [
    ["Set up job", 1],
    ["Run echo report", 1],
    ["Complete job", 0],
  ]),
  // test (1) completed at 64 + 1 + 35 + 2 = 102.
  job("done", 102, 104, [
    ["Set up job", 1],
    ["Run echo ok", 1],
    ["Complete job", 0],
  ]),
];

describe("outrun report: where a run's time goes", () => {
  it("splits each job into pickup, setup, work and post from its steps, matched to the workflow's steps in order", () => {
    const t = timeline(runJobs(), files());
    const build = t.jobs.find((j) => j.name === "build")!;
    expect(build).toMatchObject({ workflowJob: "build", pickupSec: 3, spanSec: 56 });
    // Set up job 2 + Set up runner 1 + checkout 3 + setup-node 4 + the cache restore 5.
    expect(build.setupSec).toBe(15);
    // npm ci 10 + Build 20 (its name: the step's `name:`; npm ci's: `Run ` and its run line).
    expect(build.workSec).toBe(30);
    // The cache save 6 + its post steps 1 + 0 + 1.
    expect(build.postSec).toBe(8);
    // 56 − 53 of steps: 1 s before the first step, 2 s after the last.
    expect(build.outsideStepsSec).toBe(3);
    expect(build.steps.map((s) => [s.name, s.phase, s.rule])).toEqual([
      ["Set up job", "setup", "Set up job"],
      ["Set up runner", "setup", "Set up runner"],
      ["Run actions/checkout@v4", "setup", "checkout"],
      ["Run actions/setup-node@v4", "setup", "setup action"],
      ["Restore the build cache", "setup", "cache restore"],
      ["Run npm ci", "work", "run:"],
      ["Build", "work", "run:"],
      ["Run actions/cache/save@v4", "post", "cache save"],
      ["Post Run actions/checkout@v4", "post", "post step"],
      ["Complete runner", "post", "Complete runner"],
      ["Complete job", "post", "Complete job"],
    ]);
  });

  it("maps a matrix cell to its job by its name with the matrix values, and a reusable workflow's job as caller / callee", () => {
    const t = timeline(runJobs(), files());
    expect(Object.fromEntries(t.jobs.map((j) => [j.name, j.workflowJob]))).toEqual({
      build: "build",
      lint: "lint",
      "test (1)": "test",
      "test (2)": "test",
      "e2e / browser": "e2e/browser",
      "e2e / report": "e2e/report",
      done: "done",
    });
  });

  it("follows the chain of needs that ends last: the job ending last, then back through its need that completed last", () => {
    const t = timeline(runJobs(), files());
    // done needs lint, test and e2e (each of e2e's jobs); its last need to complete is test (1), which needs build.
    expect(t.chain).toEqual([
      { name: "build", afterNeedSec: 0 },
      { name: "test (1)", afterNeedSec: 0 },
      { name: "done", afterNeedSec: 0 },
    ]);
    expect(t.wall).toEqual({ start: at(0), end: at(107), seconds: 107 });
  });

  it("gives each job off the chain its slack: how much later it could end before delaying a job that needs it", () => {
    const t = timeline(runJobs(), files());
    // done's needs were all done at 102 (test (1)): lint ended at 15, test (2) at 89, e2e / report at 97.
    // e2e / browser ended at 91; e2e / report took 97 − 91 = 6 s after it, so browser could end at 102 − 6 = 96.
    expect(Object.fromEntries(t.offChain!.map((o) => [o.name, o.slackSec]))).toEqual({ lint: 87, "test (2)": 13, "e2e / browser": 5, "e2e / report": 5 });
  });

  it("estimates the speed of light: the run's shortest pickup + the longest work of one job + that job's setup no cache removes", () => {
    const t = timeline(runJobs(), files());
    // Shortest pickup: e2e / browser, 1 s. Longest work: build, 30 s (test (1)'s is 30 too: the first found wins).
    // build's Set up job 2 + Set up runner 1 + checkout 3 = 6 (setup-node and the cache restore can be cached).
    expect(t.speedOfLight).toEqual({
      estimated: true,
      pickupSec: 1,
      pickupJob: "e2e / browser",
      workSec: 30,
      workJob: "build",
      setupSec: 6,
      seconds: 37,
      gapSec: 70,
    });
  });

  it("names the job a lever must touch: the chain's job taking the most of the run, and its largest step", () => {
    const t = timeline(runJobs(), files());
    // build: 0 + 3 + 56 = 59; test (1): 0 + 5 + 38 = 43; done: 0 + 2 + 5 = 7.
    expect(t.lever).toEqual({ job: "build", step: "Build", seconds: 20 });
  });

  it("names the pickup as the lever when the heaviest chain job waited longer for a runner than any of its steps", () => {
    const jobs = runJobs().map((j) => (j.name === "build" ? { ...j, created_at: at(-40) } : j));
    expect(timeline(jobs, files()).lever).toEqual({ job: "build", step: "pickup", seconds: 43 });
  });

  it("leaves steps unclassified when GitHub's do not match the workflow's, and claims no speed of light then", () => {
    const jobs = runJobs().map((j) =>
      j.name === "lint"
        ? {
            ...j,
            steps: steps(3, [
              ["Set up job", 1],
              ["Run actions/checkout@v4", 2],
              ["Run npm run format", 7],
              ["Complete job", 0],
            ]),
          }
        : j,
    );
    const t = timeline(jobs, files());
    const lint = t.jobs.find((j) => j.name === "lint")!;
    expect(lint.unmatched).toBe(`step 2: GitHub's "Run npm run format" is not the workflow's step 2`);
    expect([lint.setupSec, lint.workSec, lint.unclassifiedSec]).toEqual([1, 0, 9]);
    expect(t.speedOfLight).toBeUndefined();
    expect(t.noSpeedOfLight).toMatch(/lint/);
    // The chain does not depend on steps: still claimed.
    expect(t.chain?.map((l) => l.name)).toEqual(["build", "test (1)", "done"]);
  });

  it("counts a skipped step in its place, so the steps after it still match", () => {
    const jobs = runJobs().map((j) =>
      j.name === "lint"
        ? {
            ...j,
            steps: steps(3, [
              ["Set up job", 1],
              ["Run actions/checkout@v4", 2, "skipped"],
              ["Run npm run lint", 7],
              ["Complete job", 0],
            ]),
          }
        : j,
    );
    expect(timeline(jobs, files()).jobs.find((j) => j.name === "lint")!.unmatched).toBeUndefined();
  });

  it("maps a job whose name several workflow jobs match to none, and claims no chain ending on it", () => {
    const twice = WORKFLOW.replace("  lint:\n    runs-on", "  lint:\n    name: done\n    runs-on");
    const t = timeline(runJobs(), { workflow: parsed(".github/workflows/ci.yml", twice), callees: new Map() });
    expect(t.jobs.find((j) => j.name === "done")!.unmatched).toBe("its name matches several jobs of the workflow file (lint, done)");
    expect(t.chain).toBeUndefined();
    expect(t.noChain).toMatch(/^the job ending last, done, maps to no job of the workflow file/);
  });

  it("gives per-job times only without the workflow file, and says why no chain is claimed", () => {
    const t = timeline(runJobs(), { why: "the run names no workflow file" });
    expect(t.chain).toBeUndefined();
    expect(t.noChain).toBe("the run names no workflow file");
    const build = t.jobs.find((j) => j.name === "build")!;
    // The runner's own steps are known without the file; the workflow's are not.
    expect([build.pickupSec, build.setupSec, build.workSec, build.postSec, build.unclassifiedSec]).toEqual([3, 3, 0, 2, 48]);
  });

  it("leaves a job carried from an earlier attempt off the chain, and says the chain stops there", () => {
    const jobs = runJobs().map((j) => (j.name === "build" ? { ...j, run_attempt: 2, created_at: at(200), started_at: at(3) } : j));
    const t = timeline(jobs, files());
    expect(t.notRun).toEqual([{ name: "build", why: "carried from an earlier attempt" }]);
    expect(t.chain?.map((l) => l.name)).toEqual(["test (1)", "done"]);
    expect(t.noChain).toMatch(/^test \(1\) needs build, carried from an earlier attempt/);
  });

  it("reads a run from its URL, with its attempt, or from its id and --repo", () => {
    expect(runOf("https://github.com/acme/app/actions/runs/123/attempts/2", undefined)).toEqual({ repo: "acme/app", id: 123, attempt: 2 });
    expect(runOf("https://github.com/acme/app/actions/runs/123/job/456", undefined)).toEqual({ repo: "acme/app", id: 123 });
    expect(runOf("123", "acme/app")).toEqual({ repo: "acme/app", id: 123 });
    expect(runOf("123", undefined)).toMatchObject({ _tag: "UsageInvalid" });
  });

  it("prints the wall clock, the chain, the jobs off it, the speed of light with its arithmetic, and the lever", () => {
    const text = formatReport(
      {
        repo: "acme/app",
        id: 7,
        attempt: 1,
        run: { id: 7, head_sha: "abcdef0123", path: ".github/workflows/ci.yml", event: "push", head_branch: "main", conclusion: "success" },
        source: "ci.yml",
      },
      timeline(runJobs(), files()),
    );
    expect(text).toContain("wall clock: 107 s");
    expect(text).toContain("critical path (3 jobs");
    expect(text).toMatch(/ {2}build +pickup 3 s, setup 15 s, work 30 s, post 8 s, outside steps 3 s/);
    expect(text).toMatch(/lint .*; slack 87 s/);
    expect(text).toContain("speed of light (estimated): 37 s = 1 s pickup");
    expect(text).toContain("gap: 70 s");
    expect(text).toContain("to shorten this run: build (Build, 20 s)");
  });
});
