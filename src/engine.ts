// `outrun plan` and `outrun test`: every unit keyed, its verdict looked up, the misses (and a few
// audited hits) shared across runners by duration, a runner's share run in batches, red units
// rerun alone, and what the run learned written back.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, freemem, hostname, tmpdir, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Console, Effect, Semaphore } from "effect";
import type { Adapter, UnitResult } from "./adapters/adapter.ts";
import { bunAdapter } from "./adapters/bun.ts";
import { catch2Adapter } from "./adapters/catch2.ts";
import { pytestAdapter } from "./adapters/pytest.ts";
import { vitestAdapter } from "./adapters/vitest.ts";
import { xcodeAdapter } from "./adapters/xcode.ts";
import { batches, fillIdle, runnersFor, shard } from "./balance.ts";
import { type CacheEntry, divergenceKey, LocalCache, type Put, put, quarantineKey, query, timingKey } from "./cache.ts";
import { type Config, loadConfig, type Suite } from "./config.ts";
import { FileFailed, UsageInvalid } from "./errors.ts";
import { exec } from "./exec.ts";
import * as Git from "./git.ts";
import { computeCommands, computeUnits, type KeyedCommand, type ReadSet, tracedKey, type Unit } from "./keys.ts";
import { keyedEnv, machineFingerprint, unitEnv } from "./machine.ts";
import { loadReadSets, saveReadSets } from "./readsets.ts";
import { ImportGraph, scanSource } from "./sources/imports.ts";
import { parseObserved, readSetOf } from "./sources/observed.ts";
import { loadScans, saveScans, stateDir } from "./state.ts";
import type { Remote } from "./upstream.ts";
import { formatTag, parseTag, type Tier, tierOf, usable, type Verdict } from "./verdict.ts";

const ADAPTERS: Record<Suite["adapter"], Adapter> = {
  bun: bunAdapter,
  vitest: vitestAdapter,
  pytest: pytestAdapter,
  xcode: xcodeAdapter,
  catch2: catch2Adapter,
};

/** At most this many red units are rerun alone (a broken commit failing hundreds would double its run). */
const MAX_RETRIES = 20;
const DEFAULT_IDLE_MS = 300_000;
// The deadline of a batch holding a file never timed: its expected time is a guess (the suite's
// median or default), so a deadline derived from it would kill a slow file before it ends. The idle
// watchdog still stops a process that hangs silent.
const UNMEASURED_DEADLINE_MS = 15 * 60_000;

/** Pure: a batch's deadline. Derived from durations only when every file was timed; a retry alone gets more than what its batch had. */
export const deadlineMs = (
  batch: { readonly expectedMs: number; readonly measured: boolean; readonly floorMs?: number | undefined },
  suiteTimeoutMs?: number,
) => Math.max(suiteTimeoutMs ?? 0, batch.measured ? 3 * batch.expectedMs + 60_000 : UNMEASURED_DEADLINE_MS, batch.floorMs ?? 0);

type Env = Readonly<Record<string, string | undefined>>;

export interface KeyOptions {
  readonly cwd: string;
  readonly config?: string | undefined;
  readonly env: Env;
  /** The remote cache, if any; without it, only this machine's cache. */
  readonly remote?: Remote | undefined;
  /** Key the command units only (no test file, no read set): `outrun lookup` and `outrun record`. */
  readonly commandsOnly?: boolean | undefined;
  /**
   * outrun's own files of this call (the plan, the summary, the trace), never keyed: a shard that
   * downloaded its plan into the checkout keys the tree its plan keyed, not the tree plus plan.json.
   */
  readonly own?: readonly (string | undefined)[] | undefined;
}

export interface PlanOptions extends KeyOptions {
  /** Identifies this run: its shards ignore what it wrote itself. */
  readonly runId: string;
  readonly only?: readonly string[] | undefined;
  /** The share of hits re-executed to check the cache (on idle capacity only). */
  readonly audit: number;
  /** Batches a runner runs at once (default: its CPUs). */
  readonly slots?: number | undefined;
}

export interface TestOptions extends PlanOptions {
  /** This runner's share: index (1-based) of count; with a plan, count is the plan's. */
  readonly shard: { readonly index: number; readonly count: number };
  /** A plan written by `outrun plan`: this runner runs what it assigns to `shard.index`. */
  readonly plan?: string | undefined;
  readonly dryRun: boolean;
  /** Whether this run may write the remote cache (the server decides where). */
  readonly write: boolean;
  readonly summary?: string | undefined;
  /** The tracer's JSON lines for this run (sources/observed.ts), read once the batches ended. */
  readonly trace?: string | undefined;
}

const now = () => performance.now();
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** Memory available to new processes, in MB (Linux: MemAvailable; elsewhere what the OS says is free). */
const availableMb = () => {
  try {
    const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return Number(match[1]) / 1024;
  } catch {
    // Not Linux: below.
  }
  // macOS counts its file cache as used; half the total is what a test run can count on.
  return Math.max(freemem(), totalmem() / 2) / 1024 / 1024;
};

/** The checkout's files without outrun's own (paths relative to `cwd`, or absolute; real paths compared, `/tmp` is `/private/tmp` on macOS). */
const withoutOwn = (blobs: Git.Blobs, repo: string, cwd: string, own: readonly (string | undefined)[]): Git.Blobs => {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      // A file not written yet (the plan's --out): its folder's real path.
      return join(realpathSync(dirname(path)), basename(path));
    }
  };
  const paths = own.flatMap((p) => {
    if (p === undefined) return [];
    try {
      const rel = relative(realpathSync(repo), real(resolve(cwd, p)));
      return rel.startsWith("..") || isAbsolute(rel) ? [] : [rel.split(sep).join("/")];
    } catch {
      // Its folder does not exist: it is not in the checkout either.
      return [];
    }
  });
  if (!paths.some((p) => blobs.has(p))) return blobs;
  const kept = new Map(blobs);
  for (const p of paths) kept.delete(p);
  return kept;
};

export const keyUnits = (options: KeyOptions) =>
  Effect.gen(function* () {
    const t0 = now();
    const repo = yield* Git.root(options.cwd);
    const [config, blobs] = yield* Effect.all([loadConfig(options.config ?? `${repo}/outrun.json`), Git.blobs(repo)], { concurrency: 2 }).pipe(
      Effect.map(([config, all]) => [config, withoutOwn(all, repo, options.cwd, options.own ?? [])] as const),
    );
    const tIndex = now();
    const state = stateDir(options.env);
    // An unreadable scan cache is rebuilt: it only saves reading files again.
    const scans = yield* loadScans(state).pipe(Effect.catchTag("FileFailed", () => Effect.succeed(new Map<string, readonly string[] | null>())));
    const before = scans.size;
    const read = (path: string) => {
      try {
        return readFileSync(`${repo}/${path}`, "utf8");
      } catch {
        return undefined;
      }
    };
    const graph = new ImportGraph(
      blobs,
      (path, blob) => {
        const cached = scans.get(blob);
        if (cached !== undefined) return cached ?? undefined;
        const text = read(path);
        if (text === undefined) return undefined;
        const specs = scanSource(text, path);
        scans.set(blob, specs ?? null);
        return specs;
      },
      read,
    );
    const machine = machineFingerprint(options.env, config.system ?? []);
    const adapters = [...new Set(config.suites.map((s) => s.adapter))];
    const toolchains: Record<string, string> = Object.fromEntries(
      yield* Effect.forEach(adapters, (a) => ADAPTERS[a].toolchain(options.env).pipe(Effect.map((t) => [a, `${t} ${machine}`] as const)), {
        concurrency: "unbounded",
      }),
    );
    const tTool = now();
    const readSets = options.commandsOnly
      ? new Map()
      : yield* loadReadSets(state, new Map(config.suites.map((s) => [s.name, toolchains[s.adapter] ?? ""])), options.remote);
    const tSets = now();
    const units = options.commandsOnly ? [] : computeUnits({ config, blobs, graph, readSets, toolchain: toolchains, env: options.env });
    const commands = computeCommands({ config, blobs, graph, env: options.env }, machine);
    const tKeys = now();
    if (scans.size !== before)
      // A scan cache that cannot be saved costs the next run its scans, nothing more.
      yield* saveScans(state, scans).pipe(Effect.catchTag("FileFailed", (e) => Console.error(`outrun: ${e.message}`)));
    return {
      repo,
      config,
      blobs,
      units,
      commands,
      toolchains,
      state,
      phases: { index: tIndex - t0, toolchain: tTool - tIndex, readsets: tSets - tTool, keys: tKeys - tSets },
    };
  });

interface Looked {
  /** Unit id → the candidate key whose verdict hit. */
  readonly hits: Map<string, string>;
  readonly durations: Map<string, number>;
  readonly previous: Map<string, number | undefined>;
  readonly timing: Map<string, string>;
  readonly quarantined: Set<string>;
  readonly diverged: Set<string>;
  /** The command units' keys whose pass is cached. */
  readonly commandHits: Set<string>;
}

const median = (values: readonly number[]) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const lookup = (
  units: readonly Unit[],
  commands: readonly KeyedCommand[],
  toolchains: Record<string, string>,
  local: LocalCache,
  remote: Remote | undefined,
  runId: string,
  tier: Tier,
) =>
  Effect.gen(function* () {
    const toolchainOf = (u: Unit) => toolchains[u.runner] ?? "";
    const timing = new Map(units.map((u) => [u.id, timingKey(u.id, toolchainOf(u))]));
    const quarantine = new Map(units.map((u) => [u.id, quarantineKey(u.id, toolchainOf(u))]));
    const suites = new Map(units.map((u) => [u.suite.name, divergenceKey(u.suite.name, toolchainOf(u))]));
    const hashes = [
      ...new Set([...units.flatMap((u) => u.candidates), ...timing.values(), ...quarantine.values(), ...suites.values(), ...commands.map((c) => c.key)]),
    ];
    const localEntries = yield* local.get(hashes).pipe(Effect.catchTag("FileFailed", () => Effect.succeed(new Map<string, CacheEntry>())));
    let remoteEntries = new Map<string, CacheEntry>();
    if (remote)
      // A remote cache that does not answer leaves this run with its local cache: slower, never wrong.
      remoteEntries = yield* query(remote, hashes).pipe(
        Effect.catchTag("CacheUnavailable", (e) =>
          Console.error(`outrun: the remote cache: ${e.message}; using this machine's only`).pipe(Effect.as(new Map<string, CacheEntry>())),
        ),
      );
    const at = Date.now();
    // An artifact this run may trust: fresh, of a tier it reads, not written by this run itself.
    const valid = (hash: string) =>
      [remoteEntries.get(hash), localEntries.get(hash)].some((e) => {
        if (!e) return false;
        const tag = parseTag(e.tag);
        return usable(tag, tier, at) && tag.run !== runId;
      });
    const diverged = new Set([...suites].filter(([, hash]) => valid(hash)).map(([suite]) => suite));
    const quarantined = new Set(units.filter((u) => valid(quarantine.get(u.id) as string)).map((u) => u.id));
    const hits = new Map<string, string>();
    const previous = new Map<string, number | undefined>();
    for (const u of units) {
      if (u.cacheable && !quarantined.has(u.id) && !diverged.has(u.suite.name)) {
        const hit = u.candidates.find(valid);
        if (hit) hits.set(u.id, hit);
      }
      const t = remoteEntries.get(timing.get(u.id) as string) ?? localEntries.get(timing.get(u.id) as string);
      let ms: number | undefined;
      if (t) {
        const tag = parseTag(t.tag);
        ms = tag.run === runId ? tag.prev : t.durationMs;
      }
      previous.set(u.id, ms);
    }
    // A file never timed counts as its suite's median (the suite's default without any).
    const known = new Map<string, number[]>();
    for (const u of units) {
      const ms = previous.get(u.id);
      if (ms !== undefined) known.set(u.suite.name, [...(known.get(u.suite.name) ?? []), ms]);
    }
    const medians = new Map([...known].map(([s, v]) => [s, median(v)]));
    const durations = new Map(units.map((u) => [u.id, previous.get(u.id) ?? medians.get(u.suite.name) ?? u.suite.defaultMs ?? 1000]));
    // Remember what the remote knew, so the next run here needs no network.
    if (remoteEntries.size > 0) yield* local.set(remoteEntries).pipe(Effect.catchTag("FileFailed", () => Effect.void));
    const commandHits = new Set(commands.map((c) => c.key).filter(valid));
    return { hits, durations, previous, timing, quarantined, diverged, commandHits } satisfies Looked;
  });

/** `measured`: `durationMs` was recorded for this file, not guessed from its suite. */
type TimedUnit = Unit & { readonly durationMs: number; readonly measured: boolean; readonly audit: boolean };

/** Pure: whether this hit is one of the run's audits (about `fraction` of hits, the same on every runner). */
const audited = (key: string, runId: string, fraction: number) =>
  fraction > 0 && Number.parseInt(sha256(`${runId}\n${key}`).slice(0, 8), 16) / 2 ** 32 < fraction;

const filterOnly = (units: readonly Unit[], only: readonly string[] | undefined) =>
  only ? units.filter((u) => only.some((o) => u.id === o || u.id.startsWith(`${o.replace(/\/$/, "")}/`))) : units;

/** Keys, lookups, and what is left to run: the misses, and the audits picked among the hits. */
const prepare = (options: PlanOptions) =>
  Effect.gen(function* () {
    const keyed = yield* keyUnits(options);
    const tier = tierOf(options.env, keyed.config.trustedRef ?? "refs/heads/main", hostname());
    const units = filterOnly(keyed.units, options.only);
    const local = new LocalCache(`${keyed.state}/verdicts`);
    const t0 = now();
    const looked = yield* lookup(units, keyed.commands, keyed.toolchains, local, options.remote, options.runId, tier);
    const timed = (u: Unit, audit: boolean): TimedUnit => ({
      ...u,
      durationMs: looked.durations.get(u.id) ?? 1000,
      measured: looked.previous.get(u.id) !== undefined,
      audit,
    });
    const misses = units.filter((u) => !looked.hits.has(u.id)).map((u) => timed(u, false));
    const audits = units.filter((u) => audited(looked.hits.get(u.id) ?? "", options.runId, options.audit) && looked.hits.has(u.id)).map((u) => timed(u, true));
    return { keyed, tier, units, local, looked, misses, audits, phases: { ...keyed.phases, lookup: now() - t0 } };
  });

const toTimed = (u: TimedUnit) => ({ ...u, suite: u.suite.name, unit: u });

/** What a started runner may spend on audits even with no miss to run (ms of work). */
const AUDIT_FLOOR_MS = 10_000;

/** Pure: the shares of `count` started runners: the misses by LPT, then the audits on idle capacity. */
const share = (misses: readonly TimedUnit[], audits: readonly TimedUnit[], count: number) => {
  const shares = shard(misses.map(toTimed), count);
  return fillIdle(shares, audits.map(toTimed), AUDIT_FLOOR_MS).shares.map((s) => s.map((x) => x.unit));
};

interface PlanFile {
  readonly v: 1;
  readonly runId: string;
  readonly runners: number;
  readonly units: readonly { readonly id: string; readonly key: string; readonly runner: number; readonly audit: boolean }[];
  /** Each command unit: whether it must run. */
  readonly commands: Readonly<Record<string, "run" | "hit">>;
  /** Each command unit's key, for `outrun record --key` after a step that changed the checkout. */
  readonly commandKeys: Readonly<Record<string, string>>;
  /** What every key holds beside the files: when a shard's keys differ from the plan's, it says why. */
  readonly context: PlanContext;
}

interface PlanContext {
  readonly toolchains: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

const planContext = (config: Config, toolchains: Record<string, string>, env: Readonly<Record<string, string | undefined>>): PlanContext => {
  const names = [...(config.env ?? []), ...config.suites.flatMap((s) => s.env ?? []), ...(config.commands ?? []).flatMap((c) => c.env ?? [])];
  return { toolchains, env: Object.fromEntries(keyedEnv(env, names)) };
};

/** Pure: the names (never the values: a keyed variable may be private) of what differs between two contexts. */
export const contextDiff = (plan: PlanContext | undefined, here: PlanContext): string[] => {
  if (!plan) return ["the plan has no context (an older outrun)"];
  const out: string[] = [];
  for (const name of new Set([...Object.keys(plan.toolchains), ...Object.keys(here.toolchains)]))
    if (plan.toolchains[name] !== here.toolchains[name]) out.push(`the ${name} toolchain or machine`);
  for (const name of new Set([...Object.keys(plan.env), ...Object.keys(here.env)])) if (plan.env[name] !== here.env[name]) out.push(`$${name}`);
  return out;
};

export interface PlanRunners {
  readonly max: number;
  readonly targetMs: number;
  readonly startMs: number;
  /** Batches each runner runs at once. */
  readonly slots: number;
}

/**
 * `outrun plan`: the lookups, done once before any test job: how many runners the misses need
 * (none when every unit hits, so no job starts), and which runner runs which unit.
 */
export const plan = (options: PlanOptions & { readonly runners: PlanRunners; readonly out: string }) =>
  Effect.gen(function* () {
    const prepared = yield* prepare({ ...options, own: [options.out] });
    const runners = runnersFor(prepared.misses.map(toTimed), options.runners);
    const shares = runners === 0 ? [] : share(prepared.misses, prepared.audits, runners);
    const file: PlanFile = {
      v: 1,
      runId: options.runId,
      runners,
      units: shares.flatMap((s, i) => s.map((u) => ({ id: u.id, key: u.key, runner: i + 1, audit: u.audit }))),
      commands: Object.fromEntries(prepared.keyed.commands.map((c) => [c.name, prepared.looked.commandHits.has(c.key) ? "hit" : "run"])),
      commandKeys: Object.fromEntries(prepared.keyed.commands.map((c) => [c.name, c.key])),
      context: planContext(prepared.keyed.config, prepared.keyed.toolchains, options.env),
    };
    yield* Effect.tryPromise({
      try: () => Bun.write(options.out, `${JSON.stringify(file)}\n`),
      catch: () => new FileFailed({ message: `${options.out}: not writable` }),
    });
    const loads = shares.map((s) => s.reduce((a, u) => a + u.durationMs, 0) / options.runners.slots);
    yield* Console.error(
      `outrun: ${prepared.units.length} units, ${prepared.looked.hits.size} hit, ${prepared.misses.length} to run on ${runners} runner(s)${loads.length ? ` (~${seconds(Math.max(...loads))} each at most)` : ""}, ${file.units.filter((u) => u.audit).length} audits${
        Object.keys(file.commands).length
          ? `; commands: ${Object.entries(file.commands)
              .map(([n, v]) => `${n} ${v}`)
              .join(", ")}`
          : ""
      } (${Object.entries(prepared.phases)
        .map(([k, v]) => `${k} ${Math.round(v)} ms`)
        .join(", ")})`,
    );
    const output = options.env.GITHUB_OUTPUT;
    if (output)
      yield* Effect.tryPromise({
        try: () =>
          appendFile(
            output,
            `runners=${runners}\nmatrix=${JSON.stringify(Array.from({ length: runners }, (_, i) => i + 1))}\nmisses=${prepared.misses.length}\n${commandOutputs(file.commands)}keys=${JSON.stringify(file.commandKeys)}\n`,
          ),
        catch: () => new FileFailed({ message: `${output}: not writable` }),
      });
    return file;
  });

/**
 * Pure: the GitHub outputs of the command units: `run-<name>` (true or false) each, and for the
 * names written `group:id`, `group-<group>`: the ids of that group to run (a job's matrix).
 */
const commandOutputs = (commands: PlanFile["commands"]) => {
  const safe = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "-");
  const groups = new Map<string, string[]>();
  const lines = Object.entries(commands).map(([name, v]) => {
    const colon = name.indexOf(":");
    if (colon > 0) {
      const group = name.slice(0, colon);
      const ids = groups.get(group) ?? [];
      if (v === "run") ids.push(name.slice(colon + 1));
      groups.set(group, ids);
    }
    return `run-${safe(name)}=${v === "run"}\n`;
  });
  return [...lines, ...[...groups].map(([g, ids]) => `group-${safe(g)}=${JSON.stringify(ids)}\n`)].join("");
};

const readPlan = (path: string) =>
  Effect.tryPromise({
    try: async () => (await Bun.file(path).json()) as PlanFile,
    catch: () => new UsageInvalid({ message: `--plan ${path}: not a plan written by outrun plan` }),
  });

type Status = "passed" | "failed" | "flaky" | "unfinished";

interface Outcome {
  readonly unit: TimedUnit;
  readonly status: Status;
  readonly result: UnitResult | undefined;
  readonly output?: string | undefined;
}

interface Summary {
  readonly units: number;
  readonly replayed: number;
  readonly misses: number;
  readonly mine: number;
  readonly ran: number;
  readonly failed: readonly string[];
  /** Red, then green alone: quarantined, not blocking. */
  readonly flaky: readonly string[];
  /** Quarantined units that failed: reported, not blocking. */
  readonly quarantinedFailed: readonly string[];
  readonly audits: number;
  /** Audited hits that failed: the cache replayed a pass that does not hold. */
  readonly diverged: readonly string[];
  /** Files the run wrote into the working tree (it then writes no verdict). */
  readonly wroteTree: readonly string[];
  readonly shard: string;
  readonly tier: Tier;
  readonly phasesMs: Record<string, number>;
  readonly batches: number;
  readonly expectedMs: number;
  readonly cache: "remote" | "local";
}

/** Pure: whether a summary fails the run. */
export const blocking = (s: Pick<Summary, "failed" | "diverged" | "wroteTree">) => s.failed.length + s.diverged.length + s.wroteTree.length;

interface Batch {
  readonly suite: string;
  readonly units: readonly TimedUnit[];
  readonly expectedMs: number;
  /** Every file was timed before (else the deadline is not derived from `expectedMs`). */
  readonly measured: boolean;
  /** A lower bound for the deadline (a retry alone: more than its batch had). */
  readonly floorMs?: number;
}

const runBatch = (
  context: { repo: string; scratch: string; tmpRoot: string; env: Env; config: Config },
  batch: Batch,
  memory: Semaphore.Semaphore,
  budget: number,
) =>
  Effect.gen(function* () {
    const suite = (batch.units[0] as Unit).suite;
    const adapter = ADAPTERS[suite.adapter];
    const prepared = adapter.batch(
      suite,
      context.repo,
      batch.units.map((u) => u.file),
      context.scratch,
    );
    // Each process its own temporary folder, so nothing leaks from one batch to the next.
    const tmp = yield* Effect.tryPromise({
      try: () => mkdtemp(`${context.tmpRoot}/outrun-tmp-`),
      catch: () => new FileFailed({ message: "no temporary folder" }),
    });
    const timeoutMs = deadlineMs(batch, suite.timeoutMs);
    const env = { ...unitEnv(context.env, [...(context.config.env ?? []), ...(suite.env ?? [])], tmp), ...prepared.env };
    // Admission by memory: a batch takes its suite's share of the budget at once, never part of it.
    const exited = yield* Semaphore.withPermits(
      memory,
      Math.min(budget, suite.memoryMb ?? 1024),
    )(exec({ argv: prepared.argv, cwd: prepared.cwd, env, timeoutMs, idleMs: suite.idleMs ?? DEFAULT_IDLE_MS }));
    const results = yield* prepared.results(exited);
    yield* Effect.tryPromise({ try: () => rm(tmp, { recursive: true, force: true }), catch: () => new FileFailed({ message: `${tmp}: not removable` }) }).pipe(
      Effect.catchTag("FileFailed", () => Effect.void),
    );
    return { batch, exited, results };
  });

export const test = (options: TestOptions) =>
  Effect.gen(function* () {
    const { index } = options.shard;
    let count = options.shard.count;
    if (!(count >= 1 && index >= 1 && index <= count))
      return yield* new UsageInvalid({ message: `--shard ${index}/${count}: the index is between 1 and the count` });
    const prepared = yield* prepare({ ...options, own: [options.plan, options.summary, options.trace] });
    const { keyed, looked, tier } = prepared;
    const { repo, config } = keyed;
    let mine: TimedUnit[];
    if (options.plan) {
      const file = yield* readPlan(options.plan);
      count = file.runners;
      const byId = new Map(prepared.units.map((u) => [u.id, u]));
      mine = [];
      const differ: string[] = [];
      for (const p of file.units.filter((p) => p.runner === index)) {
        const u = byId.get(p.id);
        if (!u) {
          yield* Console.error(`outrun: the plan's ${p.id} is not a unit here; skipped`);
          continue;
        }
        if (u.key !== p.key) differ.push(u.id);
        mine.push({ ...u, durationMs: looked.durations.get(u.id) ?? 1000, measured: looked.previous.get(u.id) !== undefined, audit: p.audit });
      }
      if (differ.length > 0) {
        const why = contextDiff(file.context, planContext(config, keyed.toolchains, options.env));
        yield* Console.error(
          `outrun: ${differ.length} of this shard's keys differ from the plan's (${why.length ? `different here: ${why.join(", ")}` : "the checkout changed?"}): ${differ.slice(0, 5).join(", ")}${differ.length > 5 ? ", ..." : ""}; they run with this job's keys`,
        );
      }
    } else mine = share(prepared.misses, prepared.audits, count)[index - 1] ?? [];
    const slots = options.slots ?? Math.max(1, availableParallelism());
    const plan = batches(mine.map(toTimed), { slots, startupMs: 500, minBatchMs: 4000 }).map((b): Batch => ({
      suite: b.suite,
      expectedMs: b.expectedMs,
      units: b.units.map((x) => x.unit),
      measured: b.units.every((x) => x.unit.measured),
    }));
    const expectedMs = plan.reduce((a, b) => a + b.expectedMs, 0) / slots;
    const shardLabel = `${index}/${count}`;
    const audits = mine.filter((u) => u.audit).length;
    yield* Console.error(
      `outrun: ${prepared.units.length} units, ${looked.hits.size} replayed, ${prepared.misses.length} to run (tier ${tier}); this runner (${shardLabel}): ${mine.length - audits} misses and ${audits} audits in ${plan.length} batches on ${slots} slots, ~${seconds(expectedMs)}`,
    );
    const phases: Record<string, number> = { ...prepared.phases };
    const outcomes: Outcome[] = [];
    let wroteTree: string[] = [];
    if (!options.dryRun && plan.length > 0) {
      const scratch = yield* Effect.tryPromise({ try: () => mkdtemp(`${tmpdir()}/outrun-`), catch: () => new FileFailed({ message: "no temporary folder" }) });
      // A memory-backed TMPDIR where there is one.
      const tmpRoot = existsSync("/dev/shm") ? "/dev/shm" : scratch;
      const context = { repo, scratch, tmpRoot, env: options.env, config };
      for (const suite of new Map(mine.map((m) => [m.suite.name, m.suite])).values()) {
        const prep = ADAPTERS[suite.adapter].prepare;
        if (prep) yield* prep(suite, repo, scratch);
      }
      const treeBefore = yield* Git.status(repo);
      const budget = Math.max(1024, Math.floor(availableMb() - 1024));
      const memory = yield* Semaphore.make(budget);
      const tRun = now();
      const ran = yield* Effect.forEach(
        plan,
        (batch) =>
          runBatch(context, batch, memory, budget).pipe(
            Effect.tap(({ exited, results }) => {
              const failed = batch.units.filter((u) => results.get(u.file)?.passed === false).length;
              const missing = batch.units.filter((u) => !results.has(u.file)).length;
              return Console.error(
                `  ${failed + missing === 0 ? "ok  " : "FAIL"} ${batch.suite}: ${batch.units.length} files in ${seconds(exited.durationMs)} (expected ${seconds(batch.expectedMs)})${failed ? `, ${failed} failed` : ""}${missing ? `, ${missing} unfinished${exited.killed ? ` (killed: ${exited.killed})` : ""}` : ""}`,
              );
            }),
          ),
        { concurrency: slots },
      );
      // A unit that did not pass runs once more alone, in a fresh process, before it is reported:
      // a unit its batch did not finish (a crash, a watchdog) to know which it was, a red one to
      // tell a failure from a flaky test.
      const first = new Map<string, Outcome>();
      const given = new Map<string, number>();
      for (const { batch, exited, results } of ran)
        for (const u of batch.units) {
          given.set(u.id, exited.durationMs);
          const r = results.get(u.file);
          first.set(u.id, { unit: u, status: r ? (r.passed ? "passed" : "failed") : "unfinished", result: r, output: r?.passed ? undefined : exited.output });
        }
      const red = [...first.values()].filter((o) => o.status !== "passed");
      const retried = [...red.filter((o) => o.status === "unfinished"), ...red.filter((o) => o.status === "failed").slice(0, MAX_RETRIES)];
      if (retried.length > 0) {
        yield* Console.error(`outrun: ${retried.length} red or unfinished units run again alone`);
        const alone = yield* Effect.forEach(
          retried,
          (o) =>
            runBatch(
              context,
              {
                suite: o.unit.suite.name,
                units: [o.unit],
                expectedMs: o.unit.durationMs + 500,
                measured: o.unit.measured,
                // A file its batch did not finish gets twice the time that batch ran, so a slow file is not killed twice at the same point.
                floorMs: o.status === "unfinished" ? 2 * (given.get(o.unit.id) ?? 0) + 60_000 : undefined,
              },
              memory,
              budget,
            ),
          { concurrency: slots },
        );
        for (const { batch, exited, results } of alone) {
          const u = batch.units[0] as TimedUnit;
          const before = first.get(u.id) as Outcome;
          const r = results.get(u.file);
          const status: Status = r?.passed ? (before.status === "failed" ? "flaky" : "passed") : r ? "failed" : "unfinished";
          first.set(u.id, { unit: u, status, result: r ?? before.result, output: r?.passed ? before.output : exited.output });
        }
      }
      outcomes.push(...first.values());
      phases.run = now() - tRun;
      // Write isolation: a run that changed the working tree (beyond ignored files) leaves no
      // verdict, since what it changed may be what made another unit pass.
      const treeAfter = yield* Git.status(repo);
      wroteTree = [...treeAfter].filter((line) => !treeBefore.has(line)).map((line) => line.slice(3));
      if (wroteTree.length > 0)
        yield* Console.error(`outrun: the tests wrote into the working tree (${wroteTree.slice(0, 10).join(", ")}); no verdict is written`);
      const tWrite = now();
      if (wroteTree.length === 0)
        yield* record(options, { keyed, looked, tier, outcomes, local: prepared.local }).pipe(
          Effect.catchTag("GitFailed", (e) => Console.error(`outrun: ${e.message}; nothing recorded`)),
        );
      phases.write = now() - tWrite;
      yield* Effect.tryPromise({
        try: () => rm(scratch, { recursive: true, force: true }),
        catch: () => new FileFailed({ message: `${scratch}: not removable` }),
      }).pipe(Effect.catchTag("FileFailed", () => Effect.void));
    }
    const isQuarantined = (o: Outcome) => looked.quarantined.has(o.unit.id);
    const red = outcomes.filter((o) => o.status === "failed" || o.status === "unfinished");
    const failed = red.filter((o) => !o.unit.audit && !isQuarantined(o));
    const diverged = red.filter((o) => o.unit.audit && !isQuarantined(o));
    const quarantinedFailed = red.filter(isQuarantined);
    const flaky = outcomes.filter((o) => o.status === "flaky");
    for (const f of [...failed, ...diverged]) {
      yield* Console.error(`\n--- ${f.unit.audit ? "AUDIT DIVERGED" : "FAIL"} ${f.unit.id}${f.result ? "" : " (did not finish)"} ---`);
      if (f.output) yield* Console.error(f.output.slice(-8000));
    }
    for (const f of flaky) yield* Console.error(`outrun: FLAKY ${f.unit.id}: red in its batch, green alone; quarantined, not blocking`);
    for (const f of quarantinedFailed) yield* Console.error(`outrun: QUARANTINED ${f.unit.id} failed; not blocking`);
    const summary: Summary = {
      units: prepared.units.length,
      replayed: looked.hits.size,
      misses: prepared.misses.length,
      mine: mine.length,
      ran: outcomes.length,
      failed: failed.map((f) => f.unit.id),
      flaky: flaky.map((f) => f.unit.id),
      quarantinedFailed: quarantinedFailed.map((f) => f.unit.id),
      audits,
      diverged: diverged.map((f) => f.unit.id),
      wroteTree,
      shard: shardLabel,
      tier,
      phasesMs: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, Math.round(v)])),
      batches: plan.length,
      expectedMs: Math.round(expectedMs),
      cache: options.remote ? "remote" : "local",
    };
    yield* Console.error(
      `outrun: ${summary.replayed} replayed, ${summary.ran} ran, ${summary.failed.length} failed${flaky.length ? `, ${flaky.length} flaky` : ""}${diverged.length ? `, ${diverged.length} audits diverged` : ""} (${Object.entries(
        summary.phasesMs,
      )
        .map(([k, v]) => `${k} ${v} ms`)
        .join(", ")})`,
    );
    if (options.summary)
      yield* Effect.tryPromise({
        try: () => Bun.write(options.summary as string, `${JSON.stringify(summary)}\n`),
        catch: () => new FileFailed({ message: `${options.summary}: not writable` }),
      });
    return summary;
  });

/**
 * What a run learned: each unit's duration; a verdict for each pass that may be cached (under the
 * closure's key, and the traced set's when the run was traced); a quarantine marker for each flaky
 * unit; a divergence marker for each suite whose audit failed; the traced read sets.
 */
const record = (
  options: TestOptions,
  run: {
    keyed: { repo: string; blobs: Git.Blobs; toolchains: Record<string, string>; state: string };
    looked: Looked;
    tier: Tier;
    outcomes: readonly Outcome[];
    local: LocalCache;
  },
) =>
  Effect.gen(function* () {
    const { keyed, looked, tier, outcomes } = run;
    const at = Math.floor(Date.now() / 1000);
    const commit = yield* Git.head(keyed.repo);
    const producer = { commit, runner: options.env.RUNNER_NAME ?? hostname(), image: options.env.OUTRUN_IMAGE ?? options.env.ImageOS ?? "" };
    const traced = options.trace
      ? parseObserved(
          yield* Effect.tryPromise({
            try: async () => ((await Bun.file(options.trace as string).exists()) ? await Bun.file(options.trace as string).text() : ""),
            catch: () => new FileFailed({ message: `${options.trace}: unreadable` }),
          }).pipe(Effect.catchTag("FileFailed", (e) => Console.error(`outrun: ${e.message}`).pipe(Effect.as("")))),
          keyed.repo,
        )
      : new Map();
    const entries = new Map<string, CacheEntry>();
    const puts: Put[] = [];
    const add = (hash: string, body: string, durationMs: number, tag: string) => {
      entries.set(hash, { durationMs, tag });
      puts.push({ hash, body, durationMs, tag });
    };
    const readSets = new Map<string, { toolchain: string; sets: Map<string, ReadSet> }>();
    for (const o of outcomes) {
      const u = o.unit;
      const toolchain = keyed.toolchains[u.runner] ?? "";
      const quarantined = looked.quarantined.has(u.id);
      if (o.result) {
        const prev = looked.previous.get(u.id);
        add(
          looked.timing.get(u.id) as string,
          JSON.stringify({ unit: u.id, ms: Math.round(o.result.durationMs) }),
          o.result.durationMs,
          formatTag({ run: options.runId, at, tier, prev }),
        );
      }
      const seen = traced.get(u.id);
      const set: ReadSet | undefined = seen ? readSetOf(seen, u.suite.statOnly ?? "presence") : undefined;
      if (set) {
        const bucket = readSets.get(u.suite.name) ?? { toolchain, sets: new Map<string, ReadSet>() };
        bucket.sets.set(u.weak, set);
        readSets.set(u.suite.name, bucket);
      }
      if (o.status === "passed" && o.result && u.cacheable && !set?.net && !quarantined && !u.audit) {
        const tag = formatTag({ run: options.runId, at, tier });
        for (const key of new Set([u.key, ...(set ? [tracedKey(u, keyed.blobs, set)] : [])])) {
          const verdict: Verdict = {
            v: 1,
            unit: u.id,
            key,
            outcome: "pass",
            durationMs: Math.round(o.result.durationMs),
            producedAt: new Date(at * 1000).toISOString(),
            tier,
            producer,
          };
          add(key, JSON.stringify(verdict), o.result.durationMs, tag);
        }
      }
      if (o.status === "flaky")
        add(quarantineKey(u.id, toolchain), JSON.stringify({ unit: u.id, key: u.key, at }), 0, formatTag({ run: options.runId, at, tier }));
      if (u.audit && !quarantined && (o.status === "failed" || o.status === "unfinished"))
        add(
          divergenceKey(u.suite.name, toolchain),
          JSON.stringify({ suite: u.suite.name, unit: u.id, key: u.key, at }),
          0,
          formatTag({ run: options.runId, at, tier }),
        );
    }
    yield* run.local.set(entries).pipe(Effect.catchTag("FileFailed", (e) => Console.error(`outrun: ${e.message}`)));
    const remote = options.remote && options.write ? options.remote : undefined;
    if (remote) {
      // A write the cache refuses or misses costs a later run a miss, never a wrong verdict.
      const refused = yield* put(remote, puts).pipe(Effect.catchTag("CacheUnavailable", () => Effect.succeed(puts.length)));
      if (refused > 0) yield* Console.error(`outrun: the remote cache refused ${refused} of ${puts.length} writes`);
    }
    if (readSets.size > 0) yield* saveReadSets(keyed.state, readSets, remote);
  });

/**
 * `outrun lookup <command>`: whether one command unit's pass is cached, without the plan (a job
 * that runs it starts with the plan job, not after it). Gives `run` (true or false) and `key` (for
 * `outrun record --key`) as GitHub outputs.
 */
export const lookupCommand = (options: KeyOptions & { readonly name: string; readonly runId: string }) =>
  Effect.gen(function* () {
    const keyed = yield* keyUnits({ ...options, commandsOnly: true });
    const command = keyed.commands.find((c) => c.name === options.name);
    if (!command) return yield* new UsageInvalid({ message: `${options.name}: no such command in outrun.json` });
    const tier = tierOf(options.env, keyed.config.trustedRef ?? "refs/heads/main", hostname());
    const local = new LocalCache(`${keyed.state}/verdicts`);
    const looked = yield* lookup([], [command], keyed.toolchains, local, options.remote, options.runId, tier);
    const run = !looked.commandHits.has(command.key);
    const output = options.env.GITHUB_OUTPUT;
    if (output)
      yield* Effect.tryPromise({
        try: () => appendFile(output, `run=${run}\nkey=${command.key}\n`),
        catch: () => new FileFailed({ message: `${output}: not writable` }),
      });
    yield* Console.error(`outrun: ${command.name} ${run ? "to run" : "hit"} (${command.inputs} inputs, tier ${tier})`);
    return { run, key: command.key };
  });

/**
 * `outrun record <command>`: the step a command unit names passed in this job; its key is computed
 * again here (the checkout is the plan's) and its pass written, with this run's tier.
 */
export const recordCommand = (
  options: KeyOptions & {
    readonly name: string;
    readonly runId: string;
    readonly write: boolean;
    readonly durationMs: number;
    readonly key?: string | undefined;
    /** The step failed: only a quarantined command records it. */
    readonly failed?: boolean;
  },
) =>
  Effect.gen(function* () {
    const keyed = yield* keyUnits({ ...options, commandsOnly: true });
    const found = keyed.commands.find((c) => c.name === options.name);
    if (!found) return yield* new UsageInvalid({ message: `${options.name}: no such command in outrun.json` });
    if (options.key !== undefined && !/^[0-9a-f]{64}$/.test(options.key)) return yield* new UsageInvalid({ message: `--key ${options.key}: not a key` });
    if (options.failed && !found.command.quarantined)
      return yield* new UsageInvalid({ message: `${options.name}: a failure is recorded only for a quarantined command (outrun.json "quarantined": true)` });
    // The plan's key: the step may have changed the checkout (a build writes into it) since.
    const command = options.key === undefined ? found : { ...found, key: options.key };
    const tier = tierOf(options.env, keyed.config.trustedRef ?? "refs/heads/main", hostname());
    const at = Math.floor(Date.now() / 1000);
    const commit = yield* Git.head(keyed.repo);
    const producer = { commit, runner: options.env.RUNNER_NAME ?? hostname(), image: options.env.OUTRUN_IMAGE ?? options.env.ImageOS ?? "" };
    const verdict: Verdict = {
      v: 1,
      unit: `command:${command.name}`,
      key: command.key,
      outcome: options.failed ? "fail" : "pass",
      durationMs: Math.round(options.durationMs),
      producedAt: new Date(at * 1000).toISOString(),
      tier,
      producer,
    };
    const tag = formatTag({ run: options.runId, at, tier });
    const local = new LocalCache(`${keyed.state}/verdicts`);
    yield* local
      .set(new Map([[command.key, { durationMs: options.durationMs, tag }]]))
      .pipe(Effect.catchTag("FileFailed", (e) => Console.error(`outrun: ${e.message}`)));
    if (options.remote && options.write) {
      const refused = yield* put(options.remote, [{ hash: command.key, body: JSON.stringify(verdict), durationMs: options.durationMs, tag }]).pipe(
        Effect.catchTag("CacheUnavailable", () => Effect.succeed(1)),
      );
      if (refused > 0) yield* Console.error(`outrun: the remote cache refused the command's ${verdict.outcome}`);
    }
    yield* Console.error(`outrun: ${command.name} ${options.failed ? "failed (quarantined, recorded)" : "passed"} (${command.inputs} inputs, tier ${tier})`);
  });
