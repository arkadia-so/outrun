// Nx's self-hosted cache API over a stand-in for outrun's remote cache (Turborepo's v8 artifacts).
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { BAZEL, buildCacheApp, NX } from "./build-cache.ts";

let resetOnce = false;
const stored = new Map<string, Uint8Array>();
const seen: string[] = [];
const upstream = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname} ${url.searchParams.get("slug")} ${request.headers.get("authorization")}`);
    const key = url.pathname;
    if (key.endsWith("/nxflaky") && !resetOnce) {
      resetOnce = true;
      return new Response("reset", { status: 502 });
    }
    if (request.method === "PUT" && key.includes("toolarge")) return new Response("too large", { status: 413 });
    if (request.method === "PUT") {
      stored.set(key, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 202 });
    }
    const body = stored.get(key);
    return body ? new Response(body.slice().buffer) : new Response("not found", { status: 404 });
  },
});
afterAll(() => upstream.stop(true));

let tokens = 0;
const app = buildCacheApp(NX, { url: `http://127.0.0.1:${upstream.port}`, team: "t1", token: Effect.sync(() => `tok${++tokens}`), tokenTtlMs: 60_000 });

describe("outrun nx-cache", () => {
  it("answers a miss 404, stores an archive and serves it back, under the team and the job's token", async () => {
    expect((await app.request("/v1/cache/123")).status).toBe(404);
    const archive = new Uint8Array([0, 1, 2, 255, 7]);
    const put = await app.request("/v1/cache/123", { method: "PUT", body: archive.slice().buffer, headers: { "content-length": "5" } });
    expect(put.status).toBe(200);
    const got = await app.request("/v1/cache/123");
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(archive);
    expect(seen.at(-1)).toBe("GET /v8/artifacts/nx123 t1 Bearer tok1");
    expect(tokens).toBe(1);
  });

  it("answers a miss when the cache cannot be reached, and a refused write as stored, so Nx never fails a task for it", async () => {
    const down = buildCacheApp(NX, { url: "http://127.0.0.1:1", team: "t1", token: Effect.succeed("x"), timeoutMs: 2000 });
    expect((await down.request("/v1/cache/9")).status).toBe(404);
    expect((await down.request("/v1/cache/9", { method: "PUT", body: "x" })).status).toBe(200);
  });

  it("asks again when the cache fails once, so a reset is not a miss", async () => {
    stored.set("/v8/artifacts/nxflaky", new Uint8Array([4, 2]));
    const got = await app.request("/v1/cache/flaky");
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([4, 2]));
  });

  it("refuses a hash that is not one", async () => {
    expect((await app.request("/v1/cache/..%2Fx")).status).toBe(400);
  });
});

describe("outrun bazel-cache", () => {
  const bazel = buildCacheApp(BAZEL, { url: `http://127.0.0.1:${upstream.port}`, team: "t2", token: Effect.succeed("b"), tokenTtlMs: 60_000 });
  const digest = "a".repeat(64);

  it("stores action results and blobs apart, under bzac and bzcas, and answers HEAD for an existence check", async () => {
    expect((await bazel.request(`/cas/${digest}`)).status).toBe(404);
    expect((await bazel.request(`/cas/${digest}`, { method: "PUT", body: "blob" })).status).toBe(200);
    expect((await bazel.request(`/ac/${digest}`, { method: "PUT", body: "result" })).status).toBe(200);
    expect(await (await bazel.request(`/cas/${digest}`)).text()).toBe("blob");
    expect(await (await bazel.request(`/ac/${digest}`)).text()).toBe("result");
    expect(seen.at(-1)).toBe(`GET /v8/artifacts/bzac${digest} t2 Bearer b`);
    const head = await bazel.request(`/cas/${digest}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await bazel.request(`/ac/${"b".repeat(64)}`, { method: "HEAD" })).status).toBe(404);
  });

  it("answers a blob the cache refused as refused, so Bazel never writes an action result pointing at a missing blob", async () => {
    expect((await bazel.request("/cas/toolarge1", { method: "PUT", body: "big" })).status).toBe(503);
    expect((await app.request("/v1/cache/toolarge2", { method: "PUT", body: "big" })).status).toBe(200);
  });

  it("answers only Bazel's paths", async () => {
    expect((await bazel.request("/v1/cache/123")).status).toBe(404);
    expect((await app.request(`/cas/${digest}`)).status).toBe(404);
  });
});
