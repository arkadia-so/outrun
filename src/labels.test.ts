import { describe, expect, it } from "vitest";
import { ALIASES, labelNamed, LABELS, outrunLabel, RUNNERS } from "./labels.ts";

describe("outrun's runs-on labels are named as GitHub's and Depot's, the old ones kept as aliases", () => {
  it("resolves each new label to its runner, OS and architecture", () => {
    expect(outrunLabel(["outrun-ubuntu-24.04"])).toMatchObject({ runner: "outrun-ubuntu-24.04", alias: null, tier: "standard", os: "linux", arch: "x86_64" });
    expect(outrunLabel(["outrun-ubuntu-24.04-8"])).toMatchObject({ runner: "outrun-ubuntu-24.04-8", os: "linux", arch: "x86_64" });
    expect(outrunLabel(["outrun-ubuntu-24.04-arm"])).toMatchObject({ runner: "outrun-ubuntu-24.04-arm", os: "linux", arch: "arm64" });
    expect(outrunLabel(["outrun-macos-26"])).toMatchObject({ runner: "outrun-macos-26", os: "macos", arch: "arm64" });
  });

  it("resolves each deprecated alias, at each tier, to the same runner, keeping the label it was written with", () => {
    expect(ALIASES).toEqual({
      outrun: "outrun-ubuntu-24.04",
      "outrun-8cpu": "outrun-ubuntu-24.04-8",
      "outrun-linux-arm64": "outrun-ubuntu-24.04-arm",
      "outrun-macos": "outrun-macos-26",
    });
    for (const [alias, runner] of Object.entries(ALIASES))
      for (const [suffix, tier] of [
        ["", "standard"],
        ["-priority", "priority"],
        ["-flex", "flex"],
      ] as const) {
        const asNew = outrunLabel([`${runner}${suffix}`])!;
        const asAlias = outrunLabel([`${alias}${suffix}`])!;
        expect(asAlias).toMatchObject({ label: `${alias}${suffix}`, runner, alias, tier });
        expect(asNew).toMatchObject({ label: `${runner}${suffix}`, runner, alias: null, tier });
        expect([asAlias.os, asAlias.arch]).toEqual([asNew.os, asNew.arch]);
      }
  });

  it("takes the tier from the suffix after the size and the architecture", () => {
    expect(outrunLabel(["outrun-ubuntu-24.04-arm-priority"])).toMatchObject({ runner: "outrun-ubuntu-24.04-arm", tier: "priority" });
    expect(outrunLabel(["outrun-ubuntu-24.04-8-flex"])).toMatchObject({ runner: "outrun-ubuntu-24.04-8", tier: "flex" });
    expect(outrunLabel(["outrun-macos-26-low"])).toBeUndefined();
  });

  it("is not ours with two outrun labels (an alias and its new name included) or a foreign one", () => {
    expect(outrunLabel(["outrun", "outrun-ubuntu-24.04"])).toBeUndefined();
    expect(outrunLabel(["outrun-macos", "outrun-macos-26"])).toBeUndefined();
    expect(outrunLabel(["outrun-ubuntu-24.04", "gpu"])).toBeUndefined();
    expect(outrunLabel(["ubuntu-24.04"])).toBeUndefined();
    expect(outrunLabel(["self-hosted", "Linux", "ARM64", "outrun-ubuntu-24.04-arm"])?.label).toBe("outrun-ubuntu-24.04-arm");
    expect(outrunLabel(["self-hosted", "x64", "outrun-ubuntu-24.04-arm"])).toBeUndefined();
    expect(outrunLabel(["self-hosted", "linux", "outrun-macos-26"])).toBeUndefined();
  });

  it("lists every runner under its name and its aliases at the three tiers, each label once", () => {
    expect(LABELS).toHaveLength((RUNNERS.length + Object.keys(ALIASES).length) * 3);
    expect(new Set(LABELS.map((label) => label.label)).size).toBe(LABELS.length);
    expect(labelNamed("outrun-macos-flex")).toMatchObject({ runner: "outrun-macos-26", alias: "outrun-macos", tier: "flex" });
    expect(labelNamed("Outrun")).toBeUndefined();
  });
});
