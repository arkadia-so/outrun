import { describe, expect, it } from "vitest";
import { e2eResults, withJunit } from "./e2e.ts";

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
});
