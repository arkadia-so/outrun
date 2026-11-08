import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

// A reusable workflow runs the action of its own release, never a moving tag: `@v1` of the action
// could be another release than the workflow a caller pinned.
describe("the release", () => {
  it("pins each reusable workflow's outrun action to this release", () => {
    const dir = `${import.meta.dirname}/../.github/workflows`;
    for (const name of readdirSync(dir)) {
      const text = readFileSync(`${dir}/${name}`, "utf8");
      const refs = [...text.matchAll(/^\s*-?\s*uses: arkadia-so\/outrun@(\S+)/gm)].map((m) => m[1]);
      for (const ref of refs) expect(`${name}: ${ref}`).toBe(`${name}: v${pkg.version}`);
    }
  });
});
