import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { PI_MCP_ADAPTER_REQUIRED_MESSAGE, type PiMcpBridgeCapability } from "../pi/PiMcpBridge.ts";
import {
  makePiAdapter,
  piApprovalExtensionResponse,
  piRuntimeModeNeedsApproval,
} from "./PiAdapter.ts";

const PI = ProviderDriverKind.make("piAgent");
const PI_INSTANCE = ProviderInstanceId.make("piAgent");

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeFixture = Effect.fn("makePiAdapterFixture")(function* (
  environment: NodeJS.ProcessEnv = {},
  instanceId = PI_INSTANCE,
  agentDir = "",
  mcpBridge: PiMcpBridgeCapability = {
    available: false,
    reason: "adapter-not-installed",
    message: PI_MCP_ADAPTER_REQUIRED_MESSAGE,
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binaryPath = yield* path.fromFileUrl(
    new URL("../../../scripts/pi-mock-agent.mjs", import.meta.url),
  );
  const sessionFile = path.join(
    yield* fileSystem.makeTempDirectory({ prefix: "pi-adapter-session-" }),
    "session.jsonl",
  );
  yield* fileSystem.writeFileString(sessionFile, "");
  const adapter = yield* makePiAdapter(
    {
      enabled: true,
      binaryPath,
      agentDir,
      launchArgs: "",
      trustProjectResources: false,
    },
    {
      instanceId,
      environment: {
        ...process.env,
        T3_PI_MOCK_SESSION_FILE: sessionFile,
        ...environment,
      },
      extensionPath: "/tmp/t3-pi-test-extension.mjs",
      mcpBridge,
    },
  );
  return { adapter, sessionFile };
});

const collectThrough = (
  stream: Stream.Stream<ProviderRuntimeEvent>,
  eventType: ProviderRuntimeEvent["type"],
) => Stream.runCollect(Stream.takeUntil(stream, (event) => event.type === eventType));

function isMcpBridgeUnavailableWarning(event: ProviderRuntimeEvent): boolean {
  if (event.type !== "runtime.warning") return false;
  const detail = event.payload.detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    "code" in detail &&
    detail.code === "pi_mcp_bridge_unavailable"
  );
}

const installMcpSession = Effect.fn("installPiMcpSession")(function* (threadId: ThreadId) {
  McpProviderSession.setMcpProviderSession({
    environmentId: EnvironmentId.make("local"),
    threadId,
    providerSessionId: "pi-mcp-test",
    providerInstanceId: PI_INSTANCE,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer thread-secret",
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
  );
});

const makeStartupFailureFixture = Effect.fn("makePiStartupFailureFixture")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const probeDir = yield* fileSystem.makeTempDirectory({ prefix: "pi-startup-failure-" });
  const pidFile = path.join(probeDir, "pid");
  const stdinClosedFile = path.join(probeDir, "stdin-closed");
  const fixture = yield* makeFixture({
    ...environment,
    T3_PI_MOCK_PID_FILE: pidFile,
    T3_PI_MOCK_STDIN_CLOSED_FILE: stdinClosedFile,
  });
  return { ...fixture, pidFile, stdinClosedFile };
});

const waitForMockProcessCleanup = Effect.fn("waitForPiMockProcessCleanup")(function* (
  pidFile: string,
  stdinClosedFile: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (yield* fileSystem.exists(pidFile)) break;
    yield* Effect.sleep("10 millis");
  }
  if (!(yield* fileSystem.exists(pidFile))) return false;

  const pid = Number((yield* fileSystem.readFileString(pidFile)).trim());
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stdinClosed = yield* fileSystem.exists(stdinClosedFile);
    const processAlive = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (stdinClosed && !processAlive) return true;
    yield* Effect.sleep("10 millis");
  }
  return false;
});

describe("PiAdapter lifecycle and event mapping", () => {
  it.effect("does not register a session when the Pi process cannot spawn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const missingBinary = path.join(
        yield* fileSystem.makeTempDirectory({ prefix: "pi-missing-binary-" }),
        "missing-pi",
      );
      const adapter = yield* makePiAdapter(
        {
          enabled: true,
          binaryPath: missingBinary,
          agentDir: "",
          launchArgs: "",
          trustProjectResources: false,
        },
        {
          instanceId: PI_INSTANCE,
          environment: process.env,
          extensionPath: "/tmp/t3-pi-test-extension.mjs",
          mcpBridge: {
            available: false,
            reason: "adapter-not-installed",
            message: PI_MCP_ADAPTER_REQUIRED_MESSAGE,
          },
        },
      );
      const threadId = ThreadId.make("pi-startup-spawn-failure");

      const error = yield* Effect.flip(
        adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      expect(error.message).toMatch(/spawn|not found|no such file/i);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("closes the Pi process when initial state loading fails", () =>
    Effect.gen(function* () {
      const { adapter, pidFile, stdinClosedFile } = yield* makeStartupFailureFixture({
        T3_PI_MOCK_FAIL_COMMAND: "get_state",
      });
      const threadId = ThreadId.make("pi-startup-state-failure");

      const error = yield* Effect.flip(
        adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      expect(error.message).toMatch(/injected get_state failure/i);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* waitForMockProcessCleanup(pidFile, stdinClosedFile)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
  );

  it.effect("closes the Pi process when model selection fails", () =>
    Effect.gen(function* () {
      const { adapter, pidFile, stdinClosedFile } = yield* makeStartupFailureFixture({
        T3_PI_MOCK_FAIL_COMMAND: "set_model",
      });
      const threadId = ThreadId.make("pi-startup-model-failure");

      const error = yield* Effect.flip(
        adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: createModelSelection(PI_INSTANCE, "mock-provider/team/model"),
        }),
      );

      expect(error.message).toMatch(/injected set_model failure/i);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* waitForMockProcessCleanup(pidFile, stdinClosedFile)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
  );

  it.effect("closes the Pi process when resumed session validation fails", () =>
    Effect.gen(function* () {
      const { adapter, sessionFile, pidFile, stdinClosedFile } = yield* makeStartupFailureFixture({
        T3_PI_MOCK_SESSION_ID: "unexpected-session",
      });
      const threadId = ThreadId.make("pi-startup-resume-failure");

      const error = yield* Effect.flip(
        adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: {
            schemaVersion: 1,
            sessionFile,
            sessionId: "expected-session",
          },
        }),
      );

      expect(error.message).toMatch(/unexpected-session.*expected-session/i);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* waitForMockProcessCleanup(pidFile, stdinClosedFile)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
  );

  it.effect(
    "configures model/thinking and maps streamed text, reasoning, tools, usage, and completion",
    () =>
      Effect.gen(function* () {
        const { adapter } = yield* makeFixture();
        const threadId = ThreadId.make("pi-lifecycle");
        const session = yield* adapter.startSession({
          provider: PI,
          providerInstanceId: PI_INSTANCE,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: createModelSelection(PI_INSTANCE, "mock-provider/team/model", [
            { id: "thinkingLevel", value: "xhigh" },
          ]),
        });
        expect(session.model).toBe("mock-provider/team/model");

        const eventsFiber = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({ threadId, input: "Stream a response", attachments: [] });
        const events = yield* Fiber.join(eventsFiber);
        const types = events.map((event) => event.type);

        expect(types).toContain("turn.started");
        expect(types).toContain("content.delta");
        expect(types).toContain("item.started");
        expect(types).toContain("item.updated");
        expect(types).toContain("item.completed");
        expect(types).toContain("thread.token-usage.updated");
        expect(types.filter((type) => type === "turn.completed")).toHaveLength(1);
        const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");
        expect(usageEvents).toHaveLength(1);
        expect(usageEvents[0]?.payload.usage).toEqual({
          usedTokens: 33,
          totalProcessedTokens: 33,
          inputTokens: 23,
          cachedInputTokens: 3,
          outputTokens: 10,
          lastUsedTokens: 33,
          lastInputTokens: 23,
          lastCachedInputTokens: 3,
          lastOutputTokens: 10,
          toolUses: 1,
          maxTokens: 128_000,
          compactsAutomatically: true,
        });
        expect(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.streamKind),
        ).toEqual(["reasoning_text", "assistant_text"]);
        expect(
          events
            .filter((event) => event.raw !== undefined)
            .every((event) => event.raw?.source === "pi.rpc"),
        ).toBe(true);
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("publishes the initial Pi session name as thread metadata", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({
        T3_PI_MOCK_SESSION_NAME: "Named Pi session",
      });
      const threadId = ThreadId.make("pi-session-name");
      const metadataFiber = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "thread.metadata.updated"),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const metadata = yield* Fiber.join(metadataFiber);

      expect(metadata._tag).toBe("Some");
      if (metadata._tag === "Some" && metadata.value.type === "thread.metadata.updated") {
        expect(metadata.value.payload).toEqual({
          name: "Named Pi session",
          metadata: {
            sessionId: "pi-mock-session",
            sessionName: "Named Pi session",
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("maps Pi session changes, MCP status, and stable MCP tool identity", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({
        T3_PI_MOCK_SESSION_NAME_EVENT: "Renamed Pi session",
        T3_PI_MOCK_MCP_STATUS: "1",
        T3_PI_MOCK_MCP_SERVER: "t3-code",
        T3_PI_MOCK_MCP_TOOL: "preview_status",
        T3_PI_MOCK_TOOL: "t3_code_preview_status",
      });
      const threadId = ThreadId.make("pi-mcp-lifecycle");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "Inspect the preview", attachments: [] });
      const events = yield* Fiber.join(eventsFiber);

      const metadata = events.find((event) => event.type === "thread.metadata.updated");
      expect(metadata?.payload).toMatchObject({
        name: "Renamed Pi session",
        metadata: {
          sessionName: "Renamed Pi session",
        },
      });

      const mcpStatus = events.find((event) => event.type === "mcp.status.updated");
      expect(mcpStatus?.payload).toEqual({
        status: {
          version: 1,
          servers: [
            {
              name: "t3-code",
              status: "connected",
              toolCount: 12,
              resourceCount: 0,
              disabled: false,
            },
          ],
          totalTools: 12,
          totalResources: 0,
          connectedCount: 1,
          disabledCount: 0,
        },
      });

      const mcpItems = events.filter(
        (event) =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          event.payload.itemType === "mcp_tool_call",
      );
      expect(mcpItems).toHaveLength(3);
      const completed = mcpItems.find((event) => event.type === "item.completed");
      expect(completed?.payload).toMatchObject({
        itemType: "mcp_tool_call",
        status: "completed",
        title: "t3-code · preview_status",
        data: {
          item: {
            type: "mcpToolCall",
            id: "pi-tool-1",
            server: "t3-code",
            tool: "preview_status",
            arguments: { interactiveOnly: true },
            status: "completed",
          },
        },
      });

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("maps cache reads and writes into the shared token usage contract", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({
        T3_PI_MOCK_USAGE_INPUT: "11",
        T3_PI_MOCK_USAGE_OUTPUT: "4",
        T3_PI_MOCK_USAGE_CACHE_READ: "5",
        T3_PI_MOCK_USAGE_CACHE_WRITE: "7",
        T3_PI_MOCK_USAGE_REASONING: "2",
      });
      const threadId = ThreadId.make("pi-cached-usage");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "Use cached context", attachments: [] });
      const events = yield* Fiber.join(eventsFiber);
      const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");

      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.payload.usage).toMatchObject({
        usedTokens: 27,
        totalProcessedTokens: 27,
        inputTokens: 23,
        cachedInputTokens: 5,
        outputTokens: 4,
        reasoningOutputTokens: 2,
        lastUsedTokens: 27,
        lastInputTokens: 23,
        lastCachedInputTokens: 5,
        lastOutputTokens: 4,
        lastReasoningOutputTokens: 2,
      });

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves assistant message boundaries across tool loops", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({
        T3_PI_MOCK_MULTI_MESSAGE: "1",
        T3_PI_MOCK_ASSISTANT_TEXT: "After tool",
      });
      const threadId = ThreadId.make("pi-multi-message");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const eventsFiber = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "Use a tool", attachments: [] });
      const events = yield* Fiber.join(eventsFiber);
      const assistantStarts = events.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const assistantDeltas = events.flatMap((event) =>
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? [{ itemId: event.itemId, delta: event.payload.delta }]
          : [],
      );
      const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");

      expect(assistantStarts).toHaveLength(2);
      expect(assistantStarts[0]?.itemId).not.toBe(assistantStarts[1]?.itemId);
      expect(assistantDeltas.map((event) => event.delta)).toEqual([
        "Before ",
        "tool",
        "After tool",
      ]);
      expect(assistantDeltas.map((event) => event.itemId)).toEqual([
        assistantStarts[0]?.itemId,
        assistantStarts[0]?.itemId,
        assistantStarts[1]?.itemId,
      ]);
      const firstAssistantIndex = events.findIndex((event) => event === assistantStarts[0]);
      const toolCompletedIndex = events.findIndex(
        (event) => event.type === "item.completed" && event.itemId === "pi-tool-1",
      );
      const secondAssistantIndex = events.findIndex((event) => event === assistantStarts[1]);
      expect(toolCompletedIndex).toBeGreaterThan(firstAssistantIndex);
      expect(secondAssistantIndex).toBeGreaterThan(toolCompletedIndex);
      expect(usageEvents).toHaveLength(2);
      expect(usageEvents[0]?.payload.usage).toMatchObject({
        usedTokens: 29,
        totalProcessedTokens: 29,
        inputTokens: 27,
        cachedInputTokens: 3,
        outputTokens: 2,
        toolUses: 0,
      });
      expect(usageEvents[1]?.payload.usage).toMatchObject({
        usedTokens: 46,
        totalProcessedTokens: 75,
        inputTokens: 36,
        cachedInputTokens: 5,
        outputTokens: 10,
        lastUsedTokens: 46,
        lastInputTokens: 36,
        lastCachedInputTokens: 5,
        lastOutputTokens: 10,
        toolUses: 1,
      });

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps an agent-starting slash command running until Pi settles", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({ T3_PI_MOCK_PROMPT_DELAY_MS: "50" });
      const threadId = ThreadId.make("pi-agent-command");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const settled = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "/agent-command" });
      expect(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)?.status,
      ).toBe("running");
      const events = yield* Fiber.join(settled);

      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = (yield* adapter.listSessions()).find(
          (session) => session.threadId === threadId,
        )?.status;
        if (status === "ready") break;
        yield* Effect.yieldNow;
      }
      expect(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)?.status,
      ).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("completes a non-agent slash command without waiting for agent_settled", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture();
      const threadId = ThreadId.make("pi-non-agent-command");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const settled = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const result = yield* adapter.sendTurn({ threadId, input: "/non-agent-command" });
      const events = yield* Fiber.join(settled);

      expect(result.turnId).toBeDefined();
      expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
      expect(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)?.status,
      ).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "validates resume cursors and performs native fork rollback only after a settled turn",
    () =>
      Effect.gen(function* () {
        const { adapter, sessionFile } = yield* makeFixture();
        const threadId = ThreadId.make("pi-rollback");
        const session = yield* adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: {
            schemaVersion: 1,
            sessionFile,
            sessionId: "pi-mock-session",
          },
        });
        expect(session.resumeCursor).toEqual({
          schemaVersion: 1,
          sessionFile,
          sessionId: "pi-mock-session",
        });

        const settled = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({ threadId, input: "Create a durable turn" });
        yield* Fiber.join(settled);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const current = (yield* adapter.listSessions()).find(
            (candidate) => candidate.threadId === threadId,
          );
          if (current?.status === "ready") break;
          yield* Effect.yieldNow;
        }

        expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);
        expect((yield* adapter.rollbackThread(threadId, 1)).turns).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "rehydrates stable rollback targets from durable history after context recreation",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const historyDir = yield* fileSystem.makeTempDirectory({ prefix: "pi-resume-history-" });
        const historyFile = path.join(historyDir, "entries.json");
        const requestLog = path.join(historyDir, "requests.jsonl");
        const { adapter } = yield* makeFixture({
          T3_PI_MOCK_HISTORY_FILE: historyFile,
          T3_PI_MOCK_REQUEST_LOG: requestLog,
        });
        const threadId = ThreadId.make("pi-rehydrated-rollback");
        const started = yield* adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const resumeCursor = started.resumeCursor;
        if (!resumeCursor) throw new Error("Expected Pi to return a resume cursor.");

        for (const input of ["First durable turn", "Second durable turn"]) {
          const settled = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* adapter.sendTurn({ threadId, input });
          yield* Fiber.join(settled);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const current = (yield* adapter.listSessions()).find(
              (candidate) => candidate.threadId === threadId,
            );
            if (current?.status === "ready") break;
            yield* Effect.sleep("5 millis");
          }
        }

        expect((yield* adapter.readThread(threadId)).turns).toHaveLength(2);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor,
        });

        const firstResume = yield* adapter.readThread(threadId);
        expect(firstResume.turns.map((turn) => turn.id)).toEqual([
          "pi-user-entry-1",
          "pi-user-entry-3",
        ]);

        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor,
        });
        const secondResume = yield* adapter.readThread(threadId);
        expect(secondResume.turns.map((turn) => turn.id)).toEqual(
          firstResume.turns.map((turn) => turn.id),
        );

        const rolledBack = yield* adapter.rollbackThread(threadId, 1);
        expect(rolledBack.turns.map((turn) => turn.id)).toEqual(["pi-user-entry-1"]);
        const requests = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { request: Record<string, unknown> });
        const fork = requests.findLast((entry) => entry.request.type === "fork");
        expect(fork?.request.entryId).toBe("pi-user-entry-3");
      }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
  );

  it.effect("rejects resumed active history that cannot be represented safely", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const historyDir = yield* fileSystem.makeTempDirectory({ prefix: "pi-invalid-history-" });
      const historyFile = path.join(historyDir, "entries.json");
      yield* fileSystem.writeFileString(
        historyFile,
        '[{"id":"broken-user","parentId":null,"timestamp":"2026-07-30T00:00:00.000Z","type":"message","message":{"content":"missing role"}}]',
      );
      const { adapter, sessionFile } = yield* makeFixture({
        T3_PI_MOCK_HISTORY_FILE: historyFile,
      });
      const threadId = ThreadId.make("pi-invalid-resumed-history");

      const error = yield* Effect.flip(
        adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: {
            schemaVersion: 1,
            sessionFile,
            sessionId: "pi-mock-session",
          },
        }),
      );

      expect(error.message).toMatch(/broken-user.*cannot be represented safely/i);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("interrupts through abort and completes the turn exactly once", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({ T3_PI_MOCK_PROMPT_DELAY_MS: "250" });
      const threadId = ThreadId.make("pi-interrupt");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const eventsFiber = yield* collectThrough(adapter.streamEvents, "turn.aborted").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({ threadId, input: "Wait" });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      const events = yield* Fiber.join(eventsFiber);

      expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
      expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("finishes interrupt when Pi settles before the abort response", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({
        T3_PI_MOCK_ABORT_RESPONSE_DELAY_MS: "1000",
        T3_PI_MOCK_PROMPT_DELAY_MS: "1000",
        T3_PI_MOCK_SETTLE_DURING_ABORT: "1",
      });
      const threadId = ThreadId.make("pi-interrupt-settlement-race");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const eventsFiber = yield* collectThrough(adapter.streamEvents, "turn.aborted").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const turn = yield* adapter.sendTurn({ threadId, input: "Wait" });

      const interrupted = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.timeoutOption("250 millis"));
      const events = yield* Fiber.join(eventsFiber);

      expect(Option.isSome(interrupted)).toBe(true);
      expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
      expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer), TestClock.withLive),
  );

  it.effect("converts T3 image attachments to Pi base64 ImageContent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const logDir = yield* fileSystem.makeTempDirectory({ prefix: "pi-image-log-" });
      const requestLog = path.join(logDir, "requests.jsonl");
      const { adapter } = yield* makeFixture({ T3_PI_MOCK_REQUEST_LOG: requestLog });
      const threadId = ThreadId.make("pi-image");
      const attachment = {
        type: "image" as const,
        id: "pi-image-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(
        serverConfig.attachmentsDir,
        attachmentRelativePath(attachment),
      );
      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Inspect this image",
        attachments: [attachment],
      });
      const requests = (yield* fileSystem.readFileString(requestLog))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { request: Record<string, unknown> });
      const prompt = requests.find((entry) => entry.request.type === "prompt");

      expect(prompt?.request.images).toEqual([
        { type: "image", data: "AQIDBA==", mimeType: "image/png" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps multiple Pi instances on isolated processes and session state", () =>
    Effect.gen(function* () {
      const firstId = ProviderInstanceId.make("piAgent_work");
      const secondId = ProviderInstanceId.make("piAgent_personal");
      const first = yield* makeFixture(
        { T3_PI_MOCK_SESSION_ID: "pi-work-session" },
        firstId,
        "/state/pi-work",
      );
      const second = yield* makeFixture(
        { T3_PI_MOCK_SESSION_ID: "pi-personal-session" },
        secondId,
        "/state/pi-personal",
      );
      const firstSession = yield* first.adapter.startSession({
        provider: PI,
        providerInstanceId: firstId,
        threadId: ThreadId.make("pi-work-thread"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const secondSession = yield* second.adapter.startSession({
        provider: PI,
        providerInstanceId: secondId,
        threadId: ThreadId.make("pi-personal-thread"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      expect(firstSession.providerInstanceId).toBe(firstId);
      expect(secondSession.providerInstanceId).toBe(secondId);
      expect(firstSession.resumeCursor).toMatchObject({ sessionId: "pi-work-session" });
      expect(secondSession.resumeCursor).toMatchObject({ sessionId: "pi-personal-session" });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("injects the per-thread T3 browser MCP connection into Pi", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logDir = yield* fileSystem.makeTempDirectory({ prefix: "pi-mcp-log-" });
      const requestLog = path.join(logDir, "requests.jsonl");
      const mcpConfigPath = path.join(logDir, "t3-mcp.json");
      const { adapter } = yield* makeFixture(
        { T3_PI_MOCK_REQUEST_LOG: requestLog },
        PI_INSTANCE,
        "",
        { available: true, configPath: mcpConfigPath },
      );
      const threadId = ThreadId.make("pi-mcp-enabled");
      yield* installMcpSession(threadId);

      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const source = yield* fileSystem.readFileString(requestLog);
      const [entry] = source
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              args: Array<string>;
              environment: {
                mcpEndpoint?: string;
                hasMcpBearerToken: boolean;
                mcpBridgeEnabled?: string;
              };
            },
        );
      expect(entry?.args).toContain("--mcp-config");
      expect(entry?.args).toContain(mcpConfigPath);
      expect(entry?.environment).toEqual({
        mcpEndpoint: "http://127.0.0.1:43123/mcp",
        hasMcpBearerToken: true,
        mcpBridgeEnabled: "1",
      });
      expect(source).not.toContain("thread-secret");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("warns in the thread when Pi cannot receive the browser MCP connection", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture();
      const threadId = ThreadId.make("pi-mcp-unavailable");
      yield* installMcpSession(threadId);
      const warningFiber = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, isMcpBridgeUnavailableWarning),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const warning = yield* Fiber.join(warningFiber);

      expect(warning._tag).toBe("Some");
      if (warning._tag === "Some" && warning.value.type === "runtime.warning") {
        expect(warning.value.payload.message).toMatch(/pi install npm:pi-mcp-adapter/);
        expect(warning.value.payload.detail).toMatchObject({
          code: "pi_mcp_bridge_unavailable",
          reason: "adapter-not-installed",
        });
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps adapter snapshots when a Pi extension cancels fork rollback", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({ T3_PI_MOCK_CANCEL_FORK: "1" });
      const threadId = ThreadId.make("pi-cancelled-fork");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const settled = yield* collectThrough(adapter.streamEvents, "turn.completed").pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "Keep this turn" });
      yield* Fiber.join(settled);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const [session] = yield* adapter.listSessions();
        if (session?.status === "ready") break;
        yield* Effect.yieldNow;
      }

      const error = yield* Effect.flip(adapter.rollbackThread(threadId, 1));

      expect(error.message).toMatch(/cancelled the rollback/i);
      expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("Pi approval policies and extension UI", () => {
  it("applies every runtime permission mode conservatively", () => {
    expect(piRuntimeModeNeedsApproval("full-access", "bash")).toBe(false);
    expect(piRuntimeModeNeedsApproval("auto-accept-edits", "read")).toBe(false);
    expect(piRuntimeModeNeedsApproval("auto-accept-edits", "write")).toBe(false);
    expect(piRuntimeModeNeedsApproval("auto-accept-edits", "bash")).toBe(true);
    expect(piRuntimeModeNeedsApproval("approval-required", "read")).toBe(true);
    expect(piRuntimeModeNeedsApproval("auto", "unknown-extension-tool")).toBe(true);
  });

  it("maps accept-once, accept-for-session, decline, and cancellation decisions", () => {
    expect(piApprovalExtensionResponse("request", "accept")).toEqual({
      id: "request",
      value: "Accept once",
    });
    expect(piApprovalExtensionResponse("request", "acceptForSession")).toEqual({
      id: "request",
      value: "Accept for session",
    });
    expect(piApprovalExtensionResponse("request", "decline")).toEqual({
      id: "request",
      value: "Decline",
    });
    expect(piApprovalExtensionResponse("request", "cancel")).toEqual({
      id: "request",
      cancelled: true,
    });
  });

  it.effect("bridges a Pi tool approval and maps accept-for-session back to extension UI", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeFixture({
        T3_PI_MOCK_UI: "approval",
        T3_PI_MOCK_TOOL: "bash",
      });
      const threadId = ThreadId.make("pi-approval");
      yield* adapter.startSession({
        provider: PI,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const openedFiber = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "request.opened"),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "Use a tool" });
      const opened = yield* Fiber.join(openedFiber);

      expect(opened._tag).toBe("Some");
      if (opened._tag === "Some" && opened.value.type === "request.opened") {
        expect(opened.value.payload.requestType).toBe("command_execution_approval");
      }
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("pi-ui-approval"),
        "acceptForSession",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  for (const method of ["select", "confirm", "input", "editor"] as const) {
    it.effect(`maps an extension ${method} dialog to structured user input`, () =>
      Effect.gen(function* () {
        const { adapter } = yield* makeFixture({ T3_PI_MOCK_UI: method });
        const threadId = ThreadId.make(`pi-ui-${method}`);
        yield* adapter.startSession({
          provider: PI,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const requestedFiber = yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "user-input.requested"),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({ threadId, input: "Ask me" });
        const requested = yield* Fiber.join(requestedFiber);

        expect(requested._tag).toBe("Some");
        if (requested._tag === "Some" && requested.value.type === "user-input.requested") {
          expect(requested.value.payload.questions[0]?.question).toContain(method);
        }
        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(`pi-ui-${method}`), {
          answer: method === "confirm" ? "Yes" : "Alpha",
        });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }
});
