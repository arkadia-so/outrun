// vitest: a batch is one `vitest run` given its files, reporting per file through its JUnit
// reporter (each <testsuite> is a file, named relative to the folder vitest started in). vitest's
// own version comes from the lockfile, which the suite lists among its inputs.
import { posix } from "node:path";
import { Effect } from "effect";
import { FileFailed, SpawnFailed } from "../errors.ts";
import { parseJunit } from "../junit.ts";
import type { Adapter, UnitResult } from "./adapter.ts";

let batchCount = 0;

export const vitestAdapter: Adapter = {
  name: "vitest",
  toolchain: (env) =>
    Effect.tryPromise({
      try: async () => {
        // The runtime vitest runs on: Node where it is installed, else Bun (vitest run with --bun).
        for (const [name, argv] of [
          ["node", ["node", "--version"]],
          ["bun", ["bun", "--revision"]],
        ] as const) {
          const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", env: env as Record<string, string> });
          const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]).catch(() => ["", 1] as const);
          if (code === 0) return `${name} ${out.trim()} ${process.platform}-${process.arch}`;
        }
        throw new Error("neither node nor bun runs here");
      },
      catch: (error) => new SpawnFailed({ message: `vitest's runtime: ${error instanceof Error ? error.message : String(error)}` }),
    }),
  batch: (suite, repo, files, scratch) => {
    const report = `${scratch}/vitest-${process.pid}-${++batchCount}.xml`;
    const cwd = posix.join(repo, suite.dir);
    return {
      argv: [...suite.run, "--reporter=junit", `--outputFile=${report}`, ...files],
      cwd,
      results: (exit) =>
        Effect.gen(function* () {
          const parsed = parseJunit(
            yield* Effect.tryPromise({
              try: async () => ((await Bun.file(report).exists()) ? await Bun.file(report).text() : ""),
              catch: () => new FileFailed({ message: `${report}: unreadable` }),
            }),
          );
          const out = new Map<string, UnitResult>();
          for (const f of files) {
            const r = parsed.get(f) ?? parsed.get(`./${f}`);
            if (r) out.set(f, { passed: r.failures === 0, durationMs: r.durationMs, tests: r.tests });
          }
          // Failed while every file it reported passed (an error outside any test: a failed
          // setup, an unhandled rejection): which file caused it is unknown, so none passes.
          if (exit.code !== 0 && [...out.values()].every((r) => r.passed)) return new Map<string, UnitResult>();
          return out;
        }),
    };
  },
};
