// The fleet's cache tiers as a job sees them (outrun's Mac runners): `$OUTRUN_CACHE`, the job's own
// folder (read-write, a copy of its tier, promoted into the tier after the job), then
// `$OUTRUN_CACHE_PROTECTED`, the trusted tier (read-only). An entry is one file. Restoring reads the
// job's own folder first, then the protected tier, and marks a protected entry used
// (`$OUTRUN_CACHE/.outrun-used/<entry>`, kept from pruning); saving writes the job's folder through a
// temporary name starting with `.`, renamed into place, so nothing is promoted half-written. A runner
// with no tier (a Linux runner, GitHub's) restores nothing and saves nothing: slower, never wrong.
// The e2e workflow's app, build cache and XCTest runner all go through here (README.md "End-to-end tests").
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { FileFailed, UsageInvalid } from "./errors.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Pure: an entry's name is one file name, never a path. */
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

const checked = (entry: string) =>
  ENTRY.test(entry) ? Effect.succeed(entry) : Effect.fail(new UsageInvalid({ message: `"${entry}" is no cache entry name (letters, digits, . _ -)` }));

const io = <A>(what: string, f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new FileFailed({ message: `${what}: ${String(e)}` }) });

/** Copies `entry` from the job's tiers to `file`: the tier it came from, or undefined when none holds it. */
export const restoreEntry = (env: Env, entry: string, file: string) =>
  Effect.gen(function* () {
    yield* checked(entry);
    const own = env.OUTRUN_CACHE || undefined;
    const protectedTier = env.OUTRUN_CACHE_PROTECTED || undefined;
    for (const tier of [own, protectedTier]) {
      if (!tier || !existsSync(`${tier}/${entry}`)) continue;
      yield* io(`${tier}/${entry}`, () => copyFile(`${tier}/${entry}`, file));
      if (tier === protectedTier && own) {
        // A mark that cannot be written only lets the entry be pruned sooner.
        yield* io("the used mark", async () => {
          await mkdir(`${own}/.outrun-used`, { recursive: true });
          await writeFile(`${own}/.outrun-used/${entry}`, "");
        }).pipe(Effect.catchTag("FileFailed", () => Effect.void));
      }
      return tier === own ? ("own" as const) : ("protected" as const);
    }
    return undefined;
  });

/** Saves `file` as `entry` into the job's own tier folder; false when the runner has none. */
export const saveEntry = (env: Env, file: string, entry: string) =>
  Effect.gen(function* () {
    yield* checked(entry);
    const own = env.OUTRUN_CACHE || undefined;
    if (!own) return false;
    const tmp = `${own}/.${entry}.${process.pid}.tmp`;
    yield* io(`${own}/${entry}`, async () => {
      await copyFile(file, tmp);
      await rename(tmp, `${own}/${entry}`);
    });
    return true;
  });
