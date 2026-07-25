import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodeSettings = Schema.decodeSync(PiSettings);
const selection = {
  instanceId: ProviderInstanceId.make("piAgent"),
  model: "mock-provider/mock/model",
  options: [{ id: "thinkingLevel", value: "high" as const }],
};

const makeFixture = Effect.fn("makePiTextGenerationFixture")(function* (
  environment: NodeJS.ProcessEnv,
  timeoutMs = 1_000,
) {
  const path = yield* Path.Path;
  const binaryPath = yield* path.fromFileUrl(
    new URL("../../scripts/pi-mock-agent.mjs", import.meta.url),
  );
  return yield* makePiTextGeneration(
    decodeSettings({ binaryPath }),
    { ...process.env, ...environment },
    timeoutMs,
  );
});

describe("Pi Agent text generation", () => {
  it.effect("returns validated final assistant JSON from an isolated no-tools process", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeFixture({
        T3_PI_MOCK_ASSISTANT_TEXT: '{"title":"  Focused Pi title  "}',
      });
      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Implement Pi",
        modelSelection: selection,
      });

      expect(result).toEqual({ title: "Focused Pi title" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns TextGenerationError for malformed structured output", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeFixture({
        T3_PI_MOCK_ASSISTANT_TEXT: "not json",
      });
      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Implement Pi",
          modelSelection: selection,
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toMatch(/invalid structured output/i);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns TextGenerationError when the Pi process exits", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeFixture({ T3_PI_MOCK_BEHAVIOR: "exit" });
      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Implement Pi",
          modelSelection: selection,
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toMatch(/text generation failed/i);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns TextGenerationError when Pi RPC times out", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeFixture({ T3_PI_MOCK_BEHAVIOR: "timeout" }, 25);
      const error = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Implement Pi",
          modelSelection: selection,
        }),
      );

      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toMatch(/timed out|failed/i);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
