// The xcode adapter's pure parts: which test identifiers a Swift file declares, each test case of a
// result bundle, and each file's result from its identifiers' cases. The real xcodebuild runs on a
// Mac VM (outrun/spikes/tracer/bench), not here.
import { describe, expect, it } from "vitest";
import { type CaseResult, fileResults, parseTestResults, schemeArgs, testIdentifiers } from "./xcode.ts";

describe("xcode adapter", () => {
  it("a file's test identifiers: its top-level types and @Test functions, none without tests", () => {
    const swiftTesting = `import Testing
@testable import Flipcash

@MainActor
@Suite("Composer stacking", .serialized, .bug("6ae1d31"))
struct ComposerStackingTests {
    @Test("A draft that fits stays inline")
    func fits() {}
}

private struct Helper {}

@Test func freeStanding() {}

@Test("named")
func another() async throws {}

extension OtherTests {
    @Test func more() {}
}
`;
    expect(testIdentifiers(swiftTesting)).toEqual(["ComposerStackingTests", "freeStanding()", "another()", "OtherTests"]);
    const xctest = "import XCTest\n\nfinal class LoginTests: XCTestCase {\n    func testLogin() {}\n}\n";
    expect(testIdentifiers(xctest)).toEqual(["LoginTests"]);
    expect(testIdentifiers("@MainActor\nfinal class MockChatPoster: ChatMessagePosting {\n    struct Post {}\n}\n")).toEqual([]);
    // A test-support helper named test…(_:) is no XCTest method; an empty @Suite still is a test type.
    const support = "extension PublicKey {\n    static func testMint(index: Int) -> PublicKey { .x }\n}\n\n@Suite\nstruct Empty {}\n";
    expect(testIdentifiers(support)).toEqual(["Empty"]);
  });

  it("the scheme's arguments: workspace or project, scheme, destination, test plan", () => {
    expect(
      schemeArgs({ project: "App.xcodeproj", scheme: "App", destination: "platform=iOS Simulator,name=iPhone 17", target: "AppTests", testPlan: "Unit" }),
    ).toEqual(["-project", "App.xcodeproj", "-scheme", "App", "-destination", "platform=iOS Simulator,name=iPhone 17", "-testPlan", "Unit"]);
  });

  it("each test case of the target in xcresulttool's JSON, by its top-level identifier", () => {
    const json = JSON.stringify({
      testNodes: [
        {
          name: "App",
          nodeType: "Test Plan",
          children: [
            {
              name: "AppTests",
              nodeType: "Unit test bundle",
              children: [
                {
                  name: "Composer stacking",
                  nodeType: "Test Suite",
                  nodeIdentifier: "ComposerStackingTests",
                  children: [
                    { name: "fits", nodeType: "Test Case", nodeIdentifier: "ComposerStackingTests/fits()", result: "Passed", durationInSeconds: 0.25 },
                    {
                      name: "wraps",
                      nodeType: "Test Case",
                      nodeIdentifier: "ComposerStackingTests/Nested/wraps()",
                      result: "Failed",
                      duration: "1m 2s",
                      children: [{ name: "Expectation failed: 2 == 3", nodeType: "Failure Message" }],
                    },
                  ],
                },
                { name: "freeStanding()", nodeType: "Test Case", nodeIdentifier: "AppTests/freeStanding()", result: "Skipped", duration: "12ms" },
              ],
            },
            { name: "OtherTests", nodeType: "Unit test bundle", children: [{ nodeType: "Test Case", nodeIdentifier: "X/y()", result: "Failed" }] },
          ],
        },
      ],
    });
    expect(parseTestResults(json, "AppTests")).toEqual([
      { id: "ComposerStackingTests", passed: true, durationMs: 250 },
      {
        id: "ComposerStackingTests",
        passed: false,
        durationMs: 62_000,
        failure: "ComposerStackingTests/Nested/wraps(): Failed\n    Expectation failed: 2 == 3",
      },
      { id: "freeStanding()", passed: true, durationMs: 12 },
    ]);
    expect(parseTestResults("not json", "AppTests")).toEqual([]);
  });

  it("each file's result: red if a case failed, absent if its identifiers ran nothing, passed without tests", () => {
    const cases: CaseResult[] = [
      { id: "A", passed: true, durationMs: 100 },
      { id: "A", passed: true, durationMs: 50 },
      { id: "B", passed: false, durationMs: 10 },
    ];
    const byFile = new Map([
      ["a.swift", ["A", "Helper"]],
      ["b.swift", ["B"]],
      ["c.swift", ["C"]],
      ["support.swift", []],
    ]);
    const ended = fileResults(byFile, cases, true);
    expect(ended.get("a.swift")).toEqual({ passed: true, durationMs: 150, tests: 2 });
    expect(ended.get("b.swift")).toEqual({ passed: false, durationMs: 10, tests: 1 });
    expect(ended.has("c.swift")).toBe(false);
    expect(ended.get("support.swift")).toEqual({ passed: true, durationMs: 0, tests: 0 });
    expect(fileResults(byFile, cases, false).has("support.swift")).toBe(false);
  });
});
