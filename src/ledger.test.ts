import { describe, expect, it } from "vitest";
import { cacheVerdict, hitKind, jobCache, type Ledger, ledgerOf, type LedgerRestore, type LedgerSave, ledgerText, stepOf } from "./ledger.ts";
import { cacheSamples, formatCache, runLogs } from "./report.ts";
import type { ApiStep } from "./timeline.ts";
import { zipEntries } from "./zip.ts";

const T0 = Date.UTC(2026, 10, 18, 9);
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString().replace(".000Z", "Z");
const ms = (sec: number) => T0 + sec * 1000;
const step = (name: string, from: number, to: number): ApiStep => ({ name, started_at: at(from), completed_at: at(to) });

const restore = (over: Partial<LedgerRestore> = {}): LedgerRestore => ({
  key: "deps-abc",
  restoreKeys: ["deps-"],
  matched: "deps-abc",
  hit: "exact",
  source: "local",
  bytes: 412_300_000,
  start: ms(3.2),
  end: ms(7.4),
  sha256: "a".repeat(64),
  ...over,
});
const save = (over: Partial<LedgerSave> = {}): LedgerSave => ({
  key: "deps-abd",
  to: "outrun",
  bytes: 412_300_000,
  start: ms(30.1),
  end: ms(41.9),
  outcome: "saved",
  sha256: "b".repeat(64),
  ...over,
});
const ledger = (restores: LedgerRestore[], saves: LedgerSave[]): Ledger => ({ v: 1, restores, saves });

// A job's log as GitHub's job logs API gives it: each line after its timestamp.
const logOf = (lines: readonly string[]) => lines.map((line, i) => `2026-11-18T09:00:${String(i).padStart(2, "0")}.1234567Z ${line}`).join("\n");

describe("the cache ledger in a job's log", () => {
  it("reads back the ledger the job's report printed, through GitHub's timestamps", () => {
    const written = ledger([restore(), restore({ key: "tools-2", matched: null, hit: "miss", source: null, bytes: null, sha256: null })], [save()]);
    const text = ledgerText(written);
    expect(text.split("\n").slice(0, -1)).toEqual([
      "Cache (2 restores, 1 save):",
      "  restore deps-abc: exact hit, from the machine's own copy, 412.3 MB, 4.2 s (09:00:03.2 to 09:00:07.4), sha256 aaaaaaaaaaaaaaaa",
      "  restore tools-2: miss (also asked deps-), 4.2 s (09:00:03.2 to 09:00:07.4)",
      "  save deps-abd: saved, 412.3 MB, 11.8 s (09:00:30.1 to 09:00:41.9), sha256 bbbbbbbbbbbbbbbb",
    ]);
    expect(ledgerOf(logOf(["Step times and load (CPU of 4 vCPU):", ...text.split("\n")]))).toEqual({ ledger: written });
  });

  it("says why a job has no ledger: not measured, a run before the ledger, not outrun's runners, a newer version", () => {
    expect(ledgerOf(logOf(["Step times and load", "cache ledger: not measured (the job's cache calls went to GitHub's cache)"]))).toEqual({
      absent: "cache ledger: not measured (the job's cache calls went to GitHub's cache)",
    });
    expect(ledgerOf(logOf(["Step times and load (CPU of 4 vCPU):", "Job 29 s"]))).toEqual({
      absent: "no cache ledger: the job ran before outrun's runners recorded one",
    });
    expect(ledgerOf(logOf(["##[group]Run actions/checkout@v4"]))).toEqual({ absent: "no cache ledger: the job did not run on outrun's runners" });
    expect(ledgerOf(logOf(['outrun-cache-ledger v2 {"v":2}']))).toMatchObject({ absent: expect.stringContaining("version 2") });
    expect(ledgerOf(logOf(['outrun-cache-ledger v1 {"v":1,"restores":[']))).toEqual({ absent: "its cache ledger line could not be read" });
  });

  it("calls a hit exact when the key found is the key asked, as actions/cache compares them", () => {
    expect([hitKind("Deps-1", "deps-1"), hitKind("deps-2", "deps-1"), hitKind("deps-2", null)]).toEqual(["exact", "partial", "miss"]);
  });
});

describe("each restore and save in its step", () => {
  const steps = [step("Set up job", 0, 2), step("Restore deps", 2, 8), step("Build", 8, 30), step("Post Restore deps", 30, 42), step("Complete job", 42, 42)];

  it("puts an event in the step that holds it, from its start's second to the second after its end", () => {
    expect(stepOf(steps, ms(3.2), ms(7.4))).toEqual({ step: "Restore deps", stepSec: 6 });
    // Starting in the boundary second of two steps, ending in the second: the second one.
    expect(stepOf(steps, ms(8.3), ms(12))).toEqual({ step: "Build", stepSec: 22 });
    // An instant in a boundary second: either step, so none is claimed.
    expect(stepOf(steps, ms(8.3), ms(8.4))).toEqual({ step: null, stepSec: null, steps: ["Restore deps", "Build"] });
    expect(stepOf(steps, ms(50), ms(51))).toEqual({ step: null, stepSec: null });
  });

  it("with each step's own log's first line, puts an event in the step that started last before it, whatever the second", () => {
    const numbered = [
      { ...step("Run setup-bun", 28, 31), number: 5 },
      { ...step("Task durations kept", 31, 31), number: 6 },
      { ...step("Plan", 31, 40), number: 7 },
    ];
    const starts = new Map([
      [5, ms(28.05)],
      [6, ms(31.21)],
      [7, ms(31.62)],
    ]);
    // To the second, three steps hold 31.3 to 31.5: none is claimed.
    expect(stepOf(numbered, ms(31.3), ms(31.5)).step).toBeNull();
    expect(stepOf(numbered, ms(31.3), ms(31.5), starts)).toEqual({ step: "Task durations kept", stepSec: 0 });
    // Its end read a few milliseconds past the next step's start (the machine's clock, not the VM's): still its step.
    expect(stepOf(numbered, ms(31.3), ms(31.64), starts)).toEqual({ step: "Task durations kept", stepSec: 0 });
    expect(stepOf(numbered, ms(33), ms(35), starts)).toEqual({ step: "Plan", stepSec: 9 });
  });

  it("flags a save whose step takes longer than the job's own work, and one of the bytes the job restored", () => {
    const unchanged = save({ sha256: "a".repeat(64) });
    const cache = jobCache(ledger([restore()], [unchanged]), steps, 10);
    expect(cache.restores[0]).toMatchObject({ step: "Restore deps", stepSec: 6 });
    expect(cache.saves[0]).toMatchObject({ step: "Post Restore deps", stepSec: 12 });
    expect(cache.flags).toEqual([
      'save deps-abd in "Post Restore deps" took 12 s, longer than the job\'s own work (10 s)',
      "save deps-abd stored the same bytes this job restored from deps-abc (sha256 aaaaaaaaaaaaaaaa): an unchanged save",
    ]);
    // The same bytes restored after the save (a job checking its own save): not an unchanged save.
    expect(jobCache(ledger([restore({ start: ms(43), end: ms(43.5) })], [unchanged]), steps, 22).flags).toEqual([]);
    // Changed bytes and a save shorter than the work: nothing to flag.
    expect(jobCache(ledger([restore()], [save()]), steps, 22).flags).toEqual([]);
  });

  it("says what it could not check rather than flag or clear it: no work measured, no sha256 of the save", () => {
    const cache = jobCache(ledger([restore()], [save({ sha256: null })]), steps, undefined);
    expect(cache.flags).toEqual([]);
    expect(cache.notMeasured).toEqual([
      "save deps-abd: the job's work is not measured (its steps were not matched to the workflow)",
      "save deps-abd: whether it changed is not measured (no sha256 of what it saved)",
    ]);
    // A save that did not save (already there) is flagged for neither.
    expect(jobCache(ledger([restore()], [save({ outcome: "exists", sha256: null, bytes: null })]), steps, 1)).toMatchObject({ flags: [], notMeasured: [] });
  });
});

// A zip of stored files, as an archive writer makes one (GitHub's are deflated: zip.ts reads both).
const storedZip = (files: Record<string, string>) => {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const data = new TextEncoder().encode(text);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]);
};

describe("GitHub's run logs archive", () => {
  it("gives each job's whole log and each step's start, its own log's first line, by the job's name with / as _", () => {
    const zip = storedZip({
      "0_backend _ test.txt": '\uFEFF2026-11-18T09:00:00.1234567Z Current runner version\noutrun-cache-ledger v1 {"v":1,"restores":[],"saves":[]}\n',
      "backend _ test/system.txt": "2026-11-18T08:59:58.0000000Z Requested labels: outrun\n",
      "backend _ test/1_Set up job.txt": "\uFEFF2026-11-18T09:00:00.1234567Z Current runner version\n",
      "backend _ test/6_Run actions_cache_save@v4.txt": "\uFEFF2026-11-18T09:00:31.2100000Z ##[group]Run actions/cache/save@v4\n",
    });
    const logs = runLogs(zipEntries(zip)!);
    const job = logs.get("backend _ test")!;
    expect([...job.starts]).toEqual([
      [1, Date.parse("2026-11-18T09:00:00.123Z")],
      [6, Date.parse("2026-11-18T09:00:31.210Z")],
    ]);
    expect(ledgerOf(job.log!)).toEqual({ ledger: { v: 1, restores: [], saves: [] } });
    expect(zipEntries(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("whether a cache pays, over the same job's runs on the default branch", () => {
  const hit = { hit: "exact" as const, restoreSec: 6, saveSec: 0, otherSec: 40 };
  const miss = { hit: "miss" as const, restoreSec: 1, saveSec: 12, otherSec: 100 };

  it("gives no verdict on fewer than 3 hits and 3 misses, and says how many of each it read", () => {
    expect(cacheVerdict('test, "Restore deps"', [hit, hit, hit, miss, miss], 6)).toEqual({
      exact: 3,
      miss: 2,
      partial: 0,
      sentence: 'test, "Restore deps": not enough runs (3 exact hits, 2 misses, 0 partial, in 6 runs with a ledger; 3 of each needed)',
    });
  });

  it("weighs a restore on a hit plus a save on a miss against the rest of the job on a miss minus on a hit (medians)", () => {
    const pays = cacheVerdict('test, "Restore deps"', [hit, hit, { ...hit, restoreSec: 60 }, miss, miss, miss, { ...hit, hit: "partial" }], 7);
    expect(pays).toMatchObject({ exact: 3, miss: 3, partial: 1, costSec: 18, avoidedSec: 60, pays: true });
    // A restore slower than the work it avoids: it costs more than it avoids.
    const slow = cacheVerdict('test, "Restore deps"', [...[1, 2, 3].map(() => ({ ...hit, restoreSec: 70 })), miss, miss, miss], 6);
    expect(slow).toMatchObject({ costSec: 82, avoidedSec: 60, pays: false });
    expect(slow.sentence).toBe(
      'test, "Restore deps": restore on a hit plus save on a miss cost 82 s, it avoids 60 s: it costs more than it avoids (3 exact hits, 3 misses, 0 partial, in 6 runs with a ledger)',
    );
  });

  it("takes one sample per run and restore step: a step restoring several keys is a hit only when all hit, a miss only when all missed, its saves counted once", () => {
    // Seen 2026-11-18: a setup action restoring an SDK and a package cache in one step counted as two samples a run.
    const steps = [step("Set up the SDK", 2, 18), step("Test", 18, 60), step("Post Set up the SDK", 60, 66)];
    const two = (a: "exact" | "miss", b: "exact" | "miss", saves: LedgerSave[] = []) =>
      cacheSamples(
        jobCache(ledger([restore({ key: "sdk", hit: a, start: ms(3) }), restore({ key: "pkgs", hit: b, start: ms(10) })], saves), steps, undefined),
        70,
      );
    expect([...two("exact", "exact")]).toEqual([["Set up the SDK", { hit: "exact", restoreSec: 16, saveSec: 0, otherSec: 54 }]]);
    expect(two("exact", "miss").get("Set up the SDK")?.hit).toBe("partial");
    const saves = [save({ key: "sdk", start: ms(61), end: ms(62) }), save({ key: "pkgs", start: ms(63), end: ms(64) })];
    expect(two("miss", "miss", saves).get("Set up the SDK")).toEqual({ hit: "miss", restoreSec: 16, saveSec: 6, otherSec: 48 });
  });

  it("prints a cache under 1 MB in kB, never as 0.0 MB", () => {
    // Seen 2026-11-18: a 13 kB durations file printed "0.0 MB".
    const lines = formatCache([{ name: "plan", cache: jobCache(ledger([restore({ bytes: 13_309 })], []), [step("Restore deps", 2, 8)], 5) }], []);
    expect(lines[3]).toContain("exact hit, 13.3 kB from the machine's own copy");
  });

  it("prints each job's restores and saves with their steps, the flags, and the jobs without a ledger grouped by why", () => {
    const steps = [step("Restore deps", 2, 8), step("Post Restore deps", 30, 42)];
    const lines = formatCache(
      [
        { name: "test", cache: jobCache(ledger([restore()], [save({ sha256: "a".repeat(64) })]), steps, 22) },
        { name: "lint", cache: { absent: "no cache ledger: the job ran before outrun's runners recorded one" } },
        { name: "docs", cache: { absent: "no cache ledger: the job ran before outrun's runners recorded one" } },
      ],
      [],
    );
    expect(lines).toEqual([
      "",
      "cache (each job's ledger, printed in its log by outrun's runners):",
      "  test:",
      '    restore deps-abc: exact hit, 412.3 MB from the machine\'s own copy, 4.2 s, in "Restore deps" (6 s)',
      '    save deps-abd: saved, 412.3 MB, 11.8 s, in "Post Restore deps" (12 s)',
      "    ! save deps-abd stored the same bytes this job restored from deps-abc (sha256 aaaaaaaaaaaaaaaa): an unchanged save",
      "  lint, docs: no cache ledger: the job ran before outrun's runners recorded one",
    ]);
  });
});
