import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  buildPiManagedArgs,
  clampPiThinkingLevel,
  comparePiVersions,
  isSupportedPiVersion,
  makePiRpcSessionRuntime,
  parsePiModelSlug,
  parsePiVersion,
  supportedThinkingLevels,
  validatePiLaunchArgs,
  type PiModel,
} from "./PiRpcSessionRuntime.ts";

const model: PiModel = {
  id: "org/model/with/slashes",
  name: "Reasoning model",
  provider: "mock",
  api: "mock",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 8_192,
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

const makeRuntime = Effect.fn("makePiMockRuntime")(function* (
  environment: NodeJS.ProcessEnv = {},
  requestTimeoutMs = 1_000,
) {
  const path = yield* Path.Path;
  const binaryPath = yield* path.fromFileUrl(
    new URL("../../../scripts/pi-mock-agent.mjs", import.meta.url),
  );
  return yield* makePiRpcSessionRuntime({
    binaryPath,
    cwd: process.cwd(),
    environment: { ...process.env, ...environment },
    requestTimeoutMs,
    noSession: true,
    trustProjectResources: false,
  });
});

describe("Pi RPC protocol helpers", () => {
  it("parses versions and enforces Pi 0.82+", () => {
    expect(parsePiVersion("@earendil-works/pi-coding-agent 0.82.1")).toBe("0.82.1");
    expect(comparePiVersions("0.82.0", "0.82.0")).toBe(0);
    expect(comparePiVersions("0.83.0", "0.82.9")).toBeGreaterThan(0);
    expect(isSupportedPiVersion("0.81.9")).toBe(false);
    expect(isSupportedPiVersion("0.82.0")).toBe(true);
  });

  it("splits model slugs only at the first slash", () => {
    expect(parsePiModelSlug("mock/org/model/with/slashes")).toEqual({
      provider: "mock",
      modelId: "org/model/with/slashes",
    });
    expect(parsePiModelSlug("missing-provider")).toBeNull();
  });

  it("derives and clamps model-specific thinking levels", () => {
    expect(supportedThinkingLevels(model)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(clampPiThinkingLevel("max", model, "high")).toBe("high");
    expect(clampPiThinkingLevel("xhigh", model)).toBe("xhigh");
    expect(
      supportedThinkingLevels({
        ...model,
        reasoning: false,
      }),
    ).toEqual(["off"]);
  });

  it("rejects user arguments that would take ownership of the Pi session", () => {
    for (const args of [
      "--mode rpc",
      "--print",
      "--provider anthropic",
      "--model test",
      "--thinking high",
      "--api-key secret",
      "--approve",
      "-na",
      "--session old.jsonl",
      "--no-session",
      "--mcp-config /tmp/other.json",
    ]) {
      expect(() => validatePiLaunchArgs(args)).toThrow(/managed by T3 Code/i);
    }
    expect(buildPiManagedArgs({ binaryPath: "pi", cwd: "/tmp", launchArgs: "--verbose" })).toEqual([
      "--verbose",
      "--mode",
      "rpc",
      "--no-approve",
    ]);
    expect(
      buildPiManagedArgs({
        binaryPath: "pi",
        cwd: "/tmp",
        mcpConfigPath: "/tmp/t3-mcp.json",
      }),
    ).toEqual(["--mode", "rpc", "--no-approve", "--mcp-config", "/tmp/t3-mcp.json"]);
  });
});

describe("Pi RPC JSONL runtime", () => {
  it.effect("handles split CRLF records and multiple records", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        T3_PI_MOCK_SPLIT: "1",
        T3_PI_MOCK_CRLF: "1",
      });
      const result = yield* Effect.all(
        [runtime.getState(), runtime.getAvailableModels(), runtime.getCommands()],
        { concurrency: "unbounded" },
      );

      expect(result[0].sessionId).toBe("pi-mock-session");
      expect(result[1][0]?.id).toBe("mock/model");
      expect(result[2][0]?.name).toBe("login");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("correlates out-of-order responses by request id", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_BEHAVIOR: "out-of-order" });
      const [state, models] = yield* Effect.all(
        [runtime.getState(), runtime.getAvailableModels()],
        {
          concurrency: "unbounded",
        },
      );

      expect(state.sessionId).toBe("pi-mock-session");
      expect(models[0]?.provider).toBe("mock-provider");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("settles abort before its response and safely ignores a late response", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime(
        {
          T3_PI_MOCK_ABORT_RESPONSE_DELAY_MS: "2500",
          T3_PI_MOCK_SETTLE_DURING_ABORT: "1",
        },
        1_000,
      );
      yield* runtime.getState();

      const aborted = yield* runtime.abort().pipe(Effect.timeoutOption("500 millis"));
      expect(Option.isSome(aborted)).toBe(true);

      yield* Effect.sleep("2600 millis");
      expect((yield* runtime.getState()).sessionId).toBe("pi-mock-session");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it.effect("fails outstanding requests on malformed protocol data", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_BEHAVIOR: "malformed" });
      const error = yield* Effect.flip(runtime.getState());

      expect(error.operation).toBe("protocol");
      expect(error.detail).toMatch(/malformed JSONL/i);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("times out and cleans up outstanding requests", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_BEHAVIOR: "timeout" }, 25);
      const error = yield* Effect.flip(runtime.getState());

      expect(error.operation).toBe("get_state");
      expect(error.detail).toMatch(/timed out/i);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects requests when the Pi process exits", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_BEHAVIOR: "exit" });
      const error = yield* Effect.flip(runtime.getState());

      expect(error.operation).toBe("process");
      expect(error.detail).toMatch(/exited unexpectedly/i);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
