import { describe, expect, it } from "vitest";
import { mergeReadSets } from "./readsets.ts";

describe("mergeReadSets", () => {
  it("puts the newest set first, never twice, and keeps three", () => {
    const set = (...reads: string[]) => ({ reads, net: false });
    let record = {};
    for (const r of ["a", "b", "c", "b", "d"]) record = mergeReadSets(record, new Map([["w", set(r)]]));
    expect(record).toEqual({ w: [set("d"), set("b"), set("c")] });
  });
});
