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
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
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

describe("PiAdapter lifecycle and event mapping", () => {
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
