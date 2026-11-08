import { describe, expect, it } from "vitest";
import { e2eConfigs, envNames, listedFiles } from "./discover.ts";

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
});
