import { describe, expect, it } from "vitest";
import { blobHash, parseIndex, repositoryOf, shownOrigin } from "./git.ts";

describe("git", () => {
  it("hashes bytes exactly as git does", () => {
    const bytes = new TextEncoder().encode("hello\n");
    const git = Bun.spawnSync(["git", "hash-object", "--stdin"], { stdin: bytes }).stdout.toString().trim();
    expect(blobHash(bytes)).toBe(git);
  });

  it("reads `ls-files -s -z` into path → blob, paths with spaces included", () => {
    const out = new TextEncoder().encode(
      "100644 ce013625030ba8dba906f756967f9e9ca394464a 0\ta b.ts\x00100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tc.ts\x00",
    );
    expect(parseIndex(out)).toEqual(
      new Map([
        ["a b.ts", "ce013625030ba8dba906f756967f9e9ca394464a"],
        ["c.ts", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
      ]),
    );
  });
});

describe("the repository an origin names", () => {
  it("reads GitHub's URLs and outrun's git proxy, which an agent sandbox clones through, and nothing else", () => {
    expect(repositoryOf("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repositoryOf("git@github.com:acme/app\n")).toBe("acme/app");
    expect(repositoryOf(`https://42:secret@api.outrun.sh/v1/git/sbx_${"0".repeat(20)}/acme/app.git`)).toBe("acme/app");
    expect(repositoryOf("https://gitlab.com/acme/app.git")).toBeUndefined();
    expect(repositoryOf("https://api.outrun.sh/v1/git/other/acme/app.git")).toBeUndefined();
  });
  it("shows an origin without its credential", () => {
    expect(shownOrigin(`https://42:secret@api.outrun.sh/v1/git/sbx_${"0".repeat(20)}/acme/app.git\n`)).toBe(
      `https://api.outrun.sh/v1/git/sbx_${"0".repeat(20)}/acme/app.git`,
    );
  });
});
