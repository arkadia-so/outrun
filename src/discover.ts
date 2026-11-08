// `--e2e`: the configuration outrun builds itself from a repository's TesterArmy e2e configs, with no
// outrun.json (DESIGN.md §13). Every `e2e.config.{ts,mts,js,mjs}` git knows is a suite: its folder is
// the suite's, its test files are the ones TesterArmy's own CLI lists for it (`e2e list --reporter
// json`, so a config's `tests` glob and filters mean what they mean to `e2e run`), and a batch is
// `e2e run` on the nearest installed CLI, under Node.
//
// What a discovered suite's keys hold: every file of the config's folder (a config in the app's
// package reruns its tests when the app changes), the test files' import closures, the lockfiles, and
// a digest of each variable the folder's sources read by name (`process.env.OUTRUN_E2E_URL`): an end
// to end test reaches a deployed app, which the variables name. Its batches get the job's whole
// environment (the tests' secrets), retry as the config says (no rerun alone), and a pass replays for
// a day only, since the app under test may change without a commit here.
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { Effect } from "effect";
import type { Config, Suite } from "./config.ts";
import { ConfigInvalid } from "./errors.ts";
import type { Blobs } from "./git.ts";

type Env = Readonly<Record<string, string | undefined>>;

const CONFIG = /(^|\/)e2e\.config\.(ts|mts|js|mjs)$/;
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
/** The CLI's entry, below a node_modules folder. */
const CLI = "node_modules/e2e/dist/cli/bin.js";

/**
 * Pure: the e2e configs of the checkout (repository-relative), outside any node_modules; with `only`
 * (`--only`'s paths), the ones whose folder holds one of those paths or lies under one.
 */
export const e2eConfigs = (paths: Iterable<string>, only?: readonly string[]) =>
  [...paths]
    .filter((p) => CONFIG.test(p) && !p.split("/").includes("node_modules"))
    .filter((p) => !only || only.some((o) => overlaps(posix.dirname(p), posix.normalize(o).replace(/\/$/, ""))))
    .sort();

const overlaps = (dir: string, path: string) => dir === "." || path === "." || dir === path || dir.startsWith(`${path}/`) || path.startsWith(`${dir}/`);

/** Pure: the variables a source reads by name (`process.env.NAME`, `process.env["NAME"]`, `import.meta.env.NAME`). */
export const envNames = (text: string): string[] => {
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])/g)) {
    const name = m[1] ?? m[2];
    if (name) names.add(name);
  }
  return [...names];
};

/** Pure: the test files of `e2e list --reporter json`'s answer, relative to the config's folder. */
export const listedFiles = (json: string): string[] => {
  const parsed = JSON.parse(json) as { pairs?: readonly { file?: unknown }[] };
  return [...new Set((parsed.pairs ?? []).flatMap((p) => (typeof p.file === "string" ? [p.file] : [])))].sort();
};

/** The nearest installed CLI from the config's folder up to the repository's root, relative to that folder. */
const nearestCli = (repo: string, dir: string): string | undefined => {
  const parts = dir === "." ? [] : dir.split("/");
  for (let i = parts.length; i >= 0; i--) {
    const at = [...parts.slice(0, i), CLI].join("/");
    if (existsSync(`${repo}/${at}`)) return posix.relative(dir, at);
  }
  return undefined;
};

/** A source's text; a file the index has but the working tree lost reads as empty (it names no variable). */
const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const list = (cwd: string, cli: string, config: string, env: Env) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["node", cli, "list", "--reporter", "json", "--config", config], {
        cwd,
        env: env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error((err.trim() || out.trim()).split("\n").slice(-5).join("\n") || `exit ${code}`);
      return listedFiles(out);
    },
    catch: (error) => new ConfigInvalid({ message: `e2e list in ${cwd}: ${error instanceof Error ? error.message : String(error)}` }),
  });

/** The configuration of every e2e config of the checkout (DESIGN.md §13). */
export const discoverE2e = (repo: string, blobs: Blobs, env: Env, only?: readonly string[]) =>
  Effect.gen(function* () {
    const configs = e2eConfigs(blobs.keys(), only);
    if (configs.length === 0)
      return yield* new ConfigInvalid({ message: `--e2e: no e2e.config.ts (or .mts, .js, .mjs) in the checkout${only ? ` under ${only.join(", ")}` : ""}` });
    const suites = yield* Effect.forEach(
      configs,
      (path) =>
        Effect.gen(function* () {
          const dir = posix.dirname(path);
          const base = posix.basename(path);
          const cli = nearestCli(repo, dir);
          if (!cli)
            return yield* new ConfigInvalid({
              message: `${path}: TesterArmy's e2e CLI is not installed (no ${CLI} from ${dir} up); install the repository's dependencies first`,
            });
          const tests = yield* list(dir === "." ? repo : `${repo}/${dir}`, cli, base, env);
          const prefix = dir === "." ? "" : `${dir}/`;
          const names = new Set<string>();
          for (const p of blobs.keys())
            if (p.startsWith(prefix) && SOURCE.test(p) && !p.split("/").includes("node_modules"))
              for (const n of envNames(readText(`${repo}/${p}`))) names.add(n);
          const suite: Suite = {
            name: `e2e:${dir}`,
            adapter: "e2e",
            dir,
            tests,
            run: ["node", cli, "run", "--config", base, "--reporter", "list"],
            sources: ["suite", "imports"],
            hashedEnv: [...names].sort(),
            inheritEnv: true,
            rerunAlone: false,
            maxAgeHours: 24,
            // A file never timed counts as a minute; a batch is killed after an hour, or 15 minutes silent.
            defaultMs: 60_000,
            timeoutMs: 3_600_000,
            idleMs: 900_000,
          };
          return suite;
        }),
      { concurrency: 4 },
    );
    const config: Config = { inputs: LOCKFILES, suites };
    return config;
  });
