// One job of a workflow, for one matrix combination, compiled into the bash program a worker runs
// (outrun/README.md "outrun run"): the steps in order, as GitHub's runner runs them on Linux. What the
// CLI knows when the job starts (github, inputs, matrix, needs, strategy) is evaluated here; what only
// the running job knows (a step's outputs and outcome, the env) is read by the program as it runs:
// `$GITHUB_ENV`, `$GITHUB_OUTPUT` and `$GITHUB_PATH` written by each step, each step's `if:` decided
// from the job's status so far (its value for each status computed here), `continue-on-error`,
// `timeout-minutes`, `defaults.run`, `shell`, `working-directory`, and the job's outputs. Its result,
// `$OUTRUN_RUN_RESULT` (`{outputs, steps: [{name, outcome, conclusion, ms}]}`), is what the CLI reads back.
import { condition, evaluate, ExprError, type Node, type Scope, template, toText, type Value } from "./expr.ts";
import { type Job, readsRuntime, runtimeRef, shellCommand, type Workflow } from "./workflow.ts";

const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Raw = { readonly [key: string]: unknown };
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

// A string whose `${{ }}` the job resolves as it runs, as one bash word: its literal text quoted, each
// runtime reference read where it stands, the rest evaluated now.
const word = (text: string, scope: Scope): string => {
  const parts = template(text);
  if (parts.length === 0) return "''";
  return parts
    .map((part) => {
      if (!("expr" in part)) return q(part.text);
      const ref = runtimeRef(part.expr);
      if (ref) return refWord(ref);
      return q(toText(evaluate(part.expr, scope)));
    })
    .join("");
};

// A mapping of env values (workflow, job or step), evaluated now.
const envOf = (raw: unknown, scope: Scope): [string, string][] =>
  isObject(raw)
    ? Object.entries(raw).map(([key, value]) => [key, typeof value === "string" ? toText(evaluateText(value, scope)) : toText(value as Value)])
    : [];
const evaluateText = (text: string, scope: Scope): Value => {
  const parts = template(text);
  if (parts.length === 1 && "expr" in parts[0]! && text.trim().startsWith("${{") && text.trim().endsWith("}}")) return evaluate(parts[0].expr, scope);
  return parts.map((part) => ("expr" in part ? toText(evaluate(part.expr, scope)) : part.text)).join("");
};

const defaultsOf = (raw: unknown) => (isObject(raw) && isObject(raw.run) ? raw.run : {});

// A step's `if:` under each status of the job so far: a bash test of whether it runs after success,
// after a failure. What reads steps or env is decided as the job runs (stepCondition), the rest now.
const runsWhen = (node: Node, scope: Scope) => ({
  success: testOf(stepCondition(node, { ...scope, status: "success" })),
  failure: testOf(stepCondition(node, { ...scope, status: "failure" })),
});
type Decided = { readonly value: boolean } | { readonly test: string };
const testOf = (d: Decided) => ("test" in d ? d.test : String(d.value));
// The shape workflow.ts `runtimeConditionProblem` admits: a whole reference (its truthiness, a string
// being true when not empty), == or != between references and string literals (GitHub compares
// strings ignoring case), under !, && and ||.
const stepCondition = (node: Node, scope: Scope): Decided => {
  if (!readsRuntime(node)) return { value: truthyOf(evaluate(node, scope)) };
  const ref = runtimeRef(node);
  if (ref) return { test: `[ -n ${refWord(ref)} ]` };
  if (node.kind === "not") {
    const inner = stepCondition(node.operand, scope);
    return "test" in inner ? { test: `! { ${inner.test}; }` } : { value: !inner.value };
  }
  if (node.kind === "binary" && (node.op === "&&" || node.op === "||")) {
    const left = stepCondition(node.left, scope);
    const right = stepCondition(node.right, scope);
    if ("value" in left) return node.op === "&&" ? (left.value ? right : left) : left.value ? left : right;
    if ("value" in right) return node.op === "&&" ? (right.value ? left : right) : right.value ? right : left;
    return { test: `{ ${left.test}; } ${node.op} { ${right.test}; }` };
  }
  if (node.kind === "binary" && (node.op === "==" || node.op === "!=")) {
    const side = (n: Node) => {
      const r = runtimeRef(n);
      return r ? `"$(lower ${refWord(r)})"` : q(String(evaluate(n, scope)).toLowerCase());
    };
    return { test: `[ ${side(node.left)} ${node.op === "==" ? "=" : "!="} ${side(node.right)} ]` };
  }
  throw new ExprError("a step's if: outside what outrun run v1 decides while the job runs");
};
const refWord = (ref: readonly string[]) =>
  ref[0] === "env" ? `"\${${ref[1]}-}"` : ref.length === 4 ? `"$(out ${q(ref[1]!)} ${q(ref[3]!)})"` : `"$(state ${q(ref[1]!)} ${q(ref[2]!.toLowerCase())})"`;
const truthyOf = (v: Value) => !(v === null || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));

// The helpers the program defines: a file of GitHub's `name=value` / `name<<DELIM` format applied to
// the env, to step outputs, the path; a step's outputs and state read back.
// `$<` stands for `${` (a template literal would read it).
const HELPERS = String.raw`
# GitHub's file format: name=value, or name<<DELIM, the lines, DELIM.
ghfile() {
  local file=$1 fn=$2 line name delim value
  [ -s "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == *"<<"* && ( "$line" != *"="* || "$<line%%<<*}" != *"="* ) ]]; then
      name=$<line%%<<*}; delim=$<line#*<<}; value=""
      local first=1
      while IFS= read -r line || [ -n "$line" ]; do
        [ "$line" = "$delim" ] && break
        if [ $first = 1 ]; then value=$line; first=0; else value+=$'\n'"$line"; fi
      done
      "$fn" "$name" "$value"
    elif [[ "$line" == *"="* ]]; then
      "$fn" "$<line%%=*}" "$<line#*=}"
    fi
  done < "$file"
}
setenv() { export "$1=$2"; }
out() { cat "$OUTRUN_RUN_DIR/steps/$1/outputs/$2" 2>/dev/null || true; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
state() { cat "$OUTRUN_RUN_DIR/steps/$1/$2" 2>/dev/null || true; }
ms() { local t; t=$(date +%s%3N); [[ "$t" != *N ]] || t=$(( $(date +%s) * 1000 )); echo "$t"; }
writeout() { printf '%s' "$2" > "./$1"; }
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$OUTRUN_RUN_DIR/steps.tsv"; }
`.replaceAll("$<", "${");

export interface Compiled {
  readonly script: string;
  // The job's deadline (its timeout-minutes, else GitHub's default, 360).
  readonly timeoutMs: number;
}

/**
 * The program of one job cell. `scope`: its contexts (github, inputs, matrix, needs, strategy, runner).
 * `env`: what GitHub sets for every step (GITHUB_*, RUNNER_*), beside the workflow's and the job's env.
 */
export const compileJob = (workflow: Workflow, job: Job, scope: Scope, env: Readonly<Record<string, string>>): Compiled => {
  const staticScope: Scope = { ...scope, runtime: new Set(["steps", "env"]) };
  const timeout = job.raw["timeout-minutes"];
  const minutes = timeout === undefined ? 360 : Number(typeof timeout === "string" ? evaluateText(timeout, scope) : timeout);
  const defaults = { ...defaultsOf(workflow.raw.defaults), ...defaultsOf(job.raw.defaults) };
  const lines: string[] = [
    "set -uo pipefail",
    HELPERS,
    "export OUTRUN_RUN_DIR=$(mktemp -d /tmp/outrun-run.XXXXXX)",
    'mkdir -p "$OUTRUN_RUN_DIR/tmp" "$OUTRUN_RUN_DIR/steps"',
    ': > "$OUTRUN_RUN_DIR/steps.tsv"',
    'export RUNNER_TEMP="$OUTRUN_RUN_DIR/tmp" GITHUB_WORKSPACE="$PWD" GITHUB_STEP_SUMMARY="$OUTRUN_RUN_DIR/summary.md"',
    "export GITHUB_SHA=$(git rev-parse HEAD)",
    // A job with no actions/checkout gets no tree, as on GitHub: an empty workspace.
    ...(job.steps.some((step) => typeof step.raw.uses === "string")
      ? []
      : ['mkdir -p "$OUTRUN_RUN_DIR/workspace" && cd "$OUTRUN_RUN_DIR/workspace"', 'export GITHUB_WORKSPACE="$PWD"']),
    ...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`),
    ...[...envOf(workflow.raw.env, scope), ...envOf(job.raw.env, scope)].map(([k, v]) => `export ${k}=${q(v)}`),
    "status=success",
  ];
  job.steps.forEach((step, i) => {
    const raw = step.raw;
    const name =
      typeof raw.name === "string"
        ? toText(evaluateText(raw.name, scope))
        : raw.run !== undefined
          ? `Run ${toText(raw.run as Value)
              .split("\n")[0]!
              .trim()}`
          : `Run ${String(raw.uses)}`;
    const id = typeof raw.id === "string" ? raw.id : `__${i}`;
    const when = runsWhen(condition(raw.if as string | undefined), scope);
    const label = `step ${i + 1}/${job.steps.length} · ${name}`;
    const dir = `"$OUTRUN_RUN_DIR/steps/"${q(id)}`;
    const body: string[] = [`echo ${q(`── ${label}`)}`, `mkdir -p ${dir}/outputs`, "t=$(ms)"];
    const continueOnError =
      raw["continue-on-error"] === true || (typeof raw["continue-on-error"] === "string" && truthyOf(evaluateText(raw["continue-on-error"], scope)));
    if (typeof raw.uses === "string") {
      // actions/checkout of the run's own repository: the worker's checkout is already the run's tree
      // (the warm commit, the change applied and committed: $GITHUB_SHA); ignored files (the warm's
      // caches) stay, untracked ones are gone (the apply's git clean).
      body.push('echo "checkout: the run\'s tree at $GITHUB_SHA"', "code=0");
    } else {
      const stepDefaults = defaults;
      const shellName = typeof raw.shell === "string" ? raw.shell : typeof stepDefaults.shell === "string" ? stepDefaults.shell : undefined;
      const shell = shellCommand(shellName)!;
      const wd =
        typeof raw["working-directory"] === "string"
          ? raw["working-directory"]
          : typeof stepDefaults["working-directory"] === "string"
            ? stepDefaults["working-directory"]
            : undefined;
      const file = `"$OUTRUN_RUN_DIR/step-${i}.sh"`;
      const stepTimeout =
        raw["timeout-minutes"] === undefined
          ? undefined
          : Number(typeof raw["timeout-minutes"] === "string" ? evaluateText(raw["timeout-minutes"], scope) : raw["timeout-minutes"]);
      const command = shell.replace("{0}", file);
      body.push(
        `: > "$OUTRUN_RUN_DIR/env" ; : > "$OUTRUN_RUN_DIR/path" ; : > ${dir}/output`,
        `(`,
        `  export GITHUB_ENV="$OUTRUN_RUN_DIR/env" GITHUB_PATH="$OUTRUN_RUN_DIR/path" GITHUB_OUTPUT=${dir}/output`,
        ...(isObject(raw.env)
          ? Object.entries(raw.env).map(([k, v]) => `  export ${k}=${typeof v === "string" ? word(v, staticScope) : q(toText(v as Value))}`)
          : []),
        `  printf '%s' ${word(toText(raw.run as Value), staticScope)} > ${file}`,
        ...(wd ? [`  cd ${word(wd, staticScope)} || exit 1`] : []),
        `  exec ${stepTimeout ? `timeout --kill-after=10 ${Math.max(1, Math.round(stepTimeout * 60))} ` : ""}${command}`,
        `) </dev/null; code=$?`,
        'ghfile "$OUTRUN_RUN_DIR/env" setenv',
        `while IFS= read -r p || [ -n "$p" ]; do [ -z "$p" ] || export PATH="$p:$PATH"; done < "$OUTRUN_RUN_DIR/path"`,
        `( cd ${dir}/outputs && ghfile ${dir}/output writeout )`,
      );
    }
    body.push(
      "took=$(( $(ms) - t ))",
      'if [ "$code" = 0 ]; then outcome=success; else outcome=failure; fi',
      `conclusion=$outcome; ${continueOnError ? '[ "$outcome" = success ] || conclusion=success' : ":"}`,
      `printf '%s' "$outcome" > ${dir}/outcome; printf '%s' "$conclusion" > ${dir}/conclusion`,
      '[ "$conclusion" = success ] || status=failure',
      `[ "$code" = 0 ] || echo ${q(`── ${label}: `)}"exit $code"`,
      `record ${q(name)} "$outcome" "$conclusion" "$took"`,
    );
    lines.push(
      `if { [ "$status" = success ] && ${when.success}; } || { [ "$status" = failure ] && ${when.failure}; }; then`,
      ...body.map((l) => `  ${l}`),
      "else",
      `  mkdir -p ${dir}; printf skipped > ${dir}/outcome; printf skipped > ${dir}/conclusion`,
      `  record ${q(name)} skipped skipped 0`,
      "fi",
    );
  });
  // The job's outputs, then the result the worker sends back.
  const outputs = isObject(job.raw.outputs) ? Object.entries(job.raw.outputs) : [];
  lines.push(
    'outputs="{}"',
    ...outputs.map(
      ([key, value]) =>
        `outputs=$(jq -c --arg k ${q(key)} --arg v ${word(typeof value === "string" ? value : toText(value as Value), staticScope)} '. + {($k): $v}' <<<"$outputs")`,
    ),
    `jq -n -c --argjson outputs "$outputs" --rawfile steps "$OUTRUN_RUN_DIR/steps.tsv" '{outputs: $outputs, steps: ($steps | split("\\n") | map(select(length > 0) | split("\\t") | {name: .[0], outcome: .[1], conclusion: .[2], ms: (.[3] | tonumber)}))}' > "\${OUTRUN_RUN_RESULT:-/dev/null}"`,
    '[ "$status" = success ]',
  );
  return {
    script: lines.join("\n"),
    timeoutMs: Math.max(1, minutes) * 60_000,
  };
};
