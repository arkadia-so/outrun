import { describe, expect, it } from "vitest";
import { appKey, e2eConfigs, envNames, keptTests, listedTests, parseFilter } from "./discover.ts";
import { ConfigInvalid } from "./errors.ts";

describe("e2e discovery", () => {
  it("finds every e2e config outside node_modules", () => {
    expect(e2eConfigs(["e2e.config.ts", "apps/web/e2e.config.mjs", "node_modules/x/e2e.config.ts", "apps/web/my-e2e.config.ts", "a/e2e.config.json"])).toEqual([
      "apps/web/e2e.config.mjs",
      "e2e.config.ts",
    ]);
  });

  it("keeps, with --only, the configs whose folder holds or lies under one of its paths", () => {
    const configs = ["e2e.config.ts", "apps/web/e2e.config.ts", "apps/admin/e2e.config.ts"];
    expect(e2eConfigs(configs, ["apps/web"])).toEqual(["apps/web/e2e.config.ts", "e2e.config.ts"]);
    expect(e2eConfigs(configs.slice(1), ["apps/web/e2e/cart.e2e.ts"])).toEqual(["apps/web/e2e.config.ts"]);
    expect(e2eConfigs(configs.slice(1), ["apps/"])).toEqual(["apps/admin/e2e.config.ts", "apps/web/e2e.config.ts"]);
  });

  it("names the variables a source reads", () => {
    const text = `const a = process.env.ACME_URL; const b = process.env["ACME_TOKEN"]; const c = import.meta.env.VITE_X; process.env[name];`;
    expect(envNames(text).sort()).toEqual(["ACME_TOKEN", "ACME_URL", "VITE_X"]);
  });

  it("makes a unit of each declaring line, a serial group one unit at its first line, and a file with no lines one unit", () => {
    const pair = (file: string, line: number | undefined, titlePath: string[], serialId?: string) => ({
      file,
      title: titlePath.at(-1),
      titlePath,
      ...(line === undefined ? {} : { source: { file, line, column: 1 } }),
      ...(serialId ? { serialId } : {}),
    });
    const json = JSON.stringify({
      pairs: [
        pair("e2e/b.e2e.ts", 9, ["refund"], undefined),
        pair("e2e/b.e2e.ts", 4, ["checkout", "pay"], "g1"),
        pair("e2e/b.e2e.ts", 6, ["checkout", "confirm"], "g1"),
        pair("e2e/b.e2e.ts", 9, ["refund"], undefined),
        pair("e2e/a.e2e.ts", 2, ["loop 1"]),
        pair("e2e/a.e2e.ts", 2, ["loop 2"]),
        pair("e2e/c.e2e.ts", undefined, ["old cli"]),
        { title: "no file" },
      ],
    });
    expect(listedTests(json)).toEqual([
      { file: "e2e/a.e2e.ts", line: 2, name: "loop 1" },
      { file: "e2e/b.e2e.ts", line: 4, name: "checkout" },
      { file: "e2e/b.e2e.ts", line: 9, name: "refund" },
      { file: "e2e/c.e2e.ts", name: "e2e/c.e2e.ts" },
    ]);
  });

  it("takes e2e's selection flags as the filter, and refuses anything else", () => {
    expect(parseFilter(undefined)).toEqual([]);
    expect(parseFilter("--exclude-tag release --exclude-tag=push --grep 'pays by card'")).toEqual([
      "--exclude-tag",
      "release",
      "--exclude-tag",
      "push",
      "--grep",
      "pays by card",
    ]);
    expect(parseFilter("--retries 3")).toBeInstanceOf(ConfigInvalid);
    expect(parseFilter("--tag")).toBeInstanceOf(ConfigInvalid);
    expect(parseFilter("smoke")).toBeInstanceOf(ConfigInvalid);
  });

  it("keys a built app on its build command, its machine and its inputs' content, nothing else", () => {
    const blobs = new Map([
      ["app/main.swift", "b1"],
      ["app/Info.plist", "b2"],
      ["e2e/home.e2e.ts", "b3"],
    ]);
    const key = appKey(blobs, "./build.sh", ["app/**"], "os=Darwin 25");
    expect(appKey(new Map([...blobs, ["e2e/home.e2e.ts", "b4"]]), "./build.sh", ["app/**"], "os=Darwin 25")).toBe(key);
    expect(appKey(new Map([...blobs, ["app/main.swift", "b5"]]), "./build.sh", ["app/**"], "os=Darwin 25")).not.toBe(key);
    expect(appKey(blobs, "./build.sh --release", ["app/**"], "os=Darwin 25")).not.toBe(key);
    expect(appKey(blobs, "./build.sh", ["app/**"], "os=Darwin 26")).not.toBe(key);
    expect(appKey(blobs, "./build.sh", ["app/**", "!app/Info.plist"], "os=Darwin 25")).not.toBe(key);
  });

  it("reads a kept listing only in its own format", () => {
    const tests = [{ file: "e2e/a.e2e.ts", line: 3, name: "pays" }];
    expect(keptTests(JSON.stringify({ v: 2, tests }))).toEqual(tests);
    // A listing kept by an older release (files, not tests) is listed again.
    expect(keptTests(JSON.stringify({ v: 1, files: ["e2e/a.e2e.ts"] }))).toBeUndefined();
    expect(keptTests(JSON.stringify({ v: 2, tests: [{ file: "e2e/a.e2e.ts", line: 0, name: "x" }] }))).toBeUndefined();
    expect(keptTests("{")).toBeUndefined();
    expect(keptTests(undefined)).toBeUndefined();
  });
});
