import { spawnSync } from "node:child_process";
// `outrun run <workflow>`: a GitHub Actions workflow run on outrun's Linux VMs against this tree, its
// verdict and its logs in the terminal (outrun/README.md "outrun run"). The tree: HEAD with the
// working tree's changes, untracked files included (or exactly a commit, `--ref`), sent as a patch on
// the warm commit of the Minis, so GitHub never sees it. Each job runs as GitHub runs it (needs,
// strategy.matrix, if:, outputs, timeout-minutes, run: steps, actions/checkout of this repository),
// one VM per job and matrix combination, restored from the repository's warm golden (outrun check's
// machinery: check.ts); what outrun run v1 cannot run as GitHub does is refused before anything
// runs, naming the feature, the file and the line. `on:` is not read: a run is a `workflow_dispatch`
// of the workflow, its inputs from `-f name=value`.
//
// Exit 0: every job passed (or was skipped by its if:). 1: one failed (its log printed). 2: refused
// (the workflow uses what v1 does not run). 3: the fleet did not run it (unreachable, no warm
// checkout yet, no VM free, a worker lost): the caller decides what to do, never a local run here.
// Needs what `outrun check` needs: OUTRUN_API_TOKEN, OUTRUN_INSTALLATION (or --installation),
// OUTRUN_API, OUTRUN_GITHUB_TOKEN.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { CheckApi, checkApiLive, NotRun, Repo, repoLive, treeOf, waitFor } from "./check.ts";
import { condition, evaluate, interpolate, type Scope, truthy, type Value } from "./expr.ts";
import { basePrelude, compileJob } from "./job-script.ts";
import {
  cellName,
  type Combination,
  dispatchInputs,
  expandMatrix,
  type Job,
  parseWorkflow,
  type Refusal,
  refusalsOf,
  runsOnRefusal,
  selectJobs,
  type Workflow,
} from "./workflow.ts";

/** The workflow uses what outrun run v1 cannot run as GitHub does (exit 2); the lines are printed. */
class RunRefused extends Schema.TaggedError<RunRefused>()("RunRefused", { message: Schema.String }) {}
/** A job failed (exit 1); its log is printed already. */
class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", {}) {}

// The cells running at once, at most: a check's own bound (control-plane checks.ts MAX_WORKERS).
const MAX_CELLS = 8;
// Before a cell's VM is up and patched: the agent's own deadline for an apply (APPLY_MS) and a restore.
const READY_MS = 150_000;
// Over a job's timeout-minutes, what its result may take to come back.
const RESULT_SLACK_MS = 60_000;

export type Result = "success" | "failure" | "skipped";
interface StepLine {
  readonly name: string;
  readonly outcome: string;
  readonly conclusion: string;
  readonly ms: number;
}
export interface Ran {
  readonly result: "success" | "failure";
  readonly outputs: Readonly<Record<string, string>>;
  readonly steps: readonly StepLine[];
  readonly log: string;
  readonly ms: number;
  readonly where: string;
}
export interface Cell {
  readonly job: string;
  readonly name: string;
  readonly id: string;
  readonly script: string;
  readonly timeoutMs: number;
}
export type RunCell<R = never> = (cell: Cell) => Effect.Effect<Ran, NotRun, R>;

const refusalText = (path: string, refusals: readonly Refusal[]) => [...new Set(refusals.map((r) => `${path}:${r.line}: ${r.what}`))].join("\n");

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export interface Context {
  readonly repository: string;
  readonly ref: string;
  readonly inputs: Readonly<Record<string, Value>>;
}

// What GitHub gives every job (contexts github and runner, the env of every step), for a dispatch.
const githubOf = (workflow: Workflow, job: Job, context: Context) => ({
  repository: context.repository,
  repository_owner: context.repository.split("/")[0]!,
  event_name: "workflow_dispatch",
  ref: context.ref,
  ref_name: context.ref.replace(/^refs\/(heads|tags)\//, ""),
  event: { inputs: context.inputs, ref: context.ref, workflow: workflow.path },
  workflow: workflow.name,
  job: job.id,
  server_url: "https://github.com",
  api_url: "https://api.github.com",
});
const envOf = (github: ReturnType<typeof githubOf>) => ({
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: github.repository,
  GITHUB_REPOSITORY_OWNER: github.repository_owner,
  GITHUB_EVENT_NAME: github.event_name,
  GITHUB_REF: github.ref,
  GITHUB_REF_NAME: github.ref_name,
  GITHUB_REF_TYPE: github.ref.startsWith("refs/tags/") ? "tag" : "branch",
  GITHUB_WORKFLOW: github.workflow,
  GITHUB_JOB: github.job,
  GITHUB_SERVER_URL: github.server_url,
  GITHUB_API_URL: github.api_url,
  RUNNER_OS: "Linux",
  RUNNER_ARCH: "ARM64",
});

// A value of the workflow with its expressions evaluated (a matrix, runs-on), recursively; a string
// that is one whole expression keeps its type (fromJSON's array).
const resolveValue = (value: unknown, scope: Scope): Value => {
  if (typeof value === "string") return value.includes("${{") ? interpolate(value, scope) : value;
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, scope)]));
  return (value ?? null) as Value;
};

/**
 * The selected jobs in their needs' order, each cell through `runCell` (at most MAX_CELLS at once),
 * each cell's line (and a failed one's log) through `print`. Fails RunRefused when a job's runs-on or
 * matrix, known only once its needs ran, is outside v1; NotRun when the fleet did not run a cell.
 */
export const runWorkflow = <R>(workflow: Workflow, jobs: readonly Job[], context: Context, runCell: RunCell<R>, print: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const done = new Map(
      yield* Effect.forEach(jobs, (job) => Deferred.make<{ result: Result; outputs: Record<string, string> }>().pipe(Effect.map((d) => [job.id, d] as const))),
    );
    const permits = yield* Semaphore.make(MAX_CELLS);
    const results = new Map<string, Result>();
    const runJob = (job: Job) =>
      Effect.gen(function* () {
        const needs: Record<string, { result: Result; outputs: Record<string, string> }> = {};
        for (const need of job.needs) needs[need] = yield* Deferred.await(done.get(need)!);
        const github = githubOf(workflow, job, context);
        const base: Scope = {
          contexts: { github, inputs: context.inputs, needs, runner: { os: "Linux", arch: "ARM64" } },
          status: Object.values(needs).some((n) => n.result === "failure")
            ? "failure"
            : Object.values(needs).every((n) => n.result === "success")
              ? "success"
              : "skipped",
        };
        const refuse = (what: string) => new RunRefused({ message: refusalText(workflow.path, [{ line: job.line, what: `job ${job.id}: ${what}` }]) });
        if (!truthy(evaluate(condition(job.raw.if as string | undefined), base))) {
          yield* print(`- ${job.id}: skipped`);
          return { result: "skipped" as const, outputs: {} };
        }
        const strategy = (job.raw.strategy ?? {}) as Record<string, unknown>;
        let combos: (Combination | null)[] = [null];
        if (strategy.matrix !== undefined) {
          const expanded = expandMatrix(resolveValue(strategy.matrix, base));
          if (typeof expanded === "string") return yield* refuse(expanded);
          if (expanded.length === 0) return yield* refuse("its matrix has no combination");
          if (expanded.length > 256) return yield* refuse(`its matrix has ${expanded.length} combinations (GitHub's limit: 256)`);
          combos = expanded;
        }
        const failFast = strategy["fail-fast"] === undefined ? true : truthy(resolveValue(strategy["fail-fast"], base));
        const maxParallel = strategy["max-parallel"] === undefined ? combos.length : Number(resolveValue(strategy["max-parallel"], base)) || combos.length;
        let failed = false;
        const ran = yield* Effect.forEach(
          combos.map((combo, index) => ({ combo, index })),
          ({ combo, index }) =>
            Effect.gen(function* () {
              const scope: Scope = {
                ...base,
                contexts: {
                  ...base.contexts,
                  matrix: combo ?? {},
                  strategy: { "fail-fast": failFast, "job-index": index, "job-total": combos.length, "max-parallel": maxParallel },
                },
              };
              const name = cellName(job, combo, scope);
              if (failed && failFast) {
                yield* print(`- ${name}: cancelled (fail-fast)`);
                return { result: "failure" as const, outputs: {} };
              }
              const refused = runsOnRefusal(resolveValue(job.raw["runs-on"], scope));
              if (refused) return yield* refuse(refused);
              const compiled = compileJob(workflow, job, scope, envOf(github));
              const result = yield* permits.withPermits(1)(runCell({ job: job.id, name, id: `${workflow.path}:${name}`, ...compiled }));
              const continueOnError = job.raw["continue-on-error"] !== undefined && truthy(resolveValue(job.raw["continue-on-error"], scope));
              const ok = result.result === "success" || continueOnError;
              const steps = result.steps.map(
                (step) =>
                  `${step.conclusion === "success" ? " " : step.conclusion === "skipped" ? "-" : "✗"} ${step.name} ${step.conclusion === "skipped" ? "skipped" : s(step.ms)}`,
              );
              yield* print(
                [`${result.result === "success" ? "✓" : "✗"} ${name} · ${s(result.ms)} on ${result.where}`, ...steps.map((l) => `    ${l}`)].join("\n"),
              );
              if (result.log.trim()) yield* print(`--- ${name} ---\n${result.log.trimEnd()}\n---`);
              if (!ok) failed = true;
              return { result: ok ? ("success" as const) : ("failure" as const), outputs: result.outputs };
            }),
          { concurrency: maxParallel },
        );
        // A matrix job's outputs: each cell's, the last one's winning, as GitHub's.
        const outputs = Object.assign({}, ...ran.map((r) => r.outputs)) as Record<string, string>;
        return { result: ran.some((r) => r.result === "failure") ? ("failure" as const) : ("success" as const), outputs };
      }).pipe(
        Effect.tap((outcome) => Effect.sync(() => results.set(job.id, outcome.result))),
        Effect.tap((outcome) => Deferred.succeed(done.get(job.id)!, outcome)),
      );
    yield* Effect.forEach(jobs, runJob, { concurrency: "unbounded", discard: true });
    return results;
  });

// A cell on the fleet: one check of one worker (outrun check's create, patch, shard), its script as
// the shard; `patchOf` HEAD's tree on a warm commit, once per commit for the whole run.
const fleetCell =
  (
    repo: string,
    patchOf: (sha: string) => Effect.Effect<string, NotRun>,
    message: (sha: string) => Effect.Effect<string, NotRun>,
    base: { sha: string; change: string } | undefined,
    // The base's commit object, which the cell's checkout gets back (job-script.ts basePrelude).
    baseCommit: string | undefined,
  ): RunCell<CheckApi> =>
  (cell) =>
    Effect.gen(function* () {
      const api = yield* CheckApi;
      const t0 = Date.now();
      // No VM free now: the run's other cells hold some, so this one waits its turn, within READY_MS.
      const check = yield* api
        .create(repo, 1, true)
        .pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), while: (e) => / 409 full\b/.test(e.message) && Date.now() - t0 < READY_MS }));
      return yield* Effect.gen(function* () {
        const worker = check.workers[0];
        if (!worker) return yield* new NotRun({ message: `${cell.name}: the fleet gave no VM` });
        const sha = worker.sha ?? check.sha;
        yield* api.patch(check.id, check.sha, { [sha]: yield* patchOf(sha) }, yield* message(base?.sha ?? sha), base?.change);
        const ready = yield* waitFor(check.id, 0, (events) => events.some((e) => e.step === "apply"), t0 + READY_MS, t0);
        const broken = ready.events.find((e) => e.code !== 0);
        if (broken) return yield* new NotRun({ message: `${cell.name}: ${broken.worker} ${broken.step}: exit ${broken.code}: ${broken.log.slice(-500)}` });
        yield* api.shards(check.id, [
          {
            worker: 0,
            tasks: [cell.id],
            script: base && baseCommit ? basePrelude(base.sha, baseCommit) + cell.script : cell.script,
            timeoutMs: cell.timeoutMs,
          },
        ]);
        const sent = Date.now();
        const ran = yield* waitFor(check.id, ready.after, (events) => events.some((e) => e.step === "shard"), sent + cell.timeoutMs + RESULT_SLACK_MS, sent);
        const shard = ran.events.find((e) => e.step === "shard")!;
        const job = (shard.json.job ?? null) as { outputs?: Record<string, unknown>; steps?: StepLine[] } | null;
        // A shard that ran no job script (an agent before `outrun run`) is not a verdict.
        if (!job && shard.code === 0) return yield* new NotRun({ message: `${cell.name}: ${worker.mini}'s agent reported no job: it predates outrun run` });
        return {
          result: shard.code === 0 ? ("success" as const) : ("failure" as const),
          outputs: Object.fromEntries(Object.entries(job?.outputs ?? {}).map(([k, v]) => [k, String(v)])),
          steps: Array.isArray(job?.steps) ? job.steps : [],
          log: shard.log,
          ms: Date.now() - t0,
          where: `${worker.mini}, main at ${sha.slice(0, 8)}`,
        };
      }).pipe(Effect.ensuring(api.end(check.id)));
    });

// The workflow file: a path, or a name in the repository's .github/workflows.
const locate = (name: string) => {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim() || process.cwd();
  const candidates = [
    resolve(name),
    resolve(top, ".github/workflows", name),
    resolve(top, ".github/workflows", `${name}.yml`),
    resolve(top, ".github/workflows", `${name}.yaml`),
  ];
  const file = candidates.find((path) => existsSync(path));
  return file ? { file, shown: relative(top, file) } : null;
};

const flags = {
  workflow: Argument.String("workflow").pipe(Argument.withDescription("the workflow file: a path, or its name in .github/workflows")),
  job: Flag.String("job").pipe(Flag.withDescription("run only this job and what it needs (repeatable)"), Flag.atLeast(0)),
  field: Flag.String("field").pipe(Flag.withAlias("f"), Flag.withDescription("a workflow_dispatch input, name=value (repeatable)"), Flag.atLeast(0)),
  ref: Flag.String("ref").pipe(Flag.withDescription("run exactly this commit's tree (default: HEAD with the working tree's changes)"), Flag.withDefault("")),
  installation: Flag.String("installation").pipe(
    Flag.withDescription("the installation id the token belongs to (default: OUTRUN_INSTALLATION)"),
    Flag.withDefault(""),
  ),
};

/** The workflow parsed, its jobs selected and checked, its inputs read: what runs, or the refusal. */
export const prepare = (path: string, text: string, named: readonly string[], fields: readonly string[], repository: string) =>
  Effect.gen(function* () {
    const parsed = parseWorkflow(path, text);
    if ("refusals" in parsed) return yield* new RunRefused({ message: refusalText(path, parsed.refusals) });
    const selected = selectJobs(parsed.workflow, named);
    if ("refusals" in selected) return yield* new RunRefused({ message: refusalText(path, selected.refusals) });
    const refusals = refusalsOf(parsed.workflow, selected.jobs, repository);
    const given: Record<string, string> = {};
    for (const field of fields) {
      const at = field.indexOf("=");
      if (at <= 0) refusals.push({ line: 1, what: `-f ${field}: name=value` });
      else given[field.slice(0, at)] = field.slice(at + 1);
    }
    const inputs = dispatchInputs(parsed.workflow, given);
    if ("refusals" in inputs) refusals.push(...inputs.refusals);
    if (refusals.length > 0 || "refusals" in inputs) return yield* new RunRefused({ message: refusalText(path, refusals) });
    return { workflow: parsed.workflow, jobs: selected.jobs, inputs: inputs.inputs };
  });

const handler = ({
  workflow: name,
  job,
  field,
  ref,
  installation,
}: {
  readonly workflow: string;
  readonly job: readonly string[];
  readonly field: readonly string[];
  readonly ref: string;
  readonly installation: string;
}) =>
  Effect.gen(function* () {
    const t0 = Date.now();
    const found = locate(name);
    if (!found) return yield* new RunRefused({ message: `${name}: no such workflow file (a path, or a name in .github/workflows)` });
    // The repository's name first: a refusal names its own repository's checkout as allowed.
    const origin = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
    const repository = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)?.[1] ?? "";
    const { workflow, jobs, inputs } = yield* prepare(found.shown, readFileSync(found.file, "utf8"), job, field, repository);
    if (!repository) return yield* new NotRun({ message: `origin is not a GitHub repository: ${origin}` });
    const token = process.env.OUTRUN_API_TOKEN;
    if (!token) return yield* new NotRun({ message: "OUTRUN_API_TOKEN is not set (an installation's API token)" });
    const id = installation || process.env.OUTRUN_INSTALLATION || "";
    if (!/^\d+$/.test(id))
      return yield* new NotRun({ message: "no installation: set OUTRUN_INSTALLATION or pass --installation (its GitHub App installation id)" });
    const api = process.env.OUTRUN_API ?? "https://api.outrun.sh";
    const githubToken = process.env.OUTRUN_GITHUB_TOKEN || undefined;
    if (!githubToken) yield* Console.error("outrun run: OUTRUN_GITHUB_TOKEN is not set: the warm checkouts stay at the commit the Minis' mirrors have");
    const tree = yield* treeOf(ref || undefined);
    const branch = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { encoding: "utf8" }).stdout.trim() || "refs/heads/main";
    return yield* Effect.gen(function* () {
      const repo = yield* Repo;
      const patches = new Map<string, string>();
      const patchOf = (sha: string) =>
        patches.has(sha) ? Effect.succeed(patches.get(sha)!) : repo.patchFrom(sha).pipe(Effect.tap((patch) => Effect.sync(() => patches.set(sha, patch))));
      const base = yield* repo.base;
      const baseCommit = base ? spawnSync("git", ["cat-file", "commit", base.sha], { encoding: "utf8" }) : undefined;
      yield* Console.log(`outrun run: ${found.shown}: ${jobs.length} job(s) on ${repository}, the tree ${ref ? `of ${ref}` : "of HEAD with its changes"}`);
      const results = yield* runWorkflow(
        workflow,
        jobs,
        { repository, ref: branch, inputs },
        fleetCell(repository, patchOf, repo.messageFrom, base, baseCommit?.status === 0 ? baseCommit.stdout : undefined),
        (line) => Console.log(line),
      );
      const failed = [...results].filter(([, r]) => r === "failure").map(([j]) => j);
      if (failed.length > 0) {
        yield* Console.error(`outrun run: ${found.shown}: FAILED (${failed.join(", ")}) · ${s(Date.now() - t0)}`);
        return yield* new RunFailed();
      }
      yield* Console.log(`outrun run: ${found.shown}: passed · ${s(Date.now() - t0)}`);
    }).pipe(Effect.provide(Layer.merge(checkApiLive(api, id, token, githubToken), repoLive(tree))));
  });

export const runCommand = Command.make("run", flags, handler).pipe(
  Command.withDescription("a GitHub Actions workflow on outrun's Linux VMs against this tree (exit 0 passed, 1 failed, 2 refused, 3 not run)"),
);
