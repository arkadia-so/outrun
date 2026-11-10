// The engine's own state on this machine: the import scans by blob (a file's imports are read
// once per content) and the local verdict cache. Under $OUTRUN_STATE_DIR, else
// $XDG_CACHE_HOME/outrun, else ~/.cache/outrun.
import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { Effect } from "effect";
import { FileFailed } from "./errors.ts";

export const stateDir = (env: Readonly<Record<string, string | undefined>>) => env.OUTRUN_STATE_DIR ?? `${env.XDG_CACHE_HOME ?? `${homedir()}/.cache`}/outrun`;

const SCANS = "imports-2.json";

/** blob → its specifiers, or null when it did not parse. */
export type Scans = Map<string, readonly string[] | null>;

export const loadScans = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(`${dir}/${SCANS}`);
      if (!(await file.exists())) return new Map() as Scans;
      return new Map(Object.entries((await file.json()) as Record<string, readonly string[] | null>)) as Scans;
    },
    catch: () => new FileFailed({ message: `${dir}/${SCANS}: unreadable` }),
  });

export const saveScans = (dir: string, scans: Scans) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true });
      await Bun.write(`${dir}/${SCANS}.tmp`, JSON.stringify(Object.fromEntries(scans)));
      await rename(`${dir}/${SCANS}.tmp`, `${dir}/${SCANS}`);
    },
    catch: () => new FileFailed({ message: `${dir}/${SCANS}: not writable` }),
  });

const CELLS = "run-cells.json";

/** `outrun run`: the cells each workflow's job ran last time on this machine, by "<repo> <workflow> <job>". */
export type Cells = Record<string, number>;

export const loadCells = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(`${dir}/${CELLS}`);
      return (await file.exists()) ? ((await file.json()) as Cells) : {};
    },
    catch: () => new FileFailed({ message: `${dir}/${CELLS}: unreadable` }),
  });

export const saveCells = (dir: string, cells: Cells) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true });
      await Bun.write(`${dir}/${CELLS}.tmp`, JSON.stringify(cells));
      await rename(`${dir}/${CELLS}.tmp`, `${dir}/${CELLS}`);
    },
    catch: () => new FileFailed({ message: `${dir}/${CELLS}: not writable` }),
  });
