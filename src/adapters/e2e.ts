// e2e (TesterArmy's end-to-end runner): a batch is one `e2e run` given its files, in the config's
// folder (its project root), reporting per file through its JUnit reporter: one <testsuite> per test
// file, named relative to the project root, and a `run` suite for a run-level error (an app that
// never answered), which leaves no file passed. The report goes under `.e2e/` (the CLI refuses an
// output outside the project root; `.e2e/` is the folder its own runs write and ignore). The CLI's
// own version comes from the lockfile, which the discovered suites key (discover.ts).
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
