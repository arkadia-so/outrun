// vitest-related: only in-memory fakes of the control plane and the repository.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  changeMessage,
  CheckApi,
  type CheckEvent,
  MESSAGE_MAX_CHARS,
  NotRun,
  overTarget,
  Repo,
  runRepoCheck,
  splitUnits,
  timeUnits,
  type Unit,
} from "./check.ts";

const SHA = "a".repeat(40);

// A control plane whose workers answer at once: `plan` is worker 0's plan, `fail` the shards that fail.
// `durations`: what the control plane learned of the units; `shas`: each worker's warm commit.
const fake = (opts: {
  workers: number;
  plan: Unit[] | undefined;
  fail?: number[];
  refuse?: string;
  lose?: boolean;
  message?: string;
  durations?: Record<string, number>;
  shas?: string[];
}) => {
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
        return Effect.succeed({
          id: "c",
          sha: SHA,
          workers: names.map((name, i) => ({ name, mini: `mm${i + 1}`, ...(opts.shas?.[i] ? { sha: opts.shas[i] } : {}) })),
          ...(opts.durations ? { durations: opts.durations } : {}),
        });
      }),
    patch: (_id, sha, patches, message) =>
      Effect.sync(() => {
        calls.push(`patch ${patches[sha]}`);
        if (Object.keys(patches).length > 1) calls.push(`patches ${Object.values(patches).join(", ")}`);
        if (message) calls.push(`message ${message}`);
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
    messageFrom: () => Effect.succeed(opts.message ?? ""),
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

describe("timeUnits", () => {
  it("times each unit by its last run, takes the plan's guess only for a unit never measured, else the measured units' median", () => {
    const timed = timeUnits(PLAN, { "test/a_test.dart": 2000, lint: 6000, fmt: 1000 });
    expect(timed.map((u) => [u.id, u.ms])).toEqual([
      ["test/a_test.dart", 2000],
      ["test/b_test.dart", 4000],
      ["lint", 6000],
      ["fmt", 1000],
      ["test/c_test.dart", 2000],
    ]);
  });
  it("falls back to the plan's guesses, and a second for a unit with none, when nothing was measured", () => {
    expect(timeUnits(PLAN, {}).map((u) => u.ms)).toEqual([9000, 4000, 3000, 2000, 1000]);
  });
});

describe("overTarget", () => {
  it("names the units, and the groups by their total, that alone take longer than the target", () => {
    expect(overTarget(timeUnits(PLAN, {}), 4500)).toEqual([
      ["test/a_test.dart", 9000],
      ["group js", 5000],
    ]);
  });
});

describe("changeMessage", () => {
  it("keeps one commit's message as is, its trailers already last", () => {
    expect(changeMessage("Fix it\n\nNo-Changelog: internal\n\n", "No-Changelog: internal\n\n")).toBe("Fix it\n\nNo-Changelog: internal");
    expect(changeMessage("Fix it\n", "\n")).toBe("Fix it");
  });
  it("ends several commits' messages with all their trailers, once each, so git reads every one as the commit's", () => {
    const bodies = "Second\n\nRefs: A-1\n\nFirst\n\nNo-Changelog: internal\nRefs: A-1\n";
    const trailers = "Refs: A-1\n\nNo-Changelog: internal\nRefs: A-1\n\n";
    expect(changeMessage(bodies, trailers)).toBe("Second\n\nRefs: A-1\n\nFirst\n\nNo-Changelog: internal\nRefs: A-1\n\nRefs: A-1\nNo-Changelog: internal");
  });
  it("cuts a long message to the control plane's bound, keeping the trailers", () => {
    const cut = changeMessage(`${"x".repeat(MESSAGE_MAX_CHARS)}\n\nOther: 1`, "No-Changelog: y\n");
    expect(cut.length).toBe(MESSAGE_MAX_CHARS);
    expect(cut.endsWith("\n\nNo-Changelog: y")).toBe(true);
  });
});

describe("outrun check", () => {
  it.effect("sends HEAD's tree on the warm commit, splits the first worker's plan by the units' times, and ends the check", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 3, plan: PLAN });
      yield* runRepoCheck(3).pipe(Effect.provide(layer));
      expect(calls[0]).toBe("create acme/app 3");
      expect(calls[1]).toBe("patch diff from aaaa");
      const expected = splitUnits(timeUnits(PLAN, {}), 3).map((tasks, worker) => ({ worker, tasks }));
      expect(calls[2]).toBe(`shards ${JSON.stringify(expected)}`);
      expect(calls.at(-1)).toBe("end c");
    }),
  );

  it.effect("balances the second run by the first's measured times, not the plan's guesses", () =>
    Effect.gen(function* () {
      // The plan guesses a_test is the longest; its last run says lint and fmt (one group) are.
      const { calls, layer } = fake({ workers: 2, plan: PLAN, durations: { "test/a_test.dart": 1000, "test/b_test.dart": 1000, lint: 8000, fmt: 4000 } });
      yield* runRepoCheck(2).pipe(Effect.provide(layer));
      expect(calls[2]).toBe(
        `shards ${JSON.stringify([
          { worker: 0, tasks: ["lint", "fmt"] },
          // c_test, never measured: the measured units' median, 4 s.
          { worker: 1, tasks: ["test/c_test.dart", "test/a_test.dart", "test/b_test.dart"] },
        ])}`,
      );
    }),
  );

  it.effect("sends a patch on each warm commit its workers start from", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 3, plan: [], shas: [SHA, "b".repeat(40), SHA] });
      yield* runRepoCheck(3).pipe(Effect.provide(layer));
      expect(calls.slice(1, 3)).toEqual(["patch diff from aaaa", "patches diff from aaaa, diff from bbbb"]);
    }),
  );

  it.effect("sends the change's commit messages with its patch, so a check reading a trailer sees it on the fleet", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 1, plan: [], message: "Fix the thing\n\nNo-Changelog: internal" });
      yield* runRepoCheck(1).pipe(Effect.provide(layer));
      expect(calls.slice(1, 3)).toEqual(["patch diff from aaaa", "message Fix the thing\n\nNo-Changelog: internal"]);
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
