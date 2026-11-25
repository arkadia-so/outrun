---
name: outrun
description: >-
  Move a repository's GitHub Actions CI to outrun's runners (outrun.sh) and make it as fast as it
  can be: the one-line move to outrun's runners and its rollback, the measurement protocol (`outrun
  report` on a run: the critical path, each job's pickup, setup, work and post, the speed of light,
  the step a change added against the job's history and its budget, the cache ledger and whether
  each cache pays, CPU and memory contention; cold, warm, one-file and wide changes), the levers
  ranked by measured gain (cache saves, split and time-balanced test jobs, affected-only tests on
  push, the image's tools, and the work itself: a faster tool for a check, what each test has to
  prove), the traps already hit with their fixes, what the repository's owner decides versus what an
  agent may change (with each change's rollback), and when the work is done. Use when a repository
  moves to outrun, when its CI is slow, when a job on outrun fails in a way it did not on GitHub's
  runners, and before reporting CI speed figures.
---

# outrun: move a CI, then make it fast

This is the playbook for an agent, working for a repository's owner, that moves the repository's CI to
outrun and then makes it as fast as possible. Every figure comes from a real customer's CI, measured
before and after the change. Most of them come from **a Flutter + TypeScript monorepo** with Linux,
Android, iOS and simulator end-to-end jobs. Reference: [README.md](../../README.md) (the `runs-on`
labels, their tiers and prices, the action, `outrun report`), and [outrun.sh](https://outrun.sh).

Three rules hold throughout:

- **GitHub Actions is the interface.** Keep standard workflows that still run unchanged on GitHub's
  runners: leaving outrun must cost one `runs-on` value. Reach for an outrun-specific file or setting
  only when no native field can say it.
- **Measure before changing anything.** Measure again after each change. A lever without a before and
  after figure is a guess.
- **One change, one commit, one rollback.** Write each change's rollback in its commit message.

## What is automatic

Changing `runs-on` is all a repository does. **Automatic** once a job runs on an outrun label:

- On Linux runners, `actions/cache` (and every `setup-*` cache built on it) is served by outrun's
  cache, close to the machines, scoped by repository and branch as on GitHub. On macOS runners too,
  with GitHub's cache behind it: an entry outrun's cache does not have is looked up there, and a
  save outrun's cache cannot take goes there.
- On Linux runners, the toolchains jobs install in the tool cache and the usual dependency caches
  of the home (npm, pnpm, pub, cargo, rustup, uv, Gradle...) come back warm for the repository's
  next jobs.
- A job takes a runner already waiting whenever one is free.

outrun does not trim your cache saves: restricting them is lever 1 below.

## 1. Move

1. Install outrun's GitHub App on the organisation ([outrun.sh](https://outrun.sh)).
2. Name the runner in a repository variable, never in the YAML, so going back is one command:

   ```yaml
   runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
   # macOS, a JSON list:
   runs-on: ${{ fromJSON(vars.MACOS_RUNNER || '["macos-26"]') }}
   ```

   `gh variable set CI_RUNNER --body outrun-ubuntu-24.04-arm` moves the jobs; `gh variable delete
   CI_RUNNER` brings them back. Labels, named as GitHub's (the image's OS and version, `-arm` for
   arm64, `-8` for 8 vCPU): `outrun-ubuntu-24.04` (Linux x64, 4 vCPU), `outrun-ubuntu-24.04-8` (a
   whole x64 machine), `outrun-ubuntu-24.04-arm`, `outrun-macos-26`; `-priority` or `-flex` after
   any of them picks a tier. The older `outrun`, `outrun-8cpu`, `outrun-linux-arm64` and
   `outrun-macos` still work, as deprecated aliases of the same runners: move off them.
3. Leave jobs on GitHub's runners when a GitHub feature needs them: publishing with trusted
   publishing (npm's OIDC), and store uploads whose credentials are bound to GitHub's runners.
4. Before moving to arm64, check the arm64 gaps (section 4): SDKs without a Linux arm64 build, and
   Android's x64-only build tools.
5. Run the whole workflow once by hand (`workflow_dispatch`) on outrun before the first real push.

## 2. Measure

Take every figure from GitHub's own timestamps, never from memory or the UI's rounded times.
`outrun report` computes them from one run, with nothing to configure: it reads the run, its jobs,
the workflow file that ran and the job's earlier runs with your token, and works on any run, on
outrun's runners or GitHub's (so measure a run before the move too).

```sh
GH_TOKEN=<a token that reads the repository's Actions> \
  outrun report https://github.com/<owner>/<repo>/actions/runs/<id>   # --json for a script
```

In a job, the CLI is on the PATH after `uses: arkadia-so/outrun@v1` (the job's `GITHUB_TOKEN` with
`actions: read` and `contents: read` is enough); elsewhere, from a clone of `arkadia-so/outrun` at its latest tag:
`bun install --frozen-lockfile`, then `bun src/main.ts report <run>`. Read its output in this order:

- **Wall clock**: the first job queued to the last step done.
- **Critical path**: the chain of `needs:` that ends last, the job everyone waits on. Per job:
  **pickup** (queued to started: the wait for a runner), **setup** (Set up job, checkout, `setup-*`
  actions, cache restores), **work** (`run:` steps and other actions), **post** (`Post` steps, cache
  saves), the time outside steps, and how long it queued after its need ended. Jobs off the path
  come with their **slack**: how much longer they could take without delaying anyone.
- **Speed of light (estimated)** and the **gap** to it: the run's shortest pickup, plus the longest
  work of one job, plus that job's setup no cache removes. The gap is what a lever can still win.
- **To shorten this run**: the job taking most of the critical path, and its largest step or its
  pickup. Start there (section 3).
- **Time added**: each job against the same job in the workflow's 10 earlier successful runs on the
  default branch (n, median, p90), and the step that appeared or grew past its history's spread, by
  how much. On the run that adds a check, its cost is printed. Then each job's **budget**: its
  `timeout-minutes`, else the p90 of that history; `!` marks a job over it.
- **Cache** (outrun's runners only): each restore and save of each job, the key, exact or partial
  hit or miss, bytes, transfer time, in which step. `!` flags a save longer than the job's own work,
  and a save of the same bytes the job restored (unchanged content).
- **Does each cache pay?**: per restore step, over the same job's recent successful runs on the
  default branch (lever 1).
- **Contention** (outrun's runners only): per step, CPU against the vCPUs, peak memory against the
  job's, and the time tasks waited for a CPU or memory; `!` flags workers beyond the cores, memory
  pressure, a process killed (lever 2).
- What a runner or the platform cannot measure is printed "not measured", with why; never read it
  as zero. A job without a cache or contention section did not run on outrun's runners, or ran
  before they recorded it.

Measure four cases, each at least three times, and report min, median and max with run ids:

| Case | What it shows |
| -- | -- |
| **Cold**: a new commit on a machine with empty caches | the worst case, and what the caches are worth |
| **Warm**: the same workflow again with nothing changed | the floor of setup and pickup |
| **Narrow**: a one-file change | what an agent waits for on most pushes |
| **Wide**: a change to a file most of the code depends on | the worst push |

Measure the same commit on the old runners and on outrun, with `outrun report` on each run. The
**speed of light** it prints is one pickup, plus the longest unit of work that must run, plus the
setup that cannot be cached; the gap between the run and it is where the next lever is. Other runs of the same
organisation contend for the same runners, so note what else was running. Rerun a figure that looks
off on a quiet moment before believing it.

## 3. Levers, ranked by measured gain

Work in this order, measuring after each lever. The figures come from the Flutter + TypeScript
monorepo unless stated otherwise.

**Start from the run, not from this list.** Run `outrun report` on one real run (section 2): its
critical path is the job everyone waits on, and its "to shorten this run" line names the job and
the step to work on. A lever on a job outside that chain changes nothing a person or an agent waits
for (its slack says by how much it could grow first): with a 10 min build and a 1 min lint, an
instant lint still leaves 10 min. And a larger runner is the last lever, not the first: it is paid
on every run, while work removed is removed for good.

1. **Saves that dominate a job.** Look at every post step first.
   - A lint job spent **248 s of its 324 s saving the analyzer's cache** to the Actions cache. The
     analysis itself took 4 s.
   - Without that save, the job took **50 s**.
   - Rule: save a cache only from the default branch, only when its key changed, and never one that
     takes longer to save than the work it saves.
   - A cache hit is not a faster job by itself. `outrun report`'s "does each cache pay?" compares,
     per restore step over the same job's recent successful runs on the default branch, its
     **cost** (the median restore step on an exact hit plus the median save step on a miss) with
     what it **avoids** (the median rest of the job on a miss minus on an exact hit): a cold run
     against a warm one. Drop the cache that loses. Under 3 hits or 3 misses it says "not enough
     runs": wait for more, never judge one run.
   - Its cache section flags a save that takes longer than the job's work, and a save of content
     the job had just restored unchanged: both are saves to restrict.
2. **Split the test job, shard it by measured times.**
   - One `flutter test` job took **393 s**. Split into up to 8 jobs, it took **26–53 s per job**.
   - Balance shards by each file's last measured duration, not by file count.
   - Measure each level of parallelism instead of assuming more is faster: workers beyond the
     machine's cores or memory compete with one another (a team reported a build made slower by
     extra build workers; not measured by us). Run the job at each worker count, three times each,
     and read `outrun report`'s step times and its contention section: **workers beyond the
     cores** (tasks waited for a CPU over a quarter of the step while it used most of the vCPUs),
     **memory pressure** (tasks waited for memory, or its peak neared the job's memory), **a process
     killed** (an OOM kill, exit 137). A flagged count is past the useful level: keep the fastest
     count with no flag. Fewer workers is the free answer; a bigger runner is the costly one, paid
     on every run.
   - With the move to arm64 and warm caches, the whole push CI went from **591 s to 138–160 s**.
3. **Affected-only tests on push, the full suite on the default branch.**
   - Select the tests a change can reach from its import graph. Add the tests that read sources as
     text: in the monorepo, 43 of the 129 tests one leaf file selected were of that kind.
   - Keep the full suite on the default branch and at night, so a wrong selection is caught within
     the day.
4. **The tools already in the image.**
   - Use the versions the runner's tool cache already holds, and let `setup-*` actions find them
     instead of downloading.
   - Measured per macOS shard: setup-node 3 s → 0 s, setup-bun 23 s → 7 s, the outrun action 11 s →
     1 s, and the setup steps ~40 s → **~10 s**.
5. **The work itself: what a check does, and with which tool.** The levers above make the same work
   start sooner and run in parallel; this one removes work. Not measured by us: the figures are one
   team's, on a content site of thousands of static pages (2026-11), from separate experiments.
   - **A faster tool for the same check.** Reported: lint 107 s → 3 s (ESLint to Oxlint), format
     37 s → 1 s (Prettier to Oxfmt), type check 67 s → 17 s (TypeScript's native compiler),
     dependency install 3–6 s with Bun while builds and tests stayed on Node. Change one tool at a
     time, and hold the check to what it caught before: list the lint rules the new tool lacks, and
     make sure a faster type check still reads every file the old one read (templates, generated
     code). A check that silently covers less is not a speed-up.
   - **What each test has to prove.** When thousands of inputs go through one template, test the
     template on representative cases and validate the inputs apart, without a browser. Keep
     browser tests for navigation, interaction and integration: loading every page to repeat one
     assertion is the expensive way to prove it once.
   - **A build that fits the product.** The same team's build treated each article as a route of
     its own; grouping them, then building the content as static HTML, brought a full build to
     33–35 s.
   - These change what the repository checks or ships, so they are the owner's to decide (section
     5): bring the measured time of the step, the tool or test you would change, and what would no
     longer be covered.
6. **The critical path last.**
   - Move the remaining jobs (plan, gate) only after measuring: moving them gave 114–167 s → 126–268 s
     on a busy hour, a loss until rerun on a quiet one.
   - Fold small jobs into the job that needs them, since each job costs a pickup.
   - Keep e2e and native builds off the push gate: run them dispatched, on the default branch for the
     affected flows, or at night. Their best case is already over 3 minutes (build ≥ 60 s, pickup,
     boot and install ~40 s, then the tests).

## 4. Traps already hit

| Trap | Symptom | Cause | Fix |
| -- | -- | -- | -- |
| Cache save dominating | The post step takes longer than the work (248 s of 324). | The Actions cache saved a large folder on every run. | Save only on the default branch when the key changed. |
| A cache moved to a new store, writers first | A job misses, or fails on a missing file, restoring what an earlier job just saved, on some runners only. A job that untars a build without checking the restore hit fails further on. | The new store (a new key, path, tier or cache service) reached the writers before every reader: a save to the new store is invisible to a job still reading the old one, and runners or branches move one by one. | Readers first: every reader looks in the new store and falls back to the old one. Turn writes to the new store on only once every reader reads it. Check that a restore hit before using what it restores. |
| Jobs lost to the infrastructure | Shards get a runner, run no step and fail at the job's timeout. Rerunning one shard then makes GitHub refuse the others (403). | The runners were restarted under running jobs. | Rerun all failed jobs together (`gh run rerun $RUN --failed`), never one by one. Report the run id to outrun. |
| Network errors in a burst | ENOTFOUND, ECONNRESET, a TLS handshake taking seconds, 504s downloading a tool from GitHub. | Many new connections at once, or the upstream server failing. | Retry every download with backoff (3 tries). Prefer the image's tools. Pin tools by version and checksum. |
| An install with no network misses the package cache | The job's install succeeds, then a step that installs again with no network (a sandbox, a network namespace, a container given the job's package cache) fails: `DNSResolveFailed downloading tarball <package>`, ENOTFOUND. | A job's user configuration (`~/.npmrc`) may name a package mirror close to the runner as the default registry. Bun and npm key their cache by registry, so a process that does not read that file (another home, an allowlisted sandbox) looks for the public registry's entries, finds none and downloads. | Tell the inner process the registry the job's install used: `NPM_CONFIG_REGISTRY="$(npm config get registry)"` in its environment, or let it read `~/.npmrc`. |
| arm64 gaps | `flutter` has no Linux arm64 archive. Android's build tools fail on arm64. `gh`, `zip`, `sqlite3`, `pip` or `aws` are missing. | Upstream ships x64 only, or the image lacks the tool. | Install Flutter from its git tag and run `precache`. Keep Android jobs on an x64 label. Install a missing tool only when `command -v` fails. |
| Out of memory | A test job is SIGKILLed (exit 137) only on some runs. | The job's peak memory (one suite: 4.9 GB, one file 2.1 GB) exceeded a smaller VM. | Read the step's peak memory and the kill in `outrun report`'s contention section. Fewer workers or a split job first; a larger runner last. |
| A file outside the checkout | A test passes on a laptop and fails in CI after a sparse or per-folder checkout. | The test reads another package's file. | Add the path to the job's checkout and its selection inputs. |
| Slow pickup with idle capacity | "Set up runner" takes 46–126 s, or a job queues for minutes while others start at once. | On outrun's side, the scheduler was slow to hand out jobs. | Report the run id with each job's `created_at` and `started_at`. Do not work around it in the workflow. |

## 5. Who decides, and how to roll back

**An agent may do these alone**, each measured, in its own commit, with its rollback:

| Change | Rollback |
| -- | -- |
| A job's runner, through a repository variable | `gh variable set CI_RUNNER --body <previous>`, or `gh variable delete CI_RUNNER` |
| macOS jobs' runner | `gh variable set MACOS_RUNNER --body '["macos-26"]'` |
| Splitting or sharding a job; time-balanced shards | revert the commit |
| Removing or restricting a cache save | revert the commit |
| Retries and install-if-missing for tools | revert the commit |
| Pinning or upgrading `arkadia-so/outrun` | pin the previous tag |
| Measurements and the report | none needed |

**The owner decides these.** Ask in one line with the measured gain:

- **What runs where and when:**
  - affected-only selection on push;
  - moving e2e or native builds off the gate;
  - a test dropped, quarantined or rewritten;
  - a linter, formatter, type checker, package manager or build tool replaced (lever 5): say which
    rules or files the new one does not cover.
- **What changes the bill:** a larger runner (`-8`) or another tier (`-priority`, `-flex`).
- **Secrets, tokens, GitHub environments, OIDC trust**, and anything that publishes or deploys.
- Moving a job **off GitHub** when a GitHub-only feature needs it (section 1).

## 6. Done when

- **Push CI:**
  - wall clock under **3 min** for a narrow change;
  - pickup p50 under 5 s;
  - no step other than the work over 20 % of its job.
- **Measurements:** every figure taken at least three times, with run ids.
- **It stays fast:** each layer has a time budget written in the repository, in its workflow (the
  push CI's 3 min), and each job its `timeout-minutes`. `outrun report` holds each
  job to it (or, without one, to the p90 of its history) and marks a job over it with `!`; on the
  run that adds a check, its "time added" prints what the check costs. A new check says which
  failure it catches, what already covers that failure and what it adds to its layer's budget; a
  layer over its budget is a problem to fix, not a number to raise. No check is free.

Report to the owner in this shape:

```markdown
## CI on outrun: <repo>, <date>
| Case | Before (runner, runs) | After (runs) | Gain |
| Cold / Warm / One-file / Wide | min–max s, ids | min–max s, ids | × |
Levers applied: <lever>: <before> → <after> (<commit>), rollback: <command or revert>.
Traps hit: <symptom>: <fix>.
Tried, no gain: <lever or tool>: <before> → <after>, so that the next agent does not try it again.
Left, by expected gain: <lever>: <expected gain>, <who decides>.
Needs your decision: <one line each, with the measured gain>.
```
