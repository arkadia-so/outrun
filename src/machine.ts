// What of the machine a verdict depends on, and the environment a unit runs with.
//
// The toolchain's fingerprint holds the runner's version (from its adapter), the OS and its
// release, the CPU architecture, the image the machine runs (`OUTRUN_IMAGE`, or GitHub's
// `ImageOS`/`ImageVersion`), the Unix user (a permission test passes as a user and fails as root),
// and which of the declared system binaries exist (a test needing `sqlite3`). It never holds the
// machine's name, its core count or an absolute path, so it is the same on every runner of one
// image.
//
// A unit's environment is an allow-list: every other variable is stripped. The keyed variables
// (locale, time zone, the runtime's options, CI, and what the configuration adds) go into the key
// with their values; a few are passed without being keyed because they hold absolute paths or
// change nothing a hermetic test sees (PATH, whose tools the fingerprint versions; HOME; proxies
// and CA bundles). TMPDIR is the batch's own folder.
import { release, type, userInfo } from "node:os";

type Env = Readonly<Record<string, string | undefined>>;

/** Keyed by default: they change what a test sees (a locale reorders a sort, BUN_OPTIONS changes bun). */
const KEYED_ENV = ["LANG", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "TZ", "BUN_OPTIONS", "NODE_OPTIONS", "NODE_ENV", "CI"] as const;

/** Passed through, not keyed. */
const PASSED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Pure: the keyed variables, sorted, with their values (absent ones as empty). */
export const keyedEnv = (env: Env, extra: readonly string[]) => [...new Set([...KEYED_ENV, ...extra])].sort().map((n) => [n, env[n] ?? ""] as const);

/** Pure: the environment of a unit's process: only the allow-list, and its own TMPDIR. */
export const unitEnv = (env: Env, extra: readonly string[], tmp: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of [...PASSED_ENV, ...KEYED_ENV, ...extra]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  out.TMPDIR = tmp;
  out.TMP = tmp;
  out.TEMP = tmp;
  return out;
};

/** The machine's part of the toolchain fingerprint (the adapter adds its runner's version). */
export const machineFingerprint = (env: Env, systemBinaries: readonly string[]) => {
  const user = env.USER ?? userInfo().username;
  const image = env.OUTRUN_IMAGE ?? (env.ImageOS ? `${env.ImageOS}-${env.ImageVersion ?? ""}` : "");
  const binaries = [...systemBinaries].sort().map((b) => `${b}=${Bun.which(b, { PATH: env.PATH ?? "" }) ? "yes" : "no"}`);
  return [`os=${type()} ${release()}`, `arch=${process.arch}`, `image=${image}`, `user=${user}`, ...binaries].join(" ");
};
