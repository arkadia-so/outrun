// The local repository (repoLive) on a real git repository in a temporary directory.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repo, repoLive, treeOf } from "./check.ts";

const git = (dir: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

describe("repoLive", () => {
  // The repository through GIT_DIR and GIT_WORK_TREE, which repoLive's git inherits (no chdir: a
  // test worker may not change its directory).
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "outrun-repo-"));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    process.env.GIT_DIR = join(dir, ".git");
    process.env.GIT_WORK_TREE = dir;
  });
  afterEach(() => {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives `outrun run`'s tree (HEAD with uncommitted changes) the change's commit messages and trailers", async () => {
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "a.txt"), "b\n");
    git(dir, "commit", "-qam", "Fix it", "-m", "No-Changelog: internal");
    writeFileSync(join(dir, "a.txt"), "c\n");
    const tree = await Effect.runPromise(treeOf(undefined));
    expect(git(dir, "cat-file", "-t", tree)).toBe("tree");
    const message = await Effect.runPromise(Effect.flatMap(Repo, (repo) => repo.messageFrom(base)).pipe(Effect.provide(repoLive(tree))));
    expect(message).toBe("Fix it\n\nNo-Changelog: internal");
  });

  it("reads the messages up to a commit given as the tip (`--ref`)", async () => {
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "a.txt"), "b\n");
    git(dir, "commit", "-qam", "First");
    const first = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "a.txt"), "c\n");
    git(dir, "commit", "-qam", "Second");
    const message = await Effect.runPromise(Effect.flatMap(Repo, (repo) => repo.messageFrom(base)).pipe(Effect.provide(repoLive(first))));
    expect(message).toBe("First");
  });
});
