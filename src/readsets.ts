// The traced read sets (keys.ts), kept on this machine and in the remote cache, one record per
// suite and toolchain: weak key → its last read sets, newest first. A lost update (two runs
// merging at once) only costs a later run the narrower key: it still has the closure's.
import { mkdir, rename } from "node:fs/promises";
import { Console, Effect } from "effect";
import { get, put, readSetsKey } from "./cache.ts";
import { FileFailed } from "./errors.ts";
import type { ReadSet } from "./keys.ts";
import type { Remote } from "./upstream.ts";

/** How many read sets a weak key keeps. */
const KEEP = 3;

type Record_ = Record<string, ReadSet[]>;

const parse = (text: string | undefined): Record_ => {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};
  } catch {
    return {};
  }
};

/** Pure: `added` merged into `base`: the new set first, the same set never twice, at most KEEP. */
export const mergeReadSets = (base: Record_, added: ReadonlyMap<string, ReadSet>): Record_ => {
  const out: Record_ = { ...base };
  for (const [weak, set] of added) {
    const same = (s: ReadSet) => s.net === set.net && JSON.stringify([s.reads, s.present ?? []]) === JSON.stringify([set.reads, set.present ?? []]);
    out[weak] = [set, ...(out[weak] ?? []).filter((s) => !same(s))].slice(0, KEEP);
  }
  return out;
};

const localPath = (state: string, suiteKey: string) => `${state}/readsets/${suiteKey}.json`;

const readLocal = (state: string, suiteKey: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(localPath(state, suiteKey));
      return (await file.exists()) ? await file.text() : undefined;
    },
    catch: () => new FileFailed({ message: `${localPath(state, suiteKey)}: unreadable` }),
  }).pipe(Effect.map(parse));

/** Every read set known for these suites (suite → toolchain), local first, the remote's merged in. */
export const loadReadSets = (state: string, suites: ReadonlyMap<string, string>, remote: Remote | undefined) =>
  Effect.forEach(
    [...suites],
    ([suite, toolchain]) =>
      Effect.gen(function* () {
        const hash = readSetsKey(suite, toolchain);
        const local = yield* readLocal(state, hash).pipe(Effect.catchTag("FileFailed", () => Effect.succeed({} as Record_)));
        // The remote's sets are what other machines traced; unreachable, this machine's are enough.
        // A few seconds at most: a run once waited 20 s on one of these, and read sets only narrow keys.
        const shared = remote ? parse(yield* get(remote, hash, 5_000).pipe(Effect.catchTag("CacheUnavailable", () => Effect.succeed(undefined)))) : {};
        const merged: Record_ = { ...shared };
        for (const [weak, sets] of Object.entries(local)) merged[weak] = [...sets, ...(merged[weak] ?? [])].slice(0, KEEP);
        return merged;
      }),
    { concurrency: 64 },
  ).pipe(Effect.map((records) => new Map(records.flatMap((r) => Object.entries(r)))));

/** Records what a run traced, per suite, here and (when it may write) in the remote cache. */
export const saveReadSets = (state: string, bySuite: ReadonlyMap<string, { toolchain: string; sets: Map<string, ReadSet> }>, remote: Remote | undefined) =>
  Effect.forEach(
    [...bySuite],
    ([suite, { toolchain, sets }]) =>
      Effect.gen(function* () {
        const hash = readSetsKey(suite, toolchain);
        const local = mergeReadSets(yield* readLocal(state, hash), sets);
        const path = localPath(state, hash);
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(`${state}/readsets`, { recursive: true });
            await Bun.write(`${path}.tmp`, JSON.stringify(local));
            await rename(`${path}.tmp`, path);
          },
          catch: () => new FileFailed({ message: `${path}: not writable` }),
        });
        if (!remote) return;
        const shared = mergeReadSets(parse(yield* get(remote, hash)), sets);
        const body = JSON.stringify(shared);
        const refused = yield* put(remote, [{ hash, body, durationMs: 0, tag: "" }]);
        if (refused.count > 0) yield* Console.error(`outrun: the remote cache refused the read sets of ${suite} (${refused.statuses})`);
      }).pipe(
        // Read sets only narrow keys: failing to keep them costs a later run a wider key, nothing more.
        Effect.catchTags({
          FileFailed: (e) => Console.error(`outrun: ${e.message}`),
          CacheUnavailable: (e) => Console.error(`outrun: the read sets of ${suite}: ${e.message}`),
        }),
      ),
    { concurrency: 8, discard: true },
  );
