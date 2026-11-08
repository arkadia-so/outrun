import { describe, expect, it } from "vitest";
import { appKey, e2eConfigs, envNames, keptFiles, listedFiles } from "./discover.ts";

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

  it("takes each listed file once", () => {
    const json = JSON.stringify({ pairs: [{ file: "e2e/b.e2e.ts" }, { file: "e2e/a.e2e.ts" }, { file: "e2e/b.e2e.ts" }, { title: "no file" }] });
    expect(listedFiles(json)).toEqual(["e2e/a.e2e.ts", "e2e/b.e2e.ts"]);
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
    expect(keptFiles(JSON.stringify({ v: 1, files: ["e2e/a.e2e.ts"] }))).toEqual(["e2e/a.e2e.ts"]);
    expect(keptFiles(JSON.stringify({ v: 2, files: [] }))).toBeUndefined();
    expect(keptFiles("{")).toBeUndefined();
    expect(keptFiles(undefined)).toBeUndefined();
  });
});
