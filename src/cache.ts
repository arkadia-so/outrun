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
import { Effect } from "effect";
import { CacheUnavailable, FileFailed } from "./errors.ts";

export interface CacheEntry {
  readonly durationMs: number;
  readonly tag: string;
}

export interface Remote {
  readonly url: string;
  readonly team: string;
  readonly token: string;
}

// Measured from a fleet runner (ARK-81, 2026-11-03): the server answers a 100-hash query in 3.6 s
// (it heads each hash in storage, a few at a time) and a GET or PUT in 0.3-0.8 s, while 16
// parallel requests take as long as one. So the client asks small and wide.
const QUERY_SIZE = 10;
const CONCURRENCY = 64;

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
/** The artifact holding a unit's last measured duration. */
export const timingKey = (unitId: string, toolchain: string) => sha256(`outrun-timing-1\n${toolchain}\n${unitId}`);

/** The artifact marking a unit as flaky (quarantined): present and fresh = quarantined. */
export const quarantineKey = (unitId: string, toolchain: string) => sha256(`outrun-quarantine-1\n${toolchain}\n${unitId}`);
/** The artifact marking a suite whose audited verdict diverged: its verdicts are not replayed while fresh. */
export const divergenceKey = (suite: string, toolchain: string) => sha256(`outrun-diverged-1\n${toolchain}\n${suite}`);
/** The artifact holding a suite's traced read sets (keys.ts). */
export const readSetsKey = (suite: string, toolchain: string) => sha256(`outrun-readsets-1\n${toolchain}\n${suite}`);

/** One call to the cache, with its own timeout: every client of the cache goes through it. */
export const request = (remote: Remote, path: string, init: RequestInit, timeoutMs = 20_000) =>
  Effect.tryPromise({
    try: async (signal) => {
      const url = `${remote.url}${path}${path.includes("?") ? "&" : "?"}slug=${encodeURIComponent(remote.team)}`;
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: { authorization: `Bearer ${remote.token}`, ...init.headers },
      });
      return response;
    },
    catch: (error) => new CacheUnavailable({ message: `${init.method ?? "GET"} ${path}: ${error instanceof Error ? error.message : String(error)}` }),
  });

/** The entries of these artifacts (null when absent), from the batch query. */
export const query = (remote: Remote, hashes: readonly string[]) =>
  Effect.gen(function* () {
    const chunks: string[][] = [];
    for (let i = 0; i < hashes.length; i += QUERY_SIZE) chunks.push(hashes.slice(i, i + QUERY_SIZE));
    const answers = yield* Effect.forEach(
      chunks,
      (chunk) =>
        request(remote, "/v8/artifacts", { method: "POST", body: JSON.stringify({ hashes: chunk }), headers: { "content-type": "application/json" } }).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.tryPromise({
                  try: () => response.json() as Promise<Record<string, { taskDurationMs?: number; tag?: string } | null>>,
                  catch: () => new CacheUnavailable({ message: "the batch query's answer is not JSON" }),
                })
              : Effect.fail(new CacheUnavailable({ message: `the batch query answered ${response.status}` })),
          ),
          // A connection reset now and then (seen at 64 at once): asked again, and a chunk still
          // unanswered is only these hashes missing, not the whole lookup.
          Effect.retry({ times: 2 }),
          Effect.result,
        ),
      { concurrency: CONCURRENCY },
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
          ? Effect.tryPromise({ try: () => response.text(), catch: () => new CacheUnavailable({ message: `GET ${hash}: the body did not arrive` }) })
          : Effect.fail(new CacheUnavailable({ message: `GET ${hash} answered ${response.status}` })),
    ),
  );

/** Stores artifacts; returns how many the server refused (reported, not fatal: a cache). */
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
        Effect.retry({ times: 2 }),
        Effect.map((response) => (response.ok ? 0 : 1)),
      ),
    { concurrency: CONCURRENCY },
  ).pipe(Effect.map((refused) => refused.reduce<number>((a, b) => a + b, 0)));

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
