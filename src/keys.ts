// Units and their keys, in two phases (BuildXL's model).
//
// A unit is one test file. Its weak key names how it runs: the key recipe's version, its runner,
// folder, file and command, the toolchain's fingerprint and the keyed variables' values. A strong
// key adds the content, by git blob id ("missing" for an absent path), of a set of files the unit
// may read, plus the suite's own inputs (the global inputs such as the lockfile, the preloads'
// closure, the declared inputs), which every strong key holds.
//
// Two kinds of read sets give a unit its candidate strong keys:
//   - each read set a traced run recorded for this weak key (what the unit actually read, the
//     narrowest and most trusted), kept by the engine (`ReadSets`);
//   - the import closure (the upper bound computed from the sources), always: a fresh machine with
//     no read set recorded still finds what earlier runs wrote under it.
// A unit hits when any candidate's verdict is cached. A pass is written under the closure's key,
// and under the traced set's key when the run traced it.
//
// Keys never hold an absolute path, a machine name, a core count or a time, and the files come
// from git's index (tracked, or new and not ignored), never from globbing the working tree.
import { posix } from "node:path";
import { type CommandUnit, type Config, DEFAULT_SOURCES, type Suite } from "./config.ts";
import type { Blobs } from "./git.ts";
import { hashedEnv, keyedEnv } from "./machine.ts";
import type { ImportGraph } from "./sources/imports.ts";

/** Bumped when the key's recipe changes, so no verdict of the old recipe is replayed. */
const KEY_VERSION = "outrun-key-3";

/**
 * What one traced run of a unit read (repository-relative paths) and whether it used the network.
 * `reads` are keyed by content, except a path ending in `/`, a folder the unit listed, keyed by its
 * entries. `present` are keyed by whether each exists and as what (file, folder, absent), not by
 * content: the paths the unit only stat'ed and the ones it probed and found absent. A runner that
 * stats every test file when it starts (duckdb's) then depends on each file existing, not on its
 * text, so editing one test does not move every other test's key.
 */
export interface ReadSet {
  readonly reads: readonly string[];
  readonly present?: readonly string[];
  readonly net: boolean;
}

/** Weak key → the last read sets recorded for it, newest first. */
type ReadSets = ReadonlyMap<string, readonly ReadSet[]>;

export interface Unit {
  /** The file, repository-relative: stable and readable. */
  readonly id: string;
  readonly runner: Suite["adapter"];
  /** The suite's folder, repository-relative: where its runner starts. */
  readonly cwd: string;
  /** The file relative to cwd: what its runner is given. */
  readonly file: string;
  readonly suite: Suite;
  /** The import closure's files (sorted), besides the suite's inputs. */
  readonly inputs: readonly string[];
  readonly weak: string;
  /** The digest of the suite's inputs, which the closure's key holds. */
  readonly suiteDigest: string;
  /**
   * The digest a traced key holds instead: the suite's inputs without `suite` (every file of its
   * folder), which only stands in for reads nothing observed; a complete trace observed them.
   * The global and declared inputs stay: they name what builds files git does not hold (installed
   * packages, a binary built before the run), which a trace sees only as those untracked files.
   */
  readonly tracedDigest: string;
  /** The key a pass is written under: over the import closure. */
  readonly key: string;
  /** Every strong key that would replay it: the closure's, then each traced read set's. */
  readonly candidates: readonly string[];
  /** Whether a pass may be cached: not when a traced run saw it use the network. */
  readonly cacheable: boolean;
  readonly reason?: string;
}

export interface KeyContext {
  readonly config: Config;
  readonly blobs: Blobs;
  readonly graph: ImportGraph;
  readonly readSets: ReadSets;
  /** Per adapter: the toolchain's fingerprint (its runner's version and the machine's). */
  readonly toolchain: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const at = (dir: string, path: string) => (dir === "." || dir === "" ? posix.normalize(path) : posix.join(dir, path));

/** Pure: the tracked files the globs match (relative to `dir`; `!glob` excludes), as root-relative paths. */
export const matching = (blobs: Blobs, dir: string, globs: readonly string[], exclude: readonly string[] = []): string[] => {
  const include = globs.filter((g) => !g.startsWith("!")).map((g) => new Bun.Glob(g));
  if (include.length === 0) return [];
  const prefix = dir === "." || dir === "" ? "" : `${dir}/`;
  const skip = [...exclude, ...globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1))].map((g) => new Bun.Glob(g));
  const out: string[] = [];
  for (const path of blobs.keys()) {
    if (!path.startsWith(prefix) || path.includes("node_modules/")) continue;
    const rel = path.slice(prefix.length);
    if (include.some((g) => g.match(rel)) && !skip.some((g) => g.match(rel))) out.push(path);
  }
  return out.sort();
};

/** Pure: `[path, blob id]` of each file, sorted, "missing" for an absent one. */
const contents = (blobs: Blobs, files: Iterable<string>) => [...new Set(files)].sort().map((f) => [f, blobs.get(f) ?? "missing"] as const);

/** Pure: a strong key: the weak key, the suite's inputs' digest, and a read set's content. */
const strongKey = (weak: string, suiteDigest: string, blobs: Blobs, files: Iterable<string>) =>
  sha256(JSON.stringify([weak, suiteDigest, contents(blobs, files)]));

/** Folder (root-relative, "" for the root) → its entries' names (a folder's ending in `/`), from git's index. */
type Tree = ReadonlyMap<string, ReadonlySet<string>>;
const trees = new WeakMap<Blobs, Tree>();
const treeOf = (blobs: Blobs): Tree => {
  const cached = trees.get(blobs);
  if (cached) return cached;
  const tree = new Map<string, Set<string>>();
  for (const path of blobs.keys()) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const entries = tree.get(dir) ?? new Set<string>();
      entries.add(i === parts.length - 1 ? (parts[i] as string) : `${parts[i]}/`);
      tree.set(dir, entries);
    }
  }
  trees.set(blobs, tree);
  return tree;
};

/** Pure: the key of a traced read set: what it read by content, the folders it listed by their entries, the rest by presence. */
const tracedStrongKey = (weak: string, suiteDigest: string, blobs: Blobs, id: string, set: Pick<ReadSet, "reads" | "present">) => {
  const tree = treeOf(blobs);
  const folders = set.reads.filter((r) => r.endsWith("/"));
  const files = [id, ...set.reads.filter((r) => !r.endsWith("/"))];
  const listed = [...new Set(folders)].sort().map((f) => {
    const dir = f.replace(/\/+$/, "");
    const entries = tree.get(dir === "." ? "" : dir);
    return [f, entries ? [...entries].sort() : "absent"] as const;
  });
  const present = [...new Set(set.present ?? [])]
    .sort()
    .map((p) => [p, blobs.has(p) ? "file" : tree.has(p.replace(/\/+$/, "")) ? "folder" : "absent"] as const);
  // A set with neither listings nor presences keeps the key it had before they existed.
  return listed.length === 0 && present.length === 0
    ? strongKey(weak, suiteDigest, blobs, files)
    : sha256(JSON.stringify([weak, suiteDigest, contents(blobs, files), listed, present]));
};

/** Pure: a weak key. */
const weakKey = (parts: {
  runner: string;
  cwd: string;
  file: string;
  run: readonly string[];
  toolchain: string;
  env: readonly (readonly [string, string])[];
}) => sha256(JSON.stringify([KEY_VERSION, parts.runner, parts.cwd, parts.file, parts.run, parts.toolchain, parts.env]));

/** Every unit of the configuration with its keys, in a stable order. */
export const computeUnits = (context: KeyContext): Unit[] => {
  const { config, blobs, graph, env, readSets } = context;
  const global = matching(blobs, ".", config.inputs ?? []);
  const units: Unit[] = [];
  for (const suite of config.suites) {
    const sources = new Set(suite.sources ?? DEFAULT_SOURCES);
    const roots = (suite.roots ?? []).map((r) => at(suite.dir, r));
    const rootClosure = sources.has("imports") ? graph.closure(roots) : { files: new Set(roots), wholes: new Set<string>() };
    const declared = sources.has("declared") ? matching(blobs, suite.dir, suite.inputs ?? []) : [];
    const whole = sources.has("suite") ? graph.filesUnder(suite.dir) : [];
    const suiteFiles = [...global, ...rootClosure.files, ...declared, ...whole, ...[...rootClosure.wholes].flatMap((w) => graph.filesUnder(w))];
    const suiteDigest = sha256(JSON.stringify(["suite", suite.name, contents(blobs, suiteFiles)]));
    const tracedFiles = [...global, ...rootClosure.files, ...declared];
    const tracedDigest = sha256(JSON.stringify(["traced", suite.name, contents(blobs, tracedFiles)]));
    const toolchain = context.toolchain[suite.adapter] ?? "";
    const envParts = [...keyedEnv(env, [...(config.env ?? []), ...(suite.env ?? [])]), ...hashedEnv(env, suite.hashedEnv ?? [])];
    const run = [...suite.run, ...(suite.xcode ? [JSON.stringify(suite.xcode)] : [])];
    for (const id of matching(blobs, suite.dir, suite.tests, suite.exclude)) {
      const file = suite.dir === "." ? id : posix.relative(suite.dir, id);
      const files = new Set<string>([id]);
      if (sources.has("imports")) {
        const closure = graph.closure([id]);
        for (const f of closure.files) files.add(f);
        for (const w of closure.wholes) for (const f of graph.filesUnder(w)) files.add(f);
      }
      const weak = weakKey({ runner: suite.adapter, cwd: suite.dir, file, run, toolchain, env: envParts });
      const key = strongKey(weak, suiteDigest, blobs, files);
      const traced = readSets.get(weak) ?? [];
      const net = traced.find((s) => s.net);
      units.push({
        id,
        runner: suite.adapter,
        cwd: suite.dir,
        file,
        suite,
        inputs: [...files].sort(),
        weak,
        suiteDigest,
        tracedDigest,
        key,
        candidates: [key, ...traced.map((s) => tracedStrongKey(weak, tracedDigest, blobs, id, s))],
        cacheable: !net,
        ...(net ? { reason: "a traced run used the network" } : {}),
      });
    }
  }
  return units;
};

/** Pure: the key a traced pass is written under, from what this run saw. */
export const tracedKey = (unit: Unit, blobs: Blobs, set: Pick<ReadSet, "reads" | "present">) =>
  tracedStrongKey(unit.weak, unit.tracedDigest, blobs, unit.id, set);

export interface KeyedCommand {
  readonly name: string;
  readonly command: CommandUnit;
  readonly key: string;
  readonly inputs: number;
}

/** Every command unit of the configuration with its key (`machine`: the machine's fingerprint). */
export const computeCommands = (context: Omit<KeyContext, "readSets" | "toolchain">, machine: string): KeyedCommand[] => {
  const { config, blobs, graph, env } = context;
  const global = matching(blobs, ".", config.inputs ?? []);
  return (config.commands ?? []).map((command) => {
    const closure = graph.closure(matching(blobs, ".", command.roots ?? []));
    const files = new Set([...global, ...matching(blobs, ".", command.inputs), ...closure.files, ...[...closure.wholes].flatMap((w) => graph.filesUnder(w))]);
    const envParts = keyedEnv(env, [...(config.env ?? []), ...(command.env ?? [])]);
    const key = sha256(JSON.stringify([KEY_VERSION, "command", command.name, command.run, machine, envParts, contents(blobs, files)]));
    return { name: command.name, command, key, inputs: files.size };
  });
};
