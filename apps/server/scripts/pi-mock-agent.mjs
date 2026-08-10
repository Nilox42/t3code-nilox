#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const env = process.env;
const args = process.argv.slice(2);

if (env.T3_PI_MOCK_PID_FILE) {
  NodeFS.writeFileSync(env.T3_PI_MOCK_PID_FILE, String(process.pid));
}

if (args.includes("--version")) {
  if (env.T3_PI_MOCK_VERSION_BEHAVIOR === "timeout") {
    setInterval(() => {}, 60_000);
  } else {
    process.stdout.write(`${env.T3_PI_MOCK_VERSION || "0.84.1"}\n`);
    process.exit(Number(env.T3_PI_MOCK_VERSION_EXIT_CODE || 0));
  }
}

const model = {
  id: env.T3_PI_MOCK_MODEL_ID || "mock/model",
  name: env.T3_PI_MOCK_MODEL_NAME || "Mock Model",
  provider: env.T3_PI_MOCK_PROVIDER || "mock-provider",
  api: "mock",
  reasoning: env.T3_PI_MOCK_REASONING !== "false",
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
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

let currentModel = model;
let thinkingLevel = "medium";
let streaming = false;
let aborted = false;
let assistantText =
  env.T3_PI_MOCK_ASSISTANT_TEXT ||
  '{"title":"Mock title","subject":"Mock commit","body":"Mock body","branch":"mock-branch"}';
const sessionArgumentIndex = args.indexOf("--session");
const sessionFile =
  (sessionArgumentIndex >= 0 ? args[sessionArgumentIndex + 1] : undefined) ||
  env.T3_PI_MOCK_SESSION_FILE ||
  "/tmp/t3-pi-mock-session.jsonl";
const sessionId = env.T3_PI_MOCK_SESSION_ID || "pi-mock-session";
const eol = env.T3_PI_MOCK_CRLF === "1" ? "\r\n" : "\n";
const historyFile = env.T3_PI_MOCK_HISTORY_FILE;
const entries =
  historyFile && NodeFS.existsSync(historyFile) && NodeFS.readFileSync(historyFile, "utf8").trim()
    ? JSON.parse(NodeFS.readFileSync(historyFile, "utf8"))
    : [];
let entrySequence = entries.length;
let heldStateRequest;
const failedOnceCommands = new Set();
const outputQueue = [];
let outputWriting = false;

if (env.T3_PI_MOCK_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    process.stderr.write("Mock Pi ignored SIGTERM.\n");
  });
  setInterval(() => {}, 60_000);
}

if (!args.includes("--no-session")) {
  NodeFS.mkdirSync(NodePath.dirname(sessionFile), { recursive: true });
  NodeFS.closeSync(NodeFS.openSync(sessionFile, "a"));
}

function persistHistory() {
  if (!historyFile) return;
  NodeFS.mkdirSync(NodePath.dirname(historyFile), { recursive: true });
  NodeFS.writeFileSync(historyFile, JSON.stringify(entries));
}

function appendMessageEntry(role, content) {
  const entry = {
    id: `pi-${role}-entry-${++entrySequence}`,
    parentId: entries.at(-1)?.id || null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: { role, content },
  };
  entries.push(entry);
  persistHistory();
  write({ type: "entry_appended", entry });
  return entry;
}

function state() {
  return {
    model: currentModel,
    thinkingLevel,
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile,
    sessionId,
    sessionName: env.T3_PI_MOCK_SESSION_NAME || "Mock Pi session",
    autoCompactionEnabled: true,
    messageCount: entries.length,
    pendingMessageCount: 0,
  };
}

function flushOutputQueue() {
  const text = outputQueue.shift();
  if (text === undefined) {
    outputWriting = false;
    return;
  }
  outputWriting = true;
  const midpoint = Math.floor(text.length / 2);
  process.stdout.write(text.slice(0, midpoint));
  setTimeout(() => {
    process.stdout.write(text.slice(midpoint));
    flushOutputQueue();
  }, 2);
}

function writeRaw(text) {
  if (env.T3_PI_MOCK_SPLIT !== "1" || text.length <= 2) {
    process.stdout.write(text);
    return;
  }
  outputQueue.push(text);
  if (!outputWriting) flushOutputQueue();
}

function write(record) {
  writeRaw(`${JSON.stringify(record)}${eol}`);
}

if (env.T3_PI_MOCK_STARTUP_EXTENSION_ERROR) {
  write({
    type: "extension_error",
    error: env.T3_PI_MOCK_STARTUP_EXTENSION_ERROR,
  });
}

function respond(request, data, extra = {}) {
  write({
    id: request.id,
    type: "response",
    command: request.type,
    success: true,
    ...(data === undefined ? {} : { data }),
    ...extra,
  });
  if (env.T3_PI_MOCK_EXIT_AFTER_RESPONSE === request.type) {
    setTimeout(
      () => process.exit(Number(env.T3_PI_MOCK_EXIT_AFTER_RESPONSE_CODE || 0)),
      Number(env.T3_PI_MOCK_EXIT_AFTER_RESPONSE_DELAY_MS || 10),
    );
  }
}

function mockUsage(prefix, defaults) {
  const value = (name, fallback) => {
    const configured = env[`${prefix}${name}`];
    if (configured === undefined) return fallback;
    const parsed = Number(configured);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const input = value("INPUT", defaults.input);
  const output = value("OUTPUT", defaults.output);
  const cacheRead = value("CACHE_READ", defaults.cacheRead);
  const cacheWrite = value("CACHE_WRITE", defaults.cacheWrite);
  const reasoning = value("REASONING", defaults.reasoning || 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning > 0 ? { reasoning } : {}),
    totalTokens: input + output + cacheRead + cacheWrite,
  };
}

function mockToolArgs() {
  return env.T3_PI_MOCK_MCP_SERVER ? { interactiveOnly: true } : { path: "README.md" };
}

function mockToolResult(text) {
  return {
    content: [{ type: "text", text }],
    ...(env.T3_PI_MOCK_MCP_SERVER
      ? {
          details: {
            server: env.T3_PI_MOCK_MCP_SERVER,
            tool: env.T3_PI_MOCK_MCP_TOOL || "preview_status",
          },
        }
      : {}),
  };
}

function emitMetadataEvents() {
  if (env.T3_PI_MOCK_SESSION_NAME_EVENT) {
    write({
      type: "session_info_changed",
      name: env.T3_PI_MOCK_SESSION_NAME_EVENT,
    });
  }
  if (env.T3_PI_MOCK_MCP_STATUS === "1") {
    const snapshot = {
      version: 1,
      servers: [
        {
          name: env.T3_PI_MOCK_MCP_SERVER || "t3-code",
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
    };
    write({
      type: "extension_ui_request",
      id: "pi-mcp-status",
      method: "setStatus",
      statusKey: "t3-mcp-status",
      statusText: `__T3_PI_MCP_STATUS_V1__:${JSON.stringify(snapshot)}`,
    });
  }
}

function emitPromptEvents() {
  const errorMessage = env.T3_PI_MOCK_TURN_ERROR;
  streaming = true;
  emitMetadataEvents();
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  if (env.T3_PI_MOCK_MULTI_MESSAGE === "1") {
    const beforeToolText = "Before tool";
    const firstMessage = {
      role: "assistant",
      content: [{ type: "text", text: beforeToolText }],
      stopReason: "toolUse",
      usage: mockUsage("T3_PI_MOCK_FIRST_USAGE_", {
        input: 20,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
      }),
    };
    write({ type: "message_start", message: firstMessage });
    write({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Before ",
      },
    });
    write({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "tool",
      },
    });
    write({ type: "message_end", message: firstMessage });
    appendMessageEntry("assistant", firstMessage.content);
    write({
      type: "tool_execution_start",
      toolCallId: "pi-tool-1",
      toolName: env.T3_PI_MOCK_TOOL || "read",
      args: mockToolArgs(),
    });
    write({
      type: "tool_execution_end",
      toolCallId: "pi-tool-1",
      toolName: env.T3_PI_MOCK_TOOL || "read",
      args: mockToolArgs(),
      result: mockToolResult("Done"),
      isError: false,
    });
    const toolResultMessage = {
      role: "toolResult",
      toolCallId: "pi-tool-1",
      toolName: env.T3_PI_MOCK_TOOL || "read",
      content: [{ type: "text", text: "Done" }],
      isError: false,
    };
    write({ type: "message_start", message: toolResultMessage });
    write({ type: "message_end", message: toolResultMessage });
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      stopReason: aborted ? "aborted" : "stop",
      usage: mockUsage("T3_PI_MOCK_SECOND_USAGE_", {
        input: 25,
        output: 10,
        cacheRead: 5,
        cacheWrite: 6,
      }),
    };
    write({ type: "message_start", message: finalMessage });
    write({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: assistantText,
      },
    });
    write({ type: "message_end", message: finalMessage });
    appendMessageEntry("assistant", finalMessage.content);
    streaming = false;
    write({ type: "turn_end" });
    write({ type: "agent_end" });
    write({ type: "agent_settled" });
    return;
  }
  write({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Mock reasoning",
    },
  });
  write({
    type: "tool_execution_start",
    toolCallId: "pi-tool-1",
    toolName: env.T3_PI_MOCK_TOOL || "read",
    args: mockToolArgs(),
  });
  write({
    type: "tool_execution_update",
    toolCallId: "pi-tool-1",
    toolName: env.T3_PI_MOCK_TOOL || "read",
    args: mockToolArgs(),
    partialResult: mockToolResult("Reading"),
  });
  write({
    type: "tool_execution_end",
    toolCallId: "pi-tool-1",
    toolName: env.T3_PI_MOCK_TOOL || "read",
    args: mockToolArgs(),
    result: mockToolResult("Done"),
    isError: false,
  });
  write({
    type: "message_update",
    assistantMessageEvent: errorMessage
      ? {
          type: "error",
          reason: "error",
          error: { stopReason: "error", errorMessage },
        }
      : {
          type: "text_delta",
          contentIndex: 1,
          delta: assistantText,
        },
  });
  write({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      stopReason: aborted ? "aborted" : errorMessage ? "error" : "stop",
      ...(errorMessage ? { errorMessage } : {}),
      usage: mockUsage("T3_PI_MOCK_USAGE_", {
        input: 20,
        output: 10,
        cacheRead: 3,
        cacheWrite: 0,
      }),
    },
  });
  appendMessageEntry("assistant", [{ type: "text", text: assistantText }]);
  streaming = false;
  write({ type: "turn_end" });
  write({ type: "agent_end" });
  write({ type: "agent_settled" });
  if (env.T3_PI_MOCK_EXIT_AFTER_PROMPT_CODE) {
    setTimeout(() => process.exit(Number(env.T3_PI_MOCK_EXIT_AFTER_PROMPT_CODE)), 10);
  }
}

function emitUiRequest() {
  const method = env.T3_PI_MOCK_UI;
  if (!method) return;
  if (method === "approval") {
    const marker = `__T3_PI_APPROVAL_V1__:${JSON.stringify({
      toolCallId: "pi-tool-approval",
      toolName: env.T3_PI_MOCK_TOOL || "bash",
      category: env.T3_PI_MOCK_TOOL_CATEGORY || "bash",
      input: { command: "echo mock" },
    })}`;
    write({
      type: "extension_ui_request",
      id: "pi-ui-approval",
      method: "select",
      title: marker,
      options: ["Accept once", "Accept for session", "Decline"],
    });
    closeStdinAfterUiRequest();
    return;
  }
  write({
    type: "extension_ui_request",
    id: `pi-ui-${method}`,
    method,
    title: `Mock ${method} request`,
    message: method === "confirm" ? "Continue?" : undefined,
    options: method === "select" ? ["Alpha", "Beta"] : undefined,
    placeholder: env.T3_PI_MOCK_UI_PLACEHOLDER,
    prefill: env.T3_PI_MOCK_UI_PREFILL,
    timeout: env.T3_PI_MOCK_UI_TIMEOUT_MS ? Number(env.T3_PI_MOCK_UI_TIMEOUT_MS) : undefined,
  });
  closeStdinAfterUiRequest();
}

function closeStdinAfterUiRequest() {
  if (env.T3_PI_MOCK_CLOSE_STDIN_AFTER_UI !== "1") return;
  setTimeout(() => {
    input.close();
    NodeFS.closeSync(0);
    setTimeout(
      () =>
        write({
          type: "extension_ui_request",
          id: "pi-ui-stdin-closed",
          method: "notify",
          message: "Mock Pi stdin closed.",
          notifyType: "warning",
        }),
      25,
    );
  }, 25);
}

function logRequest(request) {
  if (!env.T3_PI_MOCK_REQUEST_LOG) return;
  NodeFS.appendFileSync(
    env.T3_PI_MOCK_REQUEST_LOG,
    `${JSON.stringify({
      args,
      environment: {
        mcpEndpoint: env.T3_MCP_ENDPOINT,
        hasMcpBearerToken: Boolean(env.T3_MCP_BEARER_TOKEN),
        mcpBridgeEnabled: env.T3_PI_MCP_BRIDGE_ENABLED,
      },
      request,
    })}\n`,
  );
}

const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("close", () => {
  if (env.T3_PI_MOCK_STDIN_CLOSED_FILE) {
    NodeFS.writeFileSync(env.T3_PI_MOCK_STDIN_CLOSED_FILE, "");
  }
});
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  logRequest(request);

  if (request.type === "extension_ui_response") return;
  if (
    env.T3_PI_MOCK_FAIL_COMMAND === request.type ||
    (env.T3_PI_MOCK_FAIL_COMMAND_ONCE === request.type && !failedOnceCommands.has(request.type))
  ) {
    failedOnceCommands.add(request.type);
    write({
      id: request.id,
      type: "response",
      command: request.type,
      success: false,
      error: `Injected ${request.type} failure.`,
    });
    return;
  }
  if (env.T3_PI_MOCK_BEHAVIOR === "timeout") return;
  if (env.T3_PI_MOCK_BEHAVIOR === "exit") {
    process.exit(23);
  }
  if (env.T3_PI_MOCK_BEHAVIOR === "malformed") {
    process.stdout.write("{not-json}\n");
    return;
  }
  if (env.T3_PI_MOCK_BEHAVIOR === "unknown-event") {
    write({ type: "future_additive_event", diagnostic: "mock" });
  }
  if (env.T3_PI_MOCK_BEHAVIOR === "malformed-known-event") {
    write({
      type: "extension_ui_request",
      id: "pi-ui-invalid",
      method: "select",
      options: [1],
    });
    return;
  }

  if (env.T3_PI_MOCK_BEHAVIOR === "out-of-order" && request.type === "get_state") {
    heldStateRequest = request;
    return;
  }
  if (
    env.T3_PI_MOCK_BEHAVIOR === "out-of-order" &&
    request.type === "get_available_models" &&
    heldStateRequest
  ) {
    const stateRequest = heldStateRequest;
    heldStateRequest = undefined;
    respond(request, { models: [model] });
    setTimeout(() => respond(stateRequest, state()), 3);
    return;
  }

  switch (request.type) {
    case "get_state":
      respond(request, state());
      break;
    case "get_available_models":
      respond(request, {
        models: env.T3_PI_MOCK_NO_MODELS === "1" ? [] : [model],
      });
      break;
    case "get_commands":
      respond(request, {
        commands: [
          {
            name: "agent-command",
            description: "Start an agent-backed command",
            source: "extension",
            sourceInfo: {
              path: "/tmp/pi/extensions/agent-command.ts",
              source: "agent-command.ts",
              scope: "user",
              origin: "top-level",
            },
          },
          {
            name: "non-agent-command",
            description: "Complete without starting the agent",
            source: "extension",
            sourceInfo: {
              path: "/tmp/pi/extensions/non-agent-command.ts",
              source: "non-agent-command.ts",
              scope: "user",
              origin: "top-level",
            },
          },
          {
            name: "review",
            description: "Review the current changes",
            source: "prompt",
            sourceInfo: {
              path: "/tmp/pi/prompts/review.md",
              source: "review.md",
              scope: "project",
              origin: "top-level",
            },
          },
          {
            name: "skill:deploy",
            description: "Deploy the current project",
            source: "skill",
            sourceInfo: {
              path: "/tmp/pi/skills/deploy/SKILL.md",
              source: "deploy",
              scope: "user",
              origin: "top-level",
            },
          },
        ],
      });
      break;
    case "set_model":
      currentModel = { ...model, provider: request.provider, id: request.modelId };
      respond(request, currentModel);
      break;
    case "set_thinking_level":
      thinkingLevel = request.level;
      if (env.T3_PI_MOCK_THINKING_LEVEL_CHANGED === "1") {
        write({ type: "thinking_level_changed", level: thinkingLevel });
      }
      respond(request);
      break;
    case "prompt":
      aborted = false;
      if (request.message === "/non-agent-command") {
        respond(request);
        break;
      }
      streaming = true;
      appendMessageEntry("user", [
        { type: "text", text: request.message },
        ...(request.images || []),
      ]);
      respond(request);
      if (request.streamingBehavior === "steer") break;
      emitUiRequest();
      setTimeout(emitPromptEvents, Number(env.T3_PI_MOCK_PROMPT_DELAY_MS || 3));
      break;
    case "abort":
      aborted = true;
      if (env.T3_PI_MOCK_SETTLE_DURING_ABORT === "1") {
        write({ type: "agent_settled" });
        setTimeout(() => respond(request), Number(env.T3_PI_MOCK_ABORT_RESPONSE_DELAY_MS || "20"));
      } else {
        respond(request);
        setTimeout(() => write({ type: "agent_settled" }), 2);
      }
      break;
    case "get_entries":
      respond(request, { entries, leafId: entries.at(-1)?.id || null });
      break;
    case "fork":
      respond(request, {
        text: "Mock prompt",
        cancelled: env.T3_PI_MOCK_CANCEL_FORK === "1",
      });
      break;
    case "get_last_assistant_text":
      respond(request, { text: assistantText });
      break;
    default:
      write({
        id: request.id,
        type: "response",
        command: request.type,
        success: false,
        error: `Unsupported command: ${request.type}`,
      });
  }
});
