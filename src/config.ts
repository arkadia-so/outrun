// The repository's outrun.json: which test files are units, how a batch of them runs, and what
// besides their own content their verdict depends on.
//
//   {
//     "inputs": ["bun.lock", "package.json"],         every unit's key: these files (globs, from the root)
//     "env": ["MY_FLAG"],                             and these variables' values (besides machine.ts's KEYED_ENV)
//     "system": ["sqlite3"],                          system binaries a test needs: whether each exists joins the toolchain
//     "trustedRef": "refs/heads/main",                the ref whose CI runs write the `trusted` tier
//     "suites": [{
//       "name": "core", "adapter": "bun", "dir": "packages/core",
//       "tests": ["test/**/*.test.ts"],               the units, relative to dir
//       "run": ["bun", "run", "script/test.ts"],      a batch: this command, then the adapter's reporter flags and the files
//       "roots": ["test/preload.ts"],                 files every unit loads (preloads): their imports join every key
//       "inputs": ["test/fixture/**"],                files every unit may read (declared), relative to dir
//       "sources": ["imports", "declared"]
//     }],
//     "commands": [{                                  a whole step (a build, a browser suite) as one unit
//       "name": "build", "run": "bun run build",      run is only part of the key: the CI job runs it
//       "inputs": ["packages/cli/**"],                globs from the root (`!glob` excludes)
//       "roots": ["packages/cli/**/*.ts"],            and these files' import closures (globs)
//       "quarantined": true                           optional: never gates, recorded even red
//     }]
//   }
import { Effect, Schema } from "effect";
import { ConfigInvalid } from "./errors.ts";

const KeySource = Schema.Literals(["imports", "declared", "suite"]);
export type KeySource = typeof KeySource.Type;

const Suite = Schema.Struct({
  name: Schema.String,
  adapter: Schema.Literals(["bun", "vitest", "pytest", "xcode", "catch2"]),
  /** The suite's folder, relative to the repository's root; the batch runs there. */
  dir: Schema.String,
  /** Globs of the test files, relative to dir. */
  tests: Schema.Array(Schema.String),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /** The command of a batch, before the adapter's own arguments. */
  run: Schema.Array(Schema.String),
  roots: Schema.optional(Schema.Array(Schema.String)),
  inputs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(Schema.String)),
  /**
   * What a unit's strong keys hold besides the global inputs: `imports` (its import closure),
   * `declared` (the suite's inputs), or `suite` (every file of the suite's folder: the safe default
   * where imports do not tell what a test reads). What a traced run read is a key of its own
   * (keys.ts), whatever the sources.
   */
  sources: Schema.optional(Schema.Array(KeySource)),
  /**
   * How a traced read only stat'ed is keyed: `presence` (default: whether it exists, and as what) or
   * `content`, for a runner that decides on a file's date and reads it only when it changed.
   */
  statOnly: Schema.optional(Schema.Literals(["presence", "content"])),
  /** A batch's expected peak memory, for admission (MB). */
  memoryMb: Schema.optional(Schema.Number),
  /** A batch is killed after this long without finishing (ms), whatever its files' history. */
  timeoutMs: Schema.optional(Schema.Number),
  /** A batch is killed when its output has not grown for this long (ms; default 300 s). */
  idleMs: Schema.optional(Schema.Number),
  /** The duration assumed for a file never timed yet (ms). */
  defaultMs: Schema.optional(Schema.Number),
  /** xcode: the scheme, the destination and the test plan or bundle (adapters/xcode.ts). */
  xcode: Schema.optional(
    Schema.Struct({
      workspace: Schema.optional(Schema.String),
      project: Schema.optional(Schema.String),
      scheme: Schema.String,
      destination: Schema.String,
      testPlan: Schema.optional(Schema.String),
      /** The test target each unit belongs to: `-only-testing:<target>/<class>`. */
      target: Schema.String,
    }),
  ),
});
export type Suite = typeof Suite.Type;

/**
 * A command unit: a step whose pass is cached as a whole (`outrun plan` says whether it must run,
 * `outrun record` writes its pass). Its key holds the machine, its keyed variables, its command and
 * the content of its inputs and of its roots' import closures.
 */
const CommandUnit = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  inputs: Schema.Array(Schema.String),
  roots: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(Schema.String)),
  /**
   * A step that never gates (a test known to fail, kept to report): its run is recorded red or
   * green (`outrun record --failed`), and replayed until its inputs change, so a known failure
   * costs nothing.
   */
  quarantined: Schema.optional(Schema.Boolean),
});
export type CommandUnit = typeof CommandUnit.Type;

const Config = Schema.Struct({
  commands: Schema.optional(Schema.Array(CommandUnit)),
  inputs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(Schema.String)),
  suites: Schema.Array(Suite),
  system: Schema.optional(Schema.Array(Schema.String)),
  trustedRef: Schema.optional(Schema.String),
});
export type Config = typeof Config.Type;

export const DEFAULT_SOURCES: readonly KeySource[] = ["imports", "declared"];

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Config));

export const loadConfig = (path: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(path).text(),
      catch: () => new ConfigInvalid({ message: `${path}: not readable (outrun reads its configuration from outrun.json at the repository's root)` }),
    });
    return yield* decode(text).pipe(Effect.mapError((error) => new ConfigInvalid({ message: `${path}: ${error.message}` })));
  });
