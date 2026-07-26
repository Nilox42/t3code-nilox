export type DesktopDistributionId = "official" | "nilox";

export interface DesktopDistribution {
  readonly id: DesktopDistributionId;
  readonly baseName: string;
  readonly productName: string;
  readonly appId: string;
  readonly artifactBaseName: string;
  readonly executableName: string;
  readonly productionScheme: string;
  readonly developmentScheme: string;
  readonly defaultHomeDirName: string;
  readonly productionUserDataDirName: string;
  readonly developmentUserDataDirName: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly remoteHomeDirName: string;
  readonly releaseRepository: string | undefined;
}

export const OFFICIAL_DESKTOP_DISTRIBUTION: DesktopDistribution = {
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
};

export const NILOX_DESKTOP_DISTRIBUTION: DesktopDistribution = {
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
};

export const DESKTOP_DISTRIBUTIONS = {
  official: OFFICIAL_DESKTOP_DISTRIBUTION,
  nilox: NILOX_DESKTOP_DISTRIBUTION,
} as const satisfies Record<DesktopDistributionId, DesktopDistribution>;

export class InvalidDesktopDistributionIdentityError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(`Invalid T3CODE_DESKTOP_IDENTITY value "${value}". Expected "official" or "nilox".`);
    this.name = "InvalidDesktopDistributionIdentityError";
    this.value = value;
  }
}

export function parseDesktopDistributionId(
  value: string | null | undefined,
): DesktopDistributionId {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.length === 0 || normalized === "official") return "official";
  if (normalized === "nilox") return "nilox";
  throw new InvalidDesktopDistributionIdentityError(value ?? "");
}

export function resolveDesktopDistribution(value: string | null | undefined): DesktopDistribution {
  return DESKTOP_DISTRIBUTIONS[parseDesktopDistributionId(value)];
}
