import { describe, expect, it } from "vitest";
import { e2eEnvLines } from "./e2e-env.ts";

describe("outrun e2e-env", () => {
  it("gives the tests the caller's variables and the secrets it named, nothing else", () => {
    const lines = e2eEnvLines("ACME_URL=https://a.example.com/?x=1\n\n", "ACME_TOKEN", JSON.stringify({ ACME_TOKEN: "t0k", OTHER: "no" }), "EOF_1");
    expect(lines).toBe("ACME_URL<<EOF_1\nhttps://a.example.com/?x=1\nEOF_1\nACME_TOKEN<<EOF_1\nt0k\nEOF_1\n");
  });

  it("refuses a secret that did not reach the workflow, and a line that is not NAME=value", () => {
    expect(e2eEnvLines("", "MISSING", "{}", "E")).toMatchObject({ _tag: "UsageInvalid" });
    expect(e2eEnvLines("not a pair", "", "", "E")).toMatchObject({ _tag: "UsageInvalid" });
    expect(e2eEnvLines("", "", "", "E")).toBe("");
  });
});
