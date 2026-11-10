---
name: outrun
description: >-
  Move a repository's GitHub Actions CI to outrun (outrun.sh) and make it as fast as it can be:
  the one-line move to outrun's runners, the measurement protocol (pickup, checkout, setup, work,
  cache saves; cold, warm, one-file and wide changes), the levers ranked by measured gain (warm
  runners, split and time-balanced test jobs, affected-only tests on push, `outrun check` for the
  pre-push gate, caches kept on the machines, the image's tools, e2e sharding and replay), the traps
  already hit with their fixes, what the repository's owner decides versus what an agent may change
  (with each change's rollback), and when the work is done. Use when a repository moves to outrun,
  when its CI or its pre-push check is slow, when a job on outrun fails in a way it did not on
  GitHub's runners, and before reporting CI speed figures.
---

# outrun: move a CI, then make it fast

This is the playbook for an agent, working for a repository's owner, that moves the repository's CI to
outrun and then makes it as fast as possible. Every figure comes from a real customer's CI, measured
before and after the change. Most of them come from **a Flutter + TypeScript monorepo** with Linux,
Android, iOS and simulator end-to-end jobs. Reference: [README.md](../../README.md) (the CLI, the
action, `outrun check`, `outrun e2e`), and [outrun.sh](https://outrun.sh).

Three rules hold throughout:

- **GitHub Actions is the interface.** Keep standard workflows that still run unchanged on GitHub's
  runners: leaving outrun must cost one `runs-on` value. Reach for an outrun-specific file or setting
  only when no native field can say it.
- **Measure before changing anything.** Measure again after each change. A lever without a before and
  after figure is a guess.
- **One change, one commit, one rollback.** Write each change's rollback in its commit message.

## What is automatic, what you configure today

The goal is that changing `runs-on` and adding `uses: arkadia-so/outrun@v1` is all a repository
does. It is not there yet.

**Automatic** once a job runs on an outrun label:

- On Linux runners, `actions/cache` (and every `setup-*` cache built on it) is served by outrun's
  cache, close to the machines, scoped by repository and branch as on GitHub. On macOS runners too,
  with GitHub's cache behind it: an entry outrun's cache does not have is looked up there, and a
  save outrun's cache cannot take goes there.
- On Linux runners, the toolchains jobs install in the tool cache and the usual dependency caches
  of the home (npm, pnpm, pub, cargo, rustup, uv, Gradle...) come back warm for the repository's
  next jobs.
- A job takes a runner already waiting whenever one is free.

**What you configure today:**

1. **The verdict cache** (`outrun lookup`, `record`, `plan`, `test`): `uses: arkadia-so/outrun@v1`,
   `permissions: id-token: write` and `OUTRUN_CACHE_URL: https://cache.outrun.sh`. Without the URL,
   verdicts stay on one machine. The e2e reusable workflow sets the URL itself, but still needs
   `id-token: write`.
2. **Units**: `outrun.json` (suites, commands) and `.outrun/check.json` for `outrun check`. Only
   TesterArmy e2e suites are found with no file (`--e2e`). Nx and Bazel keep their own task graph,
   and you start `outrun nx-cache` or `outrun bazel-cache` and point the tool at it.
3. **Large caches on macOS runners**: `actions/cache` there is outrun's cache, but a folder
   stays on the machines only when the workflow restores and saves it (`$OUTRUN_CACHE`,
   `$OUTRUN_CACHE_PROTECTED`, `outrun tier restore|save`, or the e2e workflow's `build-cache`).
4. **Cache saves**: outrun does not trim them. Restricting your own saves is lever 1 below.
5. **Warm runners**: outrun sets them on request (repository, label, count, simulator). They do
   not follow demand yet.

## 1. Move

1. Install outrun's GitHub App on the organisation ([outrun.sh](https://outrun.sh)).
2. Name the runner in a repository variable, never in the YAML, so going back is one command:

   ```yaml
   runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
   # macOS, a JSON list:
   runs-on: ${{ fromJSON(vars.MACOS_RUNNER || '["macos-26"]') }}
   ```

   `gh variable set CI_RUNNER --body outrun-linux-arm64` moves the jobs; `gh variable delete
   CI_RUNNER` brings them back. Labels: `outrun` (Linux x64), `outrun-8cpu` (a whole x64 machine),
   `outrun-linux-arm64`, `outrun-macos`.
3. Leave jobs on GitHub's runners when a GitHub feature needs them: publishing with trusted
   publishing (npm's OIDC), and store uploads whose credentials are bound to GitHub's runners.
4. Before moving to arm64, check the arm64 gaps (section 4): SDKs without a Linux arm64 build, and
   Android's x64-only build tools.
5. Run the whole workflow once by hand (`workflow_dispatch`) on outrun before the first real push.

## 2. Measure

Take every figure from GitHub's API, never from memory or the UI's rounded times.

- **Per job:** `created_at → started_at` is the pickup (queue). `started_at → completed_at` is the job.
- **Per step:** "Set up job", checkout, setup (toolchain, dependencies, cache restore), the work,
  and the post steps (cache saves).
- **Per run:** the wall clock, and its critical path (the chain of `needs:` that ends last).

```sh
gh api "repos/$REPO/actions/runs/$RUN/jobs?per_page=100" --jq '.jobs[] | [.name,
  (((.started_at|fromdate)-(.created_at|fromdate))|tostring)+"s queued",
  (((.completed_at|fromdate)-(.started_at|fromdate))|tostring)+"s run"] | @tsv'
gh api "repos/$REPO/actions/jobs/$JOB" --jq '.steps[] | [.name,
  ((.completed_at|fromdate)-(.started_at|fromdate))] | @tsv'
```

Measure four cases, each at least three times, and report min, median and max with run ids:

| Case | What it shows |
| -- | -- |
| **Cold**: a new commit on a machine with empty caches | the worst case, and what the caches are worth |
| **Warm**: the same workflow again with nothing changed | the floor of setup and pickup |
| **Narrow**: a one-file change | what an agent waits for on most pushes |
| **Wide**: a change to a file most of the code depends on | the worst push |

Measure the same commit on the old runners and on outrun. Then work out the run's **speed of light**:
one pickup, plus the longest unit of work that must run, plus the setup that cannot be cached. The
gap between a job and its speed of light is where the next lever is. Other runs of the same
organisation contend for the same runners, so note what else was running. Rerun a figure that looks
off on a quiet moment before believing it.

## 3. Levers, ranked by measured gain

Work in this order, measuring after each lever. The figures come from the Flutter + TypeScript
monorepo unless stated otherwise.

1. **Saves that dominate a job.** Look at every post step first.
   - A lint job spent **248 s of its 324 s saving the analyzer's cache** to the Actions cache. The
     analysis itself took 4 s.
   - Without that save, the job took **50 s**.
   - Rule: save a cache only from the default branch, only when its key changed, and never one that
     takes longer to save than the work it saves.
2. **Split the test job, shard it by measured times.**
   - One `flutter test` job took **393 s**. Split into up to 8 jobs, it took **26–53 s per job**.
   - Balance shards by each file's last measured duration, not by file count. `outrun plan` and
     `outrun test --shard` do it (README).
   - With the move to arm64 and warm caches, the whole push CI went from **591 s to 138–160 s**.
3. **Pickup and warm runners.**
   - After the move, the queue was the largest share of a run: 10–60 s per job, and 146–167 s on
     the old provider.
   - With runners already waiting for the repository (outrun's `warmRunners` setting, README):
     - Linux arm64 pickup went from p50 15 s / p90 34 s to **0–2 s**;
     - macOS pickup went from p50 30 s to **2 s**;
     - on a 16-shard iOS suite, queue went from 30–67 s to 2–3 s, and simulator boot from 14–39 s
       to 0 s.
   - Size the count to the largest burst the repository sends at once. Jobs beyond it wait for a
     free machine (one burst of 17 jobs with 8 warm runners: 9 started in 2–3 s, 8 in 8–25 s).
4. **Affected-only tests on push, the full suite on the default branch.**
   - Select the tests a change can reach from its import graph. Add the tests that read sources as
     text: in the monorepo, 43 of the 129 tests one leaf file selected were of that kind.
   - Keep the full suite on the default branch and at night, so a wrong selection is caught within
     the day.
5. **The pre-push gate on outrun: `outrun check`.** The repository's fast check runs on warm
   checkouts of the default branch, split over several VMs by the units' measured times (README,
   "outrun check").

   | Change | Before | After |
   | -- | -- | -- |
   | One Dart file | 108–113 s on a laptop; 31.7–34.7 s on an older `outrun check` | **16.3–18.9 s** |
   | Docs only | 4.9 s | **4.1–4.3 s** |
   | Wide (447 units) | 128 s | **52 s** |

   The floor is then the slowest single unit: two of 13–17 s each in this case. `outrun check` names
   every unit alone over `--target`: split it or cache its output.

   Since 1.9 the gate can be an ordinary workflow instead (a `presubmit.yml` with only
   `workflow_dispatch`), run by the hook with `outrun run presubmit.yml` on the tree being pushed
   (README, "outrun run"): nothing outrun-specific to write, and the same file runs on GitHub. Write
   its jobs with `run:` steps and `actions/checkout` only (other actions are refused, exit 2), and
   split it with a planning job whose output feeds a `fromJSON` matrix.
6. **Large caches on the machine, not over the network.**
   - A signed iOS build restored 8 GB of Swift packages over the network. Its first runs on fresh
     machines took **505–1670 s** (the restore alone up to 1043 s).
   - With the cache kept on outrun's machines (`$OUTRUN_CACHE`, `$OUTRUN_CACHE_PROTECTED`, `outrun
     tier restore|save`, README), it took **208–213 s**, restore 11 s.
   - Keep the Actions cache for small caches (a 555 MB restore takes about 4 s on arm64).
7. **The tools already in the image.**
   - Use the versions the runner's tool cache already holds, and let `setup-*` actions find them
     instead of downloading.
   - Measured per macOS shard: setup-node 3 s → 0 s, setup-bun 23 s → 7 s, the outrun action 11 s →
     1 s, and the setup steps ~40 s → **~10 s**.
8. **End-to-end tests: shard, build once, replay.** Use `outrun e2e` (README, "End-to-end tests"):
   - one unit per test, sharded by learned durations;
   - the app built once per run, in the plan job (no pickup of its own), and incremental from its
     build folders;
   - the simulator booted while the job installs;
   - recorded agent steps replayed instead of calling the model.

   Then cut the time inside the tests:
   - keep the replay cache between runs: misses went from 29 to 11–12 a run;
   - sign in through a test-only hook (a debug deep link in non-release builds), not through the UI;
   - never wait on a real clock: backdate the session instead of waiting it out;
   - split every test far longer than the rest (a 214 s test became 63–86 s and 98–180 s);
   - shorten a timer a test waits on (10 min to 1 min took two tests from 730/714 s to 280/257 s).

   Measured: a 34-test iOS suite went from ~39 min on a hosted macOS provider to **10.1 min**. A
   later 16-shard run of the same suite took **413 s**: 2,081 s of tests in total, and model calls
   down from 232 to 107.
9. **The critical path last.**
   - Move the remaining jobs (plan, gate) only after measuring: moving them gave 114–167 s → 126–268 s
     on a busy hour, a loss until rerun on a quiet one.
   - Fold small jobs into the job that needs them, since each job costs a pickup.
   - Keep e2e and native builds off the push gate: run them dispatched, on the default branch for the
     affected flows, or at night. Their best case is already over 3 minutes (build ≥ 60 s, pickup,
     boot and install ~40 s, then the tests).

## 4. Traps already hit

| Trap | Symptom | Cause | Fix |
| -- | -- | -- | -- |
| Cache per machine | Every run that lands on another machine is cold. The same job takes 505 s, then 1670 s, then 613 s. | The cache lived on one machine, and the next job landed elsewhere. | Use the shared tiers, written by the default branch. Never judge a cache on one run: take three, on different machines. |
| Cache save dominating | The post step takes longer than the work (248 s of 324). | The Actions cache saved a large folder on every run. | Save only on the default branch when the key changed, or keep the cache on the machine (lever 6). |
| A cache moved to a new store, writers first | A job misses, or fails on a missing file, restoring what an earlier job just saved, on some runners only. A job that untars a build without checking the restore hit fails further on. | The new store (a new key, path, tier or cache service) reached the writers before every reader: a save to the new store is invisible to a job still reading the old one, and runners or branches move one by one. | Readers first: every reader looks in the new store and falls back to the old one. Turn writes to the new store on only once every reader reads it. Check that a restore hit before using what it restores. |
| Jobs lost to the infrastructure | Shards get a runner, run no step and fail at the job's timeout. Rerunning one shard then makes GitHub refuse the others (403). | The runners were restarted under running jobs. | Rerun all failed jobs together (`gh run rerun $RUN --failed`), never one by one. Report the run id to outrun. |
| Network errors in a burst | ENOTFOUND, ECONNRESET, a TLS handshake taking seconds, 504s downloading a tool from GitHub. | Many new connections at once, or the upstream server failing. | Retry every download with backoff (3 tries). Prefer the image's tools. Pin tools by version and checksum. |
| arm64 gaps | `flutter` has no Linux arm64 archive. Android's build tools fail on arm64. `gh`, `zip`, `sqlite3`, `pip` or `aws` are missing. | Upstream ships x64 only, or the image lacks the tool. | Install Flutter from its git tag and run `precache`. Keep Android jobs on an x64 label. Install a missing tool only when `command -v` fails. |
| Out of memory | A test job is SIGKILLed (exit 137) only on some runs. | The job's peak memory (one suite: 4.9 GB, one file 2.1 GB) exceeded a smaller VM. | Measure the peak RSS. Ask for a larger runner, or split the job. |
| A file outside the checkout | A test passes on a laptop and fails in CI after a sparse or per-folder checkout. | The test reads another package's file. | Add the path to the job's checkout and its selection inputs. |
| Commit messages lost in `outrun check` | A plan that reads `git log "$OUTRUN_CHECK_BASE..HEAD"` (trailers, `[skip …]` flags) sees one commit named "outrun check". | Before outrun 1.5.3, the VM committed the patch with its own message. | Use `arkadia-so/outrun@v1`, or pin 1.5.3 or later. |
| Too few workers for a wide check | A wide change plans 547 units. `outrun check --workers 4` prints `1 worker(s)`. The one shard (~500 s expected) is cut at ~240 s with `no answer in time`, three times. The push cannot land. | Fewer workers were free than asked for, and the share outran a time limit. | Any outcome other than a verdict, and any worker count below the request on a wide change, means "not run": run the check locally (exit 3 means the same). Name the units over `--target` and split them, so a wide change still fits on few workers. |
| Slow pickup with idle capacity | "Set up runner" takes 46–126 s, or a job queues for minutes while others start at once. | On outrun's side, the scheduler was slow to hand out jobs. | Report the run id with each job's `created_at` and `started_at`. Do not work around it in the workflow. |
| A slow video stop blamed on the codec | An iOS e2e test's video takes tens of seconds to stop on a macOS VM, and the recording's HEVC encoding is suspected. | Not the codec: a macOS VM on Apple silicon exposes paravirtualized hardware H.264 and HEVC encoders (VideoToolbox lists them), and `simctl io recordVideo` stops in 0.1–0.8 s with HEVC (0.4–1.2 s with H.264) after up to 240 s of recording, all CPUs busy. H.264 files are twice the size. | Keep HEVC (the default). Time the harness's own stop path (its recorder's request, the file checks after it) instead. |
| Screenshots sent as text to the e2e model | Model calls of hundreds of thousands of tokens, 429s, context overflows, wrong answers about the screen. | An OpenAI-compatible provider writes an image in a tool result as JSON text, unless told otherwise. | Create the provider with `supportsMultiPartToolContent: true`, and honour `Retry-After` on 429 and 503. |

## 5. Who decides, and how to roll back

**An agent may do these alone**, each measured, in its own commit, with its rollback:

| Change | Rollback |
| -- | -- |
| A job's runner, through a repository variable | `gh variable set CI_RUNNER --body <previous>`, or `gh variable delete CI_RUNNER` |
| macOS jobs' runner | `gh variable set MACOS_RUNNER --body '["macos-26"]'` |
| Splitting or sharding a job; time-balanced shards | revert the commit |
| Removing or restricting a cache save; moving a cache to the machine's tiers | revert the commit |
| Retries and install-if-missing for tools | revert the commit |
| Pinning or upgrading `arkadia-so/outrun` | pin the previous tag |
| Measurements and the report | none needed |

**The owner decides these.** Ask in one line with the measured gain:

- **What runs where and when:**
  - affected-only selection on push;
  - moving e2e or native builds off the gate;
  - a test dropped, quarantined or rewritten;
  - test-only hooks added to the app (debug deep links, clock shortcuts).
- **Settings on outrun's side:**
  - warm runners, and how many (they are machines waiting for the repository);
  - larger runners;
  - the repository's listing for `outrun check`.
  Ask outrun to set them, and to unset them for the rollback.
- **Secrets, tokens, GitHub environments, OIDC trust**, and anything that publishes or deploys.
- Moving a job **off GitHub** when a GitHub-only feature needs it (section 1).

## 6. Done when

- **Pre-push gate:**
  - a one-file change gets its verdict in **under 30 s**, with no fallback;
  - a docs-only change in under 5 s;
  - a wide change either fits its budget or says "not run", never a time-out.
- **Push CI:**
  - wall clock under **3 min** for a narrow change;
  - pickup p50 under 5 s;
  - no step other than the work over 20 % of its job.
- **End-to-end tests:** off the gate. Wall clock about the longest test plus ~60 s of fixed cost
  per shard.
- **Measurements:** every figure taken at least three times, with run ids.

Report to the owner in this shape:

```markdown
## CI on outrun: <repo>, <date>
| Case | Before (runner, runs) | After (runs) | Gain |
| Cold / Warm / One-file / Wide / Pre-push one-file / E2E full | min–max s, ids | min–max s, ids | × |
Levers applied: <lever>: <before> → <after> (<commit>), rollback: <command or revert>.
Traps hit: <symptom>: <fix>.
Left, by expected gain: <lever>: <expected gain>, <who decides>.
Needs your decision: <one line each, with the measured gain>.
```
