import { describe, expect, it } from "vitest";
import { contention, formatContention, type JobLoad, loadOf, type StepLoad, THRESHOLDS } from "./contention.ts";
import { ledgerOf } from "./ledger.ts";

const step = (over: Partial<StepLoad> = {}): StepLoad => ({
  name: "Build",
  start: 1_000,
  end: 1_060,
  result: "Succeeded",
  cpuPct: 50,
  cpuPeakPct: 70,
  memPeakMb: 2048,
  cpuSomePct: 5,
  memSomePct: 0,
  oomKills: 0,
  memPressureLevel: null,
  exit137: false,
  killed: [],
  ...over,
});
const linux = (steps: StepLoad[], over: Partial<JobLoad> = {}): JobLoad => ({
  os: "Linux",
  cpus: 4,
  memTotalMb: 8192,
  steps,
  oomKillsOutsideSteps: 0,
  ...over,
});

// A job's log as GitHub's job logs API gives it: each line after its timestamp.
const logOf = (lines: readonly string[]) => lines.map((line, i) => `2026-11-18T09:00:${String(i).padStart(2, "0")}.1234567Z ${line}`).join("\n");
const line = (load: unknown, cache: unknown = { absent: "cache ledger: not measured (the job's cache calls went to GitHub's cache)" }) =>
  `job-report v2 ${JSON.stringify({ v: 2, load, cache })}`;

describe("contention: what makes more parallelism slower, flagged from a job's load", () => {
  it("flags workers beyond the cores only when tasks waited for a CPU over the threshold while the step used the cores", () => {
    const over = THRESHOLDS.cpuPressurePct + 1;
    expect(contention(linux([step({ cpuSomePct: over, cpuPct: THRESHOLDS.cpuBusyPct })])).flags).toEqual([
      `"Build" (60 s): workers beyond the cores: tasks waited for a CPU ${over}% of its time while it used 80% of the 4 vCPUs. More workers than cores wait for one another: here more parallelism is slower, not faster; at most 4 workers, or less work at once`,
    ]);
    // Waiting for a CPU while the cores were not all busy is not workers beyond them (a throttled or pinned task).
    expect(contention(linux([step({ cpuSomePct: 80, cpuPct: THRESHOLDS.cpuBusyPct - 1 })])).flags).toEqual([]);
    // Every core busy and nobody waiting: the work fits the machine.
    expect(contention(linux([step({ cpuSomePct: THRESHOLDS.cpuPressurePct, cpuPct: 100 })])).flags).toEqual([]);
  });

  it("flags memory pressure on memory waited for, or a peak near the job's memory, and nothing below", () => {
    expect(contention(linux([step({ memSomePct: 11 })])).flags).toEqual([
      `"Build" (60 s): memory pressure: tasks waited for memory 11% of its time. Workers that do not fit in memory reclaim, swap or get killed: here more parallelism is slower; fewer workers, or less memory each`,
    ]);
    expect(contention(linux([step({ memPeakMb: 7400 })])).flags[0]).toMatch(/memory pressure: its memory peaked at 7\.2 GB of 8\.0 GB \(90%\)/);
    expect(contention(linux([step({ memSomePct: THRESHOLDS.memPressurePct, memPeakMb: 7300 })])).flags).toEqual([]);
  });

  it("flags a process killed: an OOM kill with the process when known, or an exit code 137, and says when no OOM kill explains it", () => {
    expect(contention(linux([step({ oomKills: 2, killed: ["cc1plus", "ld"], exit137: true, result: "Failed" })])).flags).toEqual([
      `"Build" (60 s): a process killed: the kernel's OOM killer killed 2 processes (cc1plus, ld), and it ended with exit code 137. Too many workers for the memory is the usual cause: fewer workers, or less memory each`,
    ]);
    expect(contention(linux([step({ exit137: true })])).flags[0]).toContain(
      "it ended with exit code 137, a process killed by SIGKILL; no OOM kill was counted, so not for memory",
    );
    expect(contention(linux([step()], { oomKillsOutsideSteps: 1 })).flags).toEqual(["the kernel's OOM killer killed 1 process(es) between steps"]);
  });

  it("says what a machine could not measure, never 'no': macOS, a machine without PSI or OOM counter, steps under 2 s", () => {
    const mac = contention({
      os: "Darwin",
      cpus: 3,
      memTotalMb: 7168,
      steps: [step({ cpuSomePct: null, memSomePct: null, oomKills: null, memPressureLevel: 4, exit137: true })],
      oomKillsOutsideSteps: null,
    });
    expect(mac.notMeasured).toEqual(["CPU pressure and OOM kills, on macOS (it has no pressure stall information or OOM counter)"]);
    expect(mac.flags[0]).toContain("the system's memory pressure reached critical");
    expect(mac.flags[1]).toContain("it ended with exit code 137, a process killed by SIGKILL, as the OOM killer does");
    expect(contention(linux([step({ cpuSomePct: null, memSomePct: null, oomKills: null })])).notMeasured).toEqual([
      "CPU and memory pressure: no step held 2 s between its samples (sampled every second), or the machine gives no pressure stall information",
      "OOM kills (the machine gives no OOM counter)",
    ]);
    expect(contention(linux([step(), step({ name: "Quick", start: 1_060, end: 1_061, cpuSomePct: null, memSomePct: null })])).notMeasured).toEqual([
      "the pressure of 1 step with under 2 s between their samples (sampled every second)",
    ]);
  });

  it("blames no machine for what a job too short to sample did not measure: no sample in its steps, a 2 s step without two samples", () => {
    // Seen 2026-11-18: a 1 s job on a Linux VM with PSI and an OOM counter printed no figure at all.
    const unsampled = step({ cpuPct: null, cpuPeakPct: null, memPeakMb: null, cpuSomePct: null, memSomePct: null, oomKills: null });
    const none = contention({ os: "Linux", cpus: 10, memTotalMb: null, steps: [unsampled], oomKillsOutsideSteps: null });
    expect(none.notMeasured).toEqual(["its load: no sample fell within its steps (sampled every second)"]);
    expect(
      formatContention([{ name: "ok", load: { load: { os: "Linux", cpus: 10, memTotalMb: null, steps: [unsampled], oomKillsOutsideSteps: null } } }]),
    ).toEqual([
      "",
      expect.stringContaining("contention ("),
      "  ok (10 vCPU, memory not measured):",
      "    not measured: its load: no sample fell within its steps (sampled every second)",
    ]);
    // A checkout of 2 s by GitHub's seconds, sampled once: its pressure is not measured, the machine's PSI is not in doubt.
    const twoSeconds = step({ name: "Checkout", start: 1_000, end: 1_002, cpuSomePct: null, memSomePct: null });
    expect(contention(linux([twoSeconds, step({ start: 1_002, end: 1_030 })])).notMeasured).toEqual([
      "the pressure of 1 step with under 2 s between their samples (sampled every second)",
    ]);
  });

  it("reads the job's load and its cache ledger from the one job report line, and says why a job has none", () => {
    const load = linux([step()]);
    const ledger = { v: 1, restores: [], saves: [] };
    expect(loadOf(logOf(["Step times and load (CPU of 4 vCPU):", line(load, ledger)]))).toEqual({ load });
    expect(ledgerOf(logOf(["Step times and load (CPU of 4 vCPU):", line(load, ledger)]))).toEqual({ ledger });
    expect(loadOf(logOf([line({ absent: "step times: no runner log" })]))).toEqual({ absent: "step times: no runner log" });
    expect(ledgerOf(logOf([line(load)]))).toEqual({ absent: "cache ledger: not measured (the job's cache calls went to GitHub's cache)" });
    expect(loadOf(logOf(["Step times and load (CPU of 4 vCPU):", 'outrun-cache-ledger v1 {"v":1,"restores":[],"saves":[]}']))).toEqual({
      absent: "no contention figures: the job ran before outrun's runners recorded them",
    });
    expect(loadOf(logOf(["##[group]Run actions/checkout@v4"]))).toEqual({ absent: "no contention figures: the job did not run on outrun's runners" });
    expect(loadOf(logOf(['job-report v3 {"v":3}']))).toMatchObject({ absent: expect.stringContaining("version 3, newer than this outrun reads") });
    expect(ledgerOf(logOf(['job-report v2 {"v":2,"load":']))).toEqual({ absent: "its job report line could not be read" });
  });

  it("prints each job's flags with the thresholds, or its peaks when nothing is flagged", () => {
    const out = formatContention([
      { name: "build", load: { load: linux([step({ name: "Compile", cpuSomePct: 64, cpuPct: 97, cpuPeakPct: 100 })]) } },
      { name: "lint", load: { load: linux([step({ name: "Lint", cpuPeakPct: 35, memPeakMb: 1200 })]) } },
      { name: "docs", load: { absent: "no contention figures: the job did not run on outrun's runners" } },
    ]);
    expect(out[1]).toContain("tasks waited for a CPU over 25% of a step's time while it used 80% or more of the vCPUs");
    expect(out.slice(2)).toEqual([
      "  build (4 vCPU, 8.0 GB):",
      `    ! "Compile" (60 s): workers beyond the cores: tasks waited for a CPU 64% of its time while it used 97% of the 4 vCPUs. More workers than cores wait for one another: here more parallelism is slower, not faster; at most 4 workers, or less work at once`,
      "  lint (4 vCPU, 8.0 GB): none flagged (CPU peaked at 35%, memory at 1.2 GB)",
      "  docs: no contention figures: the job did not run on outrun's runners",
    ]);
  });
});
