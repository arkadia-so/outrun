// What a cached pass says, who may read it, and for how long.
//
// A verdict is a record of one unit passing at one key (failures are never stored, except a
// quarantined command's: it never gates, so its known failure is replayed rather than rerun). Its tier names
// who produced it: main's CI writes `trusted`, a pull request `pr-<n>`, an agent session
// `session-<id>`, a developer's machine `local-<id>`; each reads its own tier, then `trusted`, so
// nothing a pull request or a laptop ran becomes main's verdict. The remote cache enforces the same
// split on its side (its namespaces); the client checks it again for what it reads from the
// machine's own cache, which several tiers may share.
//
// Every artifact the engine writes carries a tag (`x-artifact-tag`) the batch query returns with
// it, so a lookup decides without fetching any body: the run that wrote it (a run's shards ignore
// their own writes), when (verdicts expire after 7 days: tests read the clock), its tier, and for a
// timing the duration it replaced.

/** `trusted`, `pr-<n>`, `session-<id>` or `local-<id>`. */
export type Tier = string;

export interface Verdict {
  readonly v: 1;
  readonly unit: string;
  readonly key: string;
  readonly outcome: "pass" | "fail";
  /** The file's own cost, from its runner's report. */
  readonly durationMs: number;
  readonly producedAt: string;
  readonly tier: Tier;
  readonly producer: { readonly commit: string; readonly runner: string; readonly image: string };
  /** Ed25519 signature by the runner's host, outside the job's reach: not produced yet. */
  readonly sig?: string;
}

/** Verdicts, quarantines and divergences older than this are ignored. */
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

type Env = Readonly<Record<string, string | undefined>>;

const clean = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);

/**
 * Pure: this run's tier. `trusted` only for a GitHub Actions run of a push, schedule or manual
 * dispatch on the trusted ref; a pull request's run `pr-<n>`; a session (`OUTRUN_SESSION`) or any
 * other CI run `session-<id>`; anything else `local-<host>`.
 */
export const tierOf = (env: Env, trustedRef: string, host: string): Tier => {
  if (env.GITHUB_ACTIONS === "true") {
    const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "");
    if (pr) return `pr-${pr[1]}`;
    if (env.GITHUB_REF === trustedRef && ["push", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "")) return "trusted";
    return `session-${clean(env.GITHUB_REF_NAME ?? env.GITHUB_RUN_ID ?? "ci")}`;
  }
  if (env.OUTRUN_SESSION) return `session-${clean(env.OUTRUN_SESSION)}`;
  return `local-${clean(host)}`;
};

/** Pure: the tiers a run of this tier replays, its own first. */
export const readable = (tier: Tier): readonly Tier[] => (tier === "trusted" ? ["trusted"] : [tier, "trusted"]);

export interface Tag {
  readonly run?: string | undefined;
  /** When it was written, in seconds since the epoch. */
  readonly at?: number | undefined;
  readonly tier?: Tier | undefined;
  /** A timing's: the duration it replaced (what the run's other shards planned with). */
  readonly prev?: number | undefined;
}

/** Pure: the tag of an artifact. */
export const formatTag = (tag: Tag) =>
  ["outrun2", ...Object.entries(tag).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${typeof v === "number" ? Math.round(v) : v}`]))].join(";");

/** Pure: a tag's fields; an older or foreign tag gives none (so it is never fresh). */
export const parseTag = (text: string): Tag => {
  const [head, ...fields] = text.split(";");
  if (head !== "outrun2") return {};
  const map = new Map(fields.map((f) => [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)] as const));
  const number = (k: string) => (map.has(k) ? Number(map.get(k)) : undefined);
  return { run: map.get("run"), at: number("at"), tier: map.get("tier"), prev: number("prev") };
};

/** Pure: whether an artifact tagged so may be replayed by a run of `tier` at `nowMs`. */
export const usable = (tag: Tag, tier: Tier, nowMs: number) =>
  tag.at !== undefined && nowMs - tag.at * 1000 < MAX_AGE_MS && tag.tier !== undefined && readable(tier).includes(tag.tier);
