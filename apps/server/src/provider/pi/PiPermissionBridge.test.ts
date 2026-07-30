// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { PI_PERMISSION_BRIDGE_SOURCE } from "./PiPermissionBridge.ts";

type ToolCallEvent = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
};
type ToolCallHandler = (
  event: ToolCallEvent,
  context: {
    readonly ui: {
      readonly select: (
        title: string,
        options: ReadonlyArray<string>,
      ) => Promise<string | undefined>;
    };
  },
) => Promise<{ readonly block: true; readonly reason: string } | undefined>;
type BeforeAgentStartHandler = (event: {
  readonly systemPrompt: string;
}) => Promise<{ readonly systemPrompt: string } | undefined>;
type SessionStartHandler = (
  event: unknown,
  context: {
    readonly ui: {
      readonly setStatus: (key: string, text: string | undefined) => void;
    };
  },
) => Promise<void>;
type McpStatusHandler = (snapshot: unknown) => void;

const originalMode = process.env.T3_PI_RUNTIME_MODE;
const originalMcpBridgeEnabled = process.env.T3_PI_MCP_BRIDGE_ENABLED;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.T3_PI_RUNTIME_MODE;
  } else {
    process.env.T3_PI_RUNTIME_MODE = originalMode;
  }
  if (originalMcpBridgeEnabled === undefined) {
    delete process.env.T3_PI_MCP_BRIDGE_ENABLED;
  } else {
    process.env.T3_PI_MCP_BRIDGE_ENABLED = originalMcpBridgeEnabled;
  }
});

async function loadBridge(): Promise<{
  readonly toolCall: ToolCallHandler;
  readonly beforeAgentStart: BeforeAgentStartHandler;
  readonly sessionStart: SessionStartHandler;
  readonly emitMcpStatus: McpStatusHandler;
}> {
  let toolCall: ToolCallHandler | undefined;
  let beforeAgentStart: BeforeAgentStartHandler | undefined;
  let sessionStart: SessionStartHandler | undefined;
  let mcpStatus: McpStatusHandler | undefined;
  const sourceUrl = `data:text/javascript;base64,${NodeBuffer.Buffer.from(PI_PERMISSION_BRIDGE_SOURCE).toString("base64")}`;
  const bridge = (await import(sourceUrl)) as {
    readonly default: (pi: {
      readonly on: (
        event: "tool_call" | "before_agent_start" | "session_start",
        callback: ToolCallHandler | BeforeAgentStartHandler | SessionStartHandler,
      ) => void;
      readonly events: {
        readonly on: (channel: string, callback: McpStatusHandler) => void;
      };
    }) => void;
  };
  bridge.default({
    on: (event, callback) => {
      if (event === "tool_call") {
        toolCall = callback as ToolCallHandler;
      } else if (event === "before_agent_start") {
        beforeAgentStart = callback as BeforeAgentStartHandler;
      } else {
        sessionStart = callback as SessionStartHandler;
      }
    },
    events: {
      on: (channel, callback) => {
        if (channel === "pi-mcp-adapter/status/v1") mcpStatus = callback;
      },
    },
  });
  if (!toolCall) throw new Error("Pi permission bridge did not register tool_call.");
  if (!beforeAgentStart) {
    throw new Error("Pi permission bridge did not register before_agent_start.");
  }
  if (!sessionStart) throw new Error("Pi permission bridge did not register session_start.");
  if (!mcpStatus) throw new Error("Pi permission bridge did not subscribe to MCP status.");
  return { toolCall, beforeAgentStart, sessionStart, emitMcpStatus: mcpStatus };
}

describe("Pi permission bridge extension", () => {
  it("caches accepted tool categories for the Pi process", async () => {
    process.env.T3_PI_RUNTIME_MODE = "approval-required";
    const { toolCall: handler } = await loadBridge();
    let prompts = 0;
    const context = {
      ui: {
        select: async () => {
          prompts += 1;
          return "Accept for session";
        },
      },
    };
    const event = {
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "echo test" },
    };

    expect(await handler(event, context)).toBeUndefined();
    expect(await handler({ ...event, toolCallId: "bash-2" }, context)).toBeUndefined();
    expect(prompts).toBe(1);
  });

  it("allows safe categories by policy and blocks decline or cancellation", async () => {
    const { toolCall: handler } = await loadBridge();
    let choice: string | undefined = "Decline";
    let prompts = 0;
    const context = {
      ui: {
        select: async () => {
          prompts += 1;
          return choice;
        },
      },
    };

    process.env.T3_PI_RUNTIME_MODE = "full-access";
    expect(
      await handler({ toolCallId: "custom-1", toolName: "custom", input: {} }, context),
    ).toBeUndefined();

    process.env.T3_PI_RUNTIME_MODE = "auto-accept-edits";
    expect(
      await handler(
        { toolCallId: "read-1", toolName: "read", input: { path: "README.md" } },
        context,
      ),
    ).toBeUndefined();
    expect(prompts).toBe(0);

    expect(
      await handler({ toolCallId: "custom-2", toolName: "custom", input: {} }, context),
    ).toEqual({ block: true, reason: "Blocked by user" });

    choice = undefined;
    expect(
      await handler({ toolCallId: "bash-1", toolName: "bash", input: { command: "pwd" } }, context),
    ).toEqual({ block: true, reason: "Cancelled by user" });
  });

  it("adds T3 preview guidance only when the MCP bridge is enabled", async () => {
    const { beforeAgentStart } = await loadBridge();

    expect(await beforeAgentStart({ systemPrompt: "Base prompt" })).toBeUndefined();
    process.env.T3_PI_MCP_BRIDGE_ENABLED = "1";
    const result = await beforeAgentStart({ systemPrompt: "Base prompt" });

    expect(result?.systemPrompt).toContain("t3_code_preview_status");
    expect(result?.systemPrompt).toContain("t3_code_preview_open");
    expect(result?.systemPrompt).toContain("Base prompt");
  });

  it("relays a bounded MCP status snapshot without exposing configuration secrets", async () => {
    const { emitMcpStatus, sessionStart } = await loadBridge();
    const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
    emitMcpStatus({
      version: 1,
      servers: [
        {
          name: "t3-code",
          status: "connected",
          toolCount: 12,
          resourceCount: 0,
          disabled: false,
          bearerToken: "thread-secret",
          url: "http://127.0.0.1/private",
        },
      ],
      totalTools: 12,
      totalResources: 0,
      connectedCount: 1,
      disabledCount: 0,
      credentials: "thread-secret",
    });

    await sessionStart(
      {},
      {
        ui: {
          setStatus: (key, text) => statusUpdates.push({ key, text }),
        },
      },
    );

    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0]?.key).toBe("t3-mcp-status");
    expect(statusUpdates[0]?.text).toContain("__T3_PI_MCP_STATUS_V1__:");
    expect(statusUpdates[0]?.text).toContain('"name":"t3-code"');
    expect(statusUpdates[0]?.text).not.toContain("thread-secret");
    expect(statusUpdates[0]?.text).not.toContain("127.0.0.1");
  });
});
