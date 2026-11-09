// `outrun e2e-env`: the lines the reusable e2e workflow appends to $GITHUB_ENV, so that its jobs' tests
// see the caller's variables (`env`, NAME=value per line), the secrets it named (`env-secrets`), and the
// variables of its `env` secret (NAME=value per line, for a caller in another organization, which
// `secrets: inherit` does not reach), each under its own name. Explicit: a secret reaches the tests
// only when the caller names it or writes it in the `env` secret.
import { UsageInvalid } from "./errors.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What the workflow's step writes: $GITHUB_ENV's lines, and the secret values the log must mask. */
export interface E2eEnv {
  /** `NAME<<delimiter`, the value, the delimiter; empty when there is nothing. */
  readonly lines: string;
  /** Every value that came from a secret (`env-secrets` and the `env` secret), never printed. */
  readonly masks: readonly string[];
}

/** Pure: NAME=value lines, or the first one that is not. `what` names them in the error, never a value. */
const pairs = (text: string, what: string): (readonly [string, string])[] | UsageInvalid => {
  const out: (readonly [string, string])[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const at = line.indexOf("=");
    const name = line.slice(0, at).trim();
    if (at < 0 || !NAME.test(name)) return new UsageInvalid({ message: `${what}: line ${index + 1} is not NAME=value` });
    out.push([name, line.slice(at + 1).replace(/\r$/, "")]);
  }
  return out;
};

/** Pure: $GITHUB_ENV's lines and the values to mask, or the first mistake. */
export const e2eEnvLines = (variables: string, names: string, secrets: string, delimiter: string): E2eEnv | UsageInvalid => {
  const out: string[] = [];
  const masks: string[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: string, secret: boolean) => {
    if (seen.has(name)) return new UsageInvalid({ message: `${name} is set twice (env, env-secrets and the env secret name each variable once)` });
    if (value.includes(delimiter)) return new UsageInvalid({ message: `${name}: its value holds the delimiter` });
    seen.add(name);
    if (secret && value) masks.push(value);
    out.push(`${name}<<${delimiter}`, value, delimiter);
    return undefined;
  };
  const plain = pairs(variables, "env");
  if (plain instanceof UsageInvalid) return plain;
  for (const [name, value] of plain) {
    const failed = add(name, value, false);
    if (failed) return failed;
  }
  let all: Record<string, unknown>;
  try {
    all = JSON.parse(secrets || "{}") as Record<string, unknown>;
  } catch {
    return new UsageInvalid({ message: "env-secrets: the secrets context is not JSON" });
  }
  for (const name of names.split(/\s+/).filter(Boolean)) {
    if (!NAME.test(name)) return new UsageInvalid({ message: `env-secrets: "${name}" is not a variable name` });
    const value = all[name];
    if (typeof value !== "string")
      return new UsageInvalid({
        message: `env-secrets: no secret ${name} reached the workflow (pass \`secrets: inherit\`; from another organization, write it in the \`env\` secret)`,
      });
    const failed = add(name, value, true);
    if (failed) return failed;
  }
  if (typeof all.env === "string") {
    const fromSecret = pairs(all.env, "the env secret");
    if (fromSecret instanceof UsageInvalid) return fromSecret;
    for (const [name, value] of fromSecret) {
      const failed = add(name, value, true);
      if (failed) return failed;
    }
  }
  return { lines: out.length > 0 ? `${out.join("\n")}\n` : "", masks };
};
