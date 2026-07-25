import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("Pi Agent provider-instance hydration", () => {
  it("synthesizes the default Pi Agent instance from legacy settings", () => {
    const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const pi = instances[ProviderInstanceId.make("piAgent")];

    expect(pi?.driver).toBe("piAgent");
    expect(pi?.config).toEqual(DEFAULT_SERVER_SETTINGS.providers.piAgent);
  });

  it("keeps an explicit Pi Agent instance over its synthesized default", () => {
    const instanceId = ProviderInstanceId.make("piAgent");
    const instances = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("piAgent"),
          displayName: "Pi Work",
          config: { binaryPath: "/opt/pi-work", agentDir: "/state/pi-work" },
        },
      },
    });

    expect(instances[instanceId]).toEqual({
      driver: "piAgent",
      displayName: "Pi Work",
      config: { binaryPath: "/opt/pi-work", agentDir: "/state/pi-work" },
    });
  });
});
