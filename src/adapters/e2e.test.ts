import { describe, expect, it } from "vitest";
import { e2eResults, e2eTestResults, withCli, withJunit } from "./e2e.ts";

const report = (suites: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="e2e">\n${suites}\n</testsuites>\n`;

describe("the e2e adapter", () => {
  it("reads each file's verdict from its testsuite", () => {
    const xml = report(
      [
        `<testsuite name="e2e/a.e2e.ts" tests="1" failures="0" errors="0" skipped="0" time="0.602"><testcase name="adds [web]" classname="e2e/a.e2e.ts" time="0.602"/></testsuite>`,
        `<testsuite name="e2e/b.e2e.ts" tests="2" failures="1" errors="0" skipped="0" time="0.020"><testcase name="fails [web]" classname="e2e/b.e2e.ts" time="0.013"><failure message="x" type="ASSERTION_FAILED">x</failure></testcase></testsuite>`,
      ].join("\n"),
    );
    const results = e2eResults(xml, ["e2e/a.e2e.ts", "e2e/b.e2e.ts", "e2e/c.e2e.ts"], 1);
    expect(results.get("e2e/a.e2e.ts")).toEqual({ passed: true, durationMs: 602, tests: 1 });
    expect(results.get("e2e/b.e2e.ts")?.passed).toBe(false);
    expect(results.has("e2e/c.e2e.ts")).toBe(false);
  });

  it("passes no file when the run itself failed (an app that never answered)", () => {
    const xml = report(
      [
        `<testsuite name="e2e/a.e2e.ts" tests="1" failures="0" errors="0" skipped="0" time="0.1"><testcase name="a" classname="e2e/a.e2e.ts" time="0.1"/></testsuite>`,
        `<testsuite name="run" tests="1" failures="0" errors="1" skipped="0" time="0.000"><testcase name="APP_UNREACHABLE" classname="run" time="0.000"><error message="no" type="APP_UNREACHABLE">no</error></testcase></testsuite>`,
      ].join("\n"),
    );
    expect(e2eResults(xml, ["e2e/a.e2e.ts"], 1).size).toBe(0);
  });

  it("passes no file when the CLI failed after reporting only passes", () => {
    const xml = report(`<testsuite name="e2e/a.e2e.ts" tests="1" failures="0" errors="0" skipped="0" time="0.1"></testsuite>`);
    expect(e2eResults(xml, ["e2e/a.e2e.ts"], 2).size).toBe(0);
    expect(e2eResults(xml, ["e2e/a.e2e.ts"], 0).get("e2e/a.e2e.ts")?.passed).toBe(true);
  });

  it("adds junit to the run's reporters", () => {
    expect(withJunit(["node", "cli.js", "run"])).toEqual(["node", "cli.js", "run", "--reporter", "junit"]);
    expect(withJunit(["node", "cli.js", "run", "--reporter", "list", "--config", "e2e.config.ts"])).toEqual([
      "node",
      "cli.js",
      "run",
      "--reporter",
      "list,junit",
      "--config",
      "e2e.config.ts",
    ]);
  });

  it("runs a discovered suite's `e2e` on the CLI installed nearest its config, under Node", () => {
    expect(withCli(["e2e", "run", "--config", "e2e.config.ts"], "../node_modules/e2e/dist/cli/bin.js")).toEqual([
      "node",
      "../node_modules/e2e/dist/cli/bin.js",
      "run",
      "--config",
      "e2e.config.ts",
    ]);
    expect(withCli(["npx", "e2e", "run"], "x.js")).toEqual(["npx", "e2e", "run"]);
    expect(withCli(["e2e", "run"], undefined)).toEqual(["e2e", "run"]);
  });

  it("reads each test's verdict from report.json by its line, a serial group's at its first line", () => {
    const r = (file: string, line: number, status: string, serialGroupId: string | null = null, ms = 100) => ({
      file,
      source: { file, line, column: 1 },
      serialGroupId,
      status,
      attempts: status === "skipped" ? [] : [{ durationMs: ms }],
    });
    const json = JSON.stringify({
      run: {
        errors: [],
        results: [
          r("e2e/a.e2e.ts", 3, "passed"),
          r("e2e/a.e2e.ts", 7, "failed"),
          r("e2e/a.e2e.ts", 12, "flaky", "g", 50),
          r("e2e/a.e2e.ts", 10, "passed", "g", 70),
          r("e2e/a.e2e.ts", 20, "interrupted"),
          r("e2e/a.e2e.ts", 30, "skipped"),
          r("e2e/b.e2e.ts", 1, "timed-out"),
        ],
      },
    });
    const units = ["e2e/a.e2e.ts:3", "e2e/a.e2e.ts:7", "e2e/a.e2e.ts:10", "e2e/a.e2e.ts:20", "e2e/b.e2e.ts:1", "e2e/c.e2e.ts:4"];
    const results = e2eTestResults(json, units, 1);
    expect(results.get("e2e/a.e2e.ts:3")).toEqual({ passed: true, durationMs: 100, tests: 1 });
    expect(results.get("e2e/a.e2e.ts:7")?.passed).toBe(false);
    expect(results.get("e2e/a.e2e.ts:10")).toEqual({ passed: true, durationMs: 120, tests: 2 });
    expect(results.get("e2e/b.e2e.ts:1")?.passed).toBe(false);
    // Interrupted, or not in the report: unfinished. A test the run skipped and no unit names: ignored.
    expect(results.has("e2e/a.e2e.ts:20")).toBe(false);
    expect(results.has("e2e/c.e2e.ts:4")).toBe(false);
    expect(results.has("e2e/a.e2e.ts:30")).toBe(false);
  });

  it("passes no test after a run-level error, or a failed exit with every test passed", () => {
    const one = { file: "e2e/a.e2e.ts", source: { line: 3 }, status: "passed", attempts: [{ durationMs: 1 }] };
    expect(e2eTestResults(JSON.stringify({ run: { errors: [{ code: "APP_UNREACHABLE" }], results: [one] } }), ["e2e/a.e2e.ts:3"], 1).size).toBe(0);
    expect(e2eTestResults(JSON.stringify({ run: { errors: [], results: [one] } }), ["e2e/a.e2e.ts:3"], 1).size).toBe(0);
    expect(e2eTestResults(JSON.stringify({ run: { errors: [], results: [one] } }), ["e2e/a.e2e.ts:3"], 0).size).toBe(1);
    expect(e2eTestResults("", ["e2e/a.e2e.ts:3"], 0).size).toBe(0);
  });
});
