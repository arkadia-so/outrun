// The client to the remote cache against a fake one behind counting TCP listeners: how many
// connections each address of the host received, and how many requests were in flight at once.
import type { Socket, TCPSocketListener } from "bun";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { interleave, request, UPSTREAM_CONCURRENCY } from "./upstream.ts";

let inFlight = 0;
let mostInFlight = 0;
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await Bun.sleep(10);
    inFlight--;
    return new Response(`${req.headers.get("host")} ${req.headers.get("authorization")} ${new URL(req.url).search}`);
  },
});

interface Pipe {
  up?: Socket<undefined>;
  pending: Uint8Array[];
}
/** A TCP listener on `hostname` forwarding to the fake cache, counting the connections it accepts. */
const counting = (hostname: string, port = 0) => {
  const counter = { opened: 0, listener: undefined as TCPSocketListener<Pipe> | undefined };
  counter.listener = Bun.listen<Pipe>({
    hostname,
    port,
    socket: {
      open(client) {
        counter.opened++;
        client.data = { pending: [] };
        void Bun.connect({
          hostname: "127.0.0.1",
          port: backend.port ?? 0,
          socket: {
            open(up) {
              client.data.up = up;
              for (const chunk of client.data.pending) up.write(chunk);
            },
            data: (_up, chunk) => void client.write(chunk),
            close: () => {
              client.end();
            },
          },
        });
      },
      data(client, chunk) {
        if (client.data.up) client.data.up.write(chunk);
        else client.data.pending.push(new Uint8Array(chunk));
      },
      close: (client) => {
        client.data.up?.end();
      },
    },
  });
  return counter;
};
const listeners: { listener: TCPSocketListener<Pipe> | undefined }[] = [];
afterAll(() => {
  for (const l of listeners) l.listener?.stop(true);
  void backend.stop(true);
});

const remoteAt = (url: string) => ({ url, team: "t1", token: "tok" });
const ask = (url: string, n: number) =>
  Effect.runPromise(
    Effect.forEach(
      Array.from({ length: n }, (_, i) => i),
      (i) => request(remoteAt(url), `/v8/artifacts/h${i}`, { method: "GET" }),
      {
        concurrency: "unbounded",
      },
    ),
  );

describe("the client to the remote cache", () => {
  it("reuses its keep-alive connections: 20 requests one after the other open one connection", async () => {
    const v4 = counting("127.0.0.1");
    listeners.push(v4);
    const url = `http://127.0.0.1:${v4.listener?.port}`;
    for (let i = 0; i < 20; i++) {
      const answer = await Effect.runPromise(request(remoteAt(url), "/v8/artifacts/x", { method: "GET" }));
      expect(new TextDecoder().decode(answer.body)).toBe(`127.0.0.1:${v4.listener?.port} Bearer tok ?slug=t1`);
    }
    expect(v4.opened).toBe(1);
  });

  it("keeps at most UPSTREAM_CONCURRENCY requests in flight and as many connections, however many its callers ask at once", async () => {
    const v4 = counting("127.0.0.1");
    listeners.push(v4);
    mostInFlight = 0;
    const answers = await ask(`http://127.0.0.1:${v4.listener?.port}`, 200);
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(mostInFlight).toBe(UPSTREAM_CONCURRENCY);
    expect(v4.opened).toBeLessThanOrEqual(UPSTREAM_CONCURRENCY);
  });

  // localhost with an address of each family (where the machine has both): Bun's own fetch opens a
  // socket to each address per connection.
  const localhost = async (ctx: { skip: () => void }) => {
    const found = interleave((await Bun.dns.lookup("localhost", {})).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    if (found.length < 2 || found[0]?.family === found[1]?.family) ctx.skip();
    return found;
  };

  it("connects to one address of a host that has several, never to each of them", async (ctx) => {
    const addresses = await localhost(ctx);
    const first = counting(addresses[0]?.address ?? "");
    const second = counting(addresses[1]?.address ?? "", first.listener?.port);
    listeners.push(first, second);
    const answers = await ask(`http://localhost:${first.listener?.port}`, 100);
    expect(new TextDecoder().decode(answers[0]?.body)).toContain(`localhost:${first.listener?.port} `);
    expect(second.opened).toBe(0);
    expect(first.opened).toBeLessThanOrEqual(UPSTREAM_CONCURRENCY);
  });

  it("moves to the host's next address, of the other family, when the first one fails", async (ctx) => {
    const addresses = await localhost(ctx);
    const second = counting(addresses[1]?.address ?? "");
    listeners.push(second);
    const url = `http://localhost:${second.listener?.port}`;
    // The first address refuses: that request fails, the caller's retry goes to the second.
    const answer = await Effect.runPromise(request(remoteAt(url), "/v8/artifacts/x", { method: "GET" }).pipe(Effect.retry({ times: 1 })));
    expect(answer.status).toBe(200);
    await ask(url, 50);
    expect(second.opened).toBeLessThanOrEqual(UPSTREAM_CONCURRENCY);
  });
});

describe("interleave", () => {
  it("keeps the resolver's first address and alternates the families after it", () => {
    const a = (address: string, family: 4 | 6) => ({ address, family });
    expect(interleave([a("v6a", 6), a("v6b", 6), a("v4a", 4), a("v4b", 4)]).map((x) => x.address)).toEqual(["v6a", "v4a", "v6b", "v4b"]);
    expect(interleave([a("v4a", 4), a("v4b", 4), a("v6a", 6)]).map((x) => x.address)).toEqual(["v4a", "v6a", "v4b"]);
    expect(interleave([a("v4a", 4)]).map((x) => x.address)).toEqual(["v4a"]);
  });
});
