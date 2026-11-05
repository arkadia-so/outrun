// One batch's process: started in its own process group, so a watchdog or an interruption kills it
// and everything it started; its output is kept (bounded) for the report. Two watchdogs: a
// deadline, and silence (no output for `idleMs`: a runner whose compiler was killed can wait
// forever without using any time).
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { SpawnFailed } from "./errors.ts";

export interface Exec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly idleMs: number;
}

export interface Exited {
  readonly code: number | null;
  readonly signal: string | null;
  /** Why a watchdog killed it, if one did. */
  readonly killed?: "deadline" | "idle" | undefined;
  readonly output: string;
  readonly durationMs: number;
}

const MAX_OUTPUT = 256 * 1024;

const killGroup = (pid: number | undefined) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone: nothing to kill.
  }
};

export const exec = (job: Exec) =>
  Effect.callback<Exited, SpawnFailed>((resume, signal) => {
    const started = performance.now();
    const [command, ...args] = job.argv;
    if (!command) return resume(Effect.fail(new SpawnFailed({ message: "empty command" })));
    const child = spawn(command, args, { cwd: job.cwd, env: job.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let lastOutput = performance.now();
    const keep = (chunk: Buffer) => {
      lastOutput = performance.now();
      if (size >= MAX_OUTPUT) return;
      chunks.push(chunk);
      size += chunk.byteLength;
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let killed: Exited["killed"];
    const watchdog = setTimeout(() => {
      killed = "deadline";
      killGroup(child.pid);
    }, job.timeoutMs);
    const silence = setInterval(
      () => {
        if (performance.now() - lastOutput < job.idleMs) return;
        killed = "idle";
        killGroup(child.pid);
      },
      Math.min(2000, job.idleMs),
    );
    const stop = () => {
      clearTimeout(watchdog);
      clearInterval(silence);
    };
    const abort = () => killGroup(child.pid);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      stop();
      resume(Effect.fail(new SpawnFailed({ message: `${command}: ${error.message}` })));
    });
    child.once("close", (code, sig) => {
      stop();
      signal.removeEventListener("abort", abort);
      // The group may hold processes the batch left behind (servers, watchers): end them too.
      killGroup(child.pid);
      resume(Effect.succeed({ code, signal: sig, killed, output: Buffer.concat(chunks).toString("utf8"), durationMs: performance.now() - started }));
    });
  });
