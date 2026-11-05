// Pure: per-file results from a JUnit XML report whose top-level <testsuite> elements are files
// (bun test's `--reporter=junit`: `file` is relative to the folder the run started in).

export interface FileResult {
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
  readonly durationMs: number;
}

const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1];
};

const unescape = (text: string) => text.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e] ?? _);

export const parseJunit = (xml: string): Map<string, FileResult> => {
  const out = new Map<string, FileResult>();
  const tokens = /<(\/?)(testsuite|failure|error)\b([^>]*?)(\/?)>/g;
  let depth = 0;
  let current: { file: string; tests: number; failures: number; skipped: number; durationMs: number; failed: boolean } | undefined;
  for (let m = tokens.exec(xml); m; m = tokens.exec(xml)) {
    const [, closing, name, attrs = "", selfClosing] = m;
    if (name !== "testsuite") {
      if (!closing && current) current.failed = true;
      continue;
    }
    if (closing) {
      depth--;
      if (depth === 0 && current) {
        out.set(current.file, {
          tests: current.tests,
          failures: Math.max(current.failures, current.failed ? 1 : 0),
          skipped: current.skipped,
          durationMs: current.durationMs,
        });
        current = undefined;
      }
      continue;
    }
    if (depth === 0) {
      const file = attribute(attrs, "file") ?? attribute(attrs, "name");
      if (file)
        current = {
          file: unescape(file),
          tests: Number(attribute(attrs, "tests") ?? 0),
          failures: Number(attribute(attrs, "failures") ?? 0) + Number(attribute(attrs, "errors") ?? 0),
          skipped: Number(attribute(attrs, "skipped") ?? 0),
          durationMs: Number(attribute(attrs, "time") ?? 0) * 1000,
          failed: false,
        };
    }
    if (selfClosing) {
      if (depth === 0 && current) {
        out.set(current.file, { tests: current.tests, failures: current.failures, skipped: current.skipped, durationMs: current.durationMs });
        current = undefined;
      }
      continue;
    }
    depth++;
  }
  return out;
};

/**
 * Pure: per-file results from a JUnit report whose files are named on each <testcase> (pytest's
 * `junit_family=xunit1`: a `file` attribute, relative to the folder the run started in), whatever
 * its <testsuite> elements are.
 */
/** Per-file results from a report's test cases, each naming its file in `file` (or in `name`, for a runner whose tests are files). */
export const parseJunitCases = (xml: string, by: "file" | "name" = "file"): Map<string, FileResult> => {
  const out = new Map<string, { tests: number; failures: number; skipped: number; durationMs: number }>();
  const tokens = /<(\/?)(testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g;
  let current: { tests: number; failures: number; skipped: number; durationMs: number } | undefined;
  let open = false;
  let marked = { failed: false, skipped: false };
  const close = () => {
    if (current) {
      if (marked.failed) current.failures++;
      else if (marked.skipped) current.skipped++;
    }
    current = undefined;
    open = false;
  };
  for (let m = tokens.exec(xml); m; m = tokens.exec(xml)) {
    const [, closing, name, attrs = "", selfClosing] = m;
    if (name === "testcase") {
      if (closing) {
        close();
        continue;
      }
      if (open) close();
      const file = attribute(attrs, by);
      if (!file) continue;
      const key = unescape(file);
      const entry = out.get(key) ?? { tests: 0, failures: 0, skipped: 0, durationMs: 0 };
      entry.tests++;
      entry.durationMs += Number(attribute(attrs, "time") ?? 0) * 1000;
      out.set(key, entry);
      current = entry;
      marked = { failed: false, skipped: false };
      open = !selfClosing;
      if (selfClosing) close();
      continue;
    }
    if (closing || !open) continue;
    if (name === "skipped") marked.skipped = true;
    else marked.failed = true;
  }
  return out;
};
