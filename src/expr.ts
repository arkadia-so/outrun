// GitHub Actions expressions (`${{ … }}`), as GitHub evaluates them: literals, contexts, the
// operators and the functions of docs.github.com "Evaluate expressions in workflows and actions",
// loose equality with GitHub's coercion, case-insensitive string comparison and property names.
// Used by `outrun run` (run.ts) to evaluate a workflow's expressions before a job runs; a context
// only known while the job runs (`steps`, `env`) is a `Runtime` reference the job's script reads
// itself (job-script.ts). Anything outside this subset is an `ExprError`: the run is refused, never
// approximated (outrun/README.md "outrun run").

export type Value = null | boolean | number | string | readonly Value[] | { readonly [key: string]: Value };

export type Node =
  | { readonly kind: "literal"; readonly value: Value }
  | { readonly kind: "context"; readonly name: string }
  | { readonly kind: "index"; readonly target: Node; readonly key: Node }
  | { readonly kind: "star"; readonly target: Node }
  | { readonly kind: "not"; readonly operand: Node }
  | { readonly kind: "binary"; readonly op: "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">="; readonly left: Node; readonly right: Node }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly Node[] };

/** An expression outside the supported subset, or malformed. */
export class ExprError extends Error {}
/** A reference to a context only the running job knows (`steps`, `env`): the script resolves it. */
class Runtime extends Error {
  constructor(readonly root: string) {
    super(`${root} is only known while the job runs`);
  }
}

const FUNCTIONS = new Set(["contains", "startswith", "endswith", "format", "join", "tojson", "fromjson", "success", "failure", "always", "cancelled"]);
const STATUS_FUNCTIONS = new Set(["success", "failure", "always", "cancelled"]);

type Token = { readonly t: "op" | "num" | "str" | "id"; readonly v: string };

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("()[].,!<>*".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= text.length) throw new ExprError(`unterminated string in "${text}"`);
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += text[i];
        i++;
      }
      tokens.push({ t: "str", v: s });
      continue;
    }
    const num = /^(?:0x[0-9a-fA-F]+|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (num && (c !== "-" || tokens.length === 0 || tokens.at(-1)!.t === "op")) {
      tokens.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i));
    if (id) {
      tokens.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new ExprError(`unexpected "${c}" in "${text}"`);
  }
  return tokens;
};

/** Parses one expression (the text inside `${{ }}`, or an `if:` without them). */
export const parse = (text: string): Node => {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const eat = (v: string) => {
    if (peek()?.t === "op" && peek()?.v === v) {
      at++;
      return true;
    }
    return false;
  };
  const expect = (v: string) => {
    if (!eat(v)) throw new ExprError(`expected "${v}" in "${text}"`);
  };
  const or = (): Node => {
    let left = and();
    while (eat("||")) left = { kind: "binary", op: "||", left, right: and() };
    return left;
  };
  const and = (): Node => {
    let left = equality();
    while (eat("&&")) left = { kind: "binary", op: "&&", left, right: equality() };
    return left;
  };
  const equality = (): Node => {
    let left = comparison();
    for (;;) {
      const op = peek();
      if (op?.t === "op" && (op.v === "==" || op.v === "!=")) {
        at++;
        left = { kind: "binary", op: op.v, left, right: comparison() };
      } else return left;
    }
  };
  const comparison = (): Node => {
    let left = unary();
    for (;;) {
      const op = peek();
      if (op?.t === "op" && ["<", "<=", ">", ">="].includes(op.v)) {
        at++;
        left = { kind: "binary", op: op.v as "<", left, right: unary() };
      } else return left;
    }
  };
  const unary = (): Node => (eat("!") ? { kind: "not", operand: unary() } : postfix());
  const postfix = (): Node => {
    let node = primary();
    for (;;) {
      if (eat(".")) {
        if (eat("*")) {
          node = { kind: "star", target: node };
          continue;
        }
        const name = tokens[at++];
        if (name?.t !== "id") throw new ExprError(`expected a property name in "${text}"`);
        node = { kind: "index", target: node, key: { kind: "literal", value: name.v } };
      } else if (eat("[")) {
        if (eat("*")) {
          expect("]");
          node = { kind: "star", target: node };
          continue;
        }
        node = { kind: "index", target: node, key: or() };
        expect("]");
      } else return node;
    }
  };
  const primary = (): Node => {
    const token = tokens[at++];
    if (!token) throw new ExprError(`unexpected end of "${text}"`);
    if (token.t === "op" && token.v === "(") {
      const inner = or();
      expect(")");
      return inner;
    }
    if (token.t === "str") return { kind: "literal", value: token.v };
    if (token.t === "num") return { kind: "literal", value: Number(token.v) };
    if (token.t === "id") {
      const lower = token.v.toLowerCase();
      if (lower === "true" || lower === "false") return { kind: "literal", value: lower === "true" };
      if (lower === "null") return { kind: "literal", value: null };
      if (eat("(")) {
        if (!FUNCTIONS.has(lower)) throw new ExprError(`the function ${token.v}() is not supported by outrun run v1`);
        const args: Node[] = [];
        if (!eat(")")) {
          do args.push(or());
          while (eat(","));
          expect(")");
        }
        return { kind: "call", name: lower, args };
      }
      return { kind: "context", name: lower };
    }
    throw new ExprError(`unexpected "${token.v}" in "${text}"`);
  };
  const node = or();
  if (at !== tokens.length) throw new ExprError(`unexpected "${tokens[at]!.v}" in "${text}"`);
  return node;
};

// The contexts an expression reads (their roots, lower case) and the functions it calls.
export const uses = (node: Node, into = { contexts: new Set<string>(), functions: new Set<string>() }) => {
  switch (node.kind) {
    case "context":
      into.contexts.add(node.name);
      break;
    case "index":
      uses(node.target, into);
      uses(node.key, into);
      break;
    case "star":
      uses(node.target, into);
      break;
    case "not":
      uses(node.operand, into);
      break;
    case "binary":
      uses(node.left, into);
      uses(node.right, into);
      break;
    case "call":
      into.functions.add(node.name);
      for (const arg of node.args) uses(arg, into);
      break;
    case "literal":
      break;
  }
  return into;
};

// A path of literal property names from a context (`steps.plan.outputs.x` → [steps, plan, outputs, x]), else null.
export const pathOf = (node: Node): string[] | null => {
  if (node.kind === "context") return [node.name];
  if (node.kind === "index" && node.key.kind === "literal" && typeof node.key.value === "string") {
    const head = pathOf(node.target);
    return head ? [...head, node.key.value] : null;
  }
  return null;
};

export const truthy = (v: Value) => !(v === null || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));

const toNumber = (v: Value): number => {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return 0;
    return /^0x[0-9a-f]+$/i.test(t) ? Number.parseInt(t, 16) : Number(t);
  }
  return Number.NaN;
};

/** A value as GitHub writes it into a string (`${{ }}` in a template). */
export const toText = (v: Value): string => {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return Array.isArray(v) ? "Array" : "Object";
};

const equal = (a: Value, b: Value): boolean => {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  const objectish = (v: Value) => v !== null && typeof v === "object";
  if (objectish(a) || objectish(b)) return a === b;
  if (typeof a === typeof b) return a === b;
  return toNumber(a) === toNumber(b);
};

const compare = (a: Value, b: Value): number | null => {
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return x < y ? -1 : x > y ? 1 : 0;
};

const property = (target: Value, key: Value): Value => {
  if (target === null || typeof target !== "object") return null;
  if (Array.isArray(target)) {
    const i = toNumber(key);
    return Number.isInteger(i) && i >= 0 && i < target.length ? (target[i] ?? null) : null;
  }
  const name = toText(key).toLowerCase();
  const object = target as { readonly [key: string]: Value };
  for (const k of Object.keys(object)) if (k.toLowerCase() === name) return object[k] ?? null;
  return null;
};

export interface Scope {
  // The contexts known now, by lower-case name.
  readonly contexts: Readonly<Record<string, Value>>;
  // The contexts only the running job knows: reading one throws `Runtime`.
  readonly runtime?: ReadonlySet<string>;
  // The job's status for the status functions (job level: from its needs, "skipped" when one was
  // skipped: neither success() nor failure(); step level: so far).
  readonly status?: "success" | "failure" | "skipped";
}

export const evaluate = (node: Node, scope: Scope): Value => {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "context": {
      if (scope.runtime?.has(node.name)) throw new Runtime(node.name);
      if (!(node.name in scope.contexts)) throw new ExprError(`the context "${node.name}" is not available here`);
      return scope.contexts[node.name] ?? null;
    }
    case "index":
      return property(evaluate(node.target, scope), evaluate(node.key, scope));
    case "star": {
      const target = evaluate(node.target, scope);
      if (target === null || typeof target !== "object") return [];
      return Array.isArray(target) ? target : Object.values(target);
    }
    case "not":
      return !truthy(evaluate(node.operand, scope));
    case "binary": {
      const left = evaluate(node.left, scope);
      if (node.op === "&&") return truthy(left) ? evaluate(node.right, scope) : left;
      if (node.op === "||") return truthy(left) ? left : evaluate(node.right, scope);
      const right = evaluate(node.right, scope);
      if (node.op === "==") return equal(left, right);
      if (node.op === "!=") return !equal(left, right);
      const order = compare(left, right);
      if (order === null) return false;
      return node.op === "<" ? order < 0 : node.op === "<=" ? order <= 0 : node.op === ">" ? order > 0 : order >= 0;
    }
    case "call":
      return call(node.name, node.args, scope);
  }
};

const call = (name: string, args: readonly Node[], scope: Scope): Value => {
  const arity = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw new ExprError(`${name}() takes ${min === max ? min : `${min} to ${max}`} argument(s)`);
  };
  const status = scope.status ?? "success";
  switch (name) {
    case "success":
      arity(0);
      return status === "success";
    case "failure":
      arity(0);
      return status === "failure";
    case "always":
      arity(0);
      return true;
    // A local run is never cancelled while a step decides whether to run (v1: no cancel).
    case "cancelled":
      arity(0);
      return false;
  }
  const values = args.map((arg) => evaluate(arg, scope));
  switch (name) {
    case "contains": {
      arity(2);
      const [search, item] = values as [Value, Value];
      if (Array.isArray(search)) return search.some((v: Value) => equal(v, item));
      return toText(search).toLowerCase().includes(toText(item).toLowerCase());
    }
    case "startswith":
      arity(2);
      return toText(values[0]!).toLowerCase().startsWith(toText(values[1]!).toLowerCase());
    case "endswith":
      arity(2);
      return toText(values[0]!).toLowerCase().endsWith(toText(values[1]!).toLowerCase());
    case "format": {
      if (values.length < 1) throw new ExprError("format() takes a format string");
      const [fmt, ...rest] = values;
      return toText(fmt!).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, i: string | undefined) => {
        if (m === "{{") return "{";
        if (m === "}}") return "}";
        const v = rest[Number(i)];
        if (v === undefined) throw new ExprError(`format(): no argument {${i}}`);
        return toText(v);
      });
    }
    case "join": {
      arity(1, 2);
      const sep = values.length > 1 ? toText(values[1]!) : ",";
      const v = values[0]!;
      return Array.isArray(v) ? v.map((x: Value) => toText(x)).join(sep) : toText(v);
    }
    case "tojson":
      arity(1);
      return JSON.stringify(values[0], null, 2);
    case "fromjson": {
      arity(1);
      try {
        return JSON.parse(toText(values[0]!)) as Value;
      } catch {
        throw new ExprError(`fromJSON(): not JSON: ${toText(values[0]!).slice(0, 200)}`);
      }
    }
  }
  throw new ExprError(`the function ${name}() is not supported by outrun run v1`);
};

// A string's `${{ }}` parts: literal text and expressions, in order.
export type Part = { readonly text: string } | { readonly expr: Node; readonly source: string };
export const template = (text: string): Part[] => {
  const parts: Part[] = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf("${{");
    if (open < 0) {
      if (rest) parts.push({ text: rest });
      return parts;
    }
    if (open > 0) parts.push({ text: rest.slice(0, open) });
    // The closing braces outside a string literal.
    let i = open + 3;
    let inString = false;
    for (; i < rest.length; i++) {
      if (rest[i] === "'") inString = !inString;
      else if (!inString && rest.startsWith("}}", i)) break;
    }
    if (i >= rest.length) throw new ExprError(`unterminated \${{ in "${text.slice(0, 200)}"`);
    const source = rest.slice(open + 3, i).trim();
    parts.push({ expr: parse(source), source });
    rest = rest.slice(i + 2);
  }
};

/** A string with its expressions evaluated: the value itself when the string is one expression. */
export const interpolate = (text: string, scope: Scope): Value => {
  const parts = template(text);
  if (parts.length === 1 && "expr" in parts[0]! && text.trim().startsWith("${{") && text.trim().endsWith("}}")) return evaluate(parts[0].expr, scope);
  return parts.map((part) => ("expr" in part ? toText(evaluate(part.expr, scope)) : part.text)).join("");
};

/** An `if:` condition: with or without `${{ }}`; one without a status function is `success() && (…)`. */
export const condition = (text: string | boolean | number | null | undefined): Node => {
  if (text === undefined || text === null || (typeof text === "string" && text.trim() === "")) return { kind: "call", name: "success", args: [] };
  if (typeof text !== "string") return { kind: "literal", value: text };
  const trimmed = text.trim();
  const inner = trimmed.startsWith("${{") && trimmed.endsWith("}}") && trimmed.indexOf("${{", 3) < 0 ? trimmed.slice(3, -2) : trimmed;
  const node = parse(inner);
  const { functions } = uses(node);
  return [...functions].some((f) => STATUS_FUNCTIONS.has(f))
    ? node
    : { kind: "binary", op: "&&", left: { kind: "call", name: "success", args: [] }, right: node };
};
