// Pure planning: which runner runs which missed unit, and how a runner groups its units into
// batches (one process each). Both from the durations recorded by earlier runs, so every runner
// of a run computes the same plan from the same inputs, without talking to the others.

export interface Timed {
  readonly id: string;
  /** The suite the unit belongs to: a batch never mixes suites (one command each). */
  readonly suite: string;
  readonly durationMs: number;
}

/** A unit to time: its id, its suite, and the guesses for it when it was never measured. */
export interface ToTime {
  readonly id: string;
  readonly suite: string;
  /** The unit's own guess (a plan's `ms`), before any measured duration of its suite. */
  readonly guessMs?: number;
  /** Its suite's default, when no unit of the suite was measured either. */
  readonly defaultMs?: number;
}

/** What a unit counts for when nothing at all is known of it or its suite. */
export const UNKNOWN_MS = 1000;

const median = (values: readonly number[]) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Each unit's expected duration, from the durations earlier runs measured (`measured`, by id): its
 * own when it was timed; else its own guess; else the median of its suite's timed units; else its
 * suite's default; else UNKNOWN_MS. The one estimator of outrun's split (the engine's runners and
 * batches, `outrun check`'s workers): a guess stands only for a unit never measured.
 */
export const expectedDurations = (units: readonly ToTime[], measured: ReadonlyMap<string, number | undefined>): Map<string, number> => {
  const known = new Map<string, number[]>();
  for (const u of units) {
    const ms = measured.get(u.id);
    if (ms !== undefined) known.set(u.suite, [...(known.get(u.suite) ?? []), ms]);
  }
  const medians = new Map([...known].map(([suite, values]) => [suite, median(values)]));
  return new Map(units.map((u) => [u.id, measured.get(u.id) ?? u.guessMs ?? medians.get(u.suite) ?? u.defaultMs ?? UNKNOWN_MS]));
};

/** Longest first, then by id: a total order, so the plan is the same on every runner. */
const byDuration = <T extends Timed>(a: T, b: T) => b.durationMs - a.durationMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Longest processing time first: each unit, longest first, goes to the least loaded of `n`
 * runners (ties to the lowest index). Within 4/3 of the optimum, and deterministic.
 */
export const shard = <T extends Timed>(units: readonly T[], n: number): T[][] => {
  const shards = Array.from({ length: n }, () => ({ load: 0, units: [] as T[] }));
  for (const unit of [...units].sort(byDuration)) {
    let best = shards[0] as (typeof shards)[number];
    for (const s of shards) if (s.load < best.load) best = s;
    best.units.push(unit);
    best.load += unit.durationMs;
  }
  return shards.map((s) => s.units);
};

export interface BatchOptions {
  /** How many batches run at once on this runner. */
  readonly slots: number;
  /** What starting one batch costs (its process, its preloads), in ms. */
  readonly startupMs: number;
  /** No batch is planned shorter than this, unless its suite has less work (ms). */
  readonly minBatchMs: number;
}

export interface Batch<T extends Timed> {
  readonly suite: string;
  readonly units: T[];
  readonly expectedMs: number;
}

/**
 * A runner's units in batches: each suite's work split into about as many batches as there are
 * slots in proportion to its share of the work, but no batch so short that its startup dominates;
 * then longest batches first, so the last to start are the shortest.
 */
export const batches = <T extends Timed>(units: readonly T[], options: BatchOptions): Batch<T>[] => {
  const bySuite = new Map<string, T[]>();
  for (const u of units) bySuite.set(u.suite, [...(bySuite.get(u.suite) ?? []), u]);
  const total = units.reduce((a, u) => a + u.durationMs, 0);
  // The ideal batch length: the whole work over the slots, a few batches per slot so the end balances.
  const target = Math.max(options.minBatchMs, total / (options.slots * 2));
  const out: Batch<T>[] = [];
  for (const [suite, members] of [...bySuite].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const work = members.reduce((a, u) => a + u.durationMs, 0);
    const count = Math.max(1, Math.min(members.length, Math.round(work / target)));
    for (const units of shard(members, count))
      if (units.length > 0) out.push({ suite, units, expectedMs: options.startupMs + units.reduce((a, u) => a + u.durationMs, 0) });
  }
  return out.sort((a, b) => b.expectedMs - a.expectedMs);
};

export interface RunnerOptions {
  /** The most runners a run may start. */
  readonly max: number;
  /** The wall time a run aims for (ms). */
  readonly targetMs: number;
  /** What a started runner costs before its first test (queue, setup), in ms. */
  readonly startMs: number;
  /** Batches each runner runs at once. */
  readonly slots: number;
}

/**
 * How many runners the misses need: the fewest whose expected wall time, the longest unit or the
 * work spread over every runner's slots, plus a runner's start, meets the target; at most `max`.
 * No miss, no runner: a run whose units all hit starts no job.
 */
export const runnersFor = (units: readonly Timed[], options: RunnerOptions): number => {
  if (units.length === 0) return 0;
  const total = units.reduce((a, u) => a + u.durationMs, 0);
  const longest = Math.max(...units.map((u) => u.durationMs));
  const finish = (n: number) => Math.max(longest, total / (n * options.slots)) + options.startMs;
  // When even the most runners miss the target, the fewest reaching the best finish (a runner
  // that cannot make the run shorter is not started).
  const goal = Math.max(options.targetMs, finish(Math.max(1, options.max)));
  for (let n = 1; n < options.max; n++) if (finish(n) <= goal) return n;
  return Math.max(1, options.max);
};

/**
 * Extra work (audits) on idle capacity: each, longest first, goes to the least loaded share only
 * if that share stays within the busiest one's load (or `floorMs`, what a started runner may spend
 * anyway), so it never lengthens the run.
 */
export const fillIdle = <T extends Timed>(shares: readonly T[][], extra: readonly T[], floorMs = 0): { shares: T[][]; placed: T[] } => {
  const out = shares.map((s) => ({ load: s.reduce((a, u) => a + u.durationMs, 0), units: [...s] }));
  const ceiling = Math.max(floorMs, ...out.map((s) => s.load));
  const placed: T[] = [];
  for (const unit of [...extra].sort(byDuration)) {
    let best = out[0];
    for (const s of out) if (best === undefined || s.load < best.load) best = s;
    if (!best || best.load + unit.durationMs > ceiling) continue;
    best.units.push(unit);
    best.load += unit.durationMs;
    placed.push(unit);
  }
  return { shares: out.map((s) => s.units), placed };
};
