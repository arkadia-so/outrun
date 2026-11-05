// `outrun xcode-reads`: the tracer's per-target read sets of a traced xcodebuild run turned into one
// observation per test file of each xcode suite (sources/xcode-targets.ts), written as the tracer's
// JSON lines, the format `outrun test --trace` reads.
import { realpathSync } from "node:fs";
import { Console, Effect } from "effect";
import { loadConfig } from "./config.ts";
import { FileFailed } from "./errors.ts";
import * as Git from "./git.ts";
import { matching } from "./keys.ts";
import { observationLine, parseRecords, targetObservation, withinRepo } from "./sources/xcode-targets.ts";

export interface XcodeReadsOptions {
  readonly cwd: string;
  readonly config?: string | undefined;
  /** The tracer's output folder: reads.jsonl and targets.jsonl. */
  readonly traceDir: string;
  /** The tracer unit that built for testing. */
  readonly build: string;
  /** The tracer units that ran the tests (test-without-building), whole in every file's set. */
  readonly runs: readonly string[];
  readonly out: string;
}

const readText = (path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: () => new FileFailed({ message: `${path}: unreadable` }),
  });

export const xcodeReads = (options: XcodeReadsOptions) =>
  Effect.gen(function* () {
    const repo = yield* Git.root(options.cwd);
    const [config, blobs] = yield* Effect.all([loadConfig(options.config ?? `${repo}/outrun.json`), Git.blobs(repo)], { concurrency: 2 });
    // The tracer records real paths (/private/tmp/… for /tmp/…). Paths outside the checkout are
    // dropped at once (the engine keys none; a build reads hundreds of thousands), except the
    // modules a target read, which give the targets' imports.
    const roots = [repo, realpathSync(repo)];
    const records = parseRecords(yield* readText(`${options.traceDir}/reads.jsonl`)).map((r) => withinRepo(r, roots));
    const targets = parseRecords(yield* readText(`${options.traceDir}/targets.jsonl`)).map((r) => withinRepo(r, roots, (p) => p.includes(".swiftmodule")));
    const build = records.find((r) => r.unit === options.build);
    if (!build) return yield* new FileFailed({ message: `${options.traceDir}/reads.jsonl: no unit ${options.build}` });
    const runs = records.filter((r) => options.runs.includes(r.unit));
    // Every file of a suite shares its target's set: written line by line, never as one string.
    const groups: { files: string[]; seen: ReturnType<typeof targetObservation> }[] = [];
    for (const suite of config.suites) {
      if (suite.adapter !== "xcode" || !suite.xcode) continue;
      const seen = targetObservation(build, targets, runs, suite.xcode.target);
      if (!seen) {
        yield* Console.error(`outrun: the trace holds no target ${suite.xcode.target} (suite ${suite.name}): its files get no read set`);
        continue;
      }
      const files = matching(blobs, suite.dir, suite.tests, suite.exclude);
      groups.push({ files, seen });
      yield* Console.error(
        `outrun: suite ${suite.name}: ${files.length} files, ${seen.reads.length} reads each (target ${suite.xcode.target} and what it imports)`,
      );
    }
    yield* Effect.tryPromise({
      try: async () => {
        const writer = Bun.file(options.out).writer();
        for (const { files, seen } of groups) for (const id of files) if (seen) writer.write(`${observationLine(id, seen)}\n`);
        await writer.end();
      },
      catch: (e) => new FileFailed({ message: `${options.out}: not writable (${String(e)})` }),
    });
  });
