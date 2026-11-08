# outrun

outrun's CI engine. Each test file is a unit. Its key is the hash of everything its verdict
depends on, read from git's index. A unit whose key already passed is replayed; the rest run in
batches (one process for many files), balanced across runners by their recorded durations.

```sh
outrun plan --out plan.json # look every unit up once: how many runners the misses need (0: start none)
outrun test --plan plan.json --shard 2/4   # run what the plan gives runner 2
outrun test --shard 2/4     # without a plan: every runner computes the same shares
outrun test --dry-run       # the plan, nothing run
outrun units                # every unit, its key and how many files the key holds
```

## In GitHub Actions

The action puts `outrun` on the job's PATH, at the version its tag pins; the job's steps then call
it as on a laptop:

```yaml
permissions:
  contents: read
  id-token: write # the cache authenticates the job by its OIDC token
env:
  OUTRUN_CACHE_URL: https://cache.outrun.sh
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: arkadia-so/outrun@v1
      - id: look
        run: outrun lookup build
      - if: steps.look.outputs.run == 'true'
        run: make build
      - if: success() && steps.look.outputs.run == 'true'
        run: outrun record build --key "${{ steps.look.outputs.key }}"
```

It runs this repository's sources at that tag on Bun 1.4.4, downloaded once per machine into the
runner's tool cache and checked against its SHA-256, with the dependencies of `bun.lock`. The job's
own `bun`, if it has one, is not changed. Runs on macOS (Apple silicon) and Linux (arm64, x64).

## The keys

Two phases. A unit's **weak key** hashes how it runs: the key recipe's version, its runner,
folder, file and command, the toolchain's fingerprint (runner version, OS and release, CPU
architecture, image, Unix user, which declared system binaries exist) and the keyed variables
(locale, time zone, the runtime's options, `CI`, and those `outrun.json` adds). A **strong key**
adds the content, by git blob id, of a set of files: the suite's inputs (global inputs such as the
lockfile, the preloads' closure, the declared inputs) and either

- a read set a traced run recorded for that weak key (what the test actually read: files it
  opened by content; files it only stat'ed or probed and found absent by presence, so a runner
  that stats every test file at start does not tie each test to the others' text, unless the
  suite sets `"statOnly": "content"`; folders it listed by their entries; a trace that lost read
  events records no set), or
- the import closure, the upper bound: relative imports, tsconfig `paths`, package.json
  `imports`, workspace packages through their `exports`, and relative paths written as string
  literals (a spawned script, a fixture folder). Type-only imports do not count. An import that
  does not resolve, or a file that does not parse, makes the unit depend on its whole package.

A unit hits when any of its strong keys passed. Files come from git's index (tracked, or new and
not ignored), never from globbing the working tree; keys hold no absolute path, machine name or
time. A unit runs with only the allow-listed variables and its own `TMPDIR`.

## Verdicts and trust

A verdict records a pass: unit, key, duration, time, tier and producer (commit, runner, image).
Main's CI writes `trusted`; a pull request `pr-<n>`; a session or another branch `session-<id>`;
a laptop `local-<host>`. Each reads its own tier, then `trusted`. Verdicts expire after 7 days.
The remote cache enforces the split on its side; the client checks tiers and ages again.

On this machine (`$OUTRUN_STATE_DIR`, by default `~/.cache/outrun`), and on any Turborepo remote
cache (v8 API): `OUTRUN_CACHE_URL`, `OUTRUN_CACHE_TEAM`, and `OUTRUN_CACHE_TOKEN` or, in a GitHub
Actions job with `id-token: write`, the job's OIDC token.

The client is gentle with the network: at most 8 requests to the cache at once, over keep-alive
connections, to one address of the cache's host (resolved once, the next one tried after a
failure), so a burst of lookups or of Nx's requests never becomes a burst of new connections.

## Running

- Batches are admitted by memory (each suite declares `memoryMb`), killed with their whole process
  group by a deadline or after `idleMs` (300 s) without output.
- A red or unfinished unit runs again alone in a fresh process. Red then green is **flaky**: it is
  quarantined for 7 days (always run, never replayed, its failures reported but not blocking).
- About 1 % of hits (`--audit`) are re-executed on idle capacity. A cached pass that fails now marks
  its suite **diverged**: no verdict of it is replayed for 7 days, and the run fails.
- A run that writes into the working tree (beyond ignored files) writes no verdict and fails.
- `--trace file` takes the tracer's JSON lines for the run and records each unit's read set.

## Configuration

`outrun.json` at the repository's root:

```json
{
  "inputs": ["bun.lock", "package.json"],
  "env": ["MY_FLAG"],
  "system": ["sqlite3"],
  "trustedRef": "refs/heads/main",
  "suites": [
    { "name": "core", "adapter": "bun", "dir": "packages/core", "tests": ["test/**/*.test.ts"], "run": ["bun", "test"], "roots": ["test/preload.ts"] }
  ],
  "commands": [
    { "name": "e2e:app", "run": "bun run test:e2e", "inputs": ["packages/app/**"], "roots": ["packages/app/src/**/*.ts"] }
  ]
}
```

A suite's `adapter` names its runner. `run` is its batch command; the adapter adds its report flags and the files.

| Adapter | `run` example | Report |
| -- | -- | -- |
| `bun` | `bun test` | JUnit, one suite per file |
| `vitest` | `vitest run` | JUnit, one suite per file |
| `pytest` | `python -m pytest` | JUnit `xunit1`, cases grouped by file; a file with no test passes |
| `xcode` | `xcodebuild -quiet` | the result bundle's test cases, by the type each file declares |
| `catch2` | `build/test/unittest` | Catch2's JUnit, each test case named after its file (a binary whose tests are scripts named by path); the binary's sources are declared inputs |

## Xcode

An `xcode` suite is one test target of a scheme; each Swift file of it is a unit:

```json
{ "name": "AppTests", "adapter": "xcode", "dir": ".", "tests": ["AppTests/**/*.swift"], "run": ["xcodebuild", "-quiet"],
  "sources": ["suite"], "xcode": { "project": "App.xcodeproj", "scheme": "App", "destination": "platform=iOS Simulator,name=iPhone 17", "target": "AppTests" } }
```

- Before its first batch, a runner resolves the packages (with git), then builds the scheme for
  testing once into its scratch folder, with `GIT_DIR` pointing nowhere and package resolution off:
  xcodebuild otherwise runs `git status` over the checkout about a hundred times per build. A build
  that fails fails the run.
- A batch is one `test-without-building` with an `-only-testing:<target>/<id>` for each test type a
  file declares at its top level (XCTest classes, Swift Testing suites, extensions) and each top-level
  `@Test` function. Each test case of the result bundle goes back to the file declaring its type; a
  file with no test passes.
- One simulator runs one xcodebuild at a time: run xcode suites with `--slots 1`.
- Keys: outrun has no Swift import graph, so a file's key is its suite's inputs and itself; keep
  `"sources": ["suite"]` (every file under `dir`) unless `inputs` lists every file a build can
  read. A traced key leaves out the `suite` folder (a complete trace saw what the run read,
  the build's compiler reads included) but keeps the global and declared inputs.
- Read sets: trace the run with `OUTRUN_TRACE_MODULES=1`, then `outrun xcode-reads --trace-dir <the
  tracer's folder> --build <the tracer unit> --out observed.jsonl` gives each test file its target's
  set: the build's reads without what only the targets its test target does not import read (the
  build system's own reads stay), plus the test runs'. `outrun test --trace observed.jsonl` records it.

A **command unit** is a whole CI step (a build, a browser suite) cached as one pass. Its key holds the
machine, the keyed variables, `run` and the content of its `inputs` and of its `roots`' import
closures. `outrun plan` adds a GitHub output `run-<name>` (true or false) for each, and for names
written `group:id` a `group-<group>` list of the ids to run, for a job's matrix; the CI job runs the
step itself, then `outrun record <name> --key <its key> --since <start>` writes its pass (`outrun plan`'s
`keys` output: a step that writes into the checkout, like a build, would change the key computed
after it). A job can also skip the plan: `outrun lookup <name>` answers for one command alone (outputs
`run` and `key`), so its job starts with the plan job instead of after it. A command marked
`"quarantined": true` never gates (a test known to fail, kept to report): its job records it even red,
`outrun record <name> --failed`, so the known failure replays until its inputs change instead of
costing its run every time.

## Nx repositories

A repository on Nx keeps Nx as its task runner. `outrun nx-cache --port 7070` serves Nx's self-hosted remote cache API (Nx 20.8+) on `127.0.0.1` and stores each archive in outrun's cache, in the scope the job's token gives it. Start it in the background, then set `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://127.0.0.1:7070`. A cache that cannot answer is a miss: Nx runs the task. A refused write is logged and answered as stored, since Nx fails the task on any other answer.

A repository on Bazel keeps Bazel the same way. `outrun bazel-cache --port 7071` serves Bazel's HTTP remote cache (GET, HEAD and PUT on `/ac/` and `/cas/`), stored in outrun's cache under the same rules; point Bazel at it with `--remote_cache=http://127.0.0.1:7071`.

## End-to-end tests

`--e2e` runs a repository's [TesterArmy e2e](https://www.npmjs.com/package/e2e) suites with no
`outrun.json`: every `e2e.config.{ts,mts,js,mjs}` git knows is a suite, and each test file its CLI
lists (`e2e list --reporter json`) is a unit. A runner's share of a suite runs as one `e2e run`
with the config's own workers; a file's verdict is its JUnit testsuite.

```sh
outrun plan --e2e --out plan.json   # defaults for e2e: --target 300 --start 60 --max-runners 16 --slots 1
outrun test --e2e --plan plan.json --shard 2/4
outrun junit-merge --out e2e.xml shard-*/**/junit.xml   # one report; a Markdown summary on stdout
```

A unit's key holds every file of its config's folder (the app, when the config sits in its
package), its import closure, the lockfiles, Node's version, the machine, and a digest of every
variable the folder reads by name (`process.env.ACME_URL`): another deployment is another app under
test. A pass replays for 24 hours, since the app may change without a commit. The tests get the
job's whole environment, and a red file is not run again alone (the config's `retries` decide).
`--only <path>` keeps the configs whose folder holds or lies under the path.

In GitHub Actions, the reusable workflow plans, fans out and merges the reports:

```yaml
jobs:
  e2e:
    uses: arkadia-so/outrun/.github/workflows/e2e.yml@v1
    permissions: { contents: read, id-token: write }
    with:
      runs-on: outrun-linux-arm64          # outrun-macos for an iOS simulator target
      install: npm ci                      # dependencies, e2e's CLI among them
      setup: npx playwright install --with-deps chromium
      env: ACME_URL=https://staging.acme.example
      env-secrets: ACME_MODEL_TOKEN        # secrets the tests read, by name
    secrets: inherit
```

The repository needs `e2e` in its dependencies, Node on the runner, `.e2e/` git-ignored (outrun
writes each batch's report under `.e2e/outrun-*`, inside the project root as the CLI requires), and
the token its config's model needs. The model is the config's; an OpenAI-compatible gateway such as
`https://ai.trait.so/v1` with a role alias (`fast`) is one line of it:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { E2EConfig } from "e2e";

const gateway = createOpenAICompatible({ name: "trait", baseURL: "https://ai.trait.so/v1", apiKey: process.env.ACME_MODEL_TOKEN });
export default { /* tests, targets */ agents: { default: { model: gateway("fast") } } } satisfies E2EConfig;
```

## License

MIT or Apache-2.0.
