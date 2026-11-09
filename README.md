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
`outrun.json`: every `e2e.config.{ts,mts,js,mjs}` git knows is a suite, and each test its CLI lists
(`e2e list --reporter json`) is a unit, named by the line it is declared at (`e2e/checkout.e2e.ts:12`):
one file's tests spread over several runners, so the wall is bounded by the longest test, not the
longest file. A serial group is one unit (at its first test's line, which runs the whole group), and
tests declared on one line (a loop) are one unit. A runner's share of a suite runs as one `e2e run`
given those `file:line`s, with the config's own workers; each test's verdict and duration come from
e2e's `report.json`. Durations are learned per test, by its title path, so a test that moves within
its file keeps its time; its key is still its whole file's (content and import closure).

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

`OUTRUN_E2E_FILTER` selects tests with e2e's own flags (`--tag`, `--tag-mode`, `--exclude-tag`,
`--grep`, `--grep-invert`, `--target`; anything else is refused): applied when a config is listed,
so a test it leaves out is no unit and takes no runner, and passed to every `e2e run`, so it is in
each unit's key and in the listing's. A config left empty by the filter is no error.

A config's listing is kept (on the machine and in the remote cache) under the key of what can
change it: its folder's paths, the content of its test files (named `*.e2e.*`, `*.test.*`,
`*.spec.*`, or under an `e2e/` or `test(s)/` folder), its import closure, the lockfiles and the
variables the folder reads. `outrun plan --e2e --cached-listings` plans from kept listings alone,
without e2e's CLI or the repository's dependencies, and writes `planned=false` to `$GITHUB_OUTPUT`
(and no plan) when a config has none, so a job installs and plans again only then.

An app the tests drive on a device (an iOS simulator `.app`) is built once per run. `outrun
e2e-app-key --build <cmd> --inputs <glob>...` is its key: the command, the machine (OS, release,
image) and the content of the files the globs match. Set as `OUTRUN_E2E_APP`, it is in every
discovered unit's key, so a new build reruns the tests and an unchanged one replays them.

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
      filter: --exclude-tag release        # e2e's selection flags (OUTRUN_E2E_FILTER)
      environment: e2e                     # the GitHub environment of the jobs that run tests
    secrets: inherit
```

`secrets: inherit` reaches the workflow only from a repository of the same organization (GitHub's
rule). From another organization, write the variables in the `env` secret instead, NAME=value per
line; each value is masked in the logs:

```yaml
    secrets:
      env: |
        ACME_MODEL_TOKEN=${{ secrets.ACME_MODEL_TOKEN }}
```

`environment` puts the plan job (which builds the app) and the shards in that GitHub environment:
its secrets reach `secrets: inherit`, and their OIDC tokens carry its subject
(`repo:<owner>/<repo>:environment:<name>`), so a cloud trust that accepts only that environment
works unchanged. outrun's verdict cache trusts only the token's repository, whatever its subject.

The plan job installs nothing when every config's listing is kept. On `outrun-macos`, the app is
built once and each shard installs it on a simulator:

```yaml
    with:
      runs-on: outrun-macos
      install: npm ci
      build: ./scripts/build-simulator-app.sh   # once per run, after install
      build-inputs: ios/** package-lock.json    # its key, with the command and the image
      build-cache: build/ios ios/Pods           # the build's own cache folders, back before a build
      app: build/Acme.app                       # given to each shard at this path
      simulator: iPhone                         # booted when none is (the newest runtime's)
```

The plan job takes the app from the fleet's cache tiers when its key was built before (`$OUTRUN_CACHE`,
then `$OUTRUN_CACHE_PROTECTED`, written by the default branch's runs), else builds it there (no job of
its own, so no pickup of its own) and saves it into the job's tier; the shards get it from the tier or
as the run's artifact. Before a build, the `build-cache` folders come back from the tiers as the last
build on this machine left them (one entry per build command, machine and folders, never per key), and
they are saved again after it, so a new key builds incrementally. `outrun tier restore <entry> <file>`
and `outrun tier save <file> <entry>` are those moves, usable in any step. A shard boots its simulator first, so it
boots while the job installs, then installs an iOS `.app` on every booted simulator, so a config that
names no `device` runs on it. The XCTest runner e2e's iOS driver builds on its first run is kept in
the tiers too, keyed on the driver's version and Xcode's. The build is
skipped, with the matrix, when every test replays.

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

## outrun check: the fast CI on outrun's VMs

`outrun check` runs a repository's fast CI on the tree of HEAD (committed changes only) on outrun's
Linux VMs instead of the laptop: warm checkouts of `main`, HEAD's tree sent as a patch, the units
split over several VMs by their expected times, the verdict and the failures' logs back in about
the time of the longest share. The repository declares its check in `.outrun/check.json`:

```json
{
  "setup": ["curl -fsSL https://example.com/install-tools.sh | bash", "make deps"],
  "prefill": "make check",
  "install": { "when": ["package.json", "**/lockfile"], "run": "make deps" },
  "plan": "tools/ci-units.sh \"$OUTRUN_CHECK_BASE\"",
  "run": "tools/ci-run-units.sh"
}
```

- `setup` (once per warm commit of `main`; the tools of a `mise.toml` are installed before it),
  `prefill` (optional, runs the check once so its caches are warm; its failure is recorded, never
  fatal), `install` (after the patch, only when a file matching `when` changed).
- `plan` prints a JSON array of units, each an id or `{"id", "ms", "group"}`: `ms` its expected
  time, units of one `group` kept on one VM. `OUTRUN_CHECK_BASE` is the warm commit; HEAD is one
  commit on it holding the change, whose message is the change's commit messages, newest first,
  with all their trailers last, so `git log "$OUTRUN_CHECK_BASE..HEAD"` reads them as locally
  (since 1.5.3).
- `run` runs the units in `OUTRUN_CHECK_UNITS` (one per line) and exits 0 when they pass. It may
  write `[{"id", "ms", "exit", "cache"}]` to `OUTRUN_CHECK_REPORT`.

Each command is a bash script run at the checkout's root, stopping at its first failing line.

```sh
OUTRUN_API_TOKEN=ort_... OUTRUN_INSTALLATION=<id> OUTRUN_GITHUB_TOKEN=<a token that reads the repo> \
  outrun check --workers 4
```

Exit 0: every unit passed; 1: one failed (its log printed); 3: outrun did not run it (unreachable,
no warm checkout yet, no VM free): run the check locally instead. The repository must be listed in
the installation's check settings.

## License

MIT or Apache-2.0.
