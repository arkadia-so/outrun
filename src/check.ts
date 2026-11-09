// `outrun check`: the repository's fast CI on the tree of HEAD, run on outrun's Linux VMs instead of
// this machine (DESIGN.md §12), as the repository declares it in its `.outrun/check.json` (README.md,
// "outrun check"; DESIGN.md §12.7).
// One check: its workers placed at the priority tier on VMs restored from a warm checkout (a commit
// of main), HEAD's tree sent as a patch on that commit, the first worker's plan (the units to run,
// each with its expected time) split over the workers by longest processing time first (outrun's
// own `shard`, balance.ts; the units of one group stay on one worker), each shard through
// the declaration's `run`, the verdicts fanned back in.
//
// Exit 0: every unit passed. 1: one failed (its log printed). 3: the fleet did not run it
// (unreachable, no warm checkout yet, no VM free, a worker lost): the caller decides what to do;
// this command never falls back to a local run on its own.
// Needs OUTRUN_API_TOKEN, an installation's API token (`ort_…`), and its installation id
// (OUTRUN_INSTALLATION or --installation); OUTRUN_API, the control plane (https://api.outrun.sh). OUTRUN_GITHUB_TOKEN, a GitHub token that may read the
// repository, is sent with the check (header X-GitHub-Token) so the Minis fetch their mirror of a
// private repository before building its warm checkout (used for that fetch only, never stored);
// without it the warms stay at the commit their mirror has.
import { spawn } from "node:child_process";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { shard } from "./balance.ts";

// The check protocol this client speaks (the control plane refuses another): 2, the units of the
// repository's own declaration.
const CHECK_PROTOCOL = 2;
// A unit the plan gives no time for counts for this much, so unknown units still spread.
const UNKNOWN_UNIT_MS = 1000;
// How long one check may take, end to end.
const CHECK_MS = 10 * 60_000;

/** The fleet did not run the check (exit 3): why. */
export class NotRun extends Schema.TaggedError<NotRun>()("NotRun", { message: Schema.String }) {}
/** A check failed (exit 1); its report is printed already. */
class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {}) {}

export interface CheckEvent {
  readonly seq: number;
  readonly worker: string;
  readonly step: "up" | "apply" | "shard" | "down" | "warm" | "lost";
  readonly code: number;
  readonly ms: number;
  readonly json: Readonly<Record<string, unknown>>;
  readonly log: string;
}
export interface Created {
  readonly id: string;
  readonly sha: string;
  readonly workers: readonly { readonly name: string; readonly mini: string }[];
}

// The control plane's check routes (/v1/installations/:id/checks).
export class CheckApi extends Context.Service<
  CheckApi,
  {
    readonly create: (repo: string, workers: number) => Effect.Effect<Created, NotRun>;
    readonly patch: (id: string, patch: string) => Effect.Effect<void, NotRun>;
    readonly shards: (id: string, shards: readonly { worker: number; tasks: readonly string[] }[]) => Effect.Effect<void, NotRun>;
    readonly events: (id: string, after: number) => Effect.Effect<readonly CheckEvent[], NotRun>;
    readonly end: (id: string) => Effect.Effect<void>;
  }
>()("outrun/cli/CheckApi") {}

// The local repository: its GitHub name, and HEAD's tree as a patch on a given commit.
export class Repo extends Context.Service<
  Repo,
  {
    readonly name: Effect.Effect<string, NotRun>;
    readonly patchFrom: (sha: string) => Effect.Effect<string, NotRun>;
  }
>()("outrun/cli/Repo") {}

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

interface ShardTask {
  readonly id: string;
  readonly ms: number;
  readonly cache: string;
  readonly exit: number | null;
}
const shardTasks = (event: CheckEvent): ShardTask[] => {
  const tasks = event.json.tasks;
  return Array.isArray(tasks) ? (tasks as ShardTask[]) : [];
};
// A unit of the plan (the declaration's `plan` prints them): its id, its expected time (0: unknown),
// and its group: the units of one group run on one worker (they share a build, say).
export interface Unit {
  readonly id: string;
  readonly ms: number;
  readonly group?: string;
}
const planOf = (event: CheckEvent): Unit[] => {
  const units = event.json.units;
  return Array.isArray(units)
    ? units.flatMap((u): Unit[] =>
        u && typeof u === "object" && typeof u.id === "string"
          ? [{ id: u.id, ms: Number(u.ms) || 0, ...(typeof u.group === "string" && u.group ? { group: u.group } : {}) }]
          : [],
      )
    : [];
};

// The units over at most `n` workers, longest first to the least loaded (balance.ts `shard`), a
// group as one unit of its total time; workers left without a unit get no shard.
export const splitUnits = (units: readonly Unit[], n: number): string[][] => {
  const parts = new Map<string, { id: string; suite: string; durationMs: number; ids: string[] }>();
  for (const unit of units) {
    const key = unit.group === undefined ? `unit:${unit.id}` : `group:${unit.group}`;
    const part = parts.get(key) ?? { id: key, suite: "", durationMs: 0, ids: [] };
    part.durationMs += unit.ms > 0 ? unit.ms : UNKNOWN_UNIT_MS;
    part.ids.push(unit.id);
    parts.set(key, part);
  }
  return shard([...parts.values()], Math.max(1, Math.min(n, parts.size)))
    .map((share) => share.flatMap((part) => part.ids))
    .filter((ids) => ids.length > 0);
};

// The events until `done` says the check has what it waits for; a worker lost ends it.
const waitFor = (id: string, from: number, done: (events: readonly CheckEvent[]) => boolean, deadline: number) =>
  Effect.gen(function* () {
    const api = yield* CheckApi;
    const seen: CheckEvent[] = [];
    let after = from;
    while (!done(seen)) {
      if (Date.now() > deadline) return yield* new NotRun({ message: "the check took too long" });
      const more = yield* api.events(id, after);
      for (const event of more) {
        after = Math.max(after, event.seq);
        if (event.step === "lost") return yield* new NotRun({ message: `worker ${event.worker} was lost: ${event.log}` });
        seen.push(event);
      }
    }
    return { events: seen, after };
  });

// One check, end to end; the report on stdout.
export const runRepoCheck = (workers: number) =>
  Effect.gen(function* () {
    const api = yield* CheckApi;
    const repo = yield* Repo;
    const t0 = Date.now();
    const deadline = t0 + CHECK_MS;
    const name = yield* repo.name;
    const check = yield* api.create(name, workers);
    return yield* Effect.gen(function* () {
      const n = check.workers.length;
      const patch = yield* repo.patchFrom(check.sha);
      yield* api.patch(check.id, patch);
      // Every worker up and patched; the first's apply carries the plan.
      const ready = yield* waitFor(check.id, 0, (events) => events.filter((e) => e.step === "apply").length === n, deadline);
      const failed = ready.events.find((e) => e.code !== 0);
      if (failed) return yield* new NotRun({ message: `${failed.worker} ${failed.step}: exit ${failed.code}: ${failed.log.slice(-500)}` });
      const readyAt = Date.now();
      const first = ready.events.find((e) => e.step === "apply" && e.worker === check.workers[0]!.name)!;
      // A plan without its units is a Mac agent of the first protocol (turbo's tasks): not run,
      // never read as nothing to run.
      if (!Array.isArray(first.json.units))
        return yield* new NotRun({ message: `${first.worker}'s plan reported no units: its Mac agent predates the check declaration` });
      const tasks = planOf(first);
      const ups = ready.events.filter((e) => e.step === "up");
      const lines = [
        `outrun check: ${n} worker(s) on ${[...new Set(check.workers.map((w) => w.mini))].join(", ")}, main at ${check.sha.slice(0, 8)}`,
        `  up ${s(Math.max(...ups.map((e) => e.ms)))} · apply ${s(Number(first.json.apply ?? 0))} · plan ${s(Number(first.json.plan ?? 0))} · ready after ${s(readyAt - t0)}`,
      ];
      if (tasks.length === 0) {
        yield* Console.log([...lines, `  nothing to run · ${s(Date.now() - t0)}`].join("\n"));
        return;
      }
      const shards = splitUnits(tasks, n).map((ids, worker) => ({ worker, tasks: ids }));
      yield* api.shards(check.id, shards);
      const ran = yield* waitFor(check.id, ready.after, (events) => events.filter((e) => e.step === "shard").length === shards.length, deadline);
      const results = ran.events.filter((e) => e.step === "shard");
      const all = results.flatMap(shardTasks);
      const red = all.filter((t) => t.exit !== 0 && t.exit !== null);
      const slowest = [...all].sort((a, b) => b.ms - a.ms).slice(0, 3);
      lines.push(
        `  ${tasks.length} unit(s) in ${shards.length} shard(s): run ${s(Math.max(...results.map((e) => e.ms)))} (slowest: ${slowest.map((t) => `${t.id} ${s(t.ms)}`).join(", ")})`,
      );
      const broken = results.filter((e) => e.code !== 0);
      for (const event of broken) lines.push(`--- ${event.worker} ---`, event.log);
      lines.push(
        broken.length === 0 ? `  passed · ${s(Date.now() - t0)}` : `  FAILED: ${red.map((t) => t.id).join(", ") || "a shard"} · ${s(Date.now() - t0)}`,
      );
      yield* (broken.length === 0 ? Console.log : Console.error)(lines.join("\n"));
      if (broken.length > 0) return yield* new CheckFailed();
    }).pipe(Effect.ensuring(api.end(check.id)));
  });

const exec = (program: string, args: readonly string[]) =>
  Effect.callback<string, NotRun>((resume) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => resume(Effect.fail(new NotRun({ message: `${program}: ${error.message}` }))));
    child.on("close", (code) =>
      resume(
        code === 0 ? Effect.succeed(Buffer.concat(out).toString("utf8")) : Effect.fail(new NotRun({ message: `${program} ${args.join(" ")}: ${err.trim()}` })),
      ),
    );
  });

const RepoLive = Layer.succeed(Repo, {
  name: exec("git", ["remote", "get-url", "origin"]).pipe(
    Effect.flatMap((url) => {
      const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(url);
      return match ? Effect.succeed(match[1]!) : Effect.fail(new NotRun({ message: `origin is not a GitHub repository: ${url.trim()}` }));
    }),
  ),
  // The warm commit fetched if this clone lacks it; then HEAD's whole tree against it.
  patchFrom: (sha) =>
    exec("git", ["cat-file", "-e", `${sha}^{commit}`]).pipe(
      Effect.catchTag("NotRun", () => exec("git", ["fetch", "-q", "origin", sha])),
      Effect.andThen(exec("git", ["diff", "--binary", "--no-color", "--no-ext-diff", sha, "HEAD"])),
    ),
});

const checkApiLive = (api: string, installation: string, token: string, githubToken: string | undefined) => {
  const base = `${api}/v1/installations/${installation}/checks`;
  const request = (path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }, timeoutMs = 30_000) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${base}${path}`, {
          method: init.method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
      },
      catch: (cause) => new NotRun({ message: `the control plane: ${String(cause)}` }),
    }).pipe(
      Effect.flatMap((answer) =>
        answer.status < 300
          ? Effect.succeed(answer.body)
          : Effect.fail(
              new NotRun({
                message: `${init.method} ${path || "/"}: ${answer.status} ${String(answer.body.refused ?? "")} ${String(answer.body.error ?? "")}`.trim(),
              }),
            ),
      ),
    );
  return Layer.succeed(CheckApi, {
    create: (repo, workers) =>
      request("", {
        method: "POST",
        body: { protocol: CHECK_PROTOCOL, repo, workers },
        ...(githubToken ? { headers: { "x-github-token": githubToken } } : {}),
      }).pipe(Effect.map((body) => body as unknown as Created)),
    patch: (id, patch) => request(`/${id}/patch`, { method: "POST", body: { patch } }).pipe(Effect.asVoid),
    shards: (id, shards) => request(`/${id}/shards`, { method: "POST", body: { shards } }).pipe(Effect.asVoid),
    events: (id, after) =>
      request(`/${id}/events?after=${after}`, { method: "GET" }, 40_000).pipe(Effect.map((body) => (body.events ?? []) as readonly CheckEvent[])),
    // The end is a courtesy: the control plane drops a check its caller left (DEMAND_STALE_MS).
    end: (id) =>
      request(`/${id}`, { method: "DELETE" }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotRun", () => Effect.void),
      ),
  });
};

const flags = {
  workers: Flag.Int("workers").pipe(Flag.withDescription("VMs to fan the units over (1 to 8)"), Flag.withDefault(4)),
  installation: Flag.String("installation").pipe(
    Flag.withDescription("the installation id the token belongs to (default: OUTRUN_INSTALLATION)"),
    Flag.withDefault(""),
  ),
};
const handler = ({ workers, installation }: { readonly workers: number; readonly installation: string }) =>
  Effect.gen(function* () {
    const token = process.env.OUTRUN_API_TOKEN;
    if (!token) return yield* new NotRun({ message: "OUTRUN_API_TOKEN is not set (an installation's API token)" });
    const id = installation || process.env.OUTRUN_INSTALLATION || "";
    if (!/^\d+$/.test(id))
      return yield* new NotRun({ message: "no installation: set OUTRUN_INSTALLATION or pass --installation (its GitHub App installation id)" });
    if (workers < 1 || workers > 8) return yield* new NotRun({ message: "--workers is 1 to 8" });
    const api = process.env.OUTRUN_API ?? "https://api.outrun.sh";
    const githubToken = process.env.OUTRUN_GITHUB_TOKEN || undefined;
    if (!githubToken) yield* Console.error("outrun check: OUTRUN_GITHUB_TOKEN is not set: the warm checkouts stay at the commit the Minis' mirrors have");
    return yield* runRepoCheck(workers).pipe(Effect.provide(Layer.merge(checkApiLive(api, id, token, githubToken), RepoLive)));
  });

export const checkCommand = Command.make("check", flags, handler).pipe(
  Command.withDescription("HEAD's tree through the repository's .outrun/check.json on the fleet's Linux VMs (exit 0 passed, 1 failed, 3 not run)"),
);
