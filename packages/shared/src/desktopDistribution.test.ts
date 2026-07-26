import { describe, expect, it } from "vite-plus/test";

import {
  InvalidDesktopDistributionIdentityError,
  OFFICIAL_DESKTOP_DISTRIBUTION,
  parseDesktopDistributionId,
  resolveDesktopDistribution,
} from "./desktopDistribution.ts";

describe("DesktopDistribution", () => {
  it("defaults a missing identity to official", () => {
    expect(parseDesktopDistributionId(undefined)).toBe("official");
    expect(resolveDesktopDistribution(undefined)).toBe(OFFICIAL_DESKTOP_DISTRIBUTION);
  });

  it("normalizes whitespace and case", () => {
    expect(parseDesktopDistributionId("  NiLoX \n")).toBe("nilox");
  });

  it("resolves every Nilox identity value", () => {
    expect(resolveDesktopDistribution("nilox")).toEqual({
      id: "nilox",
      baseName: "T3 Code Nilox",
      productName: "T3 Code Nilox (Alpha)",
      appId: "io.github.nilox42.t3code.nilox",
      artifactBaseName: "T3-Code-Nilox",
      executableName: "t3code-nilox",
      productionScheme: "t3code-nilox",
      developmentScheme: "t3code-nilox-dev",
      defaultHomeDirName: ".t3-nilox",
      productionUserDataDirName: "t3code-nilox",
      developmentUserDataDirName: "t3code-nilox-dev",
      linuxDesktopEntryName: "t3code-nilox.desktop",
      linuxWmClass: "t3code-nilox",
      remoteHomeDirName: ".t3-nilox",
      releaseRepository: "Nilox42/t3code-nilox",
    });
  });

  it("preserves official identity values", () => {
    expect(resolveDesktopDistribution("official")).toEqual({
      id: "official",
      baseName: "T3 Code",
      productName: "T3 Code (Alpha)",
      appId: "com.t3tools.t3code",
      artifactBaseName: "T3-Code",
      executableName: "t3code",
      productionScheme: "t3code",
      developmentScheme: "t3code-dev",
      defaultHomeDirName: ".t3",
      productionUserDataDirName: "t3code",
      developmentUserDataDirName: "t3code-dev",
      linuxDesktopEntryName: "t3code.desktop",
      linuxWmClass: "t3code",
      remoteHomeDirName: ".t3",
      releaseRepository: undefined,
    });
  });

  it("rejects unknown identities with an actionable error", () => {
    expect(() => resolveDesktopDistribution("enterprise")).toThrow(
      InvalidDesktopDistributionIdentityError,
    );
    expect(() => resolveDesktopDistribution("enterprise")).toThrow(
      'Invalid T3CODE_DESKTOP_IDENTITY value "enterprise". Expected "official" or "nilox".',
    );
  });
});
