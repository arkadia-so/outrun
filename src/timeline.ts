// Where a run's time goes (`outrun report`, README.md "outrun report"): from a run's jobs as GitHub's
// jobs API gives them and the workflow file that ran, each job's pickup, setup, work and post, the
// chain of `needs:` that ends last (the critical path), the slack of the jobs off it, the run's speed
// of light and the job a lever must touch to shorten the run. Pure: no network, no file.
//
// Also the run figures every report of outrun shares (pickup, carried jobs, a job's step span, the wall
// clock): the case study (private) imports them from here, one implementation.
import type { Job, Workflow } from "./workflow.ts";

/** A step as GitHub's jobs API gives it. */
export interface ApiStep {
  readonly name: string;
  readonly number?: number;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

/** A job as GitHub's jobs API gives it (`/actions/runs/{id}/attempts/{n}/jobs`). */
export interface ApiJob {
  readonly id: number;
  readonly run_id: number;
  readonly run_attempt?: number;
  readonly labels: readonly string[];
  readonly status?: string | null;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly runner_name?: string | null;
  readonly name?: string;
  readonly steps?: readonly ApiStep[];
}

// The run figures below marked @public are read by the case study too (outrun/cli/case-study, private).

/**
 * An ISO time as epoch ms; NaN when absent.
 * @public
 */
export const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * A job copied into a later attempt without running again: its run predates the attempt (GitHub keeps the earlier pass).
 * @public
 */
export const isCarried = (job: ApiJob) => ms(job.started_at) < ms(job.created_at) - 1000;

/**
 * Jobs that held a runner in this attempt: billed and timed.
 * @public
 */
export const ranJobs = (jobs: readonly ApiJob[]) =>
  jobs.filter((job) => job.runner_name && Number.isFinite(ms(job.started_at)) && ms(job.completed_at) >= ms(job.started_at) && !isCarried(job));

/**
 * A job's run time as GitHub meters and bills it: started to completed, seconds.
 * @public
 */
export const billedSpanSec = (job: ApiJob) => (ms(job.completed_at) - ms(job.started_at)) / 1000;

/**
 * A job's VM time read from its steps (first step started to last step done), seconds; GitHub's own times when it has no step.
 * @public
 */
export const stepSpanSec = (job: ApiJob) => {
  const starts = (job.steps ?? []).map((s) => ms(s.started_at)).filter(Number.isFinite);
  const ends = (job.steps ?? []).map((s) => ms(s.completed_at)).filter(Number.isFinite);
  return starts.length && ends.length ? (Math.max(...ends) - Math.min(...starts)) / 1000 : billedSpanSec(job);
};

/** When a job's last step was done (epoch ms); its completed_at when it has no step. */
const stepEnd = (job: ApiJob) => {
  const ends = (job.steps ?? []).map((s) => ms(s.completed_at)).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : ms(job.completed_at);
};

/**
 * A run's wall clock (epoch ms): its first job queued ([jobs], every job of the attempt, skipped ones
 * included) to the last step done of a job that ran. Undefined when no job ran.
 * @public
 */
export const wallClock = (jobs: readonly ApiJob[]): { readonly start: number; readonly end: number } | undefined => {
  const ran = ranJobs(jobs);
  if (ran.length === 0) return undefined;
  return { start: Math.min(...jobs.map((job) => ms(job.created_at))), end: Math.max(...ran.map(stepEnd)) };
};

/** Where a step's time counts. */
type Phase = "setup" | "work" | "post" | "unclassified";

interface StepTime {
  readonly name: string;
  readonly phase: Phase;
  /** completed_at − started_at, seconds (0 for a step GitHub gives no time). */
  readonly seconds: number;
  /** Why this phase: the rule that classified it. */
  readonly rule: string;
}

export interface JobTime {
  readonly id: number;
  readonly name: string;
  /** The workflow's job it runs (`id`, or `caller/callee` for a reusable workflow's), when the name matched one. */
  readonly workflowJob?: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly completedAt: string;
  /** created_at → started_at, seconds: the wait for a runner. */
  readonly pickupSec: number;
  /** started_at → completed_at, seconds. */
  readonly spanSec: number;
  readonly setupSec: number;
  readonly workSec: number;
  readonly postSec: number;
  readonly unclassifiedSec: number;
  /** spanSec minus every step's seconds: the job's time outside any step GitHub lists (before the first, between, after the last). */
  readonly outsideStepsSec: number;
  readonly steps: readonly StepTime[];
  /** Why its steps are unclassified (the workflow's steps and GitHub's did not match), or why it maps to no workflow job. */
  readonly unmatched?: string;
}

interface ChainLink {
  readonly name: string;
  /** created_at minus the end of the need it waited for (the run's first job queued, for the first link), seconds. */
  readonly afterNeedSec: number;
}

interface OffChain {
  readonly name: string;
  /** How much later it could have ended before delaying a job that needs it or the run's end, seconds (measured durations kept). */
  readonly slackSec: number;
}

interface SpeedOfLight {
  /** Always an estimate: a floor computed from this run's own figures. */
  readonly estimated: true;
  /** The run's shortest pickup, seconds, and the job it was measured on. */
  readonly pickupSec: number;
  readonly pickupJob: string;
  /** The longest work of one job (its work steps), seconds: the longest unit that must run. */
  readonly workSec: number;
  readonly workJob: string;
  /** That job's setup no cache removes: its Set up job, Set up runner and checkout steps, seconds. */
  readonly setupSec: number;
  readonly seconds: number;
  /** The wall clock minus the speed of light, seconds. */
  readonly gapSec: number;
}

interface Lever {
  readonly job: string;
  /** Its largest item: a step's name, or "pickup". */
  readonly step: string;
  readonly seconds: number;
}

export interface Timeline {
  readonly wall?: { readonly start: string; readonly end: string; readonly seconds: number };
  /** The jobs that ran in this attempt, in the API's order. */
  readonly jobs: readonly JobTime[];
  /** Jobs of the attempt that did not run here: skipped, never picked up, or carried from an earlier attempt. */
  readonly notRun: readonly { readonly name: string; readonly why: string }[];
  /** The critical path, first job first; absent with the reason in [noChain]. */
  readonly chain?: readonly ChainLink[];
  readonly noChain?: string;
  readonly offChain?: readonly OffChain[];
  readonly speedOfLight?: SpeedOfLight;
  readonly noSpeedOfLight?: string;
  readonly lever?: Lever;
}

/** The workflow file a run ran, and the reusable workflows its jobs call (`uses:` as written → the file parsed); a missing callee: its jobs' steps are unclassified. */
export interface WorkflowFiles {
  readonly workflow: Workflow;
  readonly callees: ReadonlyMap<string, Workflow>;
}

type Raw = { readonly [key: string]: unknown };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name as a pattern: an expression stands for any text.
const namePattern = (name: string) =>
  name
    .split(/\$\{\{[\s\S]*?\}\}/)
    .map(escape)
    .join(".*");
const MATRIX_SUFFIX = "(?: \\(.*\\))?";
const displayName = (job: Job) => namePattern(typeof job.raw.name === "string" ? job.raw.name : job.id) + (job.raw.strategy ? MATRIX_SUFFIX : "");

/** One job GitHub can show: a workflow job, or a job of a reusable workflow under its caller. */
interface Node {
  readonly key: string;
  readonly pattern: RegExp;
  /** Whether the pattern holds no expression: a literal match wins over a pattern's. */
  readonly literal: boolean;
  /** Its steps, or null when its file was not read (a callee outside the repository). */
  readonly steps: readonly { readonly raw: Raw }[] | null;
  /** The keys it needs: a node's key, or a caller's id (each of its callee jobs). */
  readonly needs: readonly string[];
}

const nodesOf = (files: WorkflowFiles): Node[] =>
  [...files.workflow.jobs.values()].flatMap((job): Node[] => {
    const uses = job.raw.uses;
    if (typeof uses !== "string")
      return [{ key: job.id, pattern: new RegExp(`^${displayName(job)}$`), literal: !/\.\*/.test(displayName(job)), steps: job.steps, needs: job.needs }];
    const callee = files.callees.get(uses);
    const prefix = `${displayName(job)} / `;
    if (!callee) return [{ key: `${job.id}/?`, pattern: new RegExp(`^${prefix}.*$`), literal: false, steps: null, needs: job.needs }];
    return [...callee.jobs.values()].map((inner) => ({
      key: `${job.id}/${inner.id}`,
      pattern: new RegExp(`^${prefix}${displayName(inner)}$`),
      literal: !/\.\*/.test(prefix + displayName(inner)),
      steps: inner.steps,
      needs: inner.needs.length > 0 ? inner.needs.map((n) => `${job.id}/${n}`) : job.needs,
    }));
  });

/** The workflow job an API job runs, or why none: no name matches, or several do. */
const mapJob = (nodes: readonly Node[], name: string): Node | string => {
  const matches = nodes.filter((node) => node.pattern.test(name));
  const literal = matches.filter((node) => node.literal);
  const pick = literal.length === 1 ? literal : matches;
  if (pick.length === 1) return pick[0]!;
  return pick.length === 0
    ? "its name matches no job of the workflow file"
    : `its name matches several jobs of the workflow file (${pick.map((n) => n.key).join(", ")})`;
};

/** A workflow step's phase, from what it is: an action's `uses:` or a `run:`. */
const yamlPhase = (raw: Raw): { phase: Phase; rule: string } => {
  if (typeof raw.uses !== "string") return { phase: "work", rule: "run:" };
  const action = raw.uses.replace(/@.*$/, "").toLowerCase();
  const last = action.split("/").pop() ?? "";
  if (/(^|\/)cache\/save$/.test(action)) return { phase: "post", rule: "cache save" };
  if (last === "checkout") return { phase: "setup", rule: "checkout" };
  if (/(^|\/)cache(\/restore)?$/.test(action)) return { phase: "setup", rule: "cache restore" };
  if (last.includes("setup")) return { phase: "setup", rule: "setup action" };
  return { phase: "work", rule: "action" };
};

/** The name GitHub shows for a workflow step, as a pattern: its `name:`, else `Run <uses>` or `Run <first line of run>`. */
const yamlStepName = (raw: Raw): RegExp | null => {
  if (typeof raw.name === "string") return new RegExp(`^${namePattern(raw.name.trim())}$`);
  if (typeof raw.uses === "string") return new RegExp(`^Run ${namePattern(raw.uses.trim())}$`);
  if (typeof raw.run === "string") {
    const first = raw.run.split("\n").find((line) => line.trim() !== "");
    return first === undefined ? null : new RegExp(`^Run ${namePattern(first.trim())}`);
  }
  return null;
};

const seconds = (step: ApiStep) => {
  const s = (ms(step.completed_at) - ms(step.started_at)) / 1000;
  return Number.isFinite(s) ? s : 0;
};
// The runner's own steps, before and after the workflow's: GitHub's, and the runner hooks' (job started, job completed).
const LEADING = (name: string) => name === "Set up job" || name === "Set up runner" || name.startsWith("Pre ");
const TRAILING = (name: string) => name === "Complete job" || name === "Complete runner" || name.startsWith("Post ");
// The setup no cache removes: the runner starting the job and the tree being fetched.
const UNCACHEABLE = new Set(["Set up job", "Set up runner", "checkout"]);

/** Each API step's phase, by matching GitHub's steps to the workflow's in order; a mismatch leaves the workflow's steps unclassified, never guessed. */
const classify = (api: readonly ApiStep[], yaml: readonly { readonly raw: Raw }[] | null): { steps: StepTime[]; unmatched?: string } => {
  const sorted = [...api].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  let lead = 0;
  while (lead < sorted.length && LEADING(sorted[lead]!.name)) lead++;
  let tail = sorted.length;
  while (tail > lead && TRAILING(sorted[tail - 1]!.name)) tail--;
  const runner = (step: ApiStep, phase: Phase): StepTime => ({
    name: step.name,
    phase,
    seconds: seconds(step),
    rule: step.name.startsWith("Pre ") ? "pre step" : step.name.startsWith("Post ") ? "post step" : step.name,
  });
  const middle = sorted.slice(lead, tail);
  const unclassified = (why: string) => ({
    steps: [
      ...sorted.slice(0, lead).map((s) => runner(s, "setup")),
      ...middle.map((s): StepTime => ({ name: s.name, phase: "unclassified", seconds: seconds(s), rule: "unmatched" })),
      ...sorted.slice(tail).map((s) => runner(s, "post")),
    ],
    unmatched: why,
  });
  if (yaml === null) return unclassified("its workflow file was not read (a reusable workflow outside the repository)");
  if (middle.length !== yaml.length)
    return unclassified(`GitHub lists ${middle.length} steps between its setup and post steps, the workflow has ${yaml.length}`);
  const steps: StepTime[] = [];
  for (const [i, step] of middle.entries()) {
    const expected = yamlStepName(yaml[i]!.raw);
    if (!expected || !expected.test(step.name)) return unclassified(`step ${i + 1}: GitHub's "${step.name}" is not the workflow's step ${i + 1}`);
    const { phase, rule } = yamlPhase(yaml[i]!.raw);
    steps.push({ name: step.name, phase, seconds: seconds(step), rule });
  }
  return { steps: [...sorted.slice(0, lead).map((s) => runner(s, "setup")), ...steps, ...sorted.slice(tail).map((s) => runner(s, "post"))] };
};

const sum = (steps: readonly StepTime[], phase: Phase) => steps.filter((s) => s.phase === phase).reduce((acc, s) => acc + s.seconds, 0);
const nameOf = (job: ApiJob) => job.name ?? String(job.id);

const jobTime = (job: ApiJob, node: Node | string | undefined): JobTime => {
  // Without a workflow job, the workflow's steps are unknown: the steps between the runner's own are unclassified.
  const { steps: shown, unmatched } = classify(job.steps ?? [], typeof node === "object" ? node.steps : null);
  const why = typeof node === "string" ? node : node === undefined ? "no workflow file" : unmatched;
  const spanSec = billedSpanSec(job);
  return {
    id: job.id,
    name: nameOf(job),
    ...(typeof node === "object" ? { workflowJob: node.key } : {}),
    conclusion: job.conclusion,
    createdAt: job.created_at,
    startedAt: job.started_at!,
    completedAt: job.completed_at!,
    pickupSec: (ms(job.started_at) - ms(job.created_at)) / 1000,
    spanSec,
    setupSec: sum(shown, "setup"),
    workSec: sum(shown, "work"),
    postSec: sum(shown, "post"),
    unclassifiedSec: sum(shown, "unclassified"),
    outsideStepsSec: spanSec - shown.reduce((acc, s) => acc + s.seconds, 0),
    steps: shown,
    ...(why ? { unmatched: why } : {}),
  };
};

const notRunWhy = (job: ApiJob) =>
  isCarried(job)
    ? "carried from an earlier attempt"
    : job.conclusion === "skipped"
      ? "skipped"
      : !job.runner_name
        ? `never got a runner (${job.conclusion ?? job.status ?? "unknown"})`
        : `not finished (${job.status ?? "unknown"})`;

/**
 * Where the time of one attempt of a run went. [jobs]: every job of the attempt, as the jobs API
 * gives them. [files]: the workflow file at the run's head commit and its reusable workflows; without
 * it, per-job times only, and no chain is claimed ([why] says why the file is missing).
 */
export const timeline = (jobs: readonly ApiJob[], files: WorkflowFiles | { readonly why: string }): Timeline => {
  const ran = ranJobs(jobs);
  const ranIds = new Set(ran.map((job) => job.id));
  const notRun = jobs.filter((job) => !ranIds.has(job.id)).map((job) => ({ name: nameOf(job), why: notRunWhy(job) }));
  const wall = wallClock(jobs);
  const wallOut = wall && { start: new Date(wall.start).toISOString(), end: new Date(wall.end).toISOString(), seconds: (wall.end - wall.start) / 1000 };
  if ("why" in files) {
    const times = ran.map((job) => jobTime(job, undefined));
    return { ...(wallOut ? { wall: wallOut } : {}), jobs: times, notRun, noChain: files.why, noSpeedOfLight: files.why };
  }
  const nodes = nodesOf(files);
  const mapped = new Map<number, Node | string>(jobs.map((job) => [job.id, mapJob(nodes, nameOf(job))]));
  const times = ran.map((job) => jobTime(job, mapped.get(job.id)));
  const byId = new Map(times.map((t) => [t.id, t]));
  const out: { -readonly [K in keyof Timeline]: Timeline[K] } = { ...(wallOut ? { wall: wallOut } : {}), jobs: times, notRun };
  if (ran.length === 0) return { ...out, noChain: "no job ran in this attempt", noSpeedOfLight: "no job ran in this attempt" };

  // The jobs of the attempt a node's needs name (a caller's id: each of its callee jobs).
  const needed = (job: ApiJob): ApiJob[] => {
    const node = mapped.get(job.id);
    if (typeof node !== "object") return [];
    return jobs.filter((other) => {
      const o = mapped.get(other.id);
      return typeof o === "object" && node.needs.some((need) => o.key === need || o.key.startsWith(`${need}/`));
    });
  };
  const end = (job: ApiJob) => ms(job.completed_at);
  const lastOf = (list: readonly ApiJob[]) => list.reduce((best, job) => (end(job) > end(best) ? job : best));

  // The chain: the job ending last, then back through its need that completed last.
  const last = lastOf(ran);
  const lastNode = mapped.get(last.id);
  if (typeof lastNode !== "object") out.noChain = `the job ending last, ${nameOf(last)}, maps to no job of the workflow file: ${lastNode ?? "unknown"}`;
  else {
    const chain: ApiJob[] = [last];
    let notes = "";
    for (let current = last; ;) {
      const needs = needed(current);
      const ranNeeds = needs.filter((job) => ranIds.has(job.id));
      if (ranNeeds.length === 0) {
        const carried = needs.filter(isCarried);
        if (carried.length > 0) notes = `${nameOf(current)} needs ${carried.map(nameOf).join(", ")}, carried from an earlier attempt`;
        break;
      }
      current = lastOf(ranNeeds);
      chain.unshift(current);
    }
    out.chain = chain.map((job, i) => ({
      name: nameOf(job),
      afterNeedSec: (ms(job.created_at) - (i === 0 ? wall!.start : end(chain[i - 1]!))) / 1000,
    }));
    if (notes) out.noChain = notes;

    // Slack: the latest a job could end without moving a job that needs it (each job's own time from its
    // needs' end to its end kept) or the run's end.
    const onChain = new Set(chain.map((job) => job.id));
    const runEnd = end(last);
    const dependents = new Map<number, ApiJob[]>();
    for (const job of ran) for (const need of needed(job)) if (ranIds.has(need.id)) dependents.set(need.id, [...(dependents.get(need.id) ?? []), job]);
    const latest = new Map<number, number>();
    const latestEnd = (job: ApiJob): number => {
      const known = latest.get(job.id);
      if (known !== undefined) return known;
      const after = dependents.get(job.id) ?? [];
      const value =
        after.length === 0
          ? runEnd
          : Math.min(
              ...after.map((d) => {
                const needsDone = Math.max(
                  ...needed(d)
                    .filter((n) => ranIds.has(n.id))
                    .map(end),
                );
                return latestEnd(d) - (end(d) - needsDone);
              }),
            );
      latest.set(job.id, value);
      return value;
    };
    out.offChain = ran
      .filter((job) => !onChain.has(job.id) && typeof mapped.get(job.id) === "object")
      .map((job) => ({ name: nameOf(job), slackSec: (latestEnd(job) - end(job)) / 1000 }));

    // The lever: the chain's job taking the most of it, and its largest item.
    const share = (job: ApiJob, i: number) => out.chain![i]!.afterNeedSec + byId.get(job.id)!.pickupSec + byId.get(job.id)!.spanSec;
    const heaviest = chain.reduce((best, job, i) => (share(job, i) > share(best, chain.indexOf(best)) ? job : best));
    const t = byId.get(heaviest.id)!;
    const largest = t.steps.reduce<{ step: string; seconds: number }>((best, s) => (s.seconds > best.seconds ? { step: s.name, seconds: s.seconds } : best), {
      step: "pickup",
      seconds: t.pickupSec,
    });
    out.lever = { job: t.name, ...largest };
  }

  // The speed of light: one pickup + the longest work one job must do + that job's setup no cache removes.
  const unclear = times.filter((t) => t.unclassifiedSec > 0 || t.unmatched);
  if (unclear.length > 0)
    out.noSpeedOfLight = `the steps of ${unclear.map((t) => t.name).join(", ")} were not matched to the workflow, so the longest work is not measured`;
  else {
    const fastest = times.reduce((best, t) => (t.pickupSec < best.pickupSec ? t : best));
    const longest = times.reduce((best, t) => (t.workSec > best.workSec ? t : best));
    const setupSec = longest.steps.filter((s) => s.phase === "setup" && UNCACHEABLE.has(s.rule)).reduce((acc, s) => acc + s.seconds, 0);
    const total = fastest.pickupSec + longest.workSec + setupSec;
    out.speedOfLight = {
      estimated: true,
      pickupSec: fastest.pickupSec,
      pickupJob: fastest.name,
      workSec: longest.workSec,
      workJob: longest.name,
      setupSec,
      seconds: total,
      gapSec: (wallOut?.seconds ?? 0) - total,
    };
  }
  return out;
};
