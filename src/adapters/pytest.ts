// pytest: a batch is one pytest process given its files, reporting through its JUnit XML with
// each test case's file named (`junit_family=xunit1`), grouped here by file. Exit 5 (no test
// collected) for a file that defines none counts as a pass, as pytest given the whole folder
// would have it.
import { posix } from "node:path";
import { Effect } from "effect";
import { FileFailed, SpawnFailed } from "../errors.ts";
import { parseJunitCases } from "../junit.ts";
import type { Adapter, UnitResult } from "./adapter.ts";

let batchCount = 0;

export const pytestAdapter: Adapter = {
  name: "pytest",
  toolchain: (env) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(["python3", "-c", "import sys,platform;print(sys.version.split()[0],platform.machine())"], {
          stdout: "pipe",
          stderr: "ignore",
          env: env as Record<string, string>,
        });
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        if (code !== 0) throw new Error(`exit ${code}`);
        return `python ${out.trim()} ${process.platform}`;
      },
      catch: (error) => new SpawnFailed({ message: `python3: ${error instanceof Error ? error.message : String(error)}` }),
    }),
  batch: (suite, repo, files, scratch) => {
    const report = `${scratch}/pytest-${process.pid}-${++batchCount}.xml`;
    return {
      argv: [...suite.run, `--junitxml=${report}`, "-o", "junit_family=xunit1", ...files],
      cwd: posix.join(repo, suite.dir),
      results: (exit) =>
        Effect.gen(function* () {
          const xml = yield* Effect.tryPromise({
            try: async () => ((await Bun.file(report).exists()) ? await Bun.file(report).text() : ""),
            catch: () => new FileFailed({ message: `${report}: unreadable` }),
          });
          if (exit.code === 5) return new Map<string, UnitResult>(files.map((f) => [f, { passed: true, durationMs: 0, tests: 0 }]));
          const parsed = parseJunitCases(xml);
          const out = new Map<string, UnitResult>();
          for (const f of files) {
            const r = parsed.get(f);
            if (r) out.set(f, { passed: r.failures === 0, durationMs: r.durationMs, tests: r.tests });
            // Collected nothing from this file while the process ended normally: it defines no test.
            else if ((exit.code === 0 || exit.code === 1) && xml !== "") out.set(f, { passed: true, durationMs: 0, tests: 0 });
          }
          // A collection error fails the run without a test case naming its file: none passes.
          if (exit.code !== 0 && [...out.values()].every((r) => r.passed)) return new Map<string, UnitResult>();
          return out;
        }),
    };
  },
};
