// `outrun report <run>`: where a GitHub Actions run's time went (README.md "outrun report"), read
// from GitHub with the caller's own token (GH_TOKEN or GITHUB_TOKEN): the run, the jobs of one
// attempt, and the workflow file at the run's head commit (from this checkout when it has that
// commit, else GitHub's contents API), computed by timeline.ts. Plain text an agent reads, or --json.
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { formatAdded, jobAdded, timeoutOf } from "./added.ts";
import { contention, formatContention, loadOf, type LoadRead } from "./contention.ts";
import { UsageInvalid } from "./errors.ts";
import * as Git from "./git.ts";
import { type CacheSample, type CacheVerdict, cacheVerdict, type JobCache, jobCache, ledgerOf, type LedgerRead, type StepStarts } from "./ledger.ts";
import { type ApiJob, billedSpanSec, type JobTime, type Timeline, timeline, type WorkflowFiles } from "./timeline.ts";
import { parseWorkflow, type Workflow } from "./workflow.ts";
import { zipEntries } from "./zip.ts";

/** GitHub did not answer as expected (the run, its jobs). */
class ReportFailed extends Schema.TaggedError<ReportFailed>()("ReportFailed", { message: Schema.String }) {}

interface ApiRun {
  readonly id: number;
  readonly workflow_id?: number;
  readonly name?: string;
  readonly path?: string;
  readonly event?: string;
  readonly head_branch?: string | null;
  readonly head_sha: string;
  readonly run_attempt?: number;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly created_at?: string;
}

/** A run's repository, id and attempt, from a run URL (`…/actions/runs/<id>[/attempts/<n>][/job/<id>]`) or an id with --repo. */
export const runOf = (given: string, repo: string | undefined): { repo: string; id: number; attempt?: number } | UsageInvalid => {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?/.exec(given);
  if (url) return { repo: url[1]!, id: Number(url[2]), ...(url[3] ? { attempt: Number(url[3]) } : {}) };
  if (/^\d+$/.test(given)) {
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
      return new UsageInvalid({ message: `run ${given}: give its repository with --repo owner/name, or the run's URL` });
    return { repo, id: Number(given) };
  }
  return new UsageInvalid({ message: `${given}: not a run (a run's URL, https://github.com/<owner>/<name>/actions/runs/<id>, or its id with --repo)` });
};

const API = "https://api.github.com";

/** One invocation's reader of GitHub: the caller's token, and the requests it made (the report says how many). */
interface Gh {
  readonly token: string | undefined;
  requests: number;
}

const get = (path: string, gh: Gh, accept = "application/vnd.github+json") =>
  Effect.tryPromise({
    try: async (signal) => {
      gh.requests++;
      const response = await fetch(`${API}${path}`, {
        headers: { accept, "x-github-api-version": "2022-11-28", ...(gh.token ? { authorization: `Bearer ${gh.token}` } : {}) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      return { status: response.status, body: await response.text() };
    },
    catch: (error) => new ReportFailed({ message: `GitHub ${path}: ${error instanceof Error ? error.message : String(error)}` }),
  });

const getJson = <T>(path: string, gh: Gh) =>
  get(path, gh).pipe(
    Effect.flatMap(({ status, body }) =>
      status === 200
        ? Effect.succeed(JSON.parse(body) as T)
        : Effect.fail(
            new ReportFailed({
              message: `GitHub ${path}: ${status}${status === 404 || status === 401 ? (gh.token ? " (does the token read this repository's Actions?)" : " (set GH_TOKEN or GITHUB_TOKEN)") : ""}`,
            }),
          ),
    ),
  );

const jobsOf = (repo: string, id: number, attempt: number, gh: Gh) =>
  Effect.gen(function* () {
    const jobs: ApiJob[] = [];
    for (let page = 1; page <= 20; page++) {
      const body = yield* getJson<{ total_count: number; jobs: ApiJob[] }>(
        `/repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
        gh,
      );
      jobs.push(...body.jobs);
      if (body.jobs.length < 100 || jobs.length >= body.total_count) break;
    }
    return jobs;
  });

/** A file at a commit: from the checkout at [cwd] when its origin is [repo] and it has the commit, else GitHub's contents API; undefined when neither has it. */
const fileAt = (cwd: string, repo: string, sha: string, path: string, gh: Gh) =>
  Effect.gen(function* () {
    const local = yield* Git.show(cwd, repo, sha, path).pipe(Effect.catchTag("GitFailed", () => Effect.succeed(undefined)));
    if (local !== undefined) return { text: local, from: "this checkout" };
    const { status, body } = yield* get(`/repos/${repo}/contents/${path}?ref=${sha}`, gh, "application/vnd.github.raw");
    return status === 200 ? { text: body, from: "GitHub's contents API" } : undefined;
  });

/** The workflow file and its local reusable workflows at the run's commit, or why not. */
const filesOf = (
  cwd: string,
  repo: string,
  run: ApiRun,
  gh: Gh,
): Effect.Effect<{ readonly why: string } | { readonly files: WorkflowFiles; readonly from: string; readonly path: string }, ReportFailed> =>
  Effect.gen(function* () {
    const path = run.path?.replace(/@.*$/, "");
    if (!path || !path.startsWith(".github/workflows/")) return { why: `the run names no workflow file (${run.path ?? "no path"})` };
    const main = yield* fileAt(cwd, repo, run.head_sha, path, gh);
    if (!main) return { why: `${path} at ${run.head_sha.slice(0, 7)} is neither in this checkout nor readable through GitHub's contents API` };
    const parsed = parseWorkflow(path, main.text);
    if ("refusals" in parsed) return { why: `${path}: ${parsed.refusals.map((r) => r.what).join("; ")}` };
    const callees = new Map<string, Workflow>();
    for (const job of parsed.workflow.jobs.values()) {
      const uses = job.raw.uses;
      // A reusable workflow of the same repository is read at the same commit; another repository's stays unread.
      if (typeof uses !== "string" || !uses.startsWith("./") || callees.has(uses)) continue;
      const callee = yield* fileAt(cwd, repo, run.head_sha, uses.slice(2), gh);
      const calleeParsed = callee && parseWorkflow(uses.slice(2), callee.text);
      if (calleeParsed && "workflow" in calleeParsed) callees.set(uses, calleeParsed.workflow);
    }
    return { files: { workflow: parsed.workflow, callees } satisfies WorkflowFiles, from: main.from, path };
  });

/** A job's log (GitHub's job logs API), as text; undefined with why when GitHub has none to give. */
const logOf = (repo: string, job: number, gh: Gh) =>
  get(`/repos/${repo}/actions/jobs/${job}/logs`, gh, "application/vnd.github+json").pipe(
    Effect.map(({ status, body }): { readonly log: string } | { readonly why: string } =>
      status === 200 ? { log: body } : { why: `its log is not available (GitHub answered ${status})` },
    ),
  );

const getBytes = (path: string, gh: Gh) =>
  Effect.tryPromise({
    try: async (signal) => {
      gh.requests++;
      const response = await fetch(`${API}${path}`, {
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(gh.token ? { authorization: `Bearer ${gh.token}` } : {}) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
    },
    catch: (error) => new ReportFailed({ message: `GitHub ${path}: ${error instanceof Error ? error.message : String(error)}` }),
  });

const LOG_LINE_TIME = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z /;
const lineTime = (line: string) => {
  const m = LOG_LINE_TIME.exec(line);
  return m ? Date.parse(`${m[1]}${(m[2] ?? ".000").slice(0, 4).padEnd(4, "0")}Z`) : Number.NaN;
};

/**
 * GitHub's run logs archive, by job: its whole log (`<n>_<job>.txt`) and each step's start, the first
 * line of the step's own log (`<job>/<number>_<step>.txt`). The folder is the job's name with "/" as "_".
 */
export const runLogs = (files: ReadonlyMap<string, () => Uint8Array>) => {
  const jobs = new Map<string, { log?: string; starts: Map<number, number> }>();
  const of = (folder: string) => jobs.get(folder) ?? jobs.set(folder, { starts: new Map() }).get(folder)!;
  const decoder = new TextDecoder();
  for (const [name, read] of files) {
    const step = /^(.+)\/(\d+)_.*\.txt$/.exec(name);
    if (step) {
      const text = decoder.decode(read().subarray(0, 200));
      const t = lineTime(text);
      if (Number.isFinite(t)) of(step[1]!).starts.set(Number(step[2]), t);
      continue;
    }
    const whole = /^\d+_([^/]+)\.txt$/.exec(name);
    if (whole) of(whole[1]!).log = decoder.decode(read());
  }
  return jobs;
};
const folderOf = (job: string) => job.replaceAll("/", "_");

/** Each job's ledger, its load and its steps' starts: from the attempt's logs archive, else (no archive, a job not in it) the job's own log, its steps to the second. */
const ledgersOf = (repo: string, id: number, attempt: number, jobs: readonly { readonly id: number; readonly name: string }[], gh: Gh) =>
  Effect.gen(function* () {
    const archive = yield* getBytes(`/repos/${repo}/actions/runs/${id}/attempts/${attempt}/logs`, gh);
    const files = archive.status === 200 ? zipEntries(archive.bytes) : undefined;
    const logs = files ? runLogs(files) : new Map<string, { log?: string; starts: Map<number, number> }>();
    return yield* Effect.forEach(
      jobs,
      (job): Effect.Effect<{ readonly read: LedgerRead; readonly load: LoadRead; readonly starts?: StepStarts }, ReportFailed> => {
        const found = logs.get(folderOf(job.name));
        if (found?.log !== undefined) return Effect.succeed({ read: ledgerOf(found.log), load: loadOf(found.log), starts: found.starts });
        return logOf(repo, job.id, gh).pipe(
          Effect.map((got) => ("log" in got ? { read: ledgerOf(got.log), load: loadOf(got.log) } : { read: { absent: got.why }, load: { absent: got.why } })),
        );
      },
      { concurrency: 4 },
    );
  });

/** How many of the same workflow's successful runs on the default branch before this one are read (D8): the history of the cache verdict and of time added. */
const HISTORY_RUNS = 10;

/** The history: the same workflow's [HISTORY_RUNS] latest successful runs on the default branch created before [run], each with its jobs, read once. */
interface History {
  readonly branch: string;
  readonly runs: readonly { readonly run: ApiRun; readonly attempt: number; readonly jobs: readonly ApiJob[] }[];
}

const historyOf = (repo: string, run: ApiRun, gh: Gh): Effect.Effect<History | { readonly why: string }, ReportFailed> =>
  Effect.gen(function* () {
    if (run.workflow_id === undefined || !run.created_at) return { why: "the run names no workflow" };
    const { default_branch: branch } = yield* getJson<{ default_branch: string }>(`/repos/${repo}`, gh);
    const { workflow_runs: listed } = yield* getJson<{ workflow_runs: ApiRun[] }>(
      `/repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(branch)}&status=success&created=${encodeURIComponent(`<${run.created_at}`)}&per_page=${HISTORY_RUNS}`,
      gh,
    );
    const earlier = listed.filter((r) => r.id !== run.id).slice(0, HISTORY_RUNS);
    const runs = yield* Effect.forEach(
      earlier,
      (r) => jobsOf(repo, r.id, r.run_attempt ?? 1, gh).pipe(Effect.map((jobs) => ({ run: r, attempt: r.run_attempt ?? 1, jobs }))),
      { concurrency: 4 },
    );
    return { branch, runs };
  });

/** The same job (by name) in each history run, where it succeeded, newest first. */
const sameJob = (history: History, name: string) =>
  history.runs.flatMap(({ run, attempt, jobs }) => jobs.filter((j) => j.name === name && j.conclusion === "success").map((job) => ({ run, attempt, job })));

/**
 * One earlier run's samples, one per restore step (README.md "outrun report", cache): a step restoring
 * several keys (a setup action with caches of its own) is one cost, an exact hit when all its restores
 * were, a miss when all missed, else partial; its saves are the other steps holding a save of a key it
 * asked, each counted once. [spanSec]: the job's span.
 */
export const cacheSamples = (cache: JobCache, spanSec: number): ReadonlyMap<string, CacheSample> => {
  const byStep = new Map<string, { stepSec: number; restores: JobCache["restores"] }>();
  for (const restore of cache.restores) {
    if (restore.step === null || restore.stepSec === null) continue;
    const held = byStep.get(restore.step) ?? { stepSec: restore.stepSec, restores: [] };
    byStep.set(restore.step, { ...held, restores: [...held.restores, restore] });
  }
  const samples = new Map<string, CacheSample>();
  for (const [step, { stepSec, restores }] of byStep) {
    const keys = new Set(restores.map((x) => x.key));
    const saveSteps = new Map(
      cache.saves.filter((sv) => keys.has(sv.key) && sv.step !== null && sv.step !== step && sv.stepSec !== null).map((sv) => [sv.step!, sv.stepSec!]),
    );
    const saveSec = [...saveSteps.values()].reduce((a, b) => a + b, 0);
    const hit = restores.every((x) => x.hit === "exact") ? "exact" : restores.every((x) => x.hit === "miss") ? "miss" : "partial";
    samples.set(step, { hit, restoreSec: stepSec, saveSec, otherSec: spanSec - stepSec - saveSec });
  }
  return samples;
};

/** Each cache of this run (a job's restore step: [steps] by job name), over the same job in the history; only these runs' logs archives are read. */
const cacheHistoryOf = (repo: string, history: History, steps: ReadonlyMap<string, ReadonlySet<string>>, gh: Gh) =>
  Effect.gen(function* () {
    const names = [...steps.keys()];
    if (names.length === 0) return [];
    // By job name: each history run's job of that name, and its ledger (one logs archive per run).
    const found = new Map<string, { job: ApiJob; read: LedgerRead; starts?: StepStarts }[]>();
    yield* Effect.forEach(
      history.runs,
      ({ run: r, attempt, jobs }) =>
        Effect.gen(function* () {
          const wanted = jobs.filter((j) => j.name !== undefined && steps.has(j.name) && j.conclusion === "success");
          if (wanted.length === 0) return;
          const reads = yield* ledgersOf(
            repo,
            r.id,
            attempt,
            wanted.map((j) => ({ id: j.id, name: j.name! })),
            gh,
          );
          wanted.forEach((job, i) => found.set(job.name!, [...(found.get(job.name!) ?? []), { job, ...reads[i]! }]));
        }),
      { concurrency: 4, discard: true },
    );
    const { branch } = history;
    return names.flatMap((name) => {
      const read = found.get(name) ?? [];
      const samples = new Map<string, CacheSample[]>();
      for (const { job, read: r, starts } of read) {
        if (!("ledger" in r)) continue;
        const cache = jobCache(r.ledger, job.steps ?? [], undefined, starts);
        for (const [step, sample] of cacheSamples(cache, billedSpanSec(job))) samples.set(step, [...(samples.get(step) ?? []), sample]);
      }
      const withLedger = read.filter(({ read: r }) => "ledger" in r).length;
      return [...(steps.get(name) ?? [])].map((step) => ({
        job: name,
        step,
        branch,
        ...cacheVerdict(`${name}, "${step}"`, samples.get(step) ?? [], withLedger),
        runsWithoutLedger: read.length - withLedger,
      }));
    });
  });

/** The cache section: each job's restores and saves with their steps and flags, and each cache's verdict over its history. */
export const formatCache = (
  jobs: readonly { readonly name: string; readonly cache: JobCache | { readonly absent: string } }[],
  history: readonly (CacheVerdict & { readonly job: string; readonly step: string; readonly runsWithoutLedger: number })[] | undefined,
) => {
  const out = ["", "cache (each job's ledger, printed in its log by outrun's runners):"];
  const absent = new Map<string, string[]>();
  for (const { name, cache } of jobs) {
    if ("absent" in cache) {
      absent.set(cache.absent, [...(absent.get(cache.absent) ?? []), name]);
      continue;
    }
    if (cache.restores.length === 0 && cache.saves.length === 0) {
      out.push(`  ${name}: no restore, no save`);
      continue;
    }
    out.push(`  ${name}:`);
    const where = (e: { step: string | null; stepSec: number | null; steps?: readonly string[] }) =>
      e.step !== null ? `in "${e.step}" (${s(e.stepSec ?? 0)})` : e.steps ? `in one of ${e.steps.map((n) => `"${n}"`).join(", ")}` : "in no step";
    // ledger.ts's own size text, kB under 1 MB (13 kB printed "0.0 MB" on a real run, 2026-11-18); ledger.ts
    // keeps its copy until its next change (the agents import it, a change there is machine code).
    const mb = (bytes: number | null) =>
      bytes === null ? "size not measured" : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(1)} kB`;
    const transfer = (start: number, end: number | null) => (end === null ? "transfer time not measured" : `${((end - start) / 1000).toFixed(1)} s`);
    for (const r of cache.restores)
      out.push(
        `    restore ${r.key}: ${r.hit === "miss" ? "miss" : `${r.hit} hit${r.hit === "partial" ? ` on ${r.matched}` : ""}, ${mb(r.bytes)}${r.source ? ` from ${r.source === "local" ? "the machine's own copy" : r.source === "remote" ? "outrun's cache" : "GitHub's cache"}` : ""}`}, ${transfer(r.start, r.end)}, ${where(r)}`,
      );
    for (const v of cache.saves)
      out.push(`    save ${v.key}: ${v.outcome}${v.reason ? ` (${v.reason})` : ""}, ${mb(v.bytes)}, ${transfer(v.start, v.end)}, ${where(v)}`);
    for (const flag of cache.flags) out.push(`    ! ${flag}`);
    for (const note of cache.notMeasured) out.push(`    not measured: ${note}`);
  }
  for (const [why, names] of absent) out.push(`  ${names.join(", ")}: ${why}`);
  if (history !== undefined) {
    if (history.length > 0) out.push("", "does each cache pay? (the same job's recent successful runs on the default branch):");
    for (const h of history) out.push(`  ${h.pays === false ? "! " : ""}${h.sentence}${h.runsWithoutLedger > 0 ? `; ${h.runsWithoutLedger} without one` : ""}`);
  }
  return out;
};

const s = (seconds: number) => `${Math.round(seconds)} s`;
const clock = (iso: string) => iso.slice(11, 19);

const jobLine = (t: JobTime, width: number) =>
  `${t.name.padEnd(width)}  pickup ${s(t.pickupSec)}, setup ${s(t.setupSec)}, work ${s(t.workSec)}, post ${s(t.postSec)}${
    t.unclassifiedSec > 0 ? `, unclassified ${s(t.unclassifiedSec)}` : ""
  }${t.outsideStepsSec !== 0 ? `, outside steps ${s(t.outsideStepsSec)}` : ""} (${clock(t.startedAt)} to ${clock(t.completedAt)}, ${t.conclusion ?? "?"})`;

/** The report as text: wall clock, the chain, the jobs off it, the speed of light and the gap, then the lever. */
export const formatReport = (head: { repo: string; id: number; attempt: number; run: ApiRun; source: string }, t: Timeline) => {
  const out: string[] = [];
  const { run } = head;
  out.push(
    `${head.repo} run ${head.id}, attempt ${head.attempt}: ${run.path ?? run.name ?? "?"} on ${run.head_branch ?? "?"} at ${run.head_sha.slice(0, 7)} (${run.event ?? "?"}), ${run.conclusion ?? run.status ?? "?"}`,
    `workflow file: ${head.source}`,
  );
  out.push(
    t.wall
      ? `wall clock: ${s(t.wall.seconds)} (first job queued ${clock(t.wall.start)}, last step done ${clock(t.wall.end)})`
      : "wall clock: not measured (no job ran)",
  );
  const width = Math.max(0, ...t.jobs.map((j) => j.name.length));
  const byName = new Map(t.jobs.map((j) => [j.name, j]));
  if (t.chain) {
    out.push("", `critical path (${t.chain.length} job${t.chain.length === 1 ? "" : "s"}, the chain of needs that ends last):`);
    for (const link of t.chain) {
      const j = byName.get(link.name)!;
      out.push(`  ${jobLine(j, width)}${link.afterNeedSec > 0 ? `; queued ${s(link.afterNeedSec)} after its need ended` : ""}`);
    }
  }
  if (t.noChain) out.push("", `${t.chain ? "note" : "no critical path"}: ${t.noChain}`);
  const off = t.offChain ?? [];
  const onChain = new Set((t.chain ?? []).map((l) => l.name));
  const others = t.jobs.filter((j) => !onChain.has(j.name));
  if (others.length > 0) {
    out.push("", t.chain ? "off the path:" : "jobs:");
    for (const j of others) {
      const slack = off.find((o) => o.name === j.name);
      out.push(`  ${jobLine(j, width)}${slack ? `; slack ${s(slack.slackSec)}` : t.chain ? "; slack not measured" : ""}`);
    }
  }
  const unmatched = t.jobs.filter((j) => j.unmatched);
  if (unmatched.length > 0) {
    out.push("", "unclassified:");
    for (const j of unmatched) out.push(`  ${j.name}: ${j.unmatched}`);
  }
  if (t.notRun.length > 0) out.push("", `not run in this attempt: ${t.notRun.map((n) => `${n.name} (${n.why})`).join(", ")}`);
  out.push("");
  const sol = t.speedOfLight;
  if (sol)
    out.push(
      `speed of light (estimated): ${s(sol.seconds)} = ${s(sol.pickupSec)} pickup (the run's shortest, ${sol.pickupJob}) + ${s(sol.workSec)} work (the longest of one job, ${sol.workJob}) + ${s(sol.setupSec)} setup no cache removes (${sol.workJob}'s Set up job, Set up runner and checkout)`,
      `gap: ${s(sol.gapSec)} (wall clock ${s(t.wall?.seconds ?? 0)} − ${s(sol.seconds)})`,
    );
  else out.push(`speed of light: not measured: ${t.noSpeedOfLight ?? "unknown"}`);
  if (t.lever) out.push(`to shorten this run: ${t.lever.job} (${t.lever.step}, ${s(t.lever.seconds)})`);
  return out.join("\n");
};

const flags = {
  run: Argument.String("run").pipe(Argument.withDescription("the run: its URL, or its id with --repo")),
  repo: Flag.String("repo").pipe(Flag.withDescription("the run's repository, owner/name (with a run id)"), Flag.optional),
  attempt: Flag.Int("attempt").pipe(Flag.withDescription("the attempt to report (default: the URL's, else the run's latest)"), Flag.optional),
  json: Flag.Boolean("json").pipe(Flag.withDescription("print the report as JSON"), Flag.withDefault(false)),
};

const handler = (given: { readonly run: string; readonly repo: Option.Option<string>; readonly attempt: Option.Option<number>; readonly json: boolean }) =>
  Effect.gen(function* () {
    const target = runOf(given.run, Option.getOrUndefined(given.repo));
    if (target instanceof UsageInvalid) return yield* target;
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
    const gh: Gh = { token, requests: 0 };
    if (!token)
      yield* Console.error(
        "outrun report: neither GH_TOKEN nor GITHUB_TOKEN is set: reading GitHub without a token (public repositories, 60 requests an hour)",
      );
    const run = yield* getJson<ApiRun>(`/repos/${target.repo}/actions/runs/${target.id}`, gh);
    const attempt = Option.getOrUndefined(given.attempt) ?? target.attempt ?? run.run_attempt ?? 1;
    const jobs = yield* jobsOf(target.repo, target.id, attempt, gh);
    const found = yield* filesOf(process.cwd(), target.repo, run, gh);
    const report = timeline(jobs, "files" in found ? found.files : found);
    const source = "files" in found ? `${found.path} at ${run.head_sha.slice(0, 7)}, from ${found.from}` : `none: ${found.why}; per-job times only`;
    // Each job's cache ledger, from its own log (D4), then each cache's history on the default branch.
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const reads = yield* ledgersOf(target.repo, target.id, attempt, report.jobs, gh);
    const caches = report.jobs.map((t, i) => {
      const { read, starts } = reads[i]!;
      return {
        name: t.name,
        cache: "ledger" in read ? jobCache(read.ledger, byId.get(t.id)?.steps ?? [], t.unmatched ? undefined : t.workSec, starts) : read,
      };
    });
    // The caches to weigh: each job's restore steps (a restore in no single step is not weighed).
    const cached = new Map<string, Set<string>>();
    for (const { name, cache } of caches)
      if ("restores" in cache) for (const r of cache.restores) if (r.step !== null) cached.set(name, (cached.get(name) ?? new Set()).add(r.step));
    // The history (D8): the same workflow's successful runs on the default branch before this one, read once.
    const before = gh.requests;
    const history = yield* historyOf(target.repo, run, gh);
    const historyRequests = gh.requests - before;
    // Time added per job and its budget (D7), from the jobs' step times.
    const files = "files" in found ? found.files : undefined;
    const added =
      "why" in history
        ? undefined
        : report.jobs.map((t) =>
            jobAdded(
              byId.get(t.id)!,
              sameJob(history, t.name).map(({ job }) => job),
              timeoutOf(files, t.workflowJob),
            ),
          );
    const cacheHistory = "why" in history ? undefined : yield* cacheHistoryOf(target.repo, history, cached, gh);
    // Each job's load per step and what it flags (D6), from the same logs.
    const loads = report.jobs.map((t, i) => ({ name: t.name, load: reads[i]!.load }));
    yield* Console.log(
      given.json
        ? JSON.stringify(
            {
              repo: target.repo,
              run: target.id,
              attempt,
              workflow: run.path,
              sha: run.head_sha,
              workflowFile: source,
              ...report,
              history: "why" in history ? history : { branch: history.branch, runs: history.runs.map(({ run: r }) => r.id), requests: historyRequests },
              timeAdded: added,
              cache: caches,
              cacheHistory,
              contention: loads.map(({ name, load }) => ({ name, ...load, ...("load" in load ? contention(load.load) : {}) })),
              requests: gh.requests,
            },
            null,
            2,
          )
        : [
            formatReport({ repo: target.repo, id: target.id, attempt, run, source }, report),
            ...("why" in history
              ? ["", `time added: not measured: ${history.why}`]
              : formatAdded(
                  {
                    workflow: run.path?.replace(/^\.github\/workflows\//, "").replace(/@.*$/, "") ?? "?",
                    branch: history.branch,
                    runs: history.runs.length,
                    requests: historyRequests,
                  },
                  added!,
                )),
            ...formatCache(caches, cacheHistory),
            ...formatContention(loads),
            "",
            `GitHub: ${gh.requests} requests`,
          ].join("\n"),
    );
  });

export const reportCommand = Command.make("report", flags, handler).pipe(
  Command.withDescription(
    "where a GitHub Actions run's time went: its critical path, each job's pickup, setup, work and post, its speed of light, the time each job added against its history and its budget, each job's cache restores and saves, and the contention of its steps (GH_TOKEN or GITHUB_TOKEN)",
  ),
);
