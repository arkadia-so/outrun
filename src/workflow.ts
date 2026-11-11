// A GitHub Actions workflow as `outrun run` reads it (outrun/README.md "outrun run"): the file
// parsed, the jobs a run selects (`--job` and what they need), each checked against the supported
// subset before anything runs, a refusal naming the feature, the file and the line; then a job's
// matrix expanded and its contexts made, as GitHub makes them for a `workflow_dispatch`.
import { condition, ExprError, interpolate, type Node, pathOf, type Scope, template, uses, type Value } from "./expr.ts";

export interface Refusal {
  readonly line: number;
  readonly what: string;
}

type Raw = { readonly [key: string]: unknown };
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

interface Step {
  readonly index: number;
  readonly line: number;
  readonly raw: Raw;
}
export interface Job {
  readonly id: string;
  readonly line: number;
  readonly raw: Raw;
  readonly needs: readonly string[];
  readonly steps: readonly Step[];
}
export interface Workflow {
  readonly path: string;
  readonly name: string;
  readonly raw: Raw;
  readonly jobs: ReadonlyMap<string, Job>;
}

// The line of a key under a parent block (both found by indentation), 1-based; `from` the parent's.
const keyLine = (lines: readonly string[], key: string, from: number, parentIndent: number) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*)(?:-\\s+)?["']?${escaped}["']?\\s*:`);
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (i > from && indent <= parentIndent && parentIndent >= 0) return -1;
    const m = pattern.exec(line);
    if (m && i >= from && (parentIndent < 0 || m[1]!.length > parentIndent)) return i;
  }
  return -1;
};
const indentOf = (line: string | undefined) => (line === undefined ? 0 : line.length - line.trimStart().length);

/** The workflow file's text parsed (YAML), its jobs located by line. */
export const parseWorkflow = (path: string, text: string): { workflow: Workflow } | { refusals: Refusal[] } => {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (error) {
    return { refusals: [{ line: 1, what: `not valid YAML: ${String(error)}` }] };
  }
  if (!isObject(raw) || !isObject(raw.jobs)) return { refusals: [{ line: 1, what: "no `jobs:` mapping" }] };
  const lines = text.split("\n");
  const jobsAt = keyLine(lines, "jobs", 0, -1);
  const jobs = new Map<string, Job>();
  for (const [id, value] of Object.entries(raw.jobs)) {
    const at = keyLine(lines, id, jobsAt + 1, indentOf(lines[jobsAt]));
    const job = isObject(value) ? value : {};
    const stepsAt = at >= 0 ? keyLine(lines, "steps", at + 1, indentOf(lines[at])) : -1;
    // Each step's line: the `- ` items under `steps:`, at the first item's indentation.
    const items: number[] = [];
    if (stepsAt >= 0) {
      let itemIndent = -1;
      for (let i = stepsAt + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        const indent = indentOf(line);
        if (indent <= indentOf(lines[stepsAt]) && !line.trimStart().startsWith("-")) break;
        if (indent < indentOf(lines[stepsAt])) break;
        if (line.trimStart().startsWith("-") && (itemIndent < 0 || indent === itemIndent)) {
          itemIndent = indent;
          items.push(i + 1);
        }
      }
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const needs = typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs.map(String) : [];
    jobs.set(id, {
      id,
      line: at + 1,
      raw: job,
      needs,
      steps: steps.map((step, index) => ({ index, line: items[index] ?? at + 1, raw: isObject(step) ? step : {} })),
    });
  }
  return { workflow: { path, name: typeof raw.name === "string" ? raw.name : path, raw, jobs } };
};

/** The jobs to run: those named (all when none) and every job they need, in the file's order. */
export const selectJobs = (workflow: Workflow, named: readonly string[]): { jobs: Job[] } | { refusals: Refusal[] } => {
  const unknown = named.filter((id) => !workflow.jobs.has(id));
  if (unknown.length > 0) return { refusals: [{ line: 1, what: `no job ${unknown.join(", ")} (jobs: ${[...workflow.jobs.keys()].join(", ")})` }] };
  const keep = new Set<string>();
  const add = (id: string) => {
    if (keep.has(id)) return;
    keep.add(id);
    for (const need of workflow.jobs.get(id)?.needs ?? []) add(need);
  };
  for (const id of named.length > 0 ? named : [...workflow.jobs.keys()]) add(id);
  const refusals: Refusal[] = [];
  for (const id of keep)
    for (const need of workflow.jobs.get(id)!.needs)
      if (!workflow.jobs.has(need)) refusals.push({ line: workflow.jobs.get(id)!.line, what: `job ${id} needs ${need}, which the workflow does not have` });
  // A cycle in `needs`.
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    const cyclic = (workflow.jobs.get(id)?.needs ?? []).some(visit);
    state.set(id, 2);
    return cyclic;
  };
  for (const id of keep) if (visit(id)) refusals.push({ line: workflow.jobs.get(id)!.line, what: `job ${id}: its needs form a cycle` });
  if (refusals.length > 0) return { refusals };
  return { jobs: [...workflow.jobs.values()].filter((job) => keep.has(job.id)) };
};

// The supported subset (outrun/README.md "outrun run"): every other key is refused, never ignored.
const WORKFLOW_KEYS = new Set(["name", "run-name", "on", "true", "env", "defaults", "jobs", "permissions"]);
const JOB_KEYS = new Set([
  "name",
  "needs",
  "runs-on",
  "if",
  "steps",
  "env",
  "defaults",
  "timeout-minutes",
  "strategy",
  "outputs",
  "continue-on-error",
  "permissions",
]);
const STEP_KEYS = new Set(["id", "name", "if", "run", "uses", "with", "env", "shell", "working-directory", "continue-on-error", "timeout-minutes"]);
const STRATEGY_KEYS = new Set(["matrix", "fail-fast", "max-parallel"]);
const CHECKOUT = /^actions\/checkout@[\w.-]+$/;
// The checkout inputs `outrun run` honors exactly (job-script.ts); any other is refused.
const CHECKOUT_INPUTS = new Set(["clean", "fetch-depth", "persist-credentials", "show-progress", "path", "repository", "ref"]);
// Why a key is refused, for the refusal's line.
const WHY: Readonly<Record<string, string>> = {
  environment: "an environment's protection rules and reviewers cannot be honored outside GitHub",
  concurrency: "not supported by outrun run v1",
  container: "not supported by outrun run v1 (Linux containers come later)",
  services: "not supported by outrun run v1 (Linux services come later)",
  uses: "reusable workflows are not supported by outrun run v1",
};
// The contexts an expression may read; `secrets` and `github.token` have no value in a local run.
const CONTEXTS = new Set(["github", "inputs", "matrix", "needs", "runner", "strategy", "steps", "env"]);
// The github context's keys a local run knows (run.ts `githubContext`); the others (sha, event,
// run_id...) describe a GitHub run there is not.
// `event`: a workflow_dispatch's payload ({inputs, ref, workflow}), as GitHub gives it: any other field
// (`github.event.pull_request`) is null there too.
const GITHUB_KEYS = new Set(["repository", "repository_owner", "event_name", "event", "ref", "ref_name", "workflow", "job", "server_url", "api_url"]);
const RUNTIME_CONTEXTS = new Set(["steps", "env"]);

// Every expression string in a value (a mapping's values, a list's items), with the line it sits on.
const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : isObject(value) ? Object.values(value).flatMap(strings) : [];

const checkExpressions = (
  texts: readonly string[],
  line: number,
  where: string,
  refusals: Refusal[],
  options: { runtime: boolean; bare?: boolean; condition?: boolean },
) => {
  for (const text of texts) {
    let nodes: { node: Node; source: string }[];
    try {
      nodes = options.bare
        ? [{ node: condition(text), source: text }]
        : template(text).flatMap((part) => ("expr" in part ? [{ node: part.expr, source: part.source }] : []));
    } catch (error) {
      refusals.push({ line, what: `${where}: ${error instanceof ExprError ? error.message : String(error)}` });
      continue;
    }
    for (const { node, source } of nodes) {
      const { contexts, functions } = uses(node);
      for (const context of contexts) {
        if (context === "secrets") refusals.push({ line, what: `${where}: secrets are not given to a local run (outrun run v1 holds none)` });
        else if (context === "vars") refusals.push({ line, what: `${where}: vars: the repository's variables are not read by outrun run v1` });
        else if (context === "job") refusals.push({ line, what: `${where}: the job context is not supported by outrun run v1` });
        else if (!CONTEXTS.has(context)) refusals.push({ line, what: `${where}: unknown context ${context}` });
      }
      for (const key of githubKeys(node))
        if (key === "token") refusals.push({ line, what: `${where}: github.token: no GitHub token is minted for a tree GitHub has never seen` });
        else if (!GITHUB_KEYS.has(key))
          refusals.push({
            line,
            what: `${where}: github.${key} is not known to a local run (outrun run v1 knows github.${[...GITHUB_KEYS].join(", github.")})`,
          });
      if (functions.has("hashfiles")) refusals.push({ line, what: `${where}: hashFiles() is not supported by outrun run v1` });
      const runtime = [...contexts].filter((c) => RUNTIME_CONTEXTS.has(c));
      if (runtime.length > 0) {
        if (options.condition) {
          const problem = runtimeConditionProblem(node);
          if (problem) refusals.push({ line, what: `${where}: \${{ ${source} }}: ${problem}` });
        } else if (!options.runtime) refusals.push({ line, what: `${where}: ${runtime.join(", ")} cannot be read here by outrun run v1` });
        else if (!runtimeRef(node))
          refusals.push({
            line,
            what: `${where}: \${{ ${source} }}: v1 reads steps and env only as a whole \${{ steps.<id>.outputs.<name> }} or \${{ env.<NAME> }}`,
          });
      }
    }
  }
};

/** Whether an expression reads a context only the running job knows (`steps`, `env`). */
export const readsRuntime = (node: Node): boolean => [...uses(node).contexts].some((c) => RUNTIME_CONTEXTS.has(c));

// A step's `if:` reading steps or env, which its program decides as it runs (job-script.ts
// `stepCondition`): v1 takes a whole reference, alone (its truthiness) or compared with == or != to
// a string literal or another reference, under !, && and ||. Why not, else null.
const runtimeConditionProblem = (node: Node): string | null => {
  if (!readsRuntime(node) || runtimeRef(node)) return null;
  if (node.kind === "not") return runtimeConditionProblem(node.operand);
  if (node.kind === "binary" && (node.op === "&&" || node.op === "||")) return runtimeConditionProblem(node.left) ?? runtimeConditionProblem(node.right);
  const operand = (n: Node) => runtimeRef(n) !== null || (n.kind === "literal" && typeof n.value === "string");
  if (node.kind === "binary" && (node.op === "==" || node.op === "!=") && operand(node.left) && operand(node.right)) return null;
  return "v1 decides a step's if: on steps or env only from whole references (steps.<id>.outputs.<name>, steps.<id>.outcome, env.<NAME>), alone or compared with == or != to a string or another reference, under !, && and ||";
};

// The github context's keys an expression reads (`github` alone, or `github[expr]`: "*").
const githubKeys = (node: Node): string[] => {
  const keys: string[] = [];
  const walk = (n: Node) => {
    if (n.kind === "index" && n.target.kind === "context" && n.target.name === "github")
      keys.push(n.key.kind === "literal" && typeof n.key.value === "string" ? n.key.value.toLowerCase() : "*");
    else if (n.kind === "context" && n.name === "github") keys.push("*");
    if (n.kind === "index") {
      if (!(n.target.kind === "context" && n.target.name === "github")) walk(n.target);
      walk(n.key);
    } else if (n.kind === "star") walk(n.target);
    else if (n.kind === "not") walk(n.operand);
    else if (n.kind === "binary") {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === "call") n.args.forEach(walk);
  };
  walk(node);
  return keys;
};

/** The OS a job's VM runs: Linux (arm64), or macOS for outrun's own Mac labels. */
export type Os = "linux" | "macos";

/**
 * The OS of a job's runs-on labels, or why outrun run cannot run it: outrun's Mac labels
 * (`outrun-macos`, its `-priority` and `-flex` tiers) run on a macOS VM of the Mac CI's image, any
 * other Mac, Windows or Xcode label is refused (GitHub's `macos-15` names an image outrun does not
 * have), and every other label runs on Linux.
 */
export const runsOnOf = (labels: Value): Os | { readonly refused: string } => {
  const list = Array.isArray(labels)
    ? labels.map(String)
    : typeof labels === "string"
      ? [labels]
      : labels && typeof labels === "object"
        ? null
        : [String(labels)];
  if (!list) return { refused: "runs-on as a group is not supported by outrun run v1" };
  const macos = list.some((label) => /^outrun-macos(-priority|-flex)?$/.test(label));
  const other = list.find((label) => /mac|windows|xcode/i.test(label) && !/^outrun-macos(-priority|-flex)?$/.test(label));
  if (other) return { refused: `runs-on ${other}: outrun run runs Linux jobs and outrun-macos ones only` };
  return macos ? "macos" : "linux";
};

/** A reference the job's script resolves while it runs: `steps.<id>.outputs.<name>`, `steps.<id>.(outcome|conclusion)` or `env.<NAME>`. */
export const runtimeRef = (node: Node): readonly string[] | null => {
  const path = pathOf(node);
  if (!path) return null;
  if (path[0] === "env" && path.length === 2) return path;
  if (path[0] === "steps" && path.length === 4 && path[2]!.toLowerCase() === "outputs") return path;
  if (path[0] === "steps" && path.length === 3 && ["outcome", "conclusion"].includes(path[2]!.toLowerCase())) return path;
  return null;
};

/** Everything in the selected jobs outside the supported subset, before anything runs. */
export const refusalsOf = (workflow: Workflow, jobs: readonly Job[], repo: string): Refusal[] => {
  const refusals: Refusal[] = [];
  for (const key of Object.keys(workflow.raw))
    if (!WORKFLOW_KEYS.has(key)) refusals.push({ line: 1, what: `the workflow's ${key}: ${WHY[key] ?? "not supported by outrun run v1"}` });
  checkExpressions(strings(workflow.raw.env), 1, "the workflow's env", refusals, { runtime: false });
  const inputs = isObject(workflow.raw.on) && isObject(workflow.raw.on.workflow_dispatch) ? workflow.raw.on.workflow_dispatch.inputs : undefined;
  if (isObject(inputs))
    for (const [name, input] of Object.entries(inputs))
      if (isObject(input) && input.type === "environment") refusals.push({ line: 1, what: `input ${name}: inputs of type environment are refused` });
  for (const job of jobs) {
    const at = (what: string) => ({ line: job.line, what: `job ${job.id}: ${what}` });
    for (const key of Object.keys(job.raw)) if (!JOB_KEYS.has(key)) refusals.push(at(`${key}: ${WHY[key] ?? "not supported by outrun run v1"}`));
    const strategy = job.raw.strategy;
    if (strategy !== undefined) {
      if (!isObject(strategy)) refusals.push(at("strategy is not a mapping"));
      else for (const key of Object.keys(strategy)) if (!STRATEGY_KEYS.has(key)) refusals.push(at(`strategy.${key} is not supported`));
    }
    const where = `job ${job.id}`;
    checkExpressions(strings(job.raw["runs-on"]), job.line, `${where} runs-on`, refusals, { runtime: false });
    if (job.raw["runs-on"] === undefined) refusals.push(at("no runs-on"));
    checkExpressions(strings(job.raw.env), job.line, `${where} env`, refusals, { runtime: false });
    checkExpressions(strings(job.raw.strategy), job.line, `${where} strategy`, refusals, { runtime: false });
    checkExpressions(strings(job.raw["timeout-minutes"]), job.line, `${where} timeout-minutes`, refusals, { runtime: false });
    checkExpressions(strings(job.raw.defaults), job.line, `${where} defaults`, refusals, { runtime: false });
    if (job.raw.if !== undefined) checkExpressions([String(job.raw.if)], job.line, `${where} if`, refusals, { runtime: false, bare: true });
    checkExpressions(strings(job.raw.outputs), job.line, `${where} outputs`, refusals, { runtime: true });
    if (!Array.isArray(job.raw.steps) || job.steps.length === 0) refusals.push(at("no steps"));
    let checkedOut = false;
    for (const step of job.steps) {
      const stepAt = (what: string) => ({ line: step.line, what: `job ${job.id}, step ${step.index + 1}: ${what}` });
      const swhere = `job ${job.id}, step ${step.index + 1}`;
      for (const key of Object.keys(step.raw)) if (!STEP_KEYS.has(key)) refusals.push(stepAt(`${key} is not supported by outrun run v1`));
      const run = step.raw.run;
      const used = step.raw.uses;
      if ((run === undefined) === (used === undefined)) refusals.push(stepAt("a step has exactly one of run and uses"));
      if (used !== undefined) {
        if (typeof used !== "string" || !CHECKOUT.test(used)) refusals.push(stepAt(`uses: ${String(used)}: v1 runs run: steps and actions/checkout only`));
        else {
          const withs = isObject(step.raw.with) ? step.raw.with : {};
          for (const [key, value] of Object.entries(withs)) {
            if (!CHECKOUT_INPUTS.has(key)) refusals.push(stepAt(`actions/checkout's ${key} is not supported by outrun run v1`));
            const text = String(value ?? "");
            if (key === "path" && !["", "."].includes(text)) refusals.push(stepAt("actions/checkout's path: v1 checks out at the workspace only"));
            if (key === "repository" && text.toLowerCase() !== repo.toLowerCase() && text.replace(/\s+/g, "") !== `\${{github.repository}}`)
              refusals.push(stepAt(`actions/checkout of another repository (${text}) is not supported by outrun run v1`));
            if (key === "ref" && text !== "") refusals.push(stepAt("actions/checkout's ref: a local run checks out its own tree only"));
          }
          checkExpressions(strings(step.raw.with), step.line, `${swhere} with`, refusals, { runtime: false });
          checkedOut = true;
        }
      } else if (!checkedOut && job.steps.some((other) => typeof other.raw.uses === "string"))
        // A job without a checkout runs in an empty workspace (job-script.ts), as on GitHub.
        refusals.push(stepAt("a step before actions/checkout: v1 runs jobs on the repository's checkout"));
      if (step.raw.with !== undefined && used === undefined) refusals.push(stepAt("with: without uses"));
      if (run !== undefined && (run === null || typeof run === "object")) refusals.push(stepAt("run is not a string"));
      if (typeof run === "string") checkExpressions([run], step.line, `${swhere} run`, refusals, { runtime: true });
      checkExpressions(strings(step.raw.env), step.line, `${swhere} env`, refusals, { runtime: true });
      for (const key of ["shell", "working-directory", "timeout-minutes", "continue-on-error", "name"])
        checkExpressions(strings(step.raw[key]), step.line, `${swhere} ${key}`, refusals, { runtime: false });
      if (step.raw.if !== undefined)
        checkExpressions([String(step.raw.if)], step.line, `${swhere} if`, refusals, { runtime: true, bare: true, condition: true });
      const shell = step.raw.shell;
      if (typeof shell === "string" && !shellCommand(shell)) refusals.push(stepAt(`shell ${shell} is not supported by outrun run v1`));
    }
  }
  return refusals;
};

/** A step's shell as GitHub's runner runs it on Linux; null when outrun run v1 does not. */
export const shellCommand = (shell: string | undefined): string | null => {
  if (shell === undefined || shell === "") return "bash -e {0}";
  if (shell === "bash") return "bash --noprofile --norc -eo pipefail {0}";
  if (shell === "sh") return "sh -e {0}";
  if (shell === "python") return "python {0}";
  if (shell.includes("{0}")) return shell;
  return null;
};

// The inputs a `workflow_dispatch` declares, from `-f key=value`: typed, defaulted, required and choices checked.
export const dispatchInputs = (workflow: Workflow, given: Readonly<Record<string, string>>): { inputs: Record<string, Value> } | { refusals: Refusal[] } => {
  const declared =
    isObject(workflow.raw.on) && isObject(workflow.raw.on.workflow_dispatch) && isObject(workflow.raw.on.workflow_dispatch.inputs)
      ? workflow.raw.on.workflow_dispatch.inputs
      : {};
  const refusals: Refusal[] = [];
  const inputs: Record<string, Value> = {};
  for (const name of Object.keys(given))
    if (!(name in declared)) refusals.push({ line: 1, what: `-f ${name}: the workflow's workflow_dispatch declares no input ${name}` });
  for (const [name, spec] of Object.entries(declared)) {
    const input = isObject(spec) ? spec : {};
    const type = typeof input.type === "string" ? input.type : "string";
    const raw = given[name] ?? (input.default === undefined ? undefined : String(input.default));
    if (raw === undefined) {
      if (input.required === true) refusals.push({ line: 1, what: `input ${name} is required (-f ${name}=…)` });
      inputs[name] = type === "boolean" ? false : "";
      continue;
    }
    if (type === "boolean") {
      if (raw !== "true" && raw !== "false") refusals.push({ line: 1, what: `input ${name} is a boolean: true or false, not ${raw}` });
      inputs[name] = raw === "true";
    } else if (type === "number") {
      if (Number.isNaN(Number(raw))) refusals.push({ line: 1, what: `input ${name} is a number, not ${raw}` });
      inputs[name] = Number(raw);
    } else {
      if (type === "choice" && Array.isArray(input.options) && !input.options.map(String).includes(raw))
        refusals.push({ line: 1, what: `input ${name} is one of ${input.options.join(", ")}, not ${raw}` });
      inputs[name] = raw;
    }
  }
  return refusals.length > 0 ? { refusals } : { inputs };
};

export type Combination = Readonly<Record<string, Value>>;

/** A matrix's combinations, as GitHub expands them: the product of its keys, `exclude`, then `include`. */
export const expandMatrix = (matrix: Value): Combination[] | string => {
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix)) return "strategy.matrix is not a mapping";
  const object = matrix as Record<string, Value>;
  const keys = Object.keys(object).filter((k) => k !== "include" && k !== "exclude");
  let combos: Record<string, Value>[] = keys.length > 0 ? [{}] : [];
  for (const key of keys) {
    const values = object[key];
    if (!Array.isArray(values)) return `strategy.matrix.${key} is not a list`;
    combos = combos.flatMap((c) => values.map((v: Value) => ({ ...c, [key]: v })));
  }
  const matches = (combo: Record<string, Value>, partial: Record<string, Value>) =>
    Object.entries(partial).every(([k, v]) => JSON.stringify(combo[k]) === JSON.stringify(v));
  const exclude = object.exclude;
  if (exclude !== undefined && !Array.isArray(exclude)) return "strategy.matrix.exclude is not a list";
  for (const e of (exclude ?? []) as Value[])
    if (e && typeof e === "object" && !Array.isArray(e)) combos = combos.filter((c) => !matches(c, e as Record<string, Value>));
  const include = object.include;
  if (include !== undefined && !Array.isArray(include)) return "strategy.matrix.include is not a list";
  const original = new Set(keys);
  const base = combos.map((c) => ({ ...c }));
  const out = base.map((c) => ({ ...c }));
  for (const inc of (include ?? []) as Value[]) {
    if (!inc || typeof inc !== "object" || Array.isArray(inc)) return "strategy.matrix.include has an item that is not a mapping";
    const entry = inc as Record<string, Value>;
    // With no keys, each include is its own combination: GitHub never merges two includes.
    if (keys.length === 0) {
      out.push({ ...entry });
      continue;
    }
    let added = false;
    out.forEach((combo, i) => {
      // Only the product's combinations take an include, never one an earlier include added.
      const fits = i < base.length && Object.entries(entry).every(([k, v]) => !original.has(k) || JSON.stringify(base[i]![k]) === JSON.stringify(v));
      if (fits) {
        Object.assign(combo, entry);
        added = true;
      }
    });
    if (!added) out.push({ ...entry });
  }
  return out;
};

// A job's name for one combination, as GitHub shows it.
export const cellName = (job: Job, combo: Combination | null, scope: Scope) => {
  const named = job.raw.name;
  if (typeof named === "string") {
    try {
      return String(interpolate(named, scope));
    } catch {
      return named;
    }
  }
  if (!combo || Object.keys(combo).length === 0) return job.id;
  const values = Object.values(combo).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)));
  return `${job.id} (${values.join(", ")})`;
};

/** A job-level `if:`, with the status of its needs. */
