import { describe, expect, it } from "vitest";
import { parseObserved, readSetOf } from "./observed.ts";

const line = (record: Record<string, unknown>) => JSON.stringify({ env: [], exec: [], net: [], ...record });

describe("readSetOf", () => {
  it("keys stat-only and absent paths by presence, keeps listed folders, and refuses a trace that lost reads", () => {
    const text = [
      line({
        unit: "/r/test/a.test",
        reads: ["/r/test/a.test", "/r/test/b.test", "/r/src/", "/usr/lib/x"],
        stat_only: ["/r/test/b.test"],
        missing: ["/r/test/c.test"],
        complete: true,
        missing_complete: false,
      }),
      line({ unit: "/r/test/d.test", reads: ["/r/src/d"], complete: false }),
    ].join("\n");
    const seen = parseObserved(text, "/r");
    const a = seen.get("test/a.test");
    if (!a) throw new Error("no unit");
    expect(readSetOf(a, "presence")).toEqual({ reads: ["src/", "test/a.test"], present: ["test/b.test", "test/c.test"], net: false });
    expect(readSetOf(a, "content")).toEqual({ reads: ["src/", "test/a.test", "test/b.test"], present: ["test/c.test"], net: false });
    const d = seen.get("test/d.test");
    if (!d) throw new Error("no unit");
    expect(readSetOf(d, "presence")).toBeUndefined();
  });
});
