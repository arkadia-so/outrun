# outrun

outrun ([outrun.sh](https://outrun.sh)) runs your GitHub Actions jobs on its own runners: Linux x64,
Linux arm64 and macOS. Your workflows stay as they are. A job moves by changing its `runs-on` line,
and comes back to GitHub's runners by changing it back.

This repository is outrun's CLI, `outrun`, and the action that puts it on a job's PATH. `outrun
report` says where a GitHub Actions run's time goes, on outrun's runners or GitHub's.

## Runners

One label per runner. A job asks for it in `runs-on`, alone:

| `runs-on` | Machine | Price per minute |
| -- | -- | -- |
| `outrun-ubuntu-24.04` | Linux x64, Ubuntu 24.04, 4 vCPU, 8 GB | $0.004 |
| `outrun-ubuntu-24.04-8` | Linux x64, Ubuntu 24.04, 8 vCPU, 16 GB | $0.008 |
| `outrun-ubuntu-24.04-arm` | Linux arm64, Ubuntu 24.04, 4 vCPU, 8 GB | $0.004 |
| `outrun-macos-26` | macOS 26 with Xcode, Apple silicon, 5 vCPU, 10 GB | $0.04 |

- The labels are named as GitHub's: the image's OS and version, `-arm` for arm64, `-8` for 8 vCPU.
  A new Ubuntu or macOS version is a new label, never another image behind a label you already use.
- Linux costs $0.001 per vCPU-minute, x64 and arm64 alike; macOS $0.04 per minute. Every job is
  billed per second. The current prices are on [outrun.sh](https://outrun.sh).
- A job asks for one outrun label and nothing beside it: GitHub gives a job to a runner holding all
  its labels, and each outrun runner holds exactly one.
- `outrun`, `outrun-8cpu`, `outrun-linux-arm64` and `outrun-macos` are older names of the same four
  runners. They still work, as deprecated aliases: move off them.

## Tiers

A suffix after the label picks a tier, per job:

| Suffix | Tier | Price | What it does |
| -- | -- | -- | -- |
| `-priority` | priority | twice the standard price | goes ahead of waiting standard jobs, and pays priority only when it did, else standard |
| none | standard | the table above | |
| `-flex` | flex | half the standard price | runs when the fleet has room; on macOS and Linux arm64 only |

So `outrun-macos-26-priority` is $0.08 a minute, `outrun-macos-26` $0.04 and `outrun-macos-26-flex`
$0.02; `outrun-ubuntu-24.04-arm-flex` is $0.002. A running job is never stopped for another.

## Moving a job

1. Sign in on [outrun.sh](https://outrun.sh), create your space and save a card. In your space,
   open the GitHub tab and install outrun's GitHub App on the organization or account whose
   workflows run on outrun.
2. Change the job's `runs-on`:

   ```yaml
   jobs:
     test:
       runs-on: outrun-ubuntu-24.04-arm
   ```

   The rest of the workflow stays as it is.

To go back with one command instead of a commit, name the runner in a repository variable:

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
# macOS, a JSON list:
runs-on: ${{ fromJSON(vars.MACOS_RUNNER || '["macos-26"]') }}
```

`gh variable set CI_RUNNER --body outrun-ubuntu-24.04-arm` moves the jobs; `gh variable delete
CI_RUNNER` brings them back to GitHub's runners.

Leave a job on GitHub's runners when a GitHub feature needs them: publishing with trusted
publishing (npm's OIDC), and store uploads whose credentials are bound to GitHub's runners. Before
moving a job to arm64, check that its tools have a Linux arm64 build.

## Your bill

Every job is paid from your space's balance, per second, at the price of its label and tier. The
balance is prepaid credit in dollars: you add credits in your space's Billing, and can turn on an
automatic recharge below a threshold you choose. At zero, outrun takes no new job; jobs already
running finish, and a job queued meanwhile waits for a runner and starts once you top up.

## The CLI in a job

The action puts `outrun` on the job's PATH, at the version its tag pins:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  actions: read
  contents: read
jobs:
  report:
    runs-on: outrun-ubuntu-24.04-arm
    steps:
      - uses: arkadia-so/outrun@v1
      - run: outrun report "$RUN" --repo "$GITHUB_REPOSITORY"
        env:
          GH_TOKEN: ${{ github.token }}
          RUN: ${{ github.event.workflow_run.id }}
```

It runs this repository's sources at that tag on Bun 1.4.4, downloaded once per machine into the
runner's tool cache and checked against its SHA-256, with the dependencies of `bun.lock`. The job's
own `bun`, if it has one, is not changed. Runs on macOS (Apple silicon) and Linux (arm64, x64).

## outrun report: where a run's time goes

`outrun report <run>` reads one GitHub Actions run (any run: on outrun's runners or GitHub's) and
says where its time went: the job everyone waits on, what each job spent waiting, setting up,
working and saving, how far the run is from its floor, which job to work on first, which step
added time against the job's own history and whether the job kept its budget, and, on
outrun's runners, what each cache restored and saved and whether it pays. Nothing to
configure: it reads GitHub with your token and the workflow file that ran.

```sh
GH_TOKEN=<a token that reads the repository's Actions> outrun report https://github.com/acme/app/actions/runs/123
outrun report 123 --repo acme/app [--attempt 2] [--json]
```

- Where: in a job, after `uses: arkadia-so/outrun@v1` (the job's `GITHUB_TOKEN` needs `actions:
  read` and `contents: read`); elsewhere, from a clone of this repository at a release tag,
  `bun install --frozen-lockfile`, then `bun src/main.ts report <run>`.
- `<run>`: the run's URL (an `/attempts/<n>` in it is the attempt), or its id with `--repo
  owner/name`. `--attempt`: that attempt (default: the run's latest). `--json`: the same figures for
  a script. The token: `GH_TOKEN`, else `GITHUB_TOKEN` (without one, public repositories only).
- The workflow file is read at the run's head commit: from the current checkout when it is a clone
  of that repository and has the commit (`git show`), else GitHub's contents API; reusable workflows
  of the same repository (`uses: ./.github/workflows/...`) too.
- Every figure is GitHub's own timestamps, to the second, for one attempt; a job carried from an
  earlier attempt (a re-run of failed jobs) is listed, not counted.

What it prints, and how each figure is computed:

- **Wall clock**: the attempt's first job queued (`created_at`) to the last step done of a job
  that ran.
- **Per job**: **pickup** (queued to started: the wait for a runner), then its steps, each in one
  phase: **setup** (Set up job, the runner's own Set up runner, `Pre` steps, `actions/checkout`,
  an action whose name contains `setup`, `actions/cache` and `actions/cache/restore`), **work**
  (`run:` steps and every other action), **post** (`Post` steps, `actions/cache/save`, Complete
  runner, Complete job), and the time **outside steps** (the job's span minus its steps). GitHub's
  steps are matched to the workflow's in order, by name; when they do not match (a step count or a
  name differs), that job's steps are **unclassified**, never guessed.
- **Critical path**: the job that ended last, then back through its `needs:` to the need that
  completed last, and so on. A matrix cell is its job's name with the matrix values in parentheses;
  a reusable workflow's job is `caller / callee`. A job whose name matches no job of the file, or
  several, is not mapped; a chain ending on it is not claimed.
- **Slack** of a job off the path: how much later it could have ended before delaying a job that
  needs it (that job's own time from its needs' end to its end kept) or the run's end.
- **Speed of light (estimated)**: the run's shortest pickup + the longest work of one job (its
  work steps: the longest unit that must run) + that job's setup no cache removes (Set up job, Set
  up runner and checkout), and the **gap** between the wall clock and it. Not given when a job's
  steps are unclassified.
- **To shorten this run**: the job taking the most of the critical path (its wait after its need,
  pickup and span) and its largest item, a step or its pickup. A lever on a job off the path
  shortens nothing anyone waits for.
- Without the workflow file (a dynamic workflow, a file neither the checkout nor the token can
  read), it prints per-job times only and says why: `needs:` are never guessed from timing.
- **History**: the same workflow's 10 most recent successful runs on the default branch created
  before the run (so a report on an old run compares it with what came before it), each read once
  with its jobs; a job's history is the same job, by name (matrix values included), where it
  succeeded. The report says how many runs it read and in how many requests, and ends with every
  request it made to GitHub.
- **Time added**, per job: its span against its history's **n**, **median** (the middle value, the
  mean of the two middle ones for an even n) and **p90** (nearest rank: the ⌈0.9·n⌉-th smallest), and
  the step that added the most: a step that **appeared** (run in fewer than half of the history's
  runs; a skipped step counts as absent), with its whole time, or one that **grew**, more than 1 s
  over its history's p90 (GitHub's step times are whole seconds), by its time minus its history's
  median. Growth within that is not reported. Every other step that appeared is listed after it. A
  step name used twice in a job is matched by occurrence. Under 3 runs of history, no step is weighed and it says so. So on the run that adds a
  check, the check's cost is printed.
- **Budget**, per job: its `timeout-minutes` (a reusable workflow's job: the callee's), else, when
  unset or an expression, the p90 of its history (3 runs at least); `!` and by how much when the
  job's span went over it. Nothing to configure: a budget is never an outrun setting.
- **Cache**, per job, from the cache ledger outrun's runners print in each job's log (its "Complete
  runner" step, ending with one line `job-report v2 <json>` that holds the ledger and the job's load;
  read through GitHub's run logs archive, else its job logs API): each restore (the key asked, the key found, an **exact** hit, a **partial** hit on a restore
  key, or a **miss**, the bytes, where they came from, the transfer time, their sha256) and each save
  (key, bytes, from its creation to its finalization, **saved**, **exists** when the cache already
  held the key, **given-up** past the save's deadline, or **failed**, and the sha256 of the bytes
  saved when it was computed exactly), each in the step whose time holds it (GitHub's step times are
  to the second: a step holds an event from its start's second to the second after its end; an
  event in a boundary second of two steps is in neither). What the ledger could not measure is
  printed "not measured", never guessed. A job with no ledger says why: not run on outrun's runners,
  a run from before the ledger existed, or its cache calls went to GitHub's cache.
- **Flags**: a save whose step takes longer than the job's own work (its work steps); a save of
  **unchanged content**, whose sha256 equals that of bytes the job restored before it (never on size
  alone); and, over the same job's 10 most recent successful runs of the same workflow on the
  default branch, a cache whose **cost** (the median restore step on an exact hit plus the median
  save step on a miss) is not less than what it **avoids** (the median rest of the job on a miss
  minus on an exact hit), one verdict per restore step, one sample per run: a step whose restores all
  hit exactly is a hit, all missed a miss, else partial (a setup action restoring two caches, one
  missed), counted in neither. Under 3 runs of a hit or 3 of a miss with a ledger: "not enough runs",
  with how many of each, never a verdict.
- **Contention**, per job, from the same line: for each step, its CPU (mean and peak, of the
  machine's vCPUs), its peak memory against the job's (its cgroup's `memory.max`, else the machine's
  memory), and on Linux the share of its time some task waited for a CPU and for memory (the "some"
  totals of the kernel's pressure stall information over the step, between two samples 2 s apart or
  more within it, else "not measured") and the
  processes the kernel's OOM killer killed; on macOS the system's memory pressure level instead, CPU
  pressure and OOM kills "not measured"; and whether it ended with exit code 137. **Flags**, with
  their thresholds printed beside them: **workers beyond the cores** (tasks waited for a CPU over 25%
  of a step's time while it used 80% or more of the vCPUs), **memory pressure** (tasks waited for
  memory over 10% of its time, its peak reached 90% of the job's memory, or macOS's pressure level
  reached warning), **a process killed** (an OOM kill, named when the kernel's log says which, or exit
  code 137). These are what make more parallelism slower: more workers than cores wait for one
  another, and more than the memory holds reclaim, swap or get killed; a bigger runner is the costly
  answer, fewer workers the free one. A job with no figures says why (not run on outrun's runners, or
  before they recorded them), and a job whose steps held no sample (sampled every second) says that,
  never "none flagged".

Exit 0: printed; 1: GitHub did not answer (the run, its jobs); 2: the arguments.

## For an agent

[skills/outrun/SKILL.md](skills/outrun/SKILL.md) is the playbook for an agent that moves a
repository's CI to outrun's runners and then makes it faster: the move and its rollback, how to
measure with `outrun report`, the levers ranked by measured gain, the traps already hit.

## License

MIT or Apache-2.0.
