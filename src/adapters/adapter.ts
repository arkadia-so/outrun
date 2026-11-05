// How a test runner runs a batch of units and reports each one. The engine knows nothing of a
// runner: an adapter turns a batch into a command and its report into per-unit results.
import type { Effect } from "effect";
import type { Suite } from "../config.ts";
import type { FileFailed, SpawnFailed } from "../errors.ts";

export interface UnitResult {
  readonly passed: boolean;
  readonly durationMs: number;
  readonly tests: number;
}

interface Prepared {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Reads the batch's report: a result for each unit it saw (a unit absent did not finish). */
  readonly results: (exit: { code: number | null; output: string }) => Effect.Effect<Map<string, UnitResult>, FileFailed>;
}

export interface Adapter {
  readonly name: Suite["adapter"];
  /** What the toolchain is (versions, platform, architecture): part of every key. */
  readonly toolchain: (env: Readonly<Record<string, string | undefined>>) => Effect.Effect<string, SpawnFailed>;
  /**
   * Work done once per runner before any batch (xcode: build for testing), or nothing. Returns
   * whatever the batches need from it.
   */
  readonly prepare?: (suite: Suite, repo: string, scratch: string) => Effect.Effect<void, SpawnFailed | FileFailed>;
  /** The command of one batch of `files` (relative to the suite's folder), reporting into `scratch`. */
  readonly batch: (suite: Suite, repo: string, files: readonly string[], scratch: string) => Prepared;
}
