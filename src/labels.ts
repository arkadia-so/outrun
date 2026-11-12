// outrun's `runs-on` labels, the one table (outrun/README.md "Jobs: labels, kinds and tiers"; the
// control plane's kinds.ts, `outrun run` and `outrun check` all resolve a job's labels here).
//
// Named as GitHub's, Depot's and Blacksmith's are (Gabin, 2026-11-12): the image's OS and version,
// `-arm` for arm64 (GitHub's `ubuntu-24.04-arm`), `-<vcpu>` for a size other than the default
// (Depot's `-8`), the tier after it all (`-priority`, `-flex`). A new Ubuntu or macOS version is a
// new label, never a silent image change behind an existing one. The versions are the images'
// (checked 2026-11-12): Ubuntu 24.04 on x86_64 (infra/base-image, GitHub's ubuntu-24.04) and on
// arm64 (mac/ci.json `linux.image`, noble), macOS 26 (mac/ci.json `baseImage`, macos-tahoe-xcode).
//
// GitHub gives a job to any runner holding all its labels, so a job asks for one outrun label
// alone (beside what GitHub adds by itself for its kind: `self-hosted`, the OS, the architecture),
// and the runner registered for it carries exactly that label: a job naming two of ours, or one of
// ours beside another, is not ours.

/** A runner's OS. */
type LabelOs = "linux" | "macos";
/** A runner's architecture. */
type LabelArch = "x86_64" | "arm64";
/** A service tier, picked by the label's suffix (none: standard). */
type LabelTier = "priority" | "standard" | "flex";

/** One runner, at the standard tier: its label and what it runs. */
export interface LabelRunner {
  readonly name: string;
  readonly os: LabelOs;
  readonly arch: LabelArch;
}

export const RUNNERS = [
  // A slot of a Linux x86_64 machine, 4 vCPU (Depot's convention: the default size has no suffix).
  { name: "outrun-ubuntu-24.04", os: "linux", arch: "x86_64" },
  // A whole Linux x86_64 machine, 8 vCPU.
  { name: "outrun-ubuntu-24.04-8", os: "linux", arch: "x86_64" },
  // A Linux arm64 VM of its own on a Mini.
  { name: "outrun-ubuntu-24.04-arm", os: "linux", arch: "arm64" },
  // A macOS arm64 VM of its own on a Mini.
  { name: "outrun-macos-26", os: "macos", arch: "arm64" },
] as const satisfies readonly LabelRunner[];

/** A runner's name: its label at the standard tier. */
export type RunnerName = (typeof RUNNERS)[number]["name"];

/**
 * Deprecated aliases, removed after a migration (Gabin, 2026-11-12): the labels outrun had before,
 * each the same runner as its new name, with the same tiers (`outrun-macos-flex`). A job asking for
 * an alias runs exactly as one asking for the new name, on a runner registered with the alias.
 */
export const ALIASES: Readonly<Record<string, RunnerName>> = {
  outrun: "outrun-ubuntu-24.04",
  "outrun-8cpu": "outrun-ubuntu-24.04-8",
  "outrun-linux-arm64": "outrun-ubuntu-24.04-arm",
  "outrun-macos": "outrun-macos-26",
};

const TIERS: readonly LabelTier[] = ["standard", "priority", "flex"];

/** A label a job may ask for, resolved. */
export interface OutrunLabel {
  /** The label itself, as the job asked for it and as its runner is registered. */
  readonly label: string;
  /** The runner it asks for (its name: the new label at the standard tier). */
  readonly runner: RunnerName;
  /** The deprecated alias it was written with (without the tier), or null. */
  readonly alias: string | null;
  readonly tier: LabelTier;
  readonly os: LabelOs;
  readonly arch: LabelArch;
}

// A runner's label at a tier: its own for standard, with the tier after it otherwise.
const tierLabel = (base: string, tier: LabelTier) => (tier === "standard" ? base : `${base}-${tier}`);

/** Every label outrun answers to: each runner's name and aliases, at each tier. */
export const LABELS: readonly OutrunLabel[] = RUNNERS.flatMap((runner) =>
  [runner.name, ...Object.keys(ALIASES).filter((alias) => ALIASES[alias] === runner.name)].flatMap((base) =>
    TIERS.map((tier) => ({
      label: tierLabel(base, tier),
      runner: runner.name,
      alias: base === runner.name ? null : base,
      tier,
      os: runner.os,
      arch: runner.arch,
    })),
  ),
);

// The labels GitHub may add to `runs-on` by itself for a runner of this OS and architecture; any
// other asks for another runner. Never `linux` or `x64` with macOS.
const implied = (label: OutrunLabel): readonly string[] =>
  label.os === "macos" ? ["self-hosted"] : ["self-hosted", "linux", label.arch === "arm64" ? "arm64" : "x64"];

/** The outrun label a job's `runs-on` asks for, resolved; undefined when the job is not ours. */
export const outrunLabel = (labels: readonly string[]): OutrunLabel | undefined => {
  const lower = labels.map((label) => label.toLowerCase());
  const own = LABELS.filter((entry) => lower.includes(entry.label));
  if (own.length !== 1) return undefined;
  const entry = own[0]!;
  return lower.every((label) => label === entry.label || implied(entry).includes(label)) ? entry : undefined;
};

/** A label outrun answers to, by its exact name (a stored job's), or undefined. */
export const labelNamed = (label: string): OutrunLabel | undefined => LABELS.find((entry) => entry.label === label);
