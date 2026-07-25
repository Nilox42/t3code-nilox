#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const env = process.env;
const args = process.argv.slice(2);

if (args.includes("--version")) {
  if (env.T3_PI_MOCK_VERSION_BEHAVIOR === "timeout") {
    setInterval(() => {}, 60_000);
  } else {
    process.stdout.write(`${env.T3_PI_MOCK_VERSION || "0.82.1"}\n`);
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
const entries = [
  {
    id: "pi-user-entry-1",
    type: "message",
    message: { role: "user", content: "Mock prompt" },
  },
];
let heldStateRequest;
const outputQueue = [];
let outputWriting = false;

if (!args.includes("--no-session")) {
  NodeFS.mkdirSync(NodePath.dirname(sessionFile), { recursive: true });
  NodeFS.closeSync(NodeFS.openSync(sessionFile, "a"));
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
    sessionName: "Mock Pi session",
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

function respond(request, data, extra = {}) {
  write({
    id: request.id,
    type: "response",
    command: request.type,
    success: true,
    ...(data === undefined ? {} : { data }),
    ...extra,
  });
}

function emitPromptEvents() {
  streaming = true;
  write({ type: "agent_start" });
  write({ type: "turn_start" });
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
    args: { path: "README.md" },
  });
  write({
    type: "tool_execution_update",
    toolCallId: "pi-tool-1",
    toolName: env.T3_PI_MOCK_TOOL || "read",
    args: { path: "README.md" },
    partialResult: { content: [{ type: "text", text: "Reading" }] },
  });
  write({
    type: "tool_execution_end",
    toolCallId: "pi-tool-1",
    toolName: env.T3_PI_MOCK_TOOL || "read",
    args: { path: "README.md" },
    result: { content: [{ type: "text", text: "Done" }] },
    isError: false,
  });
  write({
    type: "message_update",
    assistantMessageEvent: {
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
      stopReason: aborted ? "aborted" : "stop",
      usage: { input: 20, output: 10, cacheRead: 3 },
    },
  });
  streaming = false;
  write({ type: "turn_end" });
  write({ type: "agent_end" });
  write({ type: "agent_settled" });
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
    return;
  }
  write({
    type: "extension_ui_request",
    id: `pi-ui-${method}`,
    method,
    title: `Mock ${method} request`,
    message: method === "confirm" ? "Continue?" : undefined,
    options: method === "select" ? ["Alpha", "Beta"] : undefined,
  });
}

function logRequest(request) {
  if (!env.T3_PI_MOCK_REQUEST_LOG) return;
  NodeFS.appendFileSync(env.T3_PI_MOCK_REQUEST_LOG, `${JSON.stringify({ args, request })}\n`);
}

const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  logRequest(request);

  if (request.type === "extension_ui_response") return;
  if (env.T3_PI_MOCK_BEHAVIOR === "timeout") return;
  if (env.T3_PI_MOCK_BEHAVIOR === "exit") {
    process.exit(23);
  }
  if (env.T3_PI_MOCK_BEHAVIOR === "malformed") {
    process.stdout.write("{not-json}\n");
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
        commands: [{ name: "login", description: "Authenticate", source: "built-in" }],
      });
      break;
    case "set_model":
      currentModel = { ...model, provider: request.provider, id: request.modelId };
      respond(request, currentModel);
      break;
    case "set_thinking_level":
      thinkingLevel = request.level;
      respond(request);
      break;
    case "prompt":
      aborted = false;
      respond(request);
      emitUiRequest();
      setTimeout(emitPromptEvents, Number(env.T3_PI_MOCK_PROMPT_DELAY_MS || 3));
      break;
    case "abort":
      aborted = true;
      respond(request);
      setTimeout(() => write({ type: "agent_settled" }), 2);
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
