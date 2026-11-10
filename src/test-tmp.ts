// A test's scratch folders, removed after its file's tests (vitest.tmp.ts fails a run that leaves one).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const made: string[] = [];
afterAll(() => Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

export const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
