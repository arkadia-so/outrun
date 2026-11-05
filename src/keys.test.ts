import { describe, expect, it } from "vitest";
import type { Config } from "./config.ts";
import { computeUnits, matching, type ReadSet, tracedKey } from "./keys.ts";
import { ImportGraph, matchPattern, scanSource } from "./sources/imports.ts";

// A small repository in memory: path → content; a file's blob is its content's own text.
const repo = (files: Record<string, string>) => {
  const blobs = new Map(Object.entries(files).map(([path, text]) => [path, `${text.length}:${Bun.hash(text)}`]));
  const graph = new ImportGraph(
    blobs,
    (path) => scanSource(files[path] ?? "", path),
    (path) => files[path],
  );
  return { blobs, graph };
};

const BASE = {
  "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  "bun.lock": "lock 1",
  "packages/a/package.json": JSON.stringify({ name: "a", exports: { ".": "./src/index.ts", "./util": "./src/util.ts" } }),
  "packages/a/src/index.ts": 'export * from "./util"\n',
  "packages/a/src/util.ts": "export const one = 1\n",
  "packages/a/src/other.ts": "export const two = 2\n",
  "packages/b/package.json": JSON.stringify({ name: "b" }),
  "packages/b/src/cli.ts": 'import { one } from "a/util"\nconsole.log(one)\n',
  "packages/b/test/util.test.ts": 'import { one } from "a/util"\nimport type { X } from "a"\n',
  "packages/b/test/cli.test.ts": 'Bun.spawn(["bun", "../src/cli.ts"])\n',
  "packages/b/test/broken.test.ts": 'import { x } from "./missing"\n',
  "packages/b/test/fixture.test.ts": 'readdirSync("./fixtures")\n',
  "packages/b/test/fixtures/one.txt": "data\n",
};

const config: Config = {
  inputs: ["bun.lock"],
  env: ["MY_FLAG"],
  suites: [{ name: "b", adapter: "bun", dir: "packages/b", tests: ["test/**/*.test.ts"], run: ["bun", "test"] }],
};

const keys = (files: Record<string, string>, env: Record<string, string> = {}, readSets = new Map<string, ReadSet[]>(), toolchain = "bun 1") => {
  const { blobs, graph } = repo(files);
  return Object.fromEntries(computeUnits({ config, blobs, graph, readSets, toolchain: { bun: toolchain }, env }).map((u) => [u.file, u]));
};

describe("keys", () => {
  const before = keys(BASE);

  it("change only for the tests whose import closure holds the changed file", () => {
    const after = keys({ ...BASE, "packages/a/src/util.ts": "export const one = 11\n" });
    expect(after["test/util.test.ts"]?.key).not.toBe(before["test/util.test.ts"]?.key);
    expect(after["test/cli.test.ts"]?.key).not.toBe(before["test/cli.test.ts"]?.key);
    expect(after["test/fixture.test.ts"]?.key).toBe(before["test/fixture.test.ts"]?.key);
    const unrelated = keys({ ...BASE, "packages/a/src/other.ts": "export const two = 22\n" });
    expect(unrelated["test/util.test.ts"]?.key).toBe(before["test/util.test.ts"]?.key);
  });

  it("ignore type-only imports: a test runner does not type-check", () => {
    const after = keys({ ...BASE, "packages/a/src/index.ts": 'export * from "./util"\nexport type X = 1\n' });
    expect(after["test/util.test.ts"]?.key).toBe(before["test/util.test.ts"]?.key);
  });

  it("follow a relative path in a string literal: a spawned script, a fixture folder", () => {
    expect(keys({ ...BASE, "packages/b/src/cli.ts": "console.log(2)\n" })["test/cli.test.ts"]?.key).not.toBe(before["test/cli.test.ts"]?.key);
    expect(keys({ ...BASE, "packages/b/test/fixtures/one.txt": "other\n" })["test/fixture.test.ts"]?.key).not.toBe(before["test/fixture.test.ts"]?.key);
  });

  it("make a test whose import does not resolve depend on its whole package", () => {
    const after = keys({ ...BASE, "packages/b/test/fixtures/one.txt": "other\n" });
    expect(after["test/broken.test.ts"]?.key).not.toBe(before["test/broken.test.ts"]?.key);
  });

  it("change every key with a global input, a keyed variable or the toolchain, and no other variable", () => {
    const key = (k: Record<string, { key: string } | undefined>) => k["test/util.test.ts"]?.key;
    expect(key(keys({ ...BASE, "bun.lock": "lock 2" }))).not.toBe(key(before));
    expect(key(keys(BASE, { MY_FLAG: "1" }))).not.toBe(key(before));
    expect(key(keys(BASE, { LANG: "C" }))).not.toBe(key(before));
    expect(key(keys(BASE, {}, new Map(), "bun 1 arch=x64"))).not.toBe(key(before));
    expect(key(keys(BASE, { OTHER: "1", PATH: "/elsewhere" }))).toBe(key(before));
  });

  it("give a traced read set a key of its own, over only what the test read", () => {
    const unit = before["test/util.test.ts"];
    if (!unit) throw new Error("no unit");
    // The test was seen reading only itself: util.ts changing moves the closure's key, not that one.
    const sets = new Map([[unit.weak, [{ reads: [], net: false }]]]);
    const traced = keys(BASE, {}, sets)["test/util.test.ts"];
    expect(traced?.candidates).toHaveLength(2);
    const { blobs } = repo(BASE);
    expect(traced?.candidates[1]).toBe(tracedKey(unit, blobs, { reads: [] }));
    const edited = keys({ ...BASE, "packages/a/src/util.ts": "export const one = 11\n" }, {}, sets)["test/util.test.ts"];
    expect(edited?.key).not.toBe(traced?.key);
    expect(edited?.candidates[1]).toBe(traced?.candidates[1]);
    const own = keys({ ...BASE, "packages/b/test/util.test.ts": 'import { one } from "a/util"\n// edited\n' }, {}, sets)["test/util.test.ts"];
    expect(own?.candidates[1]).not.toBe(traced?.candidates[1]);
  });

  it("key a path only stat'ed or found absent by presence, and a listed folder by its entries", () => {
    const unit = before["test/util.test.ts"];
    if (!unit) throw new Error("no unit");
    // A runner that stats every test file at start: editing another test must not move this key,
    // adding or deleting one must.
    const sets = new Map([[unit.weak, [{ reads: [], present: ["packages/b/test/cli.test.ts", "packages/b/test/new.test.ts"], net: false }]]]);
    const key = (files: Record<string, string>) => keys(files, {}, sets)["test/util.test.ts"]?.candidates[1];
    const base = key(BASE);
    expect(key({ ...BASE, "packages/b/test/cli.test.ts": "// edited\n" })).toBe(base);
    expect(key({ ...BASE, "packages/b/test/new.test.ts": "// new\n" })).not.toBe(base);
    const { "packages/b/test/cli.test.ts": _, ...without } = BASE;
    expect(key(without)).not.toBe(base);
    // Lookups lost: the tracer lists the folders above what was read; a file appearing in one moves the key.
    const listed = new Map([[unit.weak, [{ reads: ["packages/b/test/fixtures/"], net: false }]]]);
    const folder = (files: Record<string, string>) => keys(files, {}, listed)["test/util.test.ts"]?.candidates[1];
    expect(folder({ ...BASE, "packages/b/test/fixtures/one.txt": "other\n" })).toBe(folder(BASE));
    expect(folder({ ...BASE, "packages/b/test/fixtures/two.txt": "x\n" })).not.toBe(folder(BASE));
  });

  it("key a traced set without the suite's whole folder, which the trace replaces, but with the global and declared inputs", () => {
    const whole: Config = { ...config, suites: [{ ...config.suites[0]!, sources: ["suite"], inputs: ["test/fixtures/**"] }] };
    const declared: Config = { ...whole, suites: [{ ...whole.suites[0]!, sources: ["suite", "declared"] }] };
    const traced = (cfg: Config, files: Record<string, string>) => {
      const { blobs, graph } = repo(files);
      const plain = computeUnits({ config: cfg, blobs, graph, readSets: new Map(), toolchain: { bun: "bun 1" }, env: {} }).find(
        (u) => u.file === "test/util.test.ts",
      );
      const sets = new Map([[plain?.weak ?? "", [{ reads: [], net: false }]]]);
      return computeUnits({ config: cfg, blobs, graph, readSets: sets, toolchain: { bun: "bun 1" }, env: {} }).find((u) => u.file === "test/util.test.ts");
    };
    const base = traced(whole, BASE);
    // Another file of the folder: the folder's key moves, the traced one (which did not read it) does not.
    const other = traced(whole, { ...BASE, "packages/b/test/cli.test.ts": "// edited\n" });
    expect(other?.key).not.toBe(base?.key);
    expect(other?.candidates[1]).toBe(base?.candidates[1]);
    // A global input (the lockfile of packages the run reads installed) moves both.
    expect(traced(whole, { ...BASE, "bun.lock": "lock 2" })?.candidates[1]).not.toBe(base?.candidates[1]);
    // A declared input moves both too.
    const fixture = { ...BASE, "packages/b/test/fixtures/one.txt": "other\n" };
    expect(traced(declared, fixture)?.candidates[1]).not.toBe(traced(declared, BASE)?.candidates[1]);
  });

  it("never cache a test a traced run saw using the network", () => {
    const unit = before["test/fixture.test.ts"];
    const sets = new Map([[unit?.weak ?? "", [{ reads: [], net: true }]]]);
    expect(keys(BASE, {}, sets)["test/fixture.test.ts"]?.cacheable).toBe(false);
    expect(before["test/fixture.test.ts"]?.cacheable).toBe(true);
  });
});

describe("matching", () => {
  it("applies `!` globs as exclusions, relative to the folder", () => {
    const { blobs } = repo(BASE);
    expect(matching(blobs, "packages/a", ["**/*", "!**/*.json"])).toEqual(["packages/a/src/index.ts", "packages/a/src/other.ts", "packages/a/src/util.ts"]);
  });
});

describe("matchPattern", () => {
  it("takes the longest `*` pattern and every condition's target", () => {
    const map = { "./*": "./src/*.ts", "./util/*": { bun: "./src/util/*.ts", default: "./dist/util/*.js" } };
    expect(matchPattern(map, "./util/x")).toEqual(["./src/util/x.ts", "./dist/util/x.js"]);
    expect(matchPattern(map, "./y")).toEqual(["./src/y.ts"]);
    expect(matchPattern({ "./a": "./a.ts" }, "./b")).toBeUndefined();
  });
});
