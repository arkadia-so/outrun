// A test file's observation from a traced build's per-target read sets: its target and what it
// imports, the build's unattributed reads, the test run, and not the other targets' sources.
import { describe, expect, it } from "vitest";
import { parseObserved } from "./observed.ts";
import { modulesRead, observationLine, parseRecords, targetClosure, targetObservation, withinRepo } from "./xcode-targets.ts";

const R = "/repo";
const DD = "/dd/Build/Products/Debug-iphonesimulator";
const line = (o: Record<string, unknown>) => JSON.stringify({ complete: true, env: [], exec: [], net: [], stat_only: [], missing: [], ...o });

const targetsText = [
  line({ unit: "build", target: "AppTests", reads: [`${R}/AppTests/ATests.swift`, `${R}/AppTests/BTests.swift`, `${DD}/App.swiftmodule/arm64.swiftmodule`] }),
  line({ unit: "build", target: "App", reads: [`${R}/App/Main.swift`, `${R}/Shared/Util.swift`, `${DD}/Core.swiftmodule/arm64.swiftmodule`] }),
  line({ unit: "build", target: "Core", reads: [`${R}/Core/Sources/Core.swift`] }),
  line({ unit: "build", target: "Widget", reads: [`${R}/Widget/Widget.swift`, `${R}/Shared/Util.swift`] }),
  line({
    unit: "build",
    target: "WidgetTests",
    reads: [`${R}/WidgetTests/WTests.swift`, `/dd/Build/Products/Debug/Widget.framework/Modules/Widget.swiftmodule/x`],
  }),
].join("\n");

const buildText = line({
  unit: "build",
  reads: [
    `${R}/AppTests/ATests.swift`,
    `${R}/AppTests/BTests.swift`,
    `${R}/App/Main.swift`,
    `${R}/Shared/Util.swift`,
    `${R}/Core/Sources/Core.swift`,
    `${R}/Widget/Widget.swift`,
    `${R}/WidgetTests/WTests.swift`,
    `${R}/App.xcodeproj/project.pbxproj`,
    `${R}/App/Assets.xcassets/`,
  ],
  net: ["unknown:ip"],
});
const runText = line({
  unit: "tests",
  reads: [`${R}/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`, `${R}/App/Main.swift`, `${R}/App/Info.plist`],
  stat_only: [`${R}/App/Main.swift`, `${R}/App/Info.plist`],
  missing: [`${R}/fixtures/absent.json`],
});

describe("xcode targets", () => {
  it("the modules a target read, from the build's products", () => {
    const [, app, , , widgetTests] = parseRecords(targetsText);
    expect([...modulesRead(app as never)]).toEqual(["Core"]);
    expect([...modulesRead(widgetTests as never)]).toEqual(["Widget"]);
  });

  it("a test target's closure: itself and every target it reaches through what it imports", () => {
    const targets = parseRecords(targetsText);
    expect([...targetClosure(targets, "AppTests")].sort()).toEqual(["App", "AppTests", "Core"]);
    expect([...targetClosure(targets, "WidgetTests")].sort()).toEqual(["Widget", "WidgetTests"]);
  });

  it("a test file's reads: its closure, the build's unattributed reads, the test run, not the other targets' sources", () => {
    const [build] = parseRecords(buildText);
    const runs = parseRecords(runText);
    const seen = targetObservation(build as never, parseRecords(targetsText), runs, "AppTests");
    expect(seen?.reads).toEqual(
      [
        `${R}/App.xcodeproj/project.pbxproj`,
        `${R}/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`,
        `${R}/App/Assets.xcassets/`,
        `${R}/App/Info.plist`,
        `${R}/App/Main.swift`,
        `${R}/AppTests/ATests.swift`,
        `${R}/AppTests/BTests.swift`,
        `${R}/Core/Sources/Core.swift`,
        // Read by App (inside) and Widget (outside): kept.
        `${R}/Shared/Util.swift`,
      ].sort(),
    );
    // Stat'ed by the run but opened by the build: keyed by content, not presence.
    expect(seen?.statOnly).toEqual([`${R}/App/Info.plist`]);
    expect(seen?.missing).toEqual([`${R}/fixtures/absent.json`]);
    expect(seen?.net).toEqual(["unknown:ip"]);
    expect(targetObservation(build as never, parseRecords(targetsText), runs, "NoSuchTests")).toBeUndefined();
  });

  it("its line is what outrun test --trace reads, one per test file", () => {
    const [build] = parseRecords(buildText);
    const seen = targetObservation(build as never, parseRecords(targetsText), [], "WidgetTests");
    const observed = parseObserved(observationLine(`${R}/WidgetTests/WTests.swift`, seen as never), R);
    expect(observed.get("WidgetTests/WTests.swift")?.reads).toEqual([
      "App.xcodeproj/project.pbxproj",
      "App/Assets.xcassets/",
      "Shared/Util.swift",
      "Widget/Widget.swift",
      "WidgetTests/WTests.swift",
    ]);
  });

  it("only the checkout's paths, relative, without .git or the compiler's in-memory names", () => {
    const o = {
      reads: ["/private/tmp/app/A.swift", "/tmp/spm/x", "/private/tmp/app2/B.swift", "/private/tmp/app/", "/private/tmp/app/.git/HEAD", "/dd/M.swiftmodule/x"],
      statOnly: [],
      missing: [
        "/tmp/app/c.json",
        "/tmp/app/Code.xcodeproj/@__swiftmacro_10FlipcashUI0020AccessKeyswift_odAJdfMX101_0_33_343AfMf_.swift",
        "/tmp/app/AVFAudio-1a87dd8d.input",
        "/tmp/app/Code.xcodeproj/<swift-imported-modules>",
        "/tmp/app/Package@swift-6.swift",
      ],
      complete: true,
      env: [],
      exec: [],
      net: [],
    };
    expect(withinRepo(o, ["/tmp/app", "/private/tmp/app/"], (p) => p.includes(".swiftmodule"))).toEqual({
      ...o,
      reads: ["A.swift", "./", "/dd/M.swiftmodule/x"],
      missing: ["c.json", "Package@swift-6.swift"],
    });
  });
});
