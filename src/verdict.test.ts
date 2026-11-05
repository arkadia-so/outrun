import { describe, expect, it } from "vitest";
import { formatTag, MAX_AGE_MS, parseTag, readable, tierOf, usable } from "./verdict.ts";

const gh = (ref: string, event: string) => ({ GITHUB_ACTIONS: "true", GITHUB_REF: ref, GITHUB_EVENT_NAME: event, GITHUB_REF_NAME: ref.split("/").pop() });

describe("tiers", () => {
  it("make only a push, schedule or dispatch run on the trusted ref trusted", () => {
    expect(tierOf(gh("refs/heads/main", "push"), "refs/heads/main", "h")).toBe("trusted");
    expect(tierOf(gh("refs/pull/12/merge", "pull_request"), "refs/heads/main", "h")).toBe("pr-12");
    expect(tierOf(gh("refs/heads/main", "pull_request_target"), "refs/heads/main", "h")).toBe("session-main");
    expect(tierOf(gh("refs/heads/feature", "push"), "refs/heads/main", "h")).toBe("session-feature");
    expect(tierOf({ OUTRUN_SESSION: "agent 7" }, "refs/heads/main", "h")).toBe("session-agent-7");
    expect(tierOf({}, "refs/heads/main", "mini.local")).toBe("local-mini.local");
  });

  it("let a tier read itself and trusted, and trusted only itself", () => {
    expect(readable("trusted")).toEqual(["trusted"]);
    expect(readable("pr-3")).toEqual(["pr-3", "trusted"]);
  });
});

describe("tags", () => {
  it("round-trip the run, time, tier and replaced duration", () => {
    expect(parseTag(formatTag({ run: "42-1", at: 100, tier: "pr-3", prev: 1234.4 }))).toEqual({ run: "42-1", at: 100, tier: "pr-3", prev: 1234 });
    expect(parseTag("outrun1;run=x")).toEqual({});
  });

  it("refuse an expired verdict, another pull request's, or an untagged one", () => {
    const at = 1_000_000;
    const tag = { run: "r", at, tier: "trusted" };
    expect(usable(tag, "pr-1", at * 1000 + 1000)).toBe(true);
    expect(usable(tag, "pr-1", at * 1000 + MAX_AGE_MS)).toBe(false);
    expect(usable({ ...tag, tier: "pr-2" }, "pr-1", at * 1000)).toBe(false);
    expect(usable({ ...tag, tier: "pr-2" }, "trusted", at * 1000)).toBe(false);
    expect(usable({}, "trusted", at * 1000)).toBe(false);
  });
});
