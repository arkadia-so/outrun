import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "action/**/*.test.ts"],
    globalSetup: ["./vitest.tmp.ts"],
    // Its own module cache, beside its own lockfile. Vitest keeps the cache in the workspace's node_modules and
    // empties it whenever the nearest lockfile's hash differs from the one it recorded: this folder's bun.lock and
    // the monorepo's took turns, so each run here deleted the cache under the tests running beside it, which failed
    // reading it (ENOENT on node_modules/.vitest-cache/<hash>, ARK-128; issue #559).
    fsModuleCachePath: fileURLToPath(new URL("./node_modules/.vitest-cache", import.meta.url)),
  },
});
