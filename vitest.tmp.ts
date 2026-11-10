// Every test leaves no folder behind (OUT-56: 419 job folders and 215 test projects left in /tmp
// by the tests of outrun run and the runner adapters). The run gets its own TMPDIR, which node's
// tmpdir() and the job program's mktemp read; at the end anything left in it fails the run.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "outrun-oss-tests-"));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    const left = readdirSync(dir);
    rmSync(dir, { recursive: true, force: true });
    if (left.length) throw new Error(`the tests left ${left.length} entries in their TMPDIR: ${left.slice(0, 10).join(", ")}`);
  };
}
