// The tracer's output: what each unit was seen reading during a run, as JSON
// lines `{"unit","reads","stat_only","missing","complete","env","exec","net"}` (one per unit and run;
// a read ending in `/` is a folder listed, kept as such: when lookups were lost, `missing_complete`
// false, the tracer lists every folder above what the unit read instead). Its reads inside the
// repository become a read set of the unit's weak key (keys.ts), a key of their own; a read
// outside it (the toolchain, the dependencies) is the toolchain's and the global inputs'. The
// variables it read are in the allow-list or stripped (machine.ts). A unit seen using the network
// has no reproducible verdict: it is never replayed. On macOS the tracer cannot see TCP
// (`net_complete` false): a unit that resolves a name gets `net: ["unknown:ip"]` and so is never
// replayed, but a connect to a literal IP stays invisible. An empty `net` with `net_complete` false
// still counts as no network: refusing it would make every macOS unit uncacheable, for tests that
// dial a hard-coded address, which are rare and fail loudly without the network (ARK-81).
import { posix } from "node:path";
import type { ReadSet } from "../keys.ts";

export interface Observation {
  readonly unit: string;
  readonly reads: readonly string[];
  /** Reads only stat'ed, never opened (a subset of reads). */
  readonly statOnly: readonly string[];
  /** Paths probed and found absent. */
  readonly missing: readonly string[];
  /** No read event was lost: a trace that lost some is not a read set. */
  readonly complete: boolean;
  readonly env: readonly string[];
  readonly exec: readonly string[];
  readonly net: readonly string[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Pure: the observations of a JSON lines text, by unit (repository-relative), later lines merged in. */
export const parseObserved = (text: string, repo: string): Map<string, Observation> => {
  const byUnit = new Map<string, Observation>();
  const relative = (path: string) => {
    const slash = path.endsWith("/") ? "/" : "";
    if (!path.startsWith("/")) return posix.normalize(path).replace(/\/$/, "") + slash;
    const rel = posix.relative(repo, path);
    if (rel.startsWith("..")) return undefined;
    return rel === "" ? (slash ? "./" : undefined) : rel + slash;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof record.unit !== "string") continue;
    const unit = relative(record.unit)?.replace(/\/$/, "");
    if (!unit) continue;
    const before = byUnit.get(unit);
    const merge = (a: readonly string[] | undefined, b: string[]) => [...new Set([...(a ?? []), ...b])];
    byUnit.set(unit, {
      unit,
      reads: merge(
        before?.reads,
        strings(record.reads).flatMap((r) => relative(r) ?? []),
      ),
      statOnly: merge(
        before?.statOnly,
        strings(record.stat_only).flatMap((r) => relative(r) ?? []),
      ),
      missing: merge(
        before?.missing,
        strings(record.missing).flatMap((r) => relative(r) ?? []),
      ),
      complete: (before?.complete ?? true) && record.complete !== false,
      env: merge(before?.env, strings(record.env)),
      exec: merge(before?.exec, strings(record.exec)),
      net: merge(before?.net, strings(record.net)),
    });
  }
  return byUnit;
};

/**
 * Pure: the read set of an observation, or undefined when the trace lost read events (a set
 * missing a read would replay a verdict the read's change should have broken). The paths only
 * stat'ed (`presence`, the default) and the ones found absent are keyed by presence; listed
 * folders (`dir/`) by their entries; the rest by content.
 */
export const readSetOf = (seen: Observation, statOnly: "presence" | "content"): ReadSet | undefined => {
  if (!seen.complete) return undefined;
  const byPresence = new Set(statOnly === "presence" ? seen.statOnly.filter((p) => !p.endsWith("/")) : []);
  const reads = seen.reads.filter((r) => !byPresence.has(r));
  const present = [...new Set([...byPresence, ...seen.missing.filter((m) => !reads.includes(m))])];
  return { reads: [...reads].sort(), ...(present.length > 0 ? { present: present.sort() } : {}), net: seen.net.length > 0 };
};
