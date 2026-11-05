// Catch2: a batch is one run of the test binary given its test names, which are the unit files'
// paths (a runner whose tests are named after the files they come from, such as a SQL logic test
// binary registering each script under its path), reporting through Catch2's JUnit reporter, each
// test case named after its file. A binary built from the repository is not a toolchain: the suite
// declares the sources it is built from as inputs (`sources: ["declared"]`).
import { posix } from "node:path";
import { Effect } from "effect";
import { FileFailed } from "../errors.ts";
import { parseJunitCases } from "../junit.ts";
import type { Adapter, UnitResult } from "./adapter.ts";

let batchCount = 0;

/**
 * Pure: one Catch2 test spec naming exactly these tests. Separate arguments would all have to
 * match (Catch2 joins them with spaces, which means "and"); commas mean "or". Catch2's special
 * characters in a name are escaped.
 */
export const testSpec = (names: readonly string[]) => names.map((n) => n.replace(/[\\,[\]*"~^]/g, (c) => `\\${c}`)).join(",");

export const catch2Adapter: Adapter = {
  name: "catch2",
  toolchain: () => Effect.succeed(`catch2 ${process.platform}-${process.arch}`),
  batch: (suite, repo, files, scratch) => {
    const report = `${scratch}/catch2-${process.pid}-${++batchCount}.xml`;
    return {
      argv: [...suite.run, "--reporter", "junit", "--out", report, testSpec(files)],
      cwd: posix.join(repo, suite.dir),
      results: () =>
        Effect.gen(function* () {
          const xml = yield* Effect.tryPromise({
            try: async () => ((await Bun.file(report).exists()) ? await Bun.file(report).text() : ""),
            catch: () => new FileFailed({ message: `${report}: unreadable` }),
          });
          // A crash leaves no report (Catch2 writes it at the end): no unit of the batch finished.
          if (xml === "") return new Map<string, UnitResult>();
          const parsed = parseJunitCases(xml, "name");
          const out = new Map<string, UnitResult>();
          for (const f of files) {
            const r = parsed.get(f);
            // In a finished run, a file the binary did not register as a test is no test, as a
            // whole-binary run would have it.
            out.set(f, r ? { passed: r.failures === 0, durationMs: r.durationMs, tests: r.tests } : { passed: true, durationMs: 0, tests: 0 });
          }
          return out;
        }),
    };
  },
};
