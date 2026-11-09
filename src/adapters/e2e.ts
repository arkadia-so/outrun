// e2e (TesterArmy's end-to-end runner): a batch is one `e2e run` given its files, in the config's
// folder (its project root), reporting per file through its JUnit reporter: one <testsuite> per test
// file, named relative to the project root, and a `run` suite for a run-level error (an app that
// never answered), which leaves no file passed. The report goes under `.e2e/` (the CLI refuses an
// output outside the project root; `.e2e/` is the folder its own runs write and ignore). The CLI's
// own version comes from the lockfile, which the discovered suites key (discover.ts).
//
// A batch of tests (`file:line` units, discover.ts) is given as those positionals, and its results
// come from e2e's own report (`report.json`, schema report-v1): each result names the line its test
// is declared at and its serial group, so a group's members fold into the group's unit at its first
// line. The JUnit report is still written, for the run's merged report.
import { Effect } from "effect";
import { nearestCli } from "../discover.ts";
import { FileFailed, SpawnFailed } from "../errors.ts";
import { parseJunit } from "../junit.ts";
import type { Adapter, UnitResult } from "./adapter.ts";

let batchCount = 0;

/** Pure: per-file results of an e2e JUnit report for these files (a run-level error passes none). */
export const e2eResults = (xml: string, files: readonly string[], exitCode: number | null): Map<string, UnitResult> => {
  const parsed = parseJunit(xml);
  const out = new Map<string, UnitResult>();
  if ((parsed.get("run")?.failures ?? 0) > 0) return out;
  for (const f of files) {
    const r = parsed.get(f);
    if (r) out.set(f, { passed: r.failures === 0, durationMs: r.durationMs, tests: r.tests });
  }
  // Failed while every file it reported passed: what failed is unknown, so none passes.
  if (exitCode !== 0 && [...out.values()].every((r) => r.passed)) return new Map();
  return out;
};

interface ReportResult {
  readonly file?: unknown;
  readonly source?: { readonly line?: unknown };
  readonly serialGroupId?: unknown;
  readonly status?: unknown;
  readonly attempts?: readonly { readonly durationMs?: unknown }[];
}

/**
 * Pure: per-test results of e2e's report.json for these `file:line` units. A result counts toward the
 * unit at its line, a serial group's toward the group's first line; a unit passes when none of its
 * results failed or timed out, and one with an interrupted result, or none, did not finish. A
 * run-level error, or a failed exit while every unit passed, passes none.
 */
export const e2eTestResults = (json: string, units: readonly string[], exitCode: number | null): Map<string, UnitResult> => {
  let parsed: { run?: { errors?: readonly unknown[]; results?: readonly ReportResult[] } };
  try {
    parsed = JSON.parse(json);
  } catch {
    return new Map();
  }
  const run = parsed.run ?? {};
  if ((run.errors ?? []).length > 0) return new Map();
  const results = (run.results ?? []).filter(
    (r): r is ReportResult & { file: string; source: { line: number } } => typeof r.file === "string" && typeof r.source?.line === "number",
  );
  const first = new Map<string, number>();
  for (const r of results)
    if (typeof r.serialGroupId === "string") {
      const id = `${r.file}\0${r.serialGroupId}`;
      first.set(id, Math.min(first.get(id) ?? r.source.line, r.source.line));
    }
  const wanted = new Set(units);
  const acc = new Map<string, { failed: boolean; unfinished: boolean; durationMs: number; tests: number }>();
  for (const r of results) {
    const line = typeof r.serialGroupId === "string" ? (first.get(`${r.file}\0${r.serialGroupId}`) as number) : r.source.line;
    // A file with no lines listed is a unit of its own.
    const unit = wanted.has(r.file) ? r.file : `${r.file}:${line}`;
    if (!wanted.has(unit)) continue;
    const a = acc.get(unit) ?? { failed: false, unfinished: false, durationMs: 0, tests: 0 };
    a.failed ||= r.status === "failed" || r.status === "timed-out";
    a.unfinished ||= r.status === "interrupted";
    a.durationMs += (r.attempts ?? []).reduce((s, x) => s + (typeof x.durationMs === "number" ? x.durationMs : 0), 0);
    a.tests += 1;
    acc.set(unit, a);
  }
  const out = new Map<string, UnitResult>();
  for (const [unit, a] of acc) if (!a.unfinished) out.set(unit, { passed: !a.failed, durationMs: a.durationMs, tests: a.tests });
  if (exitCode !== 0 && [...out.values()].every((r) => r.passed)) return new Map();
  return out;
};

/** Pure: whether a batch's files are tests within files (`file:line`), not whole files. */
const LINE = /:\d+$/;

/** Pure: the run's argv with junit among its reporters (`--reporter a,b` or a list of its own). */
export const withJunit = (run: readonly string[]): string[] => {
  const at = run.indexOf("--reporter");
  if (at < 0 || at === run.length - 1) return [...run, "--reporter", "junit"];
  const reporters = (run[at + 1] as string).split(",");
  return [...run.slice(0, at + 1), [...new Set([...reporters, "junit"])].join(","), ...run.slice(at + 2)];
};

/**
 * Pure: the argv of a discovered suite's run, its `e2e` the CLI installed nearest to the config (under
 * Node), given its path relative to the config's folder; any other run is the suite's own.
 */
export const withCli = (run: readonly string[], cli: string | undefined): string[] =>
  run[0] === "e2e" && cli !== undefined ? ["node", cli, ...run.slice(1)] : [...run];

export const e2eAdapter: Adapter = {
  name: "e2e",
  toolchain: (env) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(["node", "--version"], { stdout: "pipe", stderr: "ignore", env: env as Record<string, string> });
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        if (code !== 0) throw new Error(`exit ${code}`);
        return `node ${out.trim()} ${process.platform}-${process.arch}`;
      },
      catch: (error) =>
        new SpawnFailed({
          message: `node --version: ${error instanceof Error ? error.message : String(error)} (TesterArmy's e2e CLI runs on Node)`,
        }),
    }),
  batch: (suite, repo, files) => {
    const output = `.e2e/outrun-${process.pid}-${++batchCount}`;
    const cwd = suite.dir === "." ? repo : `${repo}/${suite.dir}`;
    const report = `${cwd}/${output}/junit.xml`;
    const tests = files.some((f) => LINE.test(f));
    if (tests) {
      const json = `${cwd}/${output}/report.json`;
      return {
        argv: [...withJunit(withCli(suite.run, nearestCli(repo, suite.dir))), "--output", output, ...files],
        cwd,
        results: (exit) =>
          Effect.tryPromise({
            try: async () => ((await Bun.file(json).exists()) ? await Bun.file(json).text() : ""),
            catch: () => new FileFailed({ message: `${json}: unreadable` }),
          }).pipe(Effect.map((text) => e2eTestResults(text, files, exit.code))),
      };
    }
    return {
      // The suite's run names its progress reporter (list); junit is added for the per-file results.
      argv: [...withJunit(withCli(suite.run, nearestCli(repo, suite.dir))), "--output", output, ...files],
      cwd,
      results: (exit) =>
        Effect.tryPromise({
          try: async () => ((await Bun.file(report).exists()) ? await Bun.file(report).text() : ""),
          catch: () => new FileFailed({ message: `${report}: unreadable` }),
        }).pipe(Effect.map((xml) => e2eResults(xml, files, exit.code))),
    };
  },
};
