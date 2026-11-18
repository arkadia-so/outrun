// The content of the checkout, from git's index: each tracked file's blob hash, which git keeps
// for every file already, so an unchanged file is never read or hashed again. Files changed in
// the working tree but not staged are hashed the way git would (the same blob hash).
import { Effect } from "effect";
import { GitFailed } from "./errors.ts";

/** Path (from the root, `/`-separated) → git blob hash of its current content. */
export type Blobs = ReadonlyMap<string, string>;

const run = (args: readonly string[], cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
      return new Uint8Array(out);
    },
    catch: (error) => new GitFailed({ message: `git ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}` }),
  });

const decoder = new TextDecoder();

/** Pure: `git ls-files -s -z`'s records (`<mode> <blob> <stage>\t<path>`) as a map. */
export const parseIndex = (bytes: Uint8Array): Map<string, string> => {
  const blobs = new Map<string, string>();
  for (const record of decoder.decode(bytes).split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [, blob] = record.slice(0, tab).split(" ");
    if (blob) blobs.set(record.slice(tab + 1), blob);
  }
  return blobs;
};

/** The blob hash git gives these bytes: sha1("blob <size>\0" + bytes). */
export const blobHash = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`blob ${bytes.byteLength}\0`);
  hasher.update(bytes);
  return hasher.digest("hex");
};

export const root = (cwd: string) => run(["rev-parse", "--show-toplevel"], cwd).pipe(Effect.map((out) => decoder.decode(out).trim()));

/**
 * Every file's blob as the working tree has it: the index, the files changed since (a deleted
 * file is gone), and the new files git does not ignore (a test may import one not added yet).
 */
export const blobs = (repo: string) =>
  Effect.gen(function* () {
    const [index, changed, added] = yield* Effect.all(
      [run(["ls-files", "-s", "-z"], repo), run(["diff", "--name-only", "-z"], repo), run(["ls-files", "--others", "--exclude-standard", "-z"], repo)],
      { concurrency: 3 },
    );
    const map = parseIndex(index);
    const dirty = [...decoder.decode(changed).split("\0"), ...decoder.decode(added).split("\0")].filter(Boolean);
    yield* Effect.forEach(
      dirty,
      (path) =>
        Effect.tryPromise({
          try: async () => {
            const file = Bun.file(`${repo}/${path}`);
            if (!(await file.exists())) map.delete(path);
            else map.set(path, blobHash(new Uint8Array(await file.arrayBuffer())));
          },
          catch: () => new GitFailed({ message: `${path}: changed in the working tree but not readable` }),
        }),
      { concurrency: 16, discard: true },
    );
    return map as Blobs;
  });

/** The working tree's changes as git reports them (`git status --porcelain -z`, untracked files listed one by one). */
export const status = (repo: string) =>
  run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repo).pipe(Effect.map((out) => new Set(decoder.decode(out).split("\0").filter(Boolean))));

/**
 * A file's text at a commit of the checkout at [cwd], when that checkout is a clone of [repository]
 * (`owner/name`) and has the commit; undefined otherwise (another repository, the commit not fetched).
 */
export const show = (cwd: string, repository: string, sha: string, path: string) =>
  Effect.gen(function* () {
    const origin = decoder.decode(yield* run(["remote", "get-url", "origin"], cwd));
    if (repositoryOf(origin)?.toLowerCase() !== repository.toLowerCase()) return undefined;
    const has = yield* run(["cat-file", "-e", `${sha}^{commit}`], cwd).pipe(
      Effect.as(true),
      Effect.catchTag("GitFailed", () => Effect.succeed(false)),
    );
    if (!has) return undefined;
    return decoder.decode(yield* run(["show", `${sha}:${path}`], cwd));
  });

/** The commit checked out. */
export const head = (repo: string) => run(["rev-parse", "HEAD"], repo).pipe(Effect.map((out) => decoder.decode(out).trim()));

// The GitHub repository (`owner/name`) an origin URL names: GitHub's own (https or ssh), or outrun's
// git proxy, which an agent sandbox clones through (`…/v1/git/<sandbox>/<owner>/<repo>.git`: the
// sandbox has no GitHub credential, outrun/README.md "Agent sandboxes"). Undefined for anything else.
export const repositoryOf = (origin: string): string | undefined =>
  /(?:github\.com[:/]|\/v1\/git\/sbx_[0-9a-f]+\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(origin)?.[1];
// An origin URL as a message may show it: without the credential a clone through a proxy carries.
export const shownOrigin = (origin: string): string => origin.trim().replace(/\/\/[^/@]+@/, "//");
