import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { divergenceKey, githubOidc, put, quarantineKey, query, timingKey } from "./cache.ts";

describe("artifact keys", () => {
  it("keep a unit's timing and quarantine apart per toolchain, and apart from each other", () => {
    expect(timingKey("a.test.ts", "bun 1 linux-arm64")).not.toBe(timingKey("a.test.ts", "bun 1 darwin-arm64"));
    expect(quarantineKey("a.test.ts", "t")).not.toBe(timingKey("a.test.ts", "t"));
    expect(divergenceKey("a.test.ts", "t")).not.toBe(quarantineKey("a.test.ts", "t"));
  });
});

describe("query", () => {
  it("asks for as many hashes per request as the server answers for (100), so a lookup's round trips are as few as its in-flight cap allows", async () => {
    const sizes: number[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const { hashes } = (await req.json()) as { hashes: string[] };
        sizes.push(hashes.length);
        return Response.json(Object.fromEntries(hashes.map((h) => [h, h.endsWith("0") ? { taskDurationMs: 5, tag: "t" } : null])));
      },
    });
    try {
      const hashes = Array.from({ length: 1264 }, (_, i) => `h${i}`);
      const found = await Effect.runPromise(query({ url: `http://127.0.0.1:${server.port}`, team: "t", token: "x" }, hashes));
      expect(sizes.length).toBe(13);
      expect(Math.max(...sizes)).toBe(100);
      expect(found.size).toBe(127);
      expect(found.get("h1260")).toEqual({ durationMs: 5, tag: "t" });
    } finally {
      await server.stop(true);
    }
  });
});

describe("put", () => {
  it("asks again after a transient answer (503, 429), and reports what it still refused by status", async () => {
    const seen = new Map<string, number>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const hash = new URL(req.url).pathname.split("/").pop() as string;
        const n = (seen.get(hash) ?? 0) + 1;
        seen.set(hash, n);
        // "busy" is busy once, "down" always, "denied" refuses for good.
        if (hash === "busy" && n === 1) return new Response(null, { status: 503 });
        if (hash === "down") return new Response(null, { status: 503 });
        if (hash === "denied") return new Response(null, { status: 403 });
        return new Response(null, { status: 202 });
      },
    });
    try {
      const remote = { url: `http://127.0.0.1:${server.port}`, team: "t", token: "x" };
      const puts = ["ok", "busy", "down", "denied"].map((hash) => ({ hash, body: "{}", durationMs: 1, tag: "t" }));
      const refused = await Effect.runPromise(put(remote, puts));
      expect(refused).toEqual({ count: 2, statuses: "503, 403" });
      expect([seen.get("busy"), seen.get("down"), seen.get("denied")]).toEqual([2, 4, 1]);
    } finally {
      await server.stop(true);
    }
  });
});

describe("githubOidc", () => {
  it("fails, saying why, when the job has no OIDC token, so a run never silently skips the remote cache", async () => {
    const exit = await Effect.runPromiseExit(githubOidc("https://cache.example.com", {}));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("id-token: write");
  });
});
