import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { buildPiModelCatalog, checkPiProviderStatus } from "./PiProvider.ts";
import type { PiModel, PiRpcState } from "../pi/PiRpcSessionRuntime.ts";

const decodeSettings = Schema.decodeSync(PiSettings);

const mockBinaryPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/pi-mock-agent.mjs", import.meta.url));
});

const runStatus = (environment: NodeJS.ProcessEnv = {}, binaryPath?: string) =>
  Effect.gen(function* () {
    const resolvedBinary = binaryPath ?? (yield* mockBinaryPath);
    return yield* checkPiProviderStatus(
      decodeSettings({ binaryPath: resolvedBinary }),
      process.cwd(),
      { ...process.env, ...environment },
    );
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive);

describe("Pi Agent model catalog", () => {
  const model: PiModel = {
    id: "org/model",
    name: "Provider Model",
    provider: "upstream",
    api: "mock",
    reasoning: true,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 8_000,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
  };
  const state: PiRpcState = {
    model,
    thinkingLevel: "xhigh",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session",
    sessionName: "Session",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };

  it("uses Pi's current model as default and exposes supported thinking levels", () => {
    const [catalog] = buildPiModelCatalog([model], state);

    expect(catalog?.slug).toBe("upstream/org/model");
    expect(catalog?.subProvider).toBe("upstream");
    expect(catalog?.isDefault).toBe(true);
    expect(catalog?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "thinkingLevel",
      currentValue: "xhigh",
      options: [
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "xhigh", isDefault: true },
      ],
    });
  });
});

describe("Pi Agent provider probe", () => {
  it.effect("reports authenticated models and presentation metadata", () =>
    Effect.gen(function* () {
      const provider = yield* runStatus();

      expect(provider).toMatchObject({
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        displayName: "Pi Agent",
        badgeLabel: "Early Access",
        showInteractionModeToggle: false,
        version: "0.82.1",
      });
      expect(provider.models[0]?.slug).toBe("mock-provider/mock/model");
    }),
  );

  it.effect("reports an actionable unauthenticated state for an empty model list", () =>
    Effect.gen(function* () {
      const provider = yield* runStatus({ T3_PI_MOCK_NO_MODELS: "1" });

      expect(provider.auth.status).toBe("unauthenticated");
      expect(provider.status).toBe("warning");
      expect(provider.message).toMatch(/\/login/);
    }),
  );

  it.effect("keeps old Pi versions visible but unavailable", () =>
    Effect.gen(function* () {
      const provider = yield* runStatus({ T3_PI_MOCK_VERSION: "0.81.9" });

      expect(provider.installed).toBe(true);
      expect(provider.status).toBe("error");
      expect(provider.message).toMatch(/0\.82\.0 or newer/);
    }),
  );

  it.effect("classifies a non-zero version command", () =>
    Effect.gen(function* () {
      const provider = yield* runStatus({ T3_PI_MOCK_VERSION_EXIT_CODE: "9" });

      expect(provider.installed).toBe(true);
      expect(provider.status).toBe("error");
      expect(provider.message).toMatch(/exit code 9/);
    }),
  );

  it.effect("classifies a missing Pi executable", () =>
    Effect.gen(function* () {
      const provider = yield* runStatus({}, "/definitely/missing/t3-pi");

      expect(provider.installed).toBe(false);
      expect(provider.status).toBe("error");
      expect(provider.message).toMatch(/not installed|not on PATH/i);
    }),
  );

  it.effect(
    "classifies a version probe timeout",
    () =>
      Effect.gen(function* () {
        const provider = yield* runStatus({ T3_PI_MOCK_VERSION_BEHAVIOR: "timeout" });

        expect(provider.installed).toBe(true);
        expect(provider.status).toBe("error");
        expect(provider.message).toMatch(/timed out/i);
      }),
    8_000,
  );
});
