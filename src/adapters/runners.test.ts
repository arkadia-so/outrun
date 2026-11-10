// The vitest and pytest adapters against the real runners, on two files: one passing, one failing.
import { mkdir, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Suite } from "../config.ts";
import { tempDir } from "../test-tmp.ts";
import type { Adapter } from "./adapter.ts";
import { catch2Adapter, testSpec } from "./catch2.ts";
import { pytestAdapter } from "./pytest.ts";
import { vitestAdapter } from "./vitest.ts";

const runBatch = async (adapter: Adapter, suite: Suite, repo: string, files: string[]) => {
  const scratch = await tempDir("outrun-scratch-");
  const batch = adapter.batch(suite, repo, files, scratch);
  const child = Bun.spawn([...batch.argv], { cwd: batch.cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return Effect.runPromise(batch.results({ code, output: out + err }));
};

const project = async (files: Record<string, string>) => {
  const repo = await tempDir("outrun-runner-");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(posix.dirname(posix.join(repo, path)), { recursive: true });
    await writeFile(posix.join(repo, path), text);
  }
  return repo;
};

const python = Bun.spawnSync(["python3", "-m", "pytest", "--version"]).exitCode === 0;

describe("runner adapters", () => {
  it("vitest: a result per file from its JUnit report", async () => {
    const repo = await project({
      "t/pass.test.ts": 'test("ok", () => expect(1).toBe(1))\n',
      "t/fail.test.ts": 'test("ok", () => expect(1).toBe(1))\ntest("no", () => expect(1).toBe(2))\n',
    });
    const vitest = posix.join(import.meta.dirname, "../../node_modules/.bin/vitest");
    const suite: Suite = { name: "t", adapter: "vitest", dir: "t", tests: ["*.test.ts"], run: [vitest, "run", "--globals", "--root", "."] };
    const results = await runBatch(vitestAdapter, suite, repo, ["pass.test.ts", "fail.test.ts"]);
    expect(results.get("pass.test.ts")).toMatchObject({ passed: true, tests: 1 });
    expect(results.get("fail.test.ts")).toMatchObject({ passed: false, tests: 2 });
  }, 30_000);

  it.skipIf(!python)(
    "pytest: a result per file from its test cases, and a file without tests passes",
    async () => {
      const repo = await project({
        "tests/test_pass.py": "def test_ok():\n    assert True\n",
        "tests/test_fail.py": "def test_ok():\n    assert True\n\ndef test_no():\n    assert False\n",
        "tests/test_none.py": "X = 1\n",
      });
      const suite: Suite = {
        name: "p",
        adapter: "pytest",
        dir: ".",
        tests: ["tests/test_*.py"],
        run: ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider"],
      };
      const results = await runBatch(pytestAdapter, suite, repo, ["tests/test_pass.py", "tests/test_fail.py", "tests/test_none.py"]);
      expect(results.get("tests/test_pass.py")).toMatchObject({ passed: true, tests: 1 });
      expect(results.get("tests/test_fail.py")).toMatchObject({ passed: false, tests: 2 });
      expect(results.get("tests/test_none.py")).toMatchObject({ passed: true, tests: 0 });
      const none = await runBatch(pytestAdapter, suite, repo, ["tests/test_none.py"]);
      expect(none.get("tests/test_none.py")).toMatchObject({ passed: true });
    },
    30_000,
  );

  it("catch2: a result per file from its JUnit report, its test cases named after the files, one spec for the batch; none when it crashed", async () => {
    // A stand-in for a Catch2 binary whose tests are scripts named by path: "fail" in a name fails,
    // "crash" ends the process before the report is written.
    const fake = `const a = process.argv.slice(2); const out = a[a.indexOf("--out") + 1];
const names = a[a.indexOf("--out") + 2].split(",").filter((n) => !n.includes("absent"));
if (names.some((n) => n.includes("crash"))) process.exit(134);
const cases = names.map((n) => n.includes("fail")
  ? \`<testcase classname="unittest.global" name="\${n}" time="0.25"><failure message="x"/></testcase>\`
  : \`<testcase classname="unittest.global" name="\${n}" time="0.5"/>\`);
await Bun.write(out, \`<testsuites><testsuite name="unittest" tests="\${names.length}">\${cases.join("")}</testsuite></testsuites>\`);
process.exit(names.some((n) => n.includes("fail")) ? 1 : 0);
`;
    const repo = await project({ "unittest.ts": fake, "test/sql/ok.test": "", "test/sql/fail.test": "", "test/sql/crash.test": "" });
    const suite: Suite = { name: "sql", adapter: "catch2", dir: ".", tests: ["test/**/*.test"], run: ["bun", "unittest.ts"] };
    const results = await runBatch(catch2Adapter, suite, repo, ["test/sql/ok.test", "test/sql/fail.test", "test/sql/absent.test"]);
    expect(results.get("test/sql/ok.test")).toEqual({ passed: true, durationMs: 500, tests: 1 });
    expect(results.get("test/sql/absent.test")).toEqual({ passed: true, durationMs: 0, tests: 0 });
    expect(results.get("test/sql/fail.test")).toMatchObject({ passed: false, tests: 1 });
    expect((await runBatch(catch2Adapter, suite, repo, ["test/sql/ok.test", "test/sql/crash.test"])).size).toBe(0);
    expect(testSpec(["a/b.test", "c,d[1].test"])).toBe("a/b.test,c\\,d\\[1\\].test");
  });
});
