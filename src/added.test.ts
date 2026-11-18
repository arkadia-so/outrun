import { describe, expect, it } from "vitest";
import { formatAdded, jobAdded, timeoutOf } from "./added.ts";
import { median, quantile } from "./stats.ts";
import type { ApiJob, WorkflowFiles } from "./timeline.ts";
import { parseWorkflow } from "./workflow.ts";

const T0 = Date.UTC(2026, 10, 18, 9);
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

let nextId = 1;
/** A job whose steps [name, seconds] run back to back from its start (a "skip" third item: skipped). */
const job = (list: readonly (readonly [string, number, "skip"?])[], name = "test"): ApiJob => {
  let t = 0;
  const steps = list.map(([step, sec, skip], i) => {
    const s = {
      name: step,
      number: i + 1,
      conclusion: skip ? "skipped" : "success",
      started_at: skip ? null : at(t),
      completed_at: skip ? null : at(t + sec),
    };
    t += sec;
    return s;
  });
  return {
    id: nextId++,
    run_id: 1,
    name,
    labels: [],
    conclusion: "success",
    created_at: at(-2),
    started_at: at(0),
    completed_at: at(t),
    runner_name: "r",
    steps,
  };
};

const base = (tests: number) =>
  job([
    ["Set up job", 2],
    ["checkout", 3],
    ["Run tests", tests],
    ["Complete job", 1],
  ]);

describe("the order statistics every report shares", () => {
  it("p90 is the nearest rank and the median the mean of the two middle values", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(ten, 0.9)).toBe(9);
    expect(median(ten)).toBe(5.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(quantile([], 0.9)).toBe(0);
  });
});

describe("time added per change", () => {
  const history = [20, 21, 22, 20, 23, 21, 20, 22, 21, 24].map(base);

  it("a step absent from most of the history appeared, and its whole time is what it added", () => {
    const now = job([
      ["Set up job", 2],
      ["checkout", 3],
      ["Run tests", 21],
      ["Run lint", 40],
      ["Complete job", 1],
    ]);
    const out = jobAdded(now, history, 10);
    expect(out.added).toEqual({ step: "Run lint", kind: "appeared", stepSec: 40, addedSec: 40, present: 0, historyRuns: 10 });
  });

  it("a step that grew beyond its history's p90 is named with how much against the median, and n, median and p90", () => {
    const out = jobAdded(base(50), history, 10);
    // History of "Run tests": 20 20 20 21 21 21 22 22 23 24 → median 21, p90 23.
    expect(out.added).toEqual({
      step: "Run tests",
      kind: "grew",
      stepSec: 50,
      addedSec: 29,
      present: 10,
      historyRuns: 10,
      spread: { n: 10, medianSec: 21, p90Sec: 23 },
    });
  });

  it("growth within the history's spread is not reported, nor 1 s past its p90 (GitHub's step times are whole seconds)", () => {
    expect(jobAdded(base(23), history, 10).added).toBeUndefined();
    expect(jobAdded(base(24), history, 10).added).toBeUndefined();
    expect(jobAdded(base(25), history, 10).added).toMatchObject({ step: "Run tests", kind: "grew", addedSec: 4 });
  });

  it("every step that appeared is named, the one that added most first", () => {
    const now = job([
      ["Set up job", 2],
      ["checkout", 3],
      ["Restore durations", 1],
      ["Run tests", 21],
      ["Save durations", 1],
      ["Run lint", 40],
      ["Complete job", 1],
    ]);
    const out = jobAdded(now, history, 10);
    expect(out.added?.step).toBe("Run lint");
    expect(out.alsoAppeared?.map((a) => [a.step, a.addedSec])).toEqual([
      ["Restore durations", 1],
      ["Save durations", 1],
    ]);
  });

  it("the step that added most wins over a smaller one", () => {
    const now = job([
      ["Set up job", 9],
      ["checkout", 3],
      ["Run tests", 30],
      ["Complete job", 1],
    ]);
    expect(jobAdded(now, history, 10).added?.step).toBe("Run tests");
  });

  it("a step skipped in most of the history and run now appeared; a step skipped now is not weighed", () => {
    const withSkip = (sec: number, skip: boolean) =>
      job([["Set up job", 2], ["checkout", 3], ["Run tests", 21], skip ? ["Deploy", sec, "skip"] : ["Deploy", sec], ["Complete job", 1]]);
    const past = [1, 2, 3, 4, 5].map(() => withSkip(0, true));
    expect(jobAdded(withSkip(15, false), past, 3).added?.kind).toBe("appeared");
    expect(jobAdded(withSkip(15, true), past, 3).added).toBeUndefined();
  });

  it("a step name used twice is two steps, matched by occurrence", () => {
    const twice = (a: number, b: number) =>
      job([
        ["Run make", a],
        ["Run make", b],
      ]);
    const out = jobAdded(
      twice(5, 60),
      [1, 2, 3].map(() => twice(5, 6)),
      10,
    );
    expect(out.added).toMatchObject({ step: "Run make", kind: "grew", addedSec: 54 });
  });

  it("under 3 runs of history no step is weighed and no budget comes from it", () => {
    const out = jobAdded(base(50), history.slice(0, 2), "it sets no timeout-minutes");
    expect(out.added).toBeUndefined();
    expect(out.tooShort).toBe("2 earlier runs of this job (3 needed)");
    expect(out.noBudget).toBe("it sets no timeout-minutes, and its history holds 2 runs (3 needed for a p90)");
  });
});

describe("a job's budget", () => {
  const history = [26, 27, 28, 26, 29, 27, 26, 28, 27, 30].map((total) => base(total - 6));

  it("is its timeout-minutes, and the report says when the job went over", () => {
    const out = jobAdded(base(200), history, 3);
    expect(out.budget).toEqual({ seconds: 180, from: "timeout-minutes", overSec: 26 });
  });

  it("is the p90 of its history without timeout-minutes", () => {
    const out = jobAdded(base(24), history, "it sets no timeout-minutes");
    // Spans 26 26 26 27 27 27 28 28 29 30: p90 29; this one 30.
    expect(out.budget).toEqual({ seconds: 29, from: "history", noTimeout: "it sets no timeout-minutes", overSec: 1 });
    expect(out.history).toEqual({ n: 10, medianSec: 27, p90Sec: 29 });
  });

  it("comes from the workflow job's timeout-minutes, a reusable workflow's job included, never an expression", () => {
    const wf = (path: string, text: string) => {
      const r = parseWorkflow(path, text);
      if ("refusals" in r) throw new Error(JSON.stringify(r.refusals));
      return r.workflow;
    };
    // A GitHub expression, written in two parts so it reads as no template string.
    const expr = "$" + "{{ inputs.t }}";
    const main = wf(
      ".github/workflows/ci.yml",
      "on: push\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: true\n  b:\n    runs-on: x\n    timeout-minutes: " +
        expr +
        "\n    steps:\n      - run: true\n  c:\n    uses: ./.github/workflows/inner.yml\n  d:\n    runs-on: x\n    steps:\n      - run: true\n",
    );
    const inner = wf(
      ".github/workflows/inner.yml",
      "on: workflow_call\njobs:\n  test:\n    runs-on: x\n    timeout-minutes: 7\n    steps:\n      - run: true\n",
    );
    const files: WorkflowFiles = { workflow: main, callees: new Map([["./.github/workflows/inner.yml", inner]]) };
    expect(timeoutOf(files, "a")).toBe(5);
    expect(timeoutOf(files, "b")).toBe(`its timeout-minutes is "${expr}", not a number`);
    expect(timeoutOf(files, "c/test")).toBe(7);
    expect(timeoutOf(files, "d")).toBe("it sets no timeout-minutes");
    expect(timeoutOf(undefined, "a")).toBe("the workflow file was not read");
  });
});

describe("the time-added section", () => {
  it("prints the job's history, its budget, the step that added most and an over-budget flag", () => {
    const history = [20, 21, 22, 20, 23, 21, 20, 22, 21, 24].map(base);
    const lines = formatAdded({ workflow: "ci.yml", branch: "main", runs: 10, requests: 12 }, [jobAdded(base(200), history, 3)]);
    expect(lines.slice(2)).toEqual([
      "  ! test: 206 s; history n 10, median 27 s, p90 29 s; budget 3 min (its timeout-minutes)",
      "    ! over its budget by 26 s",
      '    + "Run tests" grew 179 s: 200 s against n 10, median 21 s, p90 23 s',
    ]);
  });
});
