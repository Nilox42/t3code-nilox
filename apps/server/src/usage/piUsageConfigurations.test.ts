import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { collectPiUsageConfigurations } from "./piUsageConfigurations.ts";

describe("collectPiUsageConfigurations", () => {
  it("uses the legacy Pi settings when no explicit default instance exists", () => {
    const configurations = collectPiUsageConfigurations(DEFAULT_SERVER_SETTINGS);

    expect(configurations).toEqual([{ settings: DEFAULT_SERVER_SETTINGS.providers.piAgent }]);
  });

  it("replaces the legacy default and includes additional Pi instances", () => {
    const defaultId = ProviderInstanceId.make("piAgent");
    const workId = ProviderInstanceId.make("pi_work");
    const configurations = collectPiUsageConfigurations({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [defaultId]: {
          driver: ProviderDriverKind.make("piAgent"),
          config: { agentDir: "/state/pi-personal" },
        },
        [workId]: {
          driver: ProviderDriverKind.make("piAgent"),
          enabled: false,
          environment: [{ name: "PI_CODING_AGENT_DIR", value: "/state/pi-work", sensitive: false }],
          config: {},
        },
      },
    });

    expect(configurations.map((configuration) => configuration.settings.agentDir)).toEqual([
      "/state/pi-personal",
      "",
    ]);
    expect(configurations[1]?.settings.enabled).toBe(false);
    expect(configurations[1]?.environment?.[0]?.value).toBe("/state/pi-work");
  });

  it("skips invalid Pi configs and non-Pi instances", () => {
    const configurations = collectPiUsageConfigurations({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("pi_invalid")]: {
          driver: ProviderDriverKind.make("piAgent"),
          config: { agentDir: 42 },
        },
        [ProviderInstanceId.make("codex_work")]: {
          driver: ProviderDriverKind.make("codex"),
          config: {},
        },
      },
    });

    expect(configurations).toEqual([{ settings: DEFAULT_SERVER_SETTINGS.providers.piAgent }]);
  });
});
