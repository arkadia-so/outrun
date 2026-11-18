// Contention (README.md "outrun report", D6 of OUT-94): what a job's machine went through during each
// step, as outrun's runners measured it and printed it in the job's own log (its "Complete runner"
// step, the job report's line: ledger.ts), then what `outrun report` flags: workers beyond the cores,
// memory pressure, a process killed for memory. These are what make "more parallelism" slower: more
// workers than cores wait for one another, and more than the memory holds reclaim, swap or get killed.
// Pure: the figures come from the job's line, the thresholds are stated here and in the output.

import { absentOf, jobReportOf, STEP_REPORT } from "./ledger.ts";

/** One step of the job, as the job's report measured it (null: not measured on that machine, or the step too short). */
export interface StepLoad {
  readonly name: string;
  /** Epoch seconds, from the runner's own log. */
  readonly start: number;
  readonly end: number;
  readonly result: string;
  /** The job's CPU, mean and peak of its samples, % of all its vCPUs. */
  readonly cpuPct: number | null;
  readonly cpuPeakPct: number | null;
  /** Peak memory in use (the page cache left out), MB. */
  readonly memPeakMb: number | null;
  /** Share of the step's time some task waited for a CPU / for memory, % (PSI's "some" totals over the step; Linux, steps of 2 s or more). */
  readonly cpuSomePct: number | null;
  readonly memSomePct: number | null;
  /** Processes the kernel's OOM killer killed during the step (Linux). */
  readonly oomKills: number | null;
  /** macOS: the system's memory pressure level at its highest (1 normal, 2 warning, 4 critical). */
  readonly memPressureLevel: number | null;
  /** A process of the step ended with exit code 137 (killed by SIGKILL), from the runner's log. */
  readonly exit137: boolean;
  /** The processes the kernel's log says it killed for memory during the step, when it could be read. */
  readonly killed: readonly string[];
}

export interface JobLoad {
  /** `uname -s` of the job's machine. */
  readonly os: string;
  readonly cpus: number;
  /** The job's memory: its cgroup's memory.max, else the machine's MemTotal (macOS: hw.memsize), MB. */
  readonly memTotalMb: number | null;
  readonly steps: readonly StepLoad[];
  /** OOM kills seen between steps. */
  readonly oomKillsOutsideSteps: number | null;
}

export type LoadRead = { readonly load: JobLoad } | { readonly absent: string };

const isLoad = (value: unknown): value is JobLoad =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as JobLoad).cpus === "number" &&
  typeof (value as JobLoad).os === "string" &&
  Array.isArray((value as JobLoad).steps);

/** The job's load in its log (GitHub's job logs API), or why it has none. */
export const loadOf = (log: string): LoadRead => {
  const report = jobReportOf(log);
  if (report !== undefined) {
    if ("absent" in report) return report;
    const { load } = report.line;
    if (isLoad(load)) return { load };
    return { absent: absentOf(load) ?? "its job report holds no load it could read" };
  }
  if (log.includes(STEP_REPORT)) return { absent: "no contention figures: the job ran before outrun's runners recorded them" };
  return { absent: "no contention figures: the job did not run on outrun's runners" };
};

/** The thresholds a flag needs, stated in the report's output and README.md "outrun report". */
export const THRESHOLDS = {
  /** Workers beyond the cores: tasks waited for a CPU more than this share of the step's time... */
  cpuPressurePct: 25,
  /** ...while the step's CPU averaged at least this share of the machine's vCPUs. */
  cpuBusyPct: 80,
  /** Memory pressure: tasks waited for memory more than this share of the step's time... */
  memPressurePct: 10,
  /** ...or the step's peak memory reached this share of the job's memory. */
  memPeakPct: 90,
} as const;

/** The thresholds in one sentence, for the output. */
const thresholdsText = () =>
  `workers beyond the cores: tasks waited for a CPU over ${THRESHOLDS.cpuPressurePct}% of a step's time while it used ${THRESHOLDS.cpuBusyPct}% or more of the vCPUs; ` +
  `memory pressure: tasks waited for memory over ${THRESHOLDS.memPressurePct}% of a step's time, or its peak memory reached ${THRESHOLDS.memPeakPct}% of the job's; ` +
  "a process killed: an OOM kill, or a step that ended with exit code 137";

export interface JobContention {
  /** What deserves a look, one sentence each. */
  readonly flags: readonly string[];
  /** What could not be checked on this machine, and why. */
  readonly notMeasured: readonly string[];
  /** The job's highest CPU and memory, for a line when nothing is flagged. */
  readonly peakCpuPct: number | null;
  readonly peakMemMb: number | null;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const pct = (value: number) => `${Math.round(value)}%`;
const MAC_LEVEL: Record<number, string> = { 2: "warning", 4: "critical" };

/** The flags of one job's load, with what its machine could not measure. */
export const contention = (load: JobLoad): JobContention => {
  const flags: string[] = [];
  const notMeasured: string[] = [];
  const linux = load.os === "Linux";
  const ran = load.steps;
  for (const s of ran) {
    const step = `"${s.name}" (${s.end - s.start} s)`;
    if (s.cpuSomePct !== null && s.cpuPct !== null && s.cpuSomePct > THRESHOLDS.cpuPressurePct && s.cpuPct >= THRESHOLDS.cpuBusyPct)
      flags.push(
        `${step}: workers beyond the cores: tasks waited for a CPU ${pct(s.cpuSomePct)} of its time while it used ${pct(s.cpuPct)} of the ${load.cpus} vCPUs. More workers than cores wait for one another: here more parallelism is slower, not faster; at most ${load.cpus} workers, or less work at once`,
      );
    const memWhy: string[] = [];
    if (s.memSomePct !== null && s.memSomePct > THRESHOLDS.memPressurePct) memWhy.push(`tasks waited for memory ${pct(s.memSomePct)} of its time`);
    if (s.memPeakMb !== null && load.memTotalMb !== null && load.memTotalMb > 0 && (s.memPeakMb / load.memTotalMb) * 100 >= THRESHOLDS.memPeakPct)
      memWhy.push(`its memory peaked at ${gb(s.memPeakMb)} of ${gb(load.memTotalMb)} (${pct((s.memPeakMb / load.memTotalMb) * 100)})`);
    if (s.memPressureLevel !== null && MAC_LEVEL[s.memPressureLevel]) memWhy.push(`the system's memory pressure reached ${MAC_LEVEL[s.memPressureLevel]}`);
    if (memWhy.length > 0)
      flags.push(
        `${step}: memory pressure: ${memWhy.join(", and ")}. Workers that do not fit in memory reclaim, swap or get killed: here more parallelism is slower; fewer workers, or less memory each`,
      );
    if ((s.oomKills ?? 0) > 0 || s.exit137) {
      const what =
        (s.oomKills ?? 0) > 0
          ? `the kernel's OOM killer killed ${s.oomKills} process${s.oomKills === 1 ? "" : "es"}${s.killed.length > 0 ? ` (${s.killed.join(", ")})` : ""}${s.exit137 ? ", and it ended with exit code 137" : ""}`
          : `it ended with exit code 137, a process killed by SIGKILL${s.killed.length > 0 ? ` (the kernel's log: ${s.killed.join(", ")})` : ""}${s.oomKills === 0 ? "; no OOM kill was counted, so not for memory" : linux ? "" : ", as the OOM killer does"}`;
      flags.push(
        `${step}: a process killed: ${what}${s.oomKills === 0 ? "" : ". Too many workers for the memory is the usual cause: fewer workers, or less memory each"}`,
      );
    }
  }
  if ((load.oomKillsOutsideSteps ?? 0) > 0) flags.push(`the kernel's OOM killer killed ${load.oomKillsOutsideSteps} process(es) between steps`);
  // A job whose steps held no sample (it ended within the sampler's first seconds) measured nothing:
  // that is the one reason, never the machine's lack of a counter (seen on a 1 s job, 2026-11-18).
  const sampled = ran.some((s) => s.cpuPct !== null);
  if (!sampled) notMeasured.push("its load: no sample fell within its steps (sampled every second)");
  else if (!linux)
    notMeasured.push(`CPU pressure and OOM kills, on ${load.os === "Darwin" ? "macOS" : load.os} (it has no pressure stall information or OOM counter)`);
  else {
    // A step's pressure needs two samples 2 s apart or more within it: a step of 2 s by GitHub's whole
    // seconds can hold less, so a step without it says nothing of the machine unless none has it.
    const without = ran.filter((s) => s.cpuSomePct === null).length;
    if (without === ran.length)
      notMeasured.push(
        "CPU and memory pressure: no step held 2 s between its samples (sampled every second), or the machine gives no pressure stall information",
      );
    else if (without > 0)
      notMeasured.push(`the pressure of ${without} step${without === 1 ? "" : "s"} with under 2 s between their samples (sampled every second)`);
    // A sample holds the OOM counter when the machine has one, so a sampled job without it has none.
    if (ran.every((s) => s.oomKills === null)) notMeasured.push("OOM kills (the machine gives no OOM counter)");
  }
  if (sampled && load.memTotalMb === null) notMeasured.push("the job's memory size, so its peak is not weighed against it");
  const cpus = ran.map((s) => s.cpuPeakPct).filter((v): v is number => v !== null);
  const mems = ran.map((s) => s.memPeakMb).filter((v): v is number => v !== null);
  return {
    flags,
    notMeasured,
    peakCpuPct: cpus.length > 0 ? Math.max(...cpus) : null,
    peakMemMb: mems.length > 0 ? Math.max(...mems) : null,
  };
};

/** The contention section of the report: each job's flags, or its peaks when none. */
export const formatContention = (jobs: readonly { readonly name: string; readonly load: LoadRead }[]) => {
  const out = ["", `contention (each job's load per step, printed in its log by outrun's runners; ${thresholdsText()}):`];
  const absent = new Map<string, string[]>();
  for (const { name, load } of jobs) {
    if ("absent" in load) {
      absent.set(load.absent, [...(absent.get(load.absent) ?? []), name]);
      continue;
    }
    const c = contention(load.load);
    const size = `${load.load.cpus} vCPU, ${load.load.memTotalMb === null ? "memory not measured" : gb(load.load.memTotalMb)}`;
    if (c.flags.length === 0 && c.peakCpuPct === null) out.push(`  ${name} (${size}):`);
    else if (c.flags.length === 0)
      out.push(
        `  ${name} (${size}): none flagged (CPU peaked at ${c.peakCpuPct === null ? "not measured" : pct(c.peakCpuPct)}, memory at ${c.peakMemMb === null ? "not measured" : gb(c.peakMemMb)})`,
      );
    else {
      out.push(`  ${name} (${size}):`);
      for (const flag of c.flags) out.push(`    ! ${flag}`);
    }
    for (const note of c.notMeasured) out.push(`    not measured: ${note}`);
  }
  for (const [why, names] of absent) out.push(`  ${names.join(", ")}: ${why}`);
  return out;
};
