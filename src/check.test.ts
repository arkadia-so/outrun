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
  patchBody,
  Repo,
  runRepoCheck,
  splitUnits,
  timeUnits,
  type Unit,
  waitFor,
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
  // The push's base (Repo `base`), absent: a clone with no remote main.
  base?: string;
  durations?: Record<string, number>;
  shas?: string[];
  // The shards a dead VM leaves unfinished (code -1), and whether the shards never answer.
  crash?: number[];
  silent?: boolean;
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
    patch: (_id, sha, patches, message, change) =>
      Effect.sync(() => {
        calls.push(`patch ${patches[sha]}`);
        if (Object.keys(patches).length > 1) calls.push(`patches ${Object.values(patches).join(", ")}`);
        if (message) calls.push(`message ${message}`);
        if (change !== undefined) calls.push(`change ${change}`);
        if (opts.lose) return void push({ worker: names[1]!, step: "lost", code: -1, json: {}, log: "mm2 left the fleet" });
        names.forEach((worker, i) =>
          push({ worker, step: "apply", code: 0, json: i === 0 ? { apply: 300, plan: 4000, ...(opts.plan ? { units: opts.plan } : {}) } : { apply: 300 } }),
        );
      }),
    shards: (_id, shards) =>
      Effect.sync(() => {
        calls.push(`shards ${JSON.stringify(shards)}`);
        if (opts.silent) return;
        for (const shard of shards) {
          const failed = opts.fail?.includes(shard.worker) ?? false;
          const crashed = opts.crash?.includes(shard.worker) ?? false;
          push({
            worker: names[shard.worker]!,
            step: "shard",
            code: crashed ? -1 : failed ? 1 : 0,
            log: failed ? `${shard.tasks[0]}: expected 1, got 2` : "",
            json: { tasks: shard.tasks.map((id, i) => ({ id, ms: 1000, cache: "MISS", exit: failed && i === 0 ? 1 : 0 })) },
          });
        }
      }),
    // A long poll: waits for an event (here, forever when there is none).
    events: (_id, after) =>
      Effect.suspend(() => {
        const later = events.filter((e) => e.seq > after);
        return later.length > 0 ? Effect.succeed(later) : Effect.never;
      }),
    end: (id) => Effect.sync(() => void calls.push(`end ${id}`)),
  });
  const repo = Layer.succeed(Repo, {
    name: Effect.succeed("acme/app"),
    patchFrom: (sha) => Effect.succeed(`diff from ${sha.slice(0, 4)}`),
    messageFrom: (sha) => Effect.succeed(opts.message === undefined ? "" : `${opts.message} (since ${sha.slice(0, 4)})`),
    base: Effect.succeed(opts.base ? { sha: opts.base, change: `diff from ${opts.base.slice(0, 4)}` } : undefined),
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
      expect(calls.slice(1, 3)).toEqual(["patch diff from aaaa", "message Fix the thing\n\nNo-Changelog: internal (since aaaa)"]);
    }),
  );

  it.effect("sends the push's change from its base, and the messages since that base, so a warm behind main plans only the push", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 1, plan: [], message: "Fix", base: "c".repeat(40) });
      yield* runRepoCheck(1).pipe(Effect.provide(layer));
      expect(calls.slice(1, 4)).toEqual(["patch diff from aaaa", "message Fix (since cccc)", "change diff from cccc"]);
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

  it.effect("a worker lost after its up failed says why the up failed, not only that it was lost", () =>
    Effect.gen(function* () {
      const events: CheckEvent[] = [
        { seq: 1, worker: "chk-c-0", step: "up", code: 1, ms: 5, json: {}, log: "setup: bun: command not found" },
        { seq: 2, worker: "chk-c-0", step: "lost", code: -1, ms: 0, json: {}, log: "apply: no VM chk-c-0 on this Mini" },
      ];
      const api = Layer.succeed(CheckApi, {
        events: (_id: string, after: number) => Effect.succeed(events.filter((e) => e.seq > after)),
      } as unknown as CheckApi["Service"]);
      const error = yield* Effect.flip(waitFor("c", 0, () => false, Date.now() + 5_000, Date.now()).pipe(Effect.provide(api)));
      expect(error).toMatchObject({ _tag: "NotRun", message: "worker chk-c-0: up exit 1: setup: bun: command not found" });
    }),
  );

  it.effect("says how many workers it got of those asked, and is not run with none", () =>
    Effect.gen(function* () {
      const one = fake({ workers: 1, plan: [] });
      yield* runRepoCheck(4).pipe(Effect.provide(one.layer));
      const none = fake({ workers: 0, plan: [] });
      const error = yield* Effect.flip(runRepoCheck(4).pipe(Effect.provide(none.layer)));
      expect(error).toMatchObject({ _tag: "NotRun", message: "the fleet gave no worker of the 4 asked" });
      expect(none.calls).toEqual(["create acme/app 4", "end c"]);
    }),
  );

  it.effect("says it was not run, never failed, when a shard's VM died under it (code -1, OUT-45)", () =>
    Effect.gen(function* () {
      const { calls, layer } = fake({ workers: 2, plan: PLAN, crash: [1] });
      const error = yield* Effect.flip(runRepoCheck(2).pipe(Effect.provide(layer)));
      expect(error).toMatchObject({ _tag: "NotRun" });
      expect(error.message).toMatch(/^chk-c-1 shard did not finish/);
      expect(calls.at(-1)).toBe("end c");
    }),
  );

  it.live("ends the check, not run, once its shards take the plan's expected time and CHECK_SLACK_MS", () =>
    Effect.gen(function* () {
      // Two units of 0.2 s measured: the cap is 0.2 s + CHECK_SLACK_MS after the shards are sent.
      const units = [
        { id: "a", ms: 0 },
        { id: "b", ms: 0 },
      ];
      const { calls, layer } = fake({ workers: 2, plan: units, durations: { a: 200, b: 200 }, silent: true });
      const t0 = Date.now();
      const error = yield* Effect.flip(runRepoCheck(2, 30_000, { slackMs: 300 }).pipe(Effect.provide(layer)));
      expect(error).toMatchObject({ _tag: "NotRun", message: "the check took too long (over 0.5 s)" });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(calls.at(-1)).toBe("end c");
    }),
  );
});

describe("the patch a check sends", () => {
  it("names every warm commit's patch when a worker starts from another commit than the check's, even alone", () => {
    expect(patchBody("aaaa", { aaaa: "on a" }, "m")).toEqual({ patch: "on a", message: "m" });
    expect(patchBody("aaaa", { bbbb: "on b" }, "m", "c")).toEqual({ patch: "", patches: { bbbb: "on b" }, message: "m", change: "c" });
    expect(patchBody("aaaa", { aaaa: "on a", bbbb: "on b" }, "m").patches).toEqual({ aaaa: "on a", bbbb: "on b" });
  });
});
