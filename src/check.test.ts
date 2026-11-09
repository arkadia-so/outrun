// vitest-related: only in-memory fakes of the control plane and the repository.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { CheckApi, type CheckEvent, NotRun, Repo, runRepoCheck, splitUnits, type Unit } from "./check.ts";

const SHA = "a".repeat(40);

// A control plane whose workers answer at once: `plan` is worker 0's plan, `fail` the shards that fail.
const fake = (opts: { workers: number; plan: Unit[] | undefined; fail?: number[]; refuse?: string; lose?: boolean }) => {
  const calls: string[] = [];
  const events: CheckEvent[] = [];
  const names = Array.from({ length: opts.workers }, (_, i) => `chk-c-${i}`);
  const push = (event: Omit<CheckEvent, "seq" | "ms" | "log"> & { ms?: number; log?: string }) =>
    events.push({ ms: 100, log: "", ...event, seq: events.length + 1 });
  const api = Layer.succeed(CheckApi, {
    create: (repo, workers) =>
      Effect.suspend(() => {
        calls.push(`create ${repo} ${workers}`);
        if (opts.refuse) return Effect.fail(new NotRun({ message: opts.refuse }));
        for (const worker of names) push({ worker, step: "up", code: 0, json: {} });
        return Effect.succeed({ id: "c", sha: SHA, workers: names.map((name, i) => ({ name, mini: `mm${i + 1}` })) });
      }),
    patch: (_id, patch) =>
      Effect.sync(() => {
        calls.push(`patch ${patch}`);
        if (opts.lose) return void push({ worker: names[1]!, step: "lost", code: -1, json: {}, log: "mm2 left the fleet" });
        names.forEach((worker, i) =>
          push({ worker, step: "apply", code: 0, json: i === 0 ? { apply: 300, plan: 4000, ...(opts.plan ? { units: opts.plan } : {}) } : { apply: 300 } }),
        );
      }),
    shards: (_id, shards) =>
      Effect.sync(() => {
        calls.push(`shards ${JSON.stringify(shards)}`);
        for (const shard of shards) {
          const failed = opts.fail?.includes(shard.worker) ?? false;
          push({
            worker: names[shard.worker]!,
            step: "shard",
            code: failed ? 1 : 0,
            log: failed ? `${shard.tasks[0]}: expected 1, got 2` : "",
            json: { tasks: shard.tasks.map((id, i) => ({ id, ms: 1000, cache: "MISS", exit: failed && i === 0 ? 1 : 0 })) },
          });
        }
      }),
    events: (_id, after) => Effect.sync(() => events.filter((e) => e.seq > after)),
    end: (id) => Effect.sync(() => void calls.push(`end ${id}`)),
  });
  const repo = Layer.succeed(Repo, {
    name: Effect.succeed("acme/app"),
    patchFrom: (sha) => Effect.succeed(`diff from ${sha.slice(0, 4)}`),
  });
  return { calls, layer: Layer.merge(api, repo) };
};

const PLAN: Unit[] = [
  { id: "test/a_test.dart", ms: 9000 },
  { id: "test/b_test.dart", ms: 4000 },
  { id: "lint", ms: 3000, group: "js" },
  { id: "fmt", ms: 2000, group: "js" },
  { id: "test/c_test.dart", ms: 0 },
];

describe("splitUnits", () => {
  it("gives each unit, longest first, to the least loaded worker, keeps a group on one worker, and counts an unknown time as a second", () => {
    expect(splitUnits(PLAN, 3)).toEqual([["test/a_test.dart"], ["lint", "fmt"], ["test/b_test.dart", "test/c_test.dart"]]);
  });
  it("uses no more workers than there are units", () => {
    expect(splitUnits([{ id: "x", ms: 5 }], 4)).toEqual([["x"]]);
    expect(splitUnits([], 4)).toEqual([]);
  });
});

describe("outrun check", () => {
  it.effect("sends HEAD's tree on the warm commit, splits the first worker's plan by the units' times, and ends the check", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 3, plan: PLAN });
      yield* runRepoCheck(3).pipe(Effect.provide(layer));
      expect(calls[0]).toBe("create acme/app 3");
      expect(calls[1]).toBe("patch diff from aaaa");
      const expected = splitUnits(PLAN, 3).map((tasks, worker) => ({ worker, tasks }));
      expect(calls[2]).toBe(`shards ${JSON.stringify(expected)}`);
      expect(calls.at(-1)).toBe("end c");
    }),
  );

  it.effect("runs no shard when the plan has no unit", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 2, plan: [] });
      yield* runRepoCheck(2).pipe(Effect.provide(layer));
      expect(calls.map((c) => c.split(" ")[0])).toEqual(["create", "patch", "end"]);
    }),
  );

  it.effect("says it was not run when the plan reports no units (a Mac agent before the declaration), never that nothing is to run", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 2, plan: undefined });
      const error = yield* Effect.flip(runRepoCheck(2).pipe(Effect.provide(layer)));
      expect(error).toMatchObject({ _tag: "NotRun", message: "chk-c-0's plan reported no units: its Mac agent predates the check declaration" });
      expect(calls.at(-1)).toBe("end c");
    }),
  );

  it.effect("fails when a shard fails, and still ends the check", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 2, plan: PLAN, fail: [1] });
      const exit = yield* Effect.exit(runRepoCheck(2).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("CheckFailed");
      expect(calls.at(-1)).toBe("end c");
    }),
  );

  it.effect("says it was not run when the fleet refuses it or loses a worker, never running it locally", () =>
    Effect.gen(function* () {
      const refused = fake({ workers: 2, plan: PLAN, refuse: "409 warming" });
      const a = yield* Effect.flip(runRepoCheck(2).pipe(Effect.provide(refused.layer)));
      expect(a).toMatchObject({ _tag: "NotRun", message: "409 warming" });
      expect(refused.calls).toEqual(["create acme/app 2"]);
      const lost = fake({ workers: 2, plan: PLAN, lose: true });
      const b = yield* Effect.flip(runRepoCheck(2).pipe(Effect.provide(lost.layer)));
      expect(b).toMatchObject({ _tag: "NotRun", message: "worker chk-c-1 was lost: mm2 left the fleet" });
      expect(lost.calls.at(-1)).toBe("end c");
    }),
  );
});
