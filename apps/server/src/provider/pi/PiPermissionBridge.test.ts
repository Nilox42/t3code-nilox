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

const originalMode = process.env.T3_PI_RUNTIME_MODE;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.T3_PI_RUNTIME_MODE;
  } else {
    process.env.T3_PI_RUNTIME_MODE = originalMode;
  }
});

async function loadBridge(): Promise<ToolCallHandler> {
  let handler: ToolCallHandler | undefined;
  const sourceUrl = `data:text/javascript;base64,${NodeBuffer.Buffer.from(PI_PERMISSION_BRIDGE_SOURCE).toString("base64")}`;
  const bridge = (await import(sourceUrl)) as {
    readonly default: (pi: {
      readonly on: (event: "tool_call", callback: ToolCallHandler) => void;
    }) => void;
  };
  bridge.default({
    on: (_event, callback) => {
      handler = callback;
    },
  });
  if (!handler) throw new Error("Pi permission bridge did not register tool_call.");
  return handler;
}

describe("Pi permission bridge extension", () => {
  it("caches accepted tool categories for the Pi process", async () => {
    process.env.T3_PI_RUNTIME_MODE = "approval-required";
    const handler = await loadBridge();
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
    const handler = await loadBridge();
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
});
