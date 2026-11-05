import { describe, expect, it } from "vitest";
import { parseJunit } from "./junit.ts";

describe("parseJunit", () => {
  it("reads one result per file from bun test's report, nested suites included", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="1">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" failures="0" skipped="0" time="0.25">
    <testsuite name="group" file="a.test.ts" tests="2" failures="0" time="0.2">
      <testcase name="one" time="0.1" />
      <testcase name="two" time="0.1" />
    </testsuite>
  </testsuite>
  <testsuite name="b &amp; c.test.ts" file="b &amp; c.test.ts" tests="1" failures="0" skipped="0" time="0.5">
    <testcase name="three" time="0.5"><failure type="AssertionError" /></testcase>
  </testsuite>
  <testsuite name="empty.test.ts" file="empty.test.ts" tests="0" failures="0" time="0" />
</testsuites>`;
    const results = parseJunit(xml);
    expect(results.get("a.test.ts")).toEqual({ tests: 2, failures: 0, skipped: 0, durationMs: 250 });
    expect(results.get("b & c.test.ts")?.failures).toBe(1);
    expect(results.get("empty.test.ts")?.tests).toBe(0);
  });
});
