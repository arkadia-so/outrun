import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Suite } from "../config.ts";
import { bunAdapter } from "./bun.ts";

const suite: Suite = { name: "s", adapter: "bun", dir: ".", tests: ["**/*.test.ts"], run: ["bun", "test"] };

const results = async (files: string[], code: number, output: string) => {
  const batch = bunAdapter.batch(suite, "/repo", files, await mkdtemp(`${tmpdir()}/outrun-bun-`));
  return Effect.runPromise(batch.results({ code, output }));
};

describe("bun adapter", () => {
  it("passes a batch whose files define no test, which bun reports without writing its report", async () => {
    const summary = "\nz.test.ts:\n\n 0 pass\n 0 fail\nRan 0 tests across 1 file. [44.00ms]\n";
    expect(await results(["z.test.ts"], 1, summary)).toEqual(new Map([["z.test.ts", { passed: true, durationMs: 0, tests: 0 }]]));
    // A crash before any test ran says nothing about the files: none passes.
    expect((await results(["z.test.ts"], 1, `error: Cannot find module "x"\n${summary}`)).size).toBe(0);
    expect((await results(["z.test.ts", "y.test.ts"], 1, summary)).size).toBe(0);
  });
});
