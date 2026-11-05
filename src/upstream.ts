// The one HTTP client to the remote cache: every call outrun makes to it (verdict lookups and
// records, read sets, `outrun nx-cache` and `bazel-cache`) goes through `request`, and it is gentle
// with new connections, so a run does not depend on how the network handles a burst of SYNs.
//
// Measured on outrun-linux-arm64 (slirp NAT, ARK-25, 2026-11-05): a burst of new connections loses
// SYNs, and Linux resends a lost one after 1, 2, 4... 32 s. curl at 8 in parallel had no slow
// connect, at 32 it had 48 of 600, at 64 75; Bun's fetch at 32, which also opens one socket per
// address of the host (two A, two AAAA for cache.outrun.sh), took 73.7 s for what took 7.2 s with
// one address pinned. The Nx replay through nx-cache opened 1,671 attempts in bursts of up to 355
// within 5 ms and sat 167 s in silence. So, per origin:
//   - one keep-alive pool (a Bun.FetchSession), every answer read whole, so its connection is
//     handed back to the pool rather than left to the garbage collector;
//   - at most UPSTREAM_CONCURRENCY requests in flight, so at most that many connections ever open;
//   - the host resolved once, and one address used, the families interleaved (RFC 8305), so a
//     connection is one SYN to one address; a request that fails moves the origin to the next
//     address, which the caller's retry then uses.
import { Effect, Semaphore } from "effect";
import { CacheUnavailable } from "./errors.ts";

export interface Remote {
  readonly url: string;
  readonly team: string;
  readonly token: string;
}

/** The most requests in flight to one origin: curl's widest burst with no slow connect (above). */
export const UPSTREAM_CONCURRENCY = 8;

/** An answer, its body read whole. */
interface Answer {
  readonly status: number;
  readonly ok: boolean;
  readonly body: Uint8Array;
}

interface Address {
  readonly address: string;
  readonly family: 4 | 6;
}

/** The addresses in the order they are tried: the resolver's, alternating families (RFC 8305 §4). */
export const interleave = (addresses: readonly Address[]): Address[] => {
  const first = addresses[0]?.family;
  const same = addresses.filter((a) => a.family === first);
  const other = addresses.filter((a) => a.family !== first);
  return Array.from({ length: Math.max(same.length, other.length) }, (_, i) => [same[i], other[i]]).flatMap((pair) =>
    pair.filter((a): a is Address => a !== undefined),
  );
};

const isIp = (host: string) => /^[\d.]+$/.test(host) || host.startsWith("[");

class Origin {
  readonly permits = Semaphore.makeUnsafe(UPSTREAM_CONCURRENCY);
  readonly #url: URL;
  readonly #session: Bun.FetchSession;
  #addresses: Promise<Address[]> | undefined;
  #current = 0;

  constructor(origin: string) {
    this.#url = new URL(origin);
    // The certificate is checked against the host's name while the connection goes to its address.
    this.#session = new Bun.FetchSession(this.#url.protocol === "https:" ? { tls: { serverName: this.#url.hostname } } : {});
  }

  /** The address to connect to now, resolved once (a failed lookup is asked again next time). */
  #address() {
    if (isIp(this.#url.hostname)) return Promise.resolve(undefined);
    this.#addresses ??= Bun.dns.lookup(this.#url.hostname, {}).then(
      (found) => interleave(found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))),
      (error: unknown) => {
        this.#addresses = undefined;
        throw error;
      },
    );
    return this.#addresses.then((addresses) => addresses[this.#current % addresses.length]);
  }

  async fetch(path: string, init: RequestInit, signal: AbortSignal): Promise<Answer> {
    const address = await this.#address();
    const target = new URL(path, this.#url);
    if (address) target.hostname = address.family === 6 ? `[${address.address}]` : address.address;
    const headers = new Headers(init.headers);
    headers.set("host", this.#url.host);
    try {
      const response = await this.#session.fetch(target, { ...init, signal, headers });
      return { status: response.status, ok: response.ok, body: new Uint8Array(await response.arrayBuffer()) };
    } catch (error) {
      // Concurrent failures on one address move the origin on once, not once each.
      if (address && (await this.#address()) === address) this.#current++;
      throw error;
    }
  }
}

const origins = new Map<string, Origin>();
const originOf = (url: string) => {
  const key = new URL(url).origin;
  let origin = origins.get(key);
  if (!origin) origins.set(key, (origin = new Origin(key)));
  return origin;
};

/** One call to the cache, with its own timeout, counted from when it may start. */
export const request = (remote: Remote, path: string, init: RequestInit, timeoutMs = 20_000) => {
  const origin = originOf(remote.url);
  const base = new URL(remote.url).pathname.replace(/\/$/, "");
  const full = `${base}${path}${path.includes("?") ? "&" : "?"}slug=${encodeURIComponent(remote.team)}`;
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${remote.token}`);
  return Effect.tryPromise({
    try: (signal) => origin.fetch(full, { ...init, headers }, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])),
    catch: (error) => new CacheUnavailable({ message: `${init.method ?? "GET"} ${path}: ${error instanceof Error ? error.message : String(error)}` }),
  }).pipe(origin.permits.withPermits(1));
};
