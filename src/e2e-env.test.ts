import { describe, expect, it } from "vitest";
import { e2eEnvLines } from "./e2e-env.ts";

describe("outrun e2e-env", () => {
  it("gives the tests the caller's variables and the secrets it named, nothing else", () => {
    const env = e2eEnvLines("ACME_URL=https://a.example.com/?x=1\n\n", "ACME_TOKEN", JSON.stringify({ ACME_TOKEN: "t0k", OTHER: "no" }), "EOF_1");
    expect(env).toEqual({ lines: "ACME_URL<<EOF_1\nhttps://a.example.com/?x=1\nEOF_1\nACME_TOKEN<<EOF_1\nt0k\nEOF_1\n", masks: ["t0k"] });
  });

  it("gives the tests the NAME=value lines of the env secret, each value masked, for a caller secrets: inherit does not reach", () => {
    const secret = "ACME_MODEL_TOKEN=m0d=el\r\n\nACME_SEED=s33d\n";
    const env = e2eEnvLines("ACME_URL=https://a.example.com", "", JSON.stringify({ github_token: "gh", env: secret }), "E");
    expect(env).toEqual({
      lines: "ACME_URL<<E\nhttps://a.example.com\nE\nACME_MODEL_TOKEN<<E\nm0d=el\nE\nACME_SEED<<E\ns33d\nE\n",
      masks: ["m0d=el", "s33d"],
    });
  });

  it("refuses a malformed line of the env secret without printing it, and a variable set twice", () => {
    const bad = e2eEnvLines("", "", JSON.stringify({ env: "ACME_TOKEN=ok\nsecret-value-without-name" }), "E");
    expect(bad).toMatchObject({ _tag: "UsageInvalid", message: "the env secret: line 2 is not NAME=value" });
    expect(JSON.stringify(bad)).not.toContain("secret-value-without-name");
    expect(e2eEnvLines("ACME_TOKEN=a", "", JSON.stringify({ env: "ACME_TOKEN=b" }), "E")).toMatchObject({ _tag: "UsageInvalid" });
    expect(e2eEnvLines("", "ACME_TOKEN", JSON.stringify({ ACME_TOKEN: "a", env: "ACME_TOKEN=b" }), "E")).toMatchObject({ _tag: "UsageInvalid" });
  });

  it("refuses a secret that did not reach the workflow, and a line that is not NAME=value", () => {
    expect(e2eEnvLines("", "MISSING", "{}", "E")).toMatchObject({ _tag: "UsageInvalid" });
    expect(e2eEnvLines("not a pair", "", "", "E")).toMatchObject({ _tag: "UsageInvalid" });
    expect(e2eEnvLines("", "", "", "E")).toEqual({ lines: "", masks: [] });
  });
});
