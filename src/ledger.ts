// The cache ledger (README.md "outrun report", D4 and D5 of OUT-94): what outrun's cache did for one
// job, each restore and each save, as the machine's cache sidecar recorded it and the job's
// "Complete runner" step printed it in the job's own log, then read back by `outrun report`. One
// definition of its format, shared by its writer (the sidecar, private) and its reader (this CLI):
// human lines, then one machine-readable line, `outrun-cache-ledger v1 <json>`. The job's report
// prints the cache's human lines and one line of its own, `job-report v2 <json>`, which holds that
// ledger (or why there is none) beside the job's load (contention.ts): the job's one machine-readable
// line (D1); version 1 of it was the cache ledger's line alone.
//
// Then, pure, what the report does with it: each restore and save attributed to the step whose time
// holds it, and the flags (a save slower than the job's own work, a save of unchanged content, a cache
// whose restore plus save costs more than it avoids). Nothing names where the bytes are kept: a job's
// log is public on a public repository. A pure file importing nothing: the machines' agent imports it.

/** A step as GitHub's jobs API gives it, what attribution reads of it (timeline.ts ApiStep has these fields). */
interface ApiStep {
  readonly name: string;
  readonly number?: number;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

/** Each step's start to the 100 ns, by its number: the first line of its own log in GitHub's run logs archive. */
export type StepStarts = ReadonlyMap<number, number>;

/**
 * What every version's line holds (the job's report looks for it: its text names no product, as the hooks' text must not).
 * @public
 */
export const LEDGER_TAG = "cache-ledger v";
/** The machine-readable line's mark, its version included: a reader refuses a version it does not know. */
const LEDGER_MARK = `outrun-${LEDGER_TAG}1 `;
const ANY_LEDGER = /outrun-cache-ledger v(\d+) /;
/**
 * Where a job's cache endpoint serves its ledger (plain HTTP, inside the machine).
 * @public
 */
export const LEDGER_PATH = "/cache-ledger";
/**
 * What the job's report prints when it could not read the ledger, then why.
 * @public
 */
export const LEDGER_NOT_MEASURED = "cache ledger: not measured";

/** exact: the key asked was found; partial: one of its restore keys was; miss: neither. */
export type HitKind = "exact" | "partial" | "miss";
/** Where a hit's bytes came from: the machine's own copy, outrun's remote store, or GitHub's cache (behind outrun's on macOS). */
type RestoreSource = "local" | "remote" | "github";

export interface LedgerRestore {
  readonly key: string;
  readonly restoreKeys: readonly string[];
  /** The key found; null on a miss. */
  readonly matched: string | null;
  readonly hit: HitKind;
  /** Null on a miss, and for a hit the job never downloaded. */
  readonly source: RestoreSource | null;
  /** Bytes served to the job; null: not measured. */
  readonly bytes: number | null;
  /** Epoch ms: the lookup asked. */
  readonly start: number;
  /** Epoch ms: the last byte served (a miss: the lookup answered); null: not measured. */
  readonly end: number | null;
  /** SHA-256 of the bytes served; null: not measured. */
  readonly sha256: string | null;
  /** Why the download did not complete, when it did not. */
  readonly failed?: string;
}

/** saved; exists: the cache already held the key; given-up: past the save's deadline; failed: anything else (`reason`). */
type SaveOutcome = "saved" | "exists" | "given-up" | "failed";

export interface LedgerSave {
  readonly key: string;
  /** Where it went: outrun's cache, or GitHub's (when outrun's could not take it, on macOS). */
  readonly to: "outrun" | "github";
  /** Bytes saved; null: not measured. */
  readonly bytes: number | null;
  /** Epoch ms: the save created (CreateCacheEntry). */
  readonly start: number;
  /** Epoch ms: the save finalized or refused; null: never finalized. */
  readonly end: number | null;
  readonly outcome: SaveOutcome;
  readonly reason?: string;
  /** SHA-256 of the bytes saved, when computed exactly; null: not measured. */
  readonly sha256: string | null;
}

export interface Ledger {
  readonly v: 1;
  readonly restores: readonly LedgerRestore[];
  readonly saves: readonly LedgerSave[];
}

/** exact when the key found is the key asked (compared as actions/cache does: case-insensitive). */
export const hitKind = (key: string, matched: string | null): HitKind =>
  matched === null ? "miss" : key.localeCompare(matched, undefined, { sensitivity: "accent" }) === 0 ? "exact" : "partial";

const mb = (bytes: number | null) =>
  bytes === null ? "size not measured" : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(1)} kB`;
const clock = (epochMs: number) => new Date(epochMs).toISOString().slice(11, 21);
const span = (start: number, end: number | null) =>
  end === null ? `from ${clock(start)}, end not measured` : `${((end - start) / 1000).toFixed(1)} s (${clock(start)} to ${clock(end)})`;
const sha = (value: string | null) => (value === null ? "sha256 not measured" : `sha256 ${value.slice(0, 16)}`);
const SOURCE: Record<RestoreSource, string> = { local: "from the machine's own copy", remote: "from outrun's cache", github: "from GitHub's cache" };

/** The ledger as the job's report prints it: human lines, then the machine-readable line. */
export const ledgerText = (ledger: Ledger): string => {
  const lines = [
    `Cache (${ledger.restores.length} restore${ledger.restores.length === 1 ? "" : "s"}, ${ledger.saves.length} save${ledger.saves.length === 1 ? "" : "s"}):`,
  ];
  for (const r of ledger.restores) {
    if (r.hit === "miss")
      lines.push(`  restore ${r.key}: miss${r.restoreKeys.length ? ` (also asked ${r.restoreKeys.join(", ")})` : ""}, ${span(r.start, r.end)}`);
    else
      lines.push(
        `  restore ${r.key}: ${r.hit} hit${r.hit === "partial" ? ` on ${r.matched}` : ""}, ${r.source ? SOURCE[r.source] : "not downloaded"}, ${mb(r.bytes)}, ${span(r.start, r.end)}, ${sha(r.sha256)}${r.failed ? `, failed: ${r.failed}` : ""}`,
      );
  }
  for (const s of ledger.saves)
    lines.push(
      `  save ${s.key}: ${s.outcome}${s.reason ? ` (${s.reason})` : ""}${s.to === "github" ? " in GitHub's cache" : ""}, ${mb(s.bytes)}, ${span(s.start, s.end)}, ${sha(s.sha256)}`,
    );
  lines.push(`${LEDGER_MARK}${JSON.stringify(ledger)}`);
  return lines.join("\n");
};

/** A job's ledger read from its log, or why there is none. */
export type LedgerRead = { readonly ledger: Ledger } | { readonly absent: string };

/** The first words of the job's report, printed by every version of outrun's runners' hook. */
export const STEP_REPORT = "Step times and load";

/**
 * The job's machine-readable line, as the hook prints it: `job-report v2 <json>`. Its text names no
 * product, as the hooks' text must not.
 * @public
 */
export const JOB_REPORT_MARK = "job-report v2 ";
const ANY_JOB_REPORT = /(?:^|\s)job-report v(\d+) /;

/** What the job's line holds: its cache ledger (or why none) and its load (contention.ts JobLoad, or why none), as read, unchecked. */
export interface JobReportLine {
  readonly cache: unknown;
  readonly load: unknown;
}

/** The job's line in its log; undefined when it has none (a job before version 2 of it, or not on outrun's runners). */
export const jobReportOf = (log: string): { readonly line: JobReportLine } | { readonly absent: string } | undefined => {
  const line = log.split("\n").find((l) => ANY_JOB_REPORT.test(l));
  if (!line) return undefined;
  const version = Number(ANY_JOB_REPORT.exec(line)![1]);
  if (version !== 2) return { absent: `its log holds a job report of version ${version}, newer than this outrun reads: update outrun` };
  try {
    const value = JSON.parse(line.slice(line.indexOf(JOB_REPORT_MARK) + JOB_REPORT_MARK.length).trim()) as { v?: unknown; cache?: unknown; load?: unknown };
    if (value.v === 2) return { line: { cache: value.cache, load: value.load } };
  } catch {
    // Deliberate: a line cut or mangled is no report, said below.
  }
  return { absent: "its job report line could not be read" };
};

/** `{ absent: why }` as the job's line writes what it could not measure. */
export const absentOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && typeof (value as { absent?: unknown }).absent === "string" ? (value as { absent: string }).absent : undefined;

const isLedger = (value: unknown): value is Ledger =>
  typeof value === "object" &&
  value !== null &&
  (value as Ledger).v === 1 &&
  Array.isArray((value as Ledger).restores) &&
  Array.isArray((value as Ledger).saves);

/** The ledger in a job's log (GitHub's job logs API: one timestamp before each line), or why it has none. */
export const ledgerOf = (log: string): LedgerRead => {
  const report = jobReportOf(log);
  if (report !== undefined) {
    if ("absent" in report) return report;
    const { cache } = report.line;
    if (isLedger(cache)) return { ledger: cache };
    return { absent: absentOf(cache) ?? "its job report holds no cache ledger it could read" };
  }
  const line = log.split("\n").find((l) => ANY_LEDGER.test(l));
  if (line) {
    const version = Number(ANY_LEDGER.exec(line)![1]);
    if (version !== 1) return { absent: `its log holds a cache ledger of version ${version}, newer than this outrun reads: update outrun` };
    const text = line.slice(line.indexOf(LEDGER_MARK) + LEDGER_MARK.length).trim();
    try {
      const value: unknown = JSON.parse(text);
      if (isLedger(value)) return { ledger: value };
    } catch {
      // Deliberate: a line cut or mangled is no ledger, said below.
    }
    return { absent: "its cache ledger line could not be read" };
  }
  const notMeasured = log.split("\n").find((l) => l.includes(LEDGER_NOT_MEASURED));
  if (notMeasured) return { absent: notMeasured.slice(notMeasured.indexOf(LEDGER_NOT_MEASURED)).trim() };
  if (log.includes(STEP_REPORT)) return { absent: "no cache ledger: the job ran before outrun's runners recorded one" };
  return { absent: "no cache ledger: the job did not run on outrun's runners" };
};

/** A restore or a save, with the step that holds it. */
type Attributed<T> = T & {
  /** The step whose time holds it; null when none or several do (`steps` then names them). */
  readonly step: string | null;
  readonly stepSec: number | null;
  readonly steps?: readonly string[];
};

export interface JobCache {
  readonly restores: readonly Attributed<LedgerRestore>[];
  readonly saves: readonly Attributed<LedgerSave>[];
  /** What deserves a look, one sentence each. */
  readonly flags: readonly string[];
  /** What could not be checked, and why. */
  readonly notMeasured: readonly string[];
}

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The step whose time holds [start, end]. With [starts] (each step's own log's first line, to the 100
 * ns), steps follow one another: an event is in the step that started last before its start. Its end
 * is not compared: the ledger's clock is the machine's, the log's the VM's, a few milliseconds apart,
 * while a cache action asks its lookup well after its step started (its runtime starts first).
 * Without them, GitHub's step times are to the second, so a step holds an event from its start's second
 * to the second after its end; several steps share a boundary second: the one that holds the whole
 * interval wins, else none is claimed.
 */
export const stepOf = (steps: readonly ApiStep[], start: number, end: number | null, starts?: StepStarts) => {
  const seconds = (s: ApiStep) => (at(s.completed_at) - at(s.started_at)) / 1000;
  let latest: ApiStep | undefined;
  if (starts)
    for (const s of steps) {
      const t = s.number === undefined ? undefined : starts.get(s.number);
      if (t !== undefined && t <= start && (latest === undefined || t > starts.get(latest.number!)!)) latest = s;
    }
  if (latest) return { step: latest.name, stepSec: seconds(latest) };
  const holds = (s: ApiStep, t: number) => at(s.started_at) <= t && t < at(s.completed_at) + 1000;
  const candidates = steps.filter((s) => holds(s, start) && (end === null || holds(s, end)));
  if (candidates.length === 1) return { step: candidates[0]!.name, stepSec: seconds(candidates[0]!) };
  return { step: null, stepSec: null, ...(candidates.length > 1 ? { steps: candidates.map((s) => s.name) } : {}) };
};

const secs = (n: number) => `${Math.round(n)} s`;

/**
 * One job's cache: each restore and save attributed to its step, and the flags D4 and D5 name. [workSec]:
 * the job's own work (its work steps, timeline.ts), undefined when its steps were not classified;
 * [starts]: its steps' starts from their own logs, when GitHub's archive had them.
 */
export const jobCache = (ledger: Ledger, steps: readonly ApiStep[], workSec: number | undefined, starts?: StepStarts): JobCache => {
  const restores = ledger.restores.map((r) => ({ ...r, ...stepOf(steps, r.start, r.end, starts) }));
  const saves = ledger.saves.map((s) => ({ ...s, ...stepOf(steps, s.start, s.end, starts) }));
  const flags: string[] = [];
  const notMeasured: string[] = [];
  for (const s of saves) {
    if (s.outcome !== "saved") continue;
    if (s.stepSec === null) notMeasured.push(`save ${s.key}: no single step holds it, so its step's time is not measured`);
    else if (workSec === undefined) notMeasured.push(`save ${s.key}: the job's work is not measured (its steps were not matched to the workflow)`);
    else if (s.stepSec > workSec) flags.push(`save ${s.key} in "${s.step}" took ${secs(s.stepSec)}, longer than the job's own work (${secs(workSec)})`);
    // What the job restored before it saved: the same bytes saved again changed nothing.
    const restored = restores.filter((r) => r.sha256 !== null && r.start < s.start);
    if (s.sha256 === null) {
      if (restored.length > 0) notMeasured.push(`save ${s.key}: whether it changed is not measured (no sha256 of what it saved)`);
    } else {
      const same = restored.find((r) => r.sha256 === s.sha256);
      if (same) flags.push(`save ${s.key} stored the same bytes this job restored from ${same.matched} (sha256 ${s.sha256.slice(0, 16)}): an unchanged save`);
    }
  }
  return { restores, saves, flags, notMeasured };
};

/** One earlier run of the same job, for one cache (the restore step of that name): what its restore found and what its steps took. */
export interface CacheSample {
  readonly hit: HitKind;
  /** Its restore step, seconds. */
  readonly restoreSec: number;
  /** The step holding the save of the key it asked (0: no save), seconds. */
  readonly saveSec: number;
  /** The job's span minus those two steps, seconds: the time the cache may avoid. */
  readonly otherSec: number;
}

/** Runs of each kind needed before a verdict. */
const MIN_SAMPLES = 3;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface CacheVerdict {
  readonly exact: number;
  readonly miss: number;
  readonly partial: number;
  /** Absent: not enough runs of one kind. */
  readonly costSec?: number;
  readonly avoidedSec?: number;
  readonly pays?: boolean;
  readonly sentence: string;
}

/**
 * Whether a cache pays: its cost (the median restore step on an exact hit plus the median save step on
 * a miss) against what it avoids (the median rest of the job on a miss minus on an exact hit), from the
 * same job's runs on the default branch. Partial hits count in neither. Too few of either: no verdict.
 */
export const cacheVerdict = (name: string, samples: readonly CacheSample[], runsRead: number): CacheVerdict => {
  const exact = samples.filter((s) => s.hit === "exact");
  const miss = samples.filter((s) => s.hit === "miss");
  const partial = samples.length - exact.length - miss.length;
  const counts = `${exact.length} exact hit${exact.length === 1 ? "" : "s"}, ${miss.length} miss${miss.length === 1 ? "" : "es"}, ${partial} partial, in ${runsRead} run${runsRead === 1 ? "" : "s"} with a ledger`;
  if (exact.length < MIN_SAMPLES || miss.length < MIN_SAMPLES)
    return { exact: exact.length, miss: miss.length, partial, sentence: `${name}: not enough runs (${counts}; ${MIN_SAMPLES} of each needed)` };
  const costSec = median(exact.map((s) => s.restoreSec)) + median(miss.map((s) => s.saveSec));
  const avoidedSec = median(miss.map((s) => s.otherSec)) - median(exact.map((s) => s.otherSec));
  const pays = costSec < avoidedSec;
  return {
    exact: exact.length,
    miss: miss.length,
    partial,
    costSec,
    avoidedSec,
    pays,
    sentence: `${name}: restore on a hit plus save on a miss cost ${secs(costSec)}, it avoids ${secs(avoidedSec)}${pays ? "" : ": it costs more than it avoids"} (${counts})`,
  };
};
