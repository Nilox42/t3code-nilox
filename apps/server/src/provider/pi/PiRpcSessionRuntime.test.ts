import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
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
  shutdownGraceMs = 750,
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
    shutdownGraceMs,
    noSession: true,
    trustProjectResources: false,
  });
});

describe("Pi RPC protocol helpers", () => {
  it("parses versions and enforces Pi 0.82+", () => {
    expect(parsePiVersion("@earendil-works/pi-coding-agent 0.82.1")).toBe("0.82.1");
    expect(parsePiVersion("@earendil-works/pi-coding-agent 0.84.1")).toBe("0.84.1");
    expect(comparePiVersions("0.82.0", "0.82.0")).toBe(0);
    expect(comparePiVersions("0.83.0", "0.82.9")).toBeGreaterThan(0);
    expect(isSupportedPiVersion("0.81.9")).toBe(false);
    expect(isSupportedPiVersion("0.82.0")).toBe(true);
    expect(isSupportedPiVersion("0.84.1")).toBe(true);
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
      "--mode=rpc",
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
      "--help",
      "-h",
      "--version",
      "-v",
      "--export session.jsonl",
      "--export=output.html",
      "--list-models",
      "--list-models=sonnet",
      "--",
    ]) {
      expect(() => validatePiLaunchArgs(args)).toThrow(/managed by T3 Code/i);
    }
    expect(
      buildPiManagedArgs({
        binaryPath: "pi",
        cwd: "/tmp",
        launchArgs: "--offline --verbose --tools read,bash --exclude-tools=write -t grep,find",
      }),
    ).toEqual([
      "--offline",
      "--verbose",
      "--tools",
      "read,bash",
      "--exclude-tools=write",
      "-t",
      "grep,find",
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
      expect(result[2][0]?.name).toBe("agent-command");
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

  it.effect("accepts Pi session metadata events emitted before command responses", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_THINKING_LEVEL_CHANGED: "1" });
      const events: string[] = [];
      runtime.onEvent((event) => events.push(event.type));

      yield* runtime.setThinkingLevel("high");

      expect(events).toContain("thinking_level_changed");
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

  it.effect("ignores unknown additive events and logs a debug diagnostic", () => {
    const logs: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      logs.push(...(Array.isArray(message) ? message : [message]));
    });

    return Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_BEHAVIOR: "unknown-event" });
      const state = yield* runtime.getState();
      const models = yield* runtime.getAvailableModels();
      yield* Effect.yieldNow;

      expect(state.sessionId).toBe("pi-mock-session");
      expect(models[0]?.id).toBe("mock/model");
      expect(logs).toContain("Ignoring unknown Pi RPC event");
      expect(logs).toContainEqual({ eventType: "future_additive_event" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
  });

  it.effect("rejects malformed payloads for known event types", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_BEHAVIOR: "malformed-known-event" });
      const error = yield* Effect.flip(runtime.getState());

      expect(error.operation).toBe("protocol");
      expect(error.detail).toMatch(/invalid known event/i);
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

  it.effect("replays the terminal exit once to a late listener", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({
        T3_PI_MOCK_EXIT_AFTER_RESPONSE: "get_state",
        T3_PI_MOCK_EXIT_AFTER_RESPONSE_CODE: "27",
      });
      let observeExit!: (exit: {
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }) => void;
      const exitObserved = new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolve) => {
        observeExit = resolve;
      });
      runtime.onExit(observeExit);
      yield* runtime.getState();
      yield* Effect.promise(() => exitObserved);

      const exits: Array<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =
        [];
      runtime.onExit((exit) => exits.push(exit));
      yield* Effect.yieldNow;

      expect(exits).toEqual([{ code: 27, signal: null }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("force-kills a Pi process that ignores stdin and SIGTERM", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ T3_PI_MOCK_IGNORE_SIGTERM: "1" }, 1_000, 25);
      const exits: Array<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =
        [];
      runtime.onExit((exit) => exits.push(exit));
      yield* runtime.getState();

      yield* Effect.all([runtime.close, runtime.close], { concurrency: "unbounded" });

      expect(runtime.getStderr()).toContain("Mock Pi ignored SIGTERM.");
      expect(exits).toEqual([{ code: null, signal: "SIGKILL" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
