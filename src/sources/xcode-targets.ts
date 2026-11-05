// What an xcodebuild test file depends on, from the tracer's per-target read sets.
//
// One traced `build-for-testing` (a tracer unit) writes, with OUTRUN_TRACE_MODULES=1, a
// `targets.jsonl` beside its `reads.jsonl`: one record per Swift module compiled (the unit's record
// format plus `"target"`: what that module's compiler processes read). A test file's verdict
// depends on its test target's module and on every module that one imports, directly or not
// (what it links), but not on the build's other modules. So a test file's observation is the build
// unit's record minus what only the other targets read, plus what its test run read:
//
//   - the closure: its test target and every target whose `.swiftmodule` (a product of the build,
//     `Build/Products/<config>/<M>.swiftmodule/`, `<M>.framework/Modules/<M>.swiftmodule/`, or
//     `<M>.build/.../<M>.swiftmodule`) a target of the closure read;
//   - the build's reads no target holds (the build system's: the project, asset catalogs, scripts,
//     headers) stay in every file's set, whatever their target, since nothing tells which target
//     they belong to;
//   - the test runs' records (the `test-without-building` units), whole.
//
// Every test file of a target gets the same set: it holds the target's sources, so editing one test
// file reruns its target's tests (the granularity of a Swift module). The output is the tracer's
// own JSON lines format, one line per test file, for `outrun test --trace` (sources/observed.ts).
// A test host app that the test target does not import is not seen: name it in the target's
// closure by importing it (`@testable import App`), as Xcode's test templates do.

export interface TracedRecord {
  readonly unit: string;
  readonly target?: string;
  readonly reads: readonly string[];
  readonly statOnly: readonly string[];
  readonly missing: readonly string[];
  readonly complete: boolean;
  readonly env: readonly string[];
  readonly exec: readonly string[];
  readonly net: readonly string[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Pure: the records of a tracer JSON lines text (reads.jsonl or targets.jsonl). */
export const parseRecords = (text: string): TracedRecord[] => {
  const out: TracedRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof r.unit !== "string") continue;
    out.push({
      unit: r.unit,
      ...(typeof r.target === "string" ? { target: r.target } : {}),
      reads: strings(r.reads),
      statOnly: strings(r.stat_only),
      missing: strings(r.missing),
      complete: r.complete !== false,
      env: strings(r.env),
      exec: strings(r.exec),
      net: strings(r.net),
    });
  }
  return out;
};

const MODULE_READ = [
  /\/Build\/Products\/[^/]+\/(?:[^/]+\.framework\/Modules\/)?([^/]+)\.swiftmodule(?:\/|$)/,
  /\/([^/]+)\.build\/(?:[^/]+\/)*\1\.swiftmodule$/,
];

/** Pure: the modules whose built interface a record read. */
export const modulesRead = (record: Pick<TracedRecord, "reads">): Set<string> => {
  const out = new Set<string>();
  for (const path of record.reads)
    for (const pattern of MODULE_READ) {
      const m = pattern.exec(path);
      if (m?.[1]) out.add(m[1]);
    }
  return out;
};

/** Pure: `root` and every target of `targets` it reaches through the modules each one read. */
export const targetClosure = (targets: readonly TracedRecord[], root: string): Set<string> => {
  const byName = new Map<string, TracedRecord[]>();
  for (const t of targets) if (t.target) byName.set(t.target, [...(byName.get(t.target) ?? []), t]);
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name) || !byName.has(name)) continue;
    seen.add(name);
    for (const t of byName.get(name) ?? []) for (const m of modulesRead(t)) if (!seen.has(m)) queue.push(m);
  }
  return seen;
};

const union = (lists: readonly (readonly string[])[]) => [...new Set(lists.flat())].sort();

/**
 * Pure: the observation of a test target's files: the build's record without what only targets
 * outside the closure read, plus the test runs' records. Undefined when the build's record or the
 * test target is not in the trace (nothing proves what the files depend on).
 */
export const targetObservation = (
  build: TracedRecord,
  targets: readonly TracedRecord[],
  runs: readonly TracedRecord[],
  testTarget: string,
): Omit<TracedRecord, "unit"> | undefined => {
  const mine = targets.filter((t) => t.unit === build.unit);
  if (!mine.some((t) => t.target === testTarget)) return undefined;
  const closure = targetClosure(mine, testTarget);
  const inside = mine.filter((t) => closure.has(t.target ?? ""));
  const outside = mine.filter((t) => !closure.has(t.target ?? ""));
  const kept = (field: "reads" | "statOnly" | "missing") => {
    const owned = new Set(inside.flatMap((t) => t[field]));
    const others = new Set(outside.flatMap((t) => t[field]));
    return build[field].filter((p) => owned.has(p) || !others.has(p));
  };
  const reads = union([kept("reads"), ...runs.map((r) => r.reads)]);
  // Only stat'ed: by every part that saw it (a path the build opened and the run stat'ed was opened).
  const opened = new Set(
    [{ reads: kept("reads"), statOnly: kept("statOnly") }, ...runs].flatMap((part) => {
      const stat = new Set(part.statOnly);
      return part.reads.filter((p) => !stat.has(p));
    }),
  );
  return {
    reads,
    statOnly: union([kept("statOnly"), ...runs.map((r) => r.statOnly)]).filter((p) => !opened.has(p)),
    missing: union([kept("missing"), ...runs.map((r) => r.missing)]),
    complete: build.complete && runs.every((r) => r.complete),
    env: union([build.env, ...runs.map((r) => r.env)]),
    exec: union([build.exec, ...runs.map((r) => r.exec)]),
    net: union([build.net, ...runs.map((r) => r.net)]),
  };
};

/** Pure: the tracer's JSON line of one test file (absolute path) with its target's observation. */
/**
 * Names the compiler gives what it holds in memory, which it then looks up beside the sources: a
 * macro's expansion (`@__swiftmacro_…`), a clang module's scan input (`AVFAudio-1a87dd8d.input`),
 * `<swift-imported-modules>`. No checkout can hold them: they are not inputs.
 */
const VIRTUAL = /(?:^|\/)(?:@__swiftmacro_[^/]*|[\w+]+-[0-9a-f]{8}\.input|[^/]*[<>][^/]*)$/;

/**
 * Pure: only the paths under `roots` (the checkout, as the tracer saw it: its real path), relative
 * to it (`./` for the checkout itself), as the engine keys them; a build reads hundreds of thousands
 * of paths outside (packages, caches, the SDK), which every test file's line would otherwise
 * repeat. Paths under `.git/` (keys come from the index) and compiler names (`VIRTUAL`) are dropped
 * too. `keep`: paths outside kept whole (the `.swiftmodule` products, which give a target's imports).
 */
export const withinRepo = <T extends Omit<TracedRecord, "unit">>(o: T, roots: readonly string[], keep: (path: string) => boolean = () => false): T => {
  const prefixes = [...new Set(roots.map((r) => r.replace(/\/+$/, "")))];
  const move = (paths: readonly string[]) =>
    paths.flatMap((p) => {
      const root = prefixes.find((r) => p === r || p.startsWith(`${r}/`));
      if (root === undefined) return keep(p) ? [p] : [];
      const rel = p.slice(root.length + 1);
      if (rel === "") return p.endsWith("/") ? ["./"] : [];
      return rel === ".git" || rel.startsWith(".git/") || VIRTUAL.test(rel) ? [] : [rel];
    });
  return { ...o, reads: move(o.reads), statOnly: move(o.statOnly), missing: move(o.missing) };
};

export const observationLine = (file: string, o: Omit<TracedRecord, "unit">) =>
  JSON.stringify({
    unit: file,
    reads: o.reads,
    stat_only: o.statOnly,
    missing: o.missing,
    complete: o.complete,
    env: o.env,
    exec: o.exec,
    net: o.net,
  });
