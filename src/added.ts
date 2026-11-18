// Time added per change (README.md "outrun report", D7 and D8 of OUT-94): each job of a run against the
// same job (by name, matrix values included) in the same workflow's recent successful runs on the
// default branch: the step that appeared (absent from most of that history) or grew most beyond its
// spread, and the job's budget, its `timeout-minutes`, else the p90 of its history. Pure: GitHub's jobs
// API's step times (to the second) in, sentences out; report.ts reads the runs.
import { median, quantile } from "./stats.ts";
import { type ApiJob, type ApiStep, billedSpanSec, ms, type WorkflowFiles } from "./timeline.ts";

/** Runs of history a figure needs: fewer, and the history is said too short, never weighed. */
const MIN_HISTORY = 3;

/** GitHub's step times are whole seconds, so a step's time is ±1 s: a step grew only past its history's p90 by more than this. */
const RESOLUTION_SEC = 1;

/** n, median and p90 (nearest rank) of a history's seconds. */
export interface Spread {
  readonly n: number;
  readonly medianSec: number;
  readonly p90Sec: number;
}

const spreadOf = (values: readonly number[]): Spread => ({
  n: values.length,
  medianSec: median(values),
  p90Sec: quantile(
    [...values].sort((a, b) => a - b),
    0.9,
  ),
});

/** The step that added the most time: appeared (absent from most of the history), or grew beyond its history's p90. */
interface StepAdded {
  readonly step: string;
  readonly kind: "appeared" | "grew";
  /** This run's step, seconds. */
  readonly stepSec: number;
  /** Appeared: its whole time; grew: its time minus its history's median. */
  readonly addedSec: number;
  /** History runs holding the step (run, not skipped), of [historyRuns]. */
  readonly present: number;
  readonly historyRuns: number;
  /** Over the history runs holding it; absent when none does. */
  readonly spread?: Spread;
}

interface Budget {
  readonly seconds: number;
  readonly from: "timeout-minutes" | "history";
  /** From history: why not its timeout-minutes. */
  readonly noTimeout?: string;
  /** The job's span minus the budget, seconds, when it went over. */
  readonly overSec?: number;
}

export interface JobAdded {
  readonly name: string;
  /** started_at → completed_at, seconds. */
  readonly spanSec: number;
  /** The same job's spans in the history; absent when it holds none. */
  readonly history?: Spread;
  /** Under [MIN_HISTORY] runs: why no step is weighed. */
  readonly tooShort?: string;
  readonly added?: StepAdded;
  /** The other steps that appeared, after [added]: a change adding several steps shows each one's cost. */
  readonly alsoAppeared?: readonly StepAdded[];
  readonly budget?: Budget;
  readonly noBudget?: string;
}

const stepSec = (step: ApiStep) => {
  const s = (ms(step.completed_at) - ms(step.started_at)) / 1000;
  return Number.isFinite(s) ? s : 0;
};

/** A job's steps that ran, by identity: the name, with "#2", "#3"... for a name's later occurrences. */
const stepsOf = (job: ApiJob): Map<string, { name: string; seconds: number }> => {
  const out = new Map<string, { name: string; seconds: number }>();
  const seen = new Map<string, number>();
  for (const step of [...(job.steps ?? [])].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
    const k = (seen.get(step.name) ?? 0) + 1;
    seen.set(step.name, k);
    if (step.conclusion === "skipped" || !step.started_at) continue;
    out.set(k === 1 ? step.name : `${step.name}#${k}`, { name: step.name, seconds: stepSec(step) });
  }
  return out;
};

/**
 * The job's `timeout-minutes` in [files] for workflow job [key] (`id`, or `caller/callee` for a reusable
 * workflow's): a number, or why none (unset, an expression, the file not read).
 */
export const timeoutOf = (files: WorkflowFiles | undefined, key: string | undefined): number | string => {
  if (!files || key === undefined) return "the workflow file was not read";
  const [outer, inner] = key.split("/");
  const caller = files.workflow.jobs.get(outer!);
  const uses = caller?.raw.uses;
  const job = inner === undefined ? caller : typeof uses === "string" ? files.callees.get(uses)?.jobs.get(inner) : undefined;
  if (!job) return "its workflow job's file was not read";
  const value = job.raw["timeout-minutes"];
  if (value === undefined) return "it sets no timeout-minutes";
  return typeof value === "number" && value > 0 ? value : `its timeout-minutes is ${JSON.stringify(value)}, not a number`;
};

/**
 * One job of the run ([current]) against the same job in [history] (each earlier run's job of that name
 * that succeeded, newest first). [timeout]: its `timeout-minutes`, or why none.
 */
export const jobAdded = (current: ApiJob, history: readonly ApiJob[], timeout: number | string): JobAdded => {
  const name = current.name ?? String(current.id);
  const spanSec = billedSpanSec(current);
  const n = history.length;
  const spans = history.map(billedSpanSec).filter(Number.isFinite);
  const out: { -readonly [K in keyof JobAdded]: JobAdded[K] } = { name, spanSec, ...(spans.length > 0 ? { history: spreadOf(spans) } : {}) };

  // The budget: its timeout-minutes, else the p90 of its history (D7).
  if (typeof timeout === "number") out.budget = { seconds: timeout * 60, from: "timeout-minutes" };
  else if (n >= MIN_HISTORY) out.budget = { seconds: out.history!.p90Sec, from: "history", noTimeout: timeout };
  else out.noBudget = `${timeout}, and its history holds ${n} run${n === 1 ? "" : "s"} (${MIN_HISTORY} needed for a p90)`;
  if (out.budget && spanSec > out.budget.seconds) out.budget = { ...out.budget, overSec: spanSec - out.budget.seconds };

  if (n < MIN_HISTORY) {
    out.tooShort = `${n} earlier run${n === 1 ? "" : "s"} of this job (${MIN_HISTORY} needed)`;
    return out;
  }
  const past = history.map(stepsOf);
  let best: StepAdded | undefined;
  const appeared: StepAdded[] = [];
  for (const [id, { name: step, seconds }] of stepsOf(current)) {
    const values = past.flatMap((steps) => {
      const s = steps.get(id);
      return s ? [s.seconds] : [];
    });
    const spread = values.length > 0 ? spreadOf(values) : undefined;
    // Absent from most of the history: it appeared; else it grew only beyond its history's p90 (by more than GitHub's resolution).
    const candidate: StepAdded | undefined =
      values.length * 2 < n
        ? { step, kind: "appeared", stepSec: seconds, addedSec: seconds, present: values.length, historyRuns: n, ...(spread ? { spread } : {}) }
        : spread && seconds > spread.p90Sec + RESOLUTION_SEC
          ? { step, kind: "grew", stepSec: seconds, addedSec: seconds - spread.medianSec, present: values.length, historyRuns: n, spread }
          : undefined;
    if (!candidate || candidate.addedSec <= 0) continue;
    if (candidate.kind === "appeared") appeared.push(candidate);
    if (!best || candidate.addedSec > best.addedSec) best = candidate;
  }
  if (best) out.added = best;
  const others = appeared.filter((a) => a !== best);
  if (others.length > 0) out.alsoAppeared = others;
  return out;
};

const s = (seconds: number) => (Number.isInteger(seconds) ? `${seconds} s` : `${seconds.toFixed(1)} s`);
const spreadText = (sp: Spread) => `n ${sp.n}, median ${s(sp.medianSec)}, p90 ${s(sp.p90Sec)}`;
const duration = (seconds: number) => (seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} min` : s(seconds));

/** The time-added section: each job's span against its history, its budget, and the step that added the most. */
export const formatAdded = (
  head: { readonly workflow: string; readonly branch: string; readonly runs: number; readonly requests: number },
  jobs: readonly JobAdded[],
) => {
  const out = [
    "",
    `time added (each job against the same job in ${head.runs} earlier successful run${head.runs === 1 ? "" : "s"} of ${head.workflow} on ${head.branch}, ` +
      `read in ${head.requests} request${head.requests === 1 ? "" : "s"} to GitHub; median, p90 nearest rank; a step absent from most of them appeared, ` +
      `one over their p90 by more than ${RESOLUTION_SEC} s (GitHub's step times are whole seconds) grew; growth within that is not reported):`,
  ];
  for (const j of jobs) {
    const hist = j.history ? `history ${spreadText(j.history)}` : `no history: a new job, in none of the ${head.runs} earlier runs`;
    const budget = j.budget
      ? `budget ${duration(j.budget.seconds)} (${j.budget.from === "timeout-minutes" ? "its timeout-minutes" : `the p90 of its history: ${j.budget.noTimeout}`})`
      : `no budget (${j.noBudget})`;
    out.push(`  ${j.budget?.overSec !== undefined ? "! " : ""}${j.name}: ${s(j.spanSec)}; ${hist}; ${budget}`);
    if (j.budget?.overSec !== undefined) out.push(`    ! over its budget by ${s(j.budget.overSec)}`);
    if (j.tooShort) out.push(`    steps not weighed: ${j.tooShort}`);
    else if (j.added) {
      for (const a of [j.added, ...(j.alsoAppeared ?? [])])
        out.push(
          a.kind === "appeared"
            ? `    + "${a.step}" appeared: ${s(a.stepSec)} added (in ${a.present} of the ${a.historyRuns} earlier runs${a.spread ? `: ${spreadText(a.spread)}` : ""})`
            : `    + "${a.step}" grew ${s(a.addedSec)}: ${s(a.stepSec)} against ${spreadText(a.spread!)}`,
        );
    } else out.push("    no step appeared or grew beyond its history's spread");
  }
  return out;
};
