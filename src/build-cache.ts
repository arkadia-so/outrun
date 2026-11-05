// A build tool's own remote cache protocol, served on this machine and stored in outrun's remote
// cache. A repository keeps its build tool as its task runner and gets outrun's cache, its trust
// tiers included: an entry is written in the scope the job's own token gives it (a branch's writes
// never reach the trusted ref's), as for every verdict. Each entry is one artifact in the job's
// cache namespace, named by the protocol's prefix and the tool's own hash.
//
//   `outrun nx-cache`: Nx's self-hosted remote cache API (GET and PUT /v1/cache/{hash}, Nx 20.8+),
//     NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://127.0.0.1:<port>; artifacts `nx<hash>`.
//   `outrun bazel-cache`: Bazel's HTTP remote cache (GET, HEAD and PUT /ac/{sha256} and
//     /cas/{sha256}), --remote_cache=http://127.0.0.1:<port>; artifacts `bzac<hash>`, `bzcas<hash>`.
import { Console, Effect } from "effect";
import { Hono } from "hono";
import { CacheUnavailable } from "./errors.ts";
import { request } from "./upstream.ts";

export interface BuildCacheOptions {
  readonly url: string;
  readonly team: string;
  /** A token for the cache, fetched again when older than `tokenTtlMs` (an OIDC token is short-lived). */
  readonly token: Effect.Effect<string, CacheUnavailable>;
  readonly tokenTtlMs?: number;
  readonly timeoutMs?: number;
}

// Under the cache's own limit of 128 with the longest prefix (`bzcas`).
const HASH = /^[A-Za-z0-9]{1,120}$/;

/** A protocol: the paths it answers (`:hash` in each) and the artifact prefix of each path. */
interface Protocol {
  readonly name: string;
  readonly routes: readonly { readonly path: string; readonly prefix: string }[];
  /**
   * How a write the cache refused is answered: as stored (200), or as refused (503).
   * Nx fails the task on anything but 200 (measured on TanStack/query, ARK-81), so it gets 200.
   * Bazel must hear the refusal: a blob it believes stored is referenced by the action result it
   * writes next, and a later job that hits that result without the blob fails with "lost inputs"
   * (carbon-lang, ARK-81: blobs of 138 to 317 MB over the cache's size limit, answered 200, then
   * a macOS job retried its build 21 times in 55 min). Told the blob was refused, Bazel does not
   * write the action result, and the action runs again next time.
   */
  readonly refusedWrite: 200 | 503;
}

export const NX: Protocol = { name: "nx-cache", routes: [{ path: "/v1/cache/:hash", prefix: "nx" }], refusedWrite: 200 };
export const BAZEL: Protocol = {
  name: "bazel-cache",
  refusedWrite: 503,
  routes: [
    { path: "/ac/:hash", prefix: "bzac" },
    { path: "/cas/:hash", prefix: "bzcas" },
  ],
};

/** The Hono app answering the build tool: 200 with the entry, 404 when absent, 200 once stored. */
export const buildCacheApp = (protocol: Protocol, options: BuildCacheOptions) => {
  let cached: { token: string; at: number } | undefined;
  const token = Effect.gen(function* () {
    if (cached && Date.now() - cached.at < (options.tokenTtlMs ?? 4 * 60_000)) return cached.token;
    const fresh = yield* options.token;
    cached = { token: fresh, at: Date.now() };
    return fresh;
  });
  const call = (artifact: string, init: RequestInit) =>
    token.pipe(
      Effect.flatMap((bearer) =>
        request({ url: options.url, team: options.team, token: bearer }, `/v8/artifacts/${artifact}`, init, options.timeoutMs ?? 120_000),
      ),
    );
  // A cache that cannot answer is a miss for the tool (it then runs the task), and a write it refuses is
  // logged, never a failed task.
  const run = (effect: Effect.Effect<Response, CacheUnavailable>, fallback: Response) =>
    // effect-lint-allow no-run-outside-boundary: a Hono handler is the HTTP boundary.
    Effect.runPromise(
      effect.pipe(Effect.catchTag("CacheUnavailable", (e) => Console.error(`outrun ${protocol.name}: ${e.message}`).pipe(Effect.as(fallback)))),
    );
  const app = new Hono();
  // Hono answers HEAD with the GET handler, without its body: Bazel's existence checks.
  for (const { path, prefix } of protocol.routes) {
    app.get(path, async (c) => {
      const hash = c.req.param("hash") ?? "";
      if (!HASH.test(hash)) return c.text("bad hash", 400);
      return run(
        call(`${prefix}${hash}`, { method: "GET" }).pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeed(new Response("The record was not found", { status: 404 }))
              : response.ok
                ? Effect.succeed(new Response(response.body.slice().buffer, { status: 200, headers: { "content-type": "application/octet-stream" } }))
                : Effect.fail(new CacheUnavailable({ message: `GET ${hash} answered ${response.status}` })),
          ),
          // A connection reset now and then (seen on TanStack/query, ARK-81): asked again, the
          // archive read whole so a reset mid-body is asked again too.
          Effect.retry({ times: 2 }),
        ),
        new Response("The record was not found", { status: 404 }),
      );
    });
    app.put(path, async (c) => {
      const hash = c.req.param("hash") ?? "";
      if (!HASH.test(hash)) return c.text("bad hash", 400);
      const body = await c.req.arrayBuffer();
      return run(
        call(`${prefix}${hash}`, {
          method: "PUT",
          body,
          headers: { "content-type": "application/octet-stream", "content-length": String(body.byteLength), "x-artifact-tag": prefix },
        }).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.succeed(new Response(null, { status: 200 }))
              : Effect.fail(new CacheUnavailable({ message: `PUT ${hash} answered ${response.status}` })),
          ),
          // Idempotent: the same hash is the same archive.
          Effect.retry({ times: 2 }),
        ),
        // Not stored: answered as the protocol needs (`refusedWrite`); a cache must never fail a task.
        new Response(null, { status: protocol.refusedWrite }),
      );
    });
  }
  return app;
};
