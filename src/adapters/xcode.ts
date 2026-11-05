// xcodebuild: a suite is one test target of a scheme (`xcode.target`), a unit one of its test files.
// Once per runner (`prepare`), the packages are resolved, then the scheme is built for testing into
// a derived data folder of the run's scratch; each batch is then one `test-without-building` with an
// `-only-testing:<target>/<type>` per test type its files declare (XCTest classes, Swift Testing
// suites, top-level `@Test` functions), and its result bundle gives each test case's outcome, mapped
// back to the file declaring its type.
//
// The build and the tests run with GIT_DIR pointing nowhere: xcodebuild otherwise runs `git status`
// over the whole checkout about a hundred times per build (its source-control scan), so every key
// would hold every file's status (outrun/spikes/tracer/README.md). Packages resolve first, with git,
// and the later steps never resolve again (`-disableAutomaticPackageResolution`).
//
// One simulator serves one xcodebuild at a time: run an xcode suite with `--slots 1` (several test
// types of a batch run in parallel inside it, as xcodebuild schedules them), or set its `memoryMb`
// to the machine's memory so its batches never overlap.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Console, Effect } from "effect";
import type { Suite } from "../config.ts";
import { FileFailed, SpawnFailed } from "../errors.ts";
import { exec } from "../exec.ts";
import type { Adapter, UnitResult } from "./adapter.ts";

/** Where git looks instead of the checkout while xcodebuild builds and tests. */
const NO_GIT = "/var/empty/no-git";

type XcodeSuite = NonNullable<Suite["xcode"]>;

/** A suite without its settings fails in `prepare`, which runs before any of its batches. */
const xcodeOf = (suite: Suite): XcodeSuite => suite.xcode ?? { scheme: "", destination: "", target: "" };

/** Pure: what names the scheme to xcodebuild: workspace or project, scheme, destination, test plan. */
export const schemeArgs = (x: XcodeSuite) => [
  ...(x.workspace ? ["-workspace", x.workspace] : x.project ? ["-project", x.project] : []),
  "-scheme",
  x.scheme,
  "-destination",
  x.destination,
  ...(x.testPlan ? ["-testPlan", x.testPlan] : []),
];

/** The derived data of a scheme, shared by the build and every batch of the run. */
const derivedData = (scratch: string, x: XcodeSuite) =>
  `${scratch}/xcode-${new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([x.workspace, x.project, x.scheme, x.destination]))
    .digest("hex")
    .slice(0, 12)}`;

const TYPE =
  /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|package|private|fileprivate|open|final|nonisolated)\s+)*(?:class|struct|actor|enum|extension)\s+([A-Za-z_]\w*)/;
const ATTRIBUTE_LINE = /^@[\w.]+(?:\(.*\))?\s*$/;
const FUNC = /^(?:(?:public|internal|package|private|fileprivate|nonisolated)\s+)*func\s+([A-Za-z_]\w*)/;

/** A test inside a type's body: a Swift Testing `@Test`, or an XCTest instance method `testX()`. */
const BODY_TEST =
  /^\s+@Test\b|^\s+(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|package|private|fileprivate|open|final|override|nonisolated)\s+)*func\s+test\w*\s*\(\s*\)/m;

/**
 * Pure: the test identifiers a Swift file declares, for `-only-testing:<target>/<id>`: each type
 * declared or extended at the top level that is a test (marked `@Suite`, an `XCTestCase`, or whose
 * body holds a `@Test` or an XCTest `testX()` method), and each top-level `@Test` function
 * (`name()`). A file without tests declares none: a mock, or a helper's `static func test(…)`.
 */
export const testIdentifiers = (source: string): string[] => {
  const out = new Set<string>();
  // The open top-level type: its name, whether its header marks it as a test, and its body.
  let open: { name: string; test: boolean; body: string[] } | undefined;
  const close = () => {
    if (open && (open.test || BODY_TEST.test(open.body.join("\n")))) out.add(open.name);
    open = undefined;
  };
  let attributes: string[] = [];
  for (const line of source.split("\n")) {
    if (/^\s/.test(line) || line === "" || line.startsWith("//")) {
      open?.body.push(line);
      continue;
    }
    if (ATTRIBUTE_LINE.test(line)) {
      attributes.push(line);
      continue;
    }
    const header = [...attributes, line].join(" ");
    attributes = [];
    const type = TYPE.exec(line);
    if (type?.[1]) {
      close();
      open = { name: type[1], test: /@Suite\b|:\s*(?:[\w.]+\s*,\s*)*XCTestCase\b/.test(header), body: [] };
      continue;
    }
    if (line.startsWith("}")) {
      close();
      continue;
    }
    const func = FUNC.exec(line.replace(/^(?:@[\w.]+(?:\([^)]*\))?\s+)+/, ""));
    if (func?.[1] && /(?:^|\s)@Test\b/.test(header)) out.add(`${func[1]}()`);
  }
  close();
  return [...out];
};

interface TestNode {
  readonly name?: string;
  readonly nodeType?: string;
  readonly nodeIdentifier?: string;
  readonly result?: string;
  readonly durationInSeconds?: number;
  readonly duration?: string;
  readonly children?: readonly TestNode[];
}

/** Pure: "1m 2.5s", "0.31s", "12ms" → milliseconds. */
const parseDuration = (text: string | undefined) => {
  if (!text) return 0;
  let ms = 0;
  for (const [, n, unit] of text.matchAll(/([\d.]+)\s*(ms|m|s|h)\b/g)) ms += Number(n) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as string] ?? 0);
  return ms;
};

export interface CaseResult {
  /** The top-level test identifier the case belongs to (its type, or `name()` for a function). */
  readonly id: string;
  readonly passed: boolean;
  readonly durationMs: number;
  /** A failed case: its identifier and the result bundle's failure messages, for the log. */
  readonly failure?: string;
}

/**
 * Pure: every test case of `target` in `xcresulttool get test-results tests`' JSON. A case passes
 * when it passed, was skipped or failed as expected; its identifier's first part names the type.
 */
export const parseTestResults = (json: string, target: string): CaseResult[] => {
  let root: { testNodes?: readonly TestNode[] };
  try {
    root = JSON.parse(json) as { testNodes?: readonly TestNode[] };
  } catch {
    return [];
  }
  const out: CaseResult[] = [];
  const walk = (node: TestNode, inTarget: boolean) => {
    const here = inTarget || (node.nodeType === "Unit test bundle" || node.nodeType === "UI test bundle" ? node.name === target : false);
    if (node.nodeType === "Test Case") {
      if (here && node.nodeIdentifier) {
        const id = (node.nodeIdentifier.startsWith(`${target}/`) ? node.nodeIdentifier.slice(target.length + 1) : node.nodeIdentifier).split("/")[0] as string;
        const passed = ["Passed", "Skipped", "Expected Failure"].includes(node.result ?? "");
        const messages = (node.children ?? []).filter((c) => c.nodeType === "Failure Message").map((c) => `\n    ${c.name ?? ""}`);
        out.push({
          id,
          passed,
          durationMs: node.durationInSeconds !== undefined ? node.durationInSeconds * 1000 : parseDuration(node.duration),
          ...(passed ? {} : { failure: `${node.nodeIdentifier}: ${node.result ?? "no result"}${messages.join("")}` }),
        });
      }
      return;
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  for (const node of root.testNodes ?? []) walk(node, false);
  return out;
};

/**
 * Pure: each file's result from its identifiers' cases. A file whose identifiers ran no case did
 * not finish (absent), unless it declares none and the run ended normally: it holds no test.
 */
export const fileResults = (byFile: ReadonlyMap<string, readonly string[]>, cases: readonly CaseResult[], ended: boolean) => {
  const byId = new Map<string, CaseResult[]>();
  for (const c of cases) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  const out = new Map<string, UnitResult>();
  for (const [file, ids] of byFile) {
    if (ids.length === 0) {
      if (ended) out.set(file, { passed: true, durationMs: 0, tests: 0 });
      continue;
    }
    const mine = ids.flatMap((id) => byId.get(id) ?? []);
    if (mine.length === 0) continue;
    out.set(file, { passed: mine.every((c) => c.passed), durationMs: mine.reduce((a, c) => a + c.durationMs, 0), tests: mine.length });
  }
  return out;
};

const spawnText = (argv: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`exit ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`);
      return out;
    },
    catch: (error) => new SpawnFailed({ message: `${argv.slice(0, 3).join(" ")}: ${error instanceof Error ? error.message : String(error)}` }),
  });

/** A build gets this long, whatever the suite's batch limits. */
const BUILD_TIMEOUT_MS = 3_600_000;
const BUILD_IDLE_MS = 900_000;

/** The schemes already built in this process: derived data folder → done. */
const built = new Set<string>();
let batchCount = 0;

const tail = (output: string) => output.trim().split("\n").slice(-30).join("\n");

export const xcodeAdapter: Adapter = {
  name: "xcode",
  // The Xcode version and build, and the simulator runtimes installed (a destination naming `OS=latest`
  // or a device name resolves against them).
  toolchain: () =>
    Effect.gen(function* () {
      const version = (yield* spawnText(["xcodebuild", "-version"])).trim().split("\n").join(" ");
      const runtimes = yield* spawnText(["xcrun", "simctl", "list", "runtimes", "-j"]);
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(runtimes) as { runtimes?: { identifier?: string; buildversion?: string; isAvailable?: boolean }[] };
        ids = (parsed.runtimes ?? [])
          .filter((r) => r.isAvailable !== false)
          .map((r) => `${r.identifier}@${r.buildversion}`)
          .sort();
      } catch {
        // No runtime listed: the version alone.
      }
      return `${version} ${process.platform} runtimes=${ids.join(",")}`;
    }),
  prepare: (suite, repo, scratch) =>
    Effect.gen(function* () {
      if (!suite.xcode)
        return yield* new SpawnFailed({ message: `suite ${suite.name}: the xcode adapter needs its "xcode" settings (scheme, destination, target)` });
      const x = suite.xcode;
      const dd = derivedData(scratch, x);
      if (built.has(dd)) return;
      const cwd = posix.join(repo, suite.dir);
      const env = process.env as Record<string, string | undefined>;
      const step = (name: string, argv: readonly string[], stepEnv: Record<string, string | undefined>) =>
        Effect.gen(function* () {
          const done = yield* exec({ argv, cwd, env: stepEnv, timeoutMs: BUILD_TIMEOUT_MS, idleMs: Math.max(suite.idleMs ?? 0, BUILD_IDLE_MS) });
          if (done.code !== 0)
            return yield* new SpawnFailed({
              message: `suite ${suite.name}: ${name} failed (exit ${done.code}${done.killed ? `, killed: ${done.killed}` : ""}):\n${tail(done.output)}`,
            });
        });
      yield* step("resolving the packages", [...suite.run, ...schemeArgs(x), "-resolvePackageDependencies"], env);
      yield* step("building for testing", [...suite.run, ...schemeArgs(x), "-derivedDataPath", dd, "-disableAutomaticPackageResolution", "build-for-testing"], {
        ...env,
        GIT_DIR: NO_GIT,
      });
      built.add(dd);
    }),
  batch: (suite, repo, files, scratch) => {
    const x = xcodeOf(suite);
    const cwd = posix.join(repo, suite.dir);
    const byFile = new Map<string, string[]>();
    for (const f of files) {
      try {
        byFile.set(f, testIdentifiers(readFileSync(posix.join(cwd, f), "utf8")));
      } catch {
        // Unreadable: an identifier no case has, so it reports nothing and counts as unfinished.
        byFile.set(f, ["\0unreadable"]);
      }
    }
    const ids = [...new Set([...byFile.values()].flat().filter((id) => !id.startsWith("\0")))].sort();
    const bundle = `${scratch}/xcode-${process.pid}-${++batchCount}.xcresult`;
    const argv =
      ids.length === 0
        ? // Nothing to test: a command that ends normally, so each file reports no test.
          ["true"]
        : [
            ...suite.run,
            ...schemeArgs(x),
            "-derivedDataPath",
            derivedData(scratch, x),
            "-resultBundlePath",
            bundle,
            "-disableAutomaticPackageResolution",
            "test-without-building",
            ...ids.map((id) => `-only-testing:${x.target}/${id}`),
          ];
    return {
      argv,
      cwd,
      env: { GIT_DIR: NO_GIT },
      results: (exit) =>
        Effect.gen(function* () {
          if (ids.length === 0) return fileResults(byFile, [], exit.code === 0);
          const exists = yield* Effect.tryPromise({
            try: () => Bun.file(`${bundle}/Info.plist`).exists(),
            catch: () => new FileFailed({ message: `${bundle}: unreadable` }),
          });
          // No result bundle: the batch did not get to its tests (a launch failure): none finished.
          if (!exists) return new Map<string, UnitResult>();
          const json = yield* spawnText(["xcrun", "xcresulttool", "get", "test-results", "tests", "--path", bundle]).pipe(
            Effect.mapError((e) => new FileFailed({ message: `${bundle}: ${e.message}` })),
          );
          const cases = parseTestResults(json, x.target);
          // xcodebuild -quiet does not print Swift Testing's failures: the bundle's are the log's.
          const failures = cases.flatMap((c) => (c.failure ? [c.failure] : []));
          if (failures.length > 0) yield* Console.error(`outrun: ${x.target}: ${failures.length} failed test cases\n  ${failures.join("\n  ")}`);
          // Exit 0 or 65 (some test failed) is a run that ended; anything else may have cut it short.
          return fileResults(byFile, cases, exit.code === 0 || exit.code === 65);
        }),
    };
  },
};
