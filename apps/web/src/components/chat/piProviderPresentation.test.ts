import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_OPTIONS } from "../../session-logic";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("Pi Agent web presentation", () => {
  it("is active in the provider picker and uses the Pi icon", () => {
    const pi = ProviderDriverKind.make("piAgent");

    expect(PROVIDER_OPTIONS.find((option) => option.value === pi)).toMatchObject({
      label: "Pi Agent",
      available: true,
      pickerSidebarBadge: "new",
    });
    expect(PROVIDER_ICON_BY_PROVIDER[pi]).toBeDefined();
  });
});
