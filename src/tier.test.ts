import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FileFailed } from "./errors.ts";
import { tempDir } from "./test-tmp.ts";
import { restoreEntry, saveEntry } from "./tier.ts";

const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new FileFailed({ message: String(e) }) });

const dirs = () =>
  io(async () => {
    const own = await tempDir("outrun-tier-own-");
    const trusted = await tempDir("outrun-tier-protected-");
    const work = await tempDir("outrun-tier-work-");
    return { own, trusted, work, env: { OUTRUN_CACHE: own, OUTRUN_CACHE_PROTECTED: trusted } };
  });

describe("the job's cache tiers", () => {
  it.effect("restores from the job's own tier first, then the protected one, marking a protected entry used", () =>
    Effect.gen(function* () {
      const d = yield* dirs();
      yield* io(() => writeFile(`${d.trusted}/app.tar`, "trusted"));
      expect(yield* restoreEntry(d.env, "app.tar", `${d.work}/a`)).toBe("protected");
      expect(yield* io(() => readFile(`${d.work}/a`, "utf8"))).toBe("trusted");
      expect(existsSync(`${d.own}/.outrun-used/app.tar`)).toBe(true);
      yield* io(() => writeFile(`${d.own}/app.tar`, "own"));
      expect(yield* restoreEntry(d.env, "app.tar", `${d.work}/b`)).toBe("own");
      expect(yield* io(() => readFile(`${d.work}/b`, "utf8"))).toBe("own");
      expect(yield* restoreEntry(d.env, "other.tar", `${d.work}/c`)).toBeUndefined();
    }),
  );

  it.effect("saves into the job's own tier under its final name only, and nothing on a runner with no tier", () =>
    Effect.gen(function* () {
      const d = yield* dirs();
      yield* io(() => writeFile(`${d.work}/f`, "built"));
      expect(yield* saveEntry(d.env, `${d.work}/f`, "e2e-build-cache-x.tar")).toBe(true);
      expect(yield* io(() => readdir(d.own))).toEqual(["e2e-build-cache-x.tar"]);
      expect(yield* saveEntry({}, `${d.work}/f`, "e2e-build-cache-x.tar")).toBe(false);
      expect(yield* restoreEntry({}, "e2e-build-cache-x.tar", `${d.work}/g`)).toBeUndefined();
    }),
  );

  it.effect("refuses an entry that is a path", () =>
    Effect.gen(function* () {
      const d = yield* dirs();
      const refused = yield* Effect.flip(restoreEntry(d.env, "../etc/passwd", `${d.work}/x`));
      expect(refused._tag).toBe("UsageInvalid");
    }),
  );
});
