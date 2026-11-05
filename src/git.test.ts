import { describe, expect, it } from "vitest";
import { blobHash, parseIndex } from "./git.ts";

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
