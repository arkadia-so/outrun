// `--e2e`: the configuration outrun builds itself from a repository's TesterArmy e2e configs, with no
// outrun.json (README.md "End-to-end tests"). Every `e2e.config.{ts,mts,js,mjs}` git knows is a suite: its folder is
// the suite's, its tests are the ones TesterArmy's own CLI lists for it (`e2e list --reporter json`,
// so a config's `tests` glob and filters mean what they mean to `e2e run`), and a batch is `e2e run`
// on the nearest installed CLI, under Node (found at the batch: adapters/e2e.ts).
//
// A unit is one test, named `file:line` by the line e2e's listing declares it at, which `e2e run`
// selects as a positional (README.md "End-to-end tests"): a file of long tests spreads over several runners. A
// serial group (`describe(..., { serial: true })`) runs in order on one worker and retries as a whole,
// so it stays one unit, at its first member's line (which selects the whole group). Tests declared on
// one line (a loop) are one unit. OUTRUN_E2E_FILTER holds e2e's own selection flags (`--tag`,
// `--exclude-tag`, `--tag-mode`, `--grep`, `--grep-invert`, `--target`): the listing applies them, so
// a test they leave out is no unit, and they join the listing's key and every unit's command.
//
// What a discovered suite's keys hold: every file of the config's folder (a config in the app's
// package reruns its tests when the app changes), the test files' import closures, the lockfiles, and
// a digest of each variable the folder's sources read by name (`process.env.OUTRUN_E2E_URL`): an end
// to end test reaches a deployed app, which the variables name. Its batches get the job's whole
// environment (the tests' secrets), retry as the config says (no rerun alone), and a pass replays for
// a day only, since the app under test may change without a commit here. The variables that only name
// the run, its job or its machine (RUN_IDENTITY: GITHUB_RUN_ID, RUNNER_NAME...) are never keyed, even
// when a source reads them: a test reads them to make unique names (a fixture's id), and keying them
// made every run's keys, and its listing's, new, so nothing ever replayed (OUT-56, 2026-11-11). OUTRUN_E2E_APP, the key of
// the app the workflow built for a device target (its `build` input), is one of those variables: a
// new build of the app reruns its tests.
//
// A config's listing is kept, keyed by what can change it: the paths of the config's folder (a file
// added or removed), the content of its test files (by name: `*.e2e.*`, `*.test.*`, `*.spec.*` or
// under an `e2e/` or `test(s)/` folder; a file with no test is not listed), the config's import
// closure, the lockfiles (the CLI's version) and the variables the folder reads. A file named like no
// test whose tests go from none to some keeps a stale listing until another input changes: the one
// approximation, taken so an edit of the app keeps the listing (README.md "End-to-end tests"). A plan whose listings are
// all kept needs neither the CLI nor the repository's dependencies (`cachedOnly`), so the plan job
// skips the install (README.md "End-to-end tests").
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { posix } from "node:path";
import { Console, Effect } from "effect";
import { get, put } from "./cache.ts";
import type { Config, Suite } from "./config.ts";
import { ConfigInvalid, FileFailed } from "./errors.ts";
import type { Blobs } from "./git.ts";
import { matching } from "./keys.ts";
import { hashedEnv } from "./machine.ts";
import type { ImportGraph } from "./sources/imports.ts";
import type { Remote } from "./upstream.ts";

type Env = Readonly<Record<string, string | undefined>>;

const CONFIG = /(^|\/)e2e\.config\.(ts|mts|js|mjs)$/;
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
/** The CLI's entry, below a node_modules folder. */
const CLI = "node_modules/e2e/dist/cli/bin.js";
/** Pure: a path named like a test file (the listing's key holds these files' content). */
const TEST_NAME = /(^|\/)(e2e|tests?)\/|\.(e2e|test|spec)\.[^/]*$/;
/** The variable the workflow names its built app's key in (e2e.yml `build`): every discovered suite is keyed on it. */
const APP_ENV = "OUTRUN_E2E_APP";
/** The variable holding e2e's selection flags (e2e.yml `filter`). */
const FILTER_ENV = "OUTRUN_E2E_FILTER";
/**
 * Variables that name the run, its job, its runner or its machine, never what is under test: a source
 * reading one (a unique fixture name from GITHUB_RUN_ID) keys nothing on it, else no run would ever
 * replay another's verdicts.
 */
const RUN_IDENTITY = new Set([
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_NUMBER",
  "GITHUB_JOB",
  "GITHUB_ACTION",
  "GITHUB_ACTION_PATH",
  "GITHUB_WORKSPACE",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_EVENT_PATH",
  "GITHUB_SHA",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "RUNNER_NAME",
  "RUNNER_TEMP",
  "RUNNER_TRACKING_ID",
  "OUTRUN_RUN_ID",
  "HOSTNAME",
]);
/** e2e's selection flags, each followed by its value. */
const FILTER_FLAGS = new Set(["--tag", "--tag-mode", "--exclude-tag", "--grep", "--grep-invert", "--target"]);

/** Pure: shell-like words (single and double quotes group, no expansion). */
const words = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
};

/**
 * Pure: e2e's selection flags from OUTRUN_E2E_FILTER's value, as `--flag value` pairs (`--flag=value`
 * taken too); anything else is refused, since it would change what a test does, not which run.
 */
export const parseFilter = (text: string | undefined): string[] | ConfigInvalid => {
  const given = words(text ?? "");
  const out: string[] = [];
  for (let i = 0; i < given.length; i++) {
    const word = given[i] as string;
    const eq = word.indexOf("=");
    const [flag, value] = eq > 0 ? [word.slice(0, eq), word.slice(eq + 1)] : [word, given[++i]];
    if (!FILTER_FLAGS.has(flag) || value === undefined || value === "")
      return new ConfigInvalid({
        message: `${FILTER_ENV}: "${word}" is not one of e2e's selection flags with its value (${[...FILTER_FLAGS].join(", ")})`,
      });
    out.push(flag, value);
  }
  return out;
};

/** One unit of a listing: a test or a serial group, by the line `e2e run` selects it at (none: the whole file). */
export interface ListedTest {
  readonly file: string;
  readonly line?: number;
  /** Its title path (a serial group's: the group's), stable across edits that move lines: its timing's name. */
  readonly name: string;
}

interface Pair {
  readonly file?: unknown;
  readonly titlePath?: unknown;
  readonly title?: unknown;
  readonly serialId?: unknown;
  readonly source?: { readonly line?: unknown };
}

const titleOf = (p: Pair): string[] =>
  Array.isArray(p.titlePath) && p.titlePath.every((t) => typeof t === "string") ? (p.titlePath as string[]) : typeof p.title === "string" ? [p.title] : [];

/**
 * Pure: the units of `e2e list --reporter json`'s answer, sorted by file and line: one per declaring
 * line, a serial group's members folded into the group at its first line, and a file whose tests
 * carry no line one unit of its own.
 */
export const listedTests = (json: string): ListedTest[] => {
  const parsed = JSON.parse(json) as { pairs?: readonly Pair[] };
  const pairs = (parsed.pairs ?? []).filter((p): p is Pair & { file: string } => typeof p.file === "string");
  const lineOf = (p: Pair) => (typeof p.source?.line === "number" && p.source.line > 0 ? p.source.line : undefined);
  const groups = new Map<string, { line: number; name: string }>();
  for (const p of pairs) {
    const line = lineOf(p);
    if (typeof p.serialId !== "string" || line === undefined) continue;
    const id = `${p.file}\0${p.serialId}`;
    const at = groups.get(id);
    if (!at || line < at.line) groups.set(id, { line, name: titleOf(p).slice(0, -1).join(" › ") || titleOf(p).join(" › ") });
  }
  const units = new Map<string, ListedTest>();
  for (const p of pairs) {
    if (pairs.some((q) => q.file === p.file && lineOf(q) === undefined)) {
      units.set(p.file, { file: p.file, name: p.file });
      continue;
    }
    const group = typeof p.serialId === "string" ? groups.get(`${p.file}\0${p.serialId}`) : undefined;
    const line = group?.line ?? (lineOf(p) as number);
    const id = `${p.file}:${line}`;
    if (!units.has(id)) units.set(id, { file: p.file, line, name: group?.name ?? titleOf(p).join(" › ") });
  }
  return [...units.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
};

/**
 * Pure: the e2e configs of the checkout (repository-relative), outside any node_modules; with `only`
 * (`--only`'s paths), the ones whose folder holds one of those paths or lies under one.
 */
export const e2eConfigs = (paths: Iterable<string>, only?: readonly string[]) =>
  [...paths]
    .filter((p) => CONFIG.test(p) && !p.split("/").includes("node_modules"))
    .filter((p) => !only || only.some((o) => overlaps(posix.dirname(p), posix.normalize(o).replace(/\/$/, ""))))
    .sort();

const overlaps = (dir: string, path: string) => dir === "." || path === "." || dir === path || dir.startsWith(`${path}/`) || path.startsWith(`${dir}/`);

/** Pure: the variables a source reads by name (`process.env.NAME`, `process.env["NAME"]`, `import.meta.env.NAME`). */
export const envNames = (text: string): string[] => {
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])/g)) {
    const name = m[1] ?? m[2];
    if (name) names.add(name);
  }
  return [...names];
};

/** The nearest installed CLI from the config's folder up to the repository's root, relative to that folder. */
export const nearestCli = (repo: string, dir: string): string | undefined => {
  const parts = dir === "." ? [] : dir.split("/");
  for (let i = parts.length; i >= 0; i--) {
    const at = [...parts.slice(0, i), CLI].join("/");
    if (existsSync(`${repo}/${at}`)) return posix.relative(dir, at);
  }
  return undefined;
};

/** A source's text; a file the index has but the working tree lost reads as empty (it names no variable). */
const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const list = (cwd: string, cli: string, config: string, filter: readonly string[], env: Env) =>
  Effect.tryPromise({
    try: async () => {
      // A filter may leave a config with no test: no unit, not an error.
      const select = filter.length > 0 ? [...filter, "--pass-with-no-tests"] : [];
      const child = Bun.spawn(["node", cli, "list", "--reporter", "json", "--config", config, ...select], {
        cwd,
        env: env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error((err.trim() || out.trim()).split("\n").slice(-5).join("\n") || `exit ${code}`);
      return listedTests(out);
    },
    catch: (error) => new ConfigInvalid({ message: `e2e list in ${cwd}: ${error instanceof Error ? error.message : String(error)}` }),
  });

/**
 * Pure: the key of an app the workflow builds once per run for a device target (e2e.yml `build`): its
 * build command, the machine that builds it (the OS, its release and the image, which holds the
 * SDK), and the content of the files its inputs' globs match (from the root; `!glob` excludes). The
 * built app is cached under it, and every discovered suite keyed on it (APP_ENV).
 */
export const appKey = (blobs: Blobs, build: string, inputs: readonly string[], machine: string) =>
  sha256(JSON.stringify(["outrun-e2e-app-1", build, machine, blobsOf(blobs, matching(blobs, ".", inputs))]));

/**
 * Pure: the tier entry of a build's own cache folders (e2e.yml `build-cache`): its build command, the
 * machine and the folders, never the sources' content, so a build whose key missed restores what the
 * last build on this machine left (an incremental build), and saves it again after.
 */
export const buildCacheEntry = (build: string, paths: readonly string[], machine: string) =>
  `e2e-build-cache-${sha256(JSON.stringify(["outrun-e2e-build-cache-1", build, machine, [...paths].sort()])).slice(0, 32)}.tar`;

/** Where listings are kept, and whether the CLI may be run for one that is not. */
export interface Listings {
  readonly graph: ImportGraph;
  readonly state: string;
  readonly remote?: Remote | undefined;
  /** Never run the CLI: a config whose listing is not kept is `missing` (the plan job before its install). */
  readonly cachedOnly?: boolean | undefined;
}

/** Pure: the key of a config's listing: what its answer depends on. */
const listingKey = (input: {
  readonly path: string;
  readonly paths: readonly string[];
  readonly tests: readonly (readonly [string, string])[];
  readonly closure: readonly (readonly [string, string])[];
  readonly lockfiles: readonly (readonly [string, string])[];
  readonly env: readonly (readonly [string, string])[];
  readonly filter: readonly string[];
}) => sha256(JSON.stringify(["outrun-e2e-listing-2", input.path, input.paths, input.tests, input.closure, input.lockfiles, input.env, input.filter]));

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const blobsOf = (blobs: Blobs, files: Iterable<string>) => [...new Set(files)].sort().map((f) => [f, blobs.get(f) ?? "missing"] as const);

const isListed = (t: unknown): t is ListedTest => {
  if (!t || typeof t !== "object") return false;
  const { file, line, name } = t as Record<string, unknown>;
  return typeof file === "string" && typeof name === "string" && (line === undefined || (typeof line === "number" && line > 0));
};

/** Pure: a kept listing's tests, or undefined for anything else (an older format is listed again). */
export const keptTests = (text: string | undefined): ListedTest[] | undefined => {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { v?: unknown; tests?: unknown };
    return parsed.v === 2 && Array.isArray(parsed.tests) && parsed.tests.every(isListed) ? (parsed.tests as ListedTest[]) : undefined;
  } catch {
    return undefined;
  }
};

const readKept = (listings: Listings, key: string) =>
  Effect.gen(function* () {
    const path = `${listings.state}/listings/${key}.json`;
    const local = keptTests(
      yield* Effect.tryPromise({
        try: async () => ((await Bun.file(path).exists()) ? await Bun.file(path).text() : undefined),
        catch: () => new FileFailed({ message: `${path}: not readable` }),
      }).pipe(
        // An unreadable kept listing is listed again: it only saves the CLI's run.
        Effect.catchTag("FileFailed", () => Effect.succeed(undefined)),
      ),
    );
    if (local) return { tests: local, from: "local" } as const;
    if (!listings.remote) return undefined;
    // A kept listing the cache cannot give only costs the CLI's run.
    const remote = keptTests(yield* get(listings.remote, key).pipe(Effect.catchTag("CacheUnavailable", () => Effect.succeed(undefined))));
    return remote ? ({ tests: remote, from: "remote" } as const) : undefined;
  });

const keep = (listings: Listings, key: string, tests: readonly ListedTest[], fromRemote: boolean) =>
  Effect.gen(function* () {
    const body = JSON.stringify({ v: 2, tests });
    const path = `${listings.state}/listings/${key}.json`;
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(`${listings.state}/listings`, { recursive: true });
        await Bun.write(`${path}.${process.pid}.tmp`, body);
        await rename(`${path}.${process.pid}.tmp`, path);
      },
      catch: () => new ConfigInvalid({ message: `${path}: not writable` }),
    });
    if (listings.remote && !fromRemote) {
      const refused = yield* put(listings.remote, [{ hash: key, body, durationMs: 0, tag: "" }]);
      if (refused.count > 0) yield* Console.error(`outrun: the remote cache refused a listing (${refused.statuses})`);
    }
  }).pipe(Effect.catchTag("ConfigInvalid", (e) => Console.error(`outrun: ${e.message}`)));

/**
 * The configuration of every e2e config of the checkout (README.md "End-to-end tests"); with `cachedOnly`, the
 * configs whose listing is not kept are `missing` and no suite is made.
 */
export const discoverE2e = (repo: string, blobs: Blobs, env: Env, listings: Listings, only?: readonly string[]) =>
  Effect.gen(function* () {
    const configs = e2eConfigs(blobs.keys(), only);
    if (configs.length === 0)
      return yield* new ConfigInvalid({ message: `--e2e: no e2e.config.ts (or .mts, .js, .mjs) in the checkout${only ? ` under ${only.join(", ")}` : ""}` });
    const filter = parseFilter(env[FILTER_ENV]);
    if (filter instanceof ConfigInvalid) return yield* filter;
    const suites = yield* Effect.forEach(
      configs,
      (path) =>
        Effect.gen(function* () {
          const dir = posix.dirname(path);
          const base = posix.basename(path);
          const prefix = dir === "." ? "" : `${dir}/`;
          const folder = [...blobs.keys()].filter((p) => p.startsWith(prefix) && !p.split("/").includes("node_modules"));
          const names = new Set<string>([APP_ENV]);
          for (const p of folder) if (SOURCE.test(p)) for (const n of envNames(readText(`${repo}/${p}`))) if (!RUN_IDENTITY.has(n)) names.add(n);
          const closure = listings.graph.closure([path]);
          const key = listingKey({
            path,
            paths: [...folder].sort(),
            tests: blobsOf(
              blobs,
              folder.filter((p) => TEST_NAME.test(p)),
            ),
            closure: blobsOf(blobs, [...closure.files, ...[...closure.wholes].flatMap((w) => listings.graph.filesUnder(w))]),
            lockfiles: blobsOf(
              blobs,
              matching(
                blobs,
                ".",
                LOCKFILES.map((l) => `**/${l}`),
              ),
            ),
            // The app's key is in the suite's keys, not its listing's: a new build reruns the tests
            // without listing them again.
            env: hashedEnv(
              env,
              [...names].filter((n) => n !== APP_ENV),
            ),
            filter,
          });
          const kept = yield* readKept(listings, key);
          let tests: readonly ListedTest[];
          if (kept) {
            tests = kept.tests;
            if (kept.from === "remote") yield* keep(listings, key, tests, true);
          } else if (listings.cachedOnly) return { missing: path } as const;
          else {
            const cli = nearestCli(repo, dir);
            if (!cli)
              return yield* new ConfigInvalid({
                message: `${path}: TesterArmy's e2e CLI is not installed (no ${CLI} from ${dir} up); install the repository's dependencies first`,
              });
            tests = yield* list(dir === "." ? repo : `${repo}/${dir}`, cli, base, filter, env);
            yield* keep(listings, key, tests, false);
          }
          const suite: Suite = {
            name: `e2e:${dir}`,
            adapter: "e2e",
            dir,
            tests: [...new Set(tests.map((t) => t.file))].sort(),
            units: tests,
            // `e2e` is the CLI the batch finds installed (adapters/e2e.ts), so the key does not depend
            // on where the install put it, and a plan made before any install keys what its shards run.
            // The filter is in it too: a serial group's member it leaves out stays out.
            run: ["e2e", "run", "--config", base, ...filter, "--reporter", "list"],
            sources: ["suite", "imports"],
            hashedEnv: [...names].sort(),
            inheritEnv: true,
            rerunAlone: false,
            maxAgeHours: 24,
            // A test never timed counts as a minute; a batch is killed after an hour, or 15 minutes silent.
            defaultMs: 60_000,
            timeoutMs: 3_600_000,
            idleMs: 900_000,
          };
          return { missing: undefined, suite };
        }),
      { concurrency: 4 },
    );
    const missing = suites.flatMap((s) => (s.missing === undefined ? [] : [s.missing]));
    const config: Config = { inputs: LOCKFILES, suites: suites.flatMap((s) => (s.suite === undefined ? [] : [s.suite])) };
    return { config, missing };
  });
