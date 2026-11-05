// Key source `imports`: a unit's import closure, over the files git tracks. Each code file's
// imports are read once per content (Bun's transpiler, type-only imports dropped: a test runner
// does not type-check, so a type cannot change a verdict) and resolved like Bun: relative paths,
// tsconfig `paths`, package.json `imports`, and the workspace's own packages through their
// `exports` (every condition's target, since which one a run loads depends on its flags). A
// package outside the workspace is the lockfile's (a global input); an import that does not
// resolve makes the unit depend on the whole package it is in, never on nothing.
//
// A test also loads code it does not import: it spawns `bun ../src/index.ts`, reads a fixture.
// So a string literal that is a relative path (`"./x"`, `"../x"`) counts too: a tracked file it
// names is a dependency (with its own closure), a tracked folder all its files. A literal naming
// nothing tracked is only a string. What a test builds from several pieces is the tracer's.
import { posix } from "node:path";
import type { Blobs } from "../git.ts";

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const JS_TO_TS: Record<string, readonly string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

/** How a file's imports are read: its specifiers, or undefined when it cannot be parsed. */
export type Scan = (path: string, blob: string) => readonly string[] | undefined;
/** Reads a tracked file's text (package.json, tsconfig.json). */
export type Read = (path: string) => string | undefined;

interface PackageJson {
  readonly name?: string;
  readonly exports?: unknown;
  readonly imports?: Record<string, unknown>;
  readonly main?: string;
  readonly module?: string;
  readonly workspaces?: readonly string[] | { readonly packages?: readonly string[] };
}

const parseJson = <T>(text: string | undefined): T | undefined => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    // tsconfig.json is JSON with comments and trailing commas.
    try {
      const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s: string | undefined) => s ?? "").replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(stripped) as T;
    } catch {
      return undefined;
    }
  }
};

/** Every string a package.json `exports`/`imports` value can lead to, whatever the conditions. */
const targets = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(targets);
  if (value && typeof value === "object") return Object.values(value).flatMap(targets);
  return [];
};

/** Pure: the targets of `subpath` in a map of patterns (`./x`, `./*`, `#y/*`), or undefined. */
export const matchPattern = (map: Record<string, unknown>, subpath: string): string[] | undefined => {
  if (subpath in map) return targets(map[subpath]);
  let best: { key: string; rest: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1)
      if (!best || prefix.length > best.key.indexOf("*")) best = { key, rest: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  if (!best) return undefined;
  const rest = best.rest;
  return targets(map[best.key]).map((t) => t.replaceAll("*", rest));
};

const splitBare = (spec: string): [string, string] => {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const rest = parts.slice(n).join("/");
  return [parts.slice(0, n).join("/"), rest ? `./${rest}` : "."];
};

export interface Edge {
  /** Files this file depends on directly. */
  readonly files: readonly string[];
  /** Package folders it depends on wholly (an import that did not resolve). */
  readonly wholes: readonly string[];
}

export class ImportGraph {
  readonly #blobs: Blobs;
  readonly #scan: Scan;
  readonly #read: Read;
  readonly #packageDirs: Set<string>;
  readonly #workspace = new Map<string, string>();
  readonly #edges = new Map<string, Edge>();
  readonly #tsconfigs = new Map<string, { dir: string; paths: Record<string, unknown> } | null>();
  readonly #manifests = new Map<string, PackageJson | undefined>();
  readonly #byDir = new Map<string, string[]>();

  constructor(blobs: Blobs, scan: Scan, read: Read) {
    this.#blobs = blobs;
    this.#scan = scan;
    this.#read = read;
    this.#packageDirs = new Set();
    for (const path of blobs.keys()) if (path === "package.json" || path.endsWith("/package.json")) this.#packageDirs.add(posix.dirname(path));
    const root = this.manifest(".");
    const globs = Array.isArray(root?.workspaces) ? root.workspaces : ((root?.workspaces as { packages?: readonly string[] } | undefined)?.packages ?? []);
    const matchers = globs.map((g) => new Bun.Glob(g.replace(/\/$/, "")));
    for (const dir of this.#packageDirs) {
      if (dir === "." || !matchers.some((m) => m.match(dir))) continue;
      const name = this.manifest(dir)?.name;
      if (name) this.#workspace.set(name, dir);
    }
  }

  manifest(dir: string): PackageJson | undefined {
    if (!this.#manifests.has(dir)) this.#manifests.set(dir, parseJson<PackageJson>(this.#read(dir === "." ? "package.json" : `${dir}/package.json`)));
    return this.#manifests.get(dir);
  }

  /** The folder of the package holding `path`: the nearest folder with a package.json. */
  packageOf(path: string): string {
    let dir = posix.dirname(path);
    while (dir !== "." && !this.#packageDirs.has(dir)) dir = posix.dirname(dir);
    return dir;
  }

  /** Every tracked file under `dir` (the whole package, when an import does not resolve). */
  filesUnder(dir: string): readonly string[] {
    let files = this.#byDir.get(dir);
    if (!files) {
      const prefix = dir === "." ? "" : `${dir}/`;
      files = [...this.#blobs.keys()].filter((p) => p.startsWith(prefix) && !p.includes("/node_modules/"));
      this.#byDir.set(dir, files);
    }
    return files;
  }

  #probe(base: string): string | undefined {
    if (base.startsWith("../") || base === "..") return undefined;
    if (this.#blobs.has(base) && !this.#packageDirs.has(base)) return base;
    const ext = posix.extname(base);
    for (const ts of JS_TO_TS[ext] ?? []) {
      const swapped = base.slice(0, -ext.length) + ts;
      if (this.#blobs.has(swapped)) return swapped;
    }
    for (const e of EXTENSIONS) if (this.#blobs.has(base + e)) return base + e;
    for (const e of EXTENSIONS) if (this.#blobs.has(`${base}/index${e}`)) return `${base}/index${e}`;
    if (this.#packageDirs.has(base)) return this.#packageEntry(base, ".")?.[0];
    return undefined;
  }

  #tsconfig(dir: string): { dir: string; paths: Record<string, unknown> } | null {
    const cached = this.#tsconfigs.get(dir);
    if (cached !== undefined) return cached;
    const path = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
    let found: { dir: string; paths: Record<string, unknown> } | null = null;
    if (this.#blobs.has(path)) {
      const options = parseJson<{ compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: string } }>(this.#read(path))?.compilerOptions;
      if (options?.paths) found = { dir: posix.join(dir, options.baseUrl ?? "."), paths: options.paths };
    }
    if (!found && dir !== ".") found = this.#tsconfig(posix.dirname(dir));
    this.#tsconfigs.set(dir, found);
    return found;
  }

  /** The files `subpath` of the package in `dir` resolves to (every condition), or undefined. */
  #packageEntry(dir: string, subpath: string): string[] | undefined {
    const manifest = this.manifest(dir);
    const exports = manifest?.exports;
    let candidates: string[] | undefined;
    if (exports !== undefined) {
      const isMap = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith("."));
      candidates = isMap ? matchPattern(exports as Record<string, unknown>, subpath) : subpath === "." ? targets(exports) : undefined;
    } else if (subpath === ".") candidates = [manifest?.module ?? manifest?.main ?? "./index"].filter((x): x is string => !!x);
    else candidates = [subpath];
    if (!candidates) return undefined;
    const files = candidates
      .filter((t) => t.startsWith("./") || !t.startsWith("."))
      .map((t) => this.#probe(posix.join(dir, t)))
      .filter((f): f is string => !!f);
    return files.length > 0 ? [...new Set(files)] : undefined;
  }

  /** Resolves one specifier of `from`: files, `whole` (depend on its package), or [] (outside: lockfile). */
  resolve(spec: string, from: string): { files: string[]; whole?: string } {
    const dir = posix.dirname(from);
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      const file = this.#probe(posix.normalize(posix.join(dir, spec.split("?")[0] ?? spec)));
      return file ? { files: [file] } : { files: [], whole: this.packageOf(from) };
    }
    if (spec.startsWith("/") || spec.includes(":")) return { files: [] };
    if (spec.startsWith("#")) {
      const pkg = this.packageOf(from);
      const mapped = matchPattern(this.manifest(pkg)?.imports ?? {}, spec);
      if (!mapped) return { files: [], whole: pkg };
      const files: string[] = [];
      for (const target of mapped) {
        if (target.startsWith("./")) {
          const file = this.#probe(posix.join(pkg, target));
          if (file) files.push(file);
        } else files.push(...this.resolve(target, from).files);
      }
      return files.length > 0 ? { files } : { files: [], whole: pkg };
    }
    const tsconfig = this.#tsconfig(dir);
    if (tsconfig) {
      const mapped = matchPattern(tsconfig.paths, spec);
      if (mapped) {
        const files = mapped.map((t) => this.#probe(posix.normalize(posix.join(tsconfig.dir, t)))).filter((f): f is string => !!f);
        if (files.length > 0) return { files };
      }
    }
    const [name, subpath] = splitBare(spec);
    const pkgDir = this.#workspace.get(name);
    if (pkgDir === undefined) return { files: [] };
    const files = this.#packageEntry(pkgDir, subpath);
    return files ? { files } : { files: [], whole: pkgDir };
  }

  edge(path: string): Edge {
    let edge = this.#edges.get(path);
    if (edge) return edge;
    const blob = this.#blobs.get(path);
    const specs = blob && CODE.test(path) ? this.#scan(path, blob) : [];
    if (specs === undefined) edge = { files: [], wholes: [this.packageOf(path)] };
    else {
      const files = new Set<string>();
      const wholes = new Set<string>();
      for (const spec of specs) {
        if (spec.startsWith(LITERAL)) {
          const target = posix.normalize(posix.join(posix.dirname(path), spec.slice(LITERAL.length))).replace(/\/$/, "");
          if (target.startsWith("..")) continue;
          if (this.#blobs.has(target)) files.add(target);
          else if (target === "." || this.filesUnder(target).length > 0) wholes.add(target);
          continue;
        }
        const resolved = this.resolve(spec, path);
        for (const f of resolved.files) files.add(f);
        if (resolved.whole !== undefined) wholes.add(resolved.whole);
      }
      edge = { files: [...files], wholes: [...wholes] };
    }
    this.#edges.set(path, edge);
    return edge;
  }

  /** Every file the roots load, themselves included, and the packages depended on wholly. */
  closure(roots: readonly string[]): { files: Set<string>; wholes: Set<string> } {
    const files = new Set<string>();
    const wholes = new Set<string>();
    const stack = roots.filter((r) => this.#blobs.has(r));
    while (stack.length > 0) {
      const path = stack.pop() as string;
      if (files.has(path)) continue;
      files.add(path);
      const edge = this.edge(path);
      for (const w of edge.wholes) wholes.add(w);
      for (const f of edge.files) if (!files.has(f)) stack.push(f);
    }
    return { files, wholes };
  }
}

const transpilers = new Map<string, Bun.Transpiler>();
const loaderOf = (path: string): "ts" | "tsx" | "js" | "jsx" =>
  /\.tsx$/.test(path) ? "tsx" : /\.(?:ts|mts|cts)$/.test(path) ? "ts" : /\.jsx$/.test(path) ? "jsx" : "js";

/** Reads specifiers with Bun's transpiler (type-only imports dropped). */
export const scanSource = (text: string, path: string): string[] | undefined => {
  const loader = loaderOf(path);
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader });
    transpilers.set(loader, transpiler);
  }
  try {
    const specs = transpiler.scanImports(text).map((i) => i.path);
    const imported = new Set(specs);
    for (const m of text.matchAll(RELATIVE_LITERAL)) {
      const literal = m[2] as string;
      if (!imported.has(literal)) specs.push(`${LITERAL}${literal}`);
    }
    return specs;
  } catch {
    return undefined;
  }
};

/** Marks a relative path found in a string literal, not an import. */
const LITERAL = "literal:";
const RELATIVE_LITERAL = /(["'`])(\.\.?\/[^"'`\s$]*)\1/g;
