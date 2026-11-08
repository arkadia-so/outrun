// The verdict cache, on Turborepo's remote cache protocol (v8): a passing unit's key is stored
// as an artifact, so any later run with the same key replays the pass. Each artifact carries its
// duration (x-artifact-duration) and a tag (x-artifact-tag) naming the run that wrote it; one
// batch query (POST /v8/artifacts) answers for 100 keys at once with both.
//
// Trust tiers are the server's: a run on the repository's main branch writes the shared level,
// any other run (a pull request, a branch, a fork) its own, which main never reads, and a
// developer's machine never writes what CI replays. The client only sends who it is: a GitHub
// Actions job its OIDC token, anything else a token from the environment.
//
// The artifacts: a unit's verdict (keyed by a strong key: present = passed, its body the Verdict
// record), its timing (keyed by its id and toolchain: the last duration measured, whatever the
// key), its quarantine marker, a suite's divergence marker and a suite's traced read sets. Tags
// (verdict.ts) carry the writing run, the time and the tier, so the batch query alone decides.
//
// Durations are one artifact per unit rather than one record per package: shards of a run write
// them at once, and per-unit artifacts need no merge (a lost merge would only cost balance).
import { mkdir } from "node:fs/promises";
import { Effect, Schedule } from "effect";
import { CacheUnavailable, FileFailed } from "./errors.ts";
import { type Remote, request, UPSTREAM_CONCURRENCY } from "./upstream.ts";

export interface CacheEntry {
  readonly durationMs: number;
  readonly tag: string;
}

// The most hashes the server's batch query answers for (platform/turbo-cache MAX_QUERY). The client
// asks for that many at once: a lookup is bound by its round trips, since it may have only
// UPSTREAM_CONCURRENCY requests in flight (upstream.ts: wider bursts of new connections lose SYNs
// on the fleet). Measured on opencode's plan (ARK-81, 2026-11-06, ~3,950 hashes): in 10-hash
// queries, 395 requests took 48-67 s, each 0.13 s (p50) in the Worker and 0.6-1.0 s more outside it.
const QUERY_SIZE = 100;
// A 100-hash query heads up to 200 objects six at a time, and may decide its caller's access first
// (2-15 s when it does, outrun/control-plane verdict-cache.ts): more than a request's default
// 20 s, and a query that times out costs its hashes, so up to a hundred units run again.
const QUERY_TIMEOUT_MS = 60_000;

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
/** The artifact holding a unit's last measured duration. */
export const timingKey = (unitId: string, toolchain: string) => sha256(`outrun-timing-1\n${toolchain}\n${unitId}`);

/** The artifact marking a unit as flaky (quarantined): present and fresh = quarantined. */
export const quarantineKey = (unitId: string, toolchain: string) => sha256(`outrun-quarantine-1\n${toolchain}\n${unitId}`);
/** The artifact marking a suite whose audited verdict diverged: its verdicts are not replayed while fresh. */
export const divergenceKey = (suite: string, toolchain: string) => sha256(`outrun-diverged-1\n${toolchain}\n${suite}`);
/** The artifact holding a suite's traced read sets (keys.ts). */
export const readSetsKey = (suite: string, toolchain: string) => sha256(`outrun-readsets-1\n${toolchain}\n${suite}`);

/** The entries of these artifacts (null when absent), from the batch query. */
export const query = (remote: Remote, hashes: readonly string[]) =>
  Effect.gen(function* () {
    const chunks: string[][] = [];
    for (let i = 0; i < hashes.length; i += QUERY_SIZE) chunks.push(hashes.slice(i, i + QUERY_SIZE));
    const answers = yield* Effect.forEach(
      chunks,
      (chunk) =>
        request(
          remote,
          "/v8/artifacts",
          { method: "POST", body: JSON.stringify({ hashes: chunk }), headers: { "content-type": "application/json" } },
          QUERY_TIMEOUT_MS,
        ).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.try({
                  try: () => JSON.parse(new TextDecoder().decode(response.body)) as Record<string, { taskDurationMs?: number; tag?: string } | null>,
                  catch: () => new CacheUnavailable({ message: "the batch query's answer is not JSON" }),
                })
              : Effect.fail(new CacheUnavailable({ message: `the batch query answered ${response.status}` })),
          ),
          // A connection reset now and then (seen at 64 at once): asked again, and a chunk still
          // unanswered is only these hashes missing, not the whole lookup.
          Effect.retry({ times: 2 }),
          Effect.result,
        ),
      { concurrency: UPSTREAM_CONCURRENCY },
    ).pipe(
      Effect.flatMap((results) => {
        const ok = results.flatMap((r) => (r._tag === "Success" ? [r.success] : []));
        const failed = results.find((r) => r._tag === "Failure");
        return ok.length === 0 && failed?._tag === "Failure" ? Effect.fail(failed.failure) : Effect.succeed(ok);
      }),
    );
    const out = new Map<string, CacheEntry>();
    for (const answer of answers)
      for (const [hash, entry] of Object.entries(answer)) if (entry) out.set(hash, { durationMs: entry.taskDurationMs ?? 0, tag: entry.tag ?? "" });
    return out;
  });

export interface Put {
  readonly hash: string;
  readonly body: string;
  readonly durationMs: number;
  readonly tag: string;
}

/** An artifact's body, or undefined when absent. */
export const get = (remote: Remote, hash: string, timeoutMs?: number) =>
  request(remote, `/v8/artifacts/${hash}`, { method: "GET" }, timeoutMs).pipe(
    Effect.flatMap((response) =>
      response.status === 404
        ? Effect.succeed(undefined)
        : response.ok
          ? Effect.succeed(new TextDecoder().decode(response.body))
          : Effect.fail(new CacheUnavailable({ message: `GET ${hash} answered ${response.status}` })),
    ),
  );

/** Pure: an answer worth asking again: the server or its storage was busy or briefly unreachable, not a refusal. */
const transient = (status: number) => status === 429 || status >= 500;

export interface Refused {
  /** How many writes the server did not take. */
  readonly count: number;
  /** Their last answers' statuses, "503 ×2" ("unreachable" for no answer), for the log line that reports them. */
  readonly statuses: string;
}

/**
 * Stores artifacts; returns what the server refused (reported, not fatal: a cache). A transient answer
 * (a 503 when the cache could not decide the caller's access in time, a 429 from the store) is asked
 * again with a backoff, as a failed connection is: on the cold run 42526792932 (OUT-45) 2 of 6 writes
 * came back non-ok once and were counted as refused, never retried.
 */
export const put = (remote: Remote, puts: readonly Put[]) =>
  Effect.forEach(
    puts,
    (p) =>
      request(remote, `/v8/artifacts/${p.hash}`, {
        method: "PUT",
        body: p.body,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(new TextEncoder().encode(p.body).byteLength),
          "x-artifact-duration": String(Math.max(0, Math.round(p.durationMs))),
          "x-artifact-tag": p.tag,
        },
      }).pipe(
        Effect.flatMap((response) =>
          transient(response.status)
            ? Effect.fail(new CacheUnavailable({ message: `PUT answered ${response.status}`, status: response.status }))
            : Effect.succeed(response),
        ),
        Effect.retry({ times: 3, schedule: Schedule.exponential("250 millis") }),
        Effect.map((response) => (response.ok ? undefined : String(response.status))),
        Effect.catchTag("CacheUnavailable", (e) => Effect.succeed(e.status === undefined ? "unreachable" : String(e.status))),
      ),
    { concurrency: UPSTREAM_CONCURRENCY },
  ).pipe(
    Effect.map((answers): Refused => {
      const counts = new Map<string, number>();
      for (const a of answers) if (a !== undefined) counts.set(a, (counts.get(a) ?? 0) + 1);
      return {
        count: [...counts.values()].reduce((a, b) => a + b, 0),
        statuses: [...counts].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(", "),
      };
    }),
  );

/** A GitHub Actions job's OIDC token for the cache's audience (needs `permissions: id-token: write`). */
export const githubOidc = (audience: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    // Said, never silent: a workflow without `id-token: write` would otherwise run cold forever (ARK-81).
    if (!url || !token)
      return yield* new CacheUnavailable({
        message: "no GitHub OIDC token (set `permissions: id-token: write` on the job, or OUTRUN_CACHE_TOKEN)",
      });
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${token}` }, signal }),
      catch: () => new CacheUnavailable({ message: "GitHub's OIDC token endpoint did not answer" }),
    });
    if (!response.ok) return yield* new CacheUnavailable({ message: `GitHub's OIDC token endpoint answered ${response.status}` });
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{ value?: string }>,
      catch: () => new CacheUnavailable({ message: "GitHub's OIDC answer is not JSON" }),
    });
    return body.value;
  });

/**
 * The local cache: one file per artifact under `dir`, its content `<durationMs> <tag>`. It holds
 * what this machine's runs wrote and what it replayed from the remote, so a re-run on the same
 * machine needs no network. An entry that is missing or unreadable is a miss.
 */
export class LocalCache {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }
  #path(hash: string) {
    return `${this.#dir}/${hash.slice(0, 2)}/${hash}`;
  }
  get(hashes: readonly string[]) {
    return Effect.forEach(
      hashes,
      (hash) =>
        Effect.tryPromise({
          try: async () => {
            const file = Bun.file(this.#path(hash));
            return (await file.exists()) ? await file.text() : undefined;
          },
          catch: () => new FileFailed({ message: `${this.#path(hash)}: unreadable` }),
        }).pipe(Effect.map((text) => [hash, text] as const)),
      { concurrency: 64 },
    ).pipe(
      Effect.map((read) => {
        const out = new Map<string, CacheEntry>();
        for (const [hash, text] of read) {
          if (text === undefined) continue;
          const space = text.indexOf(" ");
          out.set(hash, { durationMs: Number(text.slice(0, space)), tag: text.slice(space + 1) });
        }
        return out;
      }),
    );
  }
  set(entries: ReadonlyMap<string, CacheEntry>) {
    return Effect.forEach(
      [...entries],
      ([hash, entry]) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(`${this.#dir}/${hash.slice(0, 2)}`, { recursive: true });
            await Bun.write(this.#path(hash), `${Math.round(entry.durationMs)} ${entry.tag}`);
          },
          catch: () => new FileFailed({ message: `${this.#path(hash)}: not writable` }),
        }),
      { concurrency: 64, discard: true },
    );
  }
}
