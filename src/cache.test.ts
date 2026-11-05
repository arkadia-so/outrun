import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { divergenceKey, githubOidc, quarantineKey, timingKey } from "./cache.ts";

describe("artifact keys", () => {
  it("keep a unit's timing and quarantine apart per toolchain, and apart from each other", () => {
    expect(timingKey("a.test.ts", "bun 1 linux-arm64")).not.toBe(timingKey("a.test.ts", "bun 1 darwin-arm64"));
    expect(quarantineKey("a.test.ts", "t")).not.toBe(timingKey("a.test.ts", "t"));
    expect(divergenceKey("a.test.ts", "t")).not.toBe(quarantineKey("a.test.ts", "t"));
  });
});

describe("githubOidc", () => {
  it("fails, saying why, when the job has no OIDC token, so a run never silently skips the remote cache", async () => {
    const exit = await Effect.runPromiseExit(githubOidc("https://cache.example.com", {}));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("id-token: write");
  });
});
