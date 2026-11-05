#!/usr/bin/env bun
// The outrun command.
//
//   outrun plan --out plan.json [--max-runners n] [--target s] [--start s] [--slots n]
//                                the lookups, once: how many runners the misses need (none when all
//                                hit) and which runs what; in GitHub Actions, outputs runners/matrix/misses
//   outrun test [--plan plan.json] [--shard i/n] [--slots n] [--dry-run] [--local] [--no-write]
//               [--audit fraction] [--trace file] [--only path]... [--summary file]
//   outrun lookup <command>   (GitHub outputs run, key)
//   outrun record <command> [--key k] [--since epoch-seconds] [--no-write] [--failed]
//                                the command unit's step passed: write its pass
//   outrun units [--json]        every unit, its key and how many files its key holds
//   outrun xcode-reads --trace-dir d --build unit [--run unit]... --out file
//                                a traced xcodebuild's per-target read sets as each xcode test file's
//                                observation, for `outrun test --trace`
//   outrun nx-cache [--port n]   Nx's self-hosted remote cache API on 127.0.0.1, stored in outrun's cache
//   outrun bazel-cache [--port n] Bazel's HTTP remote cache on 127.0.0.1, stored in outrun's cache
//
// The remote verdict cache: OUTRUN_CACHE_URL (a Turborepo remote cache, v8), OUTRUN_CACHE_TEAM
// (its namespace, "outrun" by default), and either OUTRUN_CACHE_TOKEN or, in a GitHub Actions job
// with `id-token: write`, the job's OIDC token (audience OUTRUN_CACHE_AUDIENCE, by default the
// URL). Without a URL, only this machine's cache.
import { BunServices } from "@effect/platform-bun";
import { runMain } from "@effect/platform-bun/BunRuntime";
import { Console, Effect, Exit, Option, Runtime } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import pkg from "../package.json" with { type: "json" };
import { BAZEL, buildCacheApp, NX } from "./build-cache.ts";
import { githubOidc } from "./cache.ts";
import { blocking, keyUnits, lookupCommand, plan, recordCommand, test } from "./engine.ts";
import { CacheUnavailable, TestsFailed, UsageInvalid } from "./errors.ts";
import type { Remote } from "./upstream.ts";
import { xcodeReads } from "./xcode-reads.ts";

const env = process.env as Readonly<Record<string, string | undefined>>;

const remoteOf = (local: boolean) =>
  Effect.gen(function* () {
    const url = env.OUTRUN_CACHE_URL?.replace(/\/$/, "");
    if (local || !url) return undefined;
    const team = env.OUTRUN_CACHE_TEAM ?? "outrun";
    const token =
      env.OUTRUN_CACHE_TOKEN ??
      // Without an OIDC token, the run keeps to this machine's cache.
      (yield* githubOidc(env.OUTRUN_CACHE_AUDIENCE ?? url, env).pipe(
        Effect.catchTag("CacheUnavailable", (e) => Console.error(`outrun: ${e.message}; using this machine's cache only`).pipe(Effect.as(undefined))),
      ));
    return token ? ({ url, team, token } satisfies Remote) : undefined;
  });

const parseShard = (text: string) => {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  return match
    ? Effect.succeed({ index: Number(match[1]), count: Number(match[2]) })
    : Effect.fail(new UsageInvalid({ message: `--shard ${text}: write it i/n (1/4)` }));
};

const runIdOf = () => env.OUTRUN_RUN_ID ?? (env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}` : `local-${crypto.randomUUID()}`);

const audit = Flag.Finite("audit").pipe(Flag.withDescription("the share of hits re-executed to check the cache, on idle capacity"), Flag.withDefault(0.01));
const local = Flag.Boolean("local").pipe(Flag.withDescription("ignore the remote cache"), Flag.withDefault(false));
const slots = Flag.Int("slots").pipe(Flag.withDescription("batches a runner runs at once (default: its CPUs)"), Flag.optional);
const only = Flag.String("only").pipe(Flag.withDescription("only the units under this path (repeatable)"), Flag.atLeast(0));

const config = Flag.String("config").pipe(Flag.withDescription("the configuration (default: outrun.json at the repository's root)"), Flag.optional);

const testCommand = Command.make(
  "test",
  {
    config,
    shard: Flag.String("shard").pipe(Flag.withDescription("this runner's share, i/n (1-based; with --plan, i/any)"), Flag.withDefault("1/1")),
    plan: Flag.String("plan").pipe(Flag.withDescription("run what this plan (outrun plan) assigns to this shard's index"), Flag.optional),
    slots,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("plan and print, run nothing"), Flag.withDefault(false)),
    local,
    noWrite: Flag.Boolean("no-write").pipe(Flag.withDescription("never write the remote cache"), Flag.withDefault(false)),
    audit,
    trace: Flag.String("trace").pipe(Flag.withDescription("the tracer's JSON lines for this run: read sets to record"), Flag.optional),
    summary: Flag.String("summary").pipe(Flag.withDescription("write the run's summary (JSON) there"), Flag.optional),
    only,
  },
  (flags) =>
    Effect.gen(function* () {
      const remote = yield* remoteOf(flags.local);
      const summary = yield* test({
        cwd: process.cwd(),
        config: Option.getOrUndefined(flags.config),
        shard: yield* parseShard(flags.shard),
        plan: Option.getOrUndefined(flags.plan),
        slots: Option.getOrUndefined(flags.slots),
        dryRun: flags.dryRun,
        remote,
        write: !flags.noWrite,
        audit: flags.audit,
        trace: Option.getOrUndefined(flags.trace),
        runId: runIdOf(),
        summary: Option.getOrUndefined(flags.summary),
        env,
        only: flags.only.length > 0 ? flags.only : undefined,
      });
      const count = blocking(summary);
      if (count > 0) return yield* new TestsFailed({ count });
    }),
).pipe(Command.withDescription("Replay every passing verdict whose key is cached, run this runner's share of the rest in batches, record what it learned"));

const planCommand = Command.make(
  "plan",
  {
    config,
    out: Flag.String("out").pipe(Flag.withDescription("where the plan is written")),
    maxRunners: Flag.Int("max-runners").pipe(Flag.withDescription("the most runners to start"), Flag.withDefault(8)),
    target: Flag.Finite("target").pipe(Flag.withDescription("the wall time to aim for, in seconds"), Flag.withDefault(120)),
    start: Flag.Finite("start").pipe(Flag.withDescription("what starting a runner costs before its first test, in seconds"), Flag.withDefault(30)),
    slots: Flag.Int("slots").pipe(Flag.withDescription("batches each runner runs at once"), Flag.withDefault(4)),
    local,
    audit,
    only,
  },
  (flags) =>
    Effect.gen(function* () {
      yield* plan({
        cwd: process.cwd(),
        config: Option.getOrUndefined(flags.config),
        remote: yield* remoteOf(flags.local),
        runId: runIdOf(),
        env,
        audit: flags.audit,
        only: flags.only.length > 0 ? flags.only : undefined,
        out: flags.out,
        runners: { max: flags.maxRunners, targetMs: flags.target * 1000, startMs: flags.start * 1000, slots: flags.slots },
      });
    }),
).pipe(Command.withDescription("Look every unit up once, before any test job: how many runners the misses need, and which runs what"));

const recordCommandCommand = Command.make(
  "record",
  {
    config,
    name: Argument.String("command").pipe(Argument.withDescription("the command unit (outrun.json commands[].name)")),
    key: Flag.String("key").pipe(Flag.withDescription("the key `outrun plan` gave it (its `keys` output), when the step changed the checkout"), Flag.optional),
    since: Flag.Int("since").pipe(Flag.withDescription("when the step started (Unix seconds): its duration"), Flag.optional),
    noWrite: Flag.Boolean("no-write").pipe(Flag.withDescription("never write the remote cache"), Flag.withDefault(false)),
    failed: Flag.Boolean("failed").pipe(Flag.withDescription("the step failed (a quarantined command only)"), Flag.withDefault(false)),
    local,
  },
  (flags) =>
    Effect.gen(function* () {
      const since = Option.getOrUndefined(flags.since);
      yield* recordCommand({
        cwd: process.cwd(),
        config: Option.getOrUndefined(flags.config),
        remote: yield* remoteOf(flags.local),
        env,
        name: flags.name,
        key: Option.getOrUndefined(flags.key),
        runId: runIdOf(),
        write: !flags.noWrite,
        durationMs: since === undefined ? 0 : Date.now() - since * 1000,
        failed: flags.failed,
      });
    }),
).pipe(Command.withDescription("Write the pass of a command unit whose step just succeeded (or, quarantined, its failure)"));

const lookupCommandCommand = Command.make(
  "lookup",
  { config, name: Argument.String("command").pipe(Argument.withDescription("the command unit (outrun.json commands[].name)")), local },
  (flags) =>
    Effect.gen(function* () {
      yield* lookupCommand({
        cwd: process.cwd(),
        config: Option.getOrUndefined(flags.config),
        remote: yield* remoteOf(flags.local),
        env,
        name: flags.name,
        runId: runIdOf(),
      });
    }),
).pipe(Command.withDescription("Whether a command unit's pass is cached (GitHub outputs run and key), without the plan"));

const unitsCommand = Command.make(
  "units",
  { config, json: Flag.Boolean("json").pipe(Flag.withDefault(false)), file: Argument.String("file").pipe(Argument.variadic()) },
  (flags) =>
    Effect.gen(function* () {
      const keyed = yield* keyUnits({ cwd: process.cwd(), config: Option.getOrUndefined(flags.config), env, remote: yield* remoteOf(false) });
      const units = flags.file.length > 0 ? keyed.units.filter((u) => flags.file.some((f) => u.id.endsWith(f))) : keyed.units;
      for (const u of units)
        yield* Console.log(
          flags.json
            ? JSON.stringify({
                id: u.id,
                suite: u.suite.name,
                key: u.key,
                weak: u.weak,
                candidates: u.candidates.length,
                inputs: u.inputs,
                cacheable: u.cacheable,
              })
            : `${u.key.slice(0, 16)} ${String(u.inputs.length).padStart(5)} ${u.id}`,
        );
      yield* Console.error(
        `outrun: ${keyed.units.length} units (${Object.entries(keyed.phases)
          .map(([k, v]) => `${k} ${Math.round(v)} ms`)
          .join(", ")})`,
      );
    }),
).pipe(Command.withDescription("Every unit with its key and how many files the key holds"));

/** A build tool's remote cache protocol on 127.0.0.1, stored in outrun's cache (build-cache.ts). */
const buildCacheCommand = (protocol: typeof NX, port: number, description: string) =>
  Command.make(protocol.name, { port: Flag.Int("port").pipe(Flag.withDescription("the port on 127.0.0.1"), Flag.withDefault(port)) }, (flags) =>
    Effect.gen(function* () {
      const url = env.OUTRUN_CACHE_URL?.replace(/\/$/, "");
      if (!url) return yield* new UsageInvalid({ message: `${protocol.name} needs OUTRUN_CACHE_URL` });
      const fixed = env.OUTRUN_CACHE_TOKEN;
      const token = fixed
        ? Effect.succeed(fixed)
        : githubOidc(env.OUTRUN_CACHE_AUDIENCE ?? url, env).pipe(
            Effect.flatMap((t) => (t ? Effect.succeed(t) : Effect.fail(new CacheUnavailable({ message: "no OIDC token (id-token: write?)" })))),
          );
      const app = buildCacheApp(protocol, { url, team: env.OUTRUN_CACHE_TEAM ?? "outrun", token });
      // Bun closes a connection idle for 10 s by default, before a slow cache answers: Nx then fails
      // the run ("Failed to send request", TanStack/query, ARK-81). 255 s is Bun's maximum, above
      // the cache client's own timeout.
      const server = Bun.serve({ hostname: "127.0.0.1", port: flags.port, fetch: app.fetch, maxRequestBodySize: 2 ** 31, idleTimeout: 255 });
      yield* Console.error(`outrun ${protocol.name}: listening on http://127.0.0.1:${server.port} (team ${env.OUTRUN_CACHE_TEAM ?? "outrun"})`);
      return yield* Effect.never;
    }),
  ).pipe(Command.withDescription(description));

const nxCacheCommand = buildCacheCommand(NX, 7070, "Serve Nx's self-hosted remote cache API from outrun's cache");
const bazelCacheCommand = buildCacheCommand(BAZEL, 7071, "Serve Bazel's HTTP remote cache from outrun's cache");

const xcodeReadsCommand = Command.make(
  "xcode-reads",
  {
    config,
    traceDir: Flag.String("trace-dir").pipe(Flag.withDescription("the tracer's output folder (reads.jsonl, and targets.jsonl from OUTRUN_TRACE_MODULES=1)")),
    build: Flag.String("build").pipe(Flag.withDescription("the tracer unit that built for testing")),
    run: Flag.String("run").pipe(Flag.withDescription("a tracer unit that ran the tests (repeatable)"), Flag.atLeast(0)),
    out: Flag.String("out").pipe(Flag.withDescription("where the observations are written (JSON lines)")),
  },
  (flags) =>
    xcodeReads({
      cwd: process.cwd(),
      config: Option.getOrUndefined(flags.config),
      traceDir: flags.traceDir,
      build: flags.build,
      runs: flags.run,
      out: flags.out,
    }),
).pipe(Command.withDescription("Each xcode test file's observation from a traced build's per-target read sets"));

const outrun = Command.make("outrun").pipe(
  Command.withDescription("outrun's CI engine: test files as units, keyed by content, verdicts cached, misses batched and balanced across runners"),
  Command.withSubcommands([
    planCommand,
    testCommand,
    lookupCommandCommand,
    recordCommandCommand,
    unitsCommand,
    xcodeReadsCommand,
    nxCacheCommand,
    bazelCacheCommand,
  ]),
);

// The CLI boundary: failing tests exit 1; a refusal is one line on stderr and exit 2 (as a usage
// error printed by Effect CLI); a defect is left to runMain, which prints the Cause.
const main = Command.run(outrun, { version: pkg.version }).pipe(
  Effect.as(0),
  Effect.catchTags({
    TestsFailed: (e) => Console.error(`outrun: ${e.count} failed`).pipe(Effect.as(1)),
    ConfigInvalid: (e) => Console.error(`outrun: ${e.message}`).pipe(Effect.as(2)),
    GitFailed: (e) => Console.error(`outrun: ${e.message}`).pipe(Effect.as(2)),
    SpawnFailed: (e) => Console.error(`outrun: ${e.message}`).pipe(Effect.as(2)),
    FileFailed: (e) => Console.error(`outrun: ${e.message}`).pipe(Effect.as(2)),
    UsageInvalid: (e) => Console.error(`outrun: ${e.message}`).pipe(Effect.as(2)),
  }),
  Effect.catchIf(CliError.isCliError, () => Effect.succeed(2)),
  Effect.provide(BunServices.layer),
);

// effect-lint-allow no-run-outside-boundary: the CLI's entry point.
runMain(main, {
  teardown: (exit, onExit) => (Exit.isSuccess(exit) && typeof exit.value === "number" ? onExit(exit.value) : Runtime.defaultTeardown(exit, onExit)),
});
