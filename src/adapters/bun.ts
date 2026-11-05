// bun test: a batch is one `bun test` process given its files (`./`-prefixed, or bun reads them
// as name filters), reporting per file through its JUnit reporter.
import { posix } from "node:path";
import { Effect } from "effect";
import { FileFailed, SpawnFailed } from "../errors.ts";
import { parseJunit } from "../junit.ts";
import type { Adapter, UnitResult } from "./adapter.ts";

let batchCount = 0;

/** Pure: whether bun's summary says it ran no test, failed none, across exactly these files. */
const noTests = (output: string, files: number) => {
  const ran = /^Ran 0 tests across (\d+) files?\./m.exec(output);
  return ran !== null && Number(ran[1]) === files && /^ 0 fail$/m.test(output) && !/^error:/m.test(output);
};

export const bunAdapter: Adapter = {
  name: "bun",
  toolchain: (env) =>
    Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(["bun", "--revision"], { stdout: "pipe", stderr: "ignore", env: env as Record<string, string> });
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        if (code !== 0) throw new Error(`exit ${code}`);
        return `bun ${out.trim()} ${process.platform}-${process.arch}`;
      },
      catch: (error) => new SpawnFailed({ message: `bun --revision: ${error instanceof Error ? error.message : String(error)}` }),
    }),
  batch: (suite, repo, files, scratch) => {
    const report = `${scratch}/bun-${process.pid}-${++batchCount}.xml`;
    return {
      argv: [...suite.run, "--reporter=junit", `--reporter-outfile=${report}`, ...files.map((f) => (f.startsWith(".") ? f : `./${f}`))],
      cwd: posix.join(repo, suite.dir),
      results: (exit) =>
        Effect.gen(function* () {
          const file = Bun.file(report);
          const xml = yield* Effect.tryPromise({
            try: async () => ((await file.exists()) ? await file.text() : ""),
            catch: () => new FileFailed({ message: `${report}: unreadable` }),
          });
          const parsed = parseJunit(xml);
          const out = new Map<string, UnitResult>();
          // A batch whose files all define no test (generated from files absent here, as
          // opencode's test262 runner without its vendored files): bun writes no report at all,
          // only its summary. Run beside other files, as the repository's own CI runs it, it
          // passes; alone it must too.
          if (xml === "" && noTests(exit.output, files.length)) return new Map(files.map((f) => [f, { passed: true, durationMs: 0, tests: 0 }]));
          for (const f of files) {
            const r = parsed.get(f) ?? parsed.get(`./${f}`);
            if (r) out.set(f, { passed: r.failures === 0, durationMs: r.durationMs, tests: r.tests });
            // bun leaves out of its report a file that defines no test (all generated from files
            // absent here); the process exited 0 after writing it, so that file finished and passed.
            else if (exit.code === 0 && xml !== "") out.set(f, { passed: true, durationMs: 0, tests: 0 });
          }
          // The process failed while every file it reported passed (an error outside any test, a
          // crash after the report): which file caused it is unknown, so none passes here.
          if (exit.code !== 0 && [...out.values()].every((r) => r.passed)) return new Map<string, UnitResult>();
          return out;
        }),
    };
  },
};
