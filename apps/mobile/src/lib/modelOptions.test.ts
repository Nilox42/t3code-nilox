import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import { buildModelOptions } from "./modelOptions";

describe("mobile model options", () => {
  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("groups Pi models under the explicit Pi Agent label with dynamic thinking options", () => {
    const config = {
      providers: [
        {
          instanceId: "piAgent",
          driver: "piAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "anthropic/claude-sonnet",
              name: "Claude Sonnet",
              subProvider: "anthropic",
              isCustom: false,
              isDefault: true,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "thinkingLevel",
                    label: "Thinking level",
                    type: "select",
                    options: [
                      { id: "low", label: "Low" },
                      { id: "high", label: "High", isDefault: true },
                    ],
                    currentValue: "high",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, null);

    expect(option?.providerLabel).toBe("Pi Agent");
    expect(option?.providerDriver).toBe("piAgent");
    expect(option?.selection.options).toEqual([{ id: "thinkingLevel", value: "high" }]);
  });
});
