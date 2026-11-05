import { describe, expect, it } from "vitest";
import { batches, fillIdle, runnersFor, shard } from "./balance.ts";

const unit = (id: string, durationMs: number, suite = "s") => ({ id, suite, durationMs });

describe("shard", () => {
  it("gives every unit to exactly one runner, longest first to the least loaded", () => {
    const units = [unit("a", 10), unit("b", 7), unit("c", 5), unit("d", 4), unit("e", 3)];
    const shards = shard(units, 2);
    expect(
      shards
        .flat()
        .map((u) => u.id)
        .sort(),
    ).toEqual(["a", "b", "c", "d", "e"]);
    const loads = shards.map((s) => s.reduce((a, u) => a + u.durationMs, 0));
    expect(Math.max(...loads)).toBe(15);
  });

  it("plans the same on every runner, whatever order the units come in", () => {
    const units = [unit("a", 5), unit("b", 5), unit("c", 5), unit("d", 1)];
    expect(shard(units, 3)).toEqual(shard([...units].reverse(), 3));
  });
});

describe("batches", () => {
  it("never mixes suites in one batch, and runs the longest batches first", () => {
    const units = [unit("a", 3000, "x"), unit("b", 3000, "y"), unit("c", 9000, "x")];
    const planned = batches(units, { slots: 2, startupMs: 100, minBatchMs: 1000 });
    for (const b of planned) expect(new Set(b.units.map((u) => u.suite))).toEqual(new Set([b.suite]));
    expect(planned.map((b) => b.expectedMs)).toEqual([...planned.map((b) => b.expectedMs)].sort((a, b) => b - a));
  });

  it("keeps short work in one batch so its startup does not dominate", () => {
    const units = Array.from({ length: 20 }, (_, i) => unit(`u${i}`, 50));
    expect(batches(units, { slots: 8, startupMs: 300, minBatchMs: 4000 })).toHaveLength(1);
  });
});

describe("runnersFor", () => {
  const units = (...ms: number[]) => ms.map((durationMs, i) => ({ id: `u${i}`, suite: "s", durationMs }));
  it("starts no runner without misses, and the fewest that meet the target", () => {
    const options = { max: 8, targetMs: 60_000, startMs: 10_000, slots: 2 };
    expect(runnersFor([], options)).toBe(0);
    expect(runnersFor(units(10_000, 10_000), options)).toBe(1);
    expect(runnersFor(units(...Array(20).fill(20_000)), options)).toBe(4);
    // Never more than max.
    expect(runnersFor(units(...Array(200).fill(20_000)), options)).toBe(8);
    // The longest unit bounds what more runners buy: past 4, none makes the run shorter.
    expect(runnersFor(units(120_000, ...Array(40).fill(20_000)), options)).toBe(4);
    // A start as long as the target: one runner for a little work, not the most.
    expect(runnersFor(units(300, 300), { ...options, startMs: 60_000 })).toBe(1);
  });
});

describe("fillIdle", () => {
  it("places extra work only where it does not lengthen the busiest share", () => {
    const u = (id: string, durationMs: number) => ({ id, suite: "s", durationMs });
    const { shares, placed } = fillIdle([[u("a", 10)], [u("b", 4)]], [u("x", 5), u("y", 3)]);
    expect(placed.map((p) => p.id)).toEqual(["x"]);
    expect(shares[1]?.map((p) => p.id)).toEqual(["b", "x"]);
  });
});
