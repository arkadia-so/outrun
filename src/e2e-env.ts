// `outrun e2e-env`: the lines the reusable e2e workflow appends to $GITHUB_ENV, so that its jobs' tests
// see the caller's variables (`env`, NAME=value per line) and the secrets it named (`env-secrets`),
// each under its own name. Explicit: a secret reaches the tests only when the caller names it.
import { UsageInvalid } from "./errors.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Pure: $GITHUB_ENV's lines (`NAME<<delimiter`, the value, the delimiter), or the first mistake. */
export const e2eEnvLines = (variables: string, names: string, secrets: string, delimiter: string): string | UsageInvalid => {
  const out: string[] = [];
  const add = (name: string, value: string) => {
    if (value.includes(delimiter)) return new UsageInvalid({ message: `${name}: its value holds the delimiter` });
    out.push(`${name}<<${delimiter}`, value, delimiter);
    return undefined;
  };
  for (const line of variables.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf("=");
    const name = line.slice(0, at).trim();
    if (at < 0 || !NAME.test(name)) return new UsageInvalid({ message: `env: "${line}" is not NAME=value` });
    const failed = add(name, line.slice(at + 1));
    if (failed) return failed;
  }
  const wanted = names.split(/\s+/).filter(Boolean);
  if (wanted.length > 0) {
    let all: Record<string, unknown>;
    try {
      all = JSON.parse(secrets || "{}") as Record<string, unknown>;
    } catch {
      return new UsageInvalid({ message: "env-secrets: the secrets context is not JSON" });
    }
    for (const name of wanted) {
      if (!NAME.test(name)) return new UsageInvalid({ message: `env-secrets: "${name}" is not a variable name` });
      const value = all[name];
      if (typeof value !== "string")
        return new UsageInvalid({ message: `env-secrets: no secret ${name} reached the workflow (pass \`secrets: inherit\`, or name it under secrets:)` });
      const failed = add(name, value);
      if (failed) return failed;
    }
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
};
